// Coding › AI tools (/coding/ai): who plans, who implements, which models.
// Tools, providers and models come from the DS05 registry (static/js/registry.js
// and ai_dashboard/agent_actions.py); an older snapshot falls back to setup.

function roleCard(model, role, action, title) {
  const entry = model.roles[role];
  const list = radioList(role, entry.options,
    entry.current, isActionPending(role), (value) => requestAction(role, action, { value }));
  const nodes = [list];
  if (isActionPending(role)) nodes.push(el("div", "Switching…", "card-note"));
  return card(title, ...nodes);
}

// Tools the current roles use, each with the roles that use it.
function toolsInUse(model) {
  const uses = new Map();
  for (const role of ["planner", "implementer"]) {
    const tool = model.roles[role].tool;
    if (tool) uses.set(tool, [...(uses.get(tool) || []), role]);
  }
  return uses;
}

function modelPicker(entry) {
  const key = `model:${entry.tool}`;
  // The current model is always offered, even if the provider's list omits it.
  const choices = entry.tool === "codex" ? ["default", ...entry.models] : entry.models;
  const values = [...new Set([entry.model, ...choices])];
  return radioList(`model-${entry.tool}`, values.map((value) => ({ value, label: entry.tool === "codex" && value === "default" ? "CLI default" : value })), entry.model,
    isActionPending(key), (model, input) => {
      const detail = entry.tool === "codex"
        ? `Applies to the next ${entry.label} run for planning and implementation. No restart or AI request is needed.`
        : "The agent checks the model, then restarts.";
      const message = `Switch ${entry.label} to ${model}? ${detail}`;
      askConfirmation(message, (isConfirmed) => {
        if (!isConfirmed) {
          // Declined: show the model that is still current.
          for (const radio of input.closest(".radio-list").querySelectorAll("input")) {
            radio.checked = radio.value === entry.model;
          }
          return;
        }
        requestAction(key, "switch_model", { tool: entry.tool, model });
      });
    });
}

function toolModelNodes(entry, roles) {
  const nodes = [
    el("div", `${entry.label} · ${roles.join(" and ")}`, "card-subtitle"),
    row("Current", entry.tool === "codex" && entry.model === "default" ? "CLI default" : entry.model || "—"),
  ];
  if (!entry.manageable) {
    nodes.push(el("div", `Read-only. ${entry.note}`, "card-note"));
    return nodes;
  }
  if (entry.note) nodes.push(el("div", entry.note, "card-note"));
  nodes.push(modelPicker(entry));
  if (isActionPending(`model:${entry.tool}`)) {
    nodes.push(el("div", entry.tool === "codex" ? "Saving model for the next run…" : "Switching; the agent restarts and comes back in a few seconds.", "card-note"));
  }
  if (entry.modelsError) nodes.push(el("div", `Model list unavailable: ${entry.modelsError}`, "card-note"));
  return nodes;
}

function modelsCard(model, setup) {
  const nodes = [];
  for (const [tool, roles] of toolsInUse(model)) {
    const entry = model.tools[tool];
    if (entry) nodes.push(...toolModelNodes(entry, roles));
  }
  const latest = ((setup && setup.actions) || []).find((result) => result.action === "switch_model");
  if (latest) {
    nodes.push(el("div", "Last model switch", "card-subtitle"));
    nodes.push(el("div", `${latest.status}: ${latest.message}`, "card-note"));
  }
  return card("Models", ...(nodes.length ? nodes : [muted("No model information from the agent.")]));
}

function aiToolsPage(view) {
  const setup = setupOf(view);
  settleActions(setup);
  const model = codingToolsModel(view.snapshot);
  const nodes = model
    ? [roleCard(model, "planner", "set_planner", "Planner"),
       roleCard(model, "implementer", "set_implementer", "Implementer"),
       modelsCard(model, setup)]
    : [setupMissingCard()];
  nodes.push(codingAuthCard(setup));
  return codingSubPage(view, "AI tools", nodes);
}
