// Overview (/) and Ops (/ops): problems, agents with their status, server health.
const SEVERITY_STATUS = { error: "bad", warning: "warn", info: "info" };

function navRow(agent) {
  const state = agent.load_state === "not-found" ? "not installed" : agent.service || "unknown";
  const status = state !== "active" ? "bad"
    : agent.problem || agent.restarts >= 3 || agent.errors_last_hour > 0 ? "warn" : "ok";
  const detail = [state, agent.detail, agent.problem];
  if (agent.restarts) detail.push(`${agent.restarts} restarts`);
  if (agent.errors_last_hour) detail.push(`${agent.errors_last_hour} errors/1h`);
  if (typeof agent.up_seconds === "number") detail.push(`up ${formatDuration(agent.up_seconds)}`);
  const node = el("a", null, "nav-row");
  node.href = "/" + agent.path;
  node.addEventListener("click", (event) => {
    event.preventDefault();
    navigate(agent.path);
  });
  const text = el("div");
  const title = el("div");
  title.append(statusDot(status), " ", agent.label);
  text.append(title, el("div", detail.filter(Boolean).join(" · "), "nav-detail"));
  node.append(text, el("span", "›", "nav-chevron"));
  return node;
}

function problemRow(problem) {
  const node = el("div", null, "problem");
  const status = SEVERITY_STATUS[problem.severity] || "info";
  node.append(statusDot(status), el("span", `${STATUS_LABELS[status]}: ${problem.text}`));
  return node;
}

function usageMeter(used, total, label) {
  const meter = el("progress", null, "usage-meter");
  meter.max = total > 0 ? total : 1;
  meter.value = Math.max(0, used);
  meter.setAttribute("aria-label", label);
  return meter;
}

function resourceRows(resources) {
  if (!resources) return [muted("Resources unavailable")];
  const { load, cpus, memory, disk } = resources;
  const diskPercent = Math.round((100 * disk.used) / disk.total);
  return [
    row("Load", `${load.map((x) => x.toFixed(2)).join(" / ")} (${cpus} CPU)`),
    row("Memory", `${formatBytes(memory.total - memory.available)} of ${formatBytes(memory.total)}`),
    usageMeter(memory.total - memory.available, memory.total, "Memory usage"),
    row("Disk", `${formatBytes(disk.used)} of ${formatBytes(disk.total)} (${diskPercent}%)`),
    usageMeter(disk.used, disk.total, "Disk usage"),
    row("Disk trend", diskTrendText(disk.trend)),
  ];
}

function diskTrendText(trend) {
  if (!trend) return "after a few hours of readings";
  if (trend.days_until_full === null) return "not growing";
  return `+${formatBytes(trend.bytes_per_day)}/day · full in ~${Math.round(trend.days_until_full)} days`;
}

// Cards shared by the overview and the Ops window. Each page picks the cards
// it wants by name, so reordering one page can never change the other.
function pageStatus(view) {
  const worst = view.problems.length ? view.problems[0].severity : null;
  return worst === "error" ? "bad" : worst === "warning" ? "warn" : "ok";
}

function healthSummary(view) {
  const text = view.problems.length
    ? `${view.problems.length} items need attention`
    : "All systems healthy";
  return el("div", text, "health-summary");
}

function problemsCards(view) {
  return view.problems.length ? [card("Needs attention", ...view.problems.map(problemRow))] : [];
}

function agentsCard(view) {
  const rows = view.agents.length ? view.agents.map(navRow) : [muted("No agents configured")];
  return card("Agents", ...rows);
}

function resourcesCard(view) {
  return card("Server resources", ...resourceRows(view.resources));
}

function operationsCard(view) {
  const ops = view.agents.find((agent) => agent.name === "ops");
  if (!ops) return card("Operations", muted("Ops agent is not configured"));
  const rows = [
    row("Service", ops.service),
    row("Restarts", ops.restarts || 0),
    row("Errors in last hour", ops.errors_last_hour || 0),
  ];
  if (typeof ops.up_seconds === "number") rows.push(row("Up", formatDuration(ops.up_seconds)));
  return card("Operations", ...rows);
}

function serverSubtitle(view) {
  const resources = view.resources;
  return resources ? `${resources.hostname} · up ${formatDuration(resources.uptime_seconds)}` : "";
}

function launcherPage(view) {
  return {
    title: "AI Agents",
    subtitle: serverSubtitle(view),
    status: pageStatus(view),
    alert: "",
    nodes: [healthSummary(view), ...problemsCards(view), agentsCard(view), resourcesCard(view)],
  };
}

function opsPage(view) {
  return {
    title: "Ops agent",
    subtitle: serverSubtitle(view),
    status: pageStatus(view),
    alert: "",
    nodes: [operationsCard(view), ...problemsCards(view), resourcesCard(view)],
  };
}
