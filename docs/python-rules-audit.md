# Python rules review — 2026-09-27

Reviewed `ai_dashboard/` against `/opt/ai-rules/global/python.md`, starting from
`b8874b6`. Changes are isolated from the deployed checkout.

## Findings and changes

- Added 21 missing public and constructor docstrings. Existing parameter and
  return annotations already passed the production annotation checks.
- Split the long health problem evaluator into service, resource, and agent
  helpers in `problems.py`. Existing messages, thresholds, and severity order
  are retained; `health.compute_problems` remains available.
- Consolidated duplicated process handling in `commands.py`. Timed-out and
  cancelled child processes are killed and reaped. Failures are logged, and a
  failed journal command reports an unknown count rather than zero errors.
  Expected nonzero systemctl status codes still report inactive/missing states.
- Reused the existing BotSource dataclass for menu-button requests, reducing
  the function from six parameters to five.
- Logged previously silent configuration parsing and env-file read failures
  without logging file contents.
- Added Ruff enforcement for imports, naming, 88-character lines, annotations,
  docstrings, and mutable/default-call checks. Existing CI uses this configuration.

## Validation and limits

- 85 Python tests pass, including seven new subprocess regression tests.
- The existing jsdom navigation test passes using locally available dependencies.
- Ruff lint, formatting, and Git whitespace checks pass.
- No production module reaches 300 lines. The authentication and settings
  validation functions remain slightly above the approximate 40-line target;
  their sequential validation is cohesive and already covered by tests.
- No wildcard imports or mutable defaults found. Every production function has
  five or fewer named parameters.

Tests use local fake HTTP servers and mocked system operations. No live Telegram
messages, menu-button updates, or deployment were performed. The frontend was
regression-tested but this review covers Python rules, not JavaScript conventions.
Full static type checking and exhaustive behavioral coverage are not claimed.
