"""Forward authenticated TODO requests to the PM-owned local JSON bridge."""

import asyncio
import contextlib
import json
import os
import signal

from aiohttp import web

from ai_dashboard.auth import InitDataError, verify_init_data
from ai_dashboard.config import Settings


async def invoke_pm(command: str, payload: dict) -> dict:
    """Run a fixed executable with bounded JSON input and terminate on cancellation."""
    try:
        process = await asyncio.create_subprocess_exec(
            command,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            start_new_session=True,
        )
    except OSError:
        return {"ok": False, "error": "PM editing bridge is not installed"}
    try:
        stdout, _stderr = await asyncio.wait_for(
            process.communicate(json.dumps(payload).encode()),
            timeout=180,
        )
    except (asyncio.TimeoutError, asyncio.CancelledError) as error:
        with contextlib.suppress(ProcessLookupError):
            os.killpg(process.pid, signal.SIGKILL)
        await process.wait()
        if isinstance(error, asyncio.CancelledError):
            raise
        return {
            "ok": False,
            "error": "PM operation timed out. Refresh before retrying.",
        }
    try:
        result = json.loads(stdout)
    except ValueError:
        return {"ok": False, "error": "PM bridge failed; check the server logs"}
    return (
        result
        if isinstance(result, dict)
        else {"ok": False, "error": "Invalid PM response"}
    )


def register_pm_routes(app: web.Application, settings: Settings) -> None:
    """Register authenticated read and mutation routes; GET cannot perform edits."""

    async def handle(request: web.Request) -> web.Response:
        try:
            authorization = request.headers.get("Authorization", "")
            init_data = authorization[4:] if authorization.startswith("tma ") else ""
            verify_init_data(
                init_data,
                settings.tokens(),
                settings.owner_id,
            )
        except InitDataError as error:
            return web.json_response({"error": error.reason}, status=error.status)
        if not settings.bot("pm"):
            return web.json_response(
                {"error": "PM agent is not configured"}, status=404
            )
        try:
            payload = {"action": "read"}
            if request.method == "POST":
                payload = await request.json()
                if not isinstance(payload, dict) or payload.get("action") not in (
                    "select",
                    "add",
                    "update",
                    "delete",
                    "sync",
                ):
                    raise ValueError("Unknown PM action")
            result = await invoke_pm(settings.pm_command, payload)
        except (ValueError, UnicodeDecodeError):
            return web.json_response({"error": "Invalid PM request"}, status=400)
        status = 200 if result.get("ok") else 409 if result.get("conflict") else 400
        return web.json_response(
            result, status=status, headers={"Cache-Control": "no-store"}
        )

    app.router.add_get("/api/pm/workspace", handle)
    app.router.add_post("/api/pm/action", handle)
