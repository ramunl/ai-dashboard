"""The Coding endpoint delivers only authenticated, token-only stop requests."""

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from aiohttp.test_utils import make_mocked_request

from ai_dashboard import server
from ai_dashboard.config import BotSource, Settings
from tests.test_agent_actions import OWNER, TOKEN, _auth

STOP_TOKEN = "0123456789abcdef" * 2


class CodingStopActionTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        tmp = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.inbox = tmp / "inbox"
        settings = Settings(
            public_url="https://h",
            host="127.0.0.1",
            port=8787,
            owner_id=OWNER,
            bots=(
                BotSource(
                    "coding", TOKEN, "ai-coding-agent", "coding", inbox_dir=self.inbox
                ),
            ),
            state_dir=tmp,
        )
        self.enterContext(
            patch.object(server, "service_state", AsyncMock(return_value="active"))
        )
        self.app = server.build_app(settings, set_buttons=False, record_disk=False)

    async def post(self, args, headers):
        request = make_mocked_request(
            "POST",
            "/api/coding/actions",
            headers=headers,
            app=self.app,
        )
        request.text = AsyncMock(
            return_value=json.dumps({"action": "stop_work", "args": args})
        )
        route = await self.app.router.resolve(request)
        with patch.object(
            server.asyncio, "to_thread", side_effect=lambda fn, *args: fn(*args)
        ):
            return await route.handler(request)

    async def test_delivers_token_only_to_inbox(self):
        args = {"token": STOP_TOKEN}
        response = await self.post(args, _auth())
        self.assertEqual(response.status, 202)
        request_id = json.loads(response.text)["id"]
        request = json.loads((self.inbox / f"{request_id}.json").read_text())
        self.assertEqual(request["id"], request_id)
        self.assertEqual(request["action"], "stop_work")
        self.assertEqual(request["requested_by"], "coding")
        self.assertEqual(request["args"], args)

    async def test_rejects_missing_or_invalid_args_without_writing(self):
        for args in (
            {},
            {"token": STOP_TOKEN, "task": "01234567"},
            {"token": STOP_TOKEN.upper()},
            {"token": STOP_TOKEN[:-1]},
            {"token": STOP_TOKEN + "a"},
            {"token": STOP_TOKEN + "\n"},
            {"token": "g" + STOP_TOKEN[1:]},
            {"token": 123},
        ):
            with self.subTest(args=args):
                self.assertEqual((await self.post(args, _auth())).status, 400)
        self.assertFalse(self.inbox.exists())

    async def test_rejects_unsigned_and_non_owner_requests_without_writing(self):
        args = {"token": STOP_TOKEN}
        self.assertEqual((await self.post(args, {})).status, 401)
        self.assertEqual((await self.post(args, _auth(user_id=1))).status, 403)
        self.assertFalse(self.inbox.exists())
