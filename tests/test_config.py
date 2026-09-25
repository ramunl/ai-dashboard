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
