"""Service restarts for the Ops window, via the ops agent's ai-service.

The whitelist lives in the ops agent (ai-service list); the dashboard only
offers what that command allows, and the command checks again. Restarts are
queued, so restarting the dashboard itself still gets an answer first.
"""

from __future__ import annotations

import asyncio
import json
import logging

from ai_dashboard.commands import run_command
from ai_dashboard.health import unit_status, uptime_of

logger = logging.getLogger(__name__)

TIMEOUT_SECONDS = 120
# The observed container controlled by the Ops agent added in PR #17.
IPTV_SERVICE = "iptv-proxy"
NOT_INSTALLED = (
    "ai-service is not installed on this server (see the ai-ops-agent README)"
)


async def invoke(command: str, *args: str) -> dict:
    """Run ``command args`` and return its JSON result, or an error result."""
    try:
        process = await asyncio.create_subprocess_exec(
            command,
            *args,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
    except (FileNotFoundError, PermissionError):
        return {"ok": False, "error": NOT_INSTALLED}
    try:
        stdout, _ = await asyncio.wait_for(
            process.communicate(), timeout=TIMEOUT_SECONDS
        )
    except asyncio.TimeoutError:
        process.kill()
        await process.wait()
        return {"ok": False, "error": "ai-service timed out"}
    try:
        result = json.loads(stdout.decode(errors="replace"))
    except ValueError:
        return {"ok": False, "error": "ai-service gave an unreadable answer"}
    return result if isinstance(result, dict) else {"ok": False, "error": "bad output"}


class ServiceControl:
    """The restartable services (asked once) and restart requests."""

    def __init__(self, command: str) -> None:
        """Remember the command; the whitelist is fetched on first use."""
        self.command = command
        self.allowed: list[str] | None = None
        self.error: str | None = None

    async def services(self) -> list[str] | None:
        """Whitelisted services, or None if ai-service cannot be reached."""
        if self.allowed is None:
            result = await invoke(self.command, "list")
            if result.get("ok") and isinstance(result.get("services"), list):
                self.allowed = [str(name) for name in result["services"]]
                self.error = None
            else:
                self.error = result.get("error", "ai-service list failed")
        return self.allowed

    async def restart(self, service: str, requested_by: str) -> dict:
        """Queue a restart of an allowed service."""
        allowed = await self.services()
        if allowed is None:
            return {"ok": False, "error": self.error or NOT_INSTALLED}
        if service not in allowed:
            return {"ok": False, "error": f"unknown service '{service}'"}
        logger.info("Restart of %s requested from the %s bot", service, requested_by)
        return await invoke(self.command, "restart", service)

    async def change(self, service: str, action: str, requested_by: str) -> dict:
        """Start or stop IPTV only, through the root CLI's whitelist."""
        if action not in {"start", "stop"} or service != IPTV_SERVICE:
            return {"ok": False, "error": "unknown service or action"}
        allowed = await self.services()
        if allowed is None or service not in allowed:
            return {"ok": False, "error": "Update the Ops agent to manage IPTV"}
        logger.info("%s of %s requested from the %s bot", action, service, requested_by)
        return await invoke(self.command, action, service)

    async def reboot(self, requested_by: str) -> dict:
        """Queue a reboot of the server; ai-service refuses while work is running."""
        logger.warning("Server reboot requested from the %s bot", requested_by)
        return await invoke(self.command, "reboot")

    async def state(self, agents: list[dict], server_uptime: float | None) -> dict:
        """Each allowed service with its state and uptime, for the Services card."""
        allowed = await self.services()
        if allowed is None:
            return {"ok": False, "error": self.error or NOT_INSTALLED, "services": []}
        by_unit = {row.get("unit"): row for row in agents if row.get("unit")}
        rows = []
        for unit in allowed:
            if unit == IPTV_SERVICE:
                raw = await run_command(
                    "docker", "inspect", "--format", "{{.State.Status}}", IPTV_SERVICE
                )
                state = raw.strip() if raw else "unknown"
                rows.append(
                    {
                        "unit": unit,
                        "state": {"running": "active", "exited": "inactive"}.get(
                            state, state
                        ),
                        "up_seconds": None,
                    }
                )
                continue
            row = by_unit.get(unit)
            if row is not None:
                rows.append(
                    {
                        "unit": unit,
                        "state": row.get("service"),
                        "up_seconds": row.get("up_seconds"),
                    }
                )
                continue
            status = await unit_status(unit)  # e.g. the dashboard itself
            rows.append(
                {
                    "unit": unit,
                    "state": status["state"],
                    "up_seconds": uptime_of(status, server_uptime),
                }
            )
        return {"ok": True, "services": rows}
