// Todos workspace. Preserve drafts, selected filters and focused inputs on polling.
const PM_STATUSES = { open: "Open", in_progress: "In progress", blocked: "Blocked", done: "Done" };
const PM_PRIORITIES = { high: "High", normal: "Normal", low: "Low" };
const pmUi = { workspace: null, node: null, filter: "open", priority: "all", search: "", sort: "priority", expanded: false, editor: null, busy: false, notice: "", quick: "", filtersOpen: false, layout: null };
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
  if (pmUi.node && (pmUi.editor || pmUi.busy || pmUi.node.contains(document.activeElement))) return pmUi.node;
  pmUi.workspace = workspace;
  pmUi.node = card("Todos");
  pmPaint();
  return pmUi.node;
}

function pmPaint() {
  const node = pmUi.node, workspace = pmUi.workspace;
  node.replaceChildren(el("h2", "Todos"));
  if (pmUi.notice) {
    const notice = el("div", pmUi.notice, "pm-notice"); notice.setAttribute("role", "status"); node.append(notice);
  }
  if (pmUi.editor) { node.append(pmEditor()); return; }
  node.append(...pmToolbar(workspace), el("div", null, "pm-task-list"));
  pmPaintList();
}

function pmPaintList() {
  const list = pmUi.node.querySelector(".pm-task-list"); if (!list) return;
  let items = pmUi.workspace.items.filter(item =>
    (pmUi.filter === "all" || (pmUi.filter === "open" ? item.status !== "done" : item.status === pmUi.filter)) &&
    (pmUi.priority === "all" || item.priority === pmUi.priority) && item.text.toLocaleLowerCase().includes(pmUi.search.toLocaleLowerCase()));
  if (pmUi.sort === "priority") items = [...items].sort((a, b) => Object.keys(PM_PRIORITIES).indexOf(a.priority) - Object.keys(PM_PRIORITIES).indexOf(b.priority));
  const order = pmUi.sort === "priority" ? "sorted by priority" : "in original order";
  list.replaceChildren(el("div", items.length ? `${items.length} shown · ${order}` : "No matching todos.", "pm-count"));
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
  const check = el("input"); check.type = "checkbox"; check.checked = item.status === "done"; check.disabled = pmUi.busy;
  check.setAttribute("aria-label", `${check.checked ? "Reopen" : "Mark done"}: ${item.text}`);
  check.addEventListener("change", () => pmSend({ action: "update", id: item.id, status: check.checked ? "done" : "open", project: pmUi.workspace.project, revision: pmUi.workspace.revision }));
  entry.append(check, pmButton(item.text, () => { pmUi.editor = { ...item, revision: pmUi.workspace.revision, project: pmUi.workspace.project }; pmPaint(); }, "pm-task-title"));
  if (item.priority === "high") {
    const priority = el("span", PM_PRIORITIES.high, "pm-priority"); priority.dataset.priority = "high"; entry.append(priority);
  }
  if (PM_SHOWN_STATUSES.includes(item.status)) entry.append(el("span", PM_STATUSES[item.status], "pm-status"));
  return entry;
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
