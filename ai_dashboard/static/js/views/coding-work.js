// Coding work controls send fixed requests to the agent-owned inbox.
function workActionButton(label, action, args = {}, confirmation = "") {
  const key = `work:${action}:${args.task || ""}`;
  const button = el("button", label, "action-button work-secondary");
  button.type = "button";
  button.disabled = hasPendingActions();
  let reserved = false;
  button.addEventListener("click", () => {
    if (reserved || hasPendingActions()) return;
    reserved = true;
    button.disabled = true;
    const send = async (confirmed) => {
      if (!confirmed) {
        reserved = false;
        button.disabled = false;
        return;
      }
      await requestAction(key, action, args);
      reserved = false;
    };
    if (confirmation) askConfirmation(confirmation, send);
    else send(true);
  });
  return button;
}

function pendingWorkRows(snapshot) {
  const nodes = [];
  const plan = snapshot.pending_plan;
  const branch = snapshot.pending_branch;
  if (plan) {
    nodes.push(row("Plan", `${plan.feature} · revision ${plan.revision}`),
      muted(plan.approved ? "approved" : "waiting for approval"));
  } else if (branch) nodes.push(row("Ready to run", branch));
  else if (snapshot.awaiting_bugfix_answer) nodes.push(muted("Answer in the bot chat with /answer."));
  else nodes.push(muted("Nothing pending"));
  const actions = el("div", null, "work-actions");
  if (plan && !plan.approved) actions.append(workActionButton("Approve", "approve_plan"));
  else if (branch || (plan && plan.approved)) {
    actions.append(workActionButton("Confirm and run", "confirm_work", {},
      `Queue ${branch || plan.feature} and run it? This uses AI tokens and opens a pull request.`));
  }
  if (plan || branch || snapshot.awaiting_bugfix_answer) {
    actions.append(workActionButton("Cancel", "cancel_pending", {}, "Cancel the pending work?"));
  }
  if (actions.children.length) nodes.push(actions);
  return nodes;
}

function queuedWorkRows(snapshot) {
  const queue = snapshot.queue || [];
  if (!queue.length) return [row("Queue", "empty")];
  const nodes = [row("Queue", `${queue.length} queued`)];
  for (const task of queue) {
    nodes.push(row(`#${task.id}`, `${task.branch} (${task.label})`),
      workActionButton("Remove", "remove_queued", { task: String(task.id) },
        `Remove queued task #${task.id} (${task.branch})?`));
  }
  if (!snapshot.running) {
    nodes.push(workActionButton("Run the queue", "confirm_work", {},
      "Run the queue? This uses AI tokens and opens pull requests."));
  }
  return nodes;
}

function completedWorkRows(execution) {
  if (!execution) return [row("Last run", "none yet")];
  const nodes = [row("Last run", execution.branch),
    muted(`${execution.tests} · ${(execution.files_changed || []).length} file(s)`)];
  if (execution.pr_url) nodes.push(row("PR", openLink(execution.pr_url)));
  return nodes;
}

function workCard(snapshot) {
  return card("Work", ...pendingWorkRows(snapshot), ...queuedWorkRows(snapshot),
    ...completedWorkRows(snapshot.last_execution));
}
