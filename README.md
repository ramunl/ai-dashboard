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

| Path | Opened from | Shows |
|---|---|---|
| `/` | Back from any window | AI Agents overview: health, agent status, resources, disk trend |
| `/ops` | Ops bot | Ops service status, restarts, errors, uptime and resources |
| `/coding` | Coding bot | Coding agent: now, queue, plan, last run, versions |
| `/pm` | PM bot | PM agent: active project's open todos, projects, rule files, versions |

Every window except the launcher shows Telegram's Back button, which leads to
the launcher, including when the window was opened straight from its bot.

The overview lists Coding, PM and Ops as peers. Each row combines agent activity
with service state, restarts and recent errors. Healthy systems show a compact
summary; alerts appear in Needs attention. Ops needs no snapshot.

### Launcher problems

Computed on each refresh, most severe first:

| Severity | When |
|---|---|
| error | a monitored service is not active; disk at least 90% full; memory under 10% available |
| warning | service not installed; restarted automatically 3+ times; errors in its journal in the last hour; disk at least 80%; memory under 15%; 5-minute load above 2x CPUs; an agent running but not publishing |
| info | coding agent core update available; tasks queued with nothing running |

Journal error counts are cached for 30 s.

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
| `OPS_ENV_FILE` | `/etc/ai-ops-agent.env` | ops bot token; skipped if absent |
| `OPS_SERVICE` | `ai-ops-agent` | ops agent unit |
| `PM_ENV_FILE` | `/etc/ai-pm-agent.env` | PM bot token and `PM_SNAPSHOT_FILE`; skipped if absent |
| `PM_SERVICE` | `ai-pm-agent` | PM agent unit |
| `MONITORED_SERVICES` | `ai-coding-agent,ai-pm-agent,ai-ops-agent` | units on the launcher |
| `DASHBOARD_STATE_DIR` | `/var/lib/ai-dashboard` | the dashboard's own state (disk history) |
| `DASHBOARD_CLEANUP_COMMAND` | `/usr/local/sbin/ai-cleanup` | disk report and cleanup (from ai-ops-agent) |
| `DASHBOARD_SERVICE_COMMAND` | `/usr/local/sbin/ai-service` | service list and restarts (from ai-ops-agent) |

All bots' `YOUR_CHAT_ID` must match; otherwise the dashboard refuses to start.

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

The Ruff configuration enforces the Python rules for naming, imports,
88-character lines, annotations, public and constructor docstrings, and mutable
defaults. Run `ruff format ai_dashboard tests` before committing.

Local process execution and timeout cleanup live in `ai_dashboard/commands.py`.
Health readers collect measurements; `ai_dashboard/problems.py` evaluates those
readings into the overview's ordered problem list. See the
[Python rules audit](docs/python-rules-audit.md) for the review and validation.

### Page tests

The page lives in `ai_dashboard/static/`: `index.html`, `styles.css`, and
scripts split by role under `js/` (`api.js` network, `router.js` navigation,
`dom.js` element helpers, `app.js` the shell, one file per window in
`js/views/`). The server serves them under `/static/` with `no-store`. The
page's navigation logic is tested in a simulated browser (jsdom) with a
deliberately slow server and a request that never answers, so navigation
races show up:

```bash
npm install && npm test
```

## Disk trend

A single reading ("63% used") hides how fast the disk is filling. The dashboard
records disk usage once an hour (`DASHBOARD_STATE_DIR/disk-history.json`, last
14 days) and shows growth per day and time until full, from a least-squares fit
over the last 3 days. It needs about 6 hours of readings before showing a trend.
It warns when the disk will be full within 30 days, and reports an error within 7.
Alarms need history: no warning before 24 hours of readings and no error before
48, because a few hours extrapolated over days is mostly noise. Until there are
3 days of readings the trend says how many hours it is based on.

Each agent row also shows how long its service has been up, from systemd's
boot-relative start time; a deploy or a crash restart resets it.
## Deploy

With `ai-dashboard` as the coding agent's active project (`/repo_use`),
`/deploy <branch>` runs `/usr/local/sbin/update-ai-dashboard`: fetch, fast-forward,
install requirements, restart `ai-dashboard`, and confirm it came back up. The
log is `/var/log/ai-dashboard/update.log`.

`setup-dashboard-https.sh` installs the script. On an existing server, once:

```bash
sudo install -m 755 /opt/ai-dashboard/deploy/update-ai-dashboard /usr/local/sbin/
```

The script uses the clone's own remote (the repo is public), not the agents'
deploy key, which GitHub scopes to a single repository.

### Provider limits

The Coding window includes a Limits card with cached Codex account quota windows,
percentage remaining, reset times and reading age. The agent refreshes quota
every five minutes through its authenticated Codex app-server; dashboard
refreshes do not make provider requests. Older snapshots show a waiting state.
Claude API rate limits appear after `/limits claude` in Telegram; that explicit
check consumes one tiny API request and is separate from Claude Code plan usage.
Failed or old readings are labeled as last known data.

Claude Code subscription limits appear separately from Claude API limits. Their
5-hour and weekly readings come from an interactive Claude Code status line on
the coding-agent server. They update when that session supplies new data, not
on a timer; headless bot runs do not supply status-line percentages. Reading
age remains visible and the publisher drops expired quota windows.

## Disk cleanup (Ops window)

The Ops window shows what fills the disk (cleanable categories and the largest
directories) and a **Clean up** button. Both come from the ops agent's
`ai-cleanup` script (see the ai-ops-agent README), so the dashboard and the ops
bot share one implementation.

- The report refreshes every 10 minutes in the background and after each run.
- The button asks for confirmation (Telegram's dialog), then sends
  `POST /api/ops/cleanup`. The request has no options: the set of cleanups is
  fixed by `ai-cleanup`, so nothing from the page reaches a command line.
- The endpoint needs the owner's signed Telegram data like every data request.
  A GET cannot start a cleanup.
- One cleanup at a time: a second request gets 409. The page polls the Ops
  window and shows the result, including any step that failed.
- If `ai-cleanup` is not installed, the Ops window says so instead of
  showing a button.

## PM Todos workspace

The PM window provides project selection and creation, search, status/priority
filters, priority sorting, add/edit/delete, completion and reopening. Long items
use two-line previews and a full editor. Drafts, focused inputs and filter state
survive heartbeat refreshes. Versions move into About; the existing Rules card
remains read-only in this first phase.

Editing requires the PM repository's `/usr/local/sbin/ai-pm-todos` bridge. Deploy
ai-pm-agent and install its `deploy/ai-pm-todos` wrapper first, then deploy this
dashboard. `DASHBOARD_PM_COMMAND` can override the trusted executable path.
Without it, the PM snapshot remains visible with an editing-unavailable message.

Owner-signed Telegram authentication is required for workspace reads and actions.
GET only reads; POST `/api/pm/action` accepts fixed JSON operations. Task edits
carry project, stable ID and revision. The PM service owns all parsing and Git
publishing. Push failures display “saved locally”; Sync todos retries publication.
Conflicts preserve the editor draft: cancel to refresh, then review and reapply.

PM select controls use an explicit theme palette and native color scheme, with
custom closed-control arrows to keep selected values readable in Telegram
WebViews. The controls retain native keyboard and option selection behavior.

In PM editors, Telegram Back returns to the Todos list first. Editors also show
a Back to todos button near the top; Cancel has the same navigation behavior.
A subsequent Back leaves PM for the overview. Leaving PM clears the editor
subview so reopening PM starts at the list.

### Deployment status and rollback in Ops

The Ops window reads the fixed local `/usr/local/sbin/ai-deploy status` bridge
installed from the ai-ops-agent deployment manager. It lists the coding, PM,
Ops, and dashboard services, their recorded deployed version and commit, and
any previous verified revision. If the manager is missing, the card explains
that installation is needed. `DASHBOARD_DEPLOYMENT_COMMAND` can override the
executable path for a custom installation.

A **Roll back** button appears only for a recorded, verified previous revision.
Confirmation names the service and revision. The owner-authenticated POST queues
an independent systemd job; the dashboard never runs the restart inside its own
HTTP process. The page polls status and shows queued/running/failure states.
GET cannot initiate rollback, targets are fixed, and a stale confirmation is
rejected if the rollback revision changed. Install and initialize the manager
following the ai-ops-agent README before using these controls; Git history alone
is not proof that a revision is safe to roll back to.

## Coding setup (Coding window)

The Coding window's **Setup** card opens two sub-windows; Back returns to the
Coding window.

- **Projects** (`/coding/projects`): switch the active project, or add a
  repository (`owner/repo`; the agent clones it). Switching is disabled while
  the agent runs or has queued tasks, with the reason shown.
- **AI tools** (`/coding/ai`): planner and implementer (`codex` / `claude`),
  and models. The Claude API model can be switched (after a confirmation; the
  agent verifies it and restarts). Codex and Claude Code models are read-only,
  because they live in those CLIs' own configs.

The dashboard never changes the agent's state itself. `POST /api/coding/actions`
(owner's signed Telegram data, JSON body, at most 4 KB) checks the request and
writes it into the agent's inbox (`AGENT_INBOX_DIR` from the coding agent's env
file). The agent validates it again and runs it with the same code as its
Telegram commands; the result appears in its snapshot and the page shows it.
Requests are refused with 503 while the agent's service is not running.

A refresh never replaces the page while you type in one of its fields.

## Changing an agent from the dashboard: which pattern

Two patterns exist on purpose; pick by where the agent keeps the state:

- **State in files** (PM todos, disk cleanup): a fixed command owned by the
  agent's repo, JSON in and out, run by the dashboard and answered at once
  (`pm_bridge.py`, `maintenance.py`). The running agent need not be involved.
- **State in the running agent's memory** (coding agent: planner, implementer,
  active project, model): only that process can change it, so the dashboard
  drops a request into the agent's inbox and shows the result the agent
  publishes (`agent_actions.py`; `ai_agent/inbox.py` in the coding agent).

Either way the dashboard never edits an agent's state directly, every request
needs the owner's signed Telegram data, and the agent side validates again.

## Services and logs (Ops window)

- **Services**: every service in the ops agent's whitelist (`ai-service list`)
  with its state and uptime, and a **Restart** button (confirmation first; it
  warns when the coding agent is running a task, and when restarting the
  dashboard itself). `POST /api/ops/restart` takes only `{"service": name}`;
  the restart is queued, so the dashboard answers before it goes down.
- **Logs**: the last 80 journal lines of one service, or its errors from the
  last 24 hours. Loaded on demand (not by the 5-second refresh). `GET
  /api/ops/logs?unit=&errors=` reads only units the dashboard monitors.
