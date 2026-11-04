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

const task = (context = undefined, over = {}) => ({
  id: "0a1b2c3d", title: "Task", repo: "repo", stage: "blocked",
  ...(context === undefined ? {} : { context_status: context }), ...over,
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

test("context_status renders status, precise reason and dependency blockers", async t => {
  const p = await page(t, [task({ status: "blocked",
    reason: "dependency repo:x/y is unmerged",
    blockers: ["dependency:repo:x/y", "evidence:pr"] })]);
  const row = p.w.document.querySelector(".task");
  assert.match(row.textContent, /Context blocked/);
  assert.match(row.textContent, /dependency repo:x\/y is unmerged/);
  assert.match(row.textContent, /Dependency blocked by: dependency:repo:x\/y · evidence:pr/);
});

test("stale context shows its label and reason", async t => {
  const p = await page(t, [task({ status: "stale", reason: "evidence older than 2 days" })]);
  assert.match(p.w.document.querySelector(".task").textContent, /Context stale/);
  assert.match(p.w.document.querySelector(".task").textContent, /evidence older than 2 days/);
});

test("context fields are HTML-escaped, never injected", async t => {
  const attack = '<img src=x onerror="globalThis.pwned=1">';
  const p = await page(t, [task({ status: "blocked", reason: attack, blockers: [attack] })]);
  const row = p.w.document.querySelector(".task");
  assert.ok(!row.querySelector("img"));
  assert.ok(!row.innerHTML.includes("<img"));
  assert.equal(p.w.eval("globalThis.pwned"), undefined);
  assert.ok(row.textContent.includes(attack));
});

test("absent or unknown context stays unknown", async t => {
  const p = await page(t, [task()]);
  assert.match(p.w.document.querySelector(".task").textContent, /Context unknown/);
  p.tasks = [task({ status: "unknown" })];
  await p.refresh();
  assert.match(p.w.document.querySelector(".task").textContent, /Context unknown/);
});

test("PR/merged/deployed evidence renders separately; unknown stays hidden", async t => {
  const p = await page(t, [task({ status: "ok", blockers: [],
    evidence: { pr: "https://github.com/x/y/pull/1", merged: true, deployed: false } })]);
  const row = p.w.document.querySelector(".task");
  assert.match(row.textContent, /PR evidence/);
  assert.match(row.textContent, /Merged/);
  assert.doesNotMatch(row.textContent, /Deployed/);
  const link = row.querySelector(".context-evidence a");
  assert.equal(link.getAttribute("href"), "https://github.com/x/y/pull/1");
  p.tasks = [task({ status: "ok" })];
  await p.refresh();
  assert.doesNotMatch(p.w.document.querySelector(".task").textContent, /PR evidence|Merged|Deployed/);
});
