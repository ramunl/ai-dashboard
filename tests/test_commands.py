"""Verify subprocess failures remain unknown and interrupted children are reaped."""

import asyncio
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

from ai_dashboard import commands, health, sources


class CommandTests(unittest.IsolatedAsyncioTestCase):
    async def test_success_returns_decoded_output(self):
        process = SimpleNamespace(
            returncode=0, communicate=AsyncMock(return_value=(b"active\n", b""))
        )
        with patch.object(
            commands.asyncio, "create_subprocess_exec", return_value=process
        ):
            self.assertEqual(await commands.run_command("status"), "active\n")

    async def test_nonzero_journal_exit_is_unknown_not_zero_errors(self):
        health._error_cache.clear()
        process = SimpleNamespace(
            returncode=1, communicate=AsyncMock(return_value=(b"", b""))
        )
        with patch.object(
            commands.asyncio, "create_subprocess_exec", return_value=process
        ):
            self.assertIsNone(await health.recent_errors("test-unit", now=0))

    async def test_inactive_service_exit_code_retains_state(self):
        process = SimpleNamespace(
            returncode=3, communicate=AsyncMock(return_value=(b"inactive\n", b""))
        )
        with patch.object(
            commands.asyncio, "create_subprocess_exec", return_value=process
        ):
            self.assertEqual(await sources.service_state("test-unit"), "inactive")

    async def test_failed_command_start_is_logged(self):
        with (
            patch.object(
                commands.asyncio, "create_subprocess_exec", side_effect=OSError
            ),
            self.assertLogs("ai_dashboard.commands", level="WARNING") as logs,
        ):
            self.assertIsNone(await commands.run_command("missing-command"))
        self.assertIn("Could not start missing-command", "\n".join(logs.output))

    async def test_timeout_kills_and_reaps_child(self):
        process = SimpleNamespace(
            returncode=None,
            kill=Mock(),
            communicate=AsyncMock(side_effect=[TimeoutError, (b"", b"")]),
        )
        with patch.object(
            commands.asyncio, "create_subprocess_exec", return_value=process
        ):
            self.assertIsNone(await commands.run_command("slow-command"))
        process.kill.assert_called_once_with()
        self.assertEqual(process.communicate.await_count, 2)

    async def test_cancellation_kills_and_reaps_child_then_propagates(self):
        process = SimpleNamespace(
            returncode=None,
            kill=Mock(),
            communicate=AsyncMock(side_effect=[asyncio.CancelledError, (b"", b"")]),
        )
        with (
            patch.object(
                commands.asyncio, "create_subprocess_exec", return_value=process
            ),
            self.assertRaises(asyncio.CancelledError),
        ):
            await commands.run_command("cancelled-command")
        process.kill.assert_called_once_with()
        self.assertEqual(process.communicate.await_count, 2)

    async def test_process_exiting_during_timeout_cleanup_is_still_reaped(self):
        process = SimpleNamespace(
            returncode=None,
            kill=Mock(side_effect=ProcessLookupError),
            communicate=AsyncMock(side_effect=[TimeoutError, (b"", b"")]),
        )
        with patch.object(
            commands.asyncio, "create_subprocess_exec", return_value=process
        ):
            self.assertIsNone(await commands.run_command("exiting-command"))
        self.assertEqual(process.communicate.await_count, 2)
