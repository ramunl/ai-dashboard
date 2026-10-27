// Coding snapshot contract: ai-coding-agent 67d9a93, docs/snapshot_publisher.py.md.
// setup.models[].auth is additive to format 2. Authentication is independent
// of tool versions, model selection, quota and the snapshot heartbeat.
function codingAuthTimestamp(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 &&
    Number.isFinite(new Date(value * 1000).getTime());
}

function codingAuthToolNodes(label, auth, now) {
  const nodes = [el("h3", label, "card-subtitle")];
  if (!auth || typeof auth !== "object" || Array.isArray(auth)) {
    nodes.push(muted("Authentication unknown — no observation in this snapshot."));
    nodes.push(row("Last checked", "Unknown"), row("Relogin", "Countdown unavailable"));
    return nodes;
  }
  const statuses = new Map([
    ["authenticated", "Authenticated"], ["logged_out", "Logged out"],
    ["configured_unverified", "Configured, unverified"],
    ["unknown", "Unknown"], ["unavailable", "Check unavailable"],
  ]);
  const methods = new Map([
    ["oauth", "OAuth"], ["api_key", "API key"], ["api_key_helper", "API key helper"],
    ["third_party", "Third party"], ["none", "None"], ["unknown", "Unknown"],
  ]);
  const warnings = Array.isArray(auth.warnings) ? auth.warnings : [];
  const checked = codingAuthTimestamp(auth.checked_at) && auth.checked_at <= now;
  // A failed retry preserves the old successful status. Never present it as
  // fresh just because the heartbeat or browser request succeeded.
  const stale = auth.stale !== false || !checked || now - auth.checked_at >= 900 ||
    warnings.includes("auth_stale") || warnings.includes("check_unavailable");
  const status = statuses.get(auth.status) || "Unknown (unrecognized status)";
  nodes.push(row("Status", statusText(stale ? "warn" : auth.status === "authenticated" ? "ok" : "warn",
    stale ? `${status} — historical / unverified` : status)));
  nodes.push(row("Method", methods.get(auth.method) || "Unknown"));
  nodes.push(row("Last checked", checked ? new Date(auth.checked_at * 1000).toLocaleString() : "Unknown (missing or invalid timestamp)"));
  if (stale) nodes.push(el("div", "Observation stale or freshness unknown; current authentication is unverified.", "card-note"));
  let countdown = "Countdown unavailable (missing or unknown support)";
  if (auth.countdown_support === "no_authoritative_deadline") {
    countdown = "Unsupported — no authoritative relogin deadline";
  } else if (auth.countdown_support === "supported") {
    if (!codingAuthTimestamp(auth.relogin_at)) countdown = "Countdown unavailable (missing or invalid deadline)";
    else if (stale) countdown = "Countdown unavailable until a fresh check confirms the deadline";
    else {
      const remaining = auth.relogin_at - now;
      const days = Math.ceil(remaining / 86400);
      countdown = remaining <= 0 ? "Overdue — relogin required" : remaining < 86400
        ? "Under one day remaining" : `${days} ${days === 1 ? "day" : "days"} remaining`;
    }
  }
  nodes.push(row("Relogin", countdown));
  const warningLabels = new Map([
    ["login_required", "Login required"], ["relogin_soon", "Relogin soon"],
    ["check_unavailable", "Authentication check failed or unavailable"],
    ["auth_stale", "Authentication observation stale"],
  ]);
  for (const warning of warnings) {
    const message = typeof warning === "string"
      ? warningLabels.get(warning) || `Unknown warning: ${warning}` : "Malformed authentication warning";
    nodes.push(el("div", `${stale ? "Historical / unverified warning" : "Warning"}: ${message}`, "card-note"));
  }
  if (!Array.isArray(auth.warnings)) nodes.push(muted("Warnings unavailable (missing or malformed field)."));
  return nodes;
}

function codingAuthCard(setup, now = Date.now() / 1000) {
  const models = setup && Array.isArray(setup.models) ? setup.models : [];
  const nodes = [muted("Snapshot observations only. Authentication does not confirm quota or successful AI requests.")];
  for (const [tool, label] of [["codex", "Codex"], ["claude-code", "Claude Code"], ["claude", "Claude API"]]) {
    const entries = models.filter((entry) => entry && entry.tool === tool);
    nodes.push(...codingAuthToolNodes(label, entries.length === 1 ? entries[0].auth : null, now));
  }
  return card("Authentication", ...nodes);
}
