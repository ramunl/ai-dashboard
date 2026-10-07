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

from ai_dashboard import server, views
from ai_dashboard.auth import sign_init_data
from ai_dashboard.config import BotSource, Settings
from ai_dashboard.package_updates import PackageService

OWNER = 777
OPS_TOKEN = "222:OPS"
CHECK = '{"ok": true, "total": 2, "security": ["a"], "stable": ["b"], "untested": []}'
UPGRADE = '{"ok": true, "upgraded": 2, "remaining": 0, "reboot_required": true}'


def _fake_packages(delay: float = 0.0) -> tuple[str, Path]:
    """A stand-in ai-packages that records how it was called."""
    folder = Path(tempfile.mkdtemp())
    path = folder / "ai-packages"
    path.write_text(
        "#!/bin/sh\n"
        f'echo "$@" >> {folder}/calls\n'
        f"sleep {delay}\n"
        'case "$1" in\n'
        f"  check) echo '{CHECK}' ;;\n"
        f"  upgrade) echo '{UPGRADE}' ;;\n"
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
        if not service.running:
            return
        await asyncio.sleep(0.02)
    raise AssertionError("package run did not finish")


class PackageServiceTests(unittest.IsolatedAsyncioTestCase):
    async def test_nothing_runs_until_asked(self) -> None:
        command, calls = _fake_packages()
        service = PackageService(command)
        self.assertEqual(
            service.state(), {"running": None, "report": None, "last_upgrade": None}
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
        self.assertEqual(service.last_upgrade["upgraded"], 2)
        self.assertEqual(service.last_upgrade["triggered_by"], "ops")
        self.assertEqual(service.report["total"], 0)
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
