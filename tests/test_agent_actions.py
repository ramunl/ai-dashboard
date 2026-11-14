"""Coding setup requests: the dashboard's check, the inbox file, the endpoint."""

import json
import os
import re
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from aiohttp.test_utils import TestClient, TestServer

from ai_dashboard import server
from ai_dashboard.agent_actions import (
    RequestError,
    capabilities,
    check,
    staged_images,
    submit,
    sweep_staged,
)
from ai_dashboard.auth import sign_init_data
from ai_dashboard.config import BotSource, Settings
from ai_dashboard.sources import CODING_SNAPSHOT_FORMATS, read_snapshot

OWNER = 777
TOKEN = "111:CODING"
_HEX16 = re.compile(r"^[0-9a-f]{16}$")


def _auth(user_id: int = OWNER) -> dict:
    init = sign_init_data(
        {"auth_date": str(int(time.time())), "user": json.dumps({"id": user_id})}, TOKEN
    )
    return {"Authorization": "tma " + init}


def _registry_snapshot() -> dict:
    """A valid DS05 registry with a third provider (gpt) and one unmanageable tool."""
    return {
        "format": 2,
        "updated_at": time.time(),
        "registry": {
            "format": 1,
            "roles": {
                "planner": {"tool": "codex", "options": ["codex", "gpt"]},
                "implementer": {"tool": "gpt", "options": ["gpt", "codex"]},
            },
            "tools": {
                "codex": {
                    "label": "Codex",
                    "provider": "openai",
                    "model": "default",
                    "models": ["default"],
                    "manageable": True,
                },
                "gpt": {
                    "label": "GPT",
                    "provider": "openai",
                    "model": "gpt-4",
                    "models": ["gpt-4"],
                    "manageable": False,
                },
            },
        },
    }


class CheckTests(unittest.TestCase):
    def test_accepts_known_actions(self) -> None:
        self.assertEqual(
            check({"action": "use_project", "args": {"name": "cc"}}),
            ("use_project", {"name": "cc"}),
        )
        check(
            {"action": "switch_model", "args": {"tool": "claude", "model": "claude-x"}}
        )

    def test_accepts_codex_model_switch(self) -> None:
        check({"action": "switch_model", "args": {"tool": "codex", "model": "default"}})

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
                "args": {
                    "repo": "repo",
                    "text": "x",
                    "todo": "my_ai_agents:3f2a",
                    "images": "",
                },
            }
        )
        check(
            {
                "action": "create_task",
                "args": {"repo": "repo", "text": "x", "todo": "-", "images": ""},
            }
        )
        check({"action": "remove_task", "args": {"task": "0a1b2c3d"}})
        bad = {"repo": "repo", "text": "x", "todo": "-", "images": ""}
        for change in (
            {"repo": "../x"},
            {"todo": "a:b:c"},
            {"todo": ""},
            {"images": None},
        ):
            with self.assertRaises(RequestError, msg=str(change)):
                check({"action": "create_task", "args": {**bad, **change}})
        for args in (
            {"repo": "repo", "text": "x", "todo": "-"},  # no images field at all
            {**bad, "extra": "1"},
        ):
            with self.assertRaises(RequestError, msg=str(args)):
                check({"action": "create_task", "args": args})
        with self.assertRaises(RequestError):
            check({"action": "start_task", "args": {"task": "1"}})

    def test_reopen_requires_exact_task_id(self) -> None:
        args = {"task": "0a1b2c3d"}
        self.assertEqual(
            check({"action": "reopen_task", "args": args}), ("reopen_task", args)
        )
        for invalid in (
            {},
            None,
            {"task": 123},
            {"task": "ABCDEF12"},
            {"task": "../task"},
            {"task": "0a1b2c3d", "tool": "codex"},
            {"task": "0a1b2c3d", "force": "on"},
        ):
            with self.subTest(args=invalid), self.assertRaises(RequestError):
                check({"action": "reopen_task", "args": invalid})

    def test_task_images_are_staged_upload_ids_up_to_three(self) -> None:
        one, two, three = "0123456789abcdef", "fedcba9876543210", "0f1e2d3c4b5a6978"
        for images in ("", one, f"{one},{two}", f"{one},{two},{three}"):
            body = {"repo": "repo", "text": "x", "todo": "-", "images": images}
            check({"action": "create_task", "args": body})
        for images in (
            f"{one},",
            f"{one},{two},{three},{one}",
            "0123456789ABCDEF",
            "../etc/passwd",
            "short",
        ):
            body = {"repo": "repo", "text": "x", "todo": "-", "images": images}
            with self.assertRaises(RequestError, msg=images):
                check({"action": "create_task", "args": body})

    def test_worker_requests_are_bounded(self) -> None:
        check({"action": "worker_switch", "args": {"value": "on"}})
        check({"action": "worker_tools", "args": {"value": "fixed"}})
        check({"action": "worker_scan", "args": {}})
        check({"action": "split_plan", "args": {}})
        check({"action": "worker_reviews", "args": {"value": "10"}})
        check({"action": "worker_review", "args": {}})
        with self.assertRaises(RequestError):
            check({"action": "worker_reviews", "args": {"value": "11"}})
        check({"action": "set_autopilot", "args": {"task": "0a1b2c3d", "value": "on"}})
        check(
            {
                "action": "create_autopilot_task",
                "args": {"repo": "repo", "text": "x", "todo": "-"},
            }
        )
        check({"action": "retry_task", "args": {"task": "0a1b2c3d", "tool": "claude"}})
        check({"action": "resume_task", "args": {"task": "0a1b2c3d", "tool": "codex"}})
        for args in (
            {"task": "../x", "tool": "codex"},
            {"task": "0a1b2c3d", "tool": "unknown"},
            {"task": "0a1b2c3d", "tool": "codex", "ref": "HEAD"},
        ):
            with self.assertRaises(RequestError):
                check({"action": "resume_task", "args": args})
        with self.assertRaises(RequestError):
            check({"action": "retry_task", "args": {"task": "0a1b2c3d", "tool": "gpt"}})
        check({"action": "accept_task", "args": {"task": "0a1b2c3d"}})
        check({"action": "dismiss_task", "args": {"task": "0a1b2c3d"}})
        with self.assertRaises(RequestError):
            check({"action": "worker_scan", "args": {"service": "x"}})
        with self.assertRaises(RequestError):
            check({"action": "dismiss_task", "args": {"task": "../x"}})
        with self.assertRaises(RequestError):
            check({"action": "worker_tools", "args": {"value": "claude"}})
        check({"action": "worker_settings", "args": {"max_runs": "0", "reserve": "90"}})
        for action, args in (
            ("worker_switch", {"value": "1"}),
            ("worker_settings", {"max_runs": "51", "reserve": "10"}),
            ("worker_settings", {"max_runs": "3", "reserve": "91"}),
            ("worker_settings", {"max_runs": "3"}),
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
            {"action": "switch_model", "args": {"tool": "claude-code", "model": "m"}},
        ):
            with self.assertRaises(RequestError, msg=str(body)):
                check(body)

    def test_registry_capabilities_derive_each_allowlist(self) -> None:
        caps = capabilities(_registry_snapshot())
        self.assertEqual(caps.planner, ("codex", "gpt"))
        self.assertEqual(caps.implementer, ("gpt", "codex"))
        # Only manageable tools may switch models; retry/resume re-run the
        # implementer, so they accept exactly its options.
        self.assertEqual(caps.switch_tools, ("codex",))
        self.assertEqual(caps.retry_tools, ("gpt", "codex"))

    def test_registry_capabilities_accept_the_registry_and_refuse_legacy(self) -> None:
        caps = capabilities(_registry_snapshot())
        check({"action": "set_planner", "args": {"value": "gpt"}}, caps)
        check({"action": "set_implementer", "args": {"value": "codex"}}, caps)
        check(
            {"action": "switch_model", "args": {"tool": "codex", "model": "gpt-5"}},
            caps,
        )
        check(
            {"action": "retry_task", "args": {"task": "0a1b2c3d", "tool": "gpt"}},
            caps,
        )
        check(
            {"action": "resume_task", "args": {"task": "0a1b2c3d", "tool": "codex"}},
            caps,
        )
        for body in (
            {"action": "set_planner", "args": {"value": "claude"}},
            {"action": "set_implementer", "args": {"value": "claude"}},
            {"action": "switch_model", "args": {"tool": "gpt", "model": "gpt-5"}},
            {"action": "switch_model", "args": {"tool": "claude", "model": "claude-x"}},
            {"action": "retry_task", "args": {"task": "0a1b2c3d", "tool": "claude"}},
            {"action": "resume_task", "args": {"task": "0a1b2c3d", "tool": "claude"}},
        ):
            with self.subTest(body=body), self.assertRaises(RequestError):
                check(body, caps)

    def test_registry_capabilities_fall_back_when_malformed(self) -> None:
        registry = _registry_snapshot()["registry"]
        codex = registry["tools"]["codex"]
        gpt = registry["tools"]["gpt"]
        cases = [
            None,
            {},
            "registry",
            {**registry, "format": "1"},
            {**registry, "format": 2},
            {
                **registry,
                "tools": {**registry["tools"], "gpt": {**gpt, "manageable": "no"}},
            },
            {
                **registry,
                "tools": {**registry["tools"], "gpt": {**gpt, "model": "../x"}},
            },
            {
                **registry,
                "tools": {**registry["tools"], "gpt": {**gpt, "models": ["ok", 3]}},
            },
            {
                **registry,
                "tools": {
                    **registry["tools"],
                    "gpt": {k: v for k, v in gpt.items() if k != "model"},
                },
            },
            {**registry, "tools": {**registry["tools"], "bad id": codex}},
            {
                **registry,
                "roles": {
                    **registry["roles"],
                    "planner": {"tool": "gpt", "options": []},
                },
            },
            {
                **registry,
                "roles": {
                    **registry["roles"],
                    "implementer": {"tool": "gpt", "options": ["gpt", "missing"]},
                },
            },
            {
                **registry,
                "roles": {
                    **registry["roles"],
                    "planner": {"tool": "missing", "options": ["gpt"]},
                },
            },
        ]
        for value in cases:
            with self.subTest(registry=value):
                self.assertIsNone(capabilities({"registry": value}))

    def test_legacy_fallback_keeps_codex_claude_only(self) -> None:
        check({"action": "set_planner", "args": {"value": "claude"}})
        check({"action": "set_implementer", "args": {"value": "codex"}})
        check({"action": "retry_task", "args": {"task": "0a1b2c3d", "tool": "codex"}})
        check({"action": "resume_task", "args": {"task": "0a1b2c3d", "tool": "claude"}})
        for body in (
            {"action": "set_planner", "args": {"value": "gpt"}},
            {"action": "set_implementer", "args": {"value": "gpt"}},
            {"action": "retry_task", "args": {"task": "0a1b2c3d", "tool": "gpt"}},
            {"action": "resume_task", "args": {"task": "0a1b2c3d", "tool": "gpt"}},
        ):
            with self.subTest(body=body), self.assertRaises(RequestError):
                check(body)

    def test_context_actions_validate_scope_kind_id_revision_decision(self) -> None:
        inspect = {"scope": "task", "kind": "evidence", "id": "0a1b2c3d"}
        self.assertEqual(
            check({"action": "context_inspect_v1", "args": inspect}),
            ("context_inspect_v1", inspect),
        )
        self.assertEqual(
            check({"action": "context_link_v1", "args": inspect}),
            ("context_link_v1", inspect),
        )
        decide = {
            "scope": "initiative",
            "id": "5a9c68fe",
            "decision": "dependency:repo:ramunl/ai-dashboard",
            "revision": "2",
        }
        self.assertEqual(
            check({"action": "context_approve_v1", "args": decide}),
            ("context_approve_v1", decide),
        )
        self.assertEqual(
            check({"action": "context_reject_v1", "args": decide}),
            ("context_reject_v1", decide),
        )

    def test_context_actions_refuse_wrong_fields(self) -> None:
        inspect = {"scope": "task", "kind": "evidence", "id": "0a1b2c3d"}
        decide = {
            "scope": "initiative",
            "id": "5a9c68fe",
            "decision": "dependency:repo:ramunl/ai-dashboard",
            "revision": "2",
        }
        for action, args in (
            ("context_inspect_v1", {**inspect, "scope": "repo"}),
            ("context_inspect_v1", {**inspect, "kind": "Evidence"}),
            ("context_inspect_v1", {**inspect, "id": "ABCDEF12"}),
            ("context_inspect_v1", {**inspect, "id": "123"}),
            ("context_inspect_v1", {**inspect, "revision": "2"}),
            ("context_inspect_v1", {"scope": "task", "kind": "evidence"}),
            ("context_link_v1", {**inspect, "kind": "path/../../x"}),
            ("context_approve_v1", {**decide, "revision": "0"}),
            ("context_approve_v1", {**decide, "revision": "1.5"}),
            ("context_approve_v1", {**decide, "revision": "-1"}),
            ("context_approve_v1", {**decide, "decision": "dependency repo"}),
            ("context_approve_v1", {**decide, "decision": ""}),
            ("context_approve_v1", {**decide, "kind": "decision"}),
            ("context_reject_v1", {**decide, "scope": "branch"}),
            ("context_reject_v1", {**decide, "id": "zzzzzzzz"}),
            ("context_reject_v1", {**decide, "revision": None}),
        ):
            with (
                self.subTest(action=action, args=args),
                self.assertRaises(RequestError),
            ):
                check({"action": action, "args": args})

    def test_submit_omits_requested_by_for_context_actions(self) -> None:
        cases = {
            "context_inspect_v1": {
                "scope": "task",
                "kind": "evidence",
                "id": "0a1b2c3d",
            },
            "context_link_v1": {"scope": "task", "kind": "packet", "id": "0a1b2c3d"},
            "context_approve_v1": {
                "scope": "initiative",
                "id": "5a9c68fe",
                "decision": "dependency:repo:ramunl/ai-dashboard",
                "revision": "2",
            },
            "context_reject_v1": {
                "scope": "initiative",
                "id": "5a9c68fe",
                "decision": "dependency:repo:ramunl/ai-dashboard",
                "revision": "2",
            },
        }
        for action, args in cases.items():
            with self.subTest(action=action):
                folder = Path(tempfile.mkdtemp()) / "inbox"
                request_id = submit(folder, action, args, "coding")
                saved = json.loads((folder / f"{request_id}.json").read_text())
                self.assertEqual(set(saved), {"id", "action", "args", "requested_at"})
                self.assertNotIn("requested_by", saved)

    def test_submit_keeps_requested_by_for_other_actions(self) -> None:
        inbox = Path(tempfile.mkdtemp()) / "inbox"
        request_id = submit(inbox, "set_planner", {"value": "claude"}, "coding")
        saved = json.loads((inbox / f"{request_id}.json").read_text())
        self.assertEqual(saved["requested_by"], "coding")
        self.assertEqual(
            set(saved), {"id", "action", "args", "requested_at", "requested_by"}
        )

    def test_context_args_pass_through_unchanged(self) -> None:
        inbox = Path(tempfile.mkdtemp()) / "inbox"
        args = {
            "scope": "initiative",
            "id": "5a9c68fe",
            "decision": "dependency:repo:ramunl/ai-dashboard",
            "revision": "2",
        }
        request_id = submit(inbox, "context_approve_v1", dict(args), "coding")
        saved = json.loads((inbox / f"{request_id}.json").read_text())
        self.assertEqual(saved["args"], args)

    def test_snapshots_pass_context_fields_through_unchanged(self) -> None:
        old = {
            "format": 1,
            "updated_at": time.time(),
            "tasks": [{"id": "0a1b2c3d", "stage": "todo"}],
        }
        new = {
            **old,
            "context_recovery_pending": True,
            "initiatives": [{"id": "5a9c68fe", "health": "stale", "packets": []}],
            "tasks": [
                {
                    "id": "0a1b2c3d",
                    "stage": "blocked",
                    "context_status": {"status": "blocked", "reason": "x"},
                }
            ],
        }
        for data in (old, new):
            with self.subTest(format=data["format"]):
                path = Path(tempfile.mkdtemp()) / "snapshot.json"
                path.write_text(json.dumps(data))
                snapshot, problem = read_snapshot(path, CODING_SNAPSHOT_FORMATS)
                self.assertIsNone(problem)
                self.assertEqual(snapshot, data)
        malformed = Path(tempfile.mkdtemp()) / "snapshot.json"
        malformed.write_text("{not json")
        snapshot, problem = read_snapshot(malformed, CODING_SNAPSHOT_FORMATS)
        self.assertIsNone(snapshot)
        self.assertIsNotNone(problem)

    def test_submit_writes_one_complete_request(self) -> None:
        inbox = Path(tempfile.mkdtemp()) / "inbox"
        request_id = submit(inbox, "set_planner", {"value": "claude"}, "coding")
        files = list(inbox.iterdir())
        self.assertEqual([f.name for f in files], [f"{request_id}.json"])
        saved = json.loads(files[0].read_text())
        self.assertEqual(saved["action"], "set_planner")
        self.assertEqual(saved["requested_by"], "coding")
        self.assertRegex(saved["id"], r"^[0-9a-f]{16}$")

    def test_submit_moves_images_into_the_request_upload_folder(self) -> None:
        tmp = Path(tempfile.mkdtemp())
        image = tmp / "0123456789abcdef.png"
        image.write_bytes(b"not parsed")
        inbox = tmp / "inbox"
        args = {"repo": "repo", "text": "x", "todo": "-", "images": "0123456789abcdef"}
        request_id = submit(inbox, "create_task", args, "coding", [image])
        self.assertFalse(image.exists())
        self.assertEqual(
            sorted(f.name for f in inbox.iterdir()), [f"{request_id}.json", "uploads"]
        )
        folder = inbox / "uploads" / request_id
        self.assertEqual([f.name for f in folder.iterdir()], ["1.png"])
        self.assertEqual((folder / "1.png").read_bytes(), b"not parsed")
        saved = json.loads((inbox / f"{request_id}.json").read_text())
        self.assertEqual(saved["args"]["images"], [{"name": "1.png"}])

    def test_submit_sends_no_images_key_without_images(self) -> None:
        inbox = Path(tempfile.mkdtemp()) / "inbox"
        args = {"repo": "repo", "text": "x", "todo": "-", "images": ""}
        request_id = submit(inbox, "create_task", args, "coding")
        saved = json.loads((inbox / f"{request_id}.json").read_text())
        self.assertEqual(saved["args"], {"repo": "repo", "text": "x", "todo": "-"})
        self.assertFalse((inbox / "uploads").exists())

    def test_submit_waits_while_the_agent_has_four_batches(self) -> None:
        tmp = Path(tempfile.mkdtemp())
        inbox = tmp / "inbox"
        for number in range(4):
            (inbox / "uploads" / f"{number:016x}").mkdir(parents=True)
        (inbox / "uploads" / f"{3:016x}" / ".claimed").write_text("")
        image = tmp / "0123456789abcdef.png"
        image.write_bytes(b"x")
        args = {"repo": "repo", "text": "x", "todo": "-", "images": "id"}
        submit(inbox, "create_task", args, "coding", [image])  # 3 waiting: fine
        other = tmp / "fedcba9876543210.png"
        other.write_bytes(b"y")
        with self.assertRaisesRegex(RequestError, "not taken the last images"):
            submit(inbox, "create_task", args, "coding", [other])
        self.assertTrue(other.exists())
        self.assertEqual(len(list(inbox.glob("*.json"))), 1)

    def test_concurrent_submissions_reserve_only_one_batch(self) -> None:
        tmp = Path(tempfile.mkdtemp())
        inbox = tmp / "inbox"
        uploads = inbox / "uploads"
        existing = [f"{number:016x}" for number in range(3)]
        for name in existing:
            (uploads / name).mkdir(parents=True)
        images = {
            "a": tmp / "0123456789abcdef.png",
            "b": tmp / "fedcba9876543210.png",
        }
        for image in images.values():
            image.write_bytes(b"x")

        args = {"repo": "repo", "text": "x", "todo": "-", "images": "id"}
        start = threading.Barrier(2)
        reserve = threading.Barrier(2)
        real_mkdir = Path.mkdir
        results: dict[str, tuple[str, str]] = {}

        def reserve_folder(self: Path, mode=0o777, parents=False, exist_ok=False):
            # The capacity check happens before folder.mkdir, so a thread here
            # has already passed it. Coordinating at the reservation widens the
            # pre-fix race window; after the fix the second thread is behind
            # _MOVE_LOCK, so the first proceeds alone after a bounded wait.
            if self.parent == uploads and _HEX16.match(self.name):
                try:
                    reserve.wait(timeout=5)
                except threading.BrokenBarrierError:
                    pass
            return real_mkdir(self, mode=mode, parents=parents, exist_ok=exist_ok)

        def submit_one(tag: str, image: Path) -> None:
            try:
                start.wait(timeout=5)
            except threading.BrokenBarrierError:
                pass
            try:
                request_id = submit(inbox, "create_task", args, "coding", [image])
                results[tag] = ("ok", request_id)
            except RequestError as exc:
                results[tag] = ("error", str(exc))

        with patch.object(Path, "mkdir", reserve_folder):
            threads = [
                threading.Thread(target=submit_one, args=(tag, images[tag]))
                for tag in images
            ]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join(timeout=15)
            self.assertFalse(any(thread.is_alive() for thread in threads))

        self.assertEqual(set(results), set(images))
        accepted = [value for value in results.values() if value[0] == "ok"]
        refused = [value for value in results.values() if value[0] == "error"]
        self.assertEqual(len(accepted), 1)
        self.assertEqual(len(refused), 1)
        self.assertIn("not taken the last images", refused[0][1])

        unclaimed = [
            path
            for path in uploads.iterdir()
            if path.is_dir() and not (path / ".claimed").exists()
        ]
        self.assertEqual(len(unclaimed), 4)
        for name in existing:
            self.assertTrue((uploads / name).is_dir())
        self.assertEqual(len(list(inbox.glob("*.json"))), 1)

        refused_tag = next(tag for tag, value in results.items() if value[0] == "error")
        accepted_tag = next(tag for tag, value in results.items() if value[0] == "ok")
        self.assertTrue(images[refused_tag].exists())
        self.assertFalse(images[accepted_tag].exists())

    def test_submit_puts_images_back_when_the_request_fails(self) -> None:
        tmp = Path(tempfile.mkdtemp())
        image = tmp / "0123456789abcdef.png"
        image.write_bytes(b"x")
        inbox = tmp / "inbox"
        args = {"repo": "repo", "text": "x", "todo": "-", "images": "id"}
        with patch.object(os, "replace", side_effect=OSError):
            with self.assertRaises(OSError):
                submit(inbox, "create_task", args, "coding", [image])
        self.assertEqual(image.read_bytes(), b"x")
        self.assertEqual(list(inbox.glob("*.json")), [])
        self.assertEqual(list((inbox / "uploads").iterdir()), [])

    def test_staged_images_resolve_ids_in_order_or_not_at_all(self) -> None:
        directory = Path(tempfile.mkdtemp())
        one, two = "0123456789abcdef", "fedcba9876543210"
        (directory / f"{one}.png").write_bytes(b"x")
        (directory / f"{two}.jpg").write_bytes(b"y")
        self.assertEqual(staged_images(directory, ""), [])
        self.assertEqual(
            staged_images(directory, f"{two},{one}"),
            [directory / f"{two}.jpg", directory / f"{one}.png"],
        )
        self.assertIsNone(staged_images(directory, f"{one},{one}"))
        self.assertIsNone(staged_images(directory, "aaaaaaaaaaaaaaaa"))
        self.assertIsNone(staged_images(Path(tempfile.mkdtemp()) / "none", one))

    def test_sweep_deletes_only_what_nobody_took_in_time(self) -> None:
        directory = Path(tempfile.mkdtemp())
        old = directory / "0123456789abcdef.png"
        fresh = directory / "fedcba9876543210.png"
        old.write_bytes(b"x")
        fresh.write_bytes(b"y")
        an_hour_and_a_bit = time.time() - 3700
        os.utime(old, (an_hour_and_a_bit, an_hour_and_a_bit))
        sweep_staged(directory, time.time())
        self.assertFalse(old.exists())
        self.assertTrue(fresh.exists())
        sweep_staged(Path(tempfile.mkdtemp()) / "missing", time.time())


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

    async def test_registry_snapshot_drives_the_action_allowlist(self) -> None:
        (self.tmp / "snapshot.json").write_text(json.dumps(_registry_snapshot()))
        accepted = await self.post({"action": "set_planner", "args": {"value": "gpt"}})
        self.assertEqual(accepted.status, 202)
        refused = await self.post(
            {"action": "set_planner", "args": {"value": "claude"}}
        )
        self.assertEqual(refused.status, 400)
        switch = await self.post(
            {"action": "switch_model", "args": {"tool": "codex", "model": "gpt-5"}}
        )
        self.assertEqual(switch.status, 202)

    async def test_current_setup_snapshot_queues_deepseek_planning_only(self) -> None:
        from tests.test_setup_capabilities import SETUP

        (self.tmp / "snapshot.json").write_text(
            json.dumps({"format": 2, "updated_at": time.time(), "setup": SETUP})
        )
        response = await self.post(
            {"action": "set_planner", "args": {"value": "deepseek"}}
        )
        self.assertEqual(response.status, 202)
        request_id = (await response.json())["id"]
        saved = json.loads((self.inbox / f"{request_id}.json").read_text())
        self.assertEqual(saved["args"], {"value": "deepseek"})
        response = await self.post(
            {"action": "set_implementer", "args": {"value": "deepseek"}}
        )
        self.assertEqual(response.status, 400)

    async def test_malformed_registry_snapshot_keeps_legacy_allowlist(self) -> None:
        snapshot = _registry_snapshot()
        snapshot["registry"]["tools"]["gpt"]["manageable"] = "no"
        (self.tmp / "snapshot.json").write_text(json.dumps(snapshot))
        accepted = await self.post(
            {"action": "set_planner", "args": {"value": "codex"}}
        )
        self.assertEqual(accepted.status, 202)
        refused = await self.post({"action": "set_planner", "args": {"value": "gpt"}})
        self.assertEqual(refused.status, 400)

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
        for path in (
            "/coding/projects",
            "/coding/ai",
            "/coding/logs",
            "/tasks/group?group=g",
        ):
            self.assertEqual((await self.client.get(path)).status, 200, path)
        self.assertEqual((await self.client.get("/coding/nope")).status, 404)
        self.assertEqual((await self.client.get("/pm/projects")).status, 404)


class ReconcileActionTests(unittest.TestCase):
    def test_blockage_resolution_accepts_only_a_task_id(self):
        check({"action": "resolve_task_blockage", "args": {"task": "0a1b2c3d"}})
        for args in ({}, {"task": "bad"}, {"task": "0a1b2c3d", "run": "78"}):
            with self.assertRaises(RequestError):
                check({"action": "resolve_task_blockage", "args": args})

    def test_completion_review_accepts_only_a_task_id(self):
        check({"action": "reconcile_task", "args": {"task": "0a1b2c3d"}})
        for args in (
            {},
            {"task": "invalid"},
            {"task": "0a1b2c3d", "pr_url": "https://example.org"},
        ):
            with self.assertRaises(RequestError):
                check({"action": "reconcile_task", "args": args})
