"""Verify Telegram Mini App initData from any of the owner's agent bots.

Telegram signs initData with the token of the bot the Mini App was opened
from (https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app).
The dashboard serves several bots, so it tries each configured token; the one
that verifies tells us which bot opened it.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import time
from dataclasses import dataclass
from urllib.parse import parse_qsl, urlencode

MAX_AGE_SECONDS = 24 * 60 * 60


class InitDataError(Exception):
    """initData is missing, forged, stale, or belongs to someone else."""

    def __init__(self, reason: str, status: int = 401) -> None:
        super().__init__(reason)
        self.reason = reason
        self.status = status


@dataclass(frozen=True)
class Viewer:
    bot: str
    user_id: int


def _signature(fields: dict[str, str], bot_token: str) -> str:
    check_string = "\n".join(f"{key}={value}" for key, value in sorted(fields.items()))
    secret = hmac.new(b"WebAppData", bot_token.encode(), hashlib.sha256).digest()
    return hmac.new(secret, check_string.encode(), hashlib.sha256).hexdigest()


def verify_init_data(
    init_data: str,
    tokens: dict[str, str],
    owner_id: int,
    max_age: int = MAX_AGE_SECONDS,
    now: float | None = None,
) -> Viewer:
    """Return who is viewing, if initData is genuine, fresh, and the owner's."""
    if not init_data or not tokens:
        raise InitDataError("missing initData")
    try:
        fields = dict(parse_qsl(init_data, keep_blank_values=True, strict_parsing=True))
    except ValueError as error:
        raise InitDataError("malformed initData") from error

    received = fields.pop("hash", "")
    bot = next(
        (
            name
            for name, token in tokens.items()
            if token
            and received
            and hmac.compare_digest(_signature(fields, token), received)
        ),
        None,
    )
    if bot is None:
        raise InitDataError("invalid signature")

    try:
        auth_date = int(fields["auth_date"])
    except (KeyError, ValueError) as error:
        raise InitDataError("missing auth_date") from error
    current = time.time() if now is None else now
    if current - auth_date > max_age:
        raise InitDataError("initData expired; reopen the dashboard")

    try:
        user_id = int(json.loads(fields["user"])["id"])
    except (KeyError, ValueError, TypeError) as error:
        raise InitDataError("missing user") from error
    if user_id != owner_id:
        raise InitDataError("not the bot owner", status=403)
    return Viewer(bot=bot, user_id=user_id)


def sign_init_data(fields: dict[str, str], bot_token: str) -> str:
    """Build signed initData the way Telegram does. Used by tests."""
    return urlencode({**fields, "hash": _signature(fields, bot_token)})
