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
let workImages = [];  // { file, url } for the draft; sent with Plan or Implement
let workImagesSending = false;
let workRepo = "";  // the active project: where work with images becomes a task

function workText() {
  return workDraft.replace(/\s+/g, " ").trim().slice(0, WORK_TEXT_LIMIT);
}

function startQuestion(choice, text) {
  const shown = text.length > 120 ? `${text.slice(0, 120)}…` : text;
  return `${choice.verb} "${shown}"? This uses AI tokens; the result arrives in the bot chat.`;
}

// Work with images goes as a task in the active project: tasks carry images.
function startWithImages(choice, text, key, button) {
  if (choice.kind === "bugfix") {
    showAlert("Images go with Plan or Implement; remove them for a bugfix.");
    return;
  }
  if (!workRepo) {
    showAlert("No active project to plan in.");
    return;
  }
  const count = workImages.length;
  const shown = text.length > 120 ? `${text.slice(0, 120)}…` : text;
  button.disabled = true;
  askConfirmation(`${choice.verb} "${shown}" with ${count} image${count === 1 ? "" : "s"}${plannerText()}? It becomes a task in ${workRepo}; this uses AI tokens.`, async (isConfirmed) => {
    if (!isConfirmed) {
      button.disabled = false;
      return;
    }
    workImagesSending = true;
    refresh();
    let ids;
    try {
      ids = await uploadImages([...workImages]);
    } catch (error) {
      workImagesSending = false;
      actionNotice = { text: `Image not sent: ${error.message}`, until: Date.now() + NOTICE_MS };
      refresh();
      return;
    }
    workImagesSending = false;
    requestAction(key, "create_task", { repo: workRepo, text, todo: "-", images: ids.join(",") }, (result) => {
      workDraft = "";
      for (const image of workImages) URL.revokeObjectURL(image.url);
      workImages = [];
      actionNotice = { text: `${result.message} It is in Tasks; the plan arrives in the bot chat.`, until: Date.now() + NOTICE_MS };
    });
  });
}

function startButton(choice) {
  const key = `work:start:${choice.kind}`;
  const className = choice.kind === "plan" ? "row-button" : "row-button work-secondary";
  const button = workButton(choice.label, key, className, (button) => {
    const text = workText();
    if (!text) {
      showAlert("Describe the feature or the bug first.");
      return;
    }
    if (workImages.length) {
      startWithImages(choice, text, key, button);
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
  button.disabled = button.disabled || workImagesSending;
  if (workImagesSending && choice.kind !== "bugfix") button.textContent = "Sending images…";
  return button;
}

function addWorkImages(files) {
  addImagesTo(workImages, files);
  refresh();
}

function startWorkRows() {
  const draft = el("textarea", null, "work-draft");
  draft.placeholder = "Describe a feature or a bug…";
  draft.maxLength = WORK_TEXT_LIMIT;
  draft.value = workDraft;
  draft.disabled = hasPendingActions() || isWorkBusy;
  draft.setAttribute("aria-label", "New work");
  draft.addEventListener("input", () => { workDraft = draft.value; });
  // A screenshot pasted into the box is added as an image; text pastes as usual.
  draft.addEventListener("paste", (event) => {
    const files = [...(event.clipboardData?.files || [])].filter((file) => file.type.startsWith("image/"));
    if (!files.length) return;
    event.preventDefault();
    addWorkImages(files);
  });
  const disabled = hasPendingActions() || isWorkBusy || workImagesSending;
  const images = el("div", null, "task-images work-images");
  images.append(imagePicker(disabled, addWorkImages), ...workImages.map((image, index) => imagePreview(image, index, workImages)));
  if (workImages.length) images.append(el("div", "With images, Plan or Implement makes a task in the active project.", "card-note"));
  return [draft, images, workActions(...WORK_KINDS.map(startButton))];
}
