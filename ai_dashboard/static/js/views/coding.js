// Coding agent window (/coding): current run, queue, plan, last run.
function runningRows(running) {
  if (!running) return [muted("Idle")];
  return [
    row("Status", el("span", running.status || "RUNNING", "badge")),
    row("Branch", running.branch),
    row("Phase", running.phase),
  ];
}

function queueRows(queue) {
  if (!queue.length) return [muted("Empty")];
  const list = el("ol");
  queue.forEach((task) => list.append(el("li", `#${task.id} ${task.branch} (${task.label})`)));
  return [list];
}

function planRows(snapshot) {
  const rows = [];
  const plan = snapshot.pending_plan;
  if (plan) {
    rows.push(
      row("Feature", plan.feature),
      row("Revision", plan.revision),
      row("Approved", plan.approved ? "yes" : "no — /approve"),
    );
  }
  if (snapshot.pending_branch) rows.push(row("Ready to run", `${snapshot.pending_branch} — /confirm`));
  if (snapshot.awaiting_bugfix_answer) rows.push(row("Bugfix", "waiting for /answer"));
  return rows.length ? rows : [muted("Nothing pending")];
}

function lastRunRows(execution) {
  if (!execution) return [muted("No runs yet")];
  return [
    row("Branch", execution.branch),
    row("Tests", execution.tests),
    row("Files", execution.files_changed.length),
    row("PR", execution.pr_url ? openLink(execution.pr_url) : "—"),
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

function setupCard(setup) {
  if (!setup) return setupMissingCard();
  const active = setup.projects.find((project) => project.active);
  const claude = setup.models.find((model) => model.tool === "claude");
  const tools = [`planner ${setup.planner}`, `implementer ${setup.implementer}`];
  if (claude) tools.push(claude.model);
  return card(
    "Setup",
    setupLink("Project", active ? active.name : "—", "coding/projects"),
    setupLink("AI tools", tools.join(" · "), "coding/ai"),
  );
}

function codingCards(snapshot) {
  if (!snapshot) return [card("Coding agent", muted("No data from the agent yet."))];
  return [
    card("Now", ...runningRows(snapshot.running)),
    setupCard(snapshot.setup || null),
    card("Queue", ...queueRows(snapshot.queue)),
    card("Plan", ...planRows(snapshot)),
    card("Last run", ...lastRunRows(snapshot.last_execution)),
    card(
      "Providers",
      row("Planner", snapshot.planning_agent),
      row("Implementer", snapshot.implementation_agent),
      row("Verbosity", snapshot.verbosity),
    ),
    limitsCard(snapshot.limits),
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
