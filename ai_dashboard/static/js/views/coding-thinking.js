// Coding › Work card: what the agent is thinking about right now (a new plan,
// a revision, a bug report), with how long it has been at it. The agent
// publishes this as snapshot.thinking only while the AI call runs.

const THINKING_LABELS = {
  plan: "Planning",
  implement: "Planning",
  revise: "Revising the plan",
  bugfix: "Checking the bug report",
  answer: "Checking your answer",
};

function thinkingRows(thinking) {
  if (!thinking) return [];
  const label = THINKING_LABELS[thinking.kind] || "Working";
  const seconds = Math.max(0, Date.now() / 1000 - thinking.started_at);
  const node = el("div", null, "thinking-row");
  node.setAttribute("role", "status");
  node.append(el("span", null, "thinking-dot"), el("span", `${label}… ${formatDuration(seconds)}`));
  const rows = [node];
  if (thinking.about) rows.push(el("div", thinking.about, "card-note thinking-about"));
  rows.push(el("div", "The result will arrive in the bot chat and here.", "card-note"));
  return rows;
}
