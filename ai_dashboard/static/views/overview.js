  // ---- launcher (/): server health, services, problems, links to windows
  function fmtBytes(n) {
    const units = ["B", "KB", "MB", "GB", "TB"]; let i = 0;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return `${n.toFixed(i ? 1 : 0)} ${units[i]}`;
  }
  function fmtDuration(seconds) {
    const d = Math.floor(seconds / 86400), h = Math.floor(seconds % 86400 / 3600),
          m = Math.floor(seconds % 3600 / 60);
    return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
  }
  function navRow(label, detail, path, state) {
    const node = el("a", null, "nav");
    node.href = path;
    const left = el("div");
    const title = el("div");
    title.append(el("span", null, "dot " + state), " ", label);
    left.append(title, el("div", detail, "sub2"));
    node.append(left, el("span", "›", "chev"));
    node.addEventListener("click", (event) => { event.preventDefault(); navigate(path); });
    return node;
  }

  function renderLauncher(v) {
    const r = v.resources;
    document.getElementById("title").textContent = "AI Agents";
    document.getElementById("subtitle").textContent =
      r ? `${r.hostname} · up ${fmtDuration(r.uptime_seconds)}` : "";

    const problems = v.problems.length
      ? v.problems.map((p) => {
          const row = el("div", null, "problem");
          row.append(el("span", null, "dot " + ({ error: "bad", warning: "warn", info: "info" })[p.severity]),
                     el("span", p.text));
          return row;
        })
      : [el("div", "All good", "muted")];

    const agents = v.agents.length
      ? v.agents.map((a) => {
          const state = a.load_state === "not-found" ? "not installed" : a.service || "unknown";
          const warning = a.problem || a.restarts >= 3 || a.errors_last_hour > 0;
          const color = state !== "active" ? "bad" : warning ? "warn" : "ok";
          const details = [state, a.detail];
          if (a.problem) details.push(a.problem);
          if (a.restarts) details.push(`${a.restarts} restarts`);
          if (a.errors_last_hour) details.push(`${a.errors_last_hour} errors in the last hour`);
          return navRow(a.label, details.filter(Boolean).join(" · "), "/" + a.path, color);
        })
      : [muted("No agents configured")];

    const server = r ? [
      row("Load", `${r.load.map((x) => x.toFixed(2)).join(" / ")} (${r.cpus} CPU)`),
      row("Memory", `${fmtBytes(r.memory.total - r.memory.available)} of ${fmtBytes(r.memory.total)}`),
      row("Disk", `${fmtBytes(r.disk.used)} of ${fmtBytes(r.disk.total)} (${Math.round(100 * r.disk.used / r.disk.total)}%)`),
    ] : [muted("Resources unavailable")];

    if (r) {
      for (const [index, used, total] of [[2, r.memory.total - r.memory.available, r.memory.total],
                                        [4, r.disk.used, r.disk.total]]) {
        const meter = el("div", null, "meter");
        const fill = el("span");
        const percent = total > 0 ? Math.max(0, Math.min(100, 100 * used / total)) : 0;
        fill.style.width = `${percent}%`;
        fill.style.background = percent >= 90 ? "var(--bad)" : percent >= 80 ? "var(--warning)" : "var(--accent)";
        meter.append(fill);
        server.splice(index, 0, meter);
      }
    }
    const summary = el("div", v.problems.length
      ? `${v.problems.length} item${v.problems.length === 1 ? "" : "s"} need attention`
      : "All systems healthy", "health-summary");
    const worst = v.problems.length ? v.problems[0].severity : null;
    return {
      nodes: [summary, ...(v.problems.length ? [card("Needs attention", ...problems)] : []),
              card("Agents", ...agents), card("Server resources", ...server)],
      dot: worst === "error" ? "bad" : worst === "warning" ? "warn" : "ok",
      alert: "",
    };
  }

  function renderOps(v) {
    const overview = renderLauncher(v);
    document.getElementById("title").textContent = "Ops agent";
    const ops = v.agents.find((a) => a.name === "ops");
    const status = ops ? [row("Service", ops.service), row("Restarts", ops.restarts || 0),
      row("Errors in last hour", ops.errors_last_hour || 0)] : [muted("Ops agent is not configured")];
    return { ...overview, nodes: [card("Operations", ...status),
      ...(v.problems.length ? [overview.nodes[1]] : []), overview.nodes.at(-1)] };
  }

