// Coding agent window (/coding): current run, setup, work, providers, limits.
function runningRows(running) {
  if (!running) return [muted("Idle")];
  return [
    row("Status", el("span", running.status || "RUNNING", "badge")),
    row("Branch", running.branch),
    row("Phase", running.phase),
  ];
}

// The active run's bounded progress (progress01): stage, elapsed, last activity
// and the attempt id. Idle and legacy snapshots have no "progress", and unknown
// values stay unknown rather than being guessed.
const PROGRESS_STAGE_LABELS = {
  checkout: "Preparing checkout",
  implement: "Implementing",
  push: "Publishing changes",
  ci: "Checking CI",
  repair: "Repairing CI",
  stopping: "Stopping",
  working: "Working",
  unknown: "Unknown",
  proposed: "Proposed",
  todo: "To do",
  planning: "Planning",
  planned: "Needs approval",
  implementing: "Implementing",
  blocked: "Blocked",
  ops_required: "Needs Ops action",
  ended: "Run ended",
  pr: "PR open",
  done: "Done",
  deployed: "Deployed",
  stopped: "Stopped",
};

function progressRows(progress) {
  if (!progress || typeof progress !== "object" || Array.isArray(progress)) return [];
  const has = (key) => key in progress;
  // A legacy "progress" shape has none of the v1 fields: render nothing rather
  // than guessing a stage or an age.
  if (!has("stage") && !has("elapsed") && !has("last_activity")
    && !has("task_id") && !has("attempt_id")) return [];
  const stage = typeof progress.stage === "string" && progress.stage
    ? PROGRESS_STAGE_LABELS[progress.stage] || progress.stage
    : "Unknown";
  const elapsed = Number.isFinite(progress.elapsed) && progress.elapsed >= 0
    ? formatDuration(Math.max(0, progress.elapsed))
    : "unknown";
  const activity = Number.isFinite(progress.last_activity) && progress.last_activity >= 0
    ? `${formatDuration(progress.last_activity)} ago`
    : "no activity update available";
  const rows = [
    row("Stage", stage),
    row("Elapsed", elapsed),
    row("Last activity", activity),
  ];
  if (typeof progress.attempt_id === "string" && progress.attempt_id) {
    rows.push(row("Attempt", progress.attempt_id));
  }
  return rows;
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
    card("Now", ...runningRows(snapshot.running), ...progressRows(snapshot.progress)),
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
