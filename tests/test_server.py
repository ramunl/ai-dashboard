import json
import logging
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

import aiohttp
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

from ai_dashboard import server, sources
from ai_dashboard.auth import sign_init_data
from ai_dashboard.config import BotSource, Settings
from ai_dashboard.telegram_api import set_menu_button

OWNER = 777
TOKEN = "111:CODING"


def _settings(snapshot_file: Path) -> Settings:
    return Settings(
        public_url="https://1-2-3-4.sslip.io:8443",
        host="127.0.0.1",
        port=8787,
        owner_id=OWNER,
        bots=(BotSource("coding", "coding", TOKEN, "ai-coding-agent", snapshot_file),),
    )


def _auth(token: str = TOKEN, user_id: int = OWNER) -> dict:
    init = sign_init_data(
        {"auth_date": str(int(time.time())), "user": json.dumps({"id": user_id})}, token
    )
    return {"Authorization": "tma " + init}


class RouteTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.snapshot = Path(tempfile.mkdtemp()) / "snapshot.json"
        self.snapshot.write_text(
            json.dumps({"format": 1, "updated_at": time.time(), "queue": [{"id": 1}]})
        )
        app = server.build_app(_settings(self.snapshot), set_buttons=False)
        self.client = TestClient(TestServer(app))
        await self.client.start_server()
        self.service = patch.object(
            sources, "service_state", AsyncMock(return_value="active")
        )
        self.service.start()

    async def asyncTearDown(self) -> None:
        self.service.stop()
        await self.client.close()

    async def test_data_requires_signature(self) -> None:
        self.assertEqual((await self.client.get("/api/coding")).status, 401)
        response = await self.client.get("/api/coding", headers=_auth("999:X"))
        self.assertEqual(response.status, 401)

    async def test_data_rejects_other_user(self) -> None:
        response = await self.client.get("/api/coding", headers=_auth(user_id=1))
        self.assertEqual(response.status, 403)

    async def test_owner_gets_window_data(self) -> None:
        response = await self.client.get("/api/coding", headers=_auth())
        body = await response.json()
        self.assertEqual(response.status, 200)
        self.assertEqual(body["snapshot"]["queue"], [{"id": 1}])
        self.assertEqual(body["opened_from"], "coding")
        self.assertIsNone(body["problem"])
        self.assertEqual(response.headers["Cache-Control"], "no-store")

    async def test_unknown_window(self) -> None:
        self.assertEqual(
            (await self.client.get("/api/pm", headers=_auth())).status, 404
        )
        self.assertEqual((await self.client.get("/pm")).status, 404)

    async def test_page_served_for_root_and_windows(self) -> None:
        for path in ("/", "/coding"):
            response = await self.client.get(path)
            self.assertEqual(response.status, 200)
            self.assertIn("telegram-web-app.js", await response.text())

    async def test_health(self) -> None:
        self.assertEqual(await (await self.client.get("/healthz")).json(), {"ok": True})


class MenuButtonTests(unittest.IsolatedAsyncioTestCase):
    async def _fake_telegram(self, reply: dict):
        calls = []

        async def handler(request: web.Request) -> web.Response:
            calls.append((request.match_info["token"], await request.json()))
            return web.json_response(reply)

        app = web.Application()
        app.router.add_post("/bot{token}/setChatMenuButton", handler)
        fake = TestServer(app)
        await fake.start_server()
        self.addAsyncCleanup(fake.close)
        return str(fake.make_url("")).rstrip("/"), calls

    async def test_points_button_at_window_url(self) -> None:
        base, calls = await self._fake_telegram({"ok": True})
        async with aiohttp.ClientSession() as session:
            ok = await set_menu_button(
                session, "coding", TOKEN, OWNER, "https://h/coding", base
            )
        self.assertTrue(ok)
        token, payload = calls[0]
        self.assertEqual(token, TOKEN)
        self.assertEqual(payload["chat_id"], OWNER)
        self.assertEqual(payload["menu_button"]["web_app"]["url"], "https://h/coding")

    async def test_failure_is_logged_without_leaking_token(self) -> None:
        async with aiohttp.ClientSession() as session:
            with self.assertLogs("ai_dashboard.telegram_api", logging.WARNING) as logs:
                ok = await set_menu_button(
                    session, "coding", TOKEN, OWNER, "https://h/", "http://127.0.0.1:9"
                )
        self.assertFalse(ok)
        self.assertNotIn(TOKEN, "\n".join(logs.output))

    async def test_api_error_reported(self) -> None:
        base, _ = await self._fake_telegram(
            {"ok": False, "description": "chat not found"}
        )
        async with aiohttp.ClientSession() as session:
            with self.assertLogs("ai_dashboard.telegram_api", logging.WARNING) as logs:
                ok = await set_menu_button(
                    session, "coding", TOKEN, OWNER, "https://h/", base
                )
        self.assertFalse(ok)
        self.assertIn("chat not found", "\n".join(logs.output))
