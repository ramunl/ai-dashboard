// Setup changes for the coding agent: send the request, then follow the
// result the agent publishes in its snapshot (setup.actions).

const ACTION_TIMEOUT_MS = 3 * 60 * 1000;
const NOTICE_MS = 30 * 1000;
const FINAL_STATUSES = ["done", "failed", "expired", "rejected"];

const pendingActions = new Map(); // request id -> { key, startedAt }
let actionNotice = null; // { text, until } shown in the alert box

async function requestAction(key, action, args) {
  try {
    const answer = await postAction("coding/actions", tg ? tg.initData : "", { action, args });
    pendingActions.set(answer.id, { key, startedAt: Date.now() });
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
