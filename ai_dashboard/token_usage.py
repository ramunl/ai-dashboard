"""Normalize Coding's usage and optional cost contract without importing agent code."""

from __future__ import annotations

import calendar
import logging
import math
from collections import Counter
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta

from ai_dashboard.agent_actions import registry_tools
from ai_dashboard.sources import STALE_AFTER_SECONDS

logger = logging.getLogger(__name__)
ROLES = ("planner", "implementer")
# Format 2 predates the DS05 registry: its buckets name these two fixed tools.
LEGACY_TOOLS = ("codex", "claude")
WINDOW_DAYS = 90
COST_KINDS = ("estimated", "reported")


@dataclass(frozen=True)
class Cost:
    """One validated optional cost label: never mixed with another kind."""

    kind: str
    amount: float
    currency: str
    rate_basis: str | None


@dataclass(frozen=True)
class Balance:
    """One validated optional account-balance label."""

    kind: str
    amount: float
    currency: str


@dataclass(frozen=True)
class Usage:
    """One validated daily role/tool bucket."""

    day: date
    role: str
    tool: str
    calls: int
    unknown: int
    tokens: int
    cost: Cost | None = None


@dataclass(frozen=True)
class ParsedUsage:
    """Validated buckets, balance and omission reasons for a snapshot."""

    available: bool
    rows: tuple[Usage, ...]
    warnings: tuple[str, ...]
    balance: Balance | None = None


def _day(value: object) -> date | None:
    if not isinstance(value, str):
        return None
    try:
        parsed = date.fromisoformat(value)
    except ValueError:
        return None
    return parsed if parsed.isoformat() == value else None


def _cost(value: object, warnings: Counter[str]) -> Cost | None:
    """Validate an optional cost label, omitting a malformed one only."""
    if value is None:
        return None
    if not isinstance(value, dict):
        warnings["Malformed cost omitted"] += 1
        return None
    kind, amount = value.get("kind"), value.get("amount")
    currency, basis = value.get("currency"), value.get("rate_basis")
    if (
        kind not in COST_KINDS
        or type(amount) not in (int, float)
        or not math.isfinite(amount)
        or amount < 0
        or not isinstance(currency, str)
        or not currency.strip()
        or (basis is not None and (not isinstance(basis, str) or not basis.strip()))
    ):
        warnings["Malformed cost omitted"] += 1
        return None
    return Cost(kind, float(amount), currency, basis or None)


def _balance(value: object, warnings: Counter[str]) -> Balance | None:
    """Validate the optional account balance, omitting a malformed one only."""
    if value is None:
        return None
    if not isinstance(value, dict):
        warnings["Malformed balance omitted"] += 1
        return None
    kind, amount, currency = (
        value.get("kind"),
        value.get("amount"),
        value.get("currency"),
    )
    if (
        kind not in COST_KINDS
        or type(amount) not in (int, float)
        or not math.isfinite(amount)
        or amount < 0
        or not isinstance(currency, str)
        or not currency.strip()
    ):
        warnings["Malformed balance omitted"] += 1
        return None
    return Balance(kind, float(amount), currency)


def _row(
    value: object,
    day: date,
    tool_ids: tuple[str, ...],
    warnings: Counter[str],
) -> Usage | None:
    if not isinstance(value, dict):
        return None
    role, tool = value.get("role"), value.get("tool")
    counts = [value.get(key) for key in ("calls", "unknown", "tokens")]
    if role not in ROLES or tool not in tool_ids:
        return None
    if any(type(count) is not int or count < 0 for count in counts):
        return None
    calls, unknown, tokens = counts
    if unknown > calls or (calls == unknown and tokens != 0):
        return None
    return Usage(
        day, role, tool, calls, unknown, tokens, _cost(value.get("cost"), warnings)
    )


def _tool_ids(snapshot: object, fmt: object) -> tuple[tuple[str, ...], dict | None]:
    """The tools a snapshot's buckets may name, plus their registry entries."""
    if fmt == 2:
        return LEGACY_TOOLS, None
    if fmt != 3:
        return (), None
    tools = registry_tools(snapshot)
    return (tuple(tools), tools) if tools else ((), None)


def parse_usage(snapshot: object, today: date) -> ParsedUsage:
    """Omit invalid/duplicate buckets; never interpolate raw data into warnings."""
    warnings: Counter[str] = Counter()
    rows: list[Usage] = []
    balance: Balance | None = None

    def result(available: bool) -> ParsedUsage:
        messages = tuple(f"{reason} ({count})" for reason, count in warnings.items())
        for message in messages:
            logger.warning("Token usage: %s", message)
        return ParsedUsage(available, tuple(rows), messages, balance)

    if not isinstance(snapshot, dict) or type(snapshot.get("format")) is not int:
        warnings["Snapshot unavailable or invalid"] += 1
        return result(False)
    fmt = snapshot["format"]
    if fmt not in (2, 3):
        warnings["Usage requires Coding snapshot format 2 or 3"] += 1
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
    tool_ids, _registry = _tool_ids(snapshot, fmt)
    if fmt == 3 and not tool_ids:
        warnings["Usage requires a valid tool registry"] += 1
        return result(False)
    balance = _balance(section.get("balance") if fmt == 3 else None, warnings)
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
            row = _row(entry, day, tool_ids, warnings)
            if row is None:
                warnings["Invalid role, tool or counts omitted"] += 1
            elif keys[(row.role, row.tool)] != 1:
                warnings["Duplicate role/tool bucket omitted"] += 1
            else:
                rows.append(row)
    return result(True)


def _cost_aggregate(group: list[Usage], kind: str) -> dict | None:
    """Sum one cost kind only; mixed currencies stay unavailable, never merged."""
    rows = [row for row in group if row.cost is not None]
    costs = [row.cost for row in rows if row.cost.kind == kind]
    if not costs:
        return None
    currencies = {cost.currency for cost in costs}
    return {
        "amount": sum(cost.amount for cost in costs) if len(currencies) == 1 else None,
        "currency": next(iter(currencies)) if len(currencies) == 1 else None,
        "rate_bases": sorted({cost.rate_basis for cost in costs if cost.rate_basis}),
    }


def _totals(
    rows: list[Usage],
    tool_ids: tuple[str, ...] = LEGACY_TOOLS,
    registry: dict | None = None,
) -> list[dict]:
    totals = []
    for role in ROLES:
        for tool in tool_ids:
            group = [row for row in rows if row.role == role and row.tool == tool]
            calls = sum(row.calls for row in group)
            unknown = sum(row.unknown for row in group)
            entry = registry.get(tool) if registry else None
            totals.append(
                {
                    "role": role,
                    "tool": tool,
                    "tool_label": entry["label"] if entry else None,
                    "provider": entry["provider"] if entry else None,
                    "model": entry["model"] if entry else None,
                    "calls": calls if group else None,
                    "unknown": unknown if group else None,
                    "tokens": sum(row.tokens for row in group)
                    if group and (calls > unknown or calls == 0)
                    else None,
                    "reported_days": len({row.day for row in group}),
                    "cost_estimated": _cost_aggregate(group, "estimated"),
                    "cost_reported": _cost_aggregate(group, "reported"),
                }
            )
    return totals


def aggregate(
    rows: tuple[Usage, ...],
    period: str,
    tool_ids: tuple[str, ...] = LEGACY_TOOLS,
    registry: dict | None = None,
) -> list[dict]:
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
                "totals": _totals(group, tool_ids, registry),
            }
        )
    return result


def usage_view(snapshot: object, now: float) -> dict:
    """Return only normalized usage, cost, coverage and snapshot freshness."""
    today = datetime.fromtimestamp(now, UTC).date()
    parsed = parse_usage(snapshot, today)
    fmt = snapshot.get("format") if isinstance(snapshot, dict) else None
    tool_ids, registry = _tool_ids(snapshot, fmt)
    stamp = snapshot.get("updated_at") if isinstance(snapshot, dict) else None
    valid_stamp = (
        type(stamp) in (int, float) and 0 <= stamp <= now and math.isfinite(stamp)
    )
    age = now - stamp if valid_stamp else None
    warnings = list(parsed.warnings)
    if not valid_stamp:
        warnings.append("Snapshot freshness unavailable")
    days = sorted({row.day for row in parsed.rows})
    balance = parsed.balance
    return {
        "available": parsed.available,
        "registry": registry is not None,
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
        "totals": _totals(list(parsed.rows), tool_ids, registry),
        "periods": {
            kind: aggregate(parsed.rows, kind, tool_ids, registry)
            for kind in ("day", "week", "month")
        },
        "billing": (
            {
                "balance": {
                    "kind": balance.kind,
                    "amount": balance.amount,
                    "currency": balance.currency,
                }
                if balance
                else None
            }
            if fmt == 3
            else None
        ),
    }
