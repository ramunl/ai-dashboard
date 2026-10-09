const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

function modelsPage({ confirm = true, pending = false, error = null } = {}) {
  const dom = new JSDOM("<main></main>", { runScripts: "outside-only" });
  const win = dom.window;
  const requests = [];
  const confirmations = [];
  win.isActionPending = () => pending;
  win.askConfirmation = (message, callback) => { confirmations.push(message); callback(confirm); };
  win.requestAction = (key, action, args) => requests.push({ key, action, ...args });
  for (const file of ["dom.js", "actions-ui.js", "views/coding-ai.js"]) {
    win.eval(fs.readFileSync(path.join(__dirname, "../../ai_dashboard/static/js", file), "utf8"));
  }
  win.askConfirmation = (message, callback) => { confirmations.push(message); callback(confirm); };
  // The real transport tracks pending requests; replace only that boundary.
  win.isActionPending = () => pending;
  win.requestAction = (key, action, args) => requests.push({ key, action, ...args });
  const setup = { planner: "codex", implementer: "codex", actions: [], models: [
    { tool: "codex", model: "default", manageable: true, choices: ["default", "codex-test"], choices_error: error },
  ] };
  win.document.querySelector("main").append(win.modelsCard(setup));
  return { dom, win, requests, confirmations, inputs: [...win.document.querySelectorAll("input")] };
}

test("Codex roles share a picker with a CLI default and no restart confirmation", () => {
  const page = modelsPage();
  assert.equal(page.inputs.length, 2);
  assert.equal(page.inputs[0].checked, true);
  assert.match(page.win.document.body.textContent, /Codex · planner and implementer/);
  assert.match(page.win.document.body.textContent, /CLI default/);
  page.inputs[1].click();
  assert.equal(page.requests[0].tool, "codex");
  assert.equal(page.requests[0].model, "codex-test");
  assert.match(page.confirmations[0], /next Codex run/);
  assert.doesNotMatch(page.confirmations[0], /then restarts/);
  page.dom.window.close();
});

test("declining a Codex change restores the current selection", () => {
  const page = modelsPage({ confirm: false });
  page.inputs[1].click();
  assert.equal(page.inputs[0].checked, true);
  assert.equal(page.requests.length, 0);
  page.dom.window.close();
});

test("pending Codex saves disable controls and catalog errors stay visible", () => {
  const page = modelsPage({ pending: true, error: "Check login" });
  assert.ok(page.inputs.every((input) => input.disabled));
  assert.match(page.win.document.body.textContent, /Saving model for the next run/);
  assert.match(page.win.document.body.textContent, /Model list unavailable: Check login/);
  page.dom.window.close();
});
