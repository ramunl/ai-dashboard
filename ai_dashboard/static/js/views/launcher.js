// Launcher (/): server health, services, problems, links to the agent windows.
const SEVERITY_STATUS = { error: "bad", warning: "warn", info: "info" };

function navRow(agent) {
  const state = agent.load_state === "not-found" ? "not installed" : agent.service || "unknown";
  const status = state !== "active" ? "bad"
    : agent.problem || agent.restarts >= 3 || agent.errors_last_hour > 0 ? "warn" : "ok";
  const detail = [state, agent.detail, agent.problem];
  if (agent.restarts) detail.push(`${agent.restarts} restarts`);
  if (agent.errors_last_hour) detail.push(`${agent.errors_last_hour} errors/1h`);
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
  ];
}

function launcherPage(view) {
  const resources = view.resources;
  const worst = view.problems.length ? view.problems[0].severity : null;
  const problems = view.problems.length ? view.problems.map(problemRow) : [muted("All good")];
  const agents = view.agents.length
    ? view.agents.map(navRow)
    : [muted("No agents configured")];
  return {
    title: "AI Agents",
    subtitle: resources
      ? `${resources.hostname} · up ${formatDuration(resources.uptime_seconds)}`
      : "",
    status: worst === "error" ? "bad" : worst === "warning" ? "warn" : "ok",
    alert: "",
    nodes: [
      el("div", view.problems.length ? `${view.problems.length} items need attention` : "All systems healthy", "health-summary"),
      ...(view.problems.length ? [card("Needs attention", ...problems)] : []),
      card("Agents", ...agents),
      card("Server resources", ...resourceRows(resources)),
    ],
  };
}

function opsPage(view) {
  const overview = launcherPage(view);
  const ops = view.agents.find((agent) => agent.name === "ops");
  const diagnostics = ops
    ? [row("Service", ops.service), row("Restarts", ops.restarts || 0),
       row("Errors in last hour", ops.errors_last_hour || 0)]
    : [muted("Ops agent is not configured")];
  return { ...overview, title: "Ops agent", nodes: [card("Operations", ...diagnostics),
    ...(view.problems.length ? [overview.nodes[1]] : []), overview.nodes.at(-1)] };
}
