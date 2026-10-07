// PM todos toolbar: project picker, quick add and the "more" menu, then
// search, the Open / Done / All switch and the rarely used filters.

function pmBareField(label, input) {
  const field = pmField(label, input);
  field.classList.add("pm-field-bare");  // label kept for screen readers only
  return field;
}

function pmProjectPicker(workspace) {
  const projects = { "": "Select a project…", ...Object.fromEntries(workspace.projects.map((p) => [p.name, p.name])) };
  if (workspace.project && !projects[workspace.project]) projects[workspace.project] = workspace.project;
  const field = pmSelect("Active todo project", projects, workspace.project || "", (project) => {
    if (project) pmSend({ action: "select", project });
  });
  field.classList.add("pm-field-bare", "pm-project");
  return field;
}

function pmNewTodoDraft(workspace, text) {
  return { id: crypto.randomUUID().replaceAll("-", ""), text, priority: "normal", status: "open", isNew: true, revision: workspace.revision, project: workspace.project };
}

function pmNeedsProject(workspace) {
  if (workspace.project) return false;
  pmUi.notice = "Select or create a project first.";
  pmPaint();
  return true;
}

// Enter saves a Normal-priority todo; the field keeps focus for the next one.
function pmQuickAdd(workspace) {
  const input = el("input");
  input.type = "text";
  input.placeholder = "Add a todo…";
  input.enterKeyHint = "done";
  input.maxLength = 10000;
  input.value = pmUi.quick;
  input.addEventListener("input", () => { pmUi.quick = input.value; });
  input.addEventListener("keydown", async (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    const text = input.value.replace(/\s+/g, " ").trim();
    if (!text || pmUi.busy || pmNeedsProject(workspace)) return;
    const draft = pmNewTodoDraft(workspace, text);
    const isSaved = await pmSend({ action: "add", id: draft.id, project: draft.project, revision: draft.revision, text, priority: draft.priority, status: draft.status });
    if (!isSaved) return;
    pmUi.quick = "";
    pmPaint();
    const next = pmUi.node.querySelector(".pm-quick input");
    if (next) next.focus();
  });
  const field = pmBareField("Add a todo", input);
  field.classList.add("pm-quick");
  return field;
}

function pmMoreMenu(workspace) {
  const menu = el("details", null, "pm-menu");
  const summary = el("summary", "⋯", "pm-button");
  summary.setAttribute("aria-label", "More actions");
  const items = el("div", null, "pm-menu-items");
  items.append(
    pmButton("Add with details", () => {
      if (pmNeedsProject(workspace)) return;
      pmUi.editor = pmNewTodoDraft(workspace, pmUi.quick);
      pmPaint();
    }),
    pmButton("New project", () => { pmUi.editor = { projectForm: true, name: "" }; pmPaint(); }),
    pmButton("Sync", () => pmSend({ action: "sync", project: workspace.project })));
  menu.append(summary, items);
  return menu;
}

function pmStatusSwitch(workspace) {
  const open = workspace.items.filter((item) => item.status !== "done").length;
  const choices = [["open", `Open ${open}`], ["done", `Done ${workspace.items.length - open}`], ["all", "All"]];
  const group = el("div", null, "pm-switch");
  group.setAttribute("role", "group");
  group.setAttribute("aria-label", "Show todos");
  for (const [value, label] of choices) {
    const button = pmButton(label, () => { pmUi.filter = value; pmUi.expanded = false; pmPaint(); }, "pm-switch-button");
    button.setAttribute("aria-pressed", String(pmUi.filter === value));
    group.append(button);
  }
  return group;
}

function pmFilterPanel() {
  const panel = el("div", null, "pm-bar pm-filter-panel");
  panel.hidden = !pmUi.filtersOpen;
  panel.append(
    pmSelect("Priority", { all: "All", ...PM_PRIORITIES }, pmUi.priority, (value) => { pmUi.priority = value; pmPaintList(); }),
    pmSelect("Sort", { priority: "Priority", original: "Original order" }, pmUi.sort, (value) => { pmUi.sort = value; pmPaintList(); }));
  return panel;
}

function pmToolbar(workspace) {
  const top = el("div", null, "pm-bar pm-bar-top");
  top.append(pmProjectPicker(workspace), pmQuickAdd(workspace), pmMoreMenu(workspace));
  const search = el("input");
  search.type = "search";
  search.placeholder = "Search";
  search.value = pmUi.search;
  search.addEventListener("input", () => { pmUi.search = search.value; pmPaintList(); });
  const panel = pmFilterPanel();
  const toggle = pmButton("Filter", () => {
    pmUi.filtersOpen = !pmUi.filtersOpen;
    panel.hidden = !pmUi.filtersOpen;
    toggle.setAttribute("aria-expanded", String(pmUi.filtersOpen));
  });
  toggle.setAttribute("aria-expanded", String(pmUi.filtersOpen));
  const filters = el("div", null, "pm-bar pm-bar-filters");
  filters.append(pmBareField("Search todos", search), pmStatusSwitch(workspace), toggle);
  return [top, filters, panel];
}
