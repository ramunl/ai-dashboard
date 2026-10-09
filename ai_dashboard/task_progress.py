"""The last two task stages, which only the dashboard can see: Deployed, and
the todo ticked off.

The coding agent follows a task up to its merged pull request ("done"). Whether
that merge is live is known to the deployment manager, which the dashboard
already reads: a task is deployed once its repository has a healthy deployment
verified after the merge and its deployed commit contains that merge. A
repository without deployments ends at "done".

When a task with a todo reaches its end, TaskCloser marks the todo done
through the PM bridge, once: closed task ids are remembered, so reopening the
todo by hand is respected.
"""

from __future__ import annotations

import asyncio
import logging
import re
import subprocess
from collections.abc import Awaitable, Callable
from datetime import datetime
from typing import Any

from ai_dashboard.deployments import TARGETS
from ai_dashboard.pm_bridge import invoke_pm
from ai_dashboard.saved_checks import SavedChecks

logger = logging.getLogger(__name__)

CHECK_SECONDS = 300
MAX_REMEMBERED = 200


def _epoch(value: object) -> float | None:
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return float(value)
    if isinstance(value, str):
        try:
            return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
        except ValueError:
            return None
    return None


def contains_merge(repo: str, commit: object, merge: object) -> bool:
    """Check exact deployed history; timestamps alone cannot prove inclusion."""
    if repo not in TARGETS or not all(
        isinstance(value, str) and re.fullmatch(r"[0-9a-f]{40}", value)
        for value in (commit, merge)
    ):
        return False
    if commit == merge:
        return True
    try:
        result = subprocess.run(
            ["git", "-C", f"/opt/{repo}", "merge-base", "--is-ancestor", merge, commit],
            capture_output=True,
            timeout=2,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return False
    return result.returncode == 0


def deployed_at(tasks: list, deployments: dict) -> dict[str, float]:
    """Task id -> time of the verified deployment that contains its merge."""
    if not deployments.get("ok"):
        return {}
    live = {}
    for target in deployments.get("targets", []):
        current = target.get("current") or {}
        verified = _epoch(current.get("verified_at"))
        if target.get("status") == "healthy" and verified is not None:
            live[target["name"]] = (verified, current.get("commit"))
    result = {}
    for task in tasks:
        merged = task.get("merged_at") if task.get("stage") == "done" else None
        verified, commit = live.get(task.get("repo"), (None, None))
        if (
            isinstance(merged, (int, float))
            and verified is not None
            and verified >= merged
            and contains_merge(task.get("repo"), commit, task.get("merge_commit"))
        ):
            result[task["id"]] = verified
    return result


def is_finished(task: dict, deployed: dict[str, float]) -> bool:
    """Done for a repository without deployments, otherwise deployed."""
    if task.get("stage") != "done":
        return False
    return task.get("repo") not in TARGETS or task.get("id") in deployed


class TaskCloser:
    """Tick off the todo of each finished task, once."""

    def __init__(
        self,
        pm_command: str,
        saved: SavedChecks,
        pm: Callable[[str, dict], Awaitable[dict]] = invoke_pm,
    ) -> None:
        """Remember where todos live and which tasks were already closed."""
        self.pm_command = pm_command
        self.saved = saved
        self.pm = pm
        stored = saved.get("tasks", "closed", list) or []
        self.closed: list[str] = [str(item) for item in stored]

    def _remember(self, task_id: str) -> None:
        self.closed = [*self.closed, task_id][-MAX_REMEMBERED:]
        self.saved.put("tasks", {"closed": self.closed})

    async def close_finished(
        self, tasks: list, deployed: dict[str, float]
    ) -> list[str]:
        """Mark the todos of finished tasks done; return the task ids closed now."""
        closed_now = []
        for task in tasks:
            todo = task.get("todo")
            if (
                not todo
                or task.get("id") in self.closed
                or not is_finished(task, deployed)
            ):
                continue
            project, _, todo_id = str(todo).partition(":")
            if await self._close(project, todo_id):
                self._remember(task["id"])
                closed_now.append(task["id"])
        return closed_now

    async def _close(self, project: str, todo_id: str) -> bool:
        """True when the todo is done now (or gone); False to retry later."""
        read = await self.pm(self.pm_command, {"action": "read", "project": project})
        workspace = read.get("workspace") if read.get("ok") else None
        if not isinstance(workspace, dict):
            logger.warning(
                "Todo %s:%s not closed: %s", project, todo_id, read.get("error")
            )
            return False
        item = next(
            (i for i in workspace.get("items", []) if i.get("id") == todo_id), None
        )
        if item is None or item.get("status") == "done":
            return True  # deleted or already ticked off by hand
        result = await self.pm(
            self.pm_command,
            {
                "action": "update",
                "project": project,
                "id": todo_id,
                "revision": workspace.get("revision"),
                "status": "done",
            },
        )
        if not result.get("ok"):
            logger.warning(
                "Todo %s:%s not closed: %s", project, todo_id, result.get("error")
            )
            return False
        logger.info("Todo %s:%s closed: its task is finished", project, todo_id)
        return True


def todo_badges(tasks: list, deployed: dict[str, float]) -> dict[str, str]:
    """Todo reference -> stage of its newest task, for badges in the PM window."""
    badges = {}
    for task in tasks:  # oldest first, so the newest task wins
        if task.get("todo"):
            stage = "deployed" if task.get("id") in deployed else task.get("stage")
            badges[str(task["todo"])] = str(stage)
    return badges


def task_progress(tasks: list, deployments: dict, closer: TaskCloser) -> dict:
    """What the Tasks window adds to the agent's stages."""
    return {
        "deployed": deployed_at(tasks, deployments),
        "deployable": list(TARGETS),
        "closed": [
            task_id
            for task_id in closer.closed
            if any(t.get("id") == task_id for t in tasks)
        ],
    }


async def close_forever(
    read_tasks: Callable[[], Awaitable[list]],
    read_deployments: Callable[[], Awaitable[dict]],
    closer: TaskCloser,
    interval: float = CHECK_SECONDS,
) -> None:
    """Close finished tasks' todos until cancelled; failures are logged and retried."""
    while True:
        try:
            tasks = await read_tasks()
            if tasks:
                deployments = await read_deployments()
                await closer.close_finished(tasks, deployed_at(tasks, deployments))
        except Exception as error:
            logger.warning("Closing finished todos failed (will retry): %s", error)
        await asyncio.sleep(interval)


def snapshot_tasks(view: Any) -> list:
    """The task list from a coding window view, or [] for an agent without tasks."""
    tasks = ((view or {}).get("snapshot") or {}).get("tasks")
    return (
        [task for task in tasks if isinstance(task, dict)]
        if isinstance(tasks, list)
        else []
    )
