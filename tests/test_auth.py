import json
import time
import unittest

from ai_dashboard.auth import InitDataError, sign_init_data, verify_init_data

TOKENS = {"coding": "111:CODING", "pm": "222:PM"}
OWNER = 777


def _signed(token: str, user_id: int = OWNER, auth_date: int | None = None) -> str:
    fields = {
        "auth_date": str(int(time.time()) if auth_date is None else auth_date),
        "user": json.dumps({"id": user_id, "first_name": "Roman"}),
    }
    return sign_init_data(fields, token)


class VerifyTests(unittest.TestCase):
    def test_identifies_which_bot_opened_it(self) -> None:
        self.assertEqual(
            verify_init_data(_signed("111:CODING"), TOKENS, OWNER).bot, "coding"
        )
        self.assertEqual(verify_init_data(_signed("222:PM"), TOKENS, OWNER).bot, "pm")

    def _rejects(self, init_data: str, reason: str, status: int = 401) -> None:
        with self.assertRaises(InitDataError) as caught:
            verify_init_data(init_data, TOKENS, OWNER)
        self.assertIn(reason, caught.exception.reason)
        self.assertEqual(caught.exception.status, status)

    def test_rejects_unknown_bot(self) -> None:
        self._rejects(_signed("999:STRANGER"), "invalid signature")

    def test_rejects_tampering(self) -> None:
        self._rejects(
            _signed("111:CODING").replace("Roman", "Mallory"), "invalid signature"
        )

    def test_rejects_other_user(self) -> None:
        self._rejects(_signed("111:CODING", user_id=1), "not the bot owner", status=403)

    def test_rejects_stale(self) -> None:
        old = int(time.time()) - 2 * 86400
        self._rejects(_signed("111:CODING", auth_date=old), "expired")

    def test_rejects_missing_and_malformed(self) -> None:
        self._rejects("", "missing")
        self._rejects("a=b=c&&", "malformed")

    def test_empty_token_never_matches(self) -> None:
        with self.assertRaises(InitDataError):
            verify_init_data(_signed(""), {"broken": ""}, OWNER)
