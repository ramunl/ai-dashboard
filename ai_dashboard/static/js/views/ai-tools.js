// Ops › AI tools card: installed and published versions of Codex and Claude
// Code, with an Update button where a newer one exists. Both actions run in
// the ops agent's ai-tools command; this card only starts them.

function startToolRun(payload, button, idleText) {
  button.disabled = true;  // no double start; the server would refuse it too
  button.textContent = "Starting…";
  postAction("ops/tools", tg ? tg.initData : "", payload)
    .then(() => refresh())
    .catch((error) => {
      button.disabled = false;
      button.textContent = idleText;
      showAlert(`AI tools ${payload.action} did not start: ${error.message}`);
    });
}

function toolCheckButton(state) {
  const idleText = "Check versions";
  const button = el("button", idleText, "action-button update-button");
  button.type = "button";
  button.disabled = Boolean(state.running);
  if (state.running === "check") button.textContent = "Checking…";
  button.addEventListener("click", () => startToolRun({ action: "check" }, button, idleText));
  return button;
}

function toolUpdateButton(tool, state) {
  const idleText = "Update";
  const button = el("button", idleText, "row-button");
  button.type = "button";
  button.disabled = Boolean(state.running);
  if (state.running === tool.name) button.textContent = "Updating…";
  button.addEventListener("click", () => {
    const message = `Update ${tool.name} to ${tool.latest}? A coding task that is running keeps its current version.`;
    askConfirmation(message, (isConfirmed) => {
      if (isConfirmed) startToolRun({ action: "update", tool: tool.name }, button, idleText);
    });
  });
  return button;
}

function toolDetail(tool) {
  if (!tool.version) return "not installed";
  if (tool.update_available) return `${tool.version} · ${tool.latest} available`;
  return tool.latest ? `${tool.version} · up to date` : `${tool.version} · latest unknown`;
}

function toolRow(tool, state) {
  const node = el("div", null, "setup-row");
  const label = el("div");
  label.append(el("div", tool.name), el("div", toolDetail(tool), "nav-detail"));
  node.append(label);
  if (tool.update_available) node.append(toolUpdateButton(tool, state));
  return node;
}

function toolReportRows(state) {
  const report = state.report;
  if (!report) return [muted("Not checked since the dashboard started")];
  if (!report.ok) return [row("Last check", "failed"), el("div", report.error, "card-note")];
  const ago = formatDuration(Math.max(0, Date.now() / 1000 - report.checked_at));
  return [...report.tools.map((tool) => toolRow(tool, state)), row("Checked", `${ago} ago`)];
}

function lastToolUpdateRows(lastUpdate) {
  if (!lastUpdate) return [];
  if (!lastUpdate.ok) {
    return [row("Last update", `${lastUpdate.name} failed`), el("div", lastUpdate.error, "card-note")];
  }
  const ago = formatDuration(Math.max(0, Date.now() / 1000 - lastUpdate.finished_at));
  return [row("Last update", `${lastUpdate.name} · ${ago} ago`)];
}

function aiToolsCard(view) {
  const state = view.ai_tools;
  if (!state) return card("AI tools", muted("AI tool status unavailable"));
  return card("AI tools", ...toolReportRows(state), ...lastToolUpdateRows(state.last_update), toolCheckButton(state));
}
