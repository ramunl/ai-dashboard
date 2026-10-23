"""Ops window package updates: the service around ai-packages and its endpoint."""

import asyncio
import json
import stat
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from aiohttp.test_utils import TestClient, TestServer

from ai_dashboard import package_updates, server, views
from ai_dashboard.auth import sign_init_data
from ai_dashboard.config import BotSource, Settings
from ai_dashboard.package_updates import PackageService
from ai_dashboard.saved_checks import SavedChecks

OWNER = 777
OPS_TOKEN = "222:OPS"
# Evidence stamped far in the future: always after any upgrade started in a test.
FUTURE = 4102444800
CHECK = (
    '{"ok": true, "total": 2, "security": ["a"], "stable": ["b"], "untested": [], '
    f'"checked_at": {FUTURE}}}'
)
UPGRADE = (
    '{"ok": true, "upgraded": 2, "remaining": 0, "reboot_required": true, '
    f'"checked_at": {FUTURE}}}'
)
STATUS = f'{{"ok": true, "total": 1, "checked_at": {FUTURE}}}'
OLD_REPORT = {
    "ok": True,
    "total": 9,
    "security": [],
    "stable": ["curl"],
    "untested": [],
    "checked_at": 1,
    "reboot_required": False,
}


def _fake_packages(
    delay: float = 0.0,
    check: str | None = None,
    upgrade: str | None = None,
    status: str = "exit 1",
) -> tuple[str, Path]:
    """A stand-in ai-packages: each mode runs its shell snippet; calls are recorded.

    Snippets default to printing the JSON above; ``status`` fails unless told
    otherwise, as an ai-packages without the status interface would.
    """
    folder = Path(tempfile.mkdtemp())
    path = folder / "ai-packages"
    check = check or f"echo '{CHECK}'"
    upgrade = upgrade or f"echo '{UPGRADE}'"
    path.write_text(
        "#!/bin/sh\n"
        f'echo "$@" >> {folder}/calls\n'
        f"sleep {delay}\n"
        'case "$1" in\n'
        f"  check) {check} ;;\n"
        f"  upgrade) {upgrade} ;;\n"
        f"  status) {status} ;;\n"
        "esac\n"
    )
    path.chmod(path.stat().st_mode | stat.S_IEXEC)
    return str(path), folder / "calls"


def _auth(token: str = OPS_TOKEN, user_id: int = OWNER) -> dict:
    init = sign_init_data(
        {"auth_date": str(int(time.time())), "user": json.dumps({"id": user_id})}, token
    )
    return {"Authorization": "tma " + init}


async def _finished(service: PackageService) -> None:
    for _ in range(100):
        if not service.running and not service.reconciling:
            return
        await asyncio.sleep(0.02)
    raise AssertionError("package run did not finish")


class PackageServiceTests(unittest.IsolatedAsyncioTestCase):
    async def test_nothing_runs_until_asked(self) -> None:
        command, calls = _fake_packages()
        service = PackageService(command)
        self.assertEqual(
            service.state(),
            {
                "running": None,
                "reconciling": False,
                "report": None,
                "last_upgrade": None,
                "upgrade_blocked": "check for updates before upgrading",
            },
        )
        self.assertFalse(calls.exists())

    async def test_check_then_upgrade_one_at_a_time(self) -> None:
        command, calls = _fake_packages(delay=0.1)
        service = PackageService(command)
        self.assertTrue(service.start("check", "ops"))
        self.assertFalse(service.start("upgrade", "ops"))
        self.assertEqual(service.state()["running"], "check")
        await _finished(service)
        self.assertEqual(service.report["total"], 2)
        self.assertTrue(service.start("upgrade", "ops"))
        await _finished(service)
        self.assertEqual(service.last_upgrade["state"], "completed")
        self.assertEqual(service.last_upgrade["upgraded"], 2)
        self.assertEqual(service.last_upgrade["triggered_by"], "ops")
        self.assertEqual(service.report["total"], 0)
        self.assertEqual(service.report["source"], "upgrade")
        self.assertFalse(service.report["stale"])
        self.assertTrue(service.report["reboot_required"])
        self.assertEqual(calls.read_text().split(), ["check", "upgrade"])

    async def test_missing_command_is_reported_by_name(self) -> None:
        service = PackageService("/nonexistent/ai-packages")
        service.start("check", "ops")
        await _finished(service)
        self.assertIn("ai-packages is not installed", service.report["error"])

    async def test_unknown_mode_is_a_programming_error(self) -> None:
        with self.assertRaises(ValueError):
            PackageService(_fake_packages()[0]).start("remove", "ops")


class UpgradeOutcomeTests(unittest.IsolatedAsyncioTestCase):
    async def _upgrade(
        self, command: str, report: dict | None = OLD_REPORT
    ) -> PackageService:
        service = PackageService(command)
        service.report = report
        self.assertTrue(service.start("upgrade", "ops"))
        await _finished(service)
        return service

    async def test_empty_output_keeps_the_old_count_stale_and_says_why(self) -> None:
        command, _ = _fake_packages(upgrade="exit 1")
        service = await self._upgrade(command)
        self.assertEqual(service.last_upgrade["state"], "failed")
        self.assertEqual(
            service.last_upgrade["error"],
            "ai-packages upgrade failed (exit code 1): no output",
        )
        self.assertEqual(service.report["total"], 9)  # not zero, not verified
        self.assertTrue(service.report["stale"])
        self.assertIn("cached", service.refusal("upgrade"))

    async def test_a_signal_is_recorded_as_the_failure(self) -> None:
        command, _ = _fake_packages(upgrade="kill -TERM $$")
        service = await self._upgrade(command)
        self.assertEqual(service.last_upgrade["state"], "failed")
        self.assertEqual(service.last_upgrade["signal"], "SIGTERM")
        self.assertIn("killed by SIGTERM", service.last_upgrade["error"])

    async def test_partial_failure_takes_the_timestamped_remaining_count(self) -> None:
        partial = (
            '{"ok": false, "error": "dpkg broke", "remaining": 4, '
            f'"checked_at": {FUTURE}}}'
        )
        command, _ = _fake_packages(upgrade=f"echo '{partial}'; exit 1")
        service = await self._upgrade(command)
        self.assertEqual(service.last_upgrade["state"], "failed")
        self.assertIn("dpkg broke", service.last_upgrade["error"])
        self.assertEqual(service.report["total"], 4)
        self.assertEqual(service.report["source"], "upgrade")
        self.assertFalse(service.report["stale"])
        self.assertIsNone(service.refusal("upgrade"))  # verified: may retry

    async def test_remaining_without_a_timestamp_is_never_zero(self) -> None:
        upgrade = '{"ok": true, "upgraded": 9, "remaining": 0}'
        service = await self._upgrade(_fake_packages(upgrade=f"echo '{upgrade}'")[0])
        self.assertEqual(service.last_upgrade["state"], "completed")
        self.assertEqual(service.report["total"], 9)
        self.assertTrue(service.report["stale"])

    async def test_evidence_from_before_the_upgrade_is_rejected(self) -> None:
        upgrade = '{"ok": true, "remaining": 0, "checked_at": 1}'
        command, _ = _fake_packages(upgrade=f"echo '{upgrade}'")
        service = await self._upgrade(command)
        self.assertEqual(service.report["total"], 9)
        self.assertTrue(service.report["stale"])

    async def test_status_settles_the_counts_when_the_upgrade_says_nothing(
        self,
    ) -> None:
        status = f"echo '{STATUS}'"
        command, calls = _fake_packages(upgrade="echo '{\"ok\": true}'", status=status)
        service = await self._upgrade(command)
        self.assertEqual(service.report["total"], 1)
        self.assertEqual(service.report["source"], "status")
        self.assertFalse(service.report["stale"])
        self.assertEqual(calls.read_text().split(), ["upgrade", "status"])

    async def test_a_timeout_is_unknown_not_failed(self) -> None:
        command, _ = _fake_packages(upgrade="sleep 5")
        service = PackageService(command)
        service.report = OLD_REPORT
        with patch.dict(package_updates.TIMEOUTS, {"upgrade": 0.2}):
            service.start("upgrade", "ops")
            await _finished(service)
        self.assertEqual(service.last_upgrade["state"], "unknown")
        self.assertIn("may still be running", service.last_upgrade["error"])
        self.assertTrue(service.report["stale"])
        self.assertTrue(service.unsettled_upgrade())
        self.assertIn("unknown", service.refusal("upgrade"))

    async def test_shutdown_mid_upgrade_is_unknown_not_failed(self) -> None:
        command, _ = _fake_packages(upgrade="sleep 5")
        service = PackageService(command)
        service.report = OLD_REPORT
        service.start("upgrade", "ops")
        await asyncio.sleep(0.1)
        await asyncio.wait_for(service.close(), timeout=2)
        self.assertEqual(service.last_upgrade["state"], "unknown")
        self.assertTrue(service.report["stale"])

    async def test_a_later_check_settles_an_unknown_outcome(self) -> None:
        command, _ = _fake_packages(upgrade="sleep 5")
        service = PackageService(command)
        service.report = OLD_REPORT
        service.start("upgrade", "ops")
        await asyncio.sleep(0.1)
        await asyncio.wait_for(service.close(), timeout=2)
        self.assertTrue(service.unsettled_upgrade())
        # The owner's own check, run after the upgrade started, is the evidence.
        self.assertTrue(service.start("check", "ops"))
        await _finished(service)
        self.assertFalse(service.unsettled_upgrade())
        self.assertIsNone(service.refusal("upgrade"))


class RestartTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.path = Path(tempfile.mkdtemp()) / "ops-checks.json"

    def _saved_upgrade(self, upgrade: dict) -> None:
        SavedChecks(self.path).put(
            "packages", {"report": OLD_REPORT, "last_upgrade": upgrade}
        )

    async def test_in_flight_upgrade_comes_back_unknown_and_is_settled_by_status(
        self,
    ) -> None:
        self._saved_upgrade(
            {"state": "running", "started_at": time.time() - 60, "ok": None}
        )
        command, calls = _fake_packages(status=f"echo '{STATUS}'")
        service = PackageService(command, SavedChecks(self.path))
        self.assertEqual(service.last_upgrade["state"], "unknown")
        self.assertTrue(service.report["stale"])
        self.assertTrue(service.state()["upgrade_blocked"])
        service.start_reconcile()
        await _finished(service)
        self.assertEqual(service.report["total"], 1)
        self.assertEqual(service.report["source"], "status")
        self.assertIsNone(service.state()["upgrade_blocked"])
        # Only the fixed read-only status ran: no second upgrade.
        self.assertEqual(calls.read_text().split(), ["status"])
        saved = json.loads(self.path.read_text())["packages"]
        self.assertEqual(saved["report"]["total"], 1)

    async def test_unverifiable_restart_stays_unknown_and_stale(self) -> None:
        self._saved_upgrade({"state": "accepted", "started_at": time.time() - 60})
        command, calls = _fake_packages(status="exit 4")
        service = PackageService(command, SavedChecks(self.path))
        service.start_reconcile()
        await _finished(service)
        self.assertEqual(service.last_upgrade["state"], "unknown")
        self.assertEqual(service.report["total"], 9)
        self.assertTrue(service.report["stale"])
        self.assertIsNotNone(service.state()["upgrade_blocked"])
        self.assertEqual(calls.read_text().split(), ["status"])

    async def test_nothing_to_reconcile_runs_nothing(self) -> None:
        self._saved_upgrade({"state": "completed", "started_at": 1, "ok": True})
        command, calls = _fake_packages()
        service = PackageService(command, SavedChecks(self.path))
        service.start_reconcile()
        self.assertFalse(service.reconciling)
        self.assertFalse(calls.exists())

    async def test_results_saved_before_states_existed_still_restore(self) -> None:
        self._saved_upgrade({"ok": False, "error": "old failure"})
        service = PackageService(_fake_packages()[0], SavedChecks(self.path))
        self.assertEqual(service.last_upgrade["state"], "failed")
        self.assertEqual(service.last_upgrade["error"], "old failure")


class PackagesEndpointTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        tmp = Path(tempfile.mkdtemp())
        command, self.calls = _fake_packages(delay=0.2)
        settings = Settings(
            public_url="https://h",
            host="127.0.0.1",
            port=8787,
            owner_id=OWNER,
            bots=(BotSource("ops", OPS_TOKEN, "ai-ops-agent", "ops"),),
            state_dir=tmp,
            packages_command=command,
        )
        overview = {"resources": None, "agents": [], "problems": []}
        self.views = patch.dict(
            views.VIEW_PROVIDERS, {"ops": AsyncMock(return_value=overview)}
        )
        self.views.start()
        app = server.build_app(settings, set_buttons=False, record_disk=False)
        self.client = TestClient(TestServer(app))
        await self.client.start_server()

    async def asyncTearDown(self) -> None:
        await self.client.close()
        self.views.stop()

    async def _post(self, body: object, headers: dict | None = None) -> int:
        response = await self.client.post(
            "/api/ops/packages",
            json=body,
            headers=_auth() if headers is None else headers,
        )
        return response.status

    async def test_requires_the_owners_signature(self) -> None:
        self.assertEqual(await self._post({"action": "upgrade"}, {}), 401)
        self.assertEqual(await self._post({"action": "upgrade"}, _auth(user_id=1)), 403)
        self.assertFalse(self.calls.exists())

    async def test_only_the_two_fixed_actions_are_accepted(self) -> None:
        for body in (
            {"action": "remove"},
            {"action": "upgrade", "packages": ["curl"]},
            {"action": ["upgrade"]},
            {},
            "upgrade",
        ):
            self.assertEqual(await self._post(body), 400, body)
        self.assertFalse(self.calls.exists())

    async def test_get_cannot_start_a_run(self) -> None:
        response = await self.client.get("/api/ops/packages", headers=_auth())
        self.assertNotEqual(response.status, 202)
        self.assertFalse(self.calls.exists())

    async def test_upgrade_is_refused_until_a_check_has_run(self) -> None:
        response = await self.client.post(
            "/api/ops/packages", json={"action": "upgrade"}, headers=_auth()
        )
        self.assertEqual(response.status, 409)
        self.assertEqual(
            (await response.json())["error"], "check for updates before upgrading"
        )
        self.assertFalse(self.calls.exists())

    async def test_run_shows_in_the_ops_window_and_refuses_a_second(self) -> None:
        self.assertEqual(await self._post({"action": "check"}), 202)
        self.assertEqual(await self._post({"action": "upgrade"}), 409)
        state = await (await self.client.get("/api/ops", headers=_auth())).json()
        self.assertEqual(state["packages"]["running"], "check")
        for _ in range(50):
            await asyncio.sleep(0.05)
            state = await (await self.client.get("/api/ops", headers=_auth())).json()
            if not state["packages"]["running"]:
                break
        self.assertEqual(state["packages"]["report"]["total"], 2)
        self.assertEqual(self.calls.read_text().split(), ["check"])
