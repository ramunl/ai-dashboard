#!/usr/bin/env bash
#
# migrate-from-coding-agent.sh  (one-time)
#
# Moves the Mini App dashboard out of the coding agent into its own service,
# behind the SAME public address. Caddy is not touched: it keeps forwarding to
# 127.0.0.1:<port>, and only what listens there changes.
#
# Before running:
#   1. Deploy the coding agent version WITHOUT the built-in dashboard
#      (it publishes /var/lib/ai-coding-agent/snapshot.json instead).
#   2. git clone the ai-dashboard repo to /opt/ai-dashboard.
#
# Every step checks first and stops with an explanation. If the new service
# does not come up, the coding agent's env file is left untouched, so rolling
# back is just redeploying the previous coding agent version.
#
# Usage:  sudo bash migrate-from-coding-agent.sh
#
set -euo pipefail

CODING_DIR="/opt/ai-coding-agent"
CODING_ENV="/etc/ai-coding-agent/ai-coding-agent.env"
CODING_SERVICE="ai-coding-agent"
APP_DIR="/opt/ai-dashboard"
VENV="/opt/ai_dashboard_venv"
ENV_FILE="/etc/ai-dashboard/ai-dashboard.env"
UNIT_FILE="/etc/systemd/system/ai-dashboard.service"
SERVICE="ai-dashboard"

say()   { printf '\n=== %s ===\n' "$*"; }
ok()    { printf '    OK: %s\n' "$*"; }
stop()  { printf '\nSTOP: %s\n' "$*" >&2; exit 1; }
stamp() { date +%Y%m%d-%H%M%S; }
# A missing key yields "", not a pipefail exit, so callers can explain or default.
env_value() { { grep -E "^$1=" "$2" 2>/dev/null || true; } | tail -1 | cut -d= -f2- | sed -E "s/^[\"']|[\"']$//g"; }

[ "$(id -u)" -eq 0 ] || stop "run as root: sudo bash $0"

# --------------------------------------------------------------------------
say "1. Coding agent is on the version without the built-in dashboard"
[ -f "${CODING_DIR}/ai_agent/bot/snapshot_publisher.py" ] \
  || stop "${CODING_DIR} does not publish a snapshot yet. Deploy the new coding agent first."
[ ! -f "${CODING_DIR}/ai_agent/bot/webapp.py" ] \
  || stop "${CODING_DIR} still contains the built-in dashboard. Deploy the new coding agent first."
ok "coding agent code updated"

# --------------------------------------------------------------------------
say "2. Existing public address"
URL="$(env_value WEBAPP_URL "${CODING_ENV}")"
[[ "${URL}" == https://* ]] \
  || stop "no https WEBAPP_URL in ${CODING_ENV} to reuse. Run setup-dashboard-https.sh instead."
PORT="$(env_value WEBAPP_PORT "${CODING_ENV}")"
PORT="${PORT:-8787}"
[[ "${PORT}" =~ ^[0-9]+$ ]] || stop "WEBAPP_PORT in ${CODING_ENV} is not a number: '${PORT}'"
ok "reusing ${URL} (Caddy -> 127.0.0.1:${PORT})"

# --------------------------------------------------------------------------
say "3. Free port ${PORT} from the old in-process dashboard"
# ss names the process "python", so recognise our own dashboard by its PID;
# that keeps a re-run from mistaking the dashboard for a conflict.
holder() {
  local own
  own="$(systemctl show -p MainPID --value "${SERVICE}" 2>/dev/null || echo 0)"
  ss -ltnpH "sport = :${PORT}" | grep -v "pid=${own}," || true
}
if [ -n "$(holder)" ]; then
  # The running coding agent may still be the old build holding the port.
  systemctl restart "${CODING_SERVICE}"
  for _ in $(seq 1 15); do [ -z "$(holder)" ] && break; sleep 1; done
fi
[ -z "$(holder)" ] || stop "something still listens on ${PORT}:
$(holder)"
ok "port ${PORT} free"

# --------------------------------------------------------------------------
say "4. Coding agent publishes its snapshot"
SNAPSHOT="$(env_value AGENT_SNAPSHOT_FILE "${CODING_ENV}")"
SNAPSHOT="${SNAPSHOT:-/var/lib/ai-coding-agent/snapshot.json}"
systemctl is-active --quiet "${CODING_SERVICE}" || systemctl restart "${CODING_SERVICE}"
for _ in $(seq 1 20); do [ -s "${SNAPSHOT}" ] && break; sleep 1; done
[ -s "${SNAPSHOT}" ] || stop "${SNAPSHOT} did not appear. Check: journalctl -u ${CODING_SERVICE} -n 50 --no-pager"
ok "${SNAPSHOT} present"

# --------------------------------------------------------------------------
say "5. Dashboard code, venv, unit"
[ -f "${APP_DIR}/ai_dashboard/__main__.py" ] || stop "clone the ai-dashboard repo to ${APP_DIR} first."
[ -x "${VENV}/bin/python" ] || python3 -m venv "${VENV}"
"${VENV}/bin/pip" install -q -r "${APP_DIR}/requirements.txt"
install -m 644 "${APP_DIR}/deploy/ai-dashboard.service" "${UNIT_FILE}"
systemctl daemon-reload
ok "venv ${VENV} and ${UNIT_FILE} installed"

# --------------------------------------------------------------------------
say "6. Dashboard configuration"
install -d -m 700 "$(dirname "${ENV_FILE}")"
[ ! -f "${ENV_FILE}" ] || cp "${ENV_FILE}" "${ENV_FILE}.bak.$(stamp)"
umask 077
printf 'DASHBOARD_PUBLIC_URL=%s\nDASHBOARD_PORT=%s\nCODING_ENV_FILE=%s\nCODING_SERVICE=%s\n' \
  "${URL}" "${PORT}" "${CODING_ENV}" "${CODING_SERVICE}" > "${ENV_FILE}"
ok "${ENV_FILE} written"

# --------------------------------------------------------------------------
say "7. Start the dashboard"
systemctl enable "${SERVICE}" >/dev/null
systemctl restart "${SERVICE}"
for _ in $(seq 1 20); do curl -sf "http://127.0.0.1:${PORT}/healthz" >/dev/null && break; sleep 1; done
curl -sf "http://127.0.0.1:${PORT}/healthz" >/dev/null \
  || stop "the dashboard is not answering locally. Check: journalctl -u ${SERVICE} -n 50 --no-pager"
ok "answering on 127.0.0.1:${PORT}"
curl -sf --max-time 10 "${URL}/healthz" >/dev/null \
  || stop "${URL}/healthz is not reachable through Caddy. Check: journalctl -u caddy -n 30 --no-pager"
ok "reachable at ${URL}"

# --------------------------------------------------------------------------
say "8. Tidy the coding agent's env file"
# The coding agent no longer reads these; remove them so nothing looks configured
# that isn't. Only now, after the new service is confirmed working.
if grep -qE '^WEBAPP_(URL|HOST|PORT)=' "${CODING_ENV}"; then
  cp "${CODING_ENV}" "${CODING_ENV}.bak.$(stamp)"
  sed -i -E '/^WEBAPP_(URL|HOST|PORT)=/d' "${CODING_ENV}"
  ok "removed WEBAPP_* from ${CODING_ENV} (backed up; no restart needed)"
fi

say "DONE"
echo "The dashboard now runs as its own service (${SERVICE}) at ${URL}."
echo "It pointed the Coding bot's Dashboard button at ${URL}/coding."
echo "Reopen the Coding Agent chat and tap Dashboard."
echo
echo "Logs:   journalctl -u ${SERVICE} -f"
echo "Status: systemctl status ${SERVICE}"
