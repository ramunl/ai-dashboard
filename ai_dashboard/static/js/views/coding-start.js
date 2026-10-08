// Coding › Work card, when nothing is pending: describe new work and start it
// as /plan, /implement or /bugfix. The agent plans in the background and
// sends the plan (or its questions) to the bot chat.

const WORK_TEXT_LIMIT = 4000;
const WORK_KINDS = [
  { kind: "plan", label: "Plan", verb: "Plan" },
  { kind: "implement", label: "Implement", verb: "Plan and prepare" },
  { kind: "bugfix", label: "Bugfix", verb: "Prepare a bugfix for" },
];
let workDraft = "";  // kept across refreshes until the agent accepts it

function workText() {
  return workDraft.replace(/\s+/g, " ").trim().slice(0, WORK_TEXT_LIMIT);
}

function startQuestion(choice, text) {
  const shown = text.length > 120 ? `${text.slice(0, 120)}…` : text;
  return `${choice.verb} "${shown}"? This uses AI tokens; the result arrives in the bot chat.`;
}

function startButton(choice) {
  const key = `work:start:${choice.kind}`;
  const className = choice.kind === "plan" ? "row-button" : "row-button work-secondary";
  return workButton(choice.label, key, className, (button) => {
    const text = workText();
    if (!text) {
      showAlert("Describe the feature or the bug first.");
      return;
    }
    button.disabled = true;
    askConfirmation(startQuestion(choice, text), (isConfirmed) => {
      if (!isConfirmed) {
        button.disabled = false;
        return;
      }
      requestAction(key, "start_work", { kind: choice.kind, text }, (result) => {
        workDraft = "";
        actionNotice = { text: `${result.message} The result will arrive in the bot chat.`, until: Date.now() + NOTICE_MS };
      });
    });
  });
}

function startWorkRows() {
  const draft = el("textarea", null, "work-draft");
  draft.placeholder = "Describe a feature or a bug…";
  draft.maxLength = WORK_TEXT_LIMIT;
  draft.value = workDraft;
  draft.disabled = hasPendingActions() || isWorkBusy;
  draft.setAttribute("aria-label", "New work");
  draft.addEventListener("input", () => { workDraft = draft.value; });
  return [draft, workActions(...WORK_KINDS.map(startButton))];
}
