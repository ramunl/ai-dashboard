  function renderPm(view) {
    const s = view.snapshot;
    document.getElementById("title").textContent = "PM agent";
    document.getElementById("subtitle").textContent =
      s && s.active_project ? `todo project: ${s.active_project}` : "";
    if (!s) return [card("PM agent", muted("No data from the agent yet."))];

    const todos = [];
    if (s.todos) {
      if (s.todos.open.length) {
        const list = el("ol");
        s.todos.open.forEach((item) => list.append(el("li", item)));
        todos.push(list);
        const more = s.todos.open_count - s.todos.open.length;
        if (more > 0) todos.push(muted(`… and ${more} more (/todo_list)`));
      } else {
        todos.push(muted("Nothing open"));
      }
      if (s.todos.done) todos.push(muted(`✓ ${s.todos.done} done`));
    } else {
      todos.push(muted("No active project: /todo_use <project>"));
    }

    const projects = s.projects.length
      ? s.projects.map((p) => row(p.name + (p.name === s.active_project ? " (active)" : ""),
                                  `${p.open} open · ${p.done} done`))
      : [muted("No todo lists yet")];

    const rules = s.rules.length
      ? s.rules.map((r) => row(r.file, `${r.count} rule${r.count === 1 ? "" : "s"}`))
      : [muted("No rule files")];

    return [
      card(s.todos ? `Todos · ${s.todos.project}` : "Todos", ...todos),
      card("Projects", ...projects),
      card("Rules", ...rules),
      card("Versions", el("pre", [s.version, s.core].filter(Boolean).join("\n"))),
    ];
  }

  function pmPage(v) {
    return { nodes: renderPm(v), dot: v.problem ? "bad" : "ok",
             alert: v.problem ? `pm agent ${v.problem}` : "" };
  }

