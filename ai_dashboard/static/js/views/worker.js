// Tasks › Worker card: the coding agent's autonomous worker. It takes To do
// tasks one at a time, plans them, waits for your approval, then runs them to
// a pull request. Here: on/off, what it is doing, and its budget.

const WORKER_RUN_CHOICES = [0, 1, 2, 3, 5, 10, 20];  // 0 = no cap
const WORKER_RESERVE_CHOICES = [0, 10, 15, 20, 30, 40, 50];
let workerBudgetDraft = null;  // { max_runs, reserve } while being edited

function workerSwitchButton(worker) {
  const key = "worker:switch";
  const label = worker.enabled ? "Switch off" : "Switch on";
  const className = worker.enabled ? "row-button work-secondary" : "row-button";
  return taskButton(label, key, className, (button) => {
    const value = worker.enabled ? "off" : "on";
    const question = worker.enabled
      ? "Switch the worker off? A task it already started keeps going."
      : "Switch the worker on? It plans To do tasks by itself (AI tokens) and runs a plan once you approve it.";
    button.disabled = true;
    askConfirmation(question, (isConfirmed) => {
      if (isConfirmed) requestAction(key, "worker_switch", { value });
      else button.disabled = false;
    });
  });
}

function budgetSelect(label, choices, value, describe, onChange) {
  const select = el("select");
  for (const choice of choices) {
    const option = el("option", describe(choice));
    option.value = String(choice);
    select.append(option);
  }
  if (!choices.includes(value)) {
    const option = el("option", describe(value));
    option.value = String(value);
    select.append(option);
  }
  select.value = String(value);
  select.addEventListener("change", () => onChange(Number(select.value)));
  return pmField(label, select);
}

function workerBudgetRows(worker) {
  const draft = workerBudgetDraft || { max_runs: worker.max_runs, reserve: worker.reserve };
  const runs = budgetSelect("Runs per day", WORKER_RUN_CHOICES, draft.max_runs,
    (n) => (n ? String(n) : "No cap"), (n) => { workerBudgetDraft = { ...draft, max_runs: n }; refresh(); });
  const reserve = budgetSelect("Keep for me (Codex)", WORKER_RESERVE_CHOICES, draft.reserve,
    (n) => `${n}%`, (n) => { workerBudgetDraft = { ...draft, reserve: n }; refresh(); });
  const fields = el("div", null, "pm-bar worker-budget");
  fields.append(runs, reserve);
  const rows = [fields];
  const isChanged = workerBudgetDraft
    && (draft.max_runs !== worker.max_runs || draft.reserve !== worker.reserve);
  if (isChanged) {
    rows.push(workActions(taskButton("Save budget", "worker:budget", "row-button", (button) => {
      button.disabled = true;
      requestAction("worker:budget", "worker_settings",
        { max_runs: String(draft.max_runs), reserve: String(draft.reserve) },
        () => { workerBudgetDraft = null; });
    })));
  }
  return rows;
}

// Switch between Codex and Claude by their limits, or keep the chosen ones.
function workerToolsRow(worker) {
  const isAuto = worker.auto_tool !== false;
  const label = el("label", null, "radio-row worker-tools");
  const box = el("input");
  box.type = "checkbox";
  box.checked = isAuto;
  box.disabled = hasPendingActions();
  box.addEventListener("change", () => {
    box.disabled = true;
    requestAction("worker:tools", "worker_tools", { value: box.checked ? "auto" : "fixed" });
  });
  const text = el("span");
  text.append(el("span", "Switch tools by limits"),
    el("span", isAuto ? "Uses the other tool when one has no room" : "Uses only your chosen planner and implementer", "card-note radio-note"));
  label.append(box, text);
  return label;
}

function workerScanButton() {
  const key = "worker:scan";
  return taskButton("Scan logs now", key, "row-button work-secondary", (button) => {
    button.disabled = true;
    requestAction(key, "worker_scan", {});
  });
}

const WORKER_OUTCOMES = { planned: "plan ready", pr: "PR opened", failed: "failed", limit: "hit a limit" };

function dayLabel(day, index) {
  if (index === 0) return "Today";
  if (index === 1) return "Yesterday";
  return new Date(`${day}T12:00:00`).toLocaleDateString(undefined, { weekday: "short", day: "numeric" });
}

// The last 7 days, only those with finished steps, then the latest five.
function workerStatsRows(worker) {
  const days = (worker.stats || []).map((day, index) => ({ ...day, label: dayLabel(day.day, index) }))
    .filter((day) => day.planned || day.pr || day.failed || day.limit);
  if (!days.length && !(worker.recent || []).length) return [];
  const rows = [el("div", "Last 7 days", "card-subtitle")];
  if (!days.length) rows.push(muted("No finished steps."));
  for (const day of days) {
    const parts = [];
    if (day.planned) parts.push(`${day.planned} planned`);
    if (day.pr) parts.push(`${day.pr} PR${day.pr === 1 ? "" : "s"}`);
    if (day.failed) parts.push(`${day.failed} failed`);
    if (day.limit) parts.push(`${day.limit} limit stop${day.limit === 1 ? "" : "s"}`);
    const tools = Object.entries(day.tools || {}).map(([tool, n]) => `${tool} ${n}`).join(", ");
    rows.push(row(day.label, parts.join(" · ") + (tools ? ` (${tools})` : "")));
  }
  for (const item of worker.recent || []) {
    const outcome = WORKER_OUTCOMES[item.outcome] || item.outcome;
    const isOld = Date.now() / 1000 - item.at > 20 * 3600;
    const when = isOld ? new Date(item.at * 1000).toLocaleDateString(undefined, { day: "numeric", month: "short" }) : clockTime(item.at);
    rows.push(el("div", `${when} ${item.title} — ${outcome}${item.tool ? ` with ${item.tool}` : ""}`, "card-note worker-recent"));
  }
  return rows;
}

const WORKER_REVIEW_CHOICES = [0, 1, 2, 3, 5, 10];  // proposals per daily review; 0 = off

// Daily code review: how many proposals, the last review, and Review now.
function workerReviewRows(worker) {
  if (typeof worker.review_proposals !== "number") return [];  // an older agent
  const count = budgetSelect("Code review proposals", WORKER_REVIEW_CHOICES, worker.review_proposals,
    (n) => (n ? `${n} a day` : "Off"), (n) => requestAction("worker:reviews", "worker_reviews", { value: String(n) }));
  count.querySelector("select").disabled = hasPendingActions();
  const rows = [count];
  const last = worker.last_review;
  if (last) {
    const ago = formatDuration(Math.max(0, Date.now() / 1000 - last.at));
    rows.push(el("div", `Last review: ${last.repo}, ${last.proposed} proposal${last.proposed === 1 ? "" : "s"}, ${ago} ago`, "card-note"));
  }
  rows.push(workActions(taskButton("Review a repo now", "worker:review", "row-button work-secondary", (button) => {
    button.disabled = true;
    askConfirmation("Review the next repository now? This uses AI tokens; proposals arrive in Tasks.", (isConfirmed) => {
      if (isConfirmed) requestAction("worker:review", "worker_review", {});
      else button.disabled = false;
    });
  })));
  return rows;
}

function workerCard(worker) {
  const cap = worker.max_runs ? `${worker.runs_today} of ${worker.max_runs} runs today` : `${worker.runs_today} runs today · no cap`;
  const title = el("div");
  title.append(statusDot(worker.enabled ? (worker.failures ? "warn" : "ok") : "info"), ` ${worker.enabled ? "On" : "Off"}`);
  const head = el("div", null, "row");
  head.append(title, el("span", cap));
  const rows = [head, el("div", worker.status, "card-note worker-status")];
  if (worker.failures) rows.push(el("div", `${worker.failures} failed task(s) in a row; it stops after 3.`, "card-note"));
  for (const [tool, until] of Object.entries(worker.out_until || {})) {
    rows.push(row(`${tool[0].toUpperCase()}${tool.slice(1)}`, `out until ${clockTime(until)}`));
  }
  rows.push(workActions(workerSwitchButton(worker), workerScanButton()), ...workerBudgetRows(worker), workerToolsRow(worker), ...workerReviewRows(worker), ...workerStatsRows(worker),
    el("div", "Once a day while idle it reads the services' error logs and reviews one repository, and proposes tasks.", "card-note"),
    el("div", "Claude Code's limits can't be read from the server: the worker learns Claude is out when a run hits its limit.", "card-note"));
  return card("Worker", ...rows);
}
