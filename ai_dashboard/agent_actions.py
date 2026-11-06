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
import shutil
import tempfile
import threading
import time
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path

_NAME = re.compile(r"^[A-Za-z0-9._-]{1,64}$")
_REPOSITORY = re.compile(r"^[A-Za-z0-9._-]{1,100}/[A-Za-z0-9._-]{1,100}$")
_MODEL = re.compile(r"^[A-Za-z0-9._:-]{1,100}$")
_AGENTS = ("codex", "claude")
_TASK = re.compile(r"^[0-9]{1,9}$")
# Free text for a plan or bug report: one line, something visible in it.
_TEXT = re.compile(r"^(?=.*\S)[^\x00-\x1f\x7f]{1,4000}$")
_KINDS = ("plan", "implement", "bugfix")
_TASK_ID = re.compile(r"^[0-9a-f]{8}$")
_COUNT = re.compile(r"^([0-9]|[1-4][0-9]|50)$")  # runs per day, 0 = no cap
_REVIEWS = re.compile(r"^([0-9]|10)$")
_PERCENT = re.compile(r"^([0-9]|[1-8][0-9]|90)$")  # reserve, 0-90 %
# Where a task came from: "<todo project>:<todo id>", or "-" for none.
_TODO_REF = re.compile(r"^(-|[A-Za-z0-9._-]{1,64}:[A-Za-z0-9]{1,64})$")
# Up to MAX_IMAGES staged uploads for a task: their ids, comma-separated, or "".
_UPLOADS = re.compile(r"^(?:[0-9a-f]{16}(?:,[0-9a-f]{16}){0,2})?$")
# Context controls (CTX05), mirrored from ai_agent.context_controls. The scope
# is a task or an initiative; the id is its 8-hex id. kind names which part of
# the context to inspect or re-link; decision is a bounded code the agent
# assigns, and revision is the decision revision being approved or rejected.
_CONTEXT_SCOPE = re.compile(r"^(task|initiative)$")
_CONTEXT_KIND = re.compile(r"^[a-z][a-z0-9_-]{0,31}$")
_CONTEXT_ID = re.compile(r"^[0-9a-f]{8}$")
_CONTEXT_DECISION = re.compile(r"^[a-z][a-z0-9_.:/-]{1,127}$")
_CONTEXT_REVISION = re.compile(r"^[1-9][0-9]{0,8}$")

# DS05 snapshot capability contract (pinned here; the page mirrors it in
# static/js/registry.js). The coding agent publishes, under the top-level
# snapshot key "registry", which tools each role may run, what each tool can
# do, and which providers expose limits:
#
#   {
#     "registry": {
#       "format": 1,
#       "roles": {
#         "planner": {"tool": "<tool id>", "options": ["<tool id>", ...]},
#         "implementer": {"tool": "<tool id>", "options": ["<tool id>", ...]},
#       },
#       "tools": {
#         "<tool id>": {
#           "label": "<display text>",
#           "provider": "<provider id>",
#           "model": "<model id>" | null,
#           "models": ["<model id>", ...],
#           "manageable": true | false,
#           "note": "<text>" | null,
#           "models_error": "<text>" | null,
#         },
#       },
#       "providers": {
#         "<provider id>": {
#           "label": "<display text>",
#           "kind": "subscription" | "api",
#           "limits": "<snapshot.limits key>",
#         },
#       },
#     },
#   }
#
# "roles" and "tools" drive the action allowlists below; "providers" drives
# the limits card only and is read by the page. A snapshot without a registry
# (an older agent) keeps the legacy codex/claude choices in
# LEGACY_CAPABILITIES; a malformed registry is never trusted and also falls
# back, so a value from a broken or stale snapshot cannot reach the agent.
REGISTRY_FORMAT = 1
_REGISTRY_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
_REGISTRY_ROLES = ("planner", "implementer")

# Images a task may carry, and how each one is kept: only the declared type
# picks the suffix. The bytes are never parsed here; the agent checks them.
MAX_IMAGES = 3
MAX_IMAGE_BYTES = 5 * 1024 * 1024
IMAGE_TYPES = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
    "image/gif": ".gif",
}
# The agent's per-request upload folders (ai_agent.image_uploads): inbox/uploads/
# <request id>/<name>. It keeps at most this many unclaimed at once.
UPLOADS_DIR = "uploads"
UPLOAD_BATCHES = 4
# A staged image no task has taken within this long is deleted.
STAGED_AFTER_SECONDS = 3600

# Mirrors ai_agent.inbox.ACTIONS in the coding agent. The dashboard sends the
# staged ids in "images"; submit() moves the files into the request's upload
# folder and replaces the ids with their names, as the agent expects.
ACTIONS: dict[str, dict] = {
    "use_project": {"name": _NAME},
    "add_repository": {"repository": _REPOSITORY},
    "set_planner": {"value": _AGENTS},
    "set_implementer": {"value": _AGENTS},
    "switch_model": {"tool": ("claude", "codex"), "model": _MODEL},
    # Work on plans and the queue: the agent runs its own /approve, /confirm
    # and /cancel handlers and answers in the bot chat.
    "approve_plan": {},
    "confirm_work": {},
    "cancel_pending": {},
    "remove_queued": {"task": _TASK},
    # The only free text the dashboard sends: what to plan, build or fix. It
    # becomes the words after /plan, /implement or /bugfix, nothing else.
    "start_work": {"kind": _KINDS, "text": _TEXT},
    # A revision note for the pending plan: the words after /discuss.
    "discuss_plan": {"text": _TEXT},
    # An answer to the agent's bugfix questions: the words after /answer.
    "answer_bugfix": {"text": _TEXT},
    # Tasks: made from a todo (or not), planned in their repository.
    "create_task": {
        "repo": _NAME,
        "text": _TEXT,
        "todo": _TODO_REF,
        "images": _UPLOADS,
    },
    "create_autopilot_task": {"repo": _NAME, "text": _TEXT, "todo": _TODO_REF},
    "set_autopilot": {"task": _TASK_ID, "value": ("on", "off")},
    "start_task": {"task": _TASK_ID},
    # Archive the finished attempt and return to To do for fresh planning.
    "reopen_task": {"task": _TASK_ID},
    "cancel_start": {"task": _TASK_ID},
    "stop_task": {"task": _TASK_ID, "token": re.compile(r"[a-f0-9]{32}")},
    "remove_task": {"task": _TASK_ID},
    # Tasks the worker proposed from the server logs: keep or drop.
    "accept_task": {"task": _TASK_ID},
    "dismiss_task": {"task": _TASK_ID},
    # A plan for several repositories: one task per repository, in order.
    "split_plan": {},
    # Explicitly start fresh, or resume a validated saved checkpoint.
    "retry_task": {"task": _TASK_ID, "tool": ("codex", "claude")},
    "resume_task": {"task": _TASK_ID, "tool": ("codex", "claude")},
    # The autonomous worker: on/off and its budget.
    "worker_switch": {"value": ("on", "off")},
    "worker_settings": {"max_runs": _COUNT, "reserve": _PERCENT},
    "worker_tools": {"value": ("auto", "fixed")},
    "worker_scan": {},
    # Daily code review: proposals per review (0 = off), and review now.
    "worker_reviews": {"value": _REVIEWS},
    "worker_review": {},
    # Context (CTX05): inspect or refresh prerequisite evidence, re-link a
    # handoff packet, or approve / reject a pending decision at a revision.
    # The dashboard only queues these: the agent re-validates and, for an
    # approve/reject, confirms in the owner's chat before it applies.
    "context_inspect_v1": {
        "scope": _CONTEXT_SCOPE,
        "kind": _CONTEXT_KIND,
        "id": _CONTEXT_ID,
    },
    "context_link_v1": {
        "scope": _CONTEXT_SCOPE,
        "kind": _CONTEXT_KIND,
        "id": _CONTEXT_ID,
    },
    "context_approve_v1": {
        "scope": _CONTEXT_SCOPE,
        "id": _CONTEXT_ID,
        "decision": _CONTEXT_DECISION,
        "revision": _CONTEXT_REVISION,
    },
    "context_reject_v1": {
        "scope": _CONTEXT_SCOPE,
        "id": _CONTEXT_ID,
        "decision": _CONTEXT_DECISION,
        "revision": _CONTEXT_REVISION,
    },
}

# Context envelopes omit requested_by: the agent refuses a context request that
# carries one, so submit() must not add it for these actions.
_CONTEXT_ACTIONS = frozenset(
    (
        "context_inspect_v1",
        "context_link_v1",
        "context_approve_v1",
        "context_reject_v1",
    )
)


@dataclass(frozen=True)
class Capabilities:
    """The tool ids each registry-driven action accepts."""

    planner: tuple[str, ...]
    implementer: tuple[str, ...]
    switch_tools: tuple[str, ...]
    retry_tools: tuple[str, ...]


# The pre-DS05 choices, kept verbatim so an owner on an old snapshot sees the
# same behaviour as today: planner/implementer pick codex or claude, models
# switch on claude or codex, and retry/resume re-run with codex or claude.
LEGACY_CAPABILITIES = Capabilities(
    planner=("codex", "claude"),
    implementer=("codex", "claude"),
    switch_tools=("claude", "codex"),
    retry_tools=("codex", "claude"),
)


def capabilities(snapshot: object | None) -> Capabilities | None:
    """Return the DS05 registry's validated allowlists, or None for legacy.

    A missing or malformed registry returns None: the caller uses
    LEGACY_CAPABILITIES, so an old snapshot keeps today's codex/claude
    choices and a bad registry can never widen what a request may send.
    """
    registry = snapshot.get("registry") if isinstance(snapshot, dict) else None
    if not isinstance(registry, dict):
        return None
    if type(registry.get("format")) is not int or registry["format"] != REGISTRY_FORMAT:
        return None
    tools = _registry_tools(registry.get("tools"))
    if tools is None:
        return None
    roles = _registry_roles(registry.get("roles"), tools)
    if roles is None:
        return None
    switch = tuple(name for name, tool in tools.items() if tool["manageable"])
    return Capabilities(
        planner=roles["planner"],
        implementer=roles["implementer"],
        switch_tools=switch,
        # Retrying or resuming a task re-runs implementation, so it accepts
        # exactly the tools the implementer role may run.
        retry_tools=roles["implementer"],
    )


def _registry_tools(value: object) -> dict[str, dict] | None:
    """Validate the registry's tools map, or None if any entry is unusable."""
    if not isinstance(value, dict):
        return None
    tools: dict[str, dict] = {}
    for name, entry in value.items():
        if not isinstance(name, str) or not _REGISTRY_ID.match(name):
            return None
        if not isinstance(entry, dict):
            return None
        label, provider = entry.get("label"), entry.get("provider")
        model, models = entry.get("model"), entry.get("models")
        if (
            not isinstance(label, str)
            or not label.strip()
            or not isinstance(provider, str)
            or not _REGISTRY_ID.match(provider)
            or not isinstance(entry.get("manageable"), bool)
            or "model" not in entry
            or (
                model is not None
                and (not isinstance(model, str) or not _MODEL.match(model))
            )
            or not isinstance(models, list)
            or any(
                not isinstance(item, str) or not _MODEL.match(item)
                for item in models
            )
        ):
            return None
        tools[name] = {
            "label": label,
            "provider": provider,
            "model": model,
            "models": tuple(models),
            "manageable": entry["manageable"],
        }
    return tools


def _registry_roles(
    value: object, tools: dict[str, dict]
) -> dict[str, tuple[str, ...]] | None:
    """Validate both roles against the tools map, or None if unusable."""
    if not isinstance(value, dict):
        return None
    roles: dict[str, tuple[str, ...]] = {}
    for role in _REGISTRY_ROLES:
        entry = value.get(role)
        if not isinstance(entry, dict):
            return None
        tool, options = entry.get("tool"), entry.get("options")
        if not isinstance(tool, str) or not isinstance(options, list) or not options:
            return None
        if any(not isinstance(item, str) or item not in tools for item in options):
            return None
        if tool not in options:
            return None
        roles[role] = tuple(dict.fromkeys(options))
    return roles


class RequestError(Exception):
    """The request is malformed; the message says what is wrong."""


# Held while submit() checks that each staged image is still there and moves
# it, so two requests for the same ids cannot both pass the check.
_MOVE_LOCK = threading.Lock()


def check(
    body: object, caps: Capabilities | None = None
) -> tuple[str, dict[str, str]]:
    """Return (action, args) for a well-formed request body, else raise.

    caps is the validated DS05 capability allowlist from capabilities(); None
    keeps the legacy codex/claude choices. It is never read from the request,
    only from the coding agent's own snapshot.
    """
    if not isinstance(body, dict):
        raise RequestError("expected a JSON object")
    action = body.get("action")
    spec = ACTIONS.get(action) if isinstance(action, str) else None
    if spec is None:
        raise RequestError(f"unknown action {action!r}")
    spec = _with_capabilities(spec, action, caps or LEGACY_CAPABILITIES)
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


def _with_capabilities(
    spec: dict[str, object], action: str, caps: Capabilities
) -> dict[str, object]:
    """Apply the snapshot's tool allowlists to the registry-driven actions."""
    overrides = {
        "set_planner": {"value": caps.planner},
        "set_implementer": {"value": caps.implementer},
        "switch_model": {"tool": caps.switch_tools},
        "retry_task": {"tool": caps.retry_tools},
        "resume_task": {"tool": caps.retry_tools},
    }
    if action not in overrides:
        return spec
    return {**spec, **overrides[action]}


def staged_images(directory: Path, value: str) -> list[Path] | None:
    """The staged files for a request's upload ids, in order; None if any is gone."""
    ids = [part for part in value.split(",") if part]
    if len(set(ids)) != len(ids):
        return None
    paths = []
    for upload_id in ids:
        found = next(directory.glob(f"{upload_id}.*"), None)
        if found is None:
            return None
        paths.append(found)
    return paths


def sweep_staged(directory: Path, now: float) -> None:
    """Delete staged images and half-written uploads nobody took in time."""
    if not directory.is_dir():
        return
    for path in directory.iterdir():
        try:
            stale = now - path.stat().st_mtime > STAGED_AFTER_SECONDS
        except FileNotFoundError:  # taken by a task meanwhile
            continue
        if stale:
            path.unlink(missing_ok=True)


def submit(
    inbox: Path,
    action: str,
    args: dict[str, str],
    requested_by: str,
    images: Sequence[Path] = (),
) -> str:
    """Drop the request in the agent's inbox atomically; return its id.

    Images go in first, as uploads/<id>/<n><suffix>, and the request lists
    their names ({"name": ...}), so the agent never reads a request whose
    images are still on their way. A task without images sends no "images".
    """
    request_id = secrets.token_hex(8)
    args = {key: value for key, value in args.items() if key != "images"}
    if images:
        args["images"] = [
            {"name": f"{number}{image.suffix}"}
            for number, image in enumerate(images, 1)
        ]
    payload = {
        "id": request_id,
        "action": action,
        "args": args,
        "requested_at": time.time(),
    }
    if action not in _CONTEXT_ACTIONS:
        payload["requested_by"] = requested_by
    inbox.mkdir(parents=True, exist_ok=True)
    folder = inbox / UPLOADS_DIR / request_id
    moved: list[tuple[Path, Path]] = []
    try:
        if images:
            _make_upload_folder(inbox, folder)
        with _MOVE_LOCK:
            for number, image in enumerate(images, 1):
                target = folder / f"{number}{image.suffix}"
                if not image.is_file():
                    raise _gone(image)
                try:
                    shutil.move(image, target)
                except FileNotFoundError:  # swept as stale after the check
                    raise _gone(image) from None
                moved.append((image, target))
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
    except BaseException:
        # Put back every image already moved, so a failed request leaves the
        # staged images as they were and a retry sees the same state.
        for image, target in moved:
            shutil.move(target, image)
        shutil.rmtree(folder, ignore_errors=True)
        raise
    return request_id


def _make_upload_folder(inbox: Path, folder: Path) -> None:
    """Create uploads/<id>/, refusing when the agent's batch budget is used up.

    The agent deletes all but the newest UPLOAD_BATCHES unclaimed folders, so
    a fifth one at once would lose a batch; ask to wait instead.
    """
    root = inbox / UPLOADS_DIR
    root.mkdir(mode=0o700, exist_ok=True)
    if root.is_symlink():
        raise RequestError("the agent's upload folder is not a folder")
    waiting = [
        path
        for path in root.iterdir()
        if path.is_dir() and not (path / ".claimed").exists()
    ]
    if len(waiting) >= UPLOAD_BATCHES:
        raise RequestError(
            "the coding agent has not taken the last images yet; try again shortly"
        )
    folder.mkdir(mode=0o700)


def _gone(image: Path) -> RequestError:
    """The error for a staged image that is no longer there."""
    return RequestError(f"image {image.stem} is missing or was already used")
