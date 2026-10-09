// PM agent window (/pm): todos of the active project, projects, rules.
function todoRows(todos) {
  if (!todos) return [muted("No active project: /todo_use <project>")];
  const rows = [];
  if (todos.open.length) {
    const list = el("ol");
    todos.open.forEach((item) => list.append(el("li", item)));
    rows.push(list);
    const more = todos.open_count - todos.open.length;
    if (more > 0) rows.push(muted(`… and ${more} more (/todo_list)`));
  } else {
    rows.push(muted("Nothing open"));
  }
  if (todos.done) rows.push(muted(`✓ ${todos.done} done`));
  return rows;
}

function projectRows(snapshot) {
  if (!snapshot.projects.length) return [muted("No todo lists yet")];
  return snapshot.projects.map((project) => {
    const name = project.name + (project.name === snapshot.active_project ? " (active)" : "");
    return row(name, `${project.open} open · ${project.done} done`);
  });
}

function ruleRows(rules) {
  if (!rules.length) return [muted("No rule files")];
  return rules.map((rule) => row(rule.file, `${rule.count} rule${rule.count === 1 ? "" : "s"}`));
}

function pmCards(snapshot) {
  if (!snapshot) return [card("PM agent", muted("No data from the agent yet."))];
  return [
    card(snapshot.todos ? `Todos · ${snapshot.todos.project}` : "Todos", ...todoRows(snapshot.todos)),
    card("Projects", ...projectRows(snapshot)),
    card("Rules", ...ruleRows(snapshot.rules)),
    card("Versions", el("pre", [snapshot.version, snapshot.core].filter(Boolean).join("\n"))),
  ];
}

function pmPage(view) {
  pmTaskBadges = view.task_badges || {};
  const snapshot = view.snapshot;
  const active = view.editing && view.editing.ok ? view.editing.workspace.active_project : snapshot && snapshot.active_project;
  return {
    title: "PM agent",
    subtitle: active ? `todo project: ${active}` : "",
    status: view.problem ? "bad" : "ok",
    alert: view.problem ? `pm agent ${view.problem}` : "",
    nodes: view.editing && view.editing.ok
      ? [pmLayout(view.editing.workspace, snapshot)]
      : [...pmCards(snapshot), muted(view.editing ? view.editing.error : "Editing is not available yet")],
  };
}

// Todos take the main area; rules and "About" share one narrow side card.
// The layout node is reused while the todos card is kept (focus, drafts), so
// a refresh only swaps the side card and never moves the focused field.
function pmLayout(workspace, snapshot) {
  const main = pmWorkspace(workspace);
  const side = card("Rules", ...ruleRows(snapshot ? snapshot.rules : []), pmAbout(snapshot));
  if (pmUi.layout && main.parentNode === pmUi.layout) {
    pmUi.layout.lastChild.replaceWith(side);
    return pmUi.layout;
  }
  pmUi.layout = el("div", null, "pm-layout");
  pmUi.layout.append(main, side);
  return pmUi.layout;
}

function pmAbout(snapshot) {
  const details = el("details", null, "pm-about");
  details.append(el("summary", "About PM agent"));
  if (snapshot) details.append(el("pre", [snapshot.version, snapshot.core].filter(Boolean).join("\n")));
  return details;
}
