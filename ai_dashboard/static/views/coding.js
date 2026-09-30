  // ---- views. The launcher (/) and PM (/pm) join this table in later steps.
  function renderCoding(view) {
    const s = view.snapshot;
    document.getElementById("title").textContent = s && s.project ? s.project.name : "Coding agent";
    document.getElementById("subtitle").textContent =
      s && s.project ? `${s.project.repository} [${s.project.branch}]` : "";
    if (!s) return [card("Coding agent", muted("No data from the agent yet."))];

    const running = s.running
      ? [row("Status", (() => { const w = el("span"); w.append(el("span", s.running.status || "RUNNING", "badge")); return w; })()),
         row("Branch", s.running.branch), row("Phase", s.running.phase)]
      : [muted("Idle")];

    const queue = s.queue.length
      ? [(() => { const l = el("ol"); s.queue.forEach((t) => l.append(el("li", `#${t.id} ${t.branch} (${t.label})`))); return l; })()]
      : [muted("Empty")];

    const plan = [];
    if (s.pending_plan) {
      plan.push(row("Feature", s.pending_plan.feature), row("Revision", s.pending_plan.revision),
                row("Approved", s.pending_plan.approved ? "yes" : "no — /approve"));
    }
    if (s.pending_branch) plan.push(row("Ready to run", `${s.pending_branch} — /confirm`));
    if (s.awaiting_bugfix_answer) plan.push(row("Bugfix", "waiting for /answer"));

    const e = s.last_execution;
    const last = e
      ? [row("Branch", e.branch), row("Tests", e.tests), row("Files", e.files_changed.length),
         row("PR", e.pr_url ? openLink(e.pr_url) : "—")]
      : [muted("No runs yet")];

    const versions = el("pre", [s.version, s.core].filter(Boolean).join("\n"));
    return [
      card("Now", ...running),
      card("Queue", ...queue),
      card("Plan", ...(plan.length ? plan : [muted("Nothing pending")])),
      card("Last run", ...last),
      card("Providers", row("Planner", s.planning_agent), row("Implementer", s.implementation_agent),
           row("Verbosity", s.verbosity)),
      card("Versions", versions),
    ];
  }

  function codingPage(v) {
    return { nodes: renderCoding(v), dot: v.problem ? "bad" : "ok",
             alert: v.problem ? `coding agent ${v.problem}` : "" };
  }

