import tempfile
import unittest
from pathlib import Path

from ai_dashboard.config import ConfigError, load_settings
from ai_dashboard.envfile import read_env_file


def _env_file(text: str) -> str:
    path = Path(tempfile.mkdtemp()) / "coding.env"
    path.write_text(text)
    return str(path)


BASE = 'TELEGRAM_BOT_TOKEN="111:A"\nYOUR_CHAT_ID=777\n'


class EnvFileTests(unittest.TestCase):
    def test_parses_systemd_style_file(self) -> None:
        path = _env_file(
            "# comment\n\nexport A=1\nB='two words'\nC=\"x=y\"\n  D = spaced \nno_equals\n"
        )
        self.assertEqual(
            read_env_file(Path(path)),
            {"A": "1", "B": "two words", "C": "x=y", "D": "spaced"},
        )

    def test_missing_file_is_empty(self) -> None:
        self.assertEqual(read_env_file(Path("/nonexistent/file.env")), {})


class SettingsTests(unittest.TestCase):
    def _load(self, env_text: str = BASE, **overrides: str):
        environ = {
            "DASHBOARD_PUBLIC_URL": "https://1-2-3-4.sslip.io:8443/",
            "CODING_ENV_FILE": _env_file(env_text),
            # hermetic: never read a real /etc/ai-ops-agent.env
            "OPS_ENV_FILE": "/nonexistent/ai-ops-agent.env",
            "PM_ENV_FILE": "/nonexistent/ai-pm-agent.env",
            **overrides,
        }
        return load_settings(environ)

    def test_reads_token_and_owner_from_agent_env_file(self) -> None:
        settings = self._load()
        self.assertEqual(settings.tokens(), {"coding": "111:A"})
        self.assertEqual(settings.owner_id, 777)
        self.assertEqual(settings.public_url, "https://1-2-3-4.sslip.io:8443")
        self.assertEqual(settings.port, 8787)

    def test_snapshot_path_follows_agent_setting(self) -> None:
        settings = self._load(BASE + "AGENT_SNAPSHOT_FILE=/tmp/x/snap.json\n")
        self.assertEqual(str(settings.bot("coding").snapshot_file), "/tmp/x/snap.json")

    def test_rejects_plain_http(self) -> None:
        with self.assertRaisesRegex(ConfigError, "https"):
            self._load(DASHBOARD_PUBLIC_URL="http://1-2-3-4.sslip.io")

    def test_rejects_missing_token(self) -> None:
        with self.assertRaisesRegex(ConfigError, "TELEGRAM_BOT_TOKEN"):
            self._load("YOUR_CHAT_ID=777\n")

    def test_rejects_group_or_missing_chat_id(self) -> None:
        for chat in ("-100123", "0", "", "abc"):
            with self.assertRaisesRegex(ConfigError, "private"):
                self._load(f"TELEGRAM_BOT_TOKEN=1:A\nYOUR_CHAT_ID={chat}\n")

    def test_rejects_bad_port(self) -> None:
        for port in ("0", "70000", "http"):
            with self.assertRaisesRegex(ConfigError, "DASHBOARD_PORT"):
                self._load(DASHBOARD_PORT=port)


class MultiBotTests(SettingsTests):
    def test_ops_bot_joins_when_its_env_file_exists(self) -> None:
        ops = _env_file('OPS_TELEGRAM_BOT_TOKEN="222:OPS"\nYOUR_CHAT_ID=777\n')
        settings = self._load(OPS_ENV_FILE=ops)
        self.assertEqual(settings.tokens(), {"coding": "111:A", "ops": "222:OPS"})
        self.assertEqual(settings.bot("ops").menu_path, "")
        self.assertEqual(settings.bot("coding").menu_path, "coding")

    def test_missing_ops_env_file_is_skipped(self) -> None:
        self.assertEqual(list(self._load().tokens()), ["coding"])

    def test_ops_env_file_without_token_is_an_error(self) -> None:
        with self.assertRaisesRegex(ConfigError, "OPS_TELEGRAM_BOT_TOKEN"):
            self._load(OPS_ENV_FILE=_env_file("YOUR_CHAT_ID=777\n"))

    def test_owner_must_match_across_bots(self) -> None:
        ops = _env_file("OPS_TELEGRAM_BOT_TOKEN=2:B\nYOUR_CHAT_ID=999\n")
        with self.assertRaisesRegex(ConfigError, "differs between bots"):
            self._load(OPS_ENV_FILE=ops)

    def test_monitored_services(self) -> None:
        self.assertEqual(
            self._load().monitored_services,
            ("ai-coding-agent", "ai-pm-agent", "ai-ops-agent"),
        )
        custom = self._load(MONITORED_SERVICES=" a , b,,")
        self.assertEqual(custom.monitored_services, ("a", "b"))


class PmBotTests(SettingsTests):
    def test_pm_bot_with_default_snapshot_path(self) -> None:
        pm = _env_file('PM_TELEGRAM_BOT_TOKEN="333:PM"\nYOUR_CHAT_ID=777\n')
        bot = self._load(PM_ENV_FILE=pm).bot("pm")
        self.assertEqual(
            (bot.token, bot.menu_path, bot.service), ("333:PM", "pm", "ai-pm-agent")
        )
        self.assertEqual(str(bot.snapshot_file), "/var/lib/ai-pm-agent/snapshot.json")

    def test_pm_snapshot_path_follows_agent_setting(self) -> None:
        pm = _env_file(
            "PM_TELEGRAM_BOT_TOKEN=3:P\nYOUR_CHAT_ID=777\nPM_SNAPSHOT_FILE=/x/pm.json\n"
        )
        self.assertEqual(
            str(self._load(PM_ENV_FILE=pm).bot("pm").snapshot_file), "/x/pm.json"
        )

    def test_ops_has_no_snapshot(self) -> None:
        ops = _env_file("OPS_TELEGRAM_BOT_TOKEN=2:O\nYOUR_CHAT_ID=777\n")
        self.assertIsNone(self._load(OPS_ENV_FILE=ops).bot("ops").snapshot_file)
