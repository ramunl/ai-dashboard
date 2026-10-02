"""Owner authorization and fixed local bridge boundaries for PM editing."""

import json
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from aiohttp.test_utils import TestClient, TestServer

from ai_dashboard.auth import sign_init_data
from ai_dashboard.config import BotSource, Settings
from ai_dashboard.pm_bridge import invoke_pm
from ai_dashboard.server import build_app

TOKEN = "123:PM"


class PMEndpointTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        settings = Settings(
            public_url="https://example.org",
            host="127.0.0.1",
            port=8787,
            owner_id=777,
            bots=(BotSource("pm", TOKEN, "ai-pm-agent", "pm"),),
        )
        self.bridge = AsyncMock(return_value={"ok": True, "workspace": {"items": []}})
        self.mock = patch("ai_dashboard.pm_bridge.invoke_pm", self.bridge)
        self.mock.start()
        self.client = TestClient(
            TestServer(build_app(settings, set_buttons=False, record_disk=False))
        )
        await self.client.start_server()

    async def asyncTearDown(self):
        await self.client.close()
        self.mock.stop()

    def auth(self, user=777):
        data = sign_init_data(
            {"auth_date": str(int(time.time())), "user": json.dumps({"id": user})},
            TOKEN,
        )
        return {"Authorization": "tma " + data}

    async def test_unauthorized_and_other_owner_cannot_edit(self):
        self.assertEqual(
            (
                await self.client.post("/api/pm/action", json={"action": "delete"})
            ).status,
            401,
        )
        self.assertEqual(
            (
                await self.client.post(
                    "/api/pm/action", headers=self.auth(1), json={"action": "delete"}
                )
            ).status,
            403,
        )
        self.bridge.assert_not_called()

    async def test_get_only_reads_and_cannot_start_action(self):
        response = await self.client.get("/api/pm/workspace", headers=self.auth())
        self.assertEqual(response.status, 200)
        self.assertEqual(self.bridge.await_args.args[1], {"action": "read"})
        self.assertEqual(
            (await self.client.get("/api/pm/action", headers=self.auth())).status, 405
        )

    async def test_signed_action_passes_json_to_fixed_command(self):
        payload = {
            "action": "update",
            "project": "app",
            "id": "a" * 32,
            "revision": "rev",
            "priority": "high",
        }
        response = await self.client.post(
            "/api/pm/action", headers=self.auth(), json=payload
        )
        self.assertEqual(response.status, 200)
        self.assertEqual(
            self.bridge.await_args.args, ("/usr/local/sbin/ai-pm-todos", payload)
        )

    async def test_conflict_is_visible_and_unknown_action_rejected(self):
        self.bridge.return_value = {
            "ok": False,
            "conflict": True,
            "error": "List changed",
        }
        response = await self.client.post(
            "/api/pm/action", headers=self.auth(), json={"action": "update"}
        )
        self.assertEqual(response.status, 409)
        self.assertEqual((await response.json())["error"], "List changed")
        self.bridge.reset_mock()
        self.assertEqual(
            (
                await self.client.post(
                    "/api/pm/action", headers=self.auth(), json={"action": "shell"}
                )
            ).status,
            400,
        )
        self.bridge.assert_not_called()

    async def test_malformed_body_is_rejected(self):
        response = await self.client.post(
            "/api/pm/action", headers=self.auth(), data="bad-json"
        )
        self.assertEqual(response.status, 400)
        self.bridge.assert_not_called()


class PMInvokeTests(unittest.IsolatedAsyncioTestCase):
    async def test_missing_bridge_is_actionable(self):
        result = await invoke_pm("/missing/pm", {"action": "read"})
        self.assertIn("not installed", result["error"])

    async def test_real_bridge_receives_json_stdin(self):
        script = Path(tempfile.mkdtemp()) / "pm"
        script.write_text(
            '#!/usr/bin/env python3\nimport json,sys\np=json.load(sys.stdin)\nprint(json.dumps({"ok":True,"workspace":p}))\n'
        )
        script.chmod(0o755)
        payload = {"action": "read", "project": "literal $(touch unsafe)"}
        self.assertEqual((await invoke_pm(str(script), payload))["workspace"], payload)
