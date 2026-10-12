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

function workerCard(worker) {
  const cap = worker.max_runs ? `${worker.runs_today} of ${worker.max_runs} runs today` : `${worker.runs_today} runs today · no cap`;
  const title = el("div");
  title.append(statusDot(worker.enabled ? (worker.failures ? "warn" : "ok") : "info"), ` ${worker.enabled ? "On" : "Off"}`);
  const head = el("div", null, "row");
  head.append(title, el("span", cap));
  const rows = [head, el("div", worker.status, "card-note worker-status")];
  if (worker.failures) rows.push(el("div", `${worker.failures} failed task(s) in a row; it stops after 3.`, "card-note"));
  rows.push(workActions(workerSwitchButton(worker)), ...workerBudgetRows(worker),
    el("div", "Claude Code's limits can't be read from the server, so only Codex's are kept.", "card-note"));
  return card("Worker", ...rows);
}
