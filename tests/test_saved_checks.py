"""Ops check results survive a dashboard restart."""

import asyncio
import json
import stat
import tempfile
import unittest
from pathlib import Path

from ai_dashboard.maintenance import CleanupService
from ai_dashboard.package_updates import PackageService
from ai_dashboard.saved_checks import SavedChecks
from ai_dashboard.tool_updates import ToolService


def _fake(name: str, answers: dict[str, str]) -> str:
    """A stand-in command answering each mode with fixed JSON."""
    path = Path(tempfile.mkdtemp()) / name
    cases = "".join(f"  {mode}) echo '{body}' ;;\n" for mode, body in answers.items())
    path.write_text(f'#!/bin/sh\ncase "$1" in\n{cases}esac\n')
    path.chmod(path.stat().st_mode | stat.S_IEXEC)
    return str(path)


async def _finished(service) -> None:
    for _ in range(100):
        if not service.running:
            return
        await asyncio.sleep(0.02)
    raise AssertionError("run did not finish")


class SavedChecksTests(unittest.TestCase):
    def setUp(self) -> None:
        self.path = Path(tempfile.mkdtemp()) / "state" / "ops-checks.json"

    def test_round_trip_and_kinds(self) -> None:
        SavedChecks(self.path).put(
            "cleanup", {"report": {"ok": True}, "report_at": 5.0}
        )
        saved = SavedChecks(self.path)
        self.assertEqual(saved.get("cleanup", "report"), {"ok": True})
        self.assertEqual(saved.get("cleanup", "report_at", (int, float)), 5.0)
        self.assertIsNone(saved.get("cleanup", "report_at"))  # not a dict
        self.assertIsNone(saved.get("packages", "report"))

    def test_corrupt_or_odd_files_start_fresh(self) -> None:
        self.path.parent.mkdir(parents=True)
        for content in (
            "{not json",
            "[1, 2]",
            '{"cleanup": [1]}',
            '{"cleanup": {"report": true}}',
        ):
            self.path.write_text(content)
            self.assertIsNone(SavedChecks(self.path).get("cleanup", "report"), content)

    def test_unwritable_location_is_logged_not_raised(self) -> None:
        blocker = Path(tempfile.mkdtemp()) / "file"
        blocker.write_text("x")
        saved = SavedChecks(blocker / "ops-checks.json")
        with self.assertLogs("ai_dashboard.saved_checks", "ERROR"):
            saved.put("packages", {"report": None})
        self.assertEqual(saved.sections["packages"], {"report": None})


class RestartTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.path = Path(tempfile.mkdtemp()) / "ops-checks.json"

    async def test_package_and_tool_results_come_back_after_a_restart(self) -> None:
        packages = _fake(
            "ai-packages", {"check": '{"ok": true, "total": 2, "checked_at": 1}'}
        )
        tools = _fake(
            "ai-tools", {"check": '{"ok": true, "tools": [{"name": "claude"}]}'}
        )
        first = PackageService(packages, SavedChecks(self.path))
        first.start("check", "ops")
        await _finished(first)
        tool_service = ToolService(tools, SavedChecks(self.path))
        tool_service.start_check("ops")
        await _finished(tool_service)

        reloaded = SavedChecks(self.path)
        again = PackageService(packages, reloaded)
        self.assertEqual(again.state()["report"]["total"], 2)
        self.assertIsNone(again.state()["running"])
        tools_again = ToolService(tools, reloaded)
        self.assertEqual(tools_again.known_tools(), ["claude"])
        saved = json.loads(self.path.read_text())
        self.assertEqual(set(saved), {"packages", "ai_tools"})
        self.assertNotIn("running", json.dumps(saved))

    async def test_cleanup_report_and_last_run_come_back(self) -> None:
        command = _fake(
            "ai-cleanup",
            {
                "report": '{"ok": true, "categories": [], "reclaimable_bytes": 5}',
                "run": '{"ok": true, "freed_bytes": 123, "steps": []}',
            },
        )
        service = CleanupService(command, SavedChecks(self.path))
        service.start_run("ops")
        await _finished(service)
        again = CleanupService(command, SavedChecks(self.path))
        state = again.state()
        self.assertEqual(state["last_run"]["freed_bytes"], 123)
        self.assertEqual(state["report"]["reclaimable_bytes"], 5)
        self.assertIsInstance(state["report_at"], float)
        self.assertFalse(state["running"])

    async def test_without_a_file_nothing_is_written(self) -> None:
        service = PackageService(_fake("ai-packages", {"check": '{"ok": true}'}))
        service.start("check", "ops")
        await _finished(service)
        self.assertEqual(service.state()["report"], {"ok": True})
        self.assertFalse(self.path.exists())
