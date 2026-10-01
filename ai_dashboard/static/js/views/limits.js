// Provider quota readings published by the coding agent; no browser provider calls.
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

function quotaLimitRows(limits) {
  const rows = [];
  for (const window of limits.windows || []) {
    rows.push(row(quotaWindowLabel(window), `${window.remaining_percent}% remaining`));
    const meter = el("progress", null, "usage-meter");
    meter.max = 100;
    meter.value = window.remaining_percent;
    meter.setAttribute("aria-label", `${quotaWindowLabel(window)} quota remaining`);
    rows.push(meter, muted(limitReset(window.resets_at)));
  }
  return rows;
}

function claudeLimitRows(limits) {
  return (limits.windows || []).flatMap((window) => [
    row(window.bucket, `${window.remaining ?? "—"}/${window.limit ?? "—"} remaining`),
    muted(window.reset ? `Resets ${window.reset}` : "Reset time unavailable"),
  ]);
}

function providerLimitRows(name, limits, renderRows) {
  if (!limits) return [row(name, "Waiting for a limits reading")];
  const rows = [row(name, limits.status === "ok" ? "Available" : limits.message)];
  if (limits.status === "ok" && limits.message) rows.push(muted(limits.message));
  if (limits.checked_at) {
    const age = Math.max(0, Math.round((Date.now() / 1000 - limits.checked_at) / 60));
    rows.push(muted(`Checked ${age} min ago${age >= 10 || limits.status !== "ok" ? " · last known reading" : ""}`));
  }
  rows.push(...renderRows(limits));
  return rows;
}

function limitsCard(limits) {
  return card("Limits",
    ...providerLimitRows("Codex", limits && limits.codex, quotaLimitRows),
    ...providerLimitRows("Claude Code", limits && limits.claude_code, quotaLimitRows),
    ...providerLimitRows("Claude API", limits && limits.claude, claudeLimitRows),
  );
}
