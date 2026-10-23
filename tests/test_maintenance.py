"""Ops window disk cleanup: the service around ai-cleanup and its endpoint."""

import asyncio
import json
import stat
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from aiohttp.test_utils import TestClient, TestServer

from ai_dashboard import maintenance, server, views
from ai_dashboard.auth import sign_init_data
from ai_dashboard.config import BotSource, Settings
from ai_dashboard.maintenance import CleanupService, invoke

OWNER = 777
TOKEN = "111:CODING"
OPS_TOKEN = "222:OPS"


def _fake_cleanup(run_delay: float = 0.0, report: str | None = None) -> str:
    """A stand-in ai-cleanup executable with the real CLI contract."""
    report = report or '{"ok": true, "categories": [], "reclaimable_bytes": 5}'
    path = Path(tempfile.mkdtemp()) / "ai-cleanup"
    path.write_text(
        "#!/bin/sh\n"
        'case "$1" in\n'
        f"  report) echo '{report}' ;;\n"
        f'  run) sleep {run_delay}; echo \'{{"ok": true, "freed_bytes": 123, "steps": []}}\' ;;\n'
        "esac\n"
    )
    path.chmod(path.stat().st_mode | stat.S_IEXEC)
    return str(path)


def _script(body: str) -> str:
    """A stand-in command that runs ``body``: exit codes, output and signals."""
    path = Path(tempfile.mkdtemp()) / "fake-command"
    path.write_text("#!/bin/sh\n" + body)
    path.chmod(0o755)
    return str(path)


def _auth(token: str = OPS_TOKEN, user_id: int = OWNER) -> dict:
    init = sign_init_data(
        {"auth_date": str(int(time.time())), "user": json.dumps({"id": user_id})}, token
    )
    return {"Authorization": "tma " + init}


class InvokeTests(unittest.IsolatedAsyncioTestCase):
    async def test_parses_json_result(self) -> None:
        result = await invoke(_fake_cleanup(), "report", 10)
        self.assertEqual(result["reclaimable_bytes"], 5)

    async def test_missing_command_says_how_to_install(self) -> None:
        result = await invoke("/nonexistent/ai-cleanup", "report", 10)
        self.assertEqual(result, {"ok": False, "error": maintenance.NOT_INSTALLED})

    async def test_non_json_output_is_an_error_with_detail(self) -> None:
        path = Path(tempfile.mkdtemp()) / "broken"
        path.write_text("#!/bin/sh\necho 'Traceback: boom' >&2\nexit 1\n")
        path.chmod(0o755)
        result = await invoke(str(path), "report", 10)
        self.assertFalse(result["ok"])
        self.assertIn("Traceback: boom", result["error"])

    async def test_timeout_kills_the_process(self) -> None:
        result = await invoke(_fake_cleanup(run_delay=5), "run", 0.3)
        self.assertIn("timed out", result["error"])
        self.assertIs(result["timed_out"], True)

    async def test_nonzero_exit_is_a_failure_even_with_json_output(self) -> None:
        path = _script('echo \'{"ok": true, "remaining": 4}\'\nexit 1\n')
        result = await invoke(path, "upgrade", 10, "ai-packages")
        self.assertIs(result["ok"], False)
        self.assertEqual(result["exit_code"], 1)
        self.assertEqual(result["remaining"], 4)  # the command's fields are kept
        self.assertIn("ai-packages upgrade failed (exit code 1)", result["error"])

    async def test_empty_output_names_the_exit_code(self) -> None:
        result = await invoke(_script("exit 3\n"), "upgrade", 10, "ai-packages")
        self.assertEqual(
            result["error"], "ai-packages upgrade failed (exit code 3): no output"
        )
        self.assertEqual(result["exit_code"], 3)
        self.assertIsNone(result["signal"])
        self.assertNotIn("diagnostics", result)

    async def test_a_signal_is_named_when_there_is_no_output(self) -> None:
        result = await invoke(_script("kill -9 $$\n"), "upgrade", 10, "ai-packages")
        self.assertIs(result["ok"], False)
        self.assertEqual(result["signal"], "SIGKILL")
        self.assertIsNone(result["exit_code"])
        self.assertIn("killed by SIGKILL", result["error"])

    async def test_a_signal_during_json_output_is_still_a_failure(self) -> None:
        path = _script("echo '{\"ok\": true}'\nkill -TERM $$\n")
        result = await invoke(path, "upgrade", 10, "ai-packages")
        self.assertIs(result["ok"], False)
        self.assertEqual(result["signal"], "SIGTERM")

    async def test_diagnostics_are_bounded(self) -> None:
        long_line = "E" * 5000
        path = _script(
            f"i=0; while [ $i -lt 9 ]; do echo '{long_line}' >&2; i=$((i+1)); done\n"
            "exit 2\n"
        )
        result = await invoke(path, "upgrade", 10, "ai-packages")
        self.assertEqual(len(result["diagnostics"]), maintenance.DIAGNOSTIC_LINES)
        for line in result["diagnostics"]:
            self.assertLessEqual(len(line), maintenance.DIAGNOSTIC_CHARS)
        self.assertLess(len(result["error"]), maintenance.DIAGNOSTIC_CHARS + 80)

    async def test_successful_json_passes_through_unchanged(self) -> None:
        path = _script('echo \'{"ok": true, "upgraded": 2}\'\n')
        result = await invoke(path, "upgrade", 10, "ai-packages")
        self.assertEqual(result, {"ok": True, "upgraded": 2})


class ServiceTests(unittest.IsolatedAsyncioTestCase):
    async def test_one_run_at_a_time_then_result_and_fresh_report(self) -> None:
        service = CleanupService(_fake_cleanup(run_delay=0.3))
        self.assertTrue(service.start_run("ops"))
        self.assertTrue(service.state()["running"])
        self.assertFalse(service.start_run("coding"))  # second request refused
        for _ in range(100):
            if not service.running:
                break
            await asyncio.sleep(0.05)
        state = service.state()
        self.assertFalse(state["running"])
        self.assertEqual(state["last_run"]["freed_bytes"], 123)
        self.assertEqual(state["last_run"]["triggered_by"], "ops")
        self.assertEqual(state["report"]["reclaimable_bytes"], 5)  # refreshed after

    async def test_shutdown_stops_an_active_cleanup(self) -> None:
        service = CleanupService(_fake_cleanup(run_delay=5))
        service.start_run("ops")
        await asyncio.sleep(0.1)
        await asyncio.wait_for(service.close(), timeout=1)
        self.assertFalse(service.running)
        self.assertIsNone(service.last_run)

    async def test_report_is_not_refreshed_during_a_run(self) -> None:
        service = CleanupService(_fake_cleanup())
        service.running = True
        await service.refresh_report()
        self.assertIsNone(service.report)


class EndpointTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        tmp = Path(tempfile.mkdtemp())
        settings = Settings(
            public_url="https://h",
            host="127.0.0.1",
            port=8787,
            owner_id=OWNER,
            bots=(
                BotSource("coding", TOKEN, "ai-coding-agent", "coding", tmp / "s.json"),
                BotSource("ops", OPS_TOKEN, "ai-ops-agent", "ops"),
            ),
            state_dir=tmp,
            cleanup_command=_fake_cleanup(run_delay=0.5),
        )
        self.overview = {"resources": None, "agents": [], "problems": []}
        self.views = patch.dict(
            views.VIEW_PROVIDERS, {"ops": AsyncMock(return_value=self.overview)}
        )
        self.views.start()
        app = server.build_app(settings, set_buttons=False, record_disk=False)
        self.client = TestClient(TestServer(app))
        await self.client.start_server()

    async def asyncTearDown(self) -> None:
        await self.client.close()
        self.views.stop()

    async def test_cleanup_requires_the_owners_signature(self) -> None:
        self.assertEqual((await self.client.post("/api/ops/cleanup")).status, 401)
        response = await self.client.post("/api/ops/cleanup", headers=_auth(user_id=1))
        self.assertEqual(response.status, 403)

    async def test_get_cannot_start_a_cleanup(self) -> None:
        # Opening a URL is a GET: it must never be able to change the server.
        response = await self.client.get("/api/ops/cleanup", headers=_auth())
        self.assertEqual(response.status, 405)
        state = await (await self.client.get("/api/ops", headers=_auth())).json()
        self.assertFalse(state["cleanup"]["running"])
        self.assertIsNone(state["cleanup"]["last_run"])

    async def test_start_then_conflict_then_visible_in_ops_window(self) -> None:
        first = await self.client.post("/api/ops/cleanup", headers=_auth())
        self.assertEqual(first.status, 202)
        second = await self.client.post("/api/ops/cleanup", headers=_auth())
        self.assertEqual(second.status, 409)

        running = await (await self.client.get("/api/ops", headers=_auth())).json()
        self.assertTrue(running["cleanup"]["running"])
        self.assertEqual(running["opened_from"], "ops")

        for _ in range(60):
            await asyncio.sleep(0.05)
            state = await (await self.client.get("/api/ops", headers=_auth())).json()
            if not state["cleanup"]["running"]:
                break
        self.assertEqual(state["cleanup"]["last_run"]["freed_bytes"], 123)
        self.assertEqual(state["cleanup"]["last_run"]["triggered_by"], "ops")

    async def test_overview_has_no_cleanup_data(self) -> None:
        with patch.dict(
            views.VIEW_PROVIDERS, {"launcher": AsyncMock(return_value=self.overview)}
        ):
            body = await (
                await self.client.get("/api/launcher", headers=_auth())
            ).json()
        self.assertNotIn("cleanup", body)


if __name__ == "__main__":
    unittest.main()
