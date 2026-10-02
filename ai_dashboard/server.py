"""HTTP routes for the Mini App: the page, one data endpoint per window, health."""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
from collections.abc import AsyncIterator
from pathlib import Path

import aiohttp
from aiohttp import web

from ai_dashboard.agent_actions import RequestError, check, submit
from ai_dashboard.auth import InitDataError, verify_init_data
from ai_dashboard.config import Settings
from ai_dashboard.deployments import TARGETS, DeploymentService
from ai_dashboard.disk_history import record_forever
from ai_dashboard.maintenance import CleanupService
from ai_dashboard.pm_bridge import invoke_pm, register_pm_routes
from ai_dashboard.sources import service_state
from ai_dashboard.telegram_api import API_BASE, set_menu_button
from ai_dashboard.views import SUB_WINDOWS, VIEW_PROVIDERS, WINDOWS

logger = logging.getLogger(__name__)

STATIC_DIR = Path(__file__).with_name("static").resolve()
PAGE = STATIC_DIR / "index.html"
SETTINGS = web.AppKey("settings", Settings)
DEPLOYMENTS = web.AppKey("deployments", DeploymentService)
CLEANUP = web.AppKey("cleanup", CleanupService)
_NO_STORE = {"Cache-Control": "no-store"}


def _init_data(request: web.Request) -> str:
    header = request.headers.get("Authorization", "")
    return header[4:].strip() if header.lower().startswith("tma ") else ""


async def page(request: web.Request) -> web.StreamResponse:
    """Serve the dashboard page for a supported window or sub-window."""
    window = request.match_info.get("window", "")
    sub = request.match_info.get("sub")
    path = f"{window}/{sub}" if sub else window
    if path not in WINDOWS and path not in SUB_WINDOWS:
        raise web.HTTPNotFound()
    return web.FileResponse(PAGE, headers=_NO_STORE)


async def static_file(request: web.Request) -> web.StreamResponse:
    """Serve the page's styles and scripts; no-store so a deploy is seen at once."""
    path = (STATIC_DIR / request.match_info["name"]).resolve()
    if not path.is_relative_to(STATIC_DIR) or not path.is_file():
        raise web.HTTPNotFound()
    return web.FileResponse(path, headers=_NO_STORE)


async def health(_request: web.Request) -> web.Response:
    """Return the HTTP service liveness response."""
    return web.json_response({"ok": True})


async def window_data(request: web.Request) -> web.Response:
    """Authenticate the owner and return the requested window data."""
    settings = request.app[SETTINGS]
    try:
        viewer = verify_init_data(
            _init_data(request), settings.tokens(), settings.owner_id
        )
    except InitDataError as error:
        return web.json_response(
            {"error": error.reason}, status=error.status, headers=_NO_STORE
        )
    provider = VIEW_PROVIDERS.get(request.match_info["window"])
    if provider is None:
        return web.json_response({"error": "unknown window"}, status=404)
    view = await provider(settings)
    if view is None:
        return web.json_response({"error": "window not configured"}, status=404)
    if request.match_info["window"] == "pm":
        view = {
            **view,
            "editing": await invoke_pm(settings.pm_command, {"action": "read"}),
        }
    if request.match_info["window"] == "ops":
        view = {
            **view,
            "cleanup": request.app[CLEANUP].state(),
            "deployments": await request.app[DEPLOYMENTS].state(),
        }
    return web.json_response({**view, "opened_from": viewer.bot}, headers=_NO_STORE)


MAX_ACTION_BODY_BYTES = 4096


async def coding_action(request: web.Request) -> web.Response:
    """Queue a setup change for the coding agent; the page polls for the result.

    The agent re-validates and runs it (see ai_dashboard/agent_actions.py).
    """
    settings = request.app[SETTINGS]
    try:
        viewer = verify_init_data(
            _init_data(request), settings.tokens(), settings.owner_id
        )
    except InitDataError as error:
        return web.json_response(
            {"error": error.reason}, status=error.status, headers=_NO_STORE
        )
    bot = settings.bot("coding")
    if bot is None or bot.inbox_dir is None:
        return web.json_response({"error": "coding agent not configured"}, status=404)
    if (request.content_length or 0) > MAX_ACTION_BODY_BYTES:
        return web.json_response({"error": "request too large"}, status=413)
    try:
        action, args = check(json.loads(await request.text()))
    except (ValueError, RequestError) as error:
        return web.json_response({"error": f"bad request: {error}"}, status=400)
    state = await service_state(bot.service)
    if state != "active":
        return web.json_response(
            {"error": f"the coding agent is {state}; try again once it runs"},
            status=503,
        )
    request_id = await asyncio.to_thread(
        submit, bot.inbox_dir, action, args, viewer.bot
    )
    logger.info("Coding action %s requested from the %s bot", action, viewer.bot)
    return web.json_response({"id": request_id}, status=202, headers=_NO_STORE)


async def cleanup_action(request: web.Request) -> web.Response:
    """Start a disk cleanup for the owner; the page polls the Ops window for it.

    The request carries no options: the cleanup set is fixed by ai-cleanup.
    """
    settings = request.app[SETTINGS]
    try:
        viewer = verify_init_data(
            _init_data(request), settings.tokens(), settings.owner_id
        )
    except InitDataError as error:
        return web.json_response(
            {"error": error.reason}, status=error.status, headers=_NO_STORE
        )
    if not request.app[CLEANUP].start_run(viewer.bot):
        return web.json_response(
            {"error": "a cleanup is already running"}, status=409, headers=_NO_STORE
        )
    return web.json_response({"started": True}, status=202, headers=_NO_STORE)


async def rollback_action(request: web.Request) -> web.Response:
    """Authenticate and queue a fixed-target rollback outside this service."""
    settings = request.app[SETTINGS]
    try:
        verify_init_data(_init_data(request), settings.tokens(), settings.owner_id)
    except InitDataError as error:
        return web.json_response(
            {"error": error.reason}, status=error.status, headers=_NO_STORE
        )
    try:
        payload = await request.json()
        if (
            not isinstance(payload, dict)
            or set(payload) != {"target", "expected_commit"}
            or payload["target"] not in TARGETS
            or not isinstance(payload["expected_commit"], str)
            or not 7 <= len(payload["expected_commit"]) <= 64
        ):
            raise ValueError("Invalid rollback request")
    except (ValueError, UnicodeDecodeError, TypeError):
        return web.json_response(
            {"error": "Invalid rollback request"}, status=400, headers=_NO_STORE
        )
    result = await request.app[DEPLOYMENTS].rollback(
        payload["target"], payload["expected_commit"]
    )
    status = 202 if result.get("ok") else 409 if result.get("conflict") else 503
    return web.json_response(result, status=status, headers=_NO_STORE)


async def _point_menu_buttons(settings: Settings, api_base: str) -> None:
    """Point every bot's menu button at its window; retry a few times at boot."""
    async with aiohttp.ClientSession() as session:
        pending = list(settings.bots)
        for attempt in range(3):
            results = [
                await set_menu_button(
                    session,
                    bot,
                    settings.owner_id,
                    f"{settings.public_url}/{bot.menu_path}",
                    api_base,
                )
                for bot in pending
            ]
            pending = [bot for bot, ok in zip(pending, results) if not ok]
            if not pending:
                return
            await asyncio.sleep(10 * (attempt + 1))


def build_app(
    settings: Settings,
    set_buttons: bool = True,
    api_base: str = API_BASE,
    record_disk: bool = True,
    refresh_cleanup: bool | None = None,
) -> web.Application:
    """Register dashboard routes and optional background startup work."""
    app = web.Application()
    app[SETTINGS] = settings
    app[DEPLOYMENTS] = DeploymentService(settings.deployment_command)
    app[CLEANUP] = CleanupService(settings.cleanup_command)
    register_pm_routes(app, settings)
    app.router.add_get("/healthz", health)
    app.router.add_get("/api/{window}", window_data)
    app.router.add_post("/api/ops/cleanup", cleanup_action)
    app.router.add_post("/api/ops/rollback", rollback_action)

    app.router.add_post("/api/coding/actions", coding_action)
    app.router.add_get("/static/{name:.+}", static_file)
    app.router.add_get("/", page)
    app.router.add_get("/{window}", page)
    app.router.add_get("/{window}/{sub}", page)

    async def menu_buttons(_app: web.Application) -> AsyncIterator[None]:
        task = asyncio.create_task(_point_menu_buttons(settings, api_base))
        yield
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task

    async def disk_recorder(_app: web.Application) -> AsyncIterator[None]:
        task = asyncio.create_task(record_forever(settings.disk_history_file))
        yield
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task

    if set_buttons:
        app.cleanup_ctx.append(menu_buttons)

    async def stop_cleanup(_app: web.Application) -> None:
        await app[CLEANUP].close()

    app.on_cleanup.append(stop_cleanup)

    async def cleanup_reports(_app: web.Application) -> AsyncIterator[None]:
        task = asyncio.create_task(app[CLEANUP].refresh_forever())
        yield
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task

    if record_disk:
        app.cleanup_ctx.append(disk_recorder)
    # Background work follows record_disk unless set explicitly (tests: off).
    if record_disk if refresh_cleanup is None else refresh_cleanup:
        app.cleanup_ctx.append(cleanup_reports)
    return app
