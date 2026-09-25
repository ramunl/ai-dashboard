"""HTTP routes for the Mini App: the page, one data endpoint per window, health."""

from __future__ import annotations

import asyncio
import contextlib
import logging
from collections.abc import AsyncIterator
from pathlib import Path

import aiohttp
from aiohttp import web

from ai_dashboard.auth import InitDataError, verify_init_data
from ai_dashboard.config import Settings
from ai_dashboard.telegram_api import API_BASE, set_menu_button
from ai_dashboard.views import VIEW_PROVIDERS, WINDOWS

logger = logging.getLogger(__name__)

PAGE = Path(__file__).with_name("static") / "index.html"
SETTINGS = web.AppKey("settings", Settings)
_NO_STORE = {"Cache-Control": "no-store"}


def _init_data(request: web.Request) -> str:
    header = request.headers.get("Authorization", "")
    return header[4:].strip() if header.lower().startswith("tma ") else ""


async def page(request: web.Request) -> web.StreamResponse:
    if request.match_info.get("window", "") not in WINDOWS:
        raise web.HTTPNotFound()
    return web.FileResponse(PAGE, headers=_NO_STORE)


async def health(_request: web.Request) -> web.Response:
    return web.json_response({"ok": True})


async def window_data(request: web.Request) -> web.Response:
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
    return web.json_response({**view, "opened_from": viewer.bot}, headers=_NO_STORE)


async def _point_menu_buttons(settings: Settings, api_base: str) -> None:
    """Point every bot's menu button at its window; retry a few times at boot."""
    async with aiohttp.ClientSession() as session:
        pending = list(settings.bots)
        for attempt in range(3):
            results = [
                await set_menu_button(
                    session,
                    bot.name,
                    bot.token,
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
    settings: Settings, set_buttons: bool = True, api_base: str = API_BASE
) -> web.Application:
    app = web.Application()
    app[SETTINGS] = settings
    app.router.add_get("/healthz", health)
    app.router.add_get("/api/{window}", window_data)
    app.router.add_get("/", page)
    app.router.add_get("/{window}", page)

    async def menu_buttons(_app: web.Application) -> AsyncIterator[None]:
        task = asyncio.create_task(_point_menu_buttons(settings, api_base))
        yield
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task

    if set_buttons:
        app.cleanup_ctx.append(menu_buttons)
    return app
