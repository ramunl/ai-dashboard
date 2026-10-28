const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");
const root = path.join(__dirname, "../../ai_dashboard/static");
const source = fs.readFileSync(path.join(root, "index.html"), "utf8")
  .replace('<script src="/static/vendor/telegram-web-app.js"></script>', "")
  .replace(/<script src="\/static\/(.+?)"><\/script>/g, (_, file) =>
    `<script>${fs.readFileSync(path.join(root, file), "utf8")}</script>`);
const tick = () => new Promise(resolve => setTimeout(resolve, 20));
const task = { id: "0a1b2c3d", title: "Fix <script>text</script>", repo: "repo", stage: "done", can_reopen: true };
async function page(t, tasks = [task]) {
  const state = { posts: [], confirmations: [], tasks, actions: [], deployed: {}, post: async () => ({ id: "request1" }) };
  const dom = new JSDOM(source, {
    url: "https://dashboard.test/tasks", runScripts: "dangerously", pretendToBeVisual: true,
    beforeParse(w) {
      w.Telegram = { WebApp: { initData: "signed", ready() {}, expand() {},
        showConfirm(message, callback) { state.confirmations.push({ message, callback }); },
        BackButton: { show() {}, hide() {}, onClick() {} } } };
      w.fetch = async (url, init) => {
        if (init.method === "POST") {
          state.posts.push(JSON.parse(init.body));
          const answer = await state.post(init);
          return { ok: true, json: async () => answer };
        }
        if (state.get) return state.get(url, init);
        return { ok: true, json: async () => ({ snapshot: { tasks: state.tasks,
          setup: { planner: "codex", actions: state.actions } },
          task_progress: { deployed: state.deployed, closed: [task.id] } }) };
      };
    },
  });
  t.after(() => dom.window.close());
  state.w = dom.window;
  state.buttons = () => [...dom.window.document.querySelectorAll("button")];
  state.button = label => state.buttons().find(b => b.textContent === label);
  state.refresh = async () => { await dom.window.refresh(); await tick(); };
  await tick();
  dom.window.eval('taskFilter = "finished"');
  await state.refresh();
  return state;
}

test("eligibility is explicit, including derived Deployed; Retry keeps its meaning", async t => {
  const p = await page(t);
  for (const [stage, eligible, visible] of [
    ["done", true, true], ["stopped", true, true], ["done", undefined, false],
    ["done", false, false], ["done", "true", false], ["pr", true, false], ["todo", true, false],
  ]) {
    p.tasks = [{ ...task, stage, can_reopen: eligible }];
    p.w.eval('taskFilter = "all"');
    await p.refresh();
    assert.equal(Boolean(p.button("Reopen")), visible);
  }
  p.tasks = [task]; p.deployed = { [task.id]: 1000 };
  await p.refresh();
  assert.equal(p.w.document.querySelector(".task-status").textContent, "Deployed");
  assert.ok(p.button("Reopen"));
  p.tasks = [{ ...task, stage: "stopped", can_retry: true }];
  await p.refresh();
  assert.equal(p.button("Start planning"), undefined);
  p.button("Retry with Codex").click();
  assert.match(p.confirmations[0].message, /Same approved plan/);
});

test("confirmation, cancellation, duplicate protection and completion reveal Active", async t => {
  const p = await page(t);
  const first = p.button("Reopen"); first.click(); first.click();
  assert.equal(p.confirmations.length, 1);
  assert.match(p.confirmations[0].message, /Fresh planning uses AI tokens and requires approval/);
  assert.match(p.confirmations[0].message, /history is preserved/);
  p.confirmations[0].callback(false);
  assert.equal(first.disabled, false);
  assert.equal(p.posts.length, 0);
  first.click(); p.confirmations[1].callback(true);
  await tick(); await p.refresh();
  assert.deepEqual(p.posts, [{ action: "reopen_task", args: { task: task.id } }]);
  assert.ok(p.button("Sending…").disabled);
  p.button("Sending…").click();
  assert.equal(p.posts.length, 1);
  assert.equal(p.w.eval("taskFilter"), "finished");
  assert.doesNotMatch(p.w.document.getElementById("alert").textContent, /Reopened/);
  p.tasks = [{ ...task, stage: "todo", can_reopen: false, attempt: 2,
    attempt_history: [{ stage: "done", merged_at: 1000, merge_commit: "abc" }] }];
  p.deployed = {};
  p.actions = [{ id: "request1", status: "done", message: "Reopened as To do. A fresh plan requires approval." }];
  await p.refresh();
  assert.equal(p.w.eval("taskFilter"), "active");
  assert.match(p.w.document.getElementById("alert").textContent, /Reopened as To do/);
  assert.equal(p.w.document.querySelector(".task-status").textContent, "To do");
  assert.match(p.w.document.querySelector(".task-meta").textContent, /todo closed/);
  assert.doesNotMatch(p.w.document.querySelector(".task-meta").textContent, /deployed|merged/);
  assert.ok(p.button("Start planning"));
});

for (const status of ["rejected", "expired", "failed"]) {
  test(`${status} uses agent feedback without switching filters`, async t => {
    const p = await page(t); p.button("Reopen").click(); p.confirmations[0].callback(true);
    await tick();
    p.actions = [{ id: "request1", status, message: `Agent ${status}` }];
    await p.refresh();
    assert.equal(p.w.document.getElementById("alert").textContent, `Agent ${status}`);
    assert.equal(p.w.eval("taskFilter"), "finished");
    assert.equal(p.button("Reopen").disabled, false);
  });
}

test("submission failure, slow submission and unanswered action recover", async t => {
  const p = await page(t);
  p.post = async () => { throw new Error("offline"); };
  p.button("Reopen").click(); p.confirmations[0].callback(true); await tick(); await p.refresh();
  assert.match(p.w.document.getElementById("alert").textContent, /Not sent: offline/);
  let resolve;
  p.post = () => new Promise(r => { resolve = r; });
  p.button("Reopen").click(); p.confirmations[1].callback(true); await tick(); await p.refresh();
  assert.ok(p.button("Sending…").disabled);
  resolve({ id: "slow" }); await tick();
  p.w.eval('pendingActions.get("slow").startedAt = Date.now() - ACTION_TIMEOUT_MS - 1');
  await p.refresh();
  assert.equal(p.w.document.getElementById("alert").textContent, "No answer from the coding agent.");
  p.actions = [{ id: "slow", status: "done", message: "Late success" }];
  await p.refresh();
  assert.equal(p.w.eval("taskFilter"), "finished");
  assert.doesNotMatch(p.w.document.getElementById("alert").textContent, /Late success/);
});

test("navigation cancels confirmation and ignores stale snapshot responses", async t => {
  const p = await page(t);
  p.button("Reopen").click();
  p.w.navigate("coding/projects"); await tick();
  p.confirmations[0].callback(true);
  assert.equal(p.posts.length, 0);
  p.w.navigate("tasks"); await tick();
  p.button("Reopen").click(); p.confirmations[1].callback(true); await tick();
  let resolve;
  p.get = () => new Promise(r => { resolve = r; });
  const pending = p.w.refresh(); await tick();
  const stale = resolve;
  p.get = null;
  p.w.navigate("coding/projects"); await tick();
  stale({ ok: true, json: async () => ({ snapshot: { tasks: [], setup: {
    actions: [{ id: "request1", status: "done", message: "Stale success" }] } } }) });
  await pending;
  assert.equal(p.w.location.pathname, "/coding/projects");
  assert.equal(p.w.eval("taskFilter"), "finished");
  assert.doesNotMatch(p.w.document.getElementById("alert").textContent, /Stale success/);
});

test("unanswered submission times out without reporting success", async t => {
  const p = await page(t);
  p.w.eval(`{
    const send = postAction;
    postAction = (path, initData, payload) => send(path, initData, payload, 20);
  }`);
  p.post = init => new Promise((resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(new Error("aborted")));
  });
  p.button("Reopen").click(); p.confirmations[0].callback(true);
  await tick(); await tick(); await p.refresh();
  assert.match(p.w.document.getElementById("alert").textContent, /Not sent: no answer.*refresh before retrying/);
  assert.equal(p.w.eval("taskFilter"), "finished");
  assert.equal(p.button("Reopen").disabled, false);
});
