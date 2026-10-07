// Coding › Work card: what the pending plan says. The summary is always
// visible; branch, files, steps and risks open on tap. The agent publishes a
// bounded outline of the plan, never the generated prompt.

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
