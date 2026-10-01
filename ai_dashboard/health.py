"""Server health for the launcher: resources, services, and computed problems.

Everything is read locally (/proc, disk usage, systemd, journald), so the
launcher keeps working when every agent is down, which is when it matters.
"""

from __future__ import annotations

import os
import shutil
import socket
import time
from pathlib import Path

from ai_dashboard.commands import run_command as _run
from ai_dashboard.problems import compute_problems as compute_problems

ERROR_CACHE_SECONDS = 30
_error_cache: dict[str, tuple[float, int | None]] = {}


# ---------------------------------------------------------------- parsers


def parse_meminfo(text: str) -> dict:
    """Total and available memory in bytes from /proc/meminfo."""
    values = {}
    for line in text.splitlines():
        key, _, rest = line.partition(":")
        parts = rest.split()
        if parts and parts[0].isdigit():
            values[key.strip()] = int(parts[0]) * 1024
    return {
        "total": values.get("MemTotal", 0),
        "available": values.get("MemAvailable", 0),
    }


def parse_loadavg(text: str) -> tuple[float, float, float]:
    """Parse the one-, five-, and fifteen-minute load averages."""
    one, five, fifteen = (float(value) for value in text.split()[:3])
    return one, five, fifteen


def parse_uptime(text: str) -> float:
    """Parse elapsed uptime in seconds."""
    return float(text.split()[0])


def parse_unit_show(text: str) -> dict:
    """Key=Value lines from `systemctl show`."""
    return dict(line.split("=", 1) for line in text.splitlines() if "=" in line)


# ---------------------------------------------------------------- readers


def read_resources(proc: Path = Path("/proc"), disk_path: str = "/") -> dict:
    """Read local CPU, memory, disk, and uptime measurements."""
    load = parse_loadavg((proc / "loadavg").read_text())
    memory = parse_meminfo((proc / "meminfo").read_text())
    disk = shutil.disk_usage(disk_path)
    return {
        "hostname": socket.gethostname(),
        "cpus": os.cpu_count() or 1,
        "load": list(load),
        "memory": memory,
        "disk": {"total": disk.total, "used": disk.used, "free": disk.free},
        "uptime_seconds": parse_uptime((proc / "uptime").read_text()),
    }


async def unit_status(unit: str) -> dict:
    """Read the systemd state and restart count for one unit."""
    out = await _run(
        "systemctl",
        "show",
        unit,
        "-p",
        "LoadState",
        "-p",
        "ActiveState",
        "-p",
        "SubState",
        "-p",
        "NRestarts",
        "-p",
        "ActiveEnterTimestamp",
        "-p",
        "ActiveEnterTimestampMonotonic",
    )
    fields = parse_unit_show(out or "")
    restarts = fields.get("NRestarts", "")
    return {
        "unit": unit,
        "load_state": fields.get("LoadState", "unknown"),
        "state": fields.get("ActiveState", "unknown"),
        "sub_state": fields.get("SubState", ""),
        "restarts": int(restarts) if restarts.isdigit() else 0,
        "since": fields.get("ActiveEnterTimestamp", ""),
        # Seconds after boot when the unit last started; time-zone free.
        "started_after_boot": _monotonic_seconds(
            fields.get("ActiveEnterTimestampMonotonic", "")
        ),
    }


def _monotonic_seconds(value: str) -> float | None:
    """Microseconds since boot from systemd, as seconds; None if never started."""
    microseconds = int(value) if value.isdigit() else 0
    return microseconds / 1_000_000 if microseconds else None


def uptime_of(service: dict | None, server_uptime: float | None) -> float | None:
    """How long a unit has been running, from boot-relative timestamps."""
    if not service or server_uptime is None:
        return None
    started = service.get("started_after_boot")
    if started is None or service.get("state") != "active":
        return None
    return max(0.0, server_uptime - started)


async def recent_errors(unit: str, now: float | None = None) -> int | None:
    """Error-priority journal lines in the last hour (cached; None if unknown)."""
    current = time.time() if now is None else now
    cached = _error_cache.get(unit)
    if cached and current - cached[0] < ERROR_CACHE_SECONDS:
        return cached[1]
    out = await _run(
        "journalctl",
        "-u",
        unit,
        "-p",
        "err",
        "--since",
        "1 hour ago",
        "-q",
        "-o",
        "cat",
        "--no-pager",
        "-n",
        "500",
    )
    count = None if out is None else sum(1 for line in out.splitlines() if line.strip())
    _error_cache[unit] = (current, count)
    return count
