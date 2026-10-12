"""Owner-triggered encrypted backups and delivery through the Ops bot."""

import asyncio
import contextlib
from pathlib import Path

import aiohttp
from aiohttp import web

from ai_dashboard.auth import InitDataError, verify_init_data
from ai_dashboard.config import Settings
from ai_dashboard.maintenance import invoke
from ai_dashboard.saved_checks import SavedChecks

COMMAND = "/usr/local/sbin/ai-backup"
BACKUPS = web.AppKey("backups", object)
HEADERS = {"Cache-Control": "no-store"}


async def deliver(settings: Settings, result: dict) -> bool:
    """Send only a generated encrypted archive to the configured owner."""
    bot = settings.bot("ops")
    path = Path(result.get("file", "")).resolve()
    root = Path("/var/backups/ai-agents")
    if not bot or path.parent != root or not path.name.endswith(".tar.gz.enc"):
        return False
    try:
        with path.open("rb") as document:
            form = aiohttp.FormData()
            form.add_field("chat_id", str(settings.owner_id))
            form.add_field(
                "caption", "Encrypted backup created from the Ops dashboard."
            )
            form.add_field("document", document, filename=path.name)
            async with aiohttp.ClientSession(
                timeout=aiohttp.ClientTimeout(total=90)
            ) as session:
                async with session.post(
                    f"https://api.telegram.org/bot{bot.token}/sendDocument", data=form
                ) as response:
                    data = await response.json(content_type=None)
                    return response.status == 200 and data.get("ok") is True
    except (OSError, aiohttp.ClientError, TimeoutError, ValueError):
        return False


class BackupService:
    """Track one dashboard run while reading persisted CLI backup status."""

    def __init__(self, settings: Settings) -> None:
        """Restore the dashboard delivery result."""
        self.settings = settings
        self.saved = SavedChecks(settings.state_dir / "backup-delivery.json")
        self.delivery = self.saved.get("backups", "delivery")
        self.running = False
        self.task: asyncio.Task | None = None

    async def state(self) -> dict:
        """Read backup metadata only; never expose keys or archive contents."""
        report = await invoke(COMMAND, "status", 10, "ai-backup")
        return {**report, "running": self.running, "delivery": self.delivery}

    def start(self) -> bool:
        """Start a single backup and delivery operation."""
        if self.running:
            return False
        self.running = True
        self.task = asyncio.create_task(self.run())
        return True

    async def run(self) -> None:
        """Keep creation and delivery failures distinct."""
        try:
            result = await invoke(COMMAND, "run", 300, "ai-backup")
            sent = await deliver(self.settings, result) if result.get("ok") else False
            self.delivery = {
                "ok": sent,
                "at": result.get("at"),
                "message": "Sent to Ops bot chat"
                if sent
                else (
                    "Backup saved, but Telegram delivery failed. "
                    "Try /backup in Ops chat."
                    if result.get("ok")
                    else result.get("error", "Backup failed")
                ),
            }
            self.saved.put("backups", {"delivery": self.delivery})
        finally:
            self.running = False

    async def close(self) -> None:
        """Cancel an in-flight operation on shutdown."""
        if self.task:
            self.task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self.task


def register_backups(app: web.Application, settings: Settings) -> None:
    """Register a signed, owner-only POST with no caller-supplied options."""
    service = BackupService(settings)
    app[BACKUPS] = service

    async def action(request: web.Request) -> web.Response:
        header = request.headers.get("Authorization", "")
        try:
            verify_init_data(
                header[4:].strip() if header.lower().startswith("tma ") else "",
                settings.tokens(),
                settings.owner_id,
            )
        except InitDataError as error:
            return web.json_response(
                {"error": error.reason}, status=error.status, headers=HEADERS
            )
        if await request.read():
            return web.json_response(
                {"error": "Backup accepts no options"}, status=400, headers=HEADERS
            )
        if not settings.bot("ops"):
            return web.json_response(
                {"error": "Ops bot is not configured"}, status=503, headers=HEADERS
            )
        if not service.start():
            return web.json_response(
                {"error": "A backup is already running"}, status=409, headers=HEADERS
            )
        return web.json_response({"started": True}, status=202, headers=HEADERS)

    async def close(_app: web.Application) -> None:
        await service.close()

    app.router.add_post("/api/ops/backup", action)
    app.on_cleanup.append(close)
