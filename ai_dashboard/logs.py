"""Recent journal lines for the Ops window's Logs card (read-only).

Only units the dashboard already monitors can be read, and the command is
fixed: the request picks a unit from that list and "all" or "errors", nothing
else reaches journalctl.
"""

from __future__ import annotations

import re
import socket
from collections.abc import Iterable

from ai_dashboard.config import Settings
from ai_dashboard.health import _run

LINES = 80
MAX_LINE_CHARS = 400
ERRORS_SINCE = "24 hours ago"


def readable_units(settings: Settings) -> list[str]:
    """Units whose logs the page may show, in a stable order."""
    units = [bot.service for bot in settings.bots] + list(settings.monitored_services)
    return list(dict.fromkeys(units))


def journal_args(unit: str, errors_only: bool) -> list[str]:
    """The fixed journalctl command for one unit."""
    args = [
        "journalctl",
        "-u",
        unit,
        "-n",
        str(LINES),
        "--no-pager",
        "-q",
        "-o",
        "short-iso",
    ]
    if errors_only:
        args += ["-p", "err", "--since", ERRORS_SINCE]
    return args


def redact_log_line(line: str, secrets: Iterable[str]) -> str:
    """Remove configured tokens and common credential formats before truncation."""
    for secret in secrets:
        if secret:
            line = line.replace(secret, "[redacted]")
    return re.sub(
        r"(?:\b\d{5,}:[A-Za-z0-9_-]{20,}|\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}|"
        r"\bgh[pousr]_[A-Za-z0-9_]{16,}|\bgithub_pat_[A-Za-z0-9_]{16,})",
        "[redacted]",
        line,
    )


async def read_logs(unit: str, errors_only: bool, secrets: Iterable[str] = ()) -> dict:
    """Last lines of a unit's journal, newest last; long lines are cut."""
    out = await _run(*journal_args(unit, errors_only), timeout=15)
    if out is None:
        return {"ok": False, "error": "journalctl is not available or timed out"}
    # Every line names this server; drop it so the message fits on screen.
    host = f" {socket.gethostname()} "
    lines = [
        redact_log_line(line.replace(host, " ", 1), secrets)[:MAX_LINE_CHARS]
        for line in out.splitlines()
        if line.strip()
    ]
    return {"ok": True, "unit": unit, "errors_only": errors_only, "lines": lines}
