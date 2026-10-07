"""Ops Logs card: the fixed journalctl command and the owner-only endpoint."""

import json
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from aiohttp.test_utils import TestClient, TestServer

from ai_dashboard import logs, server
from ai_dashboard.auth import sign_init_data
from ai_dashboard.config import BotSource, Settings

OWNER = 777
TOKEN = "111:CODING"


def _auth(user_id: int = OWNER) -> dict:
    init = sign_init_data(
        {"auth_date": str(int(time.time())), "user": json.dumps({"id": user_id})}, TOKEN
    )
    return {"Authorization": "tma " + init}


class CommandTests(unittest.TestCase):
    def test_all_lines(self) -> None:
        self.assertEqual(
            logs.journal_args("ai-pm-agent", False),
            [
                "journalctl",
                "-u",
                "ai-pm-agent",
                "-n",
                "80",
                "--no-pager",
                "-q",
                "-o",
                "short-iso",
            ],
        )

    def test_errors_only(self) -> None:
        args = logs.journal_args("ai-pm-agent", True)
        self.assertEqual(args[-4:], ["-p", "err", "--since", "24 hours ago"])


class ReadTests(unittest.IsolatedAsyncioTestCase):
    async def test_cuts_long_lines_and_drops_blank_ones(self) -> None:
        out = "a\n\n" + "x" * 1000 + "\n"
        with patch.object(logs, "_run", AsyncMock(return_value=out)):
            result = await logs.read_logs("u", False)
        self.assertEqual(result["lines"], ["a", "x" * logs.MAX_LINE_CHARS])

    async def test_drops_the_hostname(self) -> None:
        out = "2026-10-07T00:00:01+0300 vps-1 python[8]: started\n"
        with (
            patch.object(logs, "_run", AsyncMock(return_value=out)),
            patch.object(logs.socket, "gethostname", return_value="vps-1"),
        ):
            result = await logs.read_logs("u", False)
        self.assertEqual(
            result["lines"], ["2026-10-07T00:00:01+0300 python[8]: started"]
        )

    async def test_unavailable_journal(self) -> None:
        with patch.object(logs, "_run", AsyncMock(return_value=None)):
            self.assertFalse((await logs.read_logs("u", False))["ok"])


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
            ),
            monitored_services=("ai-pm-agent", "ai-coding-agent"),
            state_dir=tmp,
        )
        self.run_mock = AsyncMock(
            return_value="2026-10-07T00:00:00+0300 host svc[1]: hello\n"
        )
        self.patcher = patch.object(logs, "_run", self.run_mock)
        self.patcher.start()
        app = server.build_app(settings, set_buttons=False, record_disk=False)
        self.client = TestClient(TestServer(app))
        await self.client.start_server()

    async def asyncTearDown(self) -> None:
        await self.client.close()
        self.patcher.stop()

    async def test_requires_the_owner(self) -> None:
        self.assertEqual((await self.client.get("/api/ops/logs")).status, 401)
        response = await self.client.get("/api/ops/logs", headers=_auth(user_id=1))
        self.assertEqual(response.status, 403)
        self.run_mock.assert_not_awaited()

    async def test_defaults_to_first_unit_and_lists_units(self) -> None:
        body = await (await self.client.get("/api/ops/logs", headers=_auth())).json()
        self.assertEqual(body["unit"], "ai-coding-agent")
        self.assertEqual(body["units"], ["ai-coding-agent", "ai-pm-agent"])
        self.assertEqual(body["lines"], ["2026-10-07T00:00:00+0300 host svc[1]: hello"])

    async def test_errors_filter(self) -> None:
        await self.client.get(
            "/api/ops/logs?unit=ai-pm-agent&errors=1", headers=_auth()
        )
        args = self.run_mock.await_args.args
        self.assertEqual(args[2], "ai-pm-agent")
        self.assertIn("err", args)

    async def test_redacts_credentials_before_sending_logs(self) -> None:
        self.run_mock.return_value = (
            "bot token " + TOKEN + " sk-ant-" + "a" * 30 + " ghp_" + "b" * 30
        )
        body = await (await self.client.get("/api/ops/logs", headers=_auth())).json()
        text = "\n".join(body["lines"])
        self.assertNotIn(TOKEN, text)
        self.assertNotIn("a" * 30, text)
        self.assertNotIn("b" * 30, text)
        self.assertEqual(text.count("[redacted]"), 3)

    async def test_unknown_unit_never_reaches_journalctl(self) -> None:
        for unit in ("sshd", "../etc", "ai-pm-agent --since=1", "-k"):
            response = await self.client.get(
                "/api/ops/logs", params={"unit": unit}, headers=_auth()
            )
            self.assertEqual(response.status, 400, unit)
        self.run_mock.assert_not_awaited()
