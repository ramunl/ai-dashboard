const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

function page() {
  const dom = new JSDOM("<main></main>", { runScripts: "outside-only" });
  for (const file of ["dom.js", "views/coding.js", "views/tasks.js"]) {
    dom.window.eval(fs.readFileSync(path.join(__dirname, "../../ai_dashboard/static/js", file), "utf8"));
  }
  dom.window.hasPendingActions = () => false;
  dom.window.isActionPending = () => false;
  dom.window.workActions = (...nodes) => { const box = dom.window.document.createElement("div"); box.append(...nodes); return box; };
  return dom;
}

test("operational report renders as text and Open Ops navigates without executing an action", () => {
  const dom = page();
  let destination;
  dom.window.navigate = (value) => { destination = value; };
  const nodes = dom.window.runOutcomeCard({ status: "ops_required", branch: "fix/x", at: 1000, report: "HTTP 402 <script>bad()</script>" });
  dom.window.document.body.append(...nodes);
  assert.match(dom.window.document.body.textContent, /Needs Ops action/);
  assert.match(dom.window.document.body.textContent, /HTTP 402/);
  assert.equal(dom.window.document.querySelector("script"), null);
  dom.window.document.querySelector("a").click();
  assert.equal(destination, "ops");
  dom.window.close();
});

test("blocked and operational tasks remain active, retryable and removable", () => {
  const dom = page();
  for (const stage of ["blocked", "ops_required"]) {
    const task = { id: "a", stage, title: "fix" };
    assert.equal(dom.window.isTaskFinished(task), false);
    const actions = dom.window.taskActions(task)[0];
    assert.match(actions.textContent, /Start planning/);
    assert.match(actions.textContent, /Remove/);
    if (stage === "ops_required") assert.match(actions.textContent, /Open Ops/);
  }
  assert.deepEqual(Array.from(dom.window.runOutcomeCard(null)), []);
  dom.window.close();
});
