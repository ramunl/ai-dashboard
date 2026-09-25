"""Collect what each window shows, from disk and systemd only.

The dashboard never talks to an agent process, so an agent that is down,
restarting, or deploying cannot take the dashboard with it. Instead each
agent publishes a snapshot file, and systemd says whether it is running.
"""

from __future__ import annotations

import asyncio
import json
import time
from pathlib import Path

from ai_dashboard.config import BotSource

SNAPSHOT_FORMAT = 1
# The coding agent rewrites its snapshot at least every 30 s (heartbeat).
STALE_AFTER_SECONDS = 90


async def service_state(unit: str) -> str:
    """systemd's view of a unit: active, inactive, failed, activating, ..."""
    try:
        process = await asyncio.create_subprocess_exec(
            "systemctl",
            "is-active",
            unit,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        stdout, _ = await asyncio.wait_for(process.communicate(), timeout=5)
    except (OSError, asyncio.TimeoutError):
        return "unknown"
    return stdout.decode().strip() or "unknown"


def read_snapshot(path: Path) -> tuple[dict | None, str | None]:
    """Return (snapshot, problem). Exactly one of them is None."""
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None, "has not published a snapshot yet"
    except (OSError, ValueError) as error:
        return None, f"snapshot unreadable ({type(error).__name__})"
    if not isinstance(data, dict) or data.get("format") != SNAPSHOT_FORMAT:
        return None, "published an unsupported snapshot format; update the dashboard"
    return data, None


def describe(
    state: str, snapshot: dict | None, problem: str | None, now: float
) -> dict:
    """Combine service state and snapshot into one view with at most one problem."""
    age = None
    if snapshot is not None:
        try:
            age = max(0.0, now - float(snapshot["updated_at"]))
        except (KeyError, TypeError, ValueError):
            snapshot, problem = None, "snapshot has no timestamp"

    if state != "active":
        problem = f"agent service is {state}"
    elif problem is None and age is not None and age > STALE_AFTER_SECONDS:
        problem = f"agent is running but stopped publishing {int(age)} s ago"

    return {
        "service": state,
        "snapshot": snapshot,
        "age_seconds": age,
        "stale": age is not None and age > STALE_AFTER_SECONDS,
        "problem": problem,
    }


async def agent_view(bot: BotSource, now: float | None = None) -> dict:
    state = await service_state(bot.service)
    snapshot, problem = await asyncio.to_thread(read_snapshot, bot.snapshot_file)
    view = describe(state, snapshot, problem, time.time() if now is None else now)
    return {"agent": bot.name, "unit": bot.service, **view}
