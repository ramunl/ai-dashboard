// Service counts have different meanings: never sum them into "online people".
function clientsRefreshButton(running) {
  const button = el("button", running ? "Refreshing…" : "Refresh clients", "action-button");
  button.type = "button";
  button.disabled = Boolean(running);
  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      await postAction("ops/clients", tg ? tg.initData : "");
      refresh();
    } catch (error) {
      button.disabled = false;
      showAlert(`Client refresh did not start: ${error.message}`);
    }
  });
  return button;
}

function clientTrafficRows(service) {
  const rows = [];
  const fields = [["rx_bytes", "Uploaded by clients"], ["tx_bytes", "Downloaded by clients"], ["traffic_bytes", "Combined traffic"]];
  for (const [key, label] of fields) {
    if (typeof service[key] !== "number") continue;
    rows.push(row(`${label}, current counters`, formatBytes(service[key])));
    const speed = service[key.replace("_bytes", "_bps")];
    if (typeof speed === "number") rows.push(row(`${label}, recent rate`, `${formatBytes(speed)}/s`));
    const daily = (service.sample || {}).daily || {};
    if (typeof daily[key] === "number") rows.push(row(`${label}, sampled today`, formatBytes(daily[key])));
  }
  return rows;
}

function clientServiceDetails(service) {
  const serviceKey = service.id || service.name;
  const details = rememberDetails(el("details", null, "clients-service"), ["clients", serviceKey]);
  const count = service.available && typeof service.active === "number"
    ? `${service.active.toLocaleString("en-US")} ${service.unit}` : "Unavailable";
  details.append(el("summary", `${service.name} · ${count}`));
  if (!service.available) details.append(el("p", service.error || "Service data unavailable", "card-note"));
  const fields = [["configured", "Configured profiles"], ["connections", "Incoming TCP connections"],
    ["source_addresses", "Distinct source addresses"], ["streams", "Live streams"],
    ["protocol_connections", "mtg client connections"], ["fronting_connections", "mtg fronting connections"],
    ["sessions_total", "Sessions since service start"], ["streams_total", "Streams since service start"],
    ["rejected_total", "Rejected / limited"], ["replay_total", "Replay attempts"],
    ["dial_failures_total", "Backend dial failures"], ["limit_hits_total", "Limit hits"], ["pending_bytes", "Queued bytes"]];
  for (const [key, label] of fields) {
    if (typeof service[key] === "number") details.append(row(label, service[key].toLocaleString("en-US")));
  }
  if (service.sample) {
    details.append(row("Sampled peak today", String(service.sample.peak)),
      el("p", `Daily sampling since ${new Date(service.sample.since * 1000).toLocaleString()}. Day boundary: UTC.`, "card-note"));
    if (service.sample.incomplete) details.append(el("p", "Sampling has gaps or a counter reset; daily usage may be incomplete.", "card-note"));
  }
  details.append(...clientTrafficRows(service));
  if (service.available && !["rx_bytes", "tx_bytes", "traffic_bytes"].some(key => typeof service[key] === "number")) details.append(el("p", "Traffic counters unavailable for this service.", "card-note"));
  for (const client of service.clients || []) {
    const state = typeof client.active === "boolean" ? (client.active ? "recently active" : "idle / offline") : `${client.connections} connections`;
    const item = rememberDetails(el("details", null, "clients-peer"), ["clients", serviceKey, client.id || client.name]);
    item.append(el("summary", `${client.name} · ${state}`));
    if ("last_seen_seconds" in client) item.append(row("Last handshake", client.last_seen_seconds === null ? "Never" : `${formatDuration(client.last_seen_seconds)} ago`));
    if (typeof client.rx_bytes === "number") item.append(row("Uploaded", formatBytes(client.rx_bytes)), row("Downloaded", formatBytes(client.tx_bytes)));
    details.append(item);
  }
  if (service.details_truncated) details.append(el("p", "Showing the first 50 clients; totals include all clients.", "card-note"));
  if (service.metrics_available === false) details.append(el("p", "Native traffic metrics unavailable; socket counts still shown where available.", "card-note"));
  details.append(el("p", service.note || "", "card-note"));
  return details;
}

function clientsCard(view) {
  const state = view.clients || {};
  const report = state.report;
  const nodes = [el("p", "Devices, sessions and connections per service. One person may use several; source addresses can be shared.", "card-note")];
  if (!report) nodes.push(muted("Waiting for the first client sample…"));
  else if (!report.ok) nodes.push(el("p", report.error || "Client sample failed", "card-note"));
  else {
    const age = Math.max(0, Date.now() / 1000 - report.checked_at);
    nodes.push(el("p", `Updated ${formatDuration(age)} ago · refreshes every 30 seconds while open`, "card-note"));
    if (age > 120) nodes.push(el("p", "These readings are stale.", "card-note"));
    nodes.push(...(report.services || []).map(clientServiceDetails));
  }
  nodes.push(clientsRefreshButton(state.running));
  return card("Connected clients", ...nodes);
}
