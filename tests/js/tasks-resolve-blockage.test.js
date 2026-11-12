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
const task = { id: "0a1b2c3d", title: "Fix <script>text</script>", repo: "repo", stage: "ended", can_resolve_blockage: true };
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
  dom.window.eval('taskFilter = "active"');
  await state.refresh();
  return state;
}

test("resolve requires explicit eligibility and confirmation; cancel and duplicate taps are safe", async t => {
  const p = await page(t);
  let button = p.button("Resolve blockage");
  assert.ok(button);
  button.click(); button.click();
  assert.equal(p.confirmations.length, 1);
  assert.match(p.confirmations[0].message, /newer default-branch CI covers it/);
  assert.match(p.confirmations[0].message, /clear only this attempt/);
  assert.equal(p.posts.length, 0);
  p.confirmations[0].callback(false);
  assert.equal(button.disabled, false);
  button.click(); p.confirmations[1].callback(true);
  await tick();
  assert.deepEqual(p.posts, [{ action: "resolve_task_blockage", args: { task: task.id } }]);
  await p.refresh();
  assert.ok(p.button("Sending…").disabled);
  p.tasks = [{ ...task, can_resolve_blockage: false }]; await p.refresh();
  assert.equal(p.button("Resolve blockage"), undefined);
});

test("refusal stays visible and Done is only shown after agent confirmation", async t => {
  const p = await page(t);
  p.button("Resolve blockage").click(); p.confirmations[0].callback(true);
  await tick();
  p.actions = [{ id: "request1", status: "rejected", message: "Successful CI does not include the merge commit" }];
  await p.refresh();
  assert.match(p.w.document.getElementById("alert").textContent, /does not include/);
  assert.equal(p.w.document.querySelector(".task-status").textContent, "Run ended");
  p.tasks = [{ ...task, stage: "done", can_resolve_blockage: false, blockage_resolved: true }];
  p.actions = []; p.w.eval('taskFilter = "finished"'); await p.refresh();
  assert.equal(p.w.document.querySelector(".task-status").textContent, "Done");
  assert.match(p.w.document.body.textContent, /Original CI history preserved/);
  assert.equal(p.w.document.querySelector("script script"), null);
});

test("navigation while confirmation is open never sends a stale resolution", async t => {
  const p = await page(t);
  p.button("Resolve blockage").click();
  p.w.navigate("coding"); await tick();
  p.confirmations[0].callback(true); await tick();
  assert.equal(p.posts.length, 0);
});
