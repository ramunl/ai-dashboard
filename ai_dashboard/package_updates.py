"""System package updates for the Ops window, via the ops agent's ai-packages.

The dashboard only ever calls the command with a fixed mode, ``check`` or
``upgrade``; nothing from a request reaches the command line. Nothing runs on
its own: a check refreshes the package indexes, so it waits for the owner.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import time

from ai_dashboard.maintenance import invoke
from ai_dashboard.saved_checks import SavedChecks

logger = logging.getLogger(__name__)

TIMEOUTS = {"check": 480, "upgrade": 1020}  # a little above the command's own


class PackageService:
    """Last check and last upgrade, with at most one run at a time."""

    def __init__(self, command: str, saved: SavedChecks | None = None) -> None:
        """Remember the command and restore the last results; nothing runs."""
        self.command = command
        self.saved = saved or SavedChecks(None)
        self.running: str | None = None
        self.report: dict | None = self.saved.get("packages", "report")
        self.last_upgrade: dict | None = self.saved.get("packages", "last_upgrade")
        self._task: asyncio.Task | None = None

    def start(self, mode: str, triggered_by: str) -> bool:
        """Start a check or an upgrade in the background; False if one is active."""
        if mode not in TIMEOUTS:
            raise ValueError(f"unknown mode {mode!r}")
        if self.running:
            return False
        self.running = mode
        logger.info("Package %s started from the %s bot", mode, triggered_by)
        self._task = asyncio.create_task(self._run(mode, triggered_by))
        return True

    async def _run(self, mode: str, triggered_by: str) -> None:
        try:
            result = await invoke(self.command, mode, TIMEOUTS[mode], "ai-packages")
            logger.info("Package %s finished: ok=%s", mode, result.get("ok"))
            if mode == "check":
                self.report = result
                return
            self.last_upgrade = {
                **result,
                "triggered_by": triggered_by,
                "finished_at": result.get("finished_at", time.time()),
            }
            if result.get("ok") and self.report and self.report.get("ok"):
                # The list is stale now; keep only what the upgrade reported.
                self.report = {
                    "ok": True,
                    "total": result.get("remaining", 0),
                    "security": [],
                    "stable": [],
                    "untested": [],
                    "checked_at": self.last_upgrade["finished_at"],
                    "reboot_required": result.get("reboot_required", False),
                }
        finally:
            self.running = None
            self.saved.put(
                "packages", {"report": self.report, "last_upgrade": self.last_upgrade}
            )

    async def close(self) -> None:
        """Stop waiting for an active run during shutdown."""
        if self._task is not None:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task

    def state(self) -> dict:
        """What the Ops window shows about system packages."""
        return {
            "running": self.running,
            "report": self.report,
            "last_upgrade": self.last_upgrade,
        }
