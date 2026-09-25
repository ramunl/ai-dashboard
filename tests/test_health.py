import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from ai_dashboard import health

MEMINFO = "MemTotal:        1000000 kB\nMemFree:  100 kB\nMemAvailable:     250000 kB\n"


def _service(
    unit="ai-coding-agent", state="active", load="loaded", restarts=0, errors=0
):
    return {
        "unit": unit,
        "load_state": load,
        "state": state,
        "sub_state": "running",
        "restarts": restarts,
        "since": "",
        "errors_last_hour": errors,
    }


def _resources(disk_used=0.5, mem_available=0.5, load5=0.5, cpus=1):
    return {
        "hostname": "h",
        "cpus": cpus,
        "load": [0.1, load5, 0.1],
        "memory": {"total": 1000, "available": int(1000 * mem_available)},
        "disk": {"total": 1000, "used": int(1000 * disk_used), "free": 0},
        "uptime_seconds": 1,
    }


class ParserTests(unittest.TestCase):
    def test_meminfo(self) -> None:
        self.assertEqual(
            health.parse_meminfo(MEMINFO),
            {"total": 1_024_000_000, "available": 256_000_000},
        )

    def test_loadavg_and_uptime(self) -> None:
        self.assertEqual(
            health.parse_loadavg("0.52 0.31 0.20 1/123 4567"), (0.52, 0.31, 0.20)
        )
        self.assertEqual(health.parse_uptime("12345.67 9999.00"), 12345.67)

    def test_unit_show(self) -> None:
        text = "LoadState=loaded\nActiveState=active\nActiveEnterTimestamp=Wed 2026-09-24 17:13:02 UTC\n"
        fields = health.parse_unit_show(text)
        self.assertEqual(fields["ActiveState"], "active")
        self.assertEqual(fields["ActiveEnterTimestamp"], "Wed 2026-09-24 17:13:02 UTC")

    def test_read_resources_from_proc_files(self) -> None:
        proc = Path(tempfile.mkdtemp())
        (proc / "loadavg").write_text("0.5 0.4 0.3 1/2 3")
        (proc / "meminfo").write_text(MEMINFO)
        (proc / "uptime").write_text("3600.0 1.0")
        resources = health.read_resources(proc=proc, disk_path="/")
        self.assertEqual(resources["load"], [0.5, 0.4, 0.3])
        self.assertEqual(resources["uptime_seconds"], 3600.0)
        self.assertGreater(resources["disk"]["total"], 0)


class ProblemTests(unittest.TestCase):
    def _texts(self, *args):
        return [(p["severity"], p["text"]) for p in health.compute_problems(*args)]

    def test_all_good(self) -> None:
        self.assertEqual(self._texts(_resources(), [_service()], None), [])

    def test_service_down_is_an_error(self) -> None:
        problems = self._texts(_resources(), [_service(state="failed")], None)
        self.assertIn(("error", "ai-coding-agent is failed"), problems)

    def test_not_installed_is_a_warning_not_a_failure(self) -> None:
        problems = self._texts(
            None, [_service("ai-pm-agent", state="inactive", load="not-found")], None
        )
        self.assertEqual(problems, [("warning", "ai-pm-agent is not installed")])

    def test_restart_loop_and_errors(self) -> None:
        problems = self._texts(None, [_service(restarts=4, errors=7)], None)
        self.assertIn(
            ("warning", "ai-coding-agent restarted automatically 4 times"), problems
        )
        self.assertIn(
            ("warning", "ai-coding-agent: 7 errors in the last hour"), problems
        )

    def test_resource_thresholds(self) -> None:
        self.assertIn(
            ("error", "Disk 95% full"),
            self._texts(_resources(disk_used=0.95), [], None),
        )
        self.assertIn(
            ("warning", "Disk 85% full"),
            self._texts(_resources(disk_used=0.85), [], None),
        )
        self.assertIn(
            ("error", "Memory almost exhausted (5% available)"),
            self._texts(_resources(mem_available=0.05), [], None),
        )
        self.assertIn(
            ("warning", "High load: 3.00 on 1 CPU"),
            self._texts(_resources(load5=3.0), [], None),
        )

    def test_coding_snapshot_problem_only_when_service_active(self) -> None:
        coding = {
            "unit": "ai-coding-agent",
            "problem": "has not published a snapshot yet",
        }
        running = self._texts(None, [_service()], coding)
        self.assertIn(
            ("warning", "coding agent has not published a snapshot yet"), running
        )
        stopped = self._texts(None, [_service(state="failed")], coding)
        self.assertEqual([p for p in stopped if "snapshot" in p[1]], [])

    def test_core_update_and_stuck_queue_are_info(self) -> None:
        coding = {
            "unit": "ai-coding-agent",
            "problem": None,
            "snapshot": {
                "core": "core: v1.1 (updatable)",
                "queue": [{}, {}],
                "running": None,
            },
        }
        problems = self._texts(None, [_service()], coding)
        self.assertIn(
            ("info", "Coding agent core update available: /core update coding"),
            problems,
        )
        self.assertIn(
            ("info", "2 task(s) queued, nothing running: /confirm to resume"), problems
        )

    def test_sorted_most_severe_first(self) -> None:
        problems = self._texts(
            _resources(disk_used=0.85), [_service(state="failed")], None
        )
        self.assertEqual([severity for severity, _ in problems], ["error", "warning"])


class RecentErrorsTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        health._error_cache.clear()

    async def test_counts_lines_and_caches(self) -> None:
        run = AsyncMock(return_value="boom\n\ncrash\n")
        with patch.object(health, "_run", run):
            self.assertEqual(await health.recent_errors("u", now=1000), 2)
            self.assertEqual(await health.recent_errors("u", now=1010), 2)
            self.assertEqual(run.await_count, 1)
            await health.recent_errors("u", now=1031)
            self.assertEqual(run.await_count, 2)

    async def test_unavailable_journal_is_unknown(self) -> None:
        with patch.object(health, "_run", AsyncMock(return_value=None)):
            self.assertIsNone(await health.recent_errors("u", now=1))

    async def test_unit_status_parses_systemctl(self) -> None:
        out = "LoadState=loaded\nActiveState=active\nSubState=running\nNRestarts=2\n"
        with patch.object(health, "_run", AsyncMock(return_value=out)):
            status = await health.unit_status("ai-ops-agent")
        self.assertEqual((status["state"], status["restarts"]), ("active", 2))
