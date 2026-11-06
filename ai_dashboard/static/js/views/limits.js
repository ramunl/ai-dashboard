// Provider quota readings published by the coding agent; no browser provider
// calls. The rows come from the DS05 registry's providers (static/js/registry.js)
// and fall back to the legacy Codex / Claude Code / Claude API rows on an old
// snapshot. Subscription quota, API balance and per-minute API rate limits stay
// separate readings: funds are never relabelled as a quota window.
function quotaWindowLabel(window) {
  const minutes = window.window_minutes;
  if (!Number.isFinite(minutes)) return window.bucket;
  const duration = minutes === 10080 ? "Weekly"
    : minutes >= 1440 ? `${minutes / 1440}-day`
    : minutes >= 60 ? `${minutes / 60}-hour` : `${minutes}-minute`;
  return `${window.bucket} · ${duration}`;
}

function limitReset(timestamp) {
  if (!timestamp) return "Reset time unavailable";
  const date = new Date(timestamp * 1000);
  return Number.isNaN(date.getTime()) ? "Reset time unavailable"
    : `Resets ${date.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}`;
}

// A reading describes its window only until that window resets; after that the
// numbers are history, not what is left now.
function hasResetSince(resetSeconds) {
  return Number.isFinite(resetSeconds) && resetSeconds * 1000 <= Date.now();
}

function clockTime(seconds) {
  return new Date(seconds * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// Subscription quota: windows with a percentage remaining and a reset time.
function quotaLimitRows(limits) {
  const rows = [];
  for (const window of limits.windows || []) {
    if (hasResetSince(window.resets_at)) {
      rows.push(row(quotaWindowLabel(window), "reset since this reading"),
        muted(`Window reset at ${clockTime(window.resets_at)}; the next check shows the new numbers`));
      continue;
    }
    rows.push(row(quotaWindowLabel(window), `${window.remaining_percent}% remaining`));
    const meter = el("progress", null, "usage-meter");
    meter.max = 100;
    meter.value = window.remaining_percent;
    meter.setAttribute("aria-label", `${quotaWindowLabel(window)} quota remaining`);
    rows.push(meter, muted(limitReset(window.resets_at)));
  }
  return rows;
}

// API funds on the account, if the agent reported them. These are money left
// to spend, not a quota window, so they are never drawn as a usage meter.
function apiBalanceRows(limits) {
  const balance = limits && typeof limits.balance === "object" && limits.balance ? limits.balance : null;
  if (!balance || typeof balance.amount !== "number" || !Number.isFinite(balance.amount)) return [];
  const amount = balance.amount.toFixed(2);
  const currency = typeof balance.currency === "string" && balance.currency ? ` ${balance.currency}` : "";
  const stale = balance.stale === true || balance.stale === false
    ? (balance.stale === true ? " · last known reading" : "") : " · freshness unknown";
  const rows = [row("API balance", `${amount}${currency}`)];
  if (balance.checked_at) rows.push(muted(`Read ${formatDuration(Math.max(0, Date.now() / 1000 - balance.checked_at))} ago${stale}`));
  else rows.push(muted("Balance check time unavailable"));
  return rows;
}

// API headers are per-minute rate limits from the agent's last API call (reset
// given as an ISO time), not spending: once the minute is over they are full
// again, so an old reading must not look like current usage.
function apiLimitRows(limits) {
  const windows = limits.windows || [];
  const rows = apiBalanceRows(limits);
  if (!windows.length) return rows;
  rows.push(muted("Per-minute rate limits from the last API call, not spending"));
  for (const window of windows) {
    const reset = Date.parse(window.reset) / 1000;
    if (hasResetSince(reset)) {
      rows.push(row(window.bucket, `full (${window.limit ?? "—"} per minute)`));
      continue;
    }
    rows.push(row(window.bucket, `${window.remaining ?? "—"}/${window.limit ?? "—"} remaining`),
      muted(Number.isFinite(reset) ? `Resets at ${clockTime(reset)}` : "Reset time unavailable"));
  }
  return rows;
}

function providerLimitRows(name, limits, renderRows, kind) {
  if (!limits) return [row(name, "Waiting for a limits reading")];
  const rows = [row(name, limits.status === "ok" ? "Available" : limits.message)];
  if (limits.status === "ok" && limits.message) rows.push(muted(limits.message));
  if (limits.checked_at) {
    const age = Math.max(0, Math.round((Date.now() / 1000 - limits.checked_at) / 60));
    rows.push(muted(kind === "api"
      ? `Read ${formatDuration(Math.max(0, Date.now() / 1000 - limits.checked_at))} ago · last known reading`
      : `Checked ${age} min ago${age >= 10 || limits.status !== "ok" ? " · last known reading" : ""}`));
  }
  rows.push(...renderRows(limits));
  return rows;
}

function limitsCard(limits, registry) {
  const providers = codingRegistryProviders(registry) || LEGACY_LIMIT_PROVIDERS;
  const nodes = [];
  for (const provider of providers) {
    const reading = limits && typeof limits === "object" ? limits[provider.limits] : null;
    nodes.push(...providerLimitRows(provider.label, reading,
      provider.kind === "api" ? apiLimitRows : quotaLimitRows, provider.kind));
  }
  return card("Limits", ...nodes);
}
