"""Dashboard settings, validated at startup so misconfiguration fails loudly.

Bot tokens are read from each agent's own env file rather than copied here, so
rotating a token means editing one file (then restarting both services).
"""

from __future__ import annotations

import os
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path

from ai_dashboard.envfile import read_env_file


class ConfigError(Exception):
    """The dashboard cannot start with this configuration."""


@dataclass(frozen=True)
class BotSource:
    """One agent bot the dashboard serves: its token, window, and service."""

    name: str
    window: str
    token: str
    service: str
    snapshot_file: Path


@dataclass(frozen=True)
class Settings:
    public_url: str
    host: str
    port: int
    owner_id: int
    bots: tuple[BotSource, ...] = field(default_factory=tuple)

    def tokens(self) -> dict[str, str]:
        return {bot.name: bot.token for bot in self.bots}

    def bot(self, name: str) -> BotSource | None:
        return next((bot for bot in self.bots if bot.name == name), None)


def _coding_bot(environ: Mapping[str, str]) -> tuple[BotSource, int]:
    env_file = Path(
        environ.get("CODING_ENV_FILE", "/etc/ai-coding-agent/ai-coding-agent.env")
    )
    agent_env = read_env_file(env_file)
    token = agent_env.get("TELEGRAM_BOT_TOKEN", "")
    if not token:
        raise ConfigError(f"TELEGRAM_BOT_TOKEN not found in {env_file}")
    chat_id = agent_env.get("YOUR_CHAT_ID", "")
    snapshot = agent_env.get(
        "AGENT_SNAPSHOT_FILE", "/var/lib/ai-coding-agent/snapshot.json"
    )
    bot = BotSource(
        name="coding",
        window="coding",
        token=token,
        service=environ.get("CODING_SERVICE", "ai-coding-agent"),
        snapshot_file=Path(snapshot),
    )
    try:
        owner = int(chat_id)
    except ValueError:
        owner = 0
    return bot, owner


def load_settings(environ: Mapping[str, str] | None = None) -> Settings:
    env = os.environ if environ is None else environ
    public_url = env.get("DASHBOARD_PUBLIC_URL", "").strip().rstrip("/")
    if not public_url.startswith("https://"):
        raise ConfigError(
            "DASHBOARD_PUBLIC_URL must be the public https:// address "
            f"(got '{public_url}'); Telegram opens Mini Apps only over HTTPS"
        )
    port_text = env.get("DASHBOARD_PORT", "8787").strip()
    if not port_text.isdigit() or not 0 < int(port_text) < 65536:
        raise ConfigError(f"DASHBOARD_PORT must be 1-65535 (got '{port_text}')")

    coding, owner = _coding_bot(env)
    # initData identifies a *user*; comparing it to the chat id is only valid
    # for a private chat, where chat id == user id (positive numbers).
    if owner <= 0:
        raise ConfigError(
            "YOUR_CHAT_ID in the coding agent env file must be your private "
            "chat (user) id, a positive number"
        )
    return Settings(
        public_url=public_url,
        host=env.get("DASHBOARD_HOST", "127.0.0.1"),
        port=int(port_text),
        owner_id=owner,
        bots=(coding,),
    )
