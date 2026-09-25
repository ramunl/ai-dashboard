"""Dashboard settings, validated at startup so misconfiguration fails loudly.

Bot tokens are read from each agent's own env file rather than copied here, so
rotating a token means editing one file (then restarting both services).
"""

from __future__ import annotations

import logging
import os
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path

from ai_dashboard.envfile import read_env_file

logger = logging.getLogger(__name__)

DEFAULT_MONITORED = ("ai-coding-agent", "ai-pm-agent", "ai-ops-agent")


class ConfigError(Exception):
    """The dashboard cannot start with this configuration."""


@dataclass(frozen=True)
class BotSource:
    """One agent bot: its token, systemd unit, and where its button opens.

    menu_path "" is the launcher; "coding" is /coding, and so on.
    """

    name: str
    token: str
    service: str
    menu_path: str
    snapshot_file: Path | None = None


@dataclass(frozen=True)
class Settings:
    public_url: str
    host: str
    port: int
    owner_id: int
    bots: tuple[BotSource, ...] = field(default_factory=tuple)
    monitored_services: tuple[str, ...] = DEFAULT_MONITORED

    def tokens(self) -> dict[str, str]:
        return {bot.name: bot.token for bot in self.bots}

    def bot(self, name: str) -> BotSource | None:
        return next((bot for bot in self.bots if bot.name == name), None)


@dataclass(frozen=True)
class _BotSpec:
    name: str
    env_var: str
    default_env_file: str
    token_var: str
    service_var: str
    default_service: str
    menu_path: str
    required: bool


_SPECS = (
    _BotSpec(
        "coding",
        "CODING_ENV_FILE",
        "/etc/ai-coding-agent/ai-coding-agent.env",
        "TELEGRAM_BOT_TOKEN",
        "CODING_SERVICE",
        "ai-coding-agent",
        "coding",
        required=True,
    ),
    _BotSpec(
        "ops",
        "OPS_ENV_FILE",
        "/etc/ai-ops-agent.env",
        "OPS_TELEGRAM_BOT_TOKEN",
        "OPS_SERVICE",
        "ai-ops-agent",
        "",
        required=False,
    ),
)


def _chat_id(raw: str) -> int:
    try:
        return int(raw)
    except ValueError:
        return 0


def _load_bot(
    spec: _BotSpec, environ: Mapping[str, str]
) -> tuple[BotSource, int] | None:
    env_file = Path(environ.get(spec.env_var, spec.default_env_file))
    if not env_file.is_file():
        if spec.required:
            raise ConfigError(f"{spec.name} bot env file not found: {env_file}")
        logger.warning("%s bot skipped: %s not found", spec.name, env_file)
        return None
    agent_env = read_env_file(env_file)
    token = agent_env.get(spec.token_var, "")
    if not token:
        raise ConfigError(f"{spec.token_var} not found in {env_file}")
    snapshot = None
    if spec.name == "coding":
        snapshot = Path(
            agent_env.get(
                "AGENT_SNAPSHOT_FILE", "/var/lib/ai-coding-agent/snapshot.json"
            )
        )
    bot = BotSource(
        name=spec.name,
        token=token,
        service=environ.get(spec.service_var, spec.default_service),
        menu_path=spec.menu_path,
        snapshot_file=snapshot,
    )
    return bot, _chat_id(agent_env.get("YOUR_CHAT_ID", ""))


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

    loaded = [result for spec in _SPECS if (result := _load_bot(spec, env))]
    owners = {bot.name: owner for bot, owner in loaded}
    owner = owners["coding"]
    # initData identifies a *user*; comparing it to the chat id is only valid
    # for a private chat, where chat id == user id (positive numbers).
    if owner <= 0:
        raise ConfigError(
            "YOUR_CHAT_ID in the coding agent env file must be your private "
            "chat (user) id, a positive number"
        )
    mismatched = sorted(name for name, value in owners.items() if value != owner)
    if mismatched:
        raise ConfigError(
            f"YOUR_CHAT_ID differs between bots ({', '.join(mismatched)} vs coding); "
            "the dashboard serves one owner"
        )

    monitored = tuple(
        unit.strip()
        for unit in env.get("MONITORED_SERVICES", ",".join(DEFAULT_MONITORED)).split(
            ","
        )
        if unit.strip()
    )
    return Settings(
        public_url=public_url,
        host=env.get("DASHBOARD_HOST", "127.0.0.1"),
        port=int(port_text),
        owner_id=owner,
        bots=tuple(bot for bot, _ in loaded),
        monitored_services=monitored,
    )
