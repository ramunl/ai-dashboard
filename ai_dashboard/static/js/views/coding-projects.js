// Coding › Projects (/coding/projects): switch the active project, add one.

const REPOSITORY_PATTERN = /^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/;
let repositoryDraft = ""; // kept across refreshes while the user types

function projectsCard(setup) {
  const active = setup.projects.find((project) => project.active);
  const options = setup.projects.map((project) => ({
    value: project.name,
    note: project.repository,
  }));
  const list = radioList("project", options, active && active.name,
    Boolean(setup.busy) || hasPendingActions(), (name) => {
      requestAction(`project:${name}`, "use_project", { name });
    });
  const nodes = [list];
  if (setup.busy) nodes.push(el("div", `Switching is disabled: ${setup.busy}.`, "card-note"));
  if (hasPendingActions()) nodes.push(el("div", "Switching…", "card-note"));
  return card("Projects", ...nodes);
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
