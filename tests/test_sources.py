import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from ai_dashboard import sources
from ai_dashboard.config import BotSource

NOW = 10_000.0


def _bot(snapshot_file: Path) -> BotSource:
    return BotSource("coding", "coding", "1:A", "ai-coding-agent", snapshot_file)


class DescribeTests(unittest.TestCase):
    def test_healthy(self) -> None:
        view = sources.describe("active", {"updated_at": NOW - 5}, None, NOW)
        self.assertIsNone(view["problem"])
        self.assertEqual(view["age_seconds"], 5)
        self.assertFalse(view["stale"])

    def test_service_down_wins_over_everything(self) -> None:
        view = sources.describe("failed", {"updated_at": NOW}, None, NOW)
        self.assertEqual(view["problem"], "agent service is failed")

    def test_stale_while_running(self) -> None:
        view = sources.describe("active", {"updated_at": NOW - 200}, None, NOW)
        self.assertTrue(view["stale"])
        self.assertIn("stopped publishing 200 s ago", view["problem"])

    def test_missing_timestamp(self) -> None:
        view = sources.describe("active", {"format": 1}, None, NOW)
        self.assertIsNone(view["snapshot"])
        self.assertIn("timestamp", view["problem"])


class ReadSnapshotTests(unittest.TestCase):
    def setUp(self) -> None:
        self.path = Path(tempfile.mkdtemp()) / "snapshot.json"

    def test_missing(self) -> None:
        self.assertEqual(
            sources.read_snapshot(self.path), (None, "has not published a snapshot yet")
        )

    def test_corrupt(self) -> None:
        self.path.write_text("{ nope")
        data, problem = sources.read_snapshot(self.path)
        self.assertIsNone(data)
        self.assertIn("unreadable", problem)

    def test_future_format_is_reported_not_misread(self) -> None:
        self.path.write_text(json.dumps({"format": 2, "updated_at": NOW}))
        data, problem = sources.read_snapshot(self.path)
        self.assertIsNone(data)
        self.assertIn("unsupported", problem)

    def test_valid(self) -> None:
        self.path.write_text(json.dumps({"format": 1, "updated_at": NOW, "queue": []}))
        data, problem = sources.read_snapshot(self.path)
        self.assertEqual(data["queue"], [])
        self.assertIsNone(problem)


class AgentViewTests(unittest.IsolatedAsyncioTestCase):
    async def test_combines_service_and_snapshot(self) -> None:
        path = Path(tempfile.mkdtemp()) / "snapshot.json"
        path.write_text(json.dumps({"format": 1, "updated_at": NOW - 1, "queue": []}))
        with patch.object(sources, "service_state", AsyncMock(return_value="active")):
            view = await sources.agent_view(_bot(path), now=NOW)
        self.assertEqual(view["agent"], "coding")
        self.assertEqual(view["unit"], "ai-coding-agent")
        self.assertIsNone(view["problem"])

    async def test_service_state_without_systemctl_is_unknown(self) -> None:
        with patch.object(
            sources.asyncio, "create_subprocess_exec", AsyncMock(side_effect=OSError)
        ):
            self.assertEqual(await sources.service_state("x"), "unknown")
