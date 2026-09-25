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
        bots=(BotSource("coding", TOKEN, "ai-coding-agent", "coding", snapshot_file),),
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
            (await self.client.get("/api/nope", headers=_auth())).status, 404
        )
        self.assertEqual((await self.client.get("/nope")).status, 404)

    async def test_pm_window_without_pm_bot_is_not_configured(self) -> None:
        self.assertEqual((await self.client.get("/pm")).status, 200)
        response = await self.client.get("/api/pm", headers=_auth())
        self.assertEqual(response.status, 404)
        self.assertEqual((await response.json())["error"], "window not configured")

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


class LauncherRouteTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        from ai_dashboard import views

        snapshot = Path(tempfile.mkdtemp()) / "snapshot.json"
        snapshot.write_text(
            json.dumps(
                {
                    "format": 1,
                    "updated_at": time.time(),
                    "queue": [],
                    "running": {"branch": "feature/x", "phase": "Polling CI"},
                    "project": {"name": "channel-cast"},
                }
            )
        )
        states = {
            "ai-coding-agent": "active",
            "ai-pm-agent": "active",
            "ai-ops-agent": "failed",
        }

        async def fake_status(unit: str) -> dict:
            return {
                "unit": unit,
                "load_state": "loaded",
                "state": states[unit],
                "sub_state": "",
                "restarts": 0,
                "since": "",
            }

        resources = {
            "hostname": "vps",
            "cpus": 1,
            "load": [0.1, 0.1, 0.1],
            "memory": {"total": 1000, "available": 500},
            "disk": {"total": 1000, "used": 500, "free": 500},
            "uptime_seconds": 60,
        }
        self.patches = [
            patch.object(views, "unit_status", side_effect=fake_status),
            patch.object(views, "recent_errors", AsyncMock(return_value=0)),
            patch.object(views, "read_resources", return_value=resources),
            patch.object(sources, "service_state", AsyncMock(return_value="active")),
        ]
        for item in self.patches:
            item.start()
        app = server.build_app(_settings(snapshot), set_buttons=False)
        self.client = TestClient(TestServer(app))
        await self.client.start_server()

    async def asyncTearDown(self) -> None:
        for item in self.patches:
            item.stop()
        await self.client.close()

    async def test_requires_signature(self) -> None:
        self.assertEqual((await self.client.get("/api/launcher")).status, 401)

    async def test_reports_services_resources_and_problems(self) -> None:
        response = await self.client.get("/api/launcher", headers=_auth())
        body = await response.json()
        self.assertEqual(response.status, 200)
        self.assertEqual(
            [s["unit"] for s in body["services"]],
            ["ai-coding-agent", "ai-pm-agent", "ai-ops-agent"],
        )
        self.assertEqual(body["resources"]["hostname"], "vps")
        self.assertEqual(
            body["problems"][0], {"severity": "error", "text": "ai-ops-agent is failed"}
        )
        self.assertEqual(
            body["agents"],
            [
                {
                    "name": "coding",
                    "label": "Coding agent",
                    "path": "coding",
                    "service": "active",
                    "problem": None,
                    "detail": "running feature/x · Polling CI",
                }
            ],
        )

    async def test_root_page_is_the_launcher(self) -> None:
        self.assertEqual((await self.client.get("/")).status, 200)


class MenuTargetTests(unittest.IsolatedAsyncioTestCase):
    async def test_each_bot_opens_its_own_window(self) -> None:
        calls = []

        async def handler(request: web.Request) -> web.Response:
            calls.append(
                (request.match_info["token"], (await request.json())["menu_button"])
            )
            return web.json_response({"ok": True})

        fake_app = web.Application()
        fake_app.router.add_post("/bot{token}/setChatMenuButton", handler)
        fake = TestServer(fake_app)
        await fake.start_server()
        self.addAsyncCleanup(fake.close)

        settings = Settings(
            public_url="https://h:8443",
            host="127.0.0.1",
            port=8787,
            owner_id=OWNER,
            bots=(
                BotSource("coding", TOKEN, "ai-coding-agent", "coding", Path("/x")),
                BotSource("ops", "222:OPS", "ai-ops-agent", ""),
                BotSource("pm", "333:PM", "ai-pm-agent", "pm", Path("/y")),
            ),
        )
        await server._point_menu_buttons(settings, str(fake.make_url("")).rstrip("/"))
        urls = {token: button["web_app"]["url"] for token, button in calls}
        self.assertEqual(
            urls,
            {
                TOKEN: "https://h:8443/coding",
                "222:OPS": "https://h:8443/",
                "333:PM": "https://h:8443/pm",
            },
        )


class PmWindowTests(unittest.IsolatedAsyncioTestCase):
    async def test_pm_window_and_launcher_row(self) -> None:
        from ai_dashboard import views

        tmp = Path(tempfile.mkdtemp())
        coding_snapshot = tmp / "coding.json"
        coding_snapshot.write_text(
            json.dumps({"format": 1, "updated_at": time.time(), "queue": []})
        )
        pm_snapshot = tmp / "pm.json"
        pm_snapshot.write_text(
            json.dumps(
                {
                    "format": 1,
                    "updated_at": time.time(),
                    "active_project": "channel-cast",
                    "todos": {
                        "project": "channel-cast",
                        "open": ["release apk"],
                        "open_count": 1,
                        "done": 2,
                    },
                    "projects": [{"name": "channel-cast", "open": 1, "done": 2}],
                    "rules": [{"file": "global/kotlin.md", "count": 3}],
                }
            )
        )
        settings = Settings(
            public_url="https://h",
            host="127.0.0.1",
            port=8787,
            owner_id=OWNER,
            bots=(
                BotSource(
                    "coding", TOKEN, "ai-coding-agent", "coding", coding_snapshot
                ),
                BotSource("pm", "333:PM", "ai-pm-agent", "pm", pm_snapshot),
            ),
            monitored_services=("ai-pm-agent",),
        )
        status = {
            "unit": "ai-pm-agent",
            "load_state": "loaded",
            "state": "active",
            "sub_state": "",
            "restarts": 0,
            "since": "",
        }
        with (
            patch.object(sources, "service_state", AsyncMock(return_value="active")),
            patch.object(views, "unit_status", AsyncMock(return_value=status)),
            patch.object(views, "recent_errors", AsyncMock(return_value=0)),
            patch.object(views, "read_resources", side_effect=OSError("no /proc here")),
        ):
            client = TestClient(
                TestServer(server.build_app(settings, set_buttons=False))
            )
            await client.start_server()
            try:
                pm = await (await client.get("/api/pm", headers=_auth("333:PM"))).json()
                launcher = await (
                    await client.get("/api/launcher", headers=_auth())
                ).json()
            finally:
                await client.close()

        self.assertEqual(pm["opened_from"], "pm")
        self.assertEqual(pm["snapshot"]["todos"]["open"], ["release apk"])
        self.assertEqual(
            [(a["name"], a["detail"]) for a in launcher["agents"]],
            [("coding", "idle"), ("pm", "channel-cast · 1 open · 2 done")],
        )
        self.assertIsNone(launcher["resources"])  # unreadable /proc degrades, not fails


class DetailTests(unittest.TestCase):
    def test_coding_detail(self) -> None:
        from ai_dashboard.views import coding_detail

        self.assertEqual(coding_detail({"service": "failed"}), "service failed")
        idle = {
            "service": "active",
            "snapshot": {"queue": [1, 2], "project": {"name": "cc"}},
        }
        self.assertEqual(coding_detail(idle), "idle · 2 queued · cc")

    def test_pm_detail(self) -> None:
        from ai_dashboard.views import pm_detail

        self.assertEqual(
            pm_detail({"service": "active", "snapshot": None}), "no data yet"
        )
        no_project = {
            "service": "active",
            "snapshot": {"todos": None, "projects": [1, 2]},
        }
        self.assertEqual(pm_detail(no_project), "no active project · 2 projects")
