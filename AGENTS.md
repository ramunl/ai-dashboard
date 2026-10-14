# ai-dashboard

The owner's Telegram Mini App for the AI agents (Coding, PM, Ops, Tasks). A
separate aiohttp service, so it keeps working while an agent restarts or
deploys. One owner; every request is checked against Telegram `initData`
(HMAC) in `auth.py`.

## How it works

- Reads each agent's snapshot file (read-only, secret-free) and server state;
  never imports agent code.
- Changes go two ways only: fixed root CLI commands in `/usr/local/sbin`
  (`ai-deploy`, `ai-backup`, … via `commands.py`), or request files dropped
  into the coding agent's inbox (`agent_actions.py`, an allow-list that must
  mirror the agent's `ai_agent/inbox.py`).
- The page is plain JavaScript (no build step) in `ai_dashboard/static/`.

## Layout

- `ai_dashboard/server.py` – routes; `views.py` – builds each window's data.
- `ai_dashboard/*.py` – one concern each: deployments, logs, backups,
  package/tool updates, task progress (Deployed is decided here), PM bridge,
  saved checks.
- `static/js/` – `dom.js` (helpers `el`, `card`, `row`, columns layout),
  `actions-ui.js` (`requestAction`, confirmations, notices), `router.js`,
  `views/*.js` – one file per card or window.
- `deploy/` – systemd unit and update script. `docs/` – notes.

## Commands

- Python tests: `python3 -m pytest -q`. Page tests: `npm test`
  (node `--test` with jsdom, `tests/js/`).
- Lint: `ruff check .` and `ruff format --check ai_dashboard tests`
  (ruff 0.16.8, line length 88). Format only the files you touch.

## Conventions and traps

- All page scripts share one global namespace: top-level function names must
  be unique (a test fails on duplicates).
- Put text in the DOM with `textContent`/`el()`, never `innerHTML`.
- Any action that spends AI tokens, deploys or deletes asks for confirmation
  first.
- New agent actions: add them here and in the agent's `inbox.py` together.
- Tests never touch the real `/etc`, `/var/lib` or `/usr/local/sbin`.
