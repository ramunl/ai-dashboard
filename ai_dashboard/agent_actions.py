"""Setup and work requests for the coding agent: checked here, run by the agent.

The dashboard never changes the agent's state itself. It writes a request
file into the agent's inbox; the agent validates it again (it is the
authority) and runs the same code as its Telegram commands. This early check
only stops malformed requests before they reach the agent.
"""

from __future__ import annotations

import json
import os
import re
import secrets
import tempfile
import time
from pathlib import Path

_NAME = re.compile(r"^[A-Za-z0-9._-]{1,64}$")
_REPOSITORY = re.compile(r"^[A-Za-z0-9._-]{1,100}/[A-Za-z0-9._-]{1,100}$")
_MODEL = re.compile(r"^[A-Za-z0-9._:-]{1,100}$")
_AGENTS = ("codex", "claude")
_TASK = re.compile(r"^[0-9]{1,9}$")
# Free text for a plan or bug report: one line, something visible in it.
_TEXT = re.compile(r"^(?=.*\S)[^\x00-\x1f\x7f]{1,4000}$")
_KINDS = ("plan", "implement", "bugfix")

# Mirrors ai_agent.inbox.ACTIONS in the coding agent.
ACTIONS: dict[str, dict] = {
    "use_project": {"name": _NAME},
    "add_repository": {"repository": _REPOSITORY},
    "set_planner": {"value": _AGENTS},
    "set_implementer": {"value": _AGENTS},
    "switch_model": {"tool": ("claude",), "model": _MODEL},
    # Work on plans and the queue: the agent runs its own /approve, /confirm
    # and /cancel handlers and answers in the bot chat.
    "approve_plan": {},
    "confirm_work": {},
    "cancel_pending": {},
    "remove_queued": {"task": _TASK},
    # The only free text the dashboard sends: what to plan, build or fix. It
    # becomes the words after /plan, /implement or /bugfix, nothing else.
    "start_work": {"kind": _KINDS, "text": _TEXT},
}


class RequestError(Exception):
    """The request is malformed; the message says what is wrong."""


def check(body: object) -> tuple[str, dict[str, str]]:
    """Return (action, args) for a well-formed request body, else raise."""
    if not isinstance(body, dict):
        raise RequestError("expected a JSON object")
    action = body.get("action")
    spec = ACTIONS.get(action) if isinstance(action, str) else None
    if spec is None:
        raise RequestError(f"unknown action {action!r}")
    args = body.get("args")
    if not isinstance(args, dict) or set(args) != set(spec):
        raise RequestError(f"{action} expects exactly: {', '.join(sorted(spec))}")
    for key, allowed in spec.items():
        value = args[key]
        valid = isinstance(value, str) and (
            value in allowed if isinstance(allowed, tuple) else allowed.match(value)
        )
        if not valid:
            raise RequestError(f"invalid {key}")
    return action, args


def submit(inbox: Path, action: str, args: dict[str, str], requested_by: str) -> str:
    """Drop the request in the agent's inbox atomically; return its id."""
    request_id = secrets.token_hex(8)
    payload = {
        "id": request_id,
        "action": action,
        "args": args,
        "requested_at": time.time(),
        "requested_by": requested_by,
    }
    inbox.mkdir(parents=True, exist_ok=True)
    # Written under a name the agent ignores, then renamed into place, so the
    # agent never reads a half-written request.
    fd, tmp = tempfile.mkstemp(dir=inbox, prefix=".", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(payload, handle)
        os.replace(tmp, inbox / f"{request_id}.json")
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise
    return request_id
