# Tokens page

`/tokens` is read-only. It reads the configured Coding snapshot from disk;
`GET /api/tokens` uses the existing Telegram initData owner authentication.
It exposes normalized usage, coverage, freshness and data-quality warnings,
never the rest of the snapshot. No provider calls or server changes are made.

## Schema dependency

Part 1 shipped in [ai-coding-agent PR #38](https://github.com/ramunl/ai-coding-agent/pull/38),
merged 2026-10-21 at 09:38:42 UTC, merge commit
`76a144474e0a0f370693d5c8f68d9fe2cdf5aa36`. The contract was verified against
its head `6123b1f1e5e8b35a4079e9fafe20273505f272aa`, specifically
`docs/token_usage.md`, `ai_agent/token_usage.py`, and the snapshot publisher.
This verifies the published code contract, not the live server's deployment.

Coding format 2 preserves format 1's existing fields and adds optional usage:

```json
{
  "format": 2,
  "updated_at": 1792584000,
  "token_usage": {
    "window_days": 90,
    "days": [
      {
        "date": "2026-10-21",
        "usage": [
          {"role": "planner", "tool": "codex", "calls": 3, "unknown": 1, "tokens": 150}
        ]
      }
    ]
  }
}
```

The bucket timezone is **UTC**, established by the upstream implementation
and documentation; it is not a field to infer from the browser or server's
local timezone. Roles are `planner` and `implementer`; tools are `codex` and
`claude`. Counts are nonnegative integers, excluding booleans. `unknown` must
not exceed `calls`; a bucket with no measured calls cannot have positive tokens.

Coding reads explicitly accept formats 1 and 2. PM and other bot reads still
accept format 1. Format 1, omitted usage, and unsupported formats mean usage
is unavailable, never zero. Invalid containers invalidate the section;
invalid dates, roles, tools, counts, out-of-window dates and ambiguous duplicate
buckets are omitted with logs and public warnings. Logs never quote raw snapshot
values. Extra fields are not returned. The parser does not import agent code.

## Token semantics

The dashboard sums upstream `tokens` once; it does not add any other provider
fields. These are reported counts, not billing totals:

- Claude planner: API input + output tokens; separate cache reads and writes
  are excluded by Part 1.
- Codex planner and implementer: the CLI's parsed `tokens used` count.
  Part 1 documents that parser as unverified against the installed CLI.
- Claude implementer: unknown because its text output contains no token count.

`calls` includes every recorded call; `unknown` counts calls without usage.
Unknown calls contribute no tokens. An all-unknown bucket displays unavailable;
a measured zero displays 0. Mixed buckets show the reported sum alongside the
unknown call count. Absent role/tool buckets display unavailable. Aggregate
counts combine only validated rows, so warnings imply incomplete totals.

## Coverage and freshness

Retention is 90 UTC calendar days including today. The dashboard also excludes
older and future dates. Only reported buckets are returned; missing calendar
days are never filled with zero. Daily totals roll up by ISO year/week (Monday
through Sunday) and calendar month. ISO week years can differ from calendar
years at New Year, and leap days belong to their actual calendar month.

The API exposes retention bounds, first/last reported dates, reported-day counts,
and calendar bounds/counts for each period. The upstream contract contains no
tracking-start timestamp, loss/reset marker or continuity guarantee. All periods
are therefore conservatively marked as partial coverage, even if each day has
some bucket. Weeks/months can cross retention boundaries, today is unfinished,
and a day with one tool's bucket does not prove coverage for another tool.

Freshness is based on snapshot `updated_at`, independently of the newest usage
day: a fresh snapshot can legitimately contain only older usage. More than 90
seconds old is stale. Missing, invalid or future timestamps show unknown
freshness and a warning. A missing store, an empty valid store, and measured zero
have separate UI states. The page uses the shared request timeout and navigation
generation guards so slow requests cannot overwrite a newer page.

## Verification

Python tests cover malformed and legacy inputs, omission warnings, duplicates,
zero/unknown counts, safe output, retention, ISO-year boundaries, leap dates,
freshness, compatibility, and authenticated/unauthenticated API access. jsdom
tests cover tables and text safety, unavailable/empty/error states, launcher and
Back navigation, slow/hung requests, and stale response races. The existing
script-name uniqueness test includes the new script from index.html.

Run `python3 -m pytest -q`, `npm test`, `ruff check .`, and
`ruff format --check ai_dashboard tests`. Format only touched Python files.
