"""Deployed tasks, and their todos ticked off once."""

import asyncio
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from ai_dashboard.saved_checks import SavedChecks
from ai_dashboard.task_progress import (
    TaskCloser,
    close_forever,
    deployed_at,
    is_finished,
    snapshot_tasks,
    todo_badges,
)

MERGED = 1_791_000_000.0
TASK = {
    "id": "aaaa0001",
    "repo": "ai-dashboard",
    "stage": "done",
    "merged_at": MERGED,
    "merge_commit": "a" * 40,
    "todo": "my_ai_agents:t1",
}


def _deployments(
    verified: object, status: str = "healthy", name: str = "ai-dashboard"
) -> dict:
    current = {"commit": "a" * 40, "verified_at": verified}
    return {
        "ok": True,
        "targets": [{"name": name, "status": status, "current": current}],
    }


class DeployedTests(unittest.TestCase):
    def test_a_healthy_deployment_verified_after_the_merge_counts(self) -> None:
        after = "2026-10-08T10:00:00+00:00"
        self.assertIn("aaaa0001", deployed_at([TASK], _deployments(after)))
        self.assertEqual(
            deployed_at([TASK], _deployments(MERGED + 60)), {"aaaa0001": MERGED + 60}
        )

    def test_earlier_unhealthy_other_repo_or_not_done_does_not(self) -> None:
        self.assertEqual(deployed_at([TASK], _deployments(MERGED - 1)), {})
        self.assertEqual(deployed_at([TASK], _deployments(MERGED + 1, "deploying")), {})
        self.assertEqual(
            deployed_at([TASK], _deployments(MERGED + 1, name="ai-pm-agent")), {}
        )
        self.assertEqual(
            deployed_at([{**TASK, "stage": "pr"}], _deployments(MERGED + 1)), {}
        )
        self.assertEqual(deployed_at([TASK], {"ok": False, "error": "x"}), {})

    def test_later_verification_of_old_commit_does_not_close_task(self):
        with patch("ai_dashboard.task_progress.contains_merge", return_value=False):
            self.assertEqual(deployed_at([TASK], _deployments(MERGED + 60)), {})
        self.assertEqual(
            deployed_at([{**TASK, "merge_commit": None}], _deployments(MERGED + 60)), {}
        )

    def test_finished_means_deployed_or_done_without_deployments(self) -> None:
        self.assertFalse(is_finished(TASK, {}))
        self.assertTrue(is_finished(TASK, {"aaaa0001": 1.0}))
        self.assertTrue(is_finished({**TASK, "repo": "com.randrgames.channelcast"}, {}))
        self.assertFalse(is_finished({**TASK, "stage": "pr", "repo": "other"}, {}))

    def test_tasks_are_read_from_the_coding_view(self) -> None:
        self.assertEqual(snapshot_tasks({"snapshot": {"tasks": [TASK, "x"]}}), [TASK])
        self.assertEqual(snapshot_tasks({"snapshot": {}}), [])
        self.assertEqual(snapshot_tasks(None), [])


class CloserTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.path = Path(tempfile.mkdtemp()) / "ops-checks.json"
        self.workspace = {"revision": "r7", "items": [{"id": "t1", "status": "open"}]}
        self.calls: list = []

        async def pm(command: str, payload: dict) -> dict:
            self.calls.append(payload)
            if payload["action"] == "read":
                return {"ok": True, "workspace": self.workspace}
            return {"ok": True, "workspace": self.workspace}

        self.closer = TaskCloser("ai-pm-todos", SavedChecks(self.path), pm)

    async def test_closes_the_todo_once_with_the_lists_revision(self) -> None:
        deployed = {"aaaa0001": MERGED + 60}
        self.assertEqual(
            await self.closer.close_finished([TASK], deployed), ["aaaa0001"]
        )
        self.assertEqual(
            self.calls,
            [
                {"action": "read", "project": "my_ai_agents"},
                {
                    "action": "update",
                    "project": "my_ai_agents",
                    "id": "t1",
                    "revision": "r7",
                    "status": "done",
                },
            ],
        )
        self.assertEqual(await self.closer.close_finished([TASK], deployed), [])
        self.assertEqual(len(self.calls), 2)
        again = TaskCloser("ai-pm-todos", SavedChecks(self.path), AsyncMock())
        self.assertEqual(again.closed, ["aaaa0001"])  # remembered across restarts

    async def test_waits_for_deployment_and_skips_tasks_without_a_todo(self) -> None:
        self.assertEqual(await self.closer.close_finished([TASK], {}), [])
        self.assertEqual(
            await self.closer.close_finished(
                [{**TASK, "todo": None}], {"aaaa0001": 1.0}
            ),
            [],
        )
        self.assertEqual(self.calls, [])

    async def test_a_todo_already_done_or_gone_is_not_written(self) -> None:
        self.workspace["items"] = [{"id": "t1", "status": "done"}]
        self.assertEqual(
            await self.closer.close_finished([TASK], {"aaaa0001": 1.0}), ["aaaa0001"]
        )
        self.assertEqual([call["action"] for call in self.calls], ["read"])

    async def test_a_failed_update_is_retried_on_the_next_pass(self) -> None:
        async def refusing(command: str, payload: dict) -> dict:
            if payload["action"] == "read":
                return {"ok": True, "workspace": self.workspace}
            return {"ok": False, "error": "This list changed."}

        closer = TaskCloser("ai-pm-todos", SavedChecks(self.path), refusing)
        with self.assertLogs("ai_dashboard.task_progress", "WARNING"):
            self.assertEqual(await closer.close_finished([TASK], {"aaaa0001": 1.0}), [])
        self.assertEqual(closer.closed, [])

    async def test_loop_reads_tasks_and_deployments_then_closes(self) -> None:
        reads = AsyncMock(return_value=[TASK])
        deployments = AsyncMock(return_value=_deployments(MERGED + 60))
        loop = asyncio.create_task(
            close_forever(reads, deployments, self.closer, interval=0.01)
        )
        await asyncio.sleep(0.05)
        loop.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await loop
        self.assertEqual(self.closer.closed, ["aaaa0001"])


class BadgeTests(unittest.TestCase):
    def test_newest_task_per_todo_wins_and_deployed_shows(self) -> None:
        older = {**TASK, "id": "aaaa0000", "stage": "stopped"}
        other = {"id": "aaaa0002", "todo": "my_ai_agents:t2", "stage": "implementing"}
        loose = {"id": "aaaa0003", "todo": None, "stage": "pr"}
        badges = todo_badges([older, TASK, other, loose], {"aaaa0001": 1.0})
        self.assertEqual(
            badges, {"my_ai_agents:t1": "deployed", "my_ai_agents:t2": "implementing"}
        )
