import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from ai_dashboard import sources
from ai_dashboard.config import BotSource

NOW = 10_000.0


def _bot(snapshot_file: Path) -> BotSource:
    return BotSource("coding", "1:A", "ai-coding-agent", "coding", snapshot_file)


class DescribeTests(unittest.TestCase):
    def test_healthy(self) -> None:
        view = sources.describe("active", {"updated_at": NOW - 5}, None, NOW)
        self.assertIsNone(view["problem"])
        self.assertEqual(view["age_seconds"], 5)
        self.assertFalse(view["stale"])

    def test_service_down_wins_over_everything(self) -> None:
        view = sources.describe("failed", {"updated_at": NOW}, None, NOW)
        self.assertEqual(view["problem"], "service is failed")

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

    def test_pm_todo_sort_fields_pass_through_unchanged(self) -> None:
        # The page sorts by these; a todo from before dates has no "created".
        items = [
            {"id": "a", "created": "2026-10-01T09:00:00+00:00", "priority": "high"},
            {"id": "b", "created": 1791800000, "priority": "low", "index": 1},
            {"id": "c", "priority": "normal", "index": 2},
        ]
        self.path.write_text(
            json.dumps({"format": 1, "updated_at": NOW, "todos": {"items": items}})
        )
        data, problem = sources.read_snapshot(self.path)
        self.assertIsNone(problem)
        self.assertEqual(data["todos"]["items"], items)


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


class CodingAuthenticationTests(unittest.TestCase):
    def test_auth_contract_survives_read_path(self) -> None:
        # Producer: ai-coding-agent 67d9a93, docs/snapshot_publisher.py.md.
        # Additive format-2 setup.models[].auth; no format bump needed here.
        records = [
            {
                "tool": tool,
                "auth": {
                    "status": status,
                    "method": method,
                    "checked_at": NOW - 901,
                    "stale": True,
                    "relogin_at": deadline,
                    "days_remaining": days,
                    "countdown_support": support,
                    "warnings": warnings,
                },
            }
            for tool, status, method, deadline, days, support, warnings in [
                (
                    "codex",
                    "authenticated",
                    "oauth",
                    None,
                    None,
                    "no_authoritative_deadline",
                    ["auth_stale", "check_unavailable"],
                ),
                (
                    "claude-code",
                    "logged_out",
                    "none",
                    NOW,
                    0,
                    "supported",
                    ["login_required", "auth_stale"],
                ),
                (
                    "claude",
                    "configured_unverified",
                    "api_key",
                    None,
                    None,
                    "no_authoritative_deadline",
                    ["auth_stale"],
                ),
            ]
        ]
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "snapshot.json"
            for version in sources.CODING_SNAPSHOT_FORMATS:
                with self.subTest(version=version):
                    snapshot = {
                        "format": version,
                        "updated_at": NOW,
                        "setup": {"models": records},
                    }
                    path.write_text(json.dumps(snapshot))
                    data, problem = sources.read_snapshot(
                        path, sources.CODING_SNAPSHOT_FORMATS
                    )
                    view = sources.describe("active", data, problem, NOW)
                    self.assertIsNone(view["problem"])
                    self.assertFalse(view["stale"])
                    self.assertEqual(view["snapshot"], snapshot)
                    # Heartbeat freshness must not refresh auth observations.
                    auth = view["snapshot"]["setup"]["models"][0]["auth"]
                    self.assertTrue(auth["stale"])
                    self.assertEqual(auth["checked_at"], NOW - 901)

    def test_older_snapshot_without_auth_remains_supported(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "snapshot.json"
            for version in sources.CODING_SNAPSHOT_FORMATS:
                snapshot = {"format": version, "updated_at": NOW}
                path.write_text(json.dumps(snapshot))
                data, problem = sources.read_snapshot(
                    path, sources.CODING_SNAPSHOT_FORMATS
                )
                view = sources.describe("active", data, problem, NOW)
                self.assertIsNone(view["problem"])
                self.assertEqual(view["snapshot"], snapshot)
