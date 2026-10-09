// Coding › AI tools (/coding/ai): who plans, who implements, which models.

// The tool each role runs with each choice: the planner's "claude" is the
// Claude API (switchable model), the implementer's is Claude Code (read-only).
const ROLE_TOOLS = {
  planner: { codex: "codex", claude: "claude" },
  implementer: { codex: "codex", claude: "claude-code" },
};
const TOOL_LABELS = { claude: "Claude API", "claude-code": "Claude Code", codex: "Codex" };

function roleCard(setup, role, action, title) {
  const key = role;
  const list = radioList(role, setup[`${role}_options`].map((value) => ({ value })),
    setup[role], isActionPending(key), (value) => requestAction(key, action, { value }));
  const nodes = [list];
  if (isActionPending(key)) nodes.push(el("div", "Switching…", "card-note"));
  return card(title, ...nodes);
}

// Tools the current roles use, each with the roles that use it.
function toolsInUse(setup) {
  const uses = new Map();
  for (const role of ["planner", "implementer"]) {
    const tool = ROLE_TOOLS[role][setup[role]];
    if (tool) uses.set(tool, [...(uses.get(tool) || []), role]);
  }
  return uses;
}

function modelPicker(entry) {
  const key = `model:${entry.tool}`;
  // The current model is always offered, even if the provider's list omits it.
  const choices = entry.tool === "codex" ? ["default", ...entry.choices] : entry.choices;
  const values = [...new Set([entry.model, ...choices])];
  return radioList(`model-${entry.tool}`, values.map((value) => ({ value, label: entry.tool === "codex" && value === "default" ? "CLI default" : value })), entry.model,
    isActionPending(key), (model, input) => {
      const detail = entry.tool === "codex"
        ? "Applies to the next Codex run for planning and implementation. No restart or AI request is needed."
        : "The agent checks the model, then restarts.";
      const message = `Switch ${TOOL_LABELS[entry.tool]} to ${model}? ${detail}`;
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
    el("div", `${TOOL_LABELS[entry.tool] || entry.tool} · ${roles.join(" and ")}`, "card-subtitle"),
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
  if (entry.choices_error) nodes.push(el("div", `Model list unavailable: ${entry.choices_error}`, "card-note"));
  return nodes;
}

function modelsCard(setup) {
  const nodes = [];
  for (const [tool, roles] of toolsInUse(setup)) {
    const entry = setup.models.find((model) => model.tool === tool);
    if (entry) nodes.push(...toolModelNodes(entry, roles));
  }
  const latest = (setup.actions || []).find((result) => result.action === "switch_model");
  if (latest) {
    nodes.push(el("div", "Last model switch", "card-subtitle"));
    nodes.push(el("div", `${latest.status}: ${latest.message}`, "card-note"));
  }
  return card("Models", ...(nodes.length ? nodes : [muted("No model information from the agent.")]));
}

function aiToolsPage(view) {
  const setup = setupOf(view);
  settleActions(setup);
  const nodes = setup
    ? [roleCard(setup, "planner", "set_planner", "Planner"),
       roleCard(setup, "implementer", "set_implementer", "Implementer"),
       modelsCard(setup)]
    : [setupMissingCard()];
  return codingSubPage(view, "AI tools", nodes);
}
