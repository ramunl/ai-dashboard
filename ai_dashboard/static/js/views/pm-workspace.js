// Todos workspace. Preserve drafts, selected filters and focused inputs on polling.
const PM_STATUSES = { open: "Open", in_progress: "In progress", blocked: "Blocked", done: "Done" };
const PM_PRIORITIES = { high: "High", normal: "Normal", low: "Low" };
// One of SORT_MODES. Kept across polls and project changes; never saved.
let todoSortMode = "priority";
const pmUi = { workspace: null, node: null, filter: "open", priority: "all", search: "", expanded: false, editor: null, busy: false, dragging: false, notice: "", quick: "", filtersOpen: false, layout: null };
const PM_SORT_ORDERS = { manual: "in manual order", created: "newest first", priority: "sorted by priority" };
const PM_ROWS_SHOWN = 10;
const PM_SHOWN_STATUSES = ["in_progress", "blocked"];  // worth a badge; Open and Done are not

function pmButton(text, action, className = "pm-button") {
  const button = el("button", text, className);
  button.type = "button";
  button.addEventListener("click", action);
  return button;
}

function pmField(label, input) {
  const wrapper = el("label", null, "pm-field");
  wrapper.append(el("span", label), input);
  return wrapper;
}

function pmSelect(label, choices, value, change) {
  const select = el("select");
  Object.entries(choices).forEach(([key, title]) => {
    const option = el("option", title); option.value = key; select.append(option);
  });
  select.value = value;
  select.addEventListener("change", () => change(select.value));
  return pmField(label, select);
}

function pmWorkspace(workspace) {
  if (pmUi.node && (pmUi.editor || pmUi.busy || pmUi.dragging || pmUi.node.contains(document.activeElement))) return pmUi.node;
  pmUi.workspace = workspace;
  pmUi.node = card("Todos");
  pmPaint();
  return pmUi.node;
}

function pmPaint() {
  const node = pmUi.node, workspace = pmUi.workspace;
  captureDetailsState(node);
  node.replaceChildren(el("h2", "Todos"));
  if (pmUi.notice) {
    const notice = el("div", pmUi.notice, "pm-notice"); notice.setAttribute("role", "status"); node.append(notice);
  }
  if (pmUi.editor) { node.append(pmEditor()); return; }
  node.append(...pmToolbar(workspace), pmSortBar(), el("div", null, "pm-task-list"));
  pmPaintList();
}

// Manual / Created / Priority. Switching re-sorts the data already here.
function pmSortBar() {
  const bar = document.createElement("div");
  bar.className = "todo-sort-bar";
  bar.setAttribute("role", "group");
  bar.setAttribute("aria-label", "Sort todos");
  for (const [mode, label] of Object.entries(SORT_MODES)) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "todo-sort-button";
    button.textContent = label;
    button.dataset.mode = mode;
    button.setAttribute("aria-pressed", String(todoSortMode === mode));
    button.addEventListener("click", () => {
      todoSortMode = mode;
      bar.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.mode === mode)));
      pmPaintList();
    });
    bar.append(button);
  }
  return bar;
}

function pmPaintList() {
  const list = pmUi.node.querySelector(".pm-task-list"); if (!list) return;
  // Sort the whole list first, so a missing index falls back to the saved order.
  const items = sortTodos(pmUi.workspace.items, todoSortMode).filter(item =>
    (pmUi.filter === "all" || (pmUi.filter === "open" ? item.status !== "done" : item.status === pmUi.filter)) &&
    (pmUi.priority === "all" || item.priority === pmUi.priority) && item.text.toLocaleLowerCase().includes(pmUi.search.toLocaleLowerCase()));
  list.replaceChildren(el("div", items.length ? `${items.length} shown · ${PM_SORT_ORDERS[todoSortMode]}` : "No matching todos.", "pm-count"));
  if (items.length > 1 && todoSortMode !== "manual") list.append(el("div", "Switch to Manual to reorder", "todo-sort-hint"));
  const visible = pmUi.expanded ? items : items.slice(0, PM_ROWS_SHOWN);
  visible.forEach(item => list.append(pmTaskRow(item)));
  if (items.length > PM_ROWS_SHOWN) {
    const actions = el("div", null, "pm-list-actions");
    actions.append(pmButton(pmUi.expanded ? "Show fewer" : `Show all (${items.length})`, () => {
      pmUi.expanded = !pmUi.expanded;
      pmPaintList();
    }));
    list.append(actions);
  }
}

function pmTaskRow(item) {
  const entry = el("article", null, "pm-task");
  if (todoSortMode === "manual") {
    entry.dataset.manualIndex = String(pmManualIndex(item));
    entry.append(pmDragHandle(item, entry));
  }
  const check = el("input"); check.type = "checkbox"; check.checked = item.status === "done"; check.disabled = pmUi.busy;
  check.setAttribute("aria-label", `${check.checked ? "Reopen" : "Mark done"}: ${item.text}`);
  check.addEventListener("change", () => pmSend({ action: "update", id: item.id, status: check.checked ? "done" : "open", project: pmUi.workspace.project, revision: pmUi.workspace.revision }));
  entry.append(check, pmButton(item.text, () => { pmUi.editor = { ...item, revision: pmUi.workspace.revision, project: pmUi.workspace.project }; pmPaint(); }, "pm-task-title"));
  if (item.priority === "high") {
    const priority = el("span", PM_PRIORITIES.high, "pm-priority"); priority.dataset.priority = "high"; entry.append(priority);
  }
  if (PM_SHOWN_STATUSES.includes(item.status)) entry.append(el("span", PM_STATUSES[item.status], "pm-status"));
  const taskBadge = pmTaskBadge(item);
  if (taskBadge) entry.append(taskBadge);
  return entry;
}

// The todo's place in the saved order, from the snapshot.
function pmManualIndex(item) {
  return todoManualIndex(item, pmUi.workspace.items.indexOf(item));
}

// Drag (pointer, also touch) or arrow keys, in Manual order only. A move names
// the target's saved index, never its place on screen, which filters change.
function pmDragHandle(item, entry) {
  const handle = el("button", "≡", "pm-drag-handle");
  handle.type = "button";
  handle.disabled = pmUi.busy;
  handle.setAttribute("aria-label", `Reorder ${item.text}: drag, or press the up and down arrow keys`);
  handle.addEventListener("keydown", (event) => {
    const step = { ArrowUp: "previousElementSibling", ArrowDown: "nextElementSibling" }[event.key];
    if (!step) return;
    event.preventDefault();
    const target = entry[step];
    if (target && target.dataset.manualIndex !== undefined) pmMove(item, Number(target.dataset.manualIndex));
  });
  handle.addEventListener("pointerdown", (event) => {
    if (pmUi.busy) return;
    event.preventDefault();
    pmUi.dragging = true;
    entry.classList.add("pm-dragging");
    if (handle.setPointerCapture && event.pointerId !== undefined) handle.setPointerCapture(event.pointerId);
  });
  handle.addEventListener("pointermove", (event) => {
    if (!pmUi.dragging) return;
    const target = pmDropTarget(event);
    pmUi.node.querySelectorAll(".pm-drop-target").forEach((row) => row.classList.remove("pm-drop-target"));
    if (target && target !== entry) target.classList.add("pm-drop-target");
  });
  handle.addEventListener("pointerup", (event) => {
    if (!pmUi.dragging) return;
    const target = pmDropTarget(event);
    pmDragEnd(entry);
    if (target && target !== entry) pmMove(item, Number(target.dataset.manualIndex));
  });
  handle.addEventListener("pointercancel", () => pmDragEnd(entry));
  return handle;
}

function pmDropTarget(event) {
  const hit = document.elementFromPoint ? document.elementFromPoint(event.clientX, event.clientY) : null;
  const row = hit && hit.closest(".pm-task");
  return row && pmUi.node.contains(row) && row.dataset.manualIndex !== undefined ? row : null;
}

function pmDragEnd(entry) {
  pmUi.dragging = false;
  entry.classList.remove("pm-dragging");
  pmUi.node.querySelectorAll(".pm-drop-target").forEach((row) => row.classList.remove("pm-drop-target"));
}

function pmMove(item, index) {
  if (todoSortMode !== "manual" || !Number.isInteger(index) || index === pmManualIndex(item)) return;
  pmSend({ action: "move", id: item.id, project: pmUi.workspace.project, revision: pmUi.workspace.revision, index });
}

function pmEditor() {
  const draft = pmUi.editor, form = el("form", null, "pm-editor");
  form.append(pmButton("Back to todos", pmCloseEditor));
  if (draft.projectForm) {
    const name = el("input"); name.required = true; name.pattern = "[A-Za-z0-9][A-Za-z0-9_.-]{0,79}"; name.value = draft.name;
    name.addEventListener("input", () => { draft.name = name.value; });
    form.append(pmField("New project name", name));
    form.addEventListener("submit", event => { event.preventDefault(); pmSend({ action: "select", project: draft.name }, true); });
  } else {
    form.append(el("h3", draft.isNew ? "Add todo" : "Edit todo"), muted(`Project: ${draft.project}`));
    const text = el("textarea"); text.value = draft.text; text.required = true; text.maxLength = 10000; text.rows = 6;
    text.addEventListener("input", () => { draft.text = text.value; });
    form.append(pmField("Todo text", text), pmSelect("Priority", PM_PRIORITIES, draft.priority, v => { draft.priority = v; }), pmSelect("Status", PM_STATUSES, draft.status, v => { draft.status = v; }));
    form.addEventListener("submit", event => {
      event.preventDefault();
      pmSend({ action: draft.isNew ? "add" : "update", id: draft.id, project: draft.project, revision: draft.revision, text: draft.text.replace(/\s*[\r\n]+\s*/g, " ").trim(), priority: draft.priority, status: draft.status }, true);
    });
    // Make task: hand the todo to the Tasks window, which asks for the repository.
    if (!draft.isNew && draft.status !== "done") form.append(pmButton("Make task", () => {
      taskDraft = { text: draft.text, todo: `${draft.project}:${draft.id}` };
      navigate("tasks");
    }));
    if (!draft.isNew) form.append(pmButton("Delete todo", () => {
      askConfirmation(`Delete this todo?\n${draft.text}`, answer => { if (answer) pmSend({ action: "delete", id: draft.id, project: draft.project, revision: draft.revision }, true); });
    }, "pm-button pm-delete"), muted(`Task ID: ${draft.id}`));
  }
  const save = el("button", pmUi.busy ? "Saving…" : draft.projectForm ? "Create and select" : "Save", "pm-button"); save.type = "submit";
  form.append(save, pmButton("Cancel", pmCloseEditor));
  if (pmUi.busy) form.querySelectorAll("button, input, select, textarea").forEach(c => { c.disabled = true; });
  return form;
}

async function pmSend(payload, closeEditor = false) {
  if (pmUi.busy) return false;
  pmUi.busy = true;
  let isSaved = false;
  const mine = generation;
  pmUi.node.querySelectorAll("button, input, select, textarea").forEach(c => { c.disabled = true; });
  pmUi.notice = "Saving…";
  try {
    const result = await postAction("pm/action", tg ? tg.initData : "", payload, 190000);
    pmUi.workspace = result.workspace; pmUi.notice = result.warning || "Saved.";
    if (closeEditor) pmUi.editor = null;
    isSaved = true;
  } catch (error) { pmUi.notice = error.message; }
  finally {
    pmUi.busy = false;
    if (mine === generation && currentRoute().api === "pm") {
      document.getElementById("subtitle").textContent = pmUi.workspace.active_project ? `todo project: ${pmUi.workspace.active_project}` : "";
      pmPaint();
    }
  }
  return isSaved;
}

// An editor is a local PM subview: Back closes it before leaving the PM route.
function pmCloseEditor() {
  if (pmUi.busy) {
    showAlert("Saving your todo. Wait for the operation to finish before going back.");
    return;
  }
  pmUi.editor = null;
  pmUi.notice = "";
  showAlert("");
  pmPaint();
  refresh();
}

// The task made from this todo, if any: its status, linking to the Tasks window.
let pmTaskBadges = {};  // "<project>:<todo id>" -> task stage, from the dashboard

function pmTaskBadge(item) {
  const stage = pmTaskBadges[`${pmUi.workspace.project}:${item.id}`];
  const status = stage && TASK_STATUS[stage];
  if (!status) return null;
  const badge = pmButton(`Task: ${status.label}`, () => navigate("tasks"), "task-status pm-task-badge");
  badge.dataset.tone = status.tone;
  badge.setAttribute("aria-label", `Task ${status.label}; open Tasks`);
  return badge;
}
