// Tasks window (/tasks): work made from todos, followed from planning to a
// pull request. The coding agent keeps the list and moves each task along by
// what happens to its plan and branch; this page reads it from the coding
// window's data and sends create / start / remove requests to the agent.

const TASK_STATUS = {
  proposed: { label: "Proposed", tone: "attention" },
  todo: { label: "To do", tone: "todo" },
  planning: { label: "Planning", tone: "progress" },
  planned: { label: "Needs approval", tone: "attention" },
  implementing: { label: "Implementing", tone: "progress" },
  blocked: { label: "Blocked", tone: "attention" },
  ops_required: { label: "Needs Ops action", tone: "attention" },
  ended: { label: "Run ended", tone: "todo" },
  pr: { label: "PR open", tone: "review" },
  done: { label: "Done", tone: "done" },
  deployed: { label: "Deployed", tone: "deployed" },
  stopped: { label: "Stopped", tone: "todo" },
};
const TASK_FILTERS = { active: "Active", finished: "Finished", all: "All" };
// "PR open" counts as finished here: the agent's part is over, it waits on review.
const FINISHED_TASK_STAGES = ["pr", "done", "stopped"];
// Context status (CTX05) shown beside each task; absent fields stay unknown.
const CONTEXT_TASK_STATUS = {
  ok: { label: "Context OK", tone: "done" },
  stale: { label: "Context stale", tone: "attention" },
  blocked: { label: "Context blocked", tone: "attention" },
  unknown: { label: "Context unknown", tone: "todo" },
};

let taskFilter = "active";
let taskPlanner = "";  // who plans: the registry label or the legacy codex/claude value
let taskTools = null;  // the normalized DS05/legacy tools model from the snapshot
let taskDraft = null;  // { text, todo } handed over by the PM window's Make task
let taskRepo = "";
let taskAutopilot = false;  // the Make a task sheet's Autopilot box
let taskProgress = { deployed: {}, deployable: [], closed: [] };  // from the dashboard

// The agent's stage, plus "deployed", which only the dashboard can see.
function taskStage(task) {
  return task.stage === "done" && task.id in taskProgress.deployed ? "deployed" : task.stage;
}

function agoText(seconds) {
  return `${formatDuration(Math.max(0, Date.now() / 1000 - seconds))} ago`;
}

// A stopped task that can be retried, or that a later part waits for, still
// needs you: it stays under Active.
function isTaskFinished(task) {
  return FINISHED_TASK_STAGES.includes(task.stage) && !task.can_retry && task.can_resume !== true && !task.blocks;
}

function retryButton(task, tool, name, label, className, resume = false) {
  const action = resume ? "resume_task" : "retry_task";
  const key = `task:${resume ? "resume" : "retry"}:${task.id}:${tool}`;
  return taskButton(label, key, className, (button) => {
    button.disabled = true;
    const origin = generation;
    const question = resume
      ? `Resume "${task.title}" with ${name}? Continue from saved branch and edits. A new AI run inspects remaining work; this uses AI tokens.`
      : `Start "${task.title}" fresh with ${name}? Same approved plan, clean checkout. Saved work is preserved, but implementation restarts; this uses AI tokens.`;
    askConfirmation(question, (isConfirmed) => {
      if (origin !== generation) return;
      if (isConfirmed) requestAction(key, action, { task: task.id, tool });
      else button.disabled = false;
    });
  });
}

// The tools a retry/resume may pick, from the registry's implementer options,
// or the legacy codex/claude pair on an old snapshot. Resume keeps the old
// codex-first order; a fresh start lists claude first, as before.
function retryChoices(resume) {
  if (taskTools && taskTools.registry) {
    const tools = taskTools.roles.implementer.options.map((option) => ({ id: option.value, label: option.label }));
    return resume ? tools : [...tools].reverse();
  }
  const legacy = [{ id: "codex", label: "Codex" }, { id: "claude", label: "Claude" }];
  return resume ? legacy : [...legacy].reverse();
}

function retryButtons(task, resume) {
  return retryChoices(resume).map((choice, index) =>
    retryButton(task, choice.id, choice.label,
      resume ? `Resume with ${choice.label}` : `Start fresh with ${choice.label}`,
      resume && index === 0 ? "row-button" : "row-button work-secondary", resume));
}

// Only the agent can decide whether the finished attempt is safe to archive.
function canReopenTask(task) {
  return task.can_reopen === true && ["done", "stopped"].includes(task.stage);
}

function reopenButton(task) {
  const key = `task:reopen:${task.id}`;
  return taskButton("Reopen", key, "row-button", (button) => {
    button.disabled = true;
    const origin = generation;
    askConfirmation(`Reopen "${task.title}" as To do? Fresh planning uses AI tokens and requires approval. Attempt history is preserved; its PM todo stays unchanged.`, (isConfirmed) => {
      if (origin !== generation) return;
      if (!isConfirmed) { button.disabled = hasPendingActions(); return; }
      requestAction(key, "reopen_task", { task: task.id }, (result) => {
        taskFilter = "active";
        actionNotice = { text: result.message, until: Date.now() + NOTICE_MS };
      });
    });
  });
}

// " with Codex" (the planner chosen in Setup), or "" when unknown.
function plannerText() {
  return taskPlanner ? ` with ${taskPlanner[0].toUpperCase()}${taskPlanner.slice(1)}` : "";
}

function taskButton(label, key, className, onClick) {
  const button = el("button", label, className);
  button.type = "button";
  button.disabled = hasPendingActions();
  if (isActionPending(key)) button.textContent = "Sending…";
  button.addEventListener("click", () => {
    if (!button.disabled) onClick(button);
  });
  return button;
}

function taskMeta(task) {
  const parts = [task.repo];
  if (task.stage === "planned" && task.plan_revision) {
    parts.push(task.plan_approved ? "approved · confirm to run" : `plan revision ${task.plan_revision}`);
  } else if (task.branch && task.stage !== "todo") {
    parts.push(task.branch);
  }
  const deployedAt = taskProgress.deployed[task.id];
  if (typeof deployedAt === "number") {
    parts.push(`deployed ${agoText(deployedAt)}`);
  } else if (typeof task.merged_at === "number") {
    parts.push(`merged ${agoText(task.merged_at)}`);
    const isDeployable = taskProgress.deployable.includes(task.repo);
    parts.push(isDeployable ? "waiting for a deployment" : "no deployment for this repo");
  }
  if (taskProgress.closed.includes(task.id)) parts.push("todo closed");
  if (task.autopilot) parts.push("autopilot");
  if (task.waiting_for) parts.push(`starts after: ${task.waiting_for}`);
  if (task.note) parts.push(task.note);
  if (task.todo) parts.push(`from todo ${task.todo.split(":")[0]}`);
  const meta = el("div", null, "task-meta");
  meta.append(parts.join(" · "));
  if (task.pr_url) meta.append(" · ", openLink(task.pr_url));
  return meta;
}

// Context evidence the agent published for the task (CTX05). PR / merged /
// deployed are shown separately from the status line; missing evidence stays
// unknown rather than guessed.
function contextEvidence(status) {
  const evidence = status && status.evidence;
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) return [];
  const nodes = [];
  if (typeof evidence.pr === "string" && evidence.pr) {
    const link = openLink(evidence.pr);
    const line = el("div", null, "context-evidence");
    line.append(el("span", "PR evidence "), link);
    nodes.push(line);
  }
  if (evidence.merged === true) nodes.push(el("div", "Merged", "context-evidence"));
  if (evidence.deployed === true) nodes.push(el("div", "Deployed", "context-evidence"));
  return nodes;
}

// The task's prerequisite context: a precise reason plus dependency blockers.
function taskContext(task) {
  const status = task.context_status;
  if (!status || typeof status !== "object" || Array.isArray(status)) {
    return [el("div", "Context unknown", "card-note context-status")];
  }
  const nodes = [];
  const shown = CONTEXT_TASK_STATUS[status.status] || CONTEXT_TASK_STATUS.unknown;
  const line = el("div", null, "context-status");
  const badge = el("span", shown.label, "task-status");
  badge.dataset.tone = shown.tone;
  line.append(el("span", "Context"), badge);
  if (typeof status.reason === "string" && status.reason.trim()) {
    line.append(" ", el("span", status.reason, "card-note"));
  }
  nodes.push(line);
  if (Array.isArray(status.blockers) && status.blockers.length) {
    nodes.push(el("div", `Dependency blocked by: ${status.blockers.join(" · ")}`,
      "card-note context-blockers"));
  }
  nodes.push(...contextEvidence(status));
  return nodes;
}

// A task the worker proposed from the server logs: accept it or drop it.
function proposalActions(task) {
  const acceptKey = `task:accept:${task.id}`;
  const accept = taskButton("Accept", acceptKey, "row-button", (button) => {
    button.disabled = true;
    requestAction(acceptKey, "accept_task", { task: task.id });
  });
  const dismissKey = `task:dismiss:${task.id}`;
  const dismiss = taskButton("Dismiss", dismissKey, "row-button work-secondary", (button) => {
    button.disabled = true;
    askConfirmation("Dismiss this proposal? That error won't be proposed again for 30 days.", (isConfirmed) => {
      if (isConfirmed) requestAction(dismissKey, "dismiss_task", { task: task.id });
      else button.disabled = false;
    });
  });
  const nodes = [];
  if (Array.isArray(task.evidence) && task.evidence.length) {
    const details = rememberDetails(el("details", null, "task-evidence"), ["task", task.id, "evidence"]);
    details.append(el("summary", "Log lines"));
    for (const line of task.evidence) details.append(el("pre", line, "log-line"));
    nodes.push(details);
  }
  nodes.push(workActions(accept, dismiss));
  return nodes;
}

function taskActions(task) {
  if (task.stage === "proposed") return proposalActions(task);
  const actions = [];
  if (task.can_stop === true) {
    if (task.stopping === true) {
      const stopping = el("button", "Stopping…", "row-button work-secondary");
      stopping.disabled = true;
      actions.push(stopping);
    } else {
      const key = `task:stop:${task.id}`;
      actions.push(taskButton("Stop implementation", key, "row-button work-secondary", (button) => {
        button.disabled = true;
        const origin = generation;
        askConfirmation(`Stop "${task.title}"? The provider will stop and saved work will be preserved. Wait for recovery before resuming.`, (confirmed) => {
          if (origin !== generation) return;
          if (confirmed) requestAction(key, "stop_task", { task: task.id, token: task.stop_token });
          else button.disabled = false;
        });
      }));
    }
  }
  if (task.stage === "ops_required") {
    actions.push(taskButton("Open Ops", `task:ops:${task.id}`, "row-button", () => navigate("ops")));
  }
  if (task.stage === "planned") {
    actions.push(taskButton("Open plan", `task:open:${task.id}`, "row-button", () => navigate("coding")));
  }
  if (!FINISHED_TASK_STAGES.includes(task.stage) && task.stage !== "proposed" && typeof task.autopilot === "boolean") {
    const key = `task:autopilot:${task.id}`;
    const value = task.autopilot ? "off" : "on";
    actions.push(taskButton(task.autopilot ? "Autopilot off" : "Autopilot on", key, "row-button work-secondary",
      (button) => { button.disabled = true; requestAction(key, "set_autopilot", { task: task.id, value }); }));
  }
  if (canReopenTask(task)) actions.push(reopenButton(task));
  if (task.can_resume === true) {
    actions.push(...retryButtons(task, true));
  }
  if (task.can_retry) {
    if (task.can_resume !== true) {
      const unavailable = el("button", "Resume unavailable", "row-button work-secondary");
      unavailable.disabled = true;
      unavailable.title = task.resume_reason || "No safe saved checkpoint is available.";
      actions.push(unavailable);
    }
    actions.push(...retryButtons(task, false));
  }
  if (task.queued && ["todo", "stopped", "blocked", "ops_required"].includes(task.stage)) {
    // Already asked to start: the agent starts it as soon as it is free.
    const key = `task:unqueue:${task.id}`;
    actions.push(taskButton("Don't start", key, "row-button work-secondary", (button) => {
      button.disabled = true;
      requestAction(key, "cancel_start", { task: task.id });
    }));
  } else if (["todo", "stopped", "blocked", "ops_required"].includes(task.stage) && !canReopenTask(task)) {
    const key = `task:start:${task.id}`;
    const label = task.waiting_for ? "Check prerequisites and start" : "Start planning";
    const question = task.waiting_for
      ? `Check prerequisites for "${task.title}"? If they pass, start planning in ${task.repo}${plannerText()} (uses AI tokens). If they do not pass, the task stays waiting.`
      : `Plan "${task.title}" in ${task.repo}${plannerText()}? This uses AI tokens.`;
    actions.push(taskButton(label, key, "row-button", (button) => {
      button.disabled = true;
      askConfirmation(question, (isConfirmed) => {
        if (isConfirmed) requestAction(key, "start_task", { task: task.id });
        else button.disabled = false;
      });
    }));
  }
  if (["todo", "stopped", "pr", "done", "blocked", "ops_required"].includes(task.stage)) {
    const key = `task:remove:${task.id}`;
    actions.push(taskButton("Remove", key, "row-button work-secondary", (button) => {
      button.disabled = true;
      askConfirmation(`Remove the task "${task.title}"? Its todo stays as it is.`, (isConfirmed) => {
        if (isConfirmed) requestAction(key, "remove_task", { task: task.id });
        else button.disabled = false;
      });
    }));
  }
  const notes = [];
  if (task.can_resume === true && typeof task.resume_summary === "string" && task.resume_summary) {
    notes.push(el("div", task.resume_summary, "card-note"));
  } else if (task.can_retry) {
    notes.push(el("div", `Resume unavailable: ${task.resume_reason || "No safe saved checkpoint is available."}`, "card-note"));
  }
  return actions.length ? [...notes, workActions(...actions)] : [];
}

function taskRow(task) {
  const isWaiting = task.stage === "todo" && Boolean(task.waiting_for);
  const isQueued = Boolean(task.queued) && !FINISHED_TASK_STAGES.includes(task.stage)
    && !["planning", "planned", "implementing"].includes(task.stage);
  const status = isQueued ? { label: "Starts next", tone: "todo" }
    : isWaiting ? { label: "Waiting", tone: "todo" }
    : TASK_STATUS[taskStage(task)] || { label: task.stage, tone: "todo" };
  const node = el("article", null, "task");
  const badge = el("span", status.label, "task-status");
  badge.dataset.tone = status.tone;
  node.append(el("div", task.title, "task-title"), badge, taskMeta(task), ...taskContext(task), ...taskActions(task));
  return node;
}

function taskFilterSwitch(tasks) {
  const counts = {
    active: tasks.filter((task) => !isTaskFinished(task)).length,
    finished: tasks.filter(isTaskFinished).length,
  };
  const group = el("div", null, "pm-switch task-switch");
  group.setAttribute("role", "group");
  group.setAttribute("aria-label", "Show tasks");
  for (const [value, label] of Object.entries(TASK_FILTERS)) {
    const text = value in counts ? `${label} ${counts[value]}` : label;
    const button = el("button", text, "pm-switch-button");
    button.type = "button";
    button.setAttribute("aria-pressed", String(taskFilter === value));
    button.addEventListener("click", () => { taskFilter = value; refresh(); });
    group.append(button);
  }
  return group;
}

function tasksCard(tasks) {
  const shown = tasks.filter((task) => taskFilter === "all"
    || (taskFilter === "finished") === isTaskFinished(task));
  // Newest first: the task just made is the one to look at.
  const rows = [...shown].reverse().map(taskRow);
  if (!rows.length) rows.push(muted(tasks.length ? "No tasks here." : "No tasks yet. Open a todo in the PM window and tap Make task."));
  return card("Tasks", taskFilterSwitch(tasks), ...rows);
}

// Autopilot: the worker plans, approves and runs the task to a pull request.
function autopilotBox() {
  const label = el("label", null, "radio-row task-autopilot");
  const box = el("input");
  box.type = "checkbox";
  box.checked = taskAutopilot;
  box.disabled = hasPendingActions();
  box.addEventListener("change", () => { taskAutopilot = box.checked; });
  const text = el("span");
  text.append(el("span", "Autopilot"),
    el("span", "The worker approves the plan and runs it to a pull request; you review the PR", "card-note radio-note"));
  label.append(box, text);
  return label;
}

function tasksPage(view) {
  const setup = setupOf(view);
  settleActions(setup);
  const snapshot = view.snapshot;
  const model = codingToolsModel(snapshot);
  taskTools = model;
  taskPlanner = (model && model.registry
    ? (model.roles.planner.options.find((option) => option.value === model.roles.planner.current) || {}).label || model.roles.planner.current
    : ((setup && setup.planner) || ""));
  taskProgress = { deployed: {}, deployable: [], closed: [], ...(view.task_progress || {}) };
  const tasks = (snapshot && snapshot.tasks) || null;
  const problem = view.problem ? `coding agent ${view.problem}` : "";
  const page = { title: "Tasks", subtitle: "", status: view.problem ? "bad" : "ok", alert: problem || actionNoticeText() };
  if (!tasks) {
    return { ...page, nodes: [card("Tasks", muted("Update the coding agent to keep tasks here."))] };
  }
  const waiting = tasks.filter((task) => ["planned", "proposed"].includes(task.stage)).length;
  page.subtitle = `${tasks.length} task${tasks.length === 1 ? "" : "s"}${waiting ? ` · ${waiting} need${waiting === 1 ? "s" : ""} you` : ""}`;
  if (taskPlanner) page.subtitle += ` · planner ${taskPlanner}`;
  const nodes = taskDraft && setup ? [makeTaskCard(setup), tasksCard(tasks)] : [tasksCard(tasks)];
  if (snapshot.worker) nodes.push(workerCard(snapshot.worker));
  return { ...page, nodes };
}
