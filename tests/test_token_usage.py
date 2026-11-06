"""Tests of the published Coding usage/cost contract and defensive normalization."""

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


# DS08 format-3 contract: buckets name registry tool ids and may add optional
# cost labels; the registry (DS05) supplies each tool's provider and model.
DS08_REGISTRY = {
    "format": 1,
    "roles": {
        "planner": {"tool": "opencode", "options": ["opencode", "codex"]},
        "implementer": {"tool": "codex", "options": ["opencode", "codex"]},
    },
    "tools": {
        "opencode": {
            "label": "OpenCode",
            "provider": "deepseek",
            "model": "deepseek-v4-pro",
            "models": ["deepseek-v4-pro"],
            "manageable": True,
        },
        "codex": {
            "label": "Codex",
            "provider": "openai",
            "model": "gpt-5.2-codex",
            "models": ["gpt-5.2-codex"],
            "manageable": True,
        },
        "claude-code": {
            "label": "Claude Code",
            "provider": "anthropic",
            "model": "claude-opus-5-5",
            "models": ["claude-opus-5-5"],
            "manageable": False,
        },
    },
    "providers": {
        "deepseek": {"label": "DeepSeek Pro", "kind": "api", "limits": "deepseek"},
        "openai": {"label": "OpenAI", "kind": "subscription", "limits": "codex"},
        "anthropic": {"label": "Anthropic", "kind": "subscription", "limits": "claude"},
    },
}


def ds08_bucket(**changes):
    return {
        "role": "planner",
        "tool": "opencode",
        "calls": 2,
        "unknown": 0,
        "tokens": 100,
        **changes,
    }


def ds08_snapshot(days=None, balance="absent", registry=DS08_REGISTRY, **changes):
    section = {
        "window_days": 90,
        "days": days
        if days is not None
        else [{"date": "2024-02-29", "usage": [ds08_bucket()]}],
    }
    if balance != "absent":
        section["balance"] = balance
    return {
        "format": 3,
        "updated_at": NOW - 10,
        "registry": registry,
        "token_usage": section,
        **changes,
    }


def totals_row(view, role, tool):
    return next(
        row for row in view["totals"] if row["role"] == role and row["tool"] == tool
    )


def test_reported_totals_and_missing_are_distinct():
    view = usage_view(snapshot(), NOW)
    assert view["available"] and not view["stale"]
    assert view["age_seconds"] == 10
    assert view["totals"][0]["tokens"] == 100
    assert view["totals"][1]["tokens"] is None
    assert view["timezone"] == "UTC"
    assert "snapshot" not in view


@pytest.mark.parametrize(
    "value", [None, [], {}, {"format": 1}, {"format": True}, {"format": 4}]
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
    for version in (1, 2, 3, True, 4, 2.0):
        path.write_text(json.dumps({"format": version, "todos": {"open": ["keep"]}}))
        coding, _ = sources.read_snapshot(path, sources.CODING_SNAPSHOT_FORMATS)
        other, _ = sources.read_snapshot(path)
        assert (coding is not None) == (type(version) is int and version in (1, 2, 3))
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


# --- DS08: registry-described tools, provider/model and optional cost labels ---


def test_registry_drives_roles_and_third_tool():
    view = usage_view(ds08_snapshot(), NOW)
    assert view["available"] and view["registry"]
    assert [row["role"] for row in view["totals"]] == ["planner"] * 3 + [
        "implementer"
    ] * 3
    assert [row["tool"] for row in view["totals"]] == [
        "opencode",
        "codex",
        "claude-code",
        "opencode",
        "codex",
        "claude-code",
    ]


def test_registry_provider_model_and_label_are_normalized():
    view = usage_view(ds08_snapshot(), NOW)
    row = totals_row(view, "planner", "opencode")
    assert row["tool_label"] == "OpenCode"
    assert row["provider"] == "deepseek"
    assert row["model"] == "deepseek-v4-pro"
    assert totals_row(view, "implementer", "codex")["provider"] == "openai"
    # Only normalized fields escape; the registry's own maps and flags do not.
    dumped = json.dumps(view)
    assert "providers" not in dumped
    assert "manageable" not in dumped


def test_legacy_snapshots_show_no_cost_billing_or_provider():
    view = usage_view(snapshot(), NOW)
    assert not view["registry"]
    assert view["billing"] is None
    assert all(
        row["cost_estimated"] is None
        and row["cost_reported"] is None
        and row["provider"] is None
        and row["model"] is None
        and row["tool_label"] is None
        for row in view["totals"]
    )


def test_estimated_and_reported_costs_stay_separate():
    day = {
        "date": "2024-02-29",
        "usage": [
            ds08_bucket(
                cost={
                    "kind": "estimated",
                    "amount": 0.5,
                    "currency": "USD",
                    "rate_basis": "per_1m_tokens",
                }
            ),
            ds08_bucket(
                role="implementer",
                tool="codex",
                cost={"kind": "reported", "amount": 1.25, "currency": "USD"},
            ),
        ],
    }
    view = usage_view(ds08_snapshot([day]), NOW)
    planner = totals_row(view, "planner", "opencode")
    assert planner["cost_estimated"] == {
        "amount": 0.5,
        "currency": "USD",
        "rate_bases": ["per_1m_tokens"],
    }
    assert planner["cost_reported"] is None
    implementer = totals_row(view, "implementer", "codex")
    assert implementer["cost_reported"] == {
        "amount": 1.25,
        "currency": "USD",
        "rate_bases": [],
    }
    assert implementer["cost_estimated"] is None


def test_cost_aggregation_keeps_currency_and_kind():
    days = [
        {
            "date": "2024-02-28",
            "usage": [
                ds08_bucket(
                    cost={
                        "kind": "estimated",
                        "amount": 0.25,
                        "currency": "USD",
                        "rate_basis": "per_1m_tokens",
                    }
                )
            ],
        },
        {
            "date": "2024-02-29",
            "usage": [
                ds08_bucket(
                    cost={
                        "kind": "estimated",
                        "amount": 0.75,
                        "currency": "USD",
                        "rate_basis": "per_1m_tokens",
                    }
                )
            ],
        },
    ]
    row = totals_row(usage_view(ds08_snapshot(days), NOW), "planner", "opencode")
    assert row["cost_estimated"] == {
        "amount": 1.0,
        "currency": "USD",
        "rate_bases": ["per_1m_tokens"],
    }


def test_mixed_currencies_are_unavailable_not_combined():
    days = [
        {
            "date": "2024-02-28",
            "usage": [
                ds08_bucket(cost={"kind": "reported", "amount": 1, "currency": "USD"})
            ],
        },
        {
            "date": "2024-02-29",
            "usage": [
                ds08_bucket(cost={"kind": "reported", "amount": 2, "currency": "EUR"})
            ],
        },
    ]
    row = totals_row(usage_view(ds08_snapshot(days), NOW), "planner", "opencode")
    assert row["cost_reported"] == {
        "amount": None,
        "currency": None,
        "rate_bases": [],
    }


def test_balance_reported_and_unavailable_are_distinct():
    balance = {"kind": "reported", "amount": 12.34, "currency": "USD"}
    view = usage_view(ds08_snapshot(balance=balance), NOW)
    assert view["billing"]["balance"] == {
        "kind": "reported",
        "amount": 12.34,
        "currency": "USD",
    }
    assert usage_view(ds08_snapshot(), NOW)["billing"] == {"balance": None}
    assert usage_view(ds08_snapshot(balance=None), NOW)["billing"] == {"balance": None}


def test_malformed_cost_and_balance_omitted_keep_tokens():
    data = ds08_snapshot(
        days=[
            {
                "date": "2024-02-29",
                "usage": [
                    ds08_bucket(
                        cost={"kind": "reported", "amount": -1, "currency": "USD"}
                    ),
                    ds08_bucket(role="implementer", tool="codex"),
                ],
            }
        ],
        balance={"kind": "reported", "amount": "x", "currency": "USD"},
    )
    view = usage_view(data, NOW)
    assert view["available"]
    assert view["billing"] == {"balance": None}
    row = totals_row(view, "planner", "opencode")
    assert row["tokens"] == 100  # the malformed cost never drops the counts
    assert row["cost_reported"] is None
    assert "Malformed cost omitted (1)" in view["warnings"]
    assert "Malformed balance omitted (1)" in view["warnings"]


def test_registry_tool_validation_and_duplicates():
    day = {
        "date": "2024-02-29",
        "usage": [ds08_bucket(), ds08_bucket(tool="unknown-tool")],
    }
    view = usage_view(ds08_snapshot([day]), NOW)
    assert view["available"]
    assert totals_row(view, "planner", "opencode")["tokens"] == 100
    assert "Invalid role, tool or counts omitted (1)" in view["warnings"]

    assert not parse_usage(ds08_snapshot([day, day]), TODAY).rows


def test_registry_required_for_format_3():
    missing = ds08_snapshot()
    del missing["registry"]
    view = usage_view(missing, NOW)
    assert not view["available"]
    assert any("valid tool registry" in warning for warning in view["warnings"])

    broken = ds08_snapshot(registry={"format": 9, "tools": {}})
    assert not usage_view(broken, NOW)["available"]


def test_legacy_and_registry_snapshots_coexist():
    legacy = usage_view(snapshot(), NOW)
    registry = usage_view(ds08_snapshot(), NOW)
    assert legacy["available"] and not legacy["registry"]
    assert registry["available"] and registry["registry"]
    assert legacy["totals"][0]["tool"] == "codex"
    assert registry["totals"][0]["tool"] == "opencode"
