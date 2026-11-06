// Coding agent window (/coding): current run, setup, work, providers, limits.
function runningRows(running) {
  if (!running) return [muted("Idle")];
  return [
    row("Status", el("span", running.status || "RUNNING", "badge")),
    row("Branch", running.branch),
    row("Phase", running.phase),
  ];
}

function setupLink(label, value, path) {
  const node = el("a", null, "nav-row");
  node.href = "/" + path;
  node.addEventListener("click", (event) => {
    event.preventDefault();
    navigate(path);
  });
  const content = el("div");
  content.append(el("div", label), el("div", value, "nav-detail"));
  node.append(content, el("span", "›", "nav-chevron"));
  return node;
}

function setupCard(setup, snapshot) {
  if (!setup) return setupMissingCard();
  const active = setup.projects.find((project) => project.active);
  const model = codingToolsModel(snapshot);
  const tools = model && model.registry
    ? [`planner ${codingSetupTool(model, "planner")}`, `implementer ${codingSetupTool(model, "implementer")}`]
    : setupToolLine(setup);
  return card(
    "Setup",
    setupLink("Project", active ? active.name : "—", "coding/projects"),
    setupLink("AI tools", tools.join(" · "), "coding/ai"),
    setupLink("Logs", "The agent's journal, live", "coding/logs"),
  );
}

// The old snapshot: "planner codex", "implementer codex", plus the Claude model.
function setupToolLine(setup) {
  const claude = (Array.isArray(setup.models) ? setup.models : []).find((model) => model && model.tool === "claude");
  const tools = [`planner ${setup.planner}`, `implementer ${setup.implementer}`];
  if (claude && claude.model) tools.push(claude.model);
  return tools;
}

// The registry snapshot: the current provider+model for one role.
function codingSetupTool(model, role) {
  const entry = model.roles[role];
  const tool = model.tools[entry.tool];
  if (!tool) return entry.current;
  return tool.model ? `${tool.label} · ${tool.model}` : tool.label;
}

function runOutcomeCard(outcome) {
  if (!outcome) return [];
  const title = outcome.status === "ops_required" ? "Needs Ops action" : "Blocked run";
  return [card(title, row("Branch", outcome.branch),
    el("pre", outcome.report, "card-note"),
    row("Reported", new Date(outcome.at * 1000).toLocaleString()),
    setupLink("Open Ops", "Review diagnostics and confirm server actions", "ops"))];
}

function codingCards(snapshot) {
  if (!snapshot) return [card("Coding agent", muted("No data from the agent yet."))];
  return [
    card("Now", ...runningRows(snapshot.running)),
    setupCard(snapshot.setup || null, snapshot),
    workCard(snapshot),
    ...runOutcomeCard(snapshot.last_run_outcome),
    ...contextCards(snapshot),
    card(
      "Providers",
      row("Planner", snapshot.planning_agent),
      row("Implementer", snapshot.implementation_agent),
      row("Verbosity", snapshot.verbosity),
    ),
    limitsCard(snapshot.limits, snapshot.registry),
    card("Versions", el("pre", [snapshot.version, snapshot.core].filter(Boolean).join("\n"))),
  ];
}

function codingPage(view) {
  settleActions(setupOf(view));
  const project = view.snapshot && view.snapshot.project;
  return {
    // Always the agent's name, like the PM and Ops windows: Telegram's own
    // header shows whichever bot opened the dashboard, so this line is the
    // only reliable sign of which window is open.
    title: "Coding agent",
    subtitle: project ? `project: ${project.name} · ${project.repository} [${project.branch}]` : "",
    status: view.problem ? "bad" : "ok",
    alert: view.problem ? `coding agent ${view.problem}` : actionNoticeText(),
    nodes: codingCards(view.snapshot),
  };
}
