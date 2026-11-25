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

// The producer projects whole-second ages, not Unix timestamps.

// The coding agent's v1 bounded progress: the active run's stage, elapsed,
// last activity and ids. Absent/null means idle or a legacy snapshot.
const progress = (over = {}) => ({
  stage: "implementing",
  elapsed: 3600,
  last_activity: 3600,
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

function buttonNamed(p, title, label) {
  return [...cardByTitle(p, title).querySelectorAll("button")]
    .find(button => button.textContent === label);
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
  const stale = progress({ task_id: "other", last_activity: 7200 });
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


test("producer activity ages and canonical stages render without timestamp subtraction", async t => {
  for (const age of [0, 595, 7200]) {
    const p = await page(t, { path: "coding", snapshot: codingSnapshot({
      progress: progress({ stage: "implement", last_activity: age }) }) });
    const now = cardByTitle(p, "Now");
    assert.equal(rowValue(now, "Stage"), "Implementing");
    assert.equal(rowValue(now, "Last activity"), `${p.w.formatDuration(age)} ago`);
  }
  for (const age of [-1, null, "595"]) {
    const p = await page(t, { path: "coding", snapshot: codingSnapshot({
      progress: progress({ last_activity: age }) }) });
    assert.equal(rowValue(cardByTitle(p, "Now"), "Last activity"), "no activity update available");
  }
});

test("finish estimate is approximate, handles overruns and never claims a guaranteed finish", async t => {
  const p = await page(t, {path:"coding", snapshot:codingSnapshot({progress:progress({
    finish_estimate:{status:"estimated",remaining_seconds:121,samples:5}
  })})});
  let text = p.w.document.body.textContent;
  assert.match(text,/Estimated time left/);
  assert.match(text,/About 3m/);
  assert.match(text,/Task complexity varies/);
  p.snapshot.progress.finish_estimate = {status:"longer_than_usual",samples:5};
  await p.refresh();
  text = p.w.document.body.textContent;
  assert.match(text,/Taking longer than usual/);
  p.snapshot.progress.finish_estimate = {status:"insufficient_history",samples:2};
  await p.refresh();
  assert.match(p.w.document.body.textContent,/Not enough history/);
});

test("Coding starts eligible tasks in its selected project after confirmation", async t => {
  const p = await page(t, { path: "coding", snapshot: codingSnapshot({ tasks: [
    task({ id: "11111111", title: "Waiting task", stage: "todo", waiting_for: "First part" }),
    task({ id: "22222222", title: "Plain task", stage: "blocked" }),
    task({ id: "33333333", title: "Other project", stage: "todo", repo: "other" }),
    task({ id: "44444444", title: "Archived task", stage: "stopped", can_reopen: true }),
    task({ id: "55555555", title: "Active task", stage: "implementing" }),
  ] }) });
  const work = cardByTitle(p, "Work");
  assert.ok(cardByTitle(p, "Setup"));
  assert.match(work.textContent, /Start a task.*Waiting task.*Plain task/);
  assert.doesNotMatch(work.textContent, /Other project|Archived task|Active task/);

  const plain = buttonNamed(p, "Work", "Start planning");
  plain.click();
  assert.match(p.confirmations[0].message, /Plan "Plain task" in repo with Codex.*AI tokens/);
  p.confirmations.shift().callback(false);
  assert.equal(plain.disabled, false);
  assert.deepEqual(p.posts, []);

  buttonNamed(p, "Work", "Check & start").click();
  assert.match(p.confirmations[0].message, /Check prerequisites for "Waiting task".*AI tokens.*stays waiting/);
  assert.deepEqual(p.posts, []);
  p.confirmations.shift().callback(true);
  assert.deepEqual(p.posts, [{ action: "start_task", args: { task: "11111111" } }]);
  await tick();
});

test("Coding keeps both queues visible and targets their different IDs", async t => {
  const p = await page(t, { path: "coding", snapshot: codingSnapshot({
    tasks: [task({ id: "00000007", title: "Ready for planning", stage: "todo", queued: true, repo: "other" })],
    queue: [{ id: 7, branch: "feature/queued", label: "implementation" }],
  }) });
  const work = cardByTitle(p, "Work");
  assert.match(work.textContent, /Tasks queued to start · 1.*Ready for planning · other/);
  assert.match(work.textContent, /Implementation queue · 1.*#7 feature\/queued/);
  assert.equal(buttonNamed(p, "Work", "Start planning"), undefined);

  const remove = buttonNamed(p, "Work", "Remove");
  remove.click();
  assert.match(p.confirmations[0].message, /#7 \(feature\/queued\)/);
  p.confirmations.shift().callback(false);
  assert.equal(remove.disabled, false);
  assert.deepEqual(p.posts, []);

  remove.click();
  p.confirmations.shift().callback(true);
  assert.deepEqual(p.posts, [{ action: "remove_queued", args: { task: "7" } }]);

  await tick();
  p.snapshot.setup.actions = [{ id: "request1", status: "done" }];
  await p.refresh();
  buttonNamed(p, "Work", "Cancel start").click();
  assert.deepEqual(p.confirmations, []);
  assert.deepEqual(p.posts, [
    { action: "remove_queued", args: { task: "7" } },
    { action: "cancel_start", args: { task: "00000007" } },
  ]);
  await tick();
});

test("paused and legacy implementation queues have a confirmed resume control", async t => {
  const queue = [{ id: 7, branch: "feature/queued", label: "implementation" }];
  for (const [paused, label] of [[true, "Resume queue"], [undefined, "Run the queue"]]) {
    const p = await page(t, { path: "coding", snapshot: codingSnapshot({
      running: null, queue, queue_paused: paused,
    }) });
    const resume = buttonNamed(p, "Work", label);
    resume.click();
    assert.match(p.confirmations[0].message, /1 queued task.*AI tokens/);
    p.confirmations.shift().callback(false);
    assert.equal(resume.disabled, false);
    assert.deepEqual(p.posts, []);
    resume.click();
    p.confirmations.shift().callback(true);
    assert.deepEqual(p.posts, [{ action: "confirm_work", args: {} }]);
    await tick();
  }
  const p = await page(t, { path: "coding", snapshot: codingSnapshot({
    running: null, queue, queue_paused: false,
  }) });
  assert.ok(buttonNamed(p, "Work", "Remove"));
  assert.equal(buttonNamed(p, "Work", "Resume queue"), undefined);
  assert.equal(buttonNamed(p, "Work", "Run the queue"), undefined);

  p.snapshot.queue_paused = true;
  p.snapshot.pending_branch = "feature/pending";
  await p.refresh();
  assert.ok(buttonNamed(p, "Work", "Confirm and run"));
  assert.equal(buttonNamed(p, "Work", "Resume queue"), undefined);
});

const stopToken = "0123456789abcdef".repeat(2);
const stoppableRun = (over = {}) => ({
  status: "RUNNING", branch: "feature/x", phase: "implementing",
  can_stop: true, stop_token: stopToken, ...over,
});

test("Now confirms the displayed implementation and sends only its stop token", async t => {
  const p = await page(t, { path: "coding", snapshot: codingSnapshot({ running: stoppableRun() }) });
  const stop = () => buttonNamed(p, "Now", "Stop implementation");
  stop().click();
  assert.match(p.confirmations[0].message, /feature\/x.*Saved work.*queue will pause/);
  await p.refresh();
  assert.equal(stop().disabled, true);
  p.confirmations.shift().callback(false);
  assert.equal(stop().disabled, false);
  assert.deepEqual(p.posts, []);

  stop().click();
  await p.refresh();
  p.confirmations.shift().callback(true);
  assert.deepEqual(p.posts, [{ action: "stop_work", args: { token: stopToken } }]);
  await tick();
});

test("Now hides Stop when idle or legacy and shows disabled Stopping through recovery", async t => {
  const p = await page(t, { path: "coding", snapshot: codingSnapshot({ running: null }) });
  assert.match(cardByTitle(p, "Now").textContent, /Idle/);
  assert.equal(cardByTitle(p, "Now").querySelector("button"), null);
  for (const running of [codingSnapshot().running, stoppableRun({ can_stop: false }),
    stoppableRun({ stop_token: undefined })]) {
    p.snapshot.running = running;
    await p.refresh();
    assert.equal(cardByTitle(p, "Now").querySelector("button"), null);
  }
  for (const running of [stoppableRun({ stopping: true }),
    stoppableRun({ stopping: true, can_stop: false, stop_token: undefined })]) {
    p.snapshot.running = running;
    await p.refresh();
    const stopping = buttonNamed(p, "Now", "Stopping…");
    assert.equal(stopping.disabled, true);
    stopping.click();
    assert.equal(buttonNamed(p, "Now", "Stop implementation"), undefined);
  }
  assert.deepEqual(p.confirmations, []);
  assert.deepEqual(p.posts, []);
});

test("a Stop confirmation expires after navigation or a superseding snapshot", async t => {
  const p = await page(t, { path: "coding", snapshot: codingSnapshot({ running: stoppableRun() }) });
  const stop = () => buttonNamed(p, "Now", "Stop implementation");
  stop().click();
  p.w.navigate("coding/projects");
  await tick();
  p.w.navigate("coding");
  await tick();
  p.confirmations.shift().callback(true);
  assert.deepEqual(p.posts, []);

  stop().click();
  p.snapshot.running = stoppableRun({ stop_token: "a".repeat(32) });
  await p.refresh();
  p.confirmations.shift().callback(true);
  assert.deepEqual(p.posts, []);
  assert.equal(stop().disabled, false);

  stop().click();
  p.snapshot.running = null;
  await p.refresh();
  p.confirmations.shift().callback(true);
  assert.deepEqual(p.posts, []);
});

test("Stop waits for a slow POST and reports a missing or rejected agent result", async t => {
  const p = await page(t, { path: "coding", snapshot: codingSnapshot({ running: stoppableRun() }) });
  let acknowledge;
  p.post = () => new Promise(resolve => { acknowledge = resolve; });
  const stop = buttonNamed(p, "Now", "Stop implementation");
  stop.click();
  p.confirmations.shift().callback(true);
  await p.refresh();
  const sending = buttonNamed(p, "Now", "Sending…");
  assert.equal(sending.disabled, true);
  stop.click();
  sending.click();
  assert.equal(p.posts.length, 1);
  acknowledge({ id: "request1" });
  await tick();
  assert.equal(buttonNamed(p, "Now", "Sending…").disabled, true);

  p.w.eval("Date.now = ((now) => () => now() + ACTION_TIMEOUT_MS + 1)(Date.now)");
  await p.refresh();
  assert.match(p.w.document.querySelector("#alert").textContent, /No answer from the coding agent/);
  assert.equal(buttonNamed(p, "Now", "Stop implementation").disabled, false);

  p.post = async () => ({ id: "request2" });
  buttonNamed(p, "Now", "Stop implementation").click();
  p.confirmations.shift().callback(true);
  await tick();
  p.snapshot.setup.actions = [{ id: "request2", status: "rejected", message: "Implementation ended" }];
  await p.refresh();
  assert.match(p.w.document.querySelector("#alert").textContent, /Implementation ended/);
});

test("Stop reports a POST timeout and restores the control", async t => {
  const p = await page(t, { path: "coding", snapshot: codingSnapshot({ running: stoppableRun() }) });
  p.w.eval("setTimeout = ((original) => (callback, ms) => original(callback, ms === FETCH_TIMEOUT_MS ? 0 : ms))(setTimeout)");
  p.post = ({ signal }) => new Promise((resolve, reject) => {
    signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  });
  buttonNamed(p, "Now", "Stop implementation").click();
  p.confirmations.shift().callback(true);
  await tick();
  assert.match(p.w.document.querySelector("#alert").textContent, /Not sent: no answer within 15 s/);
  assert.equal(buttonNamed(p, "Now", "Stop implementation").disabled, false);
});
