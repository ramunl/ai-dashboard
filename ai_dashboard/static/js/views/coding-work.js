// Coding › Work card: the pending plan or change, the queue and the last run,
// with the buttons for /approve, /confirm and /cancel. The agent runs its own
// command handlers and reports progress in the bot chat; this card only sends
// the request and redraws from the next snapshot.

// The agent is thinking (planning, revising, checking a bug report): every
// work button waits, since the agent would refuse anyway.
let isWorkBusy = false;

function workButton(label, key, className, onClick) {
  const button = el("button", label, className);
  button.type = "button";
  button.disabled = hasPendingActions() || isWorkBusy;
  if (isActionPending(key)) button.textContent = "Sending…";
  button.addEventListener("click", () => {
    if (button.disabled) return;
    onClick(button);
  });
  return button;
}

function sendWork(key, action, args, button, onDone = null) {
  button.disabled = true;  // no double send
  requestAction(key, action, args, onDone);
}

function confirmedWork(question, key, action, args, button, onDone = null) {
  button.disabled = true;
  askConfirmation(question, (isConfirmed) => {
    if (isConfirmed) sendWork(key, action, args, button, onDone);
    else button.disabled = false;
  });
}

function workActions(...buttons) {
  const group = el("div", null, "work-actions");
  group.append(...buttons);
  return group;
}

function runButton(target) {
  const question = `Queue ${target} and run it? This uses AI tokens and opens a pull request.`;
  return workButton("Confirm and run", "work:confirm", "row-button",
    (button) => confirmedWork(question, "work:confirm", "confirm_work", {}, button));
}

function cancelButton(what) {
  return workButton("Cancel", "work:cancel", "row-button work-secondary",
    (button) => confirmedWork(`Discard ${what}?`, "work:cancel", "cancel_pending", {}, button));
}

function pendingRows(snapshot) {
  const plan = snapshot.pending_plan;
  if (plan) {
    const state = plan.approved ? "approved" : "waiting for approval";
    const rows = [row("Plan", `${plan.feature} · revision ${plan.revision}`), el("div", state, "card-note")];
    const names = planRepositoryNames(plan);
    // Project selection does not rebind a plan that was prepared elsewhere.
    const active = typeof plan.repository === "string" && plan.repository
      ? plan.repository : snapshot.project && snapshot.project.name;
    const isElsewhere = names.length > 0 && Boolean(active) && !names.includes(active);
    const buttons = [];
    if (plan.approved) buttons.push(runButton(snapshot.pending_branch || "the approved plan"));
    else if (!isElsewhere) {
      buttons.push(workButton("Approve", "work:approve", "row-button",
        (button) => sendWork("work:approve", "approve_plan", {}, button)));
    }
    if (!plan.approved && (names.length > 1 || isElsewhere || plan.can_split_milestones === true)) {
      // One other repository: the task was made in the wrong project; move it there.
      const byMilestone = !isElsewhere && names.length < 2;
      const label = isElsewhere && names.length === 1 ? `Move to ${names[0]}` : "Split into tasks";
      buttons.push(splitButton(isElsewhere ? "row-button" : "row-button work-secondary", label, byMilestone));
    }
    return [...rows, ...planScopeAdvice(plan), ...planDetails(plan),
      workActions(...buttons, reviseButton(), cancelButton("the pending plan")), ...reviseRows()];
  }
  if (snapshot.pending_branch) {
    return [row("Ready to run", snapshot.pending_branch),
      ...planScopeAdvice({ scope_assessment: snapshot.pending_scope_assessment }, false),
      workActions(runButton(snapshot.pending_branch), cancelButton("the pending change"))];
  }
  if (snapshot.awaiting_bugfix_answer) return bugfixRows(snapshot);
  return startWorkRows();
}

function queuedRow(task) {
  const node = el("div", null, "setup-row");
  const label = el("div");
  label.append(el("div", `#${task.id} ${task.branch}`), el("div", task.label, "nav-detail"));
  const key = `work:remove:${task.id}`;
  const remove = workButton("Remove", key, "row-button work-secondary",
    (button) => confirmedWork(`Remove queued task #${task.id} (${task.branch})?`, key, "remove_queued", { task: String(task.id) }, button));
  node.append(label, remove);
  return node;
}

function queueRows(snapshot) {
  const queue = snapshot.queue || [];
  if (!queue.length) return [row("Queue", "empty")];
  const paused = snapshot.queue_paused === true;
  const rows = [el("div", `Implementation queue · ${queue.length}${paused ? " · paused" : ""}`, "card-subtitle"), ...queue.map(queuedRow)];
  // confirm_work handles pending work first. Legacy snapshots infer a stalled
  // queue from the absence of a running implementation.
  const canResume = !snapshot.pending_plan && !snapshot.pending_branch && !snapshot.running
    && (paused || typeof snapshot.queue_paused !== "boolean");
  if (canResume) {
    const label = paused ? "Resume queue" : "Run the queue";
    const verb = paused ? "Resume" : "Run";
    rows.push(workActions(workButton(label, "work:confirm", "row-button",
      (button) => confirmedWork(`${verb} ${queue.length} queued task(s)? This uses AI tokens.`, "work:confirm", "confirm_work", {}, button))));
  }
  return rows;
}

function codingTaskStartRows(snapshot) {
  const tasks = Array.isArray(snapshot.tasks) ? snapshot.tasks : [];
  const project = snapshot.project?.name;
  const startable = project ? tasks.filter((task) => task.repo === project && canStartTask(task)) : [];
  const queued = tasks.filter(isTaskQueuedToStart);
  const rows = [];
  if (startable.length) {
    const planner = taskPlannerName(codingToolsModel(snapshot), snapshot.setup);
    rows.push(el("div", "Start a task", "card-subtitle"));
    for (const task of startable) rows.push(row(task.title, startTaskButton(task, planner)));
  }
  if (queued.length) {
    rows.push(el("div", `Tasks queued to start · ${queued.length}`, "card-subtitle"));
    for (const task of queued) {
      rows.push(row(`${task.title} · ${task.repo}`, cancelTaskStartButton(task, "Cancel start")));
    }
  }
  return rows;
}

function lastRunRows(execution) {
  if (!execution) return [row("Last run", "none yet")];
  const summary = `${execution.tests} · ${execution.files_changed.length} file(s)`;
  const rows = [el("div", "Last run", "card-subtitle"), row(execution.branch, summary)];
  if (execution.pr_url) rows.push(row("PR", openLink(execution.pr_url)));
  return rows;
}

// The autonomous worker, when on: what it does, so its work isn't mistaken
// for yours. While it starts planning, new work waits.
function workerRows(worker) {
  if (!worker || !worker.enabled) return [];
  const link = el("button", "Open Tasks", "link-button");
  link.type = "button";
  link.addEventListener("click", () => navigate("tasks"));
  const value = el("span");
  value.append(worker.status, " · ", link);
  return [row("Worker", value)];
}

function workCard(snapshot) {
  workRepo = (snapshot.project && snapshot.project.name) || "";
  const thinking = snapshot.thinking || null;
  const worker = snapshot.worker || null;
  isWorkBusy = Boolean(thinking) || Boolean(worker && worker.enabled && worker.current_phase === "planning");
  // Nothing pending yet while a new request is thought about: the progress
  // row stands in for the empty form.
  const isNewWork = thinking && !snapshot.pending_plan && !snapshot.awaiting_bugfix_answer;
  const pending = isNewWork ? [] : pendingRows(snapshot);
  return card("Work", ...workerRows(worker), ...thinkingRows(thinking), ...pending,
    ...codingTaskStartRows(snapshot), ...queueRows(snapshot), ...lastRunRows(snapshot.last_execution));
}


const mergeConflictDrafts = new Map();

function mergeConflictRows(snapshot) {
  const project = snapshot.project?.name || "";
  const input = el("input", null, "setup-input");
  input.type = "url";
  input.value = mergeConflictDrafts.get(project) || "";
  input.placeholder = "https://github.com/owner/repo/pull/123";
  input.setAttribute("aria-label", "Pull request URL to resolve");
  const button = workButton("Solve conflicts", "work:fixmerge", "row-button", (button) => {
    const url = input.value.trim();
    if (!/^https:\/\/github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/pull\/[1-9][0-9]*$/.test(url)) {
      input.setCustomValidity("Enter a GitHub pull request URL.");
      input.reportValidity();
      return;
    }
    input.setCustomValidity("");
    confirmedWork("Resolve conflicts for this PR? This uses AI tokens and pushes a merge commit to its branch.",
      "work:fixmerge", "fix_merge_conflicts", { url }, button);
  });
  input.addEventListener("input", () => {
    input.setCustomValidity("");
    mergeConflictDrafts.set(project, input.value);
  });
  button.disabled = button.disabled || Boolean(snapshot.running) || Boolean(snapshot.queue?.length)
    || Boolean(snapshot.pending_plan) || Boolean(snapshot.pending_branch)
    || snapshot.awaiting_bugfix_answer === true;
  const result = snapshot.merge_conflict;
  const rows = [el("div", "Fix merge conflicts", "card-subtitle"),
    el("div", "Use an open PR in the selected project. Fork PRs are unsupported.", "card-note"),
    workActions(input, button)];
  if (result && result.status) {
    rows.push(row("Conflict fix", result.status));
    if (result.message) rows.push(el("div", result.message, "card-note"));
  }
  return rows;
}
