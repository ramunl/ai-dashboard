"""Tests of the published Coding usage contract and defensive normalization."""

import asyncio
import json
import time
from datetime import UTC, date, datetime, timedelta
from types import SimpleNamespace
from unittest.mock import patch

import pytest

from ai_dashboard import sources, views
from ai_dashboard.config import BotSource
from ai_dashboard.token_usage import aggregate, parse_usage, usage_view

TODAY = date(2024, 3, 1)
NOW = datetime(2024, 3, 1, 12, tzinfo=UTC).timestamp()


def bucket(**changes):
    return {
        "role": "planner",
        "tool": "codex",
        "calls": 2,
        "unknown": 0,
        "tokens": 100,
        **changes,
    }


def snapshot(days=None, **changes):
    return {
        "format": 2,
        "updated_at": NOW - 10,
        "token_usage": {
            "window_days": 90,
            "days": days
            if days is not None
            else [{"date": "2024-02-29", "usage": [bucket()]}],
        },
        **changes,
    }


def test_reported_totals_and_missing_are_distinct():
    view = usage_view(snapshot(), NOW)
    assert view["available"] and not view["stale"]
    assert view["age_seconds"] == 10
    assert view["totals"][0]["tokens"] == 100
    assert view["totals"][1]["tokens"] is None
    assert view["timezone"] == "UTC"
    assert "snapshot" not in view


@pytest.mark.parametrize(
    "value", [None, [], {}, {"format": 1}, {"format": True}, {"format": 3}]
)
def test_missing_legacy_and_future_usage(value):
    view = usage_view(value, NOW)
    assert not view["available"]
    assert view["periods"]["day"] == []
    assert all(row["tokens"] is None for row in view["totals"])
    assert view["warnings"]


@pytest.mark.parametrize(
    "section",
    [
        None,
        [],
        0,
        {},
        {"window_days": True, "days": []},
        {"window_days": 90, "days": {}},
        {"window_days": 30, "days": []},
    ],
)
def test_bad_sections(section):
    assert not parse_usage(snapshot(token_usage=section), TODAY).available


@pytest.mark.parametrize(
    "changes",
    [
        {"role": []},
        {"role": "worker"},
        {"tool": {}},
        {"tool": "<script>"},
        {"tokens": True},
        {"tokens": -1},
        {"tokens": 1.5},
        {"tokens": "1"},
        {"tokens": None},
        {"calls": False},
        {"unknown": -1},
        {"unknown": 3},
        {"calls": 0},
        {"unknown": 2},
    ],
)
def test_bad_counts_and_keys_are_omitted(changes, caplog):
    data = snapshot(
        [{"date": "2024-02-29", "usage": [bucket(**changes), bucket(tool="claude")]}]
    )
    parsed = parse_usage(data, TODAY)
    assert len(parsed.rows) == 1
    assert parsed.rows[0].tool == "claude"
    assert parsed.warnings
    assert "omitted" in caplog.text
    assert "<script>" not in caplog.text


@pytest.mark.parametrize(
    "item",
    [
        None,
        [],
        {},
        {"date": "2023-02-29", "usage": []},
        {"date": "20240229", "usage": []},
        {"date": "2024-W09-4", "usage": []},
        {"date": "2024-02-29", "usage": {}},
        {"date": [], "usage": []},
    ],
)
def test_bad_days(item):
    parsed = parse_usage(snapshot([item]), TODAY)
    assert not parsed.rows and parsed.warnings


def test_duplicates_are_not_counted():
    day = {"date": "2024-02-29", "usage": [bucket()]}
    assert not parse_usage(snapshot([day, day]), TODAY).rows
    day["usage"].append(bucket(tokens=200))
    assert not parse_usage(snapshot([day]), TODAY).rows


def test_unknown_and_zero():
    data = snapshot(
        [
            {
                "date": "2024-02-29",
                "usage": [
                    bucket(calls=1, unknown=1, tokens=0),
                    bucket(tool="claude", calls=1, tokens=0),
                    bucket(role="implementer", calls=2, unknown=1, tokens=20),
                ],
            }
        ]
    )
    totals = usage_view(data, NOW)["totals"]
    assert totals[0]["tokens"] is None and totals[0]["unknown"] == 1
    assert totals[1]["tokens"] == 0
    assert totals[2]["tokens"] == 20 and totals[2]["unknown"] == 1


def test_retention_and_partial_coverage():
    oldest = TODAY - timedelta(days=89)
    days = [
        {"date": day.isoformat(), "usage": [bucket()]}
        for day in (
            oldest - timedelta(days=1),
            oldest,
            TODAY,
            TODAY + timedelta(days=1),
        )
    ]
    view = usage_view(snapshot(days), NOW)
    assert view["coverage"]["start"] == oldest.isoformat()
    assert view["coverage"]["reported_days"] == 2
    assert view["totals"][0]["tokens"] == 200
    assert not view["coverage"]["continuous"]
    assert all(period["partial"] for period in view["periods"]["month"])
    assert view["warnings"]


def test_iso_year_and_month_boundaries():
    days = [
        {
            "date": day,
            "usage": [bucket(), bucket(role="implementer", tool="claude", tokens=7)],
        }
        for day in ("2020-12-31", "2021-01-01", "2021-01-04")
    ]
    parsed = parse_usage(snapshot(days), date(2021, 1, 4))
    weeks = aggregate(parsed.rows, "week")
    assert [week["period"] for week in weeks] == ["2021-W01", "2020-W53"]
    assert weeks[1]["start"] == "2020-12-28"
    assert weeks[1]["end"] == "2021-01-03"
    assert weeks[1]["totals"][0]["tokens"] == 200
    assert weeks[1]["totals"][3]["tokens"] == 14
    months = aggregate(parsed.rows, "month")
    assert [month["period"] for month in months] == ["2021-01", "2020-12"]
    assert months[0]["totals"][0]["tokens"] == 200


def test_leap_month_and_empty_retention():
    month = usage_view(snapshot(), NOW)["periods"]["month"][0]
    assert month["end"] == "2024-02-29" and month["calendar_days"] == 29
    empty = usage_view(snapshot([]), NOW)
    assert empty["available"]
    assert empty["coverage"]["first_reported_day"] is None
    assert empty["totals"][0]["tokens"] is None


@pytest.mark.parametrize(
    "stamp", [None, True, "2024-03-01", float("nan"), float("inf"), -1, NOW + 1]
)
def test_invalid_freshness(stamp):
    view = usage_view(snapshot(updated_at=stamp), NOW)
    assert view["stale"] and view["updated_at"] is None
    assert view["warnings"]


def test_stale_snapshot():
    assert usage_view(snapshot(updated_at=NOW - 91), NOW)["stale"]


def test_unrelated_fields_never_escape():
    data = snapshot(secret="PRIVATE")
    data["token_usage"]["days"][0]["usage"][0]["prompt"] = "PRIVATE"
    assert "PRIVATE" not in json.dumps(usage_view(data, NOW))


def test_format_compatibility(tmp_path):
    path = tmp_path / "snapshot.json"
    for version in (1, 2, True, 3, 2.0):
        path.write_text(json.dumps({"format": version, "todos": {"open": ["keep"]}}))
        coding, _ = sources.read_snapshot(path, sources.CODING_SNAPSHOT_FORMATS)
        other, _ = sources.read_snapshot(path)
        assert (coding is not None) == (type(version) is int and version in (1, 2))
        assert (other is not None) == (type(version) is int and version == 1)
        if other:
            assert other["todos"] == {"open": ["keep"]}


def test_provider_reads_only_snapshot(tmp_path):
    path = tmp_path / "snapshot.json"
    path.write_text(json.dumps(snapshot(secret="PRIVATE")))
    bot = BotSource("coding", "x", "unused", "coding", path)
    with (
        patch.object(views.time, "time", return_value=NOW),
        patch.object(views.asyncio, "to_thread", new=inline_thread),
    ):
        view = asyncio.run(views.tokens_view(SimpleNamespace(bot=lambda _: bot)))
    assert view["totals"][0]["tokens"] == 100
    assert "PRIVATE" not in json.dumps(view)


async def inline_thread(function, *args):
    return function(*args)


@pytest.mark.parametrize(
    "identity,expected",
    [("owner", 200), ("missing", 401), ("forged", 401), ("other", 403)],
)
def test_tokens_authenticated_handler(tmp_path, identity, expected):
    from aiohttp import web
    from aiohttp.test_utils import make_mocked_request

    from ai_dashboard import server
    from ai_dashboard.auth import sign_init_data
    from ai_dashboard.config import Settings

    path = tmp_path / "snapshot.json"
    path.write_text(json.dumps(snapshot(secret="PRIVATE")))
    bot = BotSource("coding", "123:TOKEN", "unused", "coding", path)
    settings = Settings(
        public_url="https://example.test",
        host="127.0.0.1",
        port=8787,
        owner_id=777,
        bots=(bot,),
        state_dir=tmp_path,
    )
    init = sign_init_data(
        {
            "auth_date": str(int(time.time())),
            "user": json.dumps({"id": 1 if identity == "other" else 777}),
        },
        "bad:token" if identity == "forged" else bot.token,
    )
    app = web.Application()
    app[server.SETTINGS] = settings
    request = make_mocked_request(
        "GET",
        "/api/tokens",
        app=app,
        match_info={"window": "tokens"},
        headers={} if identity == "missing" else {"Authorization": "tma " + init},
    )
    with patch.object(views.asyncio, "to_thread", new=inline_thread):
        response = asyncio.run(server.window_data(request))
    assert response.status == expected
    if expected == 200:
        body = json.loads(response.text)
        assert body["available"]
        assert "PRIVATE" not in response.text
        assert "snapshot" not in body
    assert response.headers["Cache-Control"] == "no-store"
