"""The one Bot API call the dashboard makes: pointing each bot's menu button here.

Setting it from the dashboard (instead of inside each agent) means the agents
need no Mini App code, and the button always points at a live dashboard.
"""

from __future__ import annotations

import logging

import aiohttp

logger = logging.getLogger(__name__)

API_BASE = "https://api.telegram.org"


async def set_menu_button(
    session: aiohttp.ClientSession,
    bot_name: str,
    token: str,
    chat_id: int,
    url: str,
    api_base: str = API_BASE,
) -> bool:
    """Best-effort. Never logs the request URL: it contains the bot token."""
    payload = {
        "chat_id": chat_id,
        "menu_button": {
            "type": "web_app",
            "text": "Dashboard",
            "web_app": {"url": url},
        },
    }
    try:
        async with session.post(
            f"{api_base}/bot{token}/setChatMenuButton",
            json=payload,
            timeout=aiohttp.ClientTimeout(total=15),
        ) as response:
            body = await response.json(content_type=None)
    except (aiohttp.ClientError, TimeoutError, ValueError) as error:
        logger.warning("Menu button for %s not set: %s", bot_name, type(error).__name__)
        return False
    if not body.get("ok"):
        logger.warning(
            "Menu button for %s not set: %s", bot_name, body.get("description", "error")
        )
        return False
    logger.info("Menu button for %s -> %s", bot_name, url)
    return True
