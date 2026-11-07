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

// The coding agent's v1 task context_status.
const context = (over = {}) => ({
  health: "healthy",
  freshness: "fresh",
  evidence_state: "complete",
  observed_at: observed(),
  omission_count: 0,
  truncation_count: 1,
  packet_refs: [{ packet_id: "p1", sha256: "a".repeat(64) }],
  dependency_blockers: ["dependency:repo:x/y"],
  ...over,
});

const task = (status = undefined, over = {}) => ({
  id: "0a1b2c3d", title: "Task", repo: "repo", stage: "blocked",
  ...(status === undefined ? {} : { context_status: status }), ...over,
});

async function page(t, tasks = []) {
  const state = { posts: [], confirmations: [], tasks, actions: [], deployed: {},
    closed: [], post: async () => ({ id: "request1" }) };
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
          task_progress: { deployed: state.deployed, closed: state.closed } }) };
      };
    },
  });
  t.after(() => dom.window.close());
  state.w = dom.window;
  state.buttons = () => [...dom.window.document.querySelectorAll("button")];
  state.button = label => state.buttons().find(b => b.textContent === label);
  state.refresh = async () => { await dom.window.refresh(); await tick(); };
  await tick();
  dom.window.eval('taskFilter = "all"');
  await state.refresh();
  return state;
}

test("v1 context_status renders health, freshness, evidence_state, age, counts, blockers and packet refs", async t => {
  const p = await page(t, [task(context({
    health: "blocked", evidence_state: "partial",
    omission_count: 1, truncation_count: 2,
    dependency_blockers: ["dependency:repo:x/y", "evidence:pr"],
  }))]);
  const row = p.w.document.querySelector(".task");
  assert.match(row.textContent, /Context blocked/);
  assert.match(row.textContent, /freshness fresh/);
  assert.match(row.textContent, /Partial evidence/);
  assert.match(row.textContent, /age 1h 0m/);
  assert.match(row.textContent, /1 omitted, 2 truncated/);
  assert.match(row.textContent, /Dependency blocked by: Dependency not merged: repo:x\/y · Evidence missing: pr/);
  assert.match(row.textContent, /packet p1/);
  assert.match(row.textContent, /sha256 a{64}/);
});

test("the v1 field names are read, not the old ones", async t => {
  const p = await page(t, [task(context({
    packets: [{ packet_id: "p1", sha256: "a".repeat(64) }],
    omissions: 3, truncations: 4, blockers: ["dependency:repo:x/y"],
    packet_refs: [], omission_count: undefined, truncation_count: undefined,
    dependency_blockers: [],
  }))]);
  const row = p.w.document.querySelector(".task");
  assert.doesNotMatch(row.textContent, /packet p1/);
  assert.doesNotMatch(row.textContent, /3 omitted/);
  assert.doesNotMatch(row.textContent, /4 truncated/);
  assert.doesNotMatch(row.textContent, /Dependency blocked by/);
});

test("legacy context_status still renders status, reason, blockers and evidence", async t => {
  const p = await page(t, [task({ status: "blocked",
    reason: "dependency repo:x/y is unmerged",
    blockers: ["dependency:repo:x/y", "evidence:pr"],
    evidence: { pr: "https://github.com/x/y/pull/1", merged: true, deployed: false },
  })]);
  const row = p.w.document.querySelector(".task");
  assert.match(row.textContent, /Context blocked/);
  assert.match(row.textContent, /dependency repo:x\/y is unmerged/);
  assert.match(row.textContent, /Dependency blocked by: dependency:repo:x\/y · evidence:pr/);
  assert.match(row.textContent, /PR evidence/);
  assert.match(row.textContent, /Merged/);
  assert.doesNotMatch(row.textContent, /Deployed/);
});

test("stale legacy context shows its label and reason", async t => {
  const p = await page(t, [task({ status: "stale", reason: "evidence older than 2 days" })]);
  assert.match(p.w.document.querySelector(".task").textContent, /Context stale/);
  assert.match(p.w.document.querySelector(".task").textContent, /evidence older than 2 days/);
});

test("context fields are HTML-escaped, never injected", async t => {
  const attack = '<img src=x onerror="globalThis.pwned=1">';
  const p = await page(t, [task(context({
    freshness: attack, evidence_state: attack,
    packet_refs: [{ packet_id: attack, sha256: attack }],
    dependency_blockers: [attack],
  }))]);
  const row = p.w.document.querySelector(".task");
  assert.ok(!row.querySelector("img"));
  assert.ok(!row.innerHTML.includes("<img"));
  assert.equal(p.w.eval("globalThis.pwned"), undefined);
  assert.ok(row.textContent.includes(attack));
});

test("absent, unknown or unavailable context gets its own label", async t => {
  const p = await page(t, [task()]);
  assert.match(p.w.document.querySelector(".task").textContent, /Context unknown/);
  p.tasks = [task({ health: "unknown" })];
  await p.refresh();
  assert.match(p.w.document.querySelector(".task").textContent, /Context unknown/);
  p.tasks = [task({ health: "unavailable" })];
  await p.refresh();
  assert.match(p.w.document.querySelector(".task").textContent, /Context unavailable/);
});

test("a null observed_at renders age unknown instead of a guess", async t => {
  const p = await page(t, [task(context({ observed_at: null }))]);
  assert.match(p.w.document.querySelector(".task").textContent, /age unknown/);
});

test("unknown evidence_state and blocker codes render as themselves, never guessed", async t => {
  const p = await page(t, [task(context({
    evidence_state: "mystery",
    dependency_blockers: ["unknown:thing"],
  }))]);
  const row = p.w.document.querySelector(".task");
  assert.match(row.textContent, /mystery/);
  assert.doesNotMatch(row.textContent, /Complete evidence|Partial evidence|No evidence/);
  assert.match(row.textContent, /Dependency blocked by: unknown:thing/);
});
