// Split groups are display/navigation containers. Every action still targets a child task.
function taskGroupId(task) {
  return typeof task.group === "string" && task.group.trim() && task.group.length <= 200
    ? task.group : null;
}

function taskPartNumber(value) {
  return Number.isSafeInteger(value) && value > 0 && value <= 1000 ? value : null;
}

function taskGroupTitle(tasks) {
  const named = tasks.find(task => typeof task.group_title === "string" && task.group_title.trim());
  if (named) return named.group_title.trim().slice(0, 300);
  const titles = tasks.map(task => String(task.title || "").replace(/ \([^()]+, part \d+\/\d+\)$/, ""));
  return titles[0] && titles.every(title => title === titles[0])
    && (tasks.length > 1 || titles[0] !== tasks[0].title) ? titles[0] : "Split task";
}

function taskListItems(tasks) {
  const groups = new Map();
  const items = [];
  tasks.forEach((task, index) => {
    const id = taskGroupId(task);
    if (!id) { items.push({ task, index }); return; }
    if (!groups.has(id)) groups.set(id, { groupId: id, subtasks: [], index });
    const group = groups.get(id);
    group.subtasks.push(task);
    group.index = index; // Position a group at its newest child's position.
  });
  for (const group of groups.values()) {
    group.subtasks.sort((left, right) => (taskPartNumber(left.part) || 1001) - (taskPartNumber(right.part) || 1001));
    group.total = Math.max(group.subtasks.length, ...group.subtasks.map(task => taskPartNumber(task.parts) || 0),
      ...group.subtasks.map(task => taskPartNumber(task.part) || 0));
    group.title = taskGroupTitle(group.subtasks);
    if (group.total === 1) items.push({ task: group.subtasks[0], index: group.index });
    else items.push(group);
  }
  return items.sort((left, right) => left.index - right.index);
}

function taskItemFinished(item) {
  return item.subtasks ? item.subtasks.length === item.total
    && new Set(item.subtasks.map(task => taskPartNumber(task.part))).size === item.total
    && item.subtasks.every(task => taskPartNumber(task.part) && isTaskFinished(task))
    : isTaskFinished(item.task);
}

function taskGroupSummary(group) {
  const completed = group.subtasks.filter(task => ["done", "deployed"].includes(taskStage(task))).length;
  const notes = [`${completed} of ${group.total} completed`];
  const counts = new Map();
  for (const task of group.subtasks) {
    if (["done", "deployed"].includes(taskStage(task))) continue;
    const label = task.stage === "todo" && task.waiting_for ? "waiting"
      : (TASK_STATUS[task.stage] || { label: task.stage || "Unknown" }).label.toLowerCase();
    counts.set(label, (counts.get(label) || 0) + 1);
  }
  for (const [label, count] of counts) notes.push(`${count} ${label}`);
  if (group.subtasks.length < group.total) notes.push(`${group.total - group.subtasks.length} not in this list`);
  return notes.join(" · ");
}

function taskGroupRow(group) {
  const node = el("article", null, "task task-group");
  const button = el("button", null, "task-group-link");
  button.type = "button";
  button.setAttribute("aria-label", `Open subtasks: ${group.title}`);
  button.addEventListener("click", () => navigate(`tasks/group?group=${encodeURIComponent(group.groupId)}`));
  const caption = el("span", null, "task-group-caption");
  const badge = el("span", `Split into ${group.total} parts`, "task-status");
  badge.dataset.tone = "review";
  const arrow = el("span", "›", "task-group-arrow");
  arrow.setAttribute("aria-hidden", "true");
  caption.append(badge, arrow);
  button.append(el("span", group.title, "task-group-title"), caption,
    el("span", taskGroupSummary(group), "task-meta task-group-summary"));
  node.append(button);
  return node;
}

function taskGroupPage(view) {
  const { tasks, runProgress, page } = taskPageState(view);
  const back = el("button", "← All tasks", "row-button work-secondary task-group-back");
  back.type = "button";
  back.addEventListener("click", goBack);
  const id = new URLSearchParams(location.search).get("group");
  const group = tasks && taskListItems(tasks).find(item => item.groupId === id);
  if (!group) return { ...page, title: "Task group", subtitle: "", nodes: [card("Subtasks", back,
    muted(tasks ? "This group is no longer in the task list." : "Task groups are unavailable until task data loads."))] };
  const rows = group.subtasks.map((task, index) => {
    const node = taskRow(task, runProgress);
    const number = taskPartNumber(task.part) || index + 1;
    const title = node.querySelector(".task-title");
    title.textContent = `${number}. ${task.title}`;
    return node;
  });
  const notes = [el("p", taskGroupSummary(group), "card-note")];
  if (group.subtasks.length < group.total) notes.push(el("p",
    "Some parts have been removed or archived. Only tasks still in the list are shown; their completion is unknown.", "card-note"));
  return { ...page, title: group.title, subtitle: `Split into ${group.total} parts`,
    nodes: [card("Subtasks", back, ...notes, ...rows)] };
}
