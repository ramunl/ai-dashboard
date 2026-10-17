"""The Ops window's Connected clients card: cached live service metrics.

ai-clients (from ai-ops-agent) reads fixed service counters as root and
prints one JSON report; it takes a few seconds, so the
dashboard keeps the last report (also across restarts) and refreshes it in
the background when it is older than REFRESH_SECONDS, or on Check now.
"""

import asyncio
import contextlib
import time
from collections.abc import Callable

from aiohttp import web

from ai_dashboard.auth import InitDataError, verify_init_data
from ai_dashboard.config import Settings
from ai_dashboard.maintenance import invoke
from ai_dashboard.saved_checks import SavedChecks

COMMAND = "/usr/local/sbin/ai-clients"
CLIENTS = web.AppKey("clients", object)
HEADERS = {"Cache-Control": "no-store"}
REFRESH_SECONDS = 30
TIMEOUT = 55


class ClientsService:
    """One sample at a time; the last report is kept and saved."""

    def __init__(
        self, settings: Settings, clock: Callable[[], float] = time.time
    ) -> None:
        """Restore the last report saved before a restart."""
        self.saved = SavedChecks(settings.state_dir / "clients.json")
        self.report = self.saved.get("clients", "report")
        self.clock = clock
        self.task: asyncio.Task | None = None

    @property
    def running(self) -> bool:
        """True while an sample is in flight."""
        return self.task is not None and not self.task.done()

    def state(self) -> dict:
        """The last report (or none yet); starts a refresh when it is stale."""
        report = self.report
        is_stale = not report or self.clock() - report.get("checked_at", 0) > (
            REFRESH_SECONDS
        )
        if is_stale:
            self.start()
        return {"report": report, "running": self.running}

    def start(self) -> bool:
        """Start one sample; False if one is already running."""
        if self.running:
            return False
        self.task = asyncio.create_task(self.run())
        return True

    async def run(self) -> None:
        """Run ai-clients and keep its report (or the error) with the time."""
        result = await invoke(COMMAND, "check", TIMEOUT, "ai-clients")
        if not isinstance(result, dict):
            result = {"ok": False, "error": "ai-clients returned no report"}
        self.report = {**result, "checked_at": self.clock()}
        self.saved.put("clients", {"report": self.report})

    async def close(self) -> None:
        """Cancel an sample in flight on shutdown."""
        if self.task:
            self.task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self.task


def register_clients(app: web.Application, settings: Settings) -> None:
    """Register the owner-only Check now POST; it takes no options."""
    service = ClientsService(settings)
    app[CLIENTS] = service

    async def check_now(request: web.Request) -> web.Response:
        header = request.headers.get("Authorization", "")
        try:
            verify_init_data(
                header[4:].strip() if header.lower().startswith("tma ") else "",
                settings.tokens(),
                settings.owner_id,
            )
        except InitDataError as error:
            return web.json_response(
                {"error": error.reason}, status=error.status, headers=HEADERS
            )
        if await request.read():
            return web.json_response(
                {"error": "The clients check accepts no options"},
                status=400,
                headers=HEADERS,
            )
        if not service.start():
            return web.json_response(
                {"error": "A clients check is already running"},
                status=409,
                headers=HEADERS,
            )
        return web.json_response({"started": True}, status=202, headers=HEADERS)

    async def close(_app: web.Application) -> None:
        await service.close()

    app.router.add_post("/api/ops/clients", check_now)
    app.on_cleanup.append(close)
