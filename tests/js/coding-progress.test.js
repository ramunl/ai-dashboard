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

const observed = (offset = -3600) => Math.floor(Date.now() / 1000) + offset;

// The coding agent's v1 bounded progress: the active run's stage, elapsed,
// last activity and ids. Absent/null means idle or a legacy snapshot.
const progress = (over = {}) => ({
  stage: "implementing",
  elapsed: 3600,
  last_activity: observed(),
  task_id: "0a1b2c3d",
  attempt_id: "a1b2c3d4",
  ...over,
});

const task = (over = {}) => ({
  id: "0a1b2c3d", title: "Task", repo: "repo", stage: "implementing", ...over,
});

const codingSnapshot = (over = {}) => ({
  project: { name: "repo", repository: "ramunl/repo", branch: "main" },
  setup: { projects: [{ name: "repo", active: true }], models: [],
    planner: "codex", implementer: "claude", actions: [] },
  running: { status: "RUNNING", branch: "feature/x", phase: "implementing" },
  queue: [],
  planning_agent: "codex",
  implementation_agent: "claude",
  verbosity: "normal",
  limits: null,
  version: "1",
  core: "2",
  ...over,
});

async function page(t, { path: route, snapshot }) {
  const state = { posts: [], confirmations: [],
    snapshot: structuredClone(snapshot), post: async () => ({ id: "request1" }) };
  const dom = new JSDOM(source, {
    url: `https://dashboard.test/${route}`, runScripts: "dangerously", pretendToBeVisual: true,
    beforeParse(w) {
      w.Telegram = { WebApp: { initData: "signed", ready() {}, expand() {},
        showConfirm(message, callback) { state.confirmations.push({ message, callback }); },
        BackButton: { show() {}, hide() {}, onClick() {} } } };
      w.fetch = async (url, init) => {
        if (init && init.method === "POST") {
          state.posts.push(JSON.parse(init.body));
          const answer = await state.post(init);
          return { ok: true, json: async () => answer };
        }
        if (state.get) return state.get(url, init);
        return { ok: true, json: async () => ({ snapshot: state.snapshot,
          task_progress: { deployed: {}, closed: [] } }) };
      };
    },
  });
  t.after(() => dom.window.close());
  state.w = dom.window;
  state.refresh = async () => { await dom.window.refresh(); await tick(); };
  await tick();
  if (route === "tasks") {
    dom.window.eval('taskFilter = "all"');
    await state.refresh();
  }
  return state;
}

function cardByTitle(p, title) {
  return [...p.w.document.querySelectorAll("section")]
    .find(section => section.querySelector("h2")
      && section.querySelector("h2").textContent === title);
}

// The value of a dom.js row() by its label, or null when the row is absent.
function rowValue(node, label) {
  const rowNode = [...node.querySelectorAll(".row")]
    .find(candidate => candidate.children[0] && candidate.children[0].textContent === label);
  return rowNode && rowNode.children[1] ? rowNode.children[1].textContent : null;
}

test("active progress renders stage, elapsed, last activity and attempt in both cards", async t => {
  const now = cardByTitle(await page(t, { path: "coding",
    snapshot: codingSnapshot({ progress: progress() }) }), "Now");
  assert.ok(now);
  assert.equal(rowValue(now, "Stage"), "Implementing");
  assert.equal(rowValue(now, "Elapsed"), "1h 0m");
  assert.equal(rowValue(now, "Last activity"), "1h 0m ago");
  assert.equal(rowValue(now, "Attempt"), "a1b2c3d4");

  const tasks = await page(t, { path: "tasks",
    snapshot: codingSnapshot({ tasks: [task()], progress: progress() }) });
  const rowNode = tasks.w.document.querySelector(".task");
  assert.equal(rowValue(rowNode, "Stage"), "Implementing");
  assert.equal(rowValue(rowNode, "Elapsed"), "1h 0m");
  assert.equal(rowValue(rowNode, "Last activity"), "1h 0m ago");
  assert.equal(rowValue(rowNode, "Attempt"), "a1b2c3d4");
});

test("a null stage and last_activity render unknown, never a guessed state", async t => {
  const now = cardByTitle(await page(t, { path: "coding",
    snapshot: codingSnapshot({ progress: progress({ stage: null, elapsed: null, last_activity: null }) }) }), "Now");
  assert.equal(rowValue(now, "Stage"), "Unknown");
  assert.equal(rowValue(now, "Elapsed"), "unknown");
  assert.equal(rowValue(now, "Last activity"), "no activity update available");
  assert.equal(rowValue(now, "Attempt"), "a1b2c3d4");
});

test("a stale run stays in the Now card but not on an unrelated task row", async t => {
  const stale = progress({ task_id: "other", last_activity: observed(-7200) });
  const now = cardByTitle(await page(t, { path: "coding",
    snapshot: codingSnapshot({ progress: stale }) }), "Now");
  assert.equal(rowValue(now, "Stage"), "Implementing");
  assert.equal(rowValue(now, "Last activity"), "2h 0m ago");

  const tasks = await page(t, { path: "tasks",
    snapshot: codingSnapshot({ tasks: [task()], progress: stale }) });
  const rowNode = tasks.w.document.querySelector(".task");
  assert.equal(rowValue(rowNode, "Stage"), null);
  assert.doesNotMatch(rowNode.textContent, /Last activity/);
});

test("legacy and idle snapshots leave both cards unchanged", async t => {
  for (const snapshot of [codingSnapshot({}), codingSnapshot({ progress: null })]) {
    const now = cardByTitle(await page(t, { path: "coding", snapshot }), "Now");
    assert.equal(rowValue(now, "Stage"), null);
    assert.equal(rowValue(now, "Elapsed"), null);
    assert.equal(rowValue(now, "Last activity"), null);
    assert.equal(rowValue(now, "Attempt"), null);
    assert.doesNotMatch(now.textContent, /no activity update available/);
  }

  const tasks = await page(t, { path: "tasks",
    snapshot: codingSnapshot({ tasks: [task()] }) });
  const rowNode = tasks.w.document.querySelector(".task");
  assert.equal(rowValue(rowNode, "Stage"), null);
  assert.doesNotMatch(rowNode.textContent, /Last activity/);
});

test("progress values are text, never injected HTML", async t => {
  const attack = '<img src=x onerror="globalThis.pwned=1">';
  const p = await page(t, { path: "coding",
    snapshot: codingSnapshot({ progress: progress({ stage: attack, attempt_id: attack }) }) });
  const now = cardByTitle(p, "Now");
  assert.ok(!now.querySelector("img"));
  assert.ok(!now.innerHTML.includes("<img"));
  assert.equal(p.w.eval("globalThis.pwned"), undefined);
  assert.ok(now.textContent.includes(attack));
});
