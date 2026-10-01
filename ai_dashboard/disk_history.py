"""Disk usage history and growth trend for the overview window.

A single reading ("63% used") hides the thing that matters on a small server:
how fast the disk is filling. The dashboard records usage once an hour and
reports growth per day and the time until the disk is full.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import shutil
import tempfile
import time
from pathlib import Path

logger = logging.getLogger(__name__)

SAMPLE_INTERVAL_SECONDS = 3600
KEEP_SECONDS = 14 * 86400
# Recent enough to follow a cleanup, long enough to smooth daily noise.
TREND_WINDOW_SECONDS = 3 * 86400
MIN_TREND_SPAN_SECONDS = 6 * 3600
MIN_TREND_SAMPLES = 3
Sample = tuple[float, int]


def load_samples(path: Path) -> list[Sample]:
    """Read saved samples; a missing or corrupt file starts a fresh history."""
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
        return [(float(when), int(used)) for when, used in raw["samples"]]
    except FileNotFoundError:
        return []
    except (OSError, ValueError, KeyError, TypeError) as error:
        logger.warning("Disk history %s unreadable, starting fresh: %s", path, error)
        return []


def save_samples(path: Path, samples: list[Sample]) -> bool:
    """Write samples atomically (temp file + rename); log and return False on error."""
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".disk-", suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump({"samples": samples}, handle)
            os.replace(tmp, path)
        except BaseException:
            with contextlib.suppress(OSError):
                os.unlink(tmp)
            raise
    except OSError as error:
        logger.error("Could not save disk history to %s: %s", path, error)
        return False
    return True


def add_sample(samples: list[Sample], now: float, used: int) -> list[Sample]:
    """Append a reading unless one was taken recently; drop readings past KEEP."""
    kept = [sample for sample in samples if now - sample[0] <= KEEP_SECONDS]
    last = kept[-1][0] if kept else None
    is_due = last is None or now - last >= 0.9 * SAMPLE_INTERVAL_SECONDS
    if is_due:
        kept.append((now, used))
    return kept


def trend(samples: list[Sample], total: int, now: float) -> dict | None:
    """Growth per day (least-squares over the recent window) and days until full.

    None until there is enough history to say anything honest.
    """
    recent = [sample for sample in samples if now - sample[0] <= TREND_WINDOW_SECONDS]
    has_history = (
        len(recent) >= MIN_TREND_SAMPLES
        and recent[-1][0] - recent[0][0] >= MIN_TREND_SPAN_SECONDS
    )
    if not has_history:
        return None
    mean_t = sum(when for when, _ in recent) / len(recent)
    mean_u = sum(used for _, used in recent) / len(recent)
    spread = sum((when - mean_t) ** 2 for when, _ in recent)
    slope = sum((when - mean_t) * (used - mean_u) for when, used in recent) / spread
    per_day = slope * 86400
    latest_used = recent[-1][1]
    days_until_full = (total - latest_used) / per_day if per_day > 0 else None
    return {
        "bytes_per_day": per_day,
        "days_until_full": days_until_full,
        "span_hours": (recent[-1][0] - recent[0][0]) / 3600,
    }


async def record_forever(
    path: Path, disk_path: str = "/", interval: float = SAMPLE_INTERVAL_SECONDS
) -> None:
    """Take a reading now and then every interval, until cancelled."""
    samples = await asyncio.to_thread(load_samples, path)
    while True:
        try:
            used = (await asyncio.to_thread(shutil.disk_usage, disk_path)).used
            samples = add_sample(samples, time.time(), used)
            await asyncio.to_thread(save_samples, path, samples)
        except OSError as error:
            logger.warning("Disk reading failed (will retry): %s", error)
        await asyncio.sleep(interval)
