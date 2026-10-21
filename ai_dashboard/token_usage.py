"""Normalize Coding's format-2 usage contract without importing agent code."""

from __future__ import annotations

import calendar
import logging
import math
from collections import Counter
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta

from ai_dashboard.sources import STALE_AFTER_SECONDS

logger = logging.getLogger(__name__)
ROLES = ("planner", "implementer")
TOOLS = ("codex", "claude")
WINDOW_DAYS = 90


@dataclass(frozen=True)
class Usage:
    """One validated daily role/tool bucket."""

    day: date
    role: str
    tool: str
    calls: int
    unknown: int
    tokens: int


@dataclass(frozen=True)
class ParsedUsage:
    """Validated buckets and omission reasons for a snapshot."""

    available: bool
    rows: tuple[Usage, ...]
    warnings: tuple[str, ...]


def _day(value: object) -> date | None:
    if not isinstance(value, str):
        return None
    try:
        parsed = date.fromisoformat(value)
    except ValueError:
        return None
    return parsed if parsed.isoformat() == value else None


def _row(value: object, day: date) -> Usage | None:
    if not isinstance(value, dict):
        return None
    role, tool = value.get("role"), value.get("tool")
    counts = [value.get(key) for key in ("calls", "unknown", "tokens")]
    if role not in ROLES or tool not in TOOLS:
        return None
    if any(type(count) is not int or count < 0 for count in counts):
        return None
    calls, unknown, tokens = counts
    if unknown > calls or (calls == unknown and tokens != 0):
        return None
    return Usage(day, role, tool, calls, unknown, tokens)


def parse_usage(snapshot: object, today: date) -> ParsedUsage:
    """Omit invalid/duplicate buckets; never interpolate raw data into warnings."""
    warnings: Counter[str] = Counter()
    rows: list[Usage] = []

    def result(available: bool) -> ParsedUsage:
        messages = tuple(f"{reason} ({count})" for reason, count in warnings.items())
        for message in messages:
            logger.warning("Token usage: %s", message)
        return ParsedUsage(available, tuple(rows), messages)

    if not isinstance(snapshot, dict) or type(snapshot.get("format")) is not int:
        warnings["Snapshot unavailable or invalid"] += 1
        return result(False)
    if snapshot["format"] != 2:
        warnings["Usage requires Coding snapshot format 2"] += 1
        return result(False)
    section = snapshot.get("token_usage")
    if section is None:
        warnings["Usage has not been published"] += 1
        return result(False)
    if (
        not isinstance(section, dict)
        or type(section.get("window_days")) is not int
        or section["window_days"] != WINDOW_DAYS
        or not isinstance(section.get("days"), list)
    ):
        warnings["Unsupported usage container or retention window"] += 1
        return result(False)
    days = section["days"]
    # A duplicate is ambiguous: exclude all copies, rather than count one twice.
    dates = Counter(
        item.get("date")
        for item in days
        if isinstance(item, dict) and _day(item.get("date")) is not None
    )
    oldest = today - timedelta(days=WINDOW_DAYS - 1)
    for item in days:
        day = _day(item.get("date")) if isinstance(item, dict) else None
        if day is None or not isinstance(item.get("usage"), list):
            warnings["Malformed day omitted"] += 1
            continue
        if not oldest <= day <= today:
            warnings["Day outside the retained UTC window omitted"] += 1
            continue
        if dates[item["date"]] != 1:
            warnings["Duplicate day omitted"] += 1
            continue
        keys = Counter(
            (entry.get("role"), entry.get("tool"))
            for entry in item["usage"]
            if isinstance(entry, dict)
            and isinstance(entry.get("role"), str)
            and isinstance(entry.get("tool"), str)
        )
        for entry in item["usage"]:
            row = _row(entry, day)
            if row is None:
                warnings["Invalid role, tool or counts omitted"] += 1
            elif keys[(row.role, row.tool)] != 1:
                warnings["Duplicate role/tool bucket omitted"] += 1
            else:
                rows.append(row)
    return result(True)


def _totals(rows: list[Usage]) -> list[dict]:
    totals = []
    for role in ROLES:
        for tool in TOOLS:
            group = [row for row in rows if row.role == role and row.tool == tool]
            calls = sum(row.calls for row in group)
            unknown = sum(row.unknown for row in group)
            totals.append(
                {
                    "role": role,
                    "tool": tool,
                    "calls": calls if group else None,
                    "unknown": unknown if group else None,
                    "tokens": sum(row.tokens for row in group)
                    if group and (calls > unknown or calls == 0)
                    else None,
                    "reported_days": len({row.day for row in group}),
                }
            )
    return totals


def aggregate(rows: tuple[Usage, ...], period: str) -> list[dict]:
    """Sum only retained reported buckets, keeping ISO years with ISO weeks."""
    groups: dict[str, list[Usage]] = {}
    for row in rows:
        iso = row.day.isocalendar()
        key = {
            "day": row.day.isoformat(),
            "week": f"{iso.year}-W{iso.week:02d}",
            "month": row.day.strftime("%Y-%m"),
        }[period]
        groups.setdefault(key, []).append(row)
    result = []
    for key, group in sorted(groups.items(), reverse=True):
        day = group[0].day
        if period == "week":
            start = day - timedelta(days=day.weekday())
            end = start + timedelta(days=6)
        elif period == "month":
            start = day.replace(day=1)
            end = day.replace(day=calendar.monthrange(day.year, day.month)[1])
        else:
            start = end = day
        result.append(
            {
                "period": key,
                "start": start.isoformat(),
                "end": end.isoformat(),
                "reported_days": len({row.day for row in group}),
                "calendar_days": (end - start).days + 1,
                # Upstream publishes neither tracking start nor continuity.
                "partial": True,
                "totals": _totals(group),
            }
        )
    return result


def usage_view(snapshot: object, now: float) -> dict:
    """Return only normalized usage, coverage and snapshot freshness."""
    today = datetime.fromtimestamp(now, UTC).date()
    parsed = parse_usage(snapshot, today)
    stamp = snapshot.get("updated_at") if isinstance(snapshot, dict) else None
    valid_stamp = (
        type(stamp) in (int, float) and 0 <= stamp <= now and math.isfinite(stamp)
    )
    age = now - stamp if valid_stamp else None
    warnings = list(parsed.warnings)
    if not valid_stamp:
        warnings.append("Snapshot freshness unavailable")
    days = sorted({row.day for row in parsed.rows})
    return {
        "available": parsed.available,
        "timezone": "UTC",
        "updated_at": stamp if valid_stamp else None,
        "age_seconds": age,
        "stale": age is None or age > STALE_AFTER_SECONDS,
        "warnings": warnings,
        "coverage": {
            "window_days": WINDOW_DAYS,
            "start": (today - timedelta(days=WINDOW_DAYS - 1)).isoformat(),
            "end": today.isoformat(),
            "first_reported_day": days[0].isoformat() if days else None,
            "last_reported_day": days[-1].isoformat() if days else None,
            "reported_days": len(days),
            "continuous": False,
        },
        "totals": _totals(list(parsed.rows)),
        "periods": {
            kind: aggregate(parsed.rows, kind) for kind in ("day", "week", "month")
        },
    }
