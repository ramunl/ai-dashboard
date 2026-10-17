"""Security card: cached ai-audit report, background refresh, Check now."""

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
from ai_dashboard.config import BotSource, Settings
from ai_dashboard.security import (
    REFRESH_SECONDS,
    SECURITY,
    SecurityService,
    register_security,
)

REPORT = {"ok": True, "stats": {"firewall": "active"}, "findings": []}


class SecurityTests(unittest.IsolatedAsyncioTestCase):
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

    async def asyncTearDown(self):
        self.folder.cleanup()

    def headers(self, owner=777):
        data = sign_init_data(
            {"auth_date": str(int(time.time())), "user": json.dumps({"id": owner})},
            "123:token",
        )
        return {"Authorization": "tma " + data}

    async def test_first_view_starts_an_audit_and_keeps_its_report(self):
        now = [1000.0]
        service = SecurityService(self.settings, clock=lambda: now[0])
        with patch(
            "ai_dashboard.security.invoke", new=AsyncMock(return_value=REPORT)
        ) as invoke:
            self.assertEqual(service.state(), {"report": None, "running": True})
            await service.task
            state = service.state()
            self.assertEqual(state["report"]["stats"], {"firewall": "active"})
            self.assertEqual(state["report"]["checked_at"], 1000.0)
            self.assertFalse(state["running"])
            self.assertEqual(invoke.await_count, 1)  # fresh: no second run
            invoke.assert_awaited_with(
                "/usr/local/sbin/ai-audit", "check", 120, "ai-audit"
            )
            now[0] += REFRESH_SECONDS + 1
            self.assertTrue(service.state()["running"])  # stale: refreshed
            await service.task
        restored = SecurityService(self.settings)
        self.assertEqual(restored.report["checked_at"], now[0])  # survives restarts

    async def test_a_failed_audit_is_shown_as_its_error(self):
        service = SecurityService(self.settings)
        failure = {"ok": False, "error": "ai-audit is not installed"}
        with patch("ai_dashboard.security.invoke", new=AsyncMock(return_value=failure)):
            service.start()
            await service.task
        self.assertEqual(service.report["error"], "ai-audit is not installed")

    async def test_check_now_is_owner_only_takes_no_options_and_runs_once(self):
        app = web.Application()
        register_security(app, self.settings)
        client = TestClient(TestServer(app))
        await client.start_server()
        gate = asyncio.Event()

        async def slow(*args):
            await gate.wait()
            return REPORT

        try:
            for headers, body, status in [
                ({}, None, 401),
                (self.headers(888), None, 403),
                (self.headers(), {"jail": "sshd"}, 400),
            ]:
                response = await client.post(
                    "/api/ops/security", headers=headers, json=body
                )
                self.assertEqual(response.status, status)
            with patch("ai_dashboard.security.invoke", new=slow):
                first = await client.post("/api/ops/security", headers=self.headers())
                second = await client.post("/api/ops/security", headers=self.headers())
                self.assertEqual((first.status, second.status), (202, 409))
                gate.set()
                await app[SECURITY].task
            self.assertTrue(app[SECURITY].report["ok"])
        finally:
            await client.close()
