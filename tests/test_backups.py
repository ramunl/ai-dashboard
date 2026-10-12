"""Backup route authentication, single-run behavior and delivery outcomes."""

import asyncio
import json
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

from ai_dashboard.auth import sign_init_data
from ai_dashboard.backups import BACKUPS, BackupService, deliver, register_backups
from ai_dashboard.config import BotSource, Settings


class BackupTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.settings = Settings(
            public_url="https://example.test",
            host="127.0.0.1",
            port=8080,
            owner_id=777,
            bots=(BotSource("ops", "123:token", "ops", "ops"),),
            state_dir=Path(self.folder.name),
        )
        app = web.Application()
        register_backups(app, self.settings)
        self.client = TestClient(TestServer(app))
        await self.client.start_server()

    async def asyncTearDown(self):
        await self.client.close()
        self.folder.cleanup()

    def headers(self, owner=777):
        data = sign_init_data(
            {"auth_date": str(int(time.time())), "user": json.dumps({"id": owner})},
            "123:token",
        )
        return {"Authorization": "tma " + data}

    async def test_auth_post_only_and_no_caller_options(self):
        for method, headers, body, status in [
            ("post", {}, None, 401),
            ("post", self.headers(888), None, 403),
            ("get", self.headers(), None, 405),
            ("post", self.headers(), {"path": "/etc/shadow"}, 400),
        ]:
            response = await getattr(self.client, method)(
                "/api/ops/backup", headers=headers, json=body
            )
            self.assertEqual(response.status, status)

    async def test_start_delivery_and_duplicate_guard(self):
        gate = asyncio.Event()

        async def invoke(*args):
            await gate.wait()
            return {"ok": True, "at": 123, "file": "/unused"}

        with (
            patch("ai_dashboard.backups.invoke", side_effect=invoke),
            patch(
                "ai_dashboard.backups.deliver", new=AsyncMock(return_value=True)
            ) as send,
        ):
            response = await self.client.post("/api/ops/backup", headers=self.headers())
            self.assertEqual(response.status, 202)
            response = await self.client.post("/api/ops/backup", headers=self.headers())
            self.assertEqual(response.status, 409)
            gate.set()
            await self.client.app[BACKUPS].task
            send.assert_awaited_once()
        restored = BackupService(self.settings)
        self.assertTrue(restored.delivery["ok"])
        self.assertFalse(restored.running)

    async def test_creation_failure_does_not_send_and_delivery_failure_is_distinct(
        self,
    ):
        service = self.client.app[BACKUPS]
        with (
            patch(
                "ai_dashboard.backups.invoke",
                new=AsyncMock(return_value={"ok": False, "error": "missing key"}),
            ),
            patch("ai_dashboard.backups.deliver", new=AsyncMock()) as send,
        ):
            await service.run()
            send.assert_not_called()
            self.assertEqual(service.delivery["message"], "missing key")
        with (
            patch(
                "ai_dashboard.backups.invoke",
                new=AsyncMock(return_value={"ok": True, "at": 1}),
            ),
            patch("ai_dashboard.backups.deliver", new=AsyncMock(return_value=False)),
        ):
            await service.run()
            self.assertIn("saved, but Telegram", service.delivery["message"])

    async def test_delivery_rejects_non_archive_paths(self):
        self.assertFalse(await deliver(self.settings, {"file": "/etc/passwd"}))
