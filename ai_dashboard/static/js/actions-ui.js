// Setup changes for the coding agent: send the request, then follow the
// result the agent publishes in its snapshot (setup.actions).

const ACTION_TIMEOUT_MS = 3 * 60 * 1000;
const NOTICE_MS = 30 * 1000;
const FINAL_STATUSES = ["done", "failed", "expired", "rejected"];

const pendingActions = new Map(); // request id -> { key, startedAt }
let actionNotice = null; // { text, until } shown in the alert box

// onDone(result), if given, runs once the agent reports the action as done.
async function requestAction(key, action, args, onDone = null) {
  try {
    const answer = await postAction("coding/actions", tg ? tg.initData : "", { action, args });
    pendingActions.set(answer.id, { key, startedAt: Date.now(), onDone });
  } catch (error) {
    actionNotice = { text: `Not sent: ${error.message}`, until: Date.now() + NOTICE_MS };
  }
  refresh();
}

function isActionPending(key) {
  return [...pendingActions.values()].some((pending) => pending.key === key);
}

function hasPendingActions() {
  return pendingActions.size > 0;
}

// Match pending requests with the agent's results; remember what went wrong.
function settleActions(setup) {
  const results = new Map(((setup && setup.actions) || []).map((result) => [result.id, result]));
  for (const [id, pending] of pendingActions) {
    const result = results.get(id);
    if (result && FINAL_STATUSES.includes(result.status)) {
      pendingActions.delete(id);
      if (result.status !== "done") {
        actionNotice = { text: result.message, until: Date.now() + NOTICE_MS };
      } else if (pending.onDone) {
        pending.onDone(result);
      }
    } else if (Date.now() - pending.startedAt > ACTION_TIMEOUT_MS) {
      pendingActions.delete(id);
      actionNotice = { text: "No answer from the coding agent.", until: Date.now() + NOTICE_MS };
    }
  }
}

function actionNoticeText() {
  return actionNotice && Date.now() < actionNotice.until ? actionNotice.text : "";
}

// The setup published by the coding agent, or null for an older agent.
function setupOf(view) {
  return (view.snapshot && view.snapshot.setup) || null;
}

function setupMissingCard() {
  return card("Setup", muted("Update the coding agent to manage its setup here."));
}

// Header and alert shared by the Coding sub-windows.
function codingSubPage(view, title, nodes) {
  const project = view.snapshot && view.snapshot.project;
  const problem = view.problem ? `coding agent ${view.problem}` : "";
  return {
    title,
    subtitle: project ? `active project: ${project.name}` : "",
    status: view.problem ? "bad" : "ok",
    alert: problem || actionNoticeText(),
    nodes,
  };
}

// A group of radio buttons; onPick(value, input) runs when the user picks one.
function radioList(name, options, current, disabled, onPick) {
  const group = el("div", null, "radio-list");
  group.setAttribute("role", "radiogroup");
  for (const option of options) {
    const label = el("label", null, "radio-row");
    const input = el("input");
    input.type = "radio";
    input.name = name;
    input.value = option.value;
    input.checked = option.value === current;
    input.disabled = disabled;
    input.addEventListener("change", () => onPick(option.value, input));
    const text = el("span");
    text.append(el("span", option.label || option.value));
    if (option.note) text.append(el("span", option.note, "card-note radio-note"));
    label.append(input, text);
    group.append(label);
  }
  return group;
}
