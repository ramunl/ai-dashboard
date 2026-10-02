// Coding › Projects (/coding/projects): switch the active project, add one.

const REPOSITORY_PATTERN = /^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/;
let repositoryDraft = ""; // kept across refreshes while the user types

function projectRow(project, setup) {
  const node = el("div", null, "setup-row");
  const label = el("div");
  label.append(el("div", project.name), el("div", project.repository, "card-note"));
  node.append(label);
  if (project.active) {
    node.append(el("span", "Active", "setup-state"));
    return node;
  }
  const key = `project:${project.name}`;
  const button = el("button", isActionPending(key) ? "Switching…" : "Use", "row-button");
  button.type = "button";
  button.disabled = Boolean(setup.busy) || hasPendingActions();
  button.addEventListener("click", () => {
    button.disabled = true;
    button.textContent = "Switching…";
    requestAction(key, "use_project", { name: project.name });
  });
  node.append(button);
  return node;
}

function projectsCard(setup) {
  const rows = setup.projects.map((project) => projectRow(project, setup));
  if (setup.busy) rows.push(el("div", `Switching is disabled: ${setup.busy}.`, "card-note"));
  return card("Projects", ...rows);
}

function addRepositoryCard() {
  const input = el("input", null, "text-input");
  input.type = "text";
  input.placeholder = "owner/repo";
  input.autocapitalize = "off";
  input.spellcheck = false;
  input.value = repositoryDraft;
  const button = el("button", isActionPending("add") ? "Adding…" : "Add", "row-button");
  button.type = "button";
  const isValid = () => REPOSITORY_PATTERN.test(input.value.trim());
  button.disabled = isActionPending("add") || !isValid();
  input.addEventListener("input", () => {
    repositoryDraft = input.value;
    button.disabled = isActionPending("add") || !isValid();
  });
  button.addEventListener("click", () => {
    if (!isValid()) return;
    const repository = input.value.trim();
    repositoryDraft = "";
    input.blur(); // let the page refresh again
    button.disabled = true;
    button.textContent = "Adding…";
    requestAction("add", "add_repository", { repository });
  });
  const field = el("div", null, "input-row");
  field.append(input, button);
  return card(
    "Add repository",
    field,
    el("div", "Clones the repository on the server; this can take a minute.", "card-note"),
  );
}

function projectsPage(view) {
  const setup = setupOf(view);
  settleActions(setup);
  const nodes = setup ? [projectsCard(setup), addRepositoryCard()] : [setupMissingCard()];
  return codingSubPage(view, "Projects", nodes);
}
