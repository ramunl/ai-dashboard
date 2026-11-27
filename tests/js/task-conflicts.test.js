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
const task = { id: "abcd1234", title: "Task with PR", repo: "task-repo", stage: "pr",
  pr_url: "https://github.com/owner/task-repo/pull/108", can_fix_conflicts: true };

async function page(t, tasks = [task], route = "/tasks") {
  const p = { posts: [], confirmations: [], snapshot: { tasks,
    project: { name: "different-project" }, setup: { planner: "codex", actions: [] } } };
  const dom = new JSDOM(source, {
    url: `https://dashboard.test${route}`, runScripts: "dangerously", pretendToBeVisual: true,
    beforeParse(w) {
      w.Telegram = { WebApp: { initData: "signed", ready() {}, expand() {},
        showConfirm(message, callback) { p.confirmations.push({ message, callback }); },
        BackButton: { show() {}, hide() {}, onClick() {} } } };
      w.fetch = async (url, init) => {
        if (init?.method === "POST") {
          p.posts.push(JSON.parse(init.body));
          return { ok: true, json: async () => ({ id: "request1" }) };
        }
        return { ok: true, json: async () => ({ snapshot: p.snapshot,
          task_progress: { deployed: {}, closed: [] } }) };
      };
    },
  });
  t.after(() => dom.window.close());
  p.w = dom.window;
  p.refresh = async () => { await p.w.refresh(); await tick(); };
  p.button = label => [...p.w.document.querySelectorAll("button")].find(b => b.textContent === label);
  await tick();
  p.w.eval('taskFilter = "all"');
  await p.refresh();
  return p;
}

test("PR task confirms saved URL and submits only task ID, with duplicate protection", async t => {
  const p = await page(t);
  const button = p.button("Solve conflicts");
  assert.ok(button);
  button.click(); button.click();
  assert.equal(p.confirmations.length, 1);
  assert.equal(p.posts.length, 0);
  assert.match(p.confirmations[0].message, /task-repo.*AI tokens.*existing PR branch/);
  assert.ok(p.confirmations[0].message.includes(task.pr_url));
  p.confirmations[0].callback(false);
  assert.equal(button.disabled, false);
  button.click();
  p.confirmations[1].callback(true);
  await tick();
  button.click();
  assert.deepEqual(p.posts, [{ action: "fix_task_conflicts", args: { task: task.id } }]);
});

test("button is available inside the split task's Subtasks page", async t => {
  const p = await page(t, [
    { ...task, group: "group1", group_title: "Split task", part: 1, parts: 2 },
    { id: "bbbb2222", title: "Second part", repo: "other", stage: "todo",
      group: "group1", group_title: "Split task", part: 2, parts: 2 },
  ], "/tasks/group?group=group1");
  const section = p.w.document.querySelector("article.task");
  assert.ok(section.textContent.includes(task.pr_url));
  const button = [...section.querySelectorAll("button")].find(b => b.textContent === "Solve conflicts");
  assert.ok(button);
  button.click(); p.confirmations[0].callback(true);
  await tick();
  assert.deepEqual(p.posts, [{ action: "fix_task_conflicts", args: { task: task.id } }]);
});

test("old snapshots, missing PR URLs and completed tasks hide the control", async t => {
  const p = await page(t);
  for (const changes of [ { can_fix_conflicts: undefined }, { can_fix_conflicts: false },
    { can_fix_conflicts: "true" }, { stage: "done" }, { stage: "todo" }, { pr_url: null } ]) {
    p.snapshot.tasks = [{ ...task, ...changes }];
    await p.refresh();
    assert.equal(p.button("Solve conflicts"), undefined);
  }
});

test("busy state disables conflict fixes and results stay on the matching task as safe text", async t => {
  const p = await page(t, [task, { ...task, id: "bbbb2222", title: "Other task" }]);
  p.snapshot.merge_conflict = { task_id: task.id, status: "running" };
  await p.refresh();
  assert.equal(p.button("Resolving…").disabled, true);
  assert.equal(p.button("Solve conflicts").disabled, true);
  p.snapshot.merge_conflict = { task_id: task.id, status: "failed", message: "<img src=x onerror=alert(1)>" };
  await p.refresh();
  const articles = [...p.w.document.querySelectorAll("article.task")];
  assert.equal(articles.filter(a => a.textContent.includes("Conflict fix: failed")).length, 1);
  assert.equal(articles.filter(a => a.textContent.includes("<img")).length, 1);
  assert.equal(p.w.document.querySelector("article.task img"), null);
  p.snapshot.running = { branch: "feature/other", phase: "implementing" };
  await p.refresh();
  assert.equal(p.button("Solve conflicts").disabled, true);
});

test("navigating away before confirmation prevents a stale request", async t => {
  const p = await page(t);
  p.button("Solve conflicts").click();
  p.w.navigate("coding");
  p.confirmations[0].callback(true);
  await tick();
  assert.equal(p.posts.length, 0);
});
