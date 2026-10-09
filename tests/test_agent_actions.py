"""Coding setup requests: the dashboard's check, the inbox file, the endpoint."""

import json
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from aiohttp.test_utils import TestClient, TestServer

from ai_dashboard import server
from ai_dashboard.agent_actions import RequestError, check, submit
from ai_dashboard.auth import sign_init_data
from ai_dashboard.config import BotSource, Settings

OWNER = 777
TOKEN = "111:CODING"


def _auth(user_id: int = OWNER) -> dict:
    init = sign_init_data(
        {"auth_date": str(int(time.time())), "user": json.dumps({"id": user_id})}, TOKEN
    )
    return {"Authorization": "tma " + init}


class CheckTests(unittest.TestCase):
    def test_accepts_known_actions(self) -> None:
        self.assertEqual(
            check({"action": "use_project", "args": {"name": "cc"}}),
            ("use_project", {"name": "cc"}),
        )
        check(
            {"action": "switch_model", "args": {"tool": "claude", "model": "claude-x"}}
        )

    def test_work_actions_take_no_free_text(self) -> None:
        for action in ("approve_plan", "confirm_work", "cancel_pending"):
            self.assertEqual(check({"action": action, "args": {}}), (action, {}))
            with self.assertRaises(RequestError):
                check({"action": action, "args": {"note": "x"}})
        check({"action": "remove_queued", "args": {"task": "12"}})
        for task in ("", "-1", "1 2", "1;id", "abc", 3):
            with self.assertRaises(RequestError, msg=str(task)):
                check({"action": "remove_queued", "args": {"task": task}})

    def test_start_work_takes_one_visible_line_and_a_fixed_kind(self) -> None:
        check({"action": "start_work", "args": {"kind": "plan", "text": "add /health"}})
        for kind, text in (
            ("deploy", "x"),
            ("plan", ""),
            ("plan", "  "),
            ("plan", "two\nlines"),
            ("plan", "x" * 4001),
            ("plan", ["x"]),
        ):
            with self.assertRaises(RequestError, msg=repr(text)):
                check({"action": "start_work", "args": {"kind": kind, "text": text}})

    def test_discuss_plan_takes_only_a_note(self) -> None:
        check({"action": "discuss_plan", "args": {"text": "use sqlite"}})
        check({"action": "answer_bugfix", "args": {"text": "on Android 14"}})
        with self.assertRaises(RequestError):
            check({"action": "answer_bugfix", "args": {"text": "a\nb"}})
        for args in ({"text": ""}, {"text": "a\nb"}, {}, {"text": "x", "kind": "plan"}):
            with self.assertRaises(RequestError, msg=str(args)):
                check({"action": "discuss_plan", "args": args})

    def test_task_requests_name_a_project_and_a_todo_or_none(self) -> None:
        check(
            {
                "action": "create_task",
                "args": {"repo": "repo", "text": "x", "todo": "my_ai_agents:3f2a"},
            }
        )
        check(
            {
                "action": "create_task",
                "args": {"repo": "repo", "text": "x", "todo": "-"},
            }
        )
        check({"action": "remove_task", "args": {"task": "0a1b2c3d"}})
        for action, args in (
            ("create_task", {"repo": "../x", "text": "x", "todo": "-"}),
            ("create_task", {"repo": "repo", "text": "x", "todo": "a:b:c"}),
            ("create_task", {"repo": "repo", "text": "x", "todo": ""}),
            ("start_task", {"task": "0A1B2C3D"}),
            ("start_task", {"task": "1"}),
        ):
            with self.assertRaises(RequestError, msg=str(args)):
                check({"action": action, "args": args})

    def test_refuses_malformed(self) -> None:
        for body in (
            [],
            {"action": "run", "args": {}},
            {"action": "use_project", "args": {"name": "../x"}},
            {"action": "use_project", "args": {"name": "a", "b": "c"}},
            {"action": "add_repository", "args": {"repository": "o/r && id"}},
            {"action": "switch_model", "args": {"tool": "codex", "model": "m"}},
        ):
            with self.assertRaises(RequestError, msg=str(body)):
                check(body)

    def test_submit_writes_one_complete_request(self) -> None:
        inbox = Path(tempfile.mkdtemp()) / "inbox"
        request_id = submit(inbox, "set_planner", {"value": "claude"}, "coding")
        files = list(inbox.iterdir())
        self.assertEqual([f.name for f in files], [f"{request_id}.json"])
        saved = json.loads(files[0].read_text())
        self.assertEqual(saved["action"], "set_planner")
        self.assertEqual(saved["requested_by"], "coding")
        self.assertRegex(saved["id"], r"^[0-9a-f]{16}$")


class EndpointTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp())
        self.inbox = self.tmp / "inbox"
        settings = Settings(
            public_url="https://h",
            host="127.0.0.1",
            port=8787,
            owner_id=OWNER,
            bots=(
                BotSource(
                    "coding",
                    TOKEN,
                    "ai-coding-agent",
                    "coding",
                    self.tmp / "snapshot.json",
                    inbox_dir=self.inbox,
                ),
            ),
            state_dir=self.tmp,
        )
        self.state = patch.object(
            server, "service_state", AsyncMock(return_value="active")
        )
        self.state.start()
        app = server.build_app(settings, set_buttons=False, record_disk=False)
        self.client = TestClient(TestServer(app))
        await self.client.start_server()

    async def asyncTearDown(self) -> None:
        await self.client.close()
        self.state.stop()

    async def post(self, body, headers=None):
        return await self.client.post(
            "/api/coding/actions",
            data=json.dumps(body),
            headers=_auth() if headers is None else headers,
        )

    async def test_requires_the_owner(self) -> None:
        body = {"action": "set_planner", "args": {"value": "claude"}}
        self.assertEqual((await self.post(body, headers={})).status, 401)
        self.assertEqual((await self.post(body, headers=_auth(user_id=1))).status, 403)
        self.assertFalse(self.inbox.exists())

    async def test_queues_a_valid_request(self) -> None:
        response = await self.post({"action": "use_project", "args": {"name": "cc"}})
        self.assertEqual(response.status, 202)
        request_id = (await response.json())["id"]
        saved = json.loads((self.inbox / f"{request_id}.json").read_text())
        self.assertEqual(saved["args"], {"name": "cc"})

    async def test_rejects_malformed_without_writing(self) -> None:
        response = await self.post({"action": "run_shell", "args": {"cmd": "id"}})
        self.assertEqual(response.status, 400)
        not_json = await self.client.post(
            "/api/coding/actions", data="{nope", headers=_auth()
        )
        self.assertEqual(not_json.status, 400)
        self.assertFalse(self.inbox.exists())

    async def test_refuses_when_agent_is_down(self) -> None:
        with patch.object(server, "service_state", AsyncMock(return_value="failed")):
            response = await self.post(
                {"action": "set_planner", "args": {"value": "codex"}}
            )
        self.assertEqual(response.status, 503)
        self.assertIn("the coding agent is failed", (await response.json())["error"])
        self.assertFalse(self.inbox.exists())

    async def test_rejects_oversized_body(self) -> None:
        body = {"action": "set_planner", "args": {"value": "x" * 5000}}
        self.assertEqual((await self.post(body)).status, 413)

    async def test_get_cannot_queue_anything(self) -> None:
        response = await self.client.get("/api/coding/actions", headers=_auth())
        self.assertNotEqual(response.status, 202)
        self.assertFalse(self.inbox.exists())

    async def test_sub_window_pages_are_served(self) -> None:
        for path in ("/coding/projects", "/coding/ai"):
            self.assertEqual((await self.client.get(path)).status, 200, path)
        self.assertEqual((await self.client.get("/coding/nope")).status, 404)
        self.assertEqual((await self.client.get("/pm/projects")).status, 404)
