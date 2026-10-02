"""Disk usage history and the growth trend shown on the overview."""

import asyncio
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from ai_dashboard import disk_history
from ai_dashboard.disk_history import add_sample, load_samples, save_samples, trend
from ai_dashboard.problems import compute_problems

GB = 1024**3
HOUR = 3600


def _linear(start_gb: float, end_gb: float, hours: int) -> list[tuple[float, int]]:
    return [
        (h * HOUR, int((start_gb + (end_gb - start_gb) * h / hours) * GB))
        for h in range(hours + 1)
    ]


class TrendTests(unittest.TestCase):
    def test_real_server_numbers(self) -> None:
        # 11.7 GB -> 14.5 GB over 5 days on a 23.2 GB disk (observed on the VPS).
        samples = _linear(11.7, 14.5, 120)
        result = trend(samples, int(23.2 * GB), now=120 * HOUR)
        self.assertAlmostEqual(result["bytes_per_day"] / GB, 0.56, places=2)
        self.assertAlmostEqual(result["days_until_full"], 15.5, places=1)

    def test_needs_enough_history(self) -> None:
        self.assertIsNone(trend(_linear(10, 11, 4), 20 * GB, now=4 * HOUR))
        self.assertIsNone(trend([(0, GB), (7 * HOUR, 2 * GB)], 20 * GB, now=7 * HOUR))

    def test_shrinking_disk_never_fills(self) -> None:
        result = trend(_linear(14, 12, 24), 20 * GB, now=24 * HOUR)
        self.assertLess(result["bytes_per_day"], 0)
        self.assertIsNone(result["days_until_full"])

    def test_only_recent_window_counts(self) -> None:
        # Fast growth a week ago, flat for the last 3 days: trend follows the recent part.
        old = _linear(5, 15, 96)
        recent = [(96 * HOUR + h * HOUR, 15 * GB) for h in range(1, 73)]
        result = trend(old + recent, 20 * GB, now=168 * HOUR)
        self.assertAlmostEqual(result["bytes_per_day"] / GB, 0.0, places=2)


class SampleTests(unittest.TestCase):
    def test_one_sample_per_hour_and_pruned_after_14_days(self) -> None:
        samples = add_sample([], 0, 1)
        samples = add_sample(samples, 600, 2)  # too soon, ignored
        self.assertEqual(samples, [(0, 1)])
        samples = add_sample(samples, HOUR, 3)
        self.assertEqual(len(samples), 2)
        samples = add_sample(samples, 15 * 86400, 4)
        self.assertEqual(samples, [(15 * 86400, 4)])

    def test_save_and_load_roundtrip(self) -> None:
        path = Path(tempfile.mkdtemp()) / "sub" / "disk.json"
        self.assertTrue(save_samples(path, [(1.0, 10), (2.0, 20)]))
        self.assertEqual(load_samples(path), [(1.0, 10), (2.0, 20)])
        self.assertEqual([p.name for p in path.parent.iterdir()], ["disk.json"])

    def test_missing_or_corrupt_file_starts_fresh(self) -> None:
        path = Path(tempfile.mkdtemp()) / "disk.json"
        self.assertEqual(load_samples(path), [])
        path.write_text("{ nope")
        self.assertEqual(load_samples(path), [])
        path.write_text(json.dumps({"samples": [["x", "y"]]}))
        self.assertEqual(load_samples(path), [])


class RecorderTests(unittest.TestCase):
    def test_records_and_survives_a_failed_reading(self) -> None:
        path = Path(tempfile.mkdtemp()) / "disk.json"
        calls = {"n": 0}
        real = disk_history.shutil.disk_usage

        def flaky(disk_path: str):
            calls["n"] += 1
            if calls["n"] == 1:
                raise OSError("transient")
            return real(disk_path)

        async def run() -> None:
            with (
                patch.object(disk_history.shutil, "disk_usage", side_effect=flaky),
                patch.object(
                    disk_history,
                    "add_sample",
                    side_effect=lambda s, now, used: s + [(now, used)],
                ),
            ):
                task = asyncio.create_task(
                    disk_history.record_forever(path, interval=0.01)
                )
                for _ in range(200):
                    if path.exists():
                        break
                    await asyncio.sleep(0.01)
                task.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await task

        asyncio.run(run())
        self.assertGreaterEqual(calls["n"], 2)
        self.assertTrue(load_samples(path))


class TrendProblemTests(unittest.TestCase):
    def _problems(self, days: float | None, span_hours: float = 72) -> list[dict]:
        trend_value = (
            None
            if days is None
            else {
                "bytes_per_day": 0.5 * GB,
                "days_until_full": days,
                "span_hours": span_hours,
            }
        )
        resources = {
            "disk": {"total": 100, "used": 10, "free": 90, "trend": trend_value},
            "memory": {"total": 1, "available": 1},
            "load": [0, 0, 0],
            "cpus": 1,
        }
        return compute_problems(resources, [], [])

    def test_thresholds_with_enough_history(self) -> None:
        self.assertEqual(self._problems(None), [])
        self.assertEqual(self._problems(45), [])
        self.assertEqual(
            self._problems(16),
            [
                {
                    "severity": "warning",
                    "text": "Disk grows 0.5 GB/day: full in ~16 days",
                }
            ],
        )
        self.assertEqual(self._problems(5)[0]["severity"], "error")

    def test_a_few_hours_of_data_raise_nothing(self) -> None:
        # The case seen on the server: 7 h after deploy, "full in ~6 days".
        self.assertEqual(self._problems(6, span_hours=7), [])

    def test_one_day_of_data_warns_but_never_errors(self) -> None:
        self.assertEqual(self._problems(5, span_hours=30)[0]["severity"], "warning")


if __name__ == "__main__":
    unittest.main()
