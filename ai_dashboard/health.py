"""Server health for the launcher: resources, services, and computed problems.

Everything is read locally (/proc, disk usage, systemd, journald), so the
launcher keeps working when every agent is down, which is when it matters.
"""

from __future__ import annotations

import asyncio
import os
import shutil
import socket
import time
from pathlib import Path

ERROR_CACHE_SECONDS = 30
_error_cache: dict[str, tuple[float, int | None]] = {}

SEVERITY_ORDER = {"error": 0, "warning": 1, "info": 2}


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
    one, five, fifteen = (float(value) for value in text.split()[:3])
    return one, five, fifteen


def parse_uptime(text: str) -> float:
    return float(text.split()[0])


def parse_unit_show(text: str) -> dict:
    """Key=Value lines from `systemctl show`."""
    return dict(line.split("=", 1) for line in text.splitlines() if "=" in line)


# ---------------------------------------------------------------- readers


def read_resources(proc: Path = Path("/proc"), disk_path: str = "/") -> dict:
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


async def _run(*args: str, timeout: float = 10) -> str | None:
    try:
        process = await asyncio.create_subprocess_exec(
            *args, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL
        )
        stdout, _ = await asyncio.wait_for(process.communicate(), timeout=timeout)
    except (OSError, asyncio.TimeoutError):
        return None
    return stdout.decode(errors="replace")


async def unit_status(unit: str) -> dict:
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
    }


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


# ---------------------------------------------------------------- problems


def _problem(severity: str, text: str) -> dict:
    return {"severity": severity, "text": text}


def compute_problems(
    resources: dict | None, services: list[dict], coding: dict | None
) -> list[dict]:
    """Turn raw readings into what needs attention, most severe first."""
    problems: list[dict] = []
    active_units = set()

    for service in services:
        unit = service["unit"]
        if service["load_state"] == "not-found":
            problems.append(_problem("warning", f"{unit} is not installed"))
            continue
        if service["state"] != "active":
            problems.append(_problem("error", f"{unit} is {service['state']}"))
        else:
            active_units.add(unit)
        if service["restarts"] >= 3:
            problems.append(
                _problem(
                    "warning",
                    f"{unit} restarted automatically {service['restarts']} times",
                )
            )
        errors = service.get("errors_last_hour")
        if errors:
            label = "500+" if errors >= 500 else str(errors)
            problems.append(
                _problem("warning", f"{unit}: {label} errors in the last hour")
            )

    if resources:
        disk = resources["disk"]
        used = disk["used"] / disk["total"] if disk["total"] else 0
        if used >= 0.9:
            problems.append(_problem("error", f"Disk {used:.0%} full"))
        elif used >= 0.8:
            problems.append(_problem("warning", f"Disk {used:.0%} full"))
        memory = resources["memory"]
        free = memory["available"] / memory["total"] if memory["total"] else 1
        if free < 0.10:
            problems.append(
                _problem("error", f"Memory almost exhausted ({free:.0%} available)")
            )
        elif free < 0.15:
            problems.append(_problem("warning", f"Memory low ({free:.0%} available)"))
        if resources["load"][1] > 2 * resources["cpus"]:
            problems.append(
                _problem(
                    "warning",
                    f"High load: {resources['load'][1]:.2f} on {resources['cpus']} CPU",
                )
            )

    if coding:
        # A stopped service is already reported above; only add snapshot trouble
        # when the agent claims to be running.
        if coding.get("problem") and coding.get("unit") in active_units:
            problems.append(_problem("warning", f"coding agent {coding['problem']}"))
        snapshot = coding.get("snapshot") or {}
        if "(updatable)" in (snapshot.get("core") or ""):
            problems.append(
                _problem(
                    "info", "Coding agent core update available: /core update coding"
                )
            )
        queued = len(snapshot.get("queue") or [])
        if queued and not snapshot.get("running"):
            problems.append(
                _problem(
                    "info",
                    f"{queued} task(s) queued, nothing running: /confirm to resume",
                )
            )

    return sorted(problems, key=lambda problem: SEVERITY_ORDER[problem["severity"]])
