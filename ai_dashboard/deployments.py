"""Read deployment state and queue owner-confirmed rollback in a separate service."""

from __future__ import annotations

import asyncio
import contextlib
import json
import os
import re
import signal
import time
from datetime import datetime

TARGETS = ("ai-coding-agent", "ai-pm-agent", "ai-ops-agent", "ai-dashboard")
BUSY = ("queued", "deploying", "rolling_back", "rollback_failed")
NOT_INSTALLED = (
    "Deployment manager is not installed; see the Ops installation instructions"
)


async def invoke_deployment(command: str, *arguments: str) -> dict:
    """Invoke a fixed local command without a shell or exposing its stderr."""
    try:
        process = await asyncio.create_subprocess_exec(
            command,
            *arguments,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
            start_new_session=True,
        )
    except OSError:
        return {"ok": False, "error": NOT_INSTALLED}
    try:
        stdout, _ = await asyncio.wait_for(process.communicate(), timeout=10)
    except (asyncio.TimeoutError, asyncio.CancelledError) as error:
        with contextlib.suppress(ProcessLookupError):
            os.killpg(process.pid, signal.SIGKILL)
        await process.wait()
        if isinstance(error, asyncio.CancelledError):
            raise
        return {
            "ok": False,
            "error": "Deployment request timed out; refresh before retrying",
        }
    try:
        result = json.loads(stdout)
    except ValueError:
        return {
            "ok": False,
            "error": "Deployment manager returned an unreadable response",
        }
    if not isinstance(result, dict):
        return {"ok": False, "error": "Invalid deployment response"}
    if process.returncode and not result.get("error"):
        return {
            "ok": False,
            "error": "Deployment manager failed; check its server logs",
        }
    return result


def _verified_timestamp(value: object) -> str | int | float | None:
    """Accept the manager's UTC ISO timestamp and legacy numeric readings."""
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return value if value > 0 else None
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return None
    return value if parsed.tzinfo is not None else None


def _revision(value: object) -> dict | None:
    """Limit revisions to displayable public metadata with a verified identity."""
    if not isinstance(value, dict):
        return None
    commit = value.get("commit")
    if not isinstance(commit, str) or not re.fullmatch(r"[0-9a-fA-F]{40}", commit):
        return None
    result = {"commit": commit}
    for key in ("version", "ref"):
        if isinstance(value.get(key), str):
            result[key] = value[key]
    result["verified_at"] = _verified_timestamp(value.get("verified_at"))
    return result


def deployment_state(result: dict) -> dict:
    """Expose only public deployment metadata, never configuration or history logs."""
    if not isinstance(result.get("targets"), list):
        return {
            "ok": False,
            "error": result.get("error", "Deployment status unavailable"),
        }
    targets = []
    for target in result["targets"]:
        if not isinstance(target, dict) or target.get("name") not in TARGETS:
            continue
        targets.append(
            {
                "name": target["name"],
                "status": (
                    target["status"]
                    if isinstance(target.get("status"), str)
                    else "untracked"
                ),
                "current": _revision(target.get("current")),
                "previous": _revision(target.get("previous")),
                "error": (
                    target["error"] if isinstance(target.get("error"), str) else None
                ),
            }
        )
    return {"ok": True, "targets": targets}


class DeploymentService:
    """Cache reads briefly and serialize submissions; jobs outlive the dashboard."""

    def __init__(self, command: str) -> None:
        """Configure the manager executable without starting any job."""
        self.command = command
        self._state: dict = {}
        self._read_at = 0.0
        self._lock = asyncio.Lock()

    async def state(self, force: bool = False) -> dict:
        """Return a recent sanitized status, refreshing at most every five seconds."""
        async with self._lock:
            return await self._refresh(force)

    async def _refresh(self, force: bool) -> dict:
        if force or time.monotonic() - self._read_at > 5:
            self._state = deployment_state(
                await invoke_deployment(self.command, "status")
            )
            self._read_at = time.monotonic()
        return self._state

    async def rollback(self, target: str, expected_commit: str) -> dict:
        """Queue rollback when the confirmed verified revision is still available."""
        async with self._lock:
            state = await self._refresh(True)
            if not state.get("ok"):
                return state
            if any(item["status"] in BUSY for item in state["targets"]):
                return {
                    "ok": False,
                    "conflict": True,
                    "error": "A deployment operation is already running",
                }
            item = next(
                (item for item in state["targets"] if item["name"] == target), {}
            )
            previous = item.get("previous") or {}
            if (
                not previous.get("verified_at")
                or previous.get("commit") != expected_commit
            ):
                return {
                    "ok": False,
                    "conflict": True,
                    "error": "Rollback revision changed; refresh before retrying",
                }
            result = await invoke_deployment(
                self.command,
                "submit",
                "rollback",
                target,
                "--expected-commit",
                expected_commit,
            )
            self._read_at = 0
            if result.get("status") != "queued":
                return {
                    "ok": False,
                    "conflict": True,
                    "error": result.get("error", "Rollback was not queued"),
                }
            return {"ok": True, "target": target, "status": "queued"}
