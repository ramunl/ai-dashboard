"""AI tool versions and updates for the Ops window, via the ops agent's ai-tools.

The dashboard calls the command as ``check`` or ``update <tool>``, where the
tool must be one the last check listed; the command checks the name again.
Nothing runs on its own.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import time
from collections.abc import Coroutine

from ai_dashboard.maintenance import invoke
from ai_dashboard.saved_checks import SavedChecks

logger = logging.getLogger(__name__)

CHECK_TIMEOUT_SECONDS = 240
UPDATE_TIMEOUT_SECONDS = 420  # a little above the command's own


class ToolService:
    """Last check and last update, with at most one run at a time."""

    def __init__(self, command: str, saved: SavedChecks | None = None) -> None:
        """Remember the command and restore the last results; nothing runs."""
        self.command = command
        self.saved = saved or SavedChecks(None)
        self.running: str | None = None  # "check" or the tool being updated
        self.report: dict | None = self.saved.get("ai_tools", "report")
        self.last_update: dict | None = self.saved.get("ai_tools", "last_update")
        self._task: asyncio.Task | None = None

    def known_tools(self) -> list[str]:
        """Tool names from the last successful check."""
        if not self.report or not self.report.get("ok"):
            return []
        return [str(tool.get("name")) for tool in self.report.get("tools", [])]

    def start_check(self, triggered_by: str) -> bool:
        """Start a check in the background; False if a run is active."""
        return self._start("check", self._check(), triggered_by)

    def start_update(self, tool: str, triggered_by: str) -> bool:
        """Start updating a known tool; False if a run is active."""
        if tool not in self.known_tools():
            raise ValueError(f"unknown tool {tool!r}")
        return self._start(tool, self._update(tool, triggered_by), triggered_by)

    def _start(self, label: str, work: Coroutine, triggered_by: str) -> bool:
        if self.running:
            work.close()
            return False
        self.running = label
        logger.info("AI tools %s started from the %s bot", label, triggered_by)
        self._task = asyncio.create_task(self._guarded(work))
        return True

    async def _guarded(self, work: Coroutine) -> None:
        try:
            await work
        finally:
            self.running = None
            self.saved.put(
                "ai_tools", {"report": self.report, "last_update": self.last_update}
            )

    async def _check(self) -> None:
        self.report = await invoke(
            self.command, "check", CHECK_TIMEOUT_SECONDS, "ai-tools"
        )

    async def _update(self, tool: str, triggered_by: str) -> None:
        result = await invoke(
            self.command, "update", UPDATE_TIMEOUT_SECONDS, "ai-tools", (tool,)
        )
        logger.info("AI tool %s update finished: ok=%s", tool, result.get("ok"))
        self.last_update = {
            **result,
            "name": tool,
            "triggered_by": triggered_by,
            "finished_at": result.get("finished_at", time.time()),
        }
        if result.get("ok"):
            await self._check()

    async def close(self) -> None:
        """Stop waiting for an active run during shutdown."""
        if self._task is not None:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task

    def state(self) -> dict:
        """What the Ops window shows about the AI tools."""
        return {
            "running": self.running,
            "report": self.report,
            "last_update": self.last_update,
        }
