"""The launcher's Tasks row: counts from the coding agent's snapshot."""

import unittest

from ai_dashboard.config import BotSource
from ai_dashboard.views import SUB_WINDOWS, tasks_summary

CODING = BotSource("coding", "1:A", "ai-coding-agent", "coding")
PM = BotSource("pm", "2:B", "ai-pm-agent", "pm")


class TasksSummaryTests(unittest.TestCase):
    def test_counts_active_and_waiting_tasks(self) -> None:
        tasks = [
            {"stage": s}
            for s in ("todo", "planned", "implementing", "pr", "done", "stopped")
        ]
        views = [{"snapshot": {}}, {"snapshot": {"tasks": tasks}}]
        self.assertEqual(
            tasks_summary([PM, CODING], views),
            {"active": 3, "needs_you": 1, "total": 6},
        )

    def test_no_row_for_an_agent_without_tasks_or_without_data(self) -> None:
        self.assertIsNone(tasks_summary([CODING], [{"snapshot": {"queue": []}}]))
        self.assertIsNone(tasks_summary([CODING], [None]))
        self.assertIsNone(tasks_summary([PM], [{"snapshot": {"tasks": []}}]))

    def test_tasks_page_is_served(self) -> None:
        self.assertIn("tasks", SUB_WINDOWS)
