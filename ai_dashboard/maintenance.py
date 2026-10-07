"""Disk usage report and cleanup for the Ops window, via the ops agent's script.

The cleanup logic lives in the ai-ops-agent repo (installed as
/usr/local/sbin/ai-cleanup), so the dashboard and the ops bot share one
implementation. The dashboard only ever calls it with a fixed mode, ``report``
or ``run``; nothing from a request reaches the command line.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import signal
import time

logger = logging.getLogger(__name__)

REPORT_INTERVAL_SECONDS = 600
REPORT_TIMEOUT_SECONDS = 300
RUN_TIMEOUT_SECONDS = 900
NOT_INSTALLED = (
    "ai-cleanup is not installed on this server (see the ai-ops-agent README)"
)


async def invoke(
    command: str, mode: str, timeout: float, name: str = "ai-cleanup"
) -> dict:
    """Run ``command mode`` and return its JSON result, or an error result."""
    not_installed = NOT_INSTALLED.replace("ai-cleanup", name)
    try:
        process = await asyncio.create_subprocess_exec(
            command,
            mode,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            start_new_session=True,
        )
    except (FileNotFoundError, PermissionError):
        return {"ok": False, "error": not_installed}
    try:
        stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=timeout)
    except (asyncio.TimeoutError, asyncio.CancelledError) as error:
        # Descendants may hold pipes open or continue cleaning after the parent exits.
        with contextlib.suppress(ProcessLookupError):
            os.killpg(process.pid, signal.SIGKILL)
        await process.wait()
        if isinstance(error, asyncio.CancelledError):
            raise
        return {
            "ok": False,
            "error": f"{name} {mode} timed out after {timeout:.0f} s",
        }
    try:
        result = json.loads(stdout.decode(errors="replace"))
    except ValueError:
        detail = stderr.decode(errors="replace").strip().splitlines()[-1:] or [
            "no output"
        ]
        return {"ok": False, "error": f"{name} {mode} failed: {detail[0]}"}
    return result if isinstance(result, dict) else {"ok": False, "error": "bad output"}


class CleanupService:
    """Cached disk report plus at most one cleanup run at a time."""

    def __init__(self, command: str) -> None:
        """Remember the cleanup command; nothing runs until asked."""
        self.command = command
        self.report: dict | None = None
        self.report_at: float | None = None
        self.running = False
        self.last_run: dict | None = None
        self._task: asyncio.Task | None = None

    async def refresh_report(self) -> None:
        """Measure disk usage again (skipped while a cleanup is running)."""
        if self.running:
            return
        self.report = await invoke(self.command, "report", REPORT_TIMEOUT_SECONDS)
        self.report_at = time.time()

    async def refresh_forever(self, interval: float = REPORT_INTERVAL_SECONDS) -> None:
        """Keep the report fresh until cancelled."""
        while True:
            await self.refresh_report()
            await asyncio.sleep(interval)

    def start_run(self, triggered_by: str) -> bool:
        """Start a cleanup in the background; False if one is already running."""
        if self.running:
            return False
        self.running = True
        logger.info("Cleanup started from the %s bot", triggered_by)
        self._task = asyncio.create_task(self._run(triggered_by))
        return True

    async def _run(self, triggered_by: str) -> None:
        try:
            result = await invoke(self.command, "run", RUN_TIMEOUT_SECONDS)
            self.last_run = {
                **result,
                "triggered_by": triggered_by,
                "finished_at": time.time(),
            }
            logger.info(
                "Cleanup finished: ok=%s freed=%s bytes",
                result.get("ok"),
                result.get("freed_bytes"),
            )
            self.report = await invoke(self.command, "report", REPORT_TIMEOUT_SECONDS)
            self.report_at = time.time()
        finally:
            self.running = False

    async def close(self) -> None:
        """Stop an active cleanup and its child processes during shutdown."""
        if self._task is not None:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task

    def state(self) -> dict:
        """What the Ops window shows about disk usage and cleanup."""
        return {
            "report": self.report,
            "report_at": self.report_at,
            "running": self.running,
            "last_run": self.last_run,
        }
