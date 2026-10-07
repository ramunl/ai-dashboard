"""Ops window AI tools: the service around ai-tools and its endpoint."""

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
from ai_dashboard.tool_updates import ToolService

OWNER = 777
OPS_TOKEN = "222:OPS"
CHECK = '{"ok": true, "tools": [{"name": "claude"}, {"name": "codex"}]}'
UPDATE = '{"ok": true, "name": "claude", "before": "1", "after": "2"}'


def _fake_tools(delay: float = 0.0) -> tuple[str, Path]:
    """A stand-in ai-tools that records how it was called."""
    folder = Path(tempfile.mkdtemp())
    path = folder / "ai-tools"
    path.write_text(
        "#!/bin/sh\n"
        f'echo "$@" >> {folder}/calls\n'
        f"sleep {delay}\n"
        'case "$1" in\n'
        f"  check) echo '{CHECK}' ;;\n"
        f"  update) echo '{UPDATE}' ;;\n"
        "esac\n"
    )
    path.chmod(path.stat().st_mode | stat.S_IEXEC)
    return str(path), folder / "calls"


def _auth(token: str = OPS_TOKEN, user_id: int = OWNER) -> dict:
    init = sign_init_data(
        {"auth_date": str(int(time.time())), "user": json.dumps({"id": user_id})}, token
    )
    return {"Authorization": "tma " + init}


async def _finished(service: ToolService) -> None:
    for _ in range(100):
        if not service.running:
            return
        await asyncio.sleep(0.02)
    raise AssertionError("AI tools run did not finish")


class ToolServiceTests(unittest.IsolatedAsyncioTestCase):
    async def test_update_needs_a_check_first_and_runs_one_at_a_time(self) -> None:
        command, calls = _fake_tools(delay=0.1)
        service = ToolService(command)
        with self.assertRaises(ValueError):
            service.start_update("claude", "ops")
        self.assertFalse(calls.exists())
        self.assertTrue(service.start_check("ops"))
        self.assertFalse(service.start_check("ops"))
        await _finished(service)
        self.assertEqual(service.known_tools(), ["claude", "codex"])
        self.assertTrue(service.start_update("claude", "ops"))
        self.assertEqual(service.state()["running"], "claude")
        self.assertFalse(service.start_update("codex", "ops"))
        await _finished(service)
        self.assertEqual(service.last_update["after"], "2")
        self.assertEqual(service.last_update["triggered_by"], "ops")
        self.assertEqual(
            calls.read_text().splitlines(), ["check", "update claude", "check"]
        )

    async def test_missing_command_is_reported_by_name(self) -> None:
        service = ToolService("/nonexistent/ai-tools")
        service.start_check("ops")
        await _finished(service)
        self.assertIn("ai-tools is not installed", service.report["error"])
        self.assertEqual(service.known_tools(), [])


class ToolsEndpointTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        command, self.calls = _fake_tools(delay=0.1)
        settings = Settings(
            public_url="https://h",
            host="127.0.0.1",
            port=8787,
            owner_id=OWNER,
            bots=(BotSource("ops", OPS_TOKEN, "ai-ops-agent", "ops"),),
            state_dir=Path(tempfile.mkdtemp()),
            tools_command=command,
        )
        overview = {"resources": None, "agents": [], "problems": []}
        self.views = patch.dict(
            views.VIEW_PROVIDERS, {"ops": AsyncMock(return_value=overview)}
        )
        self.views.start()
        self.app = server.build_app(settings, set_buttons=False, record_disk=False)
        self.client = TestClient(TestServer(self.app))
        await self.client.start_server()

    async def asyncTearDown(self) -> None:
        await self.client.close()
        self.views.stop()

    async def _post(self, body: object, headers: dict | None = None) -> int:
        response = await self.client.post(
            "/api/ops/tools",
            json=body,
            headers=_auth() if headers is None else headers,
        )
        return response.status

    async def test_requires_the_owners_signature(self) -> None:
        self.assertEqual(await self._post({"action": "check"}, {}), 401)
        self.assertEqual(await self._post({"action": "check"}, _auth(user_id=1)), 403)
        self.assertFalse(self.calls.exists())

    async def test_only_checked_tools_can_be_updated(self) -> None:
        self.assertEqual(await self._post({"action": "update", "tool": "claude"}), 400)
        self.assertEqual(await self._post({"action": "check"}), 202)
        self.assertEqual(await self._post({"action": "check"}), 409)
        await _finished(self.app[server.TOOLS])
        for body in (
            {"action": "update", "tool": "left-pad"},
            {"action": "update", "tool": ["claude"]},
            {"action": "update", "tool": "claude", "version": "1"},
            {"action": "update"},
            {"action": "install", "tool": "claude"},
            {"action": "check", "tool": "claude"},
            "check",
        ):
            self.assertEqual(await self._post(body), 400, body)
        self.assertEqual(self.calls.read_text().splitlines(), ["check"])
        self.assertEqual(await self._post({"action": "update", "tool": "claude"}), 202)
        state = await (await self.client.get("/api/ops", headers=_auth())).json()
        self.assertEqual(state["ai_tools"]["running"], "claude")
        await _finished(self.app[server.TOOLS])
        self.assertEqual(self.calls.read_text().splitlines()[1], "update claude")

    async def test_get_cannot_start_a_run(self) -> None:
        response = await self.client.get("/api/ops/tools", headers=_auth())
        self.assertNotEqual(response.status, 202)
        self.assertFalse(self.calls.exists())
