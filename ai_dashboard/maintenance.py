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

from ai_dashboard.saved_checks import SavedChecks

logger = logging.getLogger(__name__)

REPORT_INTERVAL_SECONDS = 600
REPORT_TIMEOUT_SECONDS = 300
RUN_TIMEOUT_SECONDS = 900
NOT_INSTALLED = (
    "ai-cleanup is not installed on this server (see the ai-ops-agent README)"
)
DIAGNOSTIC_LINES = 5  # the last stderr lines kept for a failed run
DIAGNOSTIC_CHARS = 300  # per line; keeps a runaway log out of the page


def _clip(text: str) -> str:
    return text if len(text) <= DIAGNOSTIC_CHARS else text[: DIAGNOSTIC_CHARS - 1] + "…"


def _signal_name(returncode: int) -> str | None:
    """The signal that ended a process (its return code is negative), or None."""
    if returncode >= 0:
        return None
    try:
        return signal.Signals(-returncode).name
    except ValueError:
        return f"signal {-returncode}"


def _failure(
    name: str, mode: str, returncode: int, answer: object, lines: list
) -> dict:
    """A failed run: never ok, even when it printed a JSON answer.

    The command's own error and any fields it reported are kept; with no answer
    the last stderr line says why, and the exit status says how it ended.
    """
    structured = answer.get("error") if isinstance(answer, dict) else None
    detail = str(structured) if structured else (lines[-1] if lines else "no output")
    ended = _signal_name(returncode)
    how = ""
    if ended:
        how = f" (killed by {ended})"
    elif returncode:
        how = f" (exit code {returncode})"
    result = dict(answer) if isinstance(answer, dict) else {}
    result.update(
        ok=False,
        error=_clip(f"{name} {mode} failed{how}: {detail}"),
        exit_code=None if ended else returncode,
        signal=ended,
    )
    if lines:
        result["diagnostics"] = [_clip(line) for line in lines[-DIAGNOSTIC_LINES:]]
    return result


async def invoke(
    command: str,
    mode: str,
    timeout: float,
    name: str = "ai-cleanup",
    extra: tuple[str, ...] = (),
) -> dict:
    """Run ``command mode [extra]``; return its JSON result or an error result.

    A nonzero exit is a failure even when it printed JSON. A timeout is marked
    ``timed_out``: the command was stopped, but what it changed is not known.
    """
    not_installed = NOT_INSTALLED.replace("ai-cleanup", name)
    try:
        process = await asyncio.create_subprocess_exec(
            command,
            mode,
            *extra,
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
            "timed_out": True,
            "error": f"{name} {mode} timed out after {timeout:.0f} s",
        }
    lines = [
        line.strip()
        for line in stderr.decode(errors="replace").splitlines()
        if line.strip()
    ]
    try:
        answer = json.loads(stdout.decode(errors="replace"))
    except ValueError:
        answer = None
    returncode = process.returncode
    if returncode != 0:
        return _failure(name, mode, returncode, answer, lines)
    if answer is None:
        return _failure(name, mode, 0, None, lines)
    return answer if isinstance(answer, dict) else {"ok": False, "error": "bad output"}


class CleanupService:
    """Cached disk report plus at most one cleanup run at a time."""

    def __init__(self, command: str, saved: SavedChecks | None = None) -> None:
        """Remember the command and restore the last results; nothing runs."""
        self.command = command
        self.saved = saved or SavedChecks(None)
        self.report: dict | None = self.saved.get("cleanup", "report")
        self.report_at: float | None = self.saved.get(
            "cleanup", "report_at", (int, float)
        )
        self.running = False
        self.last_run: dict | None = self.saved.get("cleanup", "last_run")
        self._task: asyncio.Task | None = None

    async def refresh_report(self) -> None:
        """Measure disk usage again (skipped while a cleanup is running)."""
        if self.running:
            return
        self.report = await invoke(self.command, "report", REPORT_TIMEOUT_SECONDS)
        self.report_at = time.time()
        self._save()

    def _save(self) -> None:
        self.saved.put(
            "cleanup",
            {
                "report": self.report,
                "report_at": self.report_at,
                "last_run": self.last_run,
            },
        )

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
            self._save()

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
