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

function codingCards(snapshot) {
  if (!snapshot) return [card("Coding agent", muted("No data from the agent yet."))];
  return [
    card("Now", ...runningRows(snapshot.running)),
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
  const project = view.snapshot && view.snapshot.project;
  return {
    title: project ? project.name : "Coding agent",
    subtitle: project ? `${project.repository} [${project.branch}]` : "",
    status: view.problem ? "bad" : "ok",
    alert: view.problem ? `coding agent ${view.problem}` : "",
    nodes: codingCards(view.snapshot),
  };
}
