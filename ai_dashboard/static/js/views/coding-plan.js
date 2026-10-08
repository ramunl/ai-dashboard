// Coding › Work card: what the pending plan says. The summary is always
// visible; branch, files, steps and risks open on tap. The agent publishes a
// bounded outline of the plan, never the generated prompt. Revise sends a
// note to the agent's /discuss; the new revision arrives in the bot chat.

let isReviseOpen = false;
let reviseDraft = "";  // kept across refreshes until the agent accepts it
let openPlan = "";  // "<plan id>:<revision>" of the plan whose details are open

function planList(title, items, tag) {
  if (!items || !items.length) return [];
  const list = el(tag, null, "plan-list");
  items.forEach((item) => list.append(el("li", item)));
  return [el("div", title, "card-subtitle"), list];
}

function planCount(count, word) {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function planDetails(plan) {
  if (typeof plan.summary !== "string") return [];  // an agent that predates the outline
  const steps = plan.steps || [];
  const files = plan.files || [];
  const key = `${plan.id}:${plan.revision}`;
  const details = el("details", null, "plan-details");
  details.open = openPlan === key;
  details.addEventListener("toggle", () => {
    if (details.open) openPlan = key;
    else if (openPlan === key) openPlan = "";
  });
  details.append(
    el("summary", `Details · ${planCount(steps.length, "step")} · ${planCount(files.length, "file")}`),
    row("Branch", plan.branch),
    ...planList("Files", files, "ul"),
    ...planList("Implementation", steps, "ol"),
    ...planList("Risks", plan.risks, "ul"),
  );
  return [el("p", plan.summary, "plan-summary"), details];
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
