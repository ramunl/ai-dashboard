// Coding › AI tools (/coding/ai): who plans, who implements, which models.

function choiceButtons(key, action, options, current) {
  const group = el("div", null, "segmented");
  group.setAttribute("role", "group");
  for (const option of options) {
    const button = el("button", option);
    button.type = "button";
    button.setAttribute("aria-pressed", String(option === current));
    button.disabled = option === current || isActionPending(key);
    button.addEventListener("click", () => {
      button.disabled = true;
      requestAction(key, action, { value: option });
    });
    group.append(button);
  }
  return group;
}

function rolesCard(setup) {
  const planner = el("div", null, "setup-row");
  planner.append(el("span", "Planner"), choiceButtons("planner", "set_planner", setup.planner_options, setup.planner));
  const implementer = el("div", null, "setup-row");
  implementer.append(
    el("span", "Implementer"),
    choiceButtons("implementer", "set_implementer", setup.implementer_options, setup.implementer),
  );
  return card("Roles", planner, implementer);
}

function confirmModelSwitch(button, tool, model) {
  const message = `Switch ${tool} to ${model}? The agent checks the model, then restarts.`;
  askConfirmation(message, (isConfirmed) => {
    if (!isConfirmed) return;
    button.disabled = true;
    button.textContent = "Switching…";
    requestAction(`model:${tool}`, "switch_model", { tool, model });
  });
}

function modelChoiceRow(entry, model) {
  const node = el("div", null, "setup-row");
  node.append(el("span", model));
  if (model === entry.model) {
    node.append(el("span", "Current", "setup-state"));
    return node;
  }
  const key = `model:${entry.tool}`;
  const button = el("button", "Use", "row-button");
  button.type = "button";
  button.disabled = isActionPending(key);
  button.addEventListener("click", () => confirmModelSwitch(button, entry.tool, model));
  node.append(button);
  return node;
}

function modelRows(entry) {
  if (!entry.manageable) {
    return [row(entry.tool, entry.model || "—"), el("div", `Read-only. ${entry.note}`, "card-note")];
  }
  const rows = [el("div", entry.tool, "card-subtitle")];
  const choices = entry.choices.length ? entry.choices : [entry.model];
  rows.push(...choices.map((model) => modelChoiceRow(entry, model)));
  if (isActionPending(`model:${entry.tool}`)) {
    rows.push(el("div", "Switching; the agent restarts and comes back in a few seconds.", "card-note"));
  }
  if (entry.choices_error) rows.push(el("div", `Model list unavailable: ${entry.choices_error}`, "card-note"));
  return rows;
}

function modelsCard(setup) {
  return card("Models", ...setup.models.flatMap(modelRows));
}

function aiToolsPage(view) {
  const setup = setupOf(view);
  settleActions(setup);
  const nodes = setup ? [rolesCard(setup), modelsCard(setup)] : [setupMissingCard()];
  return codingSubPage(view, "AI tools", nodes);
}
