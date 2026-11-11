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
const tick = () => new Promise(resolve => setTimeout(resolve, 30));
const children = [
  { id: "b", title: "Dashboard", repo: "ai-dashboard", stage: "todo", group: "group /?", group_title: "Ship feature", part: 2, parts: 2 },
  { id: "a", title: "Backend", repo: "ai-coding-agent", stage: "done", group: "group /?", group_title: "Ship feature", part: 1, parts: 2 },
];
async function page(t, tasks = children, url = "/tasks") {
  const state = { tasks, posts: [] };
  const dom = new JSDOM(source, { url: "https://dashboard.test" + url,
    runScripts: "dangerously", pretendToBeVisual: true,
    beforeParse(w) {
      w.Telegram = { WebApp: { initData: "signed", ready() {}, expand() {},
        showConfirm(message, cb) { cb(true); }, BackButton: { show() {}, hide() {}, onClick(cb) { state.back = cb; } } } };
      w.fetch = async (url, init) => {
        if (init.method === "POST") { state.posts.push(JSON.parse(init.body)); return { ok: true, json: async () => ({ id: "req" }) }; }
        return { ok: true, json: async () => ({ snapshot: { tasks: state.tasks, setup: { planner: "codex", actions: [] } } }) };
      };
    } });
  t.after(() => dom.window.close());
  state.w = dom.window; state.doc = dom.window.document;
  state.refresh = async () => { await dom.window.refresh(); await tick(); };
  await tick(); return state;
}
test("root groups children once; ordered drilldown retains actions and Back preserves filter", async t => {
  const p = await page(t, [...children, { id: "solo", title: "Other task", stage: "todo", repo: "repo" }]);
  assert.equal(p.doc.querySelectorAll(".task").length, 2);
  const group = p.doc.querySelector(".task-group");
  assert.match(group.textContent, /Ship feature.*Split into 2 parts.*1 of 2 completed/);
  assert.equal(group.querySelectorAll("button").length, 1);
  p.w.eval('taskFilter = "all"'); await p.refresh();
  p.doc.querySelector(".task-group-link").click(); await tick();
  assert.equal(p.w.location.pathname, "/tasks/group");
  assert.equal(new URLSearchParams(p.w.location.search).get("group"), "group /?");
  assert.deepEqual([...p.doc.querySelectorAll(".task-title")].map(n => n.textContent), ["1. Backend", "2. Dashboard"]);
  const second = p.doc.querySelectorAll(".task")[1];
  [...second.querySelectorAll("button")].find(n => n.textContent === "Remove").click(); await tick();
  assert.equal(p.posts[0].args.task, "b");
  p.doc.querySelector(".task-group-back").click(); await tick();
  assert.equal(p.w.location.pathname, "/tasks");
  assert.equal(p.w.eval("taskFilter"), "all");
});
test("direct links refresh in place and completed groups move to Finished", async t => {
  const p = await page(t, children, "/tasks/group?group=group%20%2F%3F");
  assert.equal(p.doc.querySelectorAll(".task").length, 2);
  p.tasks = children.map(x => ({ ...x, stage: "done" })); await p.refresh();
  assert.match(p.doc.body.textContent, /2 of 2 completed/);
  assert.equal(p.w.location.pathname, "/tasks/group");
  p.back(); await tick();
  assert.equal(p.w.location.pathname, "/tasks");
  assert.equal(p.doc.querySelectorAll(".task").length, 0);
  p.w.eval('taskFilter = "finished"'); await p.refresh();
  assert.equal(p.doc.querySelectorAll(".task-group").length, 1);
});
test("partial groups remain active, missing groups recover, titles use safe text", async t => {
  const p = await page(t, [{ ...children[0], group: "__proto__", group_title: "<img src=x onerror=alert(1)>", stage: "done" }]);
  assert.equal(p.doc.querySelectorAll(".task-group").length, 1);
  assert.equal(p.doc.querySelectorAll(".task-group img").length, 0);
  p.doc.querySelector(".task-group-link").click(); await tick();
  assert.match(p.doc.body.textContent, /completion is unknown/);
  p.tasks = []; await p.refresh();
  assert.match(p.doc.body.textContent, /no longer in the task list/);
  assert.ok(p.doc.querySelector(".task-group-back"));
});
test("legacy titles, singleton moves and independent groups do not merge by title", async t => {
  const p = await page(t, [
    { ...children[0], group: "one", title: "Legacy (ai-dashboard, part 2/2)", group_title: null },
    { ...children[1], group: "two", group_title: "Legacy" },
    { ...children[0], group: "move", part: 1, parts: 1, title: "Moved" },
    { ...children[0], group: null, title: "Ungrouped" },
  ]);
  assert.equal(p.doc.querySelectorAll(".task-group").length, 2);
  assert.equal(p.doc.querySelectorAll(".task").length, 4);
  assert.match(p.doc.body.textContent, /Moved/);
});
