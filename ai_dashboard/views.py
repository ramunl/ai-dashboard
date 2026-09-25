"""What each window's API returns. Pages are listed in WINDOWS."""

from __future__ import annotations

import asyncio
import logging

from ai_dashboard.config import Settings
from ai_dashboard.health import (
    compute_problems,
    read_resources,
    recent_errors,
    unit_status,
)
from ai_dashboard.sources import agent_view

logger = logging.getLogger(__name__)

# path -> label. "" is the launcher. A window appears here when it exists.
WINDOWS = {"": "Overview", "coding": "Coding agent"}


async def coding_view(settings: Settings) -> dict:
    return await agent_view(settings.bot("coding"))


def _coding_summary(view: dict) -> dict:
    snapshot = view.get("snapshot") or {}
    running = snapshot.get("running")
    project = snapshot.get("project") or {}
    return {
        "service": view.get("service"),
        "problem": view.get("problem"),
        "project": project.get("name"),
        "running": running.get("branch") if running else None,
        "phase": running.get("phase") if running else None,
        "queued": len(snapshot.get("queue") or []),
    }


async def launcher_view(settings: Settings) -> dict:
    units = list(settings.monitored_services)
    services, errors, coding = await asyncio.gather(
        asyncio.gather(*(unit_status(unit) for unit in units)),
        asyncio.gather(*(recent_errors(unit) for unit in units)),
        agent_view(settings.bot("coding")),
    )
    for service, count in zip(services, errors):
        service["errors_last_hour"] = count
    try:
        resources = await asyncio.to_thread(read_resources)
    except OSError as error:
        logger.warning("Could not read server resources: %s", error)
        resources = None
    return {
        "resources": resources,
        "services": list(services),
        "coding": _coding_summary(coding),
        "problems": compute_problems(resources, list(services), coding),
        "windows": [
            {"path": path, "label": label} for path, label in WINDOWS.items() if path
        ],
    }


VIEW_PROVIDERS = {"coding": coding_view, "launcher": launcher_view}
