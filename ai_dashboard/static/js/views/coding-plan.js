// Coding › Work card: what the pending plan says. The summary is always
// visible; branch, files, steps and risks open on tap. The agent publishes a
// bounded outline of the plan, never the generated prompt. Revise sends a
// note to the agent's /discuss; the new revision arrives in the bot chat.

let isReviseOpen = false;
let reviseDraft = "";  // kept across refreshes until the agent accepts it

function planList(title, items, tag) {
  if (!items || !items.length) return [];
  const list = el(tag, null, "plan-list");
  items.forEach((item) => list.append(el("li", item)));
  return [el("div", title, "card-subtitle"), list];
}

function planCount(count, word) {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

// The repositories a plan needs, in order, and what approving it runs. Shown
// outside Details: a plan for the wrong or several repositories is the thing
// to catch before approving.
function planRepositories(plan) {
  const repositories = Array.isArray(plan.repositories) ? plan.repositories : [];
  if (repositories.length < 2 && !plan.repository_note) return [];
  const list = el("ol", null, "plan-list plan-repositories");
  for (const repository of repositories) {
    const item = el("li");
    item.append(el("strong", repository.name), repository.changes ? ` — ${repository.changes}` : "");
    list.append(item);
  }
  const nodes = [el("div", "Repositories, in order", "card-subtitle"), list];
  if (plan.repository_note) nodes.push(el("div", plan.repository_note, "card-note plan-repository-note"));
  return nodes;
}

// Scope advice stays visible before approval; revising still needs confirmation.
function planScopeAdvice(plan, hasPlan = true) {
  const scope = plan.scope_assessment;
  if (!scope || scope.recommend_split !== true) return [];
  const box = el("div", null, "plan-scope-advice");
  box.setAttribute("role", "note");
  box.append(el("strong", "Split recommended before implementation"));
  if (typeof scope.reason === "string") box.append(el("p", scope.reason.slice(0, 500), "card-note"));
  const milestones = Array.isArray(scope.milestones) ? scope.milestones.filter(item => item && typeof item === "object" && !Array.isArray(item)).slice(0, 5) : [];
  if (milestones.length) {
    const list = el("ol", null, "plan-list");
    for (const milestone of milestones) {
      const item = el("li");
      item.append(el("strong", typeof milestone.title === "string" ? milestone.title.slice(0, 200) : "Milestone"));
      if (typeof milestone.acceptance === "string") item.append(el("div", milestone.acceptance.slice(0, 500), "card-note"));
      list.append(item);
    }
    box.append(el("div", "Suggested milestones", "card-subtitle"), list);
  }
  box.append(el("p", hasPlan
    ? "Use Revise to narrow this plan to one independently testable milestone. Approving still runs the whole plan."
    : "Use Cancel, then plan one independently testable milestone. Confirming still runs the whole change.", "card-note"));
  return [box];
}

function planDetails(plan) {
  if (typeof plan.summary !== "string") return [];  // an agent that predates the outline
  const steps = plan.steps || [];
  const files = plan.files || [];
  const key = `${plan.id}:${plan.revision}`;
  const details = rememberDetails(el("details", null, "plan-details"), ["plan", key]);
  details.append(
    el("summary", `Details · ${planCount(steps.length, "step")} · ${planCount(files.length, "file")}`),
    row("Branch", plan.branch),
    ...planList("Files", files, "ul"),
    ...planList("Implementation", steps, "ol"),
    ...planList("Risks", plan.risks, "ul"),
  );
  return [el("p", plan.summary, "plan-summary"), ...planRepositories(plan), details];
}

// A plan for several repositories: one To do task per repository, in order.
function splitButton(className, label = "Split into tasks") {
  const question = label === "Split into tasks"
    ? "Split into one task per repository? The plan is dropped; each part is planned again in its own repository when it starts (AI tokens)."
    : `${label}? The plan is dropped and a To do task is made there, planned again in that repository when it starts (AI tokens).`;
  return workButton(label, "work:split", className,
    (button) => confirmedWork(question, "work:split", "split_plan", {}, button,
      (result) => { actionNotice = { text: `${result.message.split("\n")[0]} See Tasks.`, until: Date.now() + NOTICE_MS }; }));
}

function planRepositoryNames(plan) {
  return (Array.isArray(plan.repositories) ? plan.repositories : []).map((repository) => repository.name);
}

function reviseButton() {
  return workButton(isReviseOpen ? "Close note" : "Revise", "work:revise", "row-button work-secondary", () => {
    isReviseOpen = !isReviseOpen;
    refresh();
  });
}

function sendReviseButton() {
  return workButton("Send note", "work:discuss", "row-button", (button) => {
    const text = reviseDraft.replace(/\s+/g, " ").trim().slice(0, WORK_TEXT_LIMIT);
    if (!text) {
      showAlert("Write what should change in the plan first.");
      return;
    }
    confirmedWork("Revise the plan with this note? This uses AI tokens; the new revision arrives in the bot chat.",
      "work:discuss", "discuss_plan", { text }, button, (result) => {
        reviseDraft = "";
        isReviseOpen = false;
        actionNotice = { text: `${result.message} The new revision will arrive in the bot chat.`, until: Date.now() + NOTICE_MS };
      });
  });
}

function reviseRows() {
  if (!isReviseOpen) return [];
  const note = el("textarea", null, "work-draft");
  note.placeholder = "What should change in the plan?";
  note.maxLength = WORK_TEXT_LIMIT;
  note.value = reviseDraft;
  note.disabled = hasPendingActions() || isWorkBusy;
  note.setAttribute("aria-label", "Revision note");
  note.addEventListener("input", () => { reviseDraft = note.value; });
  return [note, workActions(sendReviseButton())];
}
