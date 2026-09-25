# ai-dashboard

Telegram Mini App dashboard for the AI agents (coding, PM, ops), running as
its **own service** so it keeps working when an agent crashes, restarts, or
deploys.

```
Telegram ──https──▶ Caddy ──▶ ai-dashboard (127.0.0.1:8787)
                                  │ reads only files + systemd
                                  ├── /var/lib/ai-coding-agent/snapshot.json
                                  └── systemctl is-active ai-coding-agent
```

## Windows

| Path | Opened from | Status |
|---|---|---|
| `/coding` | Coding bot | live |
| `/` (launcher: server health, problems) | Ops bot | next |
| `/pm` | PM bot | later |

`/` currently shows the Coding window.

## How it gets data: agents publish, the dashboard reads

The dashboard never talks to an agent process. Each agent writes a small,
secret-free **snapshot file**; the dashboard reads it and combines it with the
agent's systemd state. That is what lets it report problems the agent itself
cannot, for example:

- `agent service is failed`: the agent is down, the dashboard still answers
- `agent is running but stopped publishing 120 s ago`: the agent is stuck
- `has not published a snapshot yet`

### Snapshot contract (format 1)

Written by the coding agent (`ai_agent/bot/snapshot_publisher.py`) on change
and at least every 30 s. The dashboard treats data older than 90 s as stale.

```json
{
  "format": 1,
  "updated_at": 1790255302.1,
  "running": {"branch": "...", "phase": "...", "status": "RUNNING"},
  "queue": [{"id": 3, "branch": "...", "label": "implementation", "agent": "codex"}],
  "pending_plan": {"id": "...", "feature": "...", "revision": 2, "approved": false},
  "pending_branch": null,
  "awaiting_bugfix_answer": false,
  "planning_agent": "codex",
  "implementation_agent": "codex",
  "verbosity": "concise",
  "last_execution": {"branch": "...", "pr_url": "...", "tests": "...", "files_changed": []},
  "project": {"name": "...", "repository": "owner/repo", "branch": "main"},
  "version": "ai-coding-agent v0.3.0\nbranch: main\ncommit: 44110fe",
  "core": "core: v1.1"
}
```

A snapshot with an unknown `format` is reported, not guessed at. Bump the
format on breaking changes and teach the dashboard the new one first.

## Security

- Data endpoints (`/api/<window>`) require Telegram `initData` signed by one
  of the configured bots **and** belonging to the owner (`YOUR_CHAT_ID`).
  Unsigned or forged: 401. Another user: 403.
- The page and `/healthz` contain no data.
- Listens on localhost only; Caddy terminates HTTPS.
- Bot tokens are read from each agent's own env file, not copied. Rotating a
  token: edit that file, restart the agent **and** `ai-dashboard`.
- The token is part of every Bot API URL, so errors are logged without the URL.
- Runs as root, because the agent env and snapshot files are root-only (0600).

## Menu buttons

On every start, the dashboard points each configured bot's Dashboard button
at its window, so the agents themselves need no Mini App code. Typing `/` in
a chat still lists commands.

## Configuration

`/etc/ai-dashboard/ai-dashboard.env` (see `.env.example`):

| Variable | Default | Meaning |
|---|---|---|
| `DASHBOARD_PUBLIC_URL` | required | public `https://` address, with port if not 443 |
| `DASHBOARD_PORT` | `8787` | local port Caddy forwards to |
| `DASHBOARD_HOST` | `127.0.0.1` | bind address |
| `CODING_ENV_FILE` | `/etc/ai-coding-agent/ai-coding-agent.env` | coding bot token, owner, snapshot path |
| `CODING_SERVICE` | `ai-coding-agent` | unit reported in the Coding window |

Invalid configuration exits with status 2 and a clear log line.

## Install

Fresh server (sets up Caddy + certificate too):

```bash
git clone <this repo> /opt/ai-dashboard
sudo HTTPS_PORT=8443 bash /opt/ai-dashboard/deploy/setup-dashboard-https.sh
```

Moving from the old dashboard built into the coding agent (reuses the HTTPS
address and Caddy config you already have):

```bash
sudo bash /opt/ai-dashboard/deploy/migrate-from-coding-agent.sh
```

## Develop

```bash
pip install -r requirements.txt -r requirements-dev.txt
ruff check ai_dashboard tests && ruff format --check ai_dashboard tests
pytest
```
# ai-dashboard
