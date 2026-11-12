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
// Context status (CTX09) shown beside each task. The coding agent publishes a
// v1 "context_status" (health, freshness, evidence_state, observed_at,
// omission_count, truncation_count, packet_refs, dependency_blockers); a
// pre-v1 snapshot still carries the legacy status/reason/blockers/evidence
// shape, which renders unchanged. Absent fields stay unknown.
const CONTEXT_TASK_STATUS = {
  healthy: { label: "Context recorded", tone: "todo" },
  degraded: { label: "Context incomplete", tone: "attention" },
  blocked: { label: "Context blocked", tone: "attention" },
  unavailable: { label: "Context unavailable", tone: "todo" },
  unknown: { label: "Context not recorded", tone: "todo" },
};
// The legacy CTX05 status values, kept for pre-v1 snapshots.
const LEGACY_CONTEXT_TASK_STATUS = {
  ok: { label: "Context OK", tone: "done" },
  stale: { label: "Context stale", tone: "attention" },
  blocked: { label: "Context blocked", tone: "attention" },
  unknown: { label: "Context unknown", tone: "todo" },
};
// v1 evidence_state codes get a human label; an unknown code renders as itself
// rather than being guessed.
const CONTEXT_EVIDENCE_STATE = {
  none: "No evidence",
  partial: "Partial evidence",
  complete: "Complete evidence",
};
// v1 dependency blocker codes are "kind:value"; the known kinds get a phrase,
// unknown codes stay as the raw code so no detail is dropped.
const CONTEXT_DEPENDENCY_BLOCKERS = {
  dependency: "Dependency not merged",
  evidence: "Evidence missing",
  dependency_unknown: "Check needed before the next run",
  dependency_changed: "Predecessor changed",
  dependency_unavailable: "Prerequisite evidence unavailable",
  dependency_recovery_pending: "Prerequisite recovery pending",
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
      resume ? `Resume with ${choice.label}` : `Restart · ${choice.label}`,
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

// Legacy CTX05 context evidence: PR / merged / deployed are shown separately
// from the status line; missing evidence stays unknown rather than guessed.
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

// Age from the v1 observed_at timestamp; a missing one stays "age unknown".
function taskContextAge(observedAt) {
  if (typeof observedAt !== "number" || !Number.isFinite(observedAt)
      || observedAt < 0 || observedAt > Date.now() / 1000) return "Capture time unavailable";
  return `Captured ${formatDuration(Date.now() / 1000 - observedAt)} ago`;
}

// A v1 dependency blocker code rendered through the label map, or as itself.
function taskContextBlocker(code) {
  if (typeof code !== "string" || !code) return "";
  const split = code.indexOf(":");
  const kind = split === -1 ? code : code.slice(0, split);
  const label = CONTEXT_DEPENDENCY_BLOCKERS[kind];
  if (!label) return code;
  const rest = split === -1 ? "" : code.slice(split + 1);
  return rest ? `${label}: ${rest}` : label;
}

// A v1 packet reference: only its id and checksum, never its contents.
function taskContextPacket(packet) {
  if (!packet || typeof packet !== "object" || Array.isArray(packet)) return null;
  const parts = [];
  if (typeof packet.packet_id === "string" && packet.packet_id) {
    parts.push(`packet ${packet.packet_id}`);
  }
  if (typeof packet.sha256 === "string" && packet.sha256) {
    parts.push(`sha256 ${packet.sha256}`);
  }
  return parts.length ? el("div", parts.join(" · "), "card-note context-packet") : null;
}

// Packet capture is historical evidence, not an expiring execution permission.
function taskContextBadge(status, task) {
  if (["blocked", "unavailable"].includes(status.health)) return CONTEXT_TASK_STATUS[status.health];
  const historical = ["done", "deployed"].includes(task.stage);
  const hasPackets = Array.isArray(status.packet_refs) && status.packet_refs.length > 0;
  if (status.evidence_state === "not_planned") return {
    label: task.stage === "planning" ? "Preparing context" : "Context not planned yet", tone: "todo" };
  if (status.evidence_state === "metadata_unavailable" ||
      (historical && !hasPackets)) return {
    label: historical ? "Historical metadata unavailable" : "Context metadata unavailable", tone: "todo" };
  if ([status.omission_count, status.truncation_count].some(count => Number.isInteger(count) && count > 0)) return {
    label: historical ? "Historical context incomplete" : "Context incomplete", tone: "attention" };
  if (hasPackets) return {
    label: historical ? "Historical context" : "Context recorded", tone: "todo" };
  return { label: "Context not recorded", tone: "todo" };
}

function contextV1Rows(status, task = {}) {
  const nodes = [];
  const shown = taskContextBadge(status, task);
  const line = el("div", null, "context-status");
  const badge = el("span", shown.label, "task-status");
  badge.dataset.tone = shown.tone;
  line.append(badge);
  if (typeof status.observed_at === "number") {
    const captured = el("span", taskContextAge(status.observed_at), "card-note");
    if (Number.isFinite(status.observed_at) && status.observed_at >= 0 && status.observed_at * 1000 <= 8640000000000000) {
      captured.title = new Date(status.observed_at * 1000).toISOString();
    }
    line.append(" ", captured);
  }
  const counts = [];
  if (Number.isInteger(status.omission_count) && status.omission_count > 0) counts.push(`${status.omission_count} omitted`);
  if (Number.isInteger(status.truncation_count) && status.truncation_count > 0) counts.push(`${status.truncation_count} truncated`);
  if (counts.length) line.append(" ", el("span", counts.join(", "), "card-note"));
  nodes.push(line);
  if (Array.isArray(status.dependency_blockers) && status.dependency_blockers.length) {
    const unknownOnly = status.dependency_blockers.every(code => code === "dependency_unknown");
    const text = unknownOnly ? "Prerequisites need checking before the next run."
      : `Dependency blocked by: ${status.dependency_blockers.map(taskContextBlocker).join(" · ")}`;
    nodes.push(el("div", text, "card-note context-blockers"));
  }
  const details = el("details", null, "context-details");
  details.append(el("summary", "Context details"));
  const meta = [];
  if (typeof status.freshness === "string") meta.push(`freshness ${status.freshness}`);
  if (typeof status.evidence_state === "string") meta.push(CONTEXT_EVIDENCE_STATE[status.evidence_state] || status.evidence_state);
  if (status.observed_at == null) meta.push("Capture time unavailable");
  if (typeof status.observed_at === "number" && Number.isFinite(status.observed_at)
      && status.observed_at >= 0 && status.observed_at * 1000 <= 8640000000000000) {
    meta.push(`Captured at ${new Date(status.observed_at * 1000).toISOString()}`);
  }
  if (meta.length) details.append(el("div", meta.join(" · "), "card-note"));
  const packets = Array.isArray(status.packet_refs) ? status.packet_refs : [];
  for (const packet of packets) {
    const ref = taskContextPacket(packet);
    if (ref) details.append(ref);
  }
  nodes.push(details);
  return nodes;
}

// The legacy CTX05 context_status row: a precise reason plus dependency
// blockers and PR / merged / deployed evidence.
function contextLegacyRows(status) {
  const nodes = [];
  const shown = LEGACY_CONTEXT_TASK_STATUS[status.status] || LEGACY_CONTEXT_TASK_STATUS.unknown;
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

// The task's prerequisite context: v1 when the status carries a health, the
// legacy shape when it carries a status, unknown otherwise.
function taskContext(task) {
  const status = task.context_status;
  if (!status || typeof status !== "object" || Array.isArray(status)) {
    return [el("div", ["done", "deployed"].includes(task.stage)
      ? "Historical metadata unavailable" : "Context not recorded", "card-note context-status")];
  }
  if (typeof status.health === "string") return contextV1Rows(status, task);
  if (typeof status.status === "string") return contextLegacyRows(status);
  return [el("div", ["done", "deployed"].includes(task.stage)
      ? "Historical metadata unavailable" : "Context not recorded", "card-note context-status")];
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
  if (task.can_resolve_blockage === true) {
    const key = `task:resolve-blockage:${task.id}`;
    actions.push(taskButton("Resolve blockage", key, "row-button work-secondary", (button) => {
      button.disabled = true;
      const origin = generation;
      askConfirmation("Verify this PR is merged and newer default-branch CI covers it? If verified, restore Done and clear only this attempt’s blockage. Old CI and recovery history are preserved. No deployment or implementation starts.", (confirmed) => {
        if (origin !== generation) return;
        if (confirmed) requestAction(key, "resolve_task_blockage", { task: task.id });
        else button.disabled = false;
      });
    }));
  }
  if (task.can_reconcile === true) {
    const key = `task:reconcile:${task.id}`;
    actions.push(taskButton("Check merged PR", key, "row-button work-secondary", (button) => {
      button.disabled = true;
      askConfirmation(`Check the saved PR for "${task.title}"? If its archived commit is confirmed merged, restore Done and review unchanged prerequisite links. No implementation will start.`, (confirmed) => {
        if (confirmed) requestAction(key, "reconcile_task", { task: task.id });
        else button.disabled = false;
      });
    }));
  }
  if (canReopenTask(task)) actions.push(reopenButton(task));
  if (task.can_resume === true) {
    actions.push(...retryButtons(task, true));
  }
  if (task.can_retry) {
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
    const label = task.waiting_for ? "Check & start" : "Start planning";
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

function taskRow(task, runProgress) {
  const isWaiting = task.stage === "todo" && Boolean(task.waiting_for);
  const isQueued = Boolean(task.queued) && !FINISHED_TASK_STAGES.includes(task.stage)
    && !["planning", "planned", "implementing"].includes(task.stage);
  const status = isQueued ? { label: "Starts next", tone: "todo" }
    : isWaiting ? { label: "Waiting", tone: "todo" }
    : TASK_STATUS[taskStage(task)] || { label: task.stage, tone: "todo" };
  // The active run's progress belongs only to the task it names; a run for a
  // different task (or a stale snapshot) never leaks onto this row.
  const progressNodes = runProgress && runProgress.task_id === task.id
    ? progressRows(runProgress) : [];
  const node = el("article", null, "task");
  const badge = el("span", status.label, "task-status");
  badge.dataset.tone = status.tone;
  node.append(el("div", task.title, "task-title"), badge, taskMeta(task),
    ...progressNodes, ...taskContext(task),
    ...(task.blockage_resolved === true ? [muted("Blockage resolved: merged PR verified with newer default-branch CI. Original CI history preserved.")] : []),
    ...taskActions(task));
  return node;
}

function taskFilterSwitch(tasks, finished = isTaskFinished) {
  const counts = {
    active: tasks.filter((task) => !finished(task)).length,
    finished: tasks.filter(finished).length,
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

function tasksCard(tasks, runProgress) {
  const items = taskListItems(tasks);
  const shown = items.filter((item) => taskFilter === "all"
    || (taskFilter === "finished") === taskItemFinished(item));
  const rows = [...shown].reverse().map((item) => item.subtasks ? taskGroupRow(item) : taskRow(item.task, runProgress));
  if (!rows.length) rows.push(muted(tasks.length ? "No tasks here." : "No tasks yet. Open a todo in the PM window and tap Make task."));
  return card("Tasks", taskFilterSwitch(items, taskItemFinished), ...rows);
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

function taskPageState(view) {
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
  const runProgress = (snapshot && snapshot.progress) || null;
  const problem = view.problem ? `coding agent ${view.problem}` : "";
  const page = { title: "Tasks", subtitle: "", status: view.problem ? "bad" : "ok", alert: problem || actionNoticeText() };
  return { setup, snapshot, tasks, runProgress, page };
}

function tasksPage(view) {
  const { setup, snapshot, tasks, runProgress, page } = taskPageState(view);
  if (!tasks) {
    return { ...page, nodes: [card("Tasks", muted("Update the coding agent to keep tasks here."))] };
  }
  const items = taskListItems(tasks);
  const waiting = items.filter(item => (item.subtasks || [item.task]).some(task => ["planned", "proposed"].includes(task.stage))).length;
  page.subtitle = `${items.length} task${items.length === 1 ? "" : "s"}${waiting ? ` · ${waiting} need${waiting === 1 ? "s" : ""} you` : ""}`;
  if (taskPlanner) page.subtitle += ` · planner ${taskPlanner}`;
  const nodes = taskDraft && setup ? [makeTaskCard(setup), tasksCard(tasks, runProgress)] : [tasksCard(tasks, runProgress)];
  if (snapshot.worker) nodes.push(workerCard(snapshot.worker));
  return { ...page, nodes };
}
