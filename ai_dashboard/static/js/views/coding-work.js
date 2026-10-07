// Coding › Work card: the pending plan or change, the queue and the last run,
// with the buttons for /approve, /confirm and /cancel. The agent runs its own
// command handlers and reports progress in the bot chat; this card only sends
// the request and redraws from the next snapshot.

function workButton(label, key, className, onClick) {
  const button = el("button", label, className);
  button.type = "button";
  button.disabled = hasPendingActions();
  if (isActionPending(key)) button.textContent = "Sending…";
  button.addEventListener("click", () => {
    if (button.disabled) return;
    onClick(button);
  });
  return button;
}

function sendWork(key, action, args, button) {
  button.disabled = true;  // no double send
  requestAction(key, action, args);
}

function confirmedWork(question, key, action, args, button) {
  button.disabled = true;
  askConfirmation(question, (isConfirmed) => {
    if (isConfirmed) sendWork(key, action, args, button);
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
    const first = plan.approved
      ? runButton(snapshot.pending_branch || "the approved plan")
      : workButton("Approve", "work:approve", "row-button",
        (button) => sendWork("work:approve", "approve_plan", {}, button));
    return [...rows, ...planDetails(plan), workActions(first, cancelButton("the pending plan"))];
  }
  if (snapshot.pending_branch) {
    return [row("Ready to run", snapshot.pending_branch),
      workActions(runButton(snapshot.pending_branch), cancelButton("the pending change"))];
  }
  if (snapshot.awaiting_bugfix_answer) {
    return [row("Bugfix", "waiting for your answer"), el("div", "Answer in the bot chat with /answer.", "card-note"),
      workActions(cancelButton("the pending bugfix"))];
  }
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
  const queue = snapshot.queue;
  if (!queue.length) return [row("Queue", "empty")];
  const rows = [el("div", `Queue · ${queue.length}`, "card-subtitle"), ...queue.map(queuedRow)];
  // Queued tasks with nothing running: left over from a restart.
  const isStalled = !snapshot.running && !snapshot.pending_plan && !snapshot.pending_branch;
  if (isStalled) {
    rows.push(workActions(workButton("Run the queue", "work:confirm", "row-button",
      (button) => confirmedWork(`Run ${queue.length} queued task(s)? This uses AI tokens.`, "work:confirm", "confirm_work", {}, button))));
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

function workCard(snapshot) {
  return card("Work", ...pendingRows(snapshot), ...queueRows(snapshot), ...lastRunRows(snapshot.last_execution));
}
