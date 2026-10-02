"""What each window's API returns. Pages are listed in WINDOWS."""

from __future__ import annotations

import asyncio
import logging
import time

from ai_dashboard.config import BotSource, Settings
from ai_dashboard.disk_history import load_samples, trend
from ai_dashboard.health import (
    compute_problems,
    read_resources,
    recent_errors,
    unit_status,
    uptime_of,
)
from ai_dashboard.sources import agent_view

logger = logging.getLogger(__name__)

# path -> label. "" is the launcher.
WINDOWS = {
    "": "Overview",
    "coding": "Coding agent",
    "pm": "PM agent",
    "ops": "Ops agent",
}

# Sub-windows served at /<window>/<sub>; they read their parent's data.
SUB_WINDOWS = {"coding/projects", "coding/ai"}


async def _window_of(settings: Settings, name: str) -> dict | None:
    """An agent window's data, or None if that bot is not configured."""
    bot = settings.bot(name)
    return None if bot is None else await agent_view(bot)


async def coding_view(settings: Settings) -> dict | None:
    """Return the coding window data when its bot is configured."""
    return await _window_of(settings, "coding")


async def pm_view(settings: Settings) -> dict | None:
    """Return the PM window data when its bot is configured."""
    return await _window_of(settings, "pm")


def coding_detail(view: dict) -> str:
    """Summarize coding activity for a launcher row."""
    if view.get("service") != "active":
        return f"service {view.get('service')}"
    snapshot = view.get("snapshot") or {}
    running = snapshot.get("running")
    if running:
        phase = f" · {running['phase']}" if running.get("phase") else ""
        return f"running {running.get('branch')}{phase}"
    parts = ["idle"]
    queued = len(snapshot.get("queue") or [])
    if queued:
        parts.append(f"{queued} queued")
    project = (snapshot.get("project") or {}).get("name")
    if project:
        parts.append(project)
    return " · ".join(parts)


def pm_detail(view: dict) -> str:
    """Summarize the active TODO project for a launcher row."""
    if view.get("service") != "active":
        return f"service {view.get('service')}"
    snapshot = view.get("snapshot")
    if not snapshot:
        return "no data yet"
    todos = snapshot.get("todos")
    if not todos:
        return f"no active project · {len(snapshot.get('projects') or [])} projects"
    parts = [todos["project"], f"{todos['open_count']} open"]
    if todos.get("done"):
        parts.append(f"{todos['done']} done")
    return " · ".join(parts)


_DETAILS = {"coding": coding_detail, "pm": pm_detail}


def _agent_row(bot: BotSource, view: dict) -> dict:
    detail = _DETAILS.get(bot.name, lambda _view: "")
    return {
        "name": bot.name,
        "label": WINDOWS.get(bot.menu_path, bot.name),
        "path": bot.menu_path,
        "service": view.get("service"),
        "problem": view.get("problem"),
        "detail": detail(view),
    }


def _launcher_agents(
    settings: Settings,
    agent_bots: list[BotSource],
    views: list[dict],
    services: list[dict],
    server_uptime: float | None = None,
) -> list[dict]:
    """Combine snapshot details with service diagnostics for every configured bot."""
    rows = [_agent_row(bot, view) for bot, view in zip(agent_bots, views)]
    for bot in settings.bots:
        service = next(item for item in services if item["unit"] == bot.service)
        if bot.snapshot_file is None:
            rows.append(
                {
                    "name": bot.name,
                    "label": "Ops agent" if bot.name == "ops" else bot.name,
                    "path": bot.menu_path,
                    "service": service["state"],
                    "problem": None,
                    "detail": "Server health, logs and updates",
                }
            )
        row = next(item for item in rows if item["name"] == bot.name)
        row["unit"] = bot.service
        row["service"] = service["state"]
        row["restarts"] = service.get("restarts", 0)
        row["errors_last_hour"] = service.get("errors_last_hour", 0)
        row["load_state"] = service.get("load_state")
        row["up_seconds"] = uptime_of(service, server_uptime)
    return rows


async def launcher_view(settings: Settings) -> dict:
    """Collect server and agent readings for the overview window."""
    units = list(
        dict.fromkeys(
            (*settings.monitored_services, *(bot.service for bot in settings.bots))
        )
    )

    agent_bots = [bot for bot in settings.bots if bot.snapshot_file is not None]
    services, errors, agent_views = await asyncio.gather(
        asyncio.gather(*(unit_status(unit) for unit in units)),
        asyncio.gather(*(recent_errors(unit) for unit in units)),
        asyncio.gather(*(agent_view(bot) for bot in agent_bots)),
    )
    for service, count in zip(services, errors):
        service["errors_last_hour"] = count
    try:
        resources = await asyncio.to_thread(read_resources)
    except OSError as error:
        logger.warning("Could not read server resources: %s", error)
        resources = None
    if resources:
        samples = await asyncio.to_thread(load_samples, settings.disk_history_file)
        disk = resources["disk"]
        disk["trend"] = trend(samples, disk["total"], time.time())
    uptime = resources["uptime_seconds"] if resources else None
    rows = _launcher_agents(
        settings, agent_bots, list(agent_views), list(services), uptime
    )
    return {
        "resources": resources,
        "services": list(services),
        "agents": rows,
        "problems": compute_problems(resources, list(services), list(agent_views)),
    }


VIEW_PROVIDERS = {
    "coding": coding_view,
    "pm": pm_view,
    "launcher": launcher_view,
    # The Ops window shows the overview data plus disk cleanup (added in server).
    "ops": launcher_view,
}
