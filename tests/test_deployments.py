"""Deployment bridge safety and public status contract."""

import asyncio
import unittest
from unittest.mock import AsyncMock, patch

from ai_dashboard.deployments import (
    DeploymentService,
    deployment_state,
    invoke_deployment,
)

COMMIT = "a" * 40
STATE = {
    "targets": [
        {
            "name": "ai-pm-agent",
            "status": "healthy",
            "current": {"commit": "b" * 40},
            "previous": {
                "commit": COMMIT,
                "version": "v1",
                "verified_at": "2026-10-02T11:00:00+00:00",
            },
        }
    ]
}


class DeploymentTests(unittest.IsolatedAsyncioTestCase):
    async def test_missing_manager_explains_installation(self):
        result = await invoke_deployment("/missing/ai-deploy", "status")
        self.assertFalse(result["ok"])
        self.assertIn("not installed", result["error"])

    async def test_cached_reads_do_not_invoke_twice(self):
        service = DeploymentService("ai-deploy")
        with patch(
            "ai_dashboard.deployments.invoke_deployment", AsyncMock(return_value=STATE)
        ) as invoke:
            await asyncio.gather(service.state(), service.state())
            await asyncio.sleep(0)  # let the background "latest main" read run
            modes = [call.args[1] for call in invoke.await_args_list]
            self.assertEqual(modes.count("status"), 1)
            self.assertEqual(modes.count("remote"), 1)

    async def test_stale_confirmation_never_submits(self):
        service = DeploymentService("ai-deploy")
        with patch(
            "ai_dashboard.deployments.invoke_deployment", AsyncMock(return_value=STATE)
        ) as invoke:
            result = await service.rollback("ai-pm-agent", "oldcommit")
            self.assertTrue(result["conflict"])
            self.assertEqual(invoke.await_count, 1)

    async def test_busy_operation_never_submits(self):
        state = {"targets": [{**STATE["targets"][0], "status": "queued"}]}
        with patch(
            "ai_dashboard.deployments.invoke_deployment", AsyncMock(return_value=state)
        ) as invoke:
            result = await DeploymentService("ai-deploy").rollback(
                "ai-pm-agent", COMMIT
            )
            self.assertTrue(result["conflict"])
            self.assertEqual(invoke.await_count, 1)

    async def test_submission_checks_commit_inside_manager(self):
        with patch(
            "ai_dashboard.deployments.invoke_deployment",
            AsyncMock(side_effect=[STATE, {"status": "queued"}]),
        ) as invoke:
            result = await DeploymentService("ai-deploy").rollback(
                "ai-pm-agent", COMMIT
            )
            self.assertTrue(result["ok"])
            invoke.assert_awaited_with(
                "ai-deploy",
                "submit",
                "rollback",
                "ai-pm-agent",
                "--expected-commit",
                COMMIT,
            )

    async def test_manager_conflict_is_not_success(self):
        with patch(
            "ai_dashboard.deployments.invoke_deployment",
            AsyncMock(side_effect=[STATE, {"error": "Operation already active"}]),
        ):
            result = await DeploymentService("ai-deploy").rollback(
                "ai-pm-agent", COMMIT
            )
            self.assertFalse(result["ok"])
            self.assertIn("already active", result["error"])

    def test_status_does_not_publish_configuration_or_logs(self):
        target = {
            **STATE["targets"][0],
            "history": [{"token": "secret"}],
            "config": "secret",
        }
        result = deployment_state({"targets": [target, {"name": "arbitrary"}]})
        self.assertEqual(len(result["targets"]), 1)
        self.assertNotIn("secret", str(result))

    def test_iso_verification_timestamp_survives_public_status(self):
        result = deployment_state(STATE)
        self.assertEqual(
            result["targets"][0]["previous"]["verified_at"],
            "2026-10-02T11:00:00+00:00",
        )

    def test_malformed_fields_cannot_break_render_or_claim_verification(self):
        target = {
            "name": "ai-pm-agent",
            "status": {},
            "error": {"token": "secret"},
            "current": {"commit": {"token": "secret"}},
            "previous": {
                "commit": COMMIT,
                "version": {"token": "secret"},
                "verified_at": "not a timestamp",
            },
        }
        result = deployment_state({"targets": [target]})["targets"][0]
        self.assertEqual(result["status"], "untracked")
        self.assertIsNone(result["current"])
        self.assertIsNone(result["previous"]["verified_at"])
        self.assertNotIn("secret", str(result))

    async def test_deploy_submits_only_the_fixed_ref(self):
        queued = AsyncMock(side_effect=[STATE, {"status": "queued"}])
        with patch("ai_dashboard.deployments.invoke_deployment", queued) as invoke:
            result = await DeploymentService("ai-deploy").deploy("ai-pm-agent")
        self.assertEqual(
            result, {"ok": True, "target": "ai-pm-agent", "status": "queued"}
        )
        self.assertEqual(
            invoke.await_args.args,
            ("ai-deploy", "submit", "deploy", "ai-pm-agent", "main"),
        )

    async def test_deploy_never_submits_while_an_operation_runs(self):
        state = {"targets": [{**STATE["targets"][0], "status": "deploying"}]}
        with patch(
            "ai_dashboard.deployments.invoke_deployment", AsyncMock(return_value=state)
        ) as invoke:
            result = await DeploymentService("ai-deploy").deploy("ai-pm-agent")
        self.assertTrue(result["conflict"])
        self.assertEqual(invoke.await_count, 1)

    async def test_deploy_reports_a_refused_submission(self):
        refused = AsyncMock(side_effect=[STATE, {"error": "Tests failed"}])
        with patch("ai_dashboard.deployments.invoke_deployment", refused):
            result = await DeploymentService("ai-deploy").deploy("ai-pm-agent")
        self.assertEqual(result["error"], "Tests failed")

    async def test_latest_main_is_read_in_the_background_and_compared(self):
        status = {
            "targets": [
                {
                    "name": "ai-pm-agent",
                    "status": "healthy",
                    "current": {"commit": "a" * 40},
                },
                {
                    "name": "ai-dashboard",
                    "status": "healthy",
                    "current": {"commit": "c" * 40},
                },
            ]
        }
        remote = {
            "targets": [
                {"name": "ai-pm-agent", "main": "b" * 40, "error": None},
                {
                    "name": "ai-dashboard",
                    "main": None,
                    "error": "fatal: https://token@x",
                },
                {"name": "/etc/passwd", "main": "d" * 40, "error": None},
            ]
        }

        async def fake(command, mode, timeout=10):
            return status if mode == "status" else remote

        service = DeploymentService("ai-deploy")
        with patch("ai_dashboard.deployments.invoke_deployment", fake):
            first = await service.state()
            self.assertIsNone(first["targets"][0]["latest"])  # not read yet
            await asyncio.sleep(0.01)
            targets = (await service.state(force=True))["targets"]
        self.assertEqual(targets[0]["latest"], "b" * 40)
        self.assertIsNone(targets[0]["latest_error"])
        self.assertIsNone(targets[1]["latest"])
        self.assertEqual(targets[1]["latest_error"], "Could not check GitHub")
        await service.close()

    async def test_an_older_manager_without_remote_still_offers_deploys(self):
        async def fake(command, mode, timeout=10):
            if mode == "status":
                return {"targets": [{"name": "ai-pm-agent", "status": "healthy"}]}
            return {
                "ok": False,
                "error": "Deployment manager returned an unreadable response",
            }

        service = DeploymentService("ai-deploy")
        with patch("ai_dashboard.deployments.invoke_deployment", fake):
            await service.state()
            await asyncio.sleep(0.01)
            target = (await service.state(force=True))["targets"][0]
        self.assertEqual((target["latest"], target["latest_error"]), (None, None))
