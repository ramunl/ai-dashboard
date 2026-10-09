// Tasks window (/tasks): work made from todos, followed from planning to a
// pull request. The coding agent keeps the list and moves each task along by
// what happens to its plan and branch; this page reads it from the coding
// window's data and sends create / start / remove requests to the agent.

const TASK_STATUS = {
  todo: { label: "To do", tone: "todo" },
  planning: { label: "Planning", tone: "progress" },
  planned: { label: "Needs approval", tone: "attention" },
  implementing: { label: "Implementing", tone: "progress" },
  pr: { label: "PR open", tone: "review" },
  done: { label: "Done", tone: "done" },
  deployed: { label: "Deployed", tone: "deployed" },
  stopped: { label: "Stopped", tone: "todo" },
};
const TASK_FILTERS = { active: "Active", finished: "Finished", all: "All" };
// "PR open" counts as finished here: the agent's part is over, it waits on review.
const FINISHED_TASK_STAGES = ["pr", "done", "stopped"];

let taskFilter = "active";
let taskDraft = null;  // { text, todo } handed over by the PM window's Make task
let taskRepo = "";
let taskProgress = { deployed: {}, deployable: [], closed: [] };  // from the dashboard

// The agent's stage, plus "deployed", which only the dashboard can see.
function taskStage(task) {
  return task.stage === "done" && task.id in taskProgress.deployed ? "deployed" : task.stage;
}

function agoText(seconds) {
  return `${formatDuration(Math.max(0, Date.now() / 1000 - seconds))} ago`;
}

function isTaskFinished(task) {
  return FINISHED_TASK_STAGES.includes(task.stage);
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
  if (task.note) parts.push(task.note);
  if (task.todo) parts.push(`from todo ${task.todo.split(":")[0]}`);
  const meta = el("div", null, "task-meta");
  meta.append(parts.join(" · "));
  if (task.pr_url) meta.append(" · ", openLink(task.pr_url));
  return meta;
}

function taskActions(task) {
  const actions = [];
  if (task.stage === "planned") {
    actions.push(taskButton("Open plan", `task:open:${task.id}`, "row-button", () => navigate("coding")));
  }
  if (task.stage === "todo" || task.stage === "stopped") {
    const key = `task:start:${task.id}`;
    actions.push(taskButton("Start planning", key, "row-button", (button) => {
      button.disabled = true;
      askConfirmation(`Plan "${task.title}" in ${task.repo}? This uses AI tokens.`, (isConfirmed) => {
        if (isConfirmed) requestAction(key, "start_task", { task: task.id });
        else button.disabled = false;
      });
    }));
  }
  if (["todo", "stopped", "pr", "done"].includes(task.stage)) {
    const key = `task:remove:${task.id}`;
    actions.push(taskButton("Remove", key, "row-button work-secondary", (button) => {
      button.disabled = true;
      askConfirmation(`Remove the task "${task.title}"? Its todo stays as it is.`, (isConfirmed) => {
        if (isConfirmed) requestAction(key, "remove_task", { task: task.id });
        else button.disabled = false;
      });
    }));
  }
  return actions.length ? [workActions(...actions)] : [];
}

function taskRow(task) {
  const status = TASK_STATUS[taskStage(task)] || { label: task.stage, tone: "todo" };
  const node = el("article", null, "task");
  const badge = el("span", status.label, "task-status");
  badge.dataset.tone = status.tone;
  node.append(el("div", task.title, "task-title"), badge, taskMeta(task), ...taskActions(task));
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

function makeTaskCard(setup) {
  const projects = setup.projects.map((project) => ({ value: project.name, note: project.repository }));
  if (!taskRepo || !projects.some((option) => option.value === taskRepo)) {
    const active = setup.projects.find((project) => project.active);
    taskRepo = active ? active.name : "";
  }
  const repos = radioList("task-repo", projects, taskRepo, hasPendingActions(), (name) => { taskRepo = name; });
  const make = taskButton("Make task and plan", "task:create", "row-button", (button) => {
    if (!taskRepo) {
      showAlert("Choose the repository first.");
      return;
    }
    const text = taskDraft.text.replace(/\s+/g, " ").trim().slice(0, WORK_TEXT_LIMIT);
    button.disabled = true;
    askConfirmation(`Make a task in ${taskRepo} and start planning it? This uses AI tokens.`, (isConfirmed) => {
      if (!isConfirmed) {
        button.disabled = false;
        return;
      }
      requestAction("task:create", "create_task", { repo: taskRepo, text, todo: taskDraft.todo }, (result) => {
        taskDraft = null;
        taskFilter = "active";
        actionNotice = { text: result.message, until: Date.now() + NOTICE_MS };
      });
    });
  });
  const cancel = taskButton("Cancel", "task:cancel", "row-button work-secondary", () => {
    taskDraft = null;
    refresh();
  });
  const sheet = card("Make a task", el("p", taskDraft.text, "plan-summary"), el("div", "Repository", "card-subtitle"), repos,
    workActions(make, cancel), el("div", "If another task is planning, this one waits as To do.", "card-note"));
  sheet.classList.add("card-wide", "task-sheet");
  return sheet;
}

function tasksPage(view) {
  const setup = setupOf(view);
  settleActions(setup);
  taskProgress = { deployed: {}, deployable: [], closed: [], ...(view.task_progress || {}) };
  const snapshot = view.snapshot;
  const tasks = (snapshot && snapshot.tasks) || null;
  const problem = view.problem ? `coding agent ${view.problem}` : "";
  const page = { title: "Tasks", subtitle: "", status: view.problem ? "bad" : "ok", alert: problem || actionNoticeText() };
  if (!tasks || !setup) {
    return { ...page, nodes: [card("Tasks", muted("Update the coding agent to keep tasks here."))] };
  }
  const waiting = tasks.filter((task) => task.stage === "planned").length;
  page.subtitle = `${tasks.length} task${tasks.length === 1 ? "" : "s"}${waiting ? ` · ${waiting} need${waiting === 1 ? "s" : ""} you` : ""}`;
  const nodes = taskDraft ? [makeTaskCard(setup), tasksCard(tasks)] : [tasksCard(tasks)];
  return { ...page, nodes };
}
