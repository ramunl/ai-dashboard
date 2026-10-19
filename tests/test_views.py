"""The launcher's Disk row: task image storage from the coding agent's snapshot."""

import unittest

from ai_dashboard.config import BotSource
from ai_dashboard.views import image_storage

CODING = BotSource("coding", "1:A", "ai-coding-agent", "coding")
PM = BotSource("pm", "2:B", "ai-pm-agent", "pm")
UPDATED_AT = 1792145939
UNKNOWN = {"used_bytes": None, "cap_bytes": None, "updated_at": None}


def coding_view(images: object) -> dict:
    return {"snapshot": {"images": images, "updated_at": UPDATED_AT}}


class ImageStorageTests(unittest.TestCase):
    def test_unknown_when_no_coding_agent_is_configured(self) -> None:
        view = coding_view({"used_bytes": 1024, "cap_bytes": 4096})
        self.assertEqual(image_storage([PM], [view]), UNKNOWN)
        self.assertEqual(image_storage([], []), UNKNOWN)

    def test_unknown_when_the_coding_agent_has_no_data(self) -> None:
        self.assertEqual(image_storage([CODING], [None]), UNKNOWN)
        self.assertEqual(image_storage([CODING], [{"snapshot": None}]), UNKNOWN)

    def test_unknown_when_the_snapshot_lacks_images(self) -> None:
        missing = {"snapshot": {"updated_at": UPDATED_AT}}
        self.assertEqual(image_storage([CODING], [missing]), UNKNOWN)
        self.assertEqual(
            image_storage([CODING], [{"snapshot": {"images": None}}]), UNKNOWN
        )

    def test_unknown_when_the_cap_is_not_positive(self) -> None:
        for cap in (0, -1):
            with self.subTest(cap=cap):
                view = coding_view({"used_bytes": 0, "cap_bytes": cap})
                self.assertEqual(image_storage([CODING], [view]), UNKNOWN)

    def test_unknown_when_the_used_figure_is_negative(self) -> None:
        view = coding_view({"used_bytes": -1, "cap_bytes": 4096})
        self.assertEqual(image_storage([CODING], [view]), UNKNOWN)

    def test_unknown_when_a_figure_is_not_an_int(self) -> None:
        for value in ("1024", None, [1024], {"bytes": 1024}):
            with self.subTest(value=value):
                used = coding_view({"used_bytes": value, "cap_bytes": 4096})
                cap = coding_view({"used_bytes": 1024, "cap_bytes": value})
                self.assertEqual(image_storage([CODING], [used]), UNKNOWN)
                self.assertEqual(image_storage([CODING], [cap]), UNKNOWN)

    def test_unknown_for_floats_so_no_nan_reaches_the_row(self) -> None:
        for value in (float("nan"), float("inf"), float("-inf"), 1024.0, 1024.5):
            with self.subTest(value=value):
                used = coding_view({"used_bytes": value, "cap_bytes": 4096})
                cap = coding_view({"used_bytes": 1024, "cap_bytes": value})
                self.assertEqual(image_storage([CODING], [used]), UNKNOWN)
                self.assertEqual(image_storage([CODING], [cap]), UNKNOWN)

    def test_unknown_for_bools_though_bool_is_an_int_subclass(self) -> None:
        for value in (True, False):
            with self.subTest(value=value):
                used = coding_view({"used_bytes": value, "cap_bytes": 4096})
                cap = coding_view({"used_bytes": 0, "cap_bytes": value})
                self.assertEqual(image_storage([CODING], [used]), UNKNOWN)
                self.assertEqual(image_storage([CODING], [cap]), UNKNOWN)

    def test_valid_snapshot_gives_the_exact_row_figures(self) -> None:
        view = coding_view({"used_bytes": 1024, "cap_bytes": 4096})
        self.assertEqual(
            image_storage([PM, CODING], [{"snapshot": {}}, view]),
            {"used_bytes": 1024, "cap_bytes": 4096, "updated_at": UPDATED_AT},
        )

    def test_valid_zero_use_without_a_timestamp(self) -> None:
        view = {"snapshot": {"images": {"used_bytes": 0, "cap_bytes": 1}}}
        self.assertEqual(
            image_storage([CODING], [view]),
            {"used_bytes": 0, "cap_bytes": 1, "updated_at": None},
        )
