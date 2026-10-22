// Coding › Work card, when nothing is pending: describe new work and start it
// as /plan, /implement or /bugfix. The agent plans in the background and
// sends the plan (or its questions) to the bot chat. Images (picked, or pasted
// into the text box) make it a task in the active project, planned with them.

const WORK_TEXT_LIMIT = 4000;
const WORK_KINDS = [
  { kind: "plan", label: "Plan", verb: "Plan" },
  { kind: "implement", label: "Implement", verb: "Plan and prepare" },
  { kind: "bugfix", label: "Bugfix", verb: "Prepare a bugfix for" },
];
let workDraft = "";  // kept across refreshes until the agent accepts it
let workImages = [];  // original Files for the draft; sent with Plan or Implement
let workImagesSending = false;
let workRepo = "";  // the active project: where work with images becomes a task

function workText() {
  return workDraft.replace(/\s+/g, " ").trim().slice(0, WORK_TEXT_LIMIT);
}

function startQuestion(choice, text) {
  const shown = text.length > 120 ? `${text.slice(0, 120)}…` : text;
  return `${choice.verb} "${shown}"? This uses AI tokens; the result arrives in the bot chat.`;
}

// Keep confirmation, uploads and the HTTP request locked across polling renders.
let workStartKey = "";
let workStartStage = "";

function setWorkStartStage(stage) {
  workStartStage = stage;
  for (const button of document.querySelectorAll("[data-work-start]")) {
    button.disabled = true;
    if (button.dataset.workStart === workStartKey) button.textContent = stage;
  }
  for (const control of document.querySelectorAll(".work-draft, .work-images input, .work-images button, .attachment-preview button")) control.disabled = true;
  refresh();
}

function startButton(choice) {
  const key = `work:start:${choice.kind}`;
  const className = choice.kind === "plan" ? "row-button" : "row-button work-secondary";
  const button = workButton(choice.label, key, className, () => {
    if (workStartKey || hasPendingActions()) return;
    const text = workText();
    if (!text) {
      showAlert("Describe the feature or the bug first.");
      return;
    }
    const picked = [...workImages];
    const repo = workRepo;
    if (picked.length && choice.kind === "bugfix") {
      showAlert("Images go with Plan or Implement; remove them for a bugfix.");
      return;
    }
    if (picked.length && !repo) {
      showAlert("No active project to plan in.");
      return;
    }
    workStartKey = key;
    setWorkStartStage("Confirming…");
    const shown = text.length > 120 ? `${text.slice(0, 120)}…` : text;
    const question = picked.length
      ? `${choice.verb} "${shown}" with ${picked.length} image${picked.length === 1 ? "" : "s"}${plannerText()}? It becomes a task in ${repo}; this uses AI tokens.`
      : startQuestion(choice, text);
    askConfirmation(question, async (isConfirmed) => {
      try {
        if (!isConfirmed) return;
        let ids = [];
        if (picked.length) {
          workImagesSending = true;
          setWorkStartStage("Sending images…");
          try { ids = await uploadImages(picked); }
          catch (error) {
            actionNotice = { text: `Image not sent: ${error.message}`, until: Date.now() + NOTICE_MS };
            return;
          }
        }
        setWorkStartStage("Sending…");
        await requestAction(key, picked.length ? "create_task" : "start_work",
          picked.length ? { repo, text, todo: "-", images: ids.join(",") } : { kind: choice.kind, text },
          (result) => {
            workDraft = "";
            workImages = [];
            actionNotice = { text: `${result.message} ${picked.length ? "It is in Tasks; the plan arrives in the bot chat." : "The result will arrive in the bot chat."}`, until: Date.now() + NOTICE_MS };
          });
      } finally {
        workImagesSending = false;
        workStartKey = "";
        workStartStage = "";
        refresh();
      }
    });
  });
  button.dataset.workStart = key;
  button.disabled = button.disabled || Boolean(workStartKey);
  if (workStartKey === key) button.textContent = workStartStage;
  return button;
}

function startWorkRows() {
  const draft = el("textarea", null, "work-draft");
  draft.placeholder = "Describe a feature or a bug…";
  draft.maxLength = WORK_TEXT_LIMIT;
  draft.value = workDraft;
  draft.disabled = hasPendingActions() || isWorkBusy || Boolean(workStartKey);
  draft.setAttribute("aria-label", "New work");
  draft.addEventListener("input", () => { workDraft = draft.value; });
  const disabled = hasPendingActions() || isWorkBusy || Boolean(workStartKey);
  return [draft, ...codingWorkerAttachments(draft, disabled), workActions(...WORK_KINDS.map(startButton))];
}
