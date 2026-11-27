"""Task conflict requests must name a task, never override its saved target."""

import unittest

from ai_dashboard.agent_actions import RequestError, check


class TaskConflictRequestTests(unittest.TestCase):
    def test_accepts_task_id_and_rejects_target_overrides(self) -> None:
        body = {"action": "fix_task_conflicts", "args": {"task": "abcd1234"}}
        self.assertEqual(check(body), ("fix_task_conflicts", {"task": "abcd1234"}))
        for key in ("url", "repo"):
            with self.subTest(key=key), self.assertRaises(RequestError):
                check({**body, "args": {**body["args"], key: "untrusted"}})
        for task in (None, "", "unknown", "abcd1234;echo"):
            with self.subTest(task=task), self.assertRaises(RequestError):
                check({"action": "fix_task_conflicts", "args": {"task": task}})
