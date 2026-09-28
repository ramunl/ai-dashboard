// Launcher (/): server health, services, problems, links to the agent windows.
const SEVERITY_STATUS = { error: "bad", warning: "warn", info: "info" };

function navRow(agent) {
  const isDown = agent.service !== "active" || Boolean(agent.problem);
  const detail = isDown
    ? [STATUS_LABELS.bad, agent.problem || `service ${agent.service}`, agent.detail]
    : [agent.detail];
  const node = el("a", null, "nav-row");
  node.href = "/" + agent.path;
  node.addEventListener("click", (event) => {
    event.preventDefault();
    navigate(agent.path);
  });
  const text = el("div");
  const title = el("div");
  title.append(statusDot(isDown ? "bad" : "ok"), " ", agent.label);
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

function serviceRow(service) {
  const state = service.load_state === "not-found" ? "not installed" : service.state;
  const extra = [];
  if (service.restarts) extra.push(`${service.restarts} restarts`);
  if (service.errors_last_hour) extra.push(`${service.errors_last_hour} errors/1h`);
  const status = service.state === "active" ? "ok" : "bad";
  return row(service.unit, statusText(status, [state, ...extra].join(" · ")));
}

function resourceRows(resources) {
  if (!resources) return [muted("Resources unavailable")];
  const { load, cpus, memory, disk } = resources;
  const diskPercent = Math.round((100 * disk.used) / disk.total);
  return [
    row("Load", `${load.map((x) => x.toFixed(2)).join(" / ")} (${cpus} CPU)`),
    row("Memory", `${formatBytes(memory.total - memory.available)} of ${formatBytes(memory.total)}`),
    row("Disk", `${formatBytes(disk.used)} of ${formatBytes(disk.total)} (${diskPercent}%)`),
  ];
}

function launcherPage(view) {
  const resources = view.resources;
  const worst = view.problems.length ? view.problems[0].severity : null;
  const problems = view.problems.length ? view.problems.map(problemRow) : [muted("All good")];
  const agents = view.agents.length
    ? view.agents.map(navRow)
    : [muted("No agents publish data yet")];
  return {
    title: "Server",
    subtitle: resources
      ? `${resources.hostname} · up ${formatDuration(resources.uptime_seconds)}`
      : "",
    status: worst === "error" ? "bad" : worst === "warning" ? "warn" : "ok",
    alert: "",
    nodes: [
      card("Problems", ...problems),
      card("Agents", ...agents),
      card("Services", ...view.services.map(serviceRow)),
      card("Server", ...resourceRows(resources)),
    ],
  };
}
