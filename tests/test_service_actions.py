"""Ops Services card: restarts through the ops agent's ai-service."""

import json
import stat
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from aiohttp.test_utils import TestClient, TestServer

from ai_dashboard import server, service_actions, views
from ai_dashboard.auth import sign_init_data
from ai_dashboard.config import BotSource, Settings
from ai_dashboard.service_actions import ServiceControl

OWNER = 777
TOKEN = "222:OPS"
ALLOWED = ["ai-coding-agent", "ai-pm-agent", "ai-ops-agent", "ai-dashboard"]


def _fake_ai_service() -> tuple[str, Path]:
    """A stand-in with the real CLI contract; it records restarts in a file."""
    tmp = Path(tempfile.mkdtemp())
    calls = tmp / "calls"
    path = tmp / "ai-service"
    path.write_text(
        "#!/bin/sh\n"
        f'case "$1" in\n'
        f"  list) echo '{json.dumps({'ok': True, 'services': ALLOWED})}' ;;\n"
        f'  restart) echo "$2" >> {calls}; echo "{{\\"ok\\": true, \\"service\\": \\"$2\\", \\"queued\\": true}}" ;;\n'
        f'  reboot) echo REBOOT >> {calls}; echo \'{{"ok": true, "queued": true}}\' ;;\n'
        "esac\n"
    )
    path.chmod(path.stat().st_mode | stat.S_IEXEC)
    return str(path), calls


def _auth(user_id: int = OWNER) -> dict:
    init = sign_init_data(
        {"auth_date": str(int(time.time())), "user": json.dumps({"id": user_id})}, TOKEN
    )
    return {"Authorization": "tma " + init}


class ServiceControlTests(unittest.IsolatedAsyncioTestCase):
    async def test_whitelist_is_asked_once(self) -> None:
        command, _ = _fake_ai_service()
        control = ServiceControl(command)
        with patch.object(
            service_actions, "invoke", wraps=service_actions.invoke
        ) as spy:
            self.assertEqual(await control.services(), ALLOWED)
            await control.services()
        self.assertEqual(spy.await_count, 1)

    async def test_restart_only_allowed_services(self) -> None:
        command, calls = _fake_ai_service()
        control = ServiceControl(command)
        self.assertTrue((await control.restart("ai-pm-agent", "ops"))["ok"])
        self.assertFalse((await control.restart("sshd", "ops"))["ok"])
        self.assertEqual(calls.read_text().split(), ["ai-pm-agent"])

    async def test_missing_command_is_explained(self) -> None:
        control = ServiceControl("/nonexistent/ai-service")
        state = await control.state([], None)
        self.assertEqual(
            state, {"ok": False, "error": service_actions.NOT_INSTALLED, "services": []}
        )

    async def test_state_reuses_agent_rows_and_looks_up_the_rest(self) -> None:
        command, _ = _fake_ai_service()
        rows = [
            {"unit": "ai-coding-agent", "service": "active", "up_seconds": 60},
            {"unit": "ai-pm-agent", "service": "failed", "up_seconds": None},
            {"unit": "ai-ops-agent", "service": "active", "up_seconds": 600},
        ]
        status = {
            "unit": "ai-dashboard",
            "state": "active",
            "started_after_boot": 100.0,
        }
        with patch.object(
            service_actions, "unit_status", AsyncMock(return_value=status)
        ) as lookup:
            state = await ServiceControl(command).state(rows, 1100.0)
        lookup.assert_awaited_once_with("ai-dashboard")
        self.assertEqual(
            state["services"],
            [
                {"unit": "ai-coding-agent", "state": "active", "up_seconds": 60},
                {"unit": "ai-pm-agent", "state": "failed", "up_seconds": None},
                {"unit": "ai-ops-agent", "state": "active", "up_seconds": 600},
                {"unit": "ai-dashboard", "state": "active", "up_seconds": 1000.0},
            ],
        )


class EndpointTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        tmp = Path(tempfile.mkdtemp())
        self.command, self.calls = _fake_ai_service()
        settings = Settings(
            public_url="https://h",
            host="127.0.0.1",
            port=8787,
            owner_id=OWNER,
            bots=(BotSource("ops", TOKEN, "ai-ops-agent", "ops"),),
            state_dir=tmp,
            service_command=self.command,
        )
        overview = {
            "resources": None,
            "agents": [{"unit": "ai-ops-agent", "service": "active", "up_seconds": 5}],
            "problems": [],
        }
        self.views = patch.dict(
            views.VIEW_PROVIDERS, {"ops": AsyncMock(return_value=overview)}
        )
        self.views.start()
        self.status = patch.object(
            service_actions,
            "unit_status",
            AsyncMock(
                return_value={
                    "unit": "x",
                    "state": "active",
                    "started_after_boot": None,
                }
            ),
        )
        self.status.start()
        app = server.build_app(settings, set_buttons=False, record_disk=False)
        self.client = TestClient(TestServer(app))
        await self.client.start_server()

    async def asyncTearDown(self) -> None:
        await self.client.close()
        self.views.stop()
        self.status.stop()

    async def post(self, body, headers=None):
        return await self.client.post(
            "/api/ops/restart",
            data=json.dumps(body),
            headers=_auth() if headers is None else headers,
        )

    async def test_requires_the_owner(self) -> None:
        self.assertEqual(
            (await self.post({"service": "ai-pm-agent"}, headers={})).status, 401
        )
        self.assertEqual(
            (await self.post({"service": "ai-pm-agent"}, headers=_auth(1))).status, 403
        )
        self.assertFalse(self.calls.exists())

    async def test_queues_an_allowed_restart(self) -> None:
        response = await self.post({"service": "ai-dashboard"})
        self.assertEqual(response.status, 202)
        self.assertTrue((await response.json())["queued"])
        self.assertEqual(self.calls.read_text().split(), ["ai-dashboard"])

    async def test_rejects_anything_else(self) -> None:
        for body in (
            {"service": "sshd"},
            {"service": "ai-pm-agent", "x": 1},
            {"service": 5},
            [],
        ):
            self.assertEqual((await self.post(body)).status, 400, body)
        self.assertFalse(self.calls.exists())

    async def test_get_cannot_restart(self) -> None:
        response = await self.client.get("/api/ops/restart", headers=_auth())
        self.assertEqual(response.status, 405)

    async def test_ops_window_lists_services(self) -> None:
        body = await (await self.client.get("/api/ops", headers=_auth())).json()
        units = [row["unit"] for row in body["service_control"]["services"]]
        self.assertEqual(units, ALLOWED)

    async def reboot(self, body, headers=None):
        return await self.client.post(
            "/api/ops/reboot",
            data=json.dumps(body),
            headers=_auth() if headers is None else headers,
        )

    async def test_reboot_requires_the_owner_and_the_exact_body(self) -> None:
        confirm = {"confirm": "reboot"}
        self.assertEqual((await self.reboot(confirm, headers={})).status, 401)
        self.assertEqual((await self.reboot(confirm, headers=_auth(1))).status, 403)
        for body in ({}, {"confirm": "yes"}, {"confirm": "reboot", "x": 1}, "reboot"):
            self.assertEqual((await self.reboot(body)).status, 400, body)
        response = await self.client.get("/api/ops/reboot", headers=_auth())
        self.assertNotEqual(response.status, 202)
        self.assertFalse(self.calls.exists())

    async def test_reboot_is_queued(self) -> None:
        response = await self.reboot({"confirm": "reboot"})
        self.assertEqual(response.status, 202)
        self.assertEqual(self.calls.read_text().split(), ["REBOOT"])

    async def test_reboot_waits_for_running_work(self) -> None:
        self.client.app[server.PACKAGES].running = "upgrade"
        response = await self.reboot({"confirm": "reboot"})
        self.assertEqual(response.status, 409)
        self.assertEqual(
            (await response.json())["error"], "a package upgrade is running"
        )
        self.assertFalse(self.calls.exists())


class IPTVControlTests(unittest.IsolatedAsyncioTestCase):
    async def test_only_fixed_iptv_start_stop_are_forwarded(self):
        control = ServiceControl("/fake/ai-service")
        control.allowed = ["iptv-proxy", "ai-dashboard"]
        with patch.object(
            service_actions, "invoke", AsyncMock(return_value={"ok": True})
        ) as invoke:
            for service, action in [
                ("sshd", "stop"),
                ("ai-dashboard", "stop"),
                ("iptv-proxy", "delete"),
            ]:
                self.assertFalse((await control.change(service, action, "ops"))["ok"])
            invoke.assert_not_awaited()
            for action in ["start", "stop"]:
                self.assertTrue(
                    (await control.change("iptv-proxy", action, "ops"))["ok"]
                )
                invoke.assert_awaited_with("/fake/ai-service", action, "iptv-proxy")

    async def test_old_ops_agent_is_explained(self):
        control = ServiceControl("/fake/ai-service")
        control.allowed = ALLOWED
        with patch.object(service_actions, "invoke", AsyncMock()) as invoke:
            result = await control.change("iptv-proxy", "stop", "ops")
            self.assertFalse(result["ok"])
            invoke.assert_not_awaited()

    async def test_iptv_state_uses_docker_not_systemd(self):
        control = ServiceControl("/fake/ai-service")
        control.allowed = ["iptv-proxy"]
        with patch.object(
            service_actions, "run_command", AsyncMock(return_value="running\n")
        ) as query:
            with patch.object(service_actions, "unit_status", AsyncMock()) as systemd:
                result = await control.state([], None)
        query.assert_awaited_once_with(
            "docker", "inspect", "--format", "{{.State.Status}}", "iptv-proxy"
        )
        systemd.assert_not_awaited()
        self.assertEqual(result["services"][0]["state"], "active")


class IPTVEndpointTests(EndpointTests):
    async def change(self, payload, headers=None):
        return await self.client.post(
            "/api/ops/service",
            json=payload,
            headers=_auth() if headers is None else headers,
        )

    async def test_auth_and_confirmation_precede_command(self):
        payload = {"service": "iptv-proxy", "action": "stop", "confirm": "stop"}
        change = AsyncMock(return_value={"ok": True})
        with patch.object(self.client.app[server.SERVICES], "change", change):
            self.assertEqual((await self.change(payload, {})).status, 401)
            self.assertEqual((await self.change(payload, _auth(1))).status, 403)
            for bad in [
                [],
                {},
                {"service": "iptv-proxy", "action": "stop"},
                {**payload, "confirm": "yes"},
                {**payload, "service": "sshd"},
                {**payload, "extra": 1},
                {**payload, "action": []},
            ]:
                self.assertEqual((await self.change(bad)).status, 400)
            response = await self.client.get("/api/ops/service", headers=_auth())
            self.assertEqual(response.status, 405)
            change.assert_not_awaited()
            self.assertEqual((await self.change(payload)).status, 200)
            change.assert_awaited_once_with("iptv-proxy", "stop", "ops")

    async def test_start_and_partial_failure_response(self):
        result = {
            "ok": False,
            "unit": "inactive",
            "port": 8080,
            "port_open": True,
            "error": "another publisher remains",
        }
        with patch.object(
            self.client.app[server.SERVICES], "change", AsyncMock(return_value=result)
        ) as change:
            response = await self.change({"service": "iptv-proxy", "action": "start"})
            self.assertEqual(response.status, 502)
            self.assertEqual(await response.json(), result)
            change.assert_awaited_once_with("iptv-proxy", "start", "ops")
