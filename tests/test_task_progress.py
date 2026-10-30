"""Deployed tasks, and their todos ticked off once."""

import asyncio
import subprocess
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, Mock, patch

from ai_dashboard import task_progress as progress
from ai_dashboard.saved_checks import SavedChecks
from ai_dashboard.task_progress import (
    TaskCloser,
    close_forever,
    contains_merge,
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


class DeployedTests(unittest.IsolatedAsyncioTestCase):
    async def test_a_healthy_deployment_verified_after_the_merge_counts(self) -> None:
        after = "2026-10-08T10:00:00+00:00"
        self.assertIn("aaaa0001", await deployed_at([TASK], _deployments(after)))
        self.assertEqual(
            await deployed_at([TASK], _deployments(MERGED + 60)),
            {"aaaa0001": MERGED + 60},
        )

    async def test_earlier_unhealthy_other_repo_or_not_done_does_not(self) -> None:
        self.assertEqual(await deployed_at([TASK], _deployments(MERGED - 1)), {})
        self.assertEqual(
            await deployed_at([TASK], _deployments(MERGED + 1, "deploying")), {}
        )
        self.assertEqual(
            await deployed_at([TASK], _deployments(MERGED + 1, name="ai-pm-agent")), {}
        )
        self.assertEqual(
            await deployed_at([{**TASK, "stage": "pr"}], _deployments(MERGED + 1)), {}
        )
        self.assertEqual(await deployed_at([TASK], {"ok": False, "error": "x"}), {})

    async def test_later_verification_of_old_commit_does_not_close_task(self):
        with patch("ai_dashboard.task_progress.contains_merge", return_value=False):
            self.assertEqual(await deployed_at([TASK], _deployments(MERGED + 60)), {})
        self.assertEqual(
            await deployed_at(
                [{**TASK, "merge_commit": None}], _deployments(MERGED + 60)
            ),
            {},
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


class AncestryTests(unittest.IsolatedAsyncioTestCase):
    async def test_validation_and_equality_skip_git(self):
        with patch("ai_dashboard.task_progress.subprocess.run") as run:
            for repo, commit, merge in (
                ("unknown", "a" * 40, "a" * 40),
                ("ai-dashboard", None, "a" * 40),
                ("ai-dashboard", "--help", "a" * 40),
                ("ai-dashboard", "a" * 40, "b" * 39),
            ):
                self.assertFalse(await contains_merge(repo, commit, merge))
            self.assertTrue(await contains_merge("ai-dashboard", "a" * 40, "a" * 40))
            run.assert_not_called()

    async def test_cache_definitive_results_and_isolate_all_key_parts(self):
        with patch("ai_dashboard.task_progress.subprocess.run") as run:
            for code in (0, 1):
                run.return_value = Mock(returncode=code)
                for repo, commit, merge in (
                    ("ai-dashboard", "a", "b"),
                    ("ai-pm-agent", "a", "b"),
                    ("ai-dashboard", "c", "b"),
                    ("ai-dashboard", "a", "d"),
                ):
                    # Distinct hashes for the positive and negative cases.
                    key = (repo, commit * 39 + str(code), merge * 40)
                    before = run.call_count
                    self.assertEqual(await contains_merge(*key), code == 0)
                    self.assertEqual(await contains_merge(*key), code == 0)
                    self.assertEqual(run.call_count, before + 1)
            self.assertEqual(run.call_args.kwargs["timeout"], 2)

    async def test_lru_eviction(self):
        with (
            patch.object(progress, "MAX_ANCESTRY_RESULTS", 2),
            patch(
                "ai_dashboard.task_progress.subprocess.run",
                return_value=Mock(returncode=0),
            ) as run,
        ):

            async def check(commit):
                return await contains_merge("ai-dashboard", commit * 40, "f" * 40)

            for commit in ("a", "b", "a", "c", "a"):
                await check(commit)
            self.assertEqual(run.call_count, 3)
            await check("b")
            self.assertEqual(run.call_count, 4)

    async def test_errors_and_timeouts_are_retried(self):
        with patch("ai_dashboard.task_progress.subprocess.run") as run:
            for index, error in enumerate(
                (
                    subprocess.TimeoutExpired("git", 2),
                    OSError("missing git"),
                    Mock(returncode=128),
                )
            ):
                key = ("ai-dashboard", str(index) * 40, "f" * 40)
                run.side_effect = [error, Mock(returncode=0)]
                self.assertFalse(await contains_merge(*key))
                self.assertTrue(await contains_merge(*key))
                self.assertTrue(await contains_merge(*key))
            self.assertEqual(run.call_count, 6)

    async def test_all_callers_cancelled_error_cleans_up_and_retries(self):
        loop = asyncio.get_running_loop()
        entered = asyncio.Event()
        release = threading.Event()

        def slow_timeout(*args, **kwargs):
            loop.call_soon_threadsafe(entered.set)
            release.wait(5)
            raise subprocess.TimeoutExpired("git", 2)

        key = ("ai-dashboard", "a" * 40, "b" * 40)
        with patch(
            "ai_dashboard.task_progress.subprocess.run", side_effect=slow_timeout
        ) as run:
            caller = asyncio.create_task(contains_merge(*key))
            try:
                await asyncio.wait_for(entered.wait(), 1)
                worker = progress._checks[loop].pending[key]
                caller.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await caller
                self.assertFalse(worker.done())
                self.assertIn(key, progress._checks[loop].pending)
            finally:
                release.set()
                await asyncio.gather(caller, return_exceptions=True)
                await asyncio.gather(*progress._checks[loop].pending.values())
            self.assertEqual(progress._checks[loop].pending, {})
            self.assertNotIn(key, progress._checks[loop].results)
            run.side_effect = None
            run.return_value = Mock(returncode=0)
            self.assertTrue(await contains_merge(*key))
            self.assertEqual(run.call_count, 2)

    async def test_cancelled_callers_keep_workers_bounded_and_deduplicated(self):
        loop = asyncio.get_running_loop()
        started = asyncio.Event()
        release = threading.Event()

        def slow_git(*args, **kwargs):
            loop.call_soon_threadsafe(started.set)
            if not release.wait(5):
                raise subprocess.TimeoutExpired("git", 2)
            return Mock(returncode=0)

        with (
            patch.object(progress, "MAX_GIT_WORKERS", 1),
            patch(
                "ai_dashboard.task_progress.subprocess.run", side_effect=slow_git
            ) as run,
        ):
            first = asyncio.create_task(
                contains_merge("ai-dashboard", "a" * 40, "f" * 40)
            )
            callers = []
            try:
                await asyncio.wait_for(started.wait(), 1)
                same = asyncio.create_task(
                    contains_merge("ai-dashboard", "a" * 40, "f" * 40)
                )
                callers.append(same)
                first.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await first
                waiting = [
                    asyncio.create_task(
                        contains_merge("ai-dashboard", c * 40, "f" * 40)
                    )
                    for c in "bcde"
                ]
                callers.extend(waiting)
                await asyncio.sleep(0)
                self.assertEqual(run.call_count, 1)
                self.assertFalse(same.done())
                for task in waiting:
                    task.cancel()
                await asyncio.gather(*waiting, return_exceptions=True)
                self.assertEqual(run.call_count, 1)
            finally:
                release.set()
                await asyncio.gather(first, *callers, return_exceptions=True)
            self.assertTrue(await contains_merge("ai-dashboard", "a" * 40, "f" * 40))
            self.assertEqual(run.call_count, 1)
            self.assertEqual(progress._checks[loop].pending, {})
            self.assertTrue(await contains_merge("ai-dashboard", "b" * 40, "f" * 40))
            self.assertEqual(run.call_count, 2)
