"""System package updates for the Ops window, via the ops agent's ai-packages.

The dashboard calls the command with a fixed mode: ``check`` (refreshes the
package indexes, so only when the owner asks), ``upgrade`` (only when the owner
confirms) or ``status`` (read-only; the only mode used to reconcile). Nothing
from a request reaches the command line, and no upgrade is ever started again
to settle an earlier one.

An upgrade ends as completed, failed or unknown. A timeout, a shutdown or a
restart does not show that the upgrade stopped, so its outcome stays unknown
until evidence settles it. Counts are replaced only by evidence stamped after
the upgrade started; without it they are kept but marked stale, and stale
counts never drive an upgrade.
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
STATUS_MODE = "status"  # read-only; the ops contract's reconciliation interface
STATUS_TIMEOUT = 60
UNSETTLED = ("accepted", "running", "unknown")
ACTIVE = "a package run is already active"


def _is_number(value: object) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _names(value: object) -> list[str] | None:
    if isinstance(value, list) and all(isinstance(name, str) for name in value):
        return value
    return None


def _since(upgrade: dict | None) -> float:
    started = (upgrade or {}).get("started_at")
    return float(started) if _is_number(started) else 0.0


def _counted(answer: dict, count_key: str, since: float, source: str) -> dict | None:
    """Package counts the command stamped at or after ``since``, or None.

    A count that is missing, not a whole number, or older than the upgrade is
    never read as zero or as current.
    """
    total = answer.get(count_key)
    checked_at = answer.get("checked_at")
    if not isinstance(total, int) or isinstance(total, bool) or total < 0:
        return None
    if not _is_number(checked_at) or checked_at < since:
        return None
    reboot = answer.get("reboot_required")
    return {
        "ok": True,
        "total": total,
        "security": _names(answer.get("security")),
        "stable": _names(answer.get("stable")),
        "untested": _names(answer.get("untested")),
        "checked_at": checked_at,
        "reboot_required": reboot if isinstance(reboot, bool) else None,
        "source": source,
        "stale": False,
    }


class PackageService:
    """Last check and last upgrade, with at most one run at a time."""

    def __init__(self, command: str, saved: SavedChecks | None = None) -> None:
        """Remember the command and restore the last results; nothing runs."""
        self.command = command
        self.saved = saved or SavedChecks(None)
        self.running: str | None = None
        self.reconciling = False
        self.report: dict | None = self.saved.get("packages", "report")
        self.last_upgrade: dict | None = self.saved.get("packages", "last_upgrade")
        self._task: asyncio.Task | None = None
        self._reconcile_task: asyncio.Task | None = None
        if self.last_upgrade is not None:
            # Results saved before outcomes were tracked have no state.
            self.last_upgrade.setdefault(
                "state", "completed" if self.last_upgrade.get("ok") else "failed"
            )
            if self.last_upgrade["state"] in ("accepted", "running"):
                # The dashboard stopped mid-upgrade; whether it finished is unknown.
                self._mark_unknown("the dashboard restarted while it ran")
                self._save()

    def refusal(self, mode: str) -> str | None:
        """Why a run of ``mode`` must not start now, or None when it may."""
        if self.running:
            return ACTIVE
        return self._upgrade_refusal() if mode == "upgrade" else None

    def start(self, mode: str, triggered_by: str) -> bool:
        """Start a check or an upgrade in the background; False if refused."""
        if mode not in TIMEOUTS:
            raise ValueError(f"unknown mode {mode!r}")
        if self.refusal(mode):
            return False
        started = time.time()
        self.running = mode
        logger.info("Package %s started from the %s bot", mode, triggered_by)
        if mode == "upgrade":
            # Saved before the command runs, so a restart can see it was in flight.
            self.last_upgrade = {
                "state": "accepted",
                "ok": None,
                "started_at": started,
                "triggered_by": triggered_by,
            }
            self._save()
        self._task = asyncio.create_task(self._run(mode, triggered_by, started))
        return True

    def start_reconcile(self) -> None:
        """After a restart, ask the read-only status what an upgrade left behind."""
        if self.reconciling or self.running or not self.unsettled_upgrade():
            return
        self.reconciling = True
        self._reconcile_task = asyncio.create_task(self._reconcile())

    def unsettled_upgrade(self) -> bool:
        """True while the last upgrade's outcome is not settled by evidence."""
        upgrade = self.last_upgrade
        if not upgrade or upgrade.get("state") not in UNSETTLED:
            return False
        report = self.report or {}
        proven = (
            bool(report.get("ok"))
            and not report.get("stale")
            and _is_number(report.get("checked_at"))
            and report["checked_at"] >= _since(upgrade)
        )
        return not proven

    def _upgrade_refusal(self) -> str | None:
        if self.unsettled_upgrade():
            return "the last upgrade's outcome is unknown; check for updates first"
        if not self.report or not self.report.get("ok"):
            return "check for updates before upgrading"
        if self.report.get("stale"):
            return "the package counts are cached; check for updates before upgrading"
        return None

    async def _run(self, mode: str, triggered_by: str, started: float) -> None:
        try:
            if mode == "check":
                self.report = await invoke(
                    self.command, "check", TIMEOUTS["check"], "ai-packages"
                )
                logger.info("Package check finished: ok=%s", self.report.get("ok"))
            else:
                await self._upgrade(triggered_by, started)
        except asyncio.CancelledError:
            # Stopped while the upgrade ran: its outcome is not known.
            state = (self.last_upgrade or {}).get("state")
            if mode == "upgrade" and state in ("accepted", "running"):
                self._mark_unknown("the dashboard stopped while the upgrade ran")
            raise
        finally:
            self.running = None
            self._save()

    async def _upgrade(self, triggered_by: str, started: float) -> None:
        self.last_upgrade = {**(self.last_upgrade or {}), "state": "running"}
        result = await invoke(
            self.command, "upgrade", TIMEOUTS["upgrade"], "ai-packages"
        )
        logger.info("Package upgrade finished: ok=%s", result.get("ok"))
        ok = result.get("ok") is True
        state = "completed" if ok else "failed"
        if result.get("timed_out"):
            state = "unknown"  # killed at the timeout: what it changed is not known
        self.last_upgrade = {
            **result,
            "state": state,
            "ok": ok,
            "started_at": started,
            "finished_at": time.time(),
            "triggered_by": triggered_by,
        }
        if state == "unknown":
            self._mark_unknown(result.get("error", "the upgrade timed out"))
        # Until evidence proves the counts, they are the pre-upgrade ones.
        self._mark_stale()
        # Counts from the upgrade's own answer, if it stamped them; else ask status.
        evidence = _counted(result, "remaining", started, "upgrade")
        if evidence is None:
            evidence = await self._read_status(started)
        if evidence is not None:
            self.report = evidence

    async def _reconcile(self) -> None:
        try:
            evidence = await self._read_status(_since(self.last_upgrade))
            if evidence is not None:
                self.report = evidence
        finally:
            self.reconciling = False
            self._save()

    async def _read_status(self, since: float) -> dict | None:
        """Counts from the read-only status, if stamped at or after ``since``."""
        answer = await invoke(self.command, STATUS_MODE, STATUS_TIMEOUT, "ai-packages")
        if answer.get("ok") is not True:
            return None
        return _counted(answer, "total", since, "status")

    def _mark_stale(self) -> None:
        """Counts we hold predate the upgrade and nothing has proven them since."""
        if self.report and self.report.get("ok"):
            self.report = {**self.report, "stale": True}

    def _mark_unknown(self, reason: str) -> None:
        self.last_upgrade = {
            **(self.last_upgrade or {}),
            "state": "unknown",
            "ok": None,
            "error": (
                f"Outcome unknown: {reason}. It may still be running; "
                "check for updates before upgrading."
            ),
        }
        self._mark_stale()

    def _save(self) -> None:
        self.saved.put(
            "packages", {"report": self.report, "last_upgrade": self.last_upgrade}
        )

    async def close(self) -> None:
        """Stop waiting for active runs during shutdown."""
        for task in (self._task, self._reconcile_task):
            if task is not None:
                task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await task

    def state(self) -> dict:
        """What the Ops window shows about system packages."""
        return {
            "running": self.running,
            "reconciling": self.reconciling,
            "report": self.report,
            "last_upgrade": self.last_upgrade,
            "upgrade_blocked": ACTIVE if self.running else self._upgrade_refusal(),
        }
