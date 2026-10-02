// Browser-level tests for the dashboard page (ai_dashboard/static/).
// Run: npm install && npm test
//
// Guards navigation races that once left a window blank or stuck on
// "Loading…": a skipped request whose stale response was discarded, and a
// Back that waited for a popstate Telegram's WebView never fired.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM, VirtualConsole } = require("jsdom");

const STATIC = path.join(__dirname, "../../ai_dashboard/static");
const TEST_TIMEOUT_MS = 400;

// The page with its scripts inlined, as jsdom does not fetch /static/ files.
function pageSource() {
  return fs
    .readFileSync(path.join(STATIC, "index.html"), "utf8")
    .replace('<script src="/static/vendor/telegram-web-app.js"></script>', "")
    .replace('<link rel="stylesheet" href="/static/styles.css">', "")
    .replace(/<script src="\/static\/(.+?)"><\/script>/g, (_tag, file) => {
      const code = fs.readFileSync(path.join(STATIC, file), "utf8")
        .replace("const FETCH_TIMEOUT_MS = 15000;", `const FETCH_TIMEOUT_MS = ${TEST_TIMEOUT_MS};`);
      return `<script>${code}</script>`;
    });
}
const PAGE = pageSource();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const LAUNCHER = {
  resources: { hostname: "vps", cpus: 1, load: [0.1, 0.1, 0.1],
    memory: { total: 1e9, available: 5e8 }, disk: { total: 2e10, used: 1e10, free: 1e10 }, uptime_seconds: 3600 },
  services: [{ unit: "ai-pm-agent", load_state: "loaded", state: "active", restarts: 0, errors_last_hour: 0 }],
  agents: [
    { name: "coding", label: "Coding agent", path: "coding", service: "active", problem: null, detail: "idle" },
    { name: "pm", label: "PM agent", path: "pm", service: "active", problem: null, detail: "cc · 1 open" },
    { name: "ops", label: "Ops agent", path: "ops", service: "active", problem: null, detail: "Server health, logs and updates" },
  ],
  problems: [],
};
const CODING = { agent: "coding", service: "active", problem: null, age_seconds: 1, snapshot: {
  format: 1, running: null, queue: [], pending_plan: null, pending_branch: null, awaiting_bugfix_answer: false,
  planning_agent: "codex", implementation_agent: "codex", verbosity: "concise", last_execution: null,
  project: { name: "repo", repository: "owner/repo", branch: "main" }, version: "v", core: "core: v1.1" } };
const PM = { agent: "pm", service: "active", problem: null, age_seconds: 2, snapshot: {
  format: 1, active_project: "cc", todos: { project: "cc", open: ["release apk"], open_count: 1, done: 0 },
  projects: [{ name: "cc", open: 1, done: 0 }], rules: [], version: "v", core: "core: v1.1" } };

const REPORT = {
  ok: true,
  reclaimable_bytes: 2.1 * 1024 ** 3,
  categories: [
    { id: "packages", label: "Unused packages and apt cache", bytes: 600 * 1024 ** 2, detail: "4 unused packages, apt cache 210 MB" },
    { id: "journal", label: "Old system logs", bytes: 1.0 * 1024 ** 3, detail: "journal 1.2 GB; keeps last 7d, at most 200M" },
    { id: "snaps", label: "Old snap revisions", bytes: 400 * 1024 ** 2, detail: "2 disabled revisions" },
    { id: "caches", label: "pip and npm caches", bytes: 100 * 1024 ** 2, detail: "/root/.cache/pip, /root/.npm/_cacache" },
  ],
  largest: [{ path: "/root/.codex", bytes: 2.4 * 1024 ** 3 }, { path: "/var/log", bytes: 1.3 * 1024 ** 3 }],
};
const OPS = { ...LAUNCHER, cleanup: { report: REPORT, report_at: 1, running: false, last_run: null } };
const DATA = { launcher: LAUNCHER, ops: OPS, coding: CODING, pm: PM };

// A request that never answers until the page aborts it.
function hang(signal) {
  return new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(new Error("aborted")));
  });
}

// options.latencyMs: server delay; options.respond(window, signal): custom
// answer; options.hasPopstate: false mimics a WebView that never fires it.
async function openPage(url, options = {}) {
  const { latencyMs = 150, respond = null, hasPopstate = true } = options;
  const back = { handler: null, visible: false };
  const errors = [];
  const posts = [];
  const bodies = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error) => errors.push(error.message));
  const dom = new JSDOM(PAGE, {
    url: "https://dashboard.test" + url, runScripts: "dangerously", pretendToBeVisual: true,
    virtualConsole,
    beforeParse(window) {
      window.Telegram = { WebApp: { initData: "signed", ready() {}, expand() {}, openLink() {},
        BackButton: { show() { back.visible = true; }, hide() { back.visible = false; },
                      onClick(handler) { back.handler = handler; } } } };
      window.fetch = async (api, init) => {
        const name = api.split("/").pop();
        if (init && init.method === "POST") {
          posts.push(api);
          bodies.push(init.body ? JSON.parse(init.body) : null);
          if (options.onPost) return options.onPost(api, init);
          return { ok: true, status: 202, json: async () => ({ started: true }) };
        }
        if (respond) return respond(name, init.signal);
        await sleep(latencyMs);  // a slow 1-CPU server
        return { ok: true, status: 200, json: async () => DATA[name] };
      };
      window.setInterval = () => 0;  // no timer: navigation alone must render
      if (!hasPopstate) window.history.back = () => {};
    },
  });
  const doc = dom.window.document;
  return {
    dom, back, errors,
    state: () => ({
      path: dom.window.location.pathname,
      title: doc.getElementById("title").textContent,
      cards: doc.querySelectorAll("main section").length,
      backVisible: back.visible,
    }),
    text: (id) => doc.getElementById(id).textContent,
    tapAgent: (index) => doc.querySelectorAll(".nav-row")[index].click(),
    doc, posts, bodies,
  };
}

test("Back pressed before the window loads still renders the launcher", async () => {
  const page = await openPage("/");
  await sleep(250);
  page.tapAgent(1);
  await sleep(50);
  page.back.handler();
  await sleep(600);
  assert.deepStrictEqual(page.state(), { path: "/", title: "AI Agents", cards: 2, backVisible: false });
  assert.deepStrictEqual(page.errors, []);
});

test("navigating while a timer refresh is in flight renders the new window", async () => {
  const page = await openPage("/");
  await sleep(250);
  page.dom.window.eval("refresh()");
  await sleep(30);
  page.tapAgent(1);
  await sleep(600);
  assert.deepStrictEqual(page.state(), { path: "/pm", title: "PM agent", cards: 4, backVisible: true });
});

test("rapid round trips keep history bounded and end rendered", async () => {
  const page = await openPage("/");
  await sleep(250);
  for (let i = 0; i < 3; i++) {
    // Faster than rows can render, so call what a row tap calls.
    page.dom.window.eval("navigate('/pm')");
    await sleep(40);
    page.back.handler();
    await sleep(40);
  }
  await sleep(600);
  assert.strictEqual(page.state().cards, 2);
  assert.strictEqual(page.state().path, "/");
  assert.ok(page.dom.window.history.length <= 2, `history grew to ${page.dom.window.history.length}`);
});

test("window opened from its bot shows Back and returns to the launcher", async () => {
  const page = await openPage("/pm");
  assert.strictEqual(page.state().title, "PM agent");  // immediately, while loading
  await sleep(300);
  assert.deepStrictEqual(page.state(), { path: "/pm", title: "PM agent", cards: 4, backVisible: true });
  page.back.handler();
  await sleep(300);
  assert.deepStrictEqual(page.state(), { path: "/", title: "AI Agents", cards: 2, backVisible: false });
  assert.strictEqual(page.dom.window.history.length, 1);
});

test("Back from the coding window renders the launcher again", async () => {
  const page = await openPage("/#tgWebAppData=signed");
  await sleep(250);
  page.tapAgent(0);
  await sleep(250);
  assert.deepStrictEqual(page.state(), { path: "/coding", title: "repo", cards: 8, backVisible: true });
  page.back.handler();
  await sleep(250);
  assert.deepStrictEqual(page.state(), { path: "/", title: "AI Agents", cards: 2, backVisible: false });
  assert.ok(page.dom.window.history.length <= 2, `history grew to ${page.dom.window.history.length}`);
  assert.deepStrictEqual(page.errors, []);
});

test("a stale request for the same window does not block its reload", async () => {
  const page = await openPage("/");
  await sleep(250);
  page.dom.window.eval("refresh()");  // timer refresh of the launcher
  await sleep(30);
  page.dom.window.eval("show()");  // the launcher is shown again meanwhile
  await sleep(400);
  assert.deepStrictEqual(page.state(), { path: "/", title: "AI Agents", cards: 2, backVisible: false });
});

test("Back renders the launcher even if the WebView never fires popstate", async () => {
  const page = await openPage("/", { hasPopstate: false });
  await sleep(250);
  page.tapAgent(0);
  await sleep(250);
  page.back.handler();
  await sleep(700);
  assert.deepStrictEqual(page.state(), { path: "/", title: "AI Agents", cards: 2, backVisible: false });
  assert.ok(page.dom.window.history.length <= 2, `history grew to ${page.dom.window.history.length}`);
});

test("a request that never answers ends in a visible error", async () => {
  const page = await openPage("/", { respond: (_name, signal) => hang(signal) });
  await sleep(TEST_TIMEOUT_MS + 200);
  assert.match(page.text("alert"), /no answer within/);
  assert.strictEqual(page.doc.getElementById("alert").hidden, false);
  assert.match(page.text("updated"), /^Update failed/);
  assert.doesNotMatch(page.text("view"), /Loading/);
});

test("a server error shows the server's message", async () => {
  const page = await openPage("/", {
    respond: async () => ({ ok: false, status: 403, json: async () => ({ error: "not the owner" }) }),
  });
  await sleep(100);
  assert.match(page.text("alert"), /not the owner/);
});

test("navigating away cancels the previous request", async () => {
  const signals = [];
  const page = await openPage("/", {
    respond: (name, signal) => {
      signals.push(signal);
      if (name === "launcher") return hang(signal);
      return { ok: true, status: 200, json: async () => DATA[name] };
    },
  });
  await sleep(50);
  page.dom.window.eval("navigate('/pm')");
  await sleep(100);
  assert.strictEqual(signals[0].aborted, true);
  assert.deepStrictEqual(page.state(), { path: "/pm", title: "PM agent", cards: 4, backVisible: true });
});

test("agent rows are links and every status dot has text", async () => {
  const page = await openPage("/");
  await sleep(250);
  const rows = [...page.doc.querySelectorAll(".nav-row")];
  assert.deepStrictEqual(rows.map((a) => [a.tagName, a.getAttribute("href")]),
                         [["A", "/coding"], ["A", "/pm"], ["A", "/ops"]]);
  assert.strictEqual(page.text("status-label"), "OK");
  assert.strictEqual(page.doc.querySelectorAll("[style]").length, 0);
});

test("overview opens Ops details without a duplicate Services card", async () => {
  const page = await openPage("/", { latencyMs: 10 });
  await sleep(60);
  assert.ok(![...page.doc.querySelectorAll("h2")].some((node) => node.textContent === "Services"));
  page.tapAgent(2);
  await sleep(60);
  assert.strictEqual(page.state().path, "/ops");
  assert.strictEqual(page.state().title, "Ops agent");
  assert.strictEqual(page.state().backVisible, true);
  assert.deepStrictEqual(page.errors, []);
});

// Overview data with a problem, uptimes, and a disk trend.
const WITH_PROBLEM = {
  ...LAUNCHER,
  resources: { ...LAUNCHER.resources,
    disk: { ...LAUNCHER.resources.disk, trend: { bytes_per_day: 0.56 * 1024 ** 3, days_until_full: 15.5 } } },
  agents: LAUNCHER.agents.map((agent) => ({ ...agent, up_seconds: 3 * 3600 + 120 })),
  problems: [{ severity: "warning", text: "Disk grows 0.6 GB/day: full in ~16 days" }],
};
const answer = (body) => async (name) => ({
  ok: true,
  status: 200,
  json: async () =>
    name === "launcher" ? body : name === "ops" ? { ...body, cleanup: OPS.cleanup } : DATA[name],
});
const cardTitles = (page) => [...page.doc.querySelectorAll("main h2")].map((node) => node.textContent);

test("Ops window shows its own cards, never the agent list", async () => {
  const overview = await openPage("/", { respond: answer(WITH_PROBLEM) });
  await sleep(60);
  assert.deepStrictEqual(cardTitles(overview), ["Needs attention", "Agents", "Server resources"]);

  const ops = await openPage("/ops", { respond: answer(WITH_PROBLEM) });
  await sleep(60);
  assert.deepStrictEqual(cardTitles(ops), ["Operations", "Deployments", "Needs attention", "Disk usage", "Server resources"]);
  assert.match(ops.doc.querySelector("main").textContent, /Up3h 2m/);

  const calm = await openPage("/ops", { respond: answer({ ...WITH_PROBLEM, problems: [] }) });
  await sleep(60);
  assert.deepStrictEqual(cardTitles(calm), ["Operations", "Deployments", "Disk usage", "Server resources"]);
});

test("agent rows show uptime and the overview shows the disk trend", async () => {
  const page = await openPage("/", { respond: answer(WITH_PROBLEM) });
  await sleep(60);
  const text = page.doc.querySelector("main").textContent;
  assert.match(text, /up 3h 2m/);
  assert.match(text, /full in ~16 days/);

  const fresh = await openPage("/", { latencyMs: 10 });
  await sleep(60);
  assert.match(fresh.doc.querySelector("main").textContent, /after a few hours of readings/);
});

test("coding limits render quota windows, resets and missing provider readings", async () => {
  const page = await openPage("/coding", { latencyMs: 10 });
  await sleep(60);
  const limits = {
    codex: { status: "ok", checked_at: Date.now() / 1000, windows: [
      { bucket: "codex", remaining_percent: 0, window_minutes: 300, resets_at: 1800000000 },
      { bucket: "codex", remaining_percent: 72, window_minutes: 10080, resets_at: 1800100000 },
    ] },
    claude: { status: "not_configured", message: "Claude API key is not configured", windows: [] },
  };
  page.dom.window.eval(`document.getElementById("view").replaceChildren(limitsCard(${JSON.stringify(limits)}))`);
  assert.match(page.text("view"), /5-hour/);
  assert.match(page.text("view"), /Weekly/);
  assert.match(page.text("view"), /0% remaining/);
  assert.match(page.text("view"), /72% remaining/);
  assert.match(page.text("view"), /Resets/);
  assert.match(page.text("view"), /not configured/);
  assert.strictEqual(page.doc.querySelectorAll("progress")[0].value, 0);
  page.dom.window.eval('document.getElementById("view").replaceChildren(limitsCard(null))');
  assert.match(page.text("view"), /Waiting for a limits reading/);
  assert.deepStrictEqual(page.errors, []);
});

test("Claude Code subscription windows stay separate from Claude API limits", async () => {
  const page = await openPage("/coding", { latencyMs: 10 });
  await sleep(60);
  const limits = {
    claude_code: { status: "ok", checked_at: Date.now() / 1000 - 7200, windows: [
      { bucket: "Claude Code", window_minutes: 300, remaining_percent: 0, resets_at: 1800000000 },
      { bucket: "Claude Code", window_minutes: 10080, remaining_percent: 65, resets_at: 1800100000 },
    ] },
    claude: { status: "not_configured", message: "Claude API key is not configured", windows: [] },
  };
  page.dom.window.eval(`document.getElementById("view").replaceChildren(limitsCard(${JSON.stringify(limits)}))`);
  assert.match(page.text("view"), /Claude Code · 5-hour/);
  assert.match(page.text("view"), /Claude Code · Weekly/);
  assert.match(page.text("view"), /0% remaining/);
  assert.match(page.text("view"), /65% remaining/);
  assert.match(page.text("view"), /last known reading/);
  assert.match(page.text("view"), /Claude API/);
  assert.deepStrictEqual(page.errors, []);
});

// ---------------------------------------------------------------- disk cleanup

const opsWith = (cleanup) => async (name) => ({
  ok: true, status: 200,
  json: async () => (name === "ops" ? { ...OPS, cleanup: { ...OPS.cleanup, ...cleanup } } : DATA[name]),
});
const cleanupButton = (page) => page.doc.querySelector("button.action-button");
const confirmWith = (page, answer) => {
  const asked = [];
  page.dom.window.Telegram.WebApp.showConfirm = (message, callback) => { asked.push(message); callback(answer); };
  return asked;
};

test("Ops window lists what fills the disk and offers a cleanup", async () => {
  const page = await openPage("/ops", { latencyMs: 10 });
  await sleep(60);
  const text = page.doc.querySelector("main").textContent;
  for (const expected of ["Disk usage", "Old system logs", "1.0 GB", "Largest directories", "/root/.codex"]) {
    assert.ok(text.includes(expected), `missing: ${expected}`);
  }
  const button = cleanupButton(page);
  assert.strictEqual(button.tagName, "BUTTON");
  assert.match(button.textContent, /Clean up · frees ~2\.1 GB/);
  assert.strictEqual(button.disabled, false);
});

test("cleanup starts only after the user confirms, and only once", async () => {
  const page = await openPage("/ops", { latencyMs: 10 });
  await sleep(60);
  const asked = confirmWith(page, true);
  const button = cleanupButton(page);
  button.click();
  button.click();  // double tap
  await sleep(60);
  assert.strictEqual(asked.length, 1);
  assert.match(asked[0], /Free about 2\.1 GB\?/);
  assert.deepStrictEqual(page.posts, ["/api/ops/cleanup"]);
});

test("declining the confirmation sends nothing", async () => {
  const page = await openPage("/ops", { latencyMs: 10 });
  await sleep(60);
  confirmWith(page, false);
  cleanupButton(page).click();
  await sleep(60);
  assert.deepStrictEqual(page.posts, []);
  assert.strictEqual(cleanupButton(page).disabled, false);
});

test("a refused start is shown and the button comes back", async () => {
  const page = await openPage("/ops", {
    latencyMs: 10,
    onPost: async () => ({ ok: false, status: 409, json: async () => ({ error: "a cleanup is already running" }) }),
  });
  await sleep(60);
  confirmWith(page, true);
  cleanupButton(page).click();
  await sleep(60);
  assert.match(page.text("alert"), /Cleanup did not start: a cleanup is already running/);
  assert.strictEqual(cleanupButton(page).disabled, false);
});

test("while cleaning, and with nothing to clean, the button is disabled", async () => {
  const running = await openPage("/ops", { respond: opsWith({ running: true }) });
  await sleep(60);
  assert.strictEqual(cleanupButton(running).textContent, "Cleaning up…");
  assert.strictEqual(cleanupButton(running).disabled, true);

  const empty = await openPage("/ops", { respond: opsWith({ report: { ...REPORT, reclaimable_bytes: 0 } }) });
  await sleep(60);
  assert.strictEqual(cleanupButton(empty).textContent, "Nothing to clean up");
  assert.strictEqual(cleanupButton(empty).disabled, true);
});

test("the last cleanup and its failures are reported", async () => {
  const lastRun = {
    ok: false, freed_bytes: 1.5 * 1024 ** 3, finished_at: Date.now() / 1000 - 120, triggered_by: "ops",
    steps: [{ label: "Old snap revisions", ok: false, message: "snap: not installed" }],
  };
  const page = await openPage("/ops", { respond: opsWith({ last_run: lastRun }) });
  await sleep(60);
  const text = page.doc.querySelector("main").textContent;
  assert.match(text, /freed 1\.5 GB · 2m ago/);
  assert.match(text, /Old snap revisions failed: snap: not installed/);
});

test("a missing ai-cleanup is explained instead of a broken button", async () => {
  const page = await openPage("/ops", {
    respond: opsWith({ report: { ok: false, error: "ai-cleanup is not installed on this server" } }),
  });
  await sleep(60);
  assert.match(page.doc.querySelector("main").textContent, /ai-cleanup is not installed/);
  assert.strictEqual(cleanupButton(page), null);
});

test("page scripts never define the same top-level function twice", () => {
  // The scripts share one global namespace: a later file's function silently
  // replaces an earlier one with the same name (ops.js lastRunRows was once
  // overwritten by coding.js and the Ops window failed to render).
  const dir = path.join(__dirname, "../../ai_dashboard/static/js");
  const files = [...fs.readdirSync(dir).filter((f) => f.endsWith(".js")).map((f) => path.join(dir, f)),
    ...fs.readdirSync(path.join(dir, "views")).map((f) => path.join(dir, "views", f))];
  const seen = new Map();
  const duplicates = [];
  for (const file of files) {
    for (const match of fs.readFileSync(file, "utf8").matchAll(/^(?:async )?function (\w+)/gm)) {
      const name = match[1];
      if (seen.has(name)) duplicates.push(`${name}: ${seen.get(name)} and ${path.basename(file)}`);
      seen.set(name, path.basename(file));
    }
  }
  assert.deepStrictEqual(duplicates, []);
});


// PM tasks: new bridge workspace, while legacy snapshots remain supported.
const TASKS = {
  project: "app", active_project: "app", revision: "r1",
  projects: [{ name: "app", open: 2, done: 1 }, { name: "other", open: 0, done: 0 }],
  items: [
    { id: "a".repeat(32), text: "High priority task", priority: "high", status: "blocked" },
    { id: "b".repeat(32), text: "Normal task", priority: "normal", status: "open" },
    { id: "c".repeat(32), text: "Completed task", priority: "low", status: "done" },
  ],
};
const editablePM = async () => ({ ok: true, status: 200, json: async () => ({ ...PM, editing: { ok: true, workspace: TASKS } }) });
const fieldSelect = (page, text) => [...page.doc.querySelectorAll("label")].find(l => l.querySelector("span").textContent === text).querySelector("select");
const selectValue = (page, select, value) => { select.value = value; select.dispatchEvent(new page.dom.window.Event("change", { bubbles: true })); };
const buttonNamed = (page, text) => [...page.doc.querySelectorAll("button")].find(b => b.textContent === text);

test("PM workspace shows priority, status and completed filters", async () => {
  const page = await openPage("/pm", { respond: editablePM });
  await sleep(70);
  assert.strictEqual(page.doc.querySelectorAll(".pm-task").length, 2);
  assert.match(page.text("view"), /HighBlocked/);
  selectValue(page, fieldSelect(page, "Status"), "done");
  assert.strictEqual(page.doc.querySelectorAll(".pm-task").length, 1);
  assert.match(page.text("view"), /Completed task/);
  assert.deepStrictEqual(page.errors, []);
});

test("PM edits include stable identity, project and revision", async () => {
  let payload;
  const page = await openPage("/pm", { respond: editablePM, onPost: async (_api, init) => {
    payload = JSON.parse(init.body);
    return { ok: true, status: 200, json: async () => ({ ok: true, workspace: TASKS }) };
  } });
  await sleep(70);
  buttonNamed(page, "High priority task").click();
  selectValue(page, fieldSelect(page, "Priority"), "low");
  selectValue(page, fieldSelect(page, "Status"), "in_progress");
  page.doc.querySelector("form").dispatchEvent(new page.dom.window.Event("submit", { bubbles: true, cancelable: true }));
  await sleep(30);
  assert.deepStrictEqual(payload, { action: "update", id: "a".repeat(32), project: "app", revision: "r1", text: "High priority task", priority: "low", status: "in_progress" });
});

test("PM editor survives heartbeat without losing input or focus", async () => {
  const page = await openPage("/pm", { respond: editablePM });
  await sleep(70);
  buttonNamed(page, "Normal task").click();
  const text = page.doc.querySelector("textarea");
  text.value = "Unfinished draft";
  text.dispatchEvent(new page.dom.window.Event("input", { bubbles: true }));
  text.focus();
  await page.dom.window.eval("refresh()");
  assert.strictEqual(page.doc.querySelector("textarea"), text);
  assert.strictEqual(text.value, "Unfinished draft");
  assert.strictEqual(page.doc.activeElement, text);
});

test("PM deletion requires confirmation", async () => {
  const page = await openPage("/pm", { respond: editablePM });
  await sleep(70);
  buttonNamed(page, "Normal task").click();
  confirmWith(page, false);
  buttonNamed(page, "Delete todo").click();
  await sleep(20);
  assert.deepStrictEqual(page.posts, []);
});

test("PM stale edit preserves draft and shows conflict", async () => {
  const page = await openPage("/pm", { respond: editablePM, onPost: async () => ({ ok: false, status: 409, json: async () => ({ error: "List changed; refresh first" }) }) });
  await sleep(70);
  buttonNamed(page, "Normal task").click();
  const text = page.doc.querySelector("textarea"); text.value = "Keep this draft";
  text.dispatchEvent(new page.dom.window.Event("input", { bubbles: true }));
  page.doc.querySelector("form").dispatchEvent(new page.dom.window.Event("submit", { bubbles: true, cancelable: true }));
  await sleep(30);
  assert.match(page.text("view"), /List changed/);
  assert.strictEqual(page.doc.querySelector("textarea").value, "Keep this draft");
});

test("PM project changes use the PM selection action", async () => {
  let payload;
  const page = await openPage("/pm", { respond: editablePM, onPost: async (_api, init) => {
    payload = JSON.parse(init.body);
    return { ok: true, status: 200, json: async () => ({ workspace: { ...TASKS, project: "other" } }) };
  } });
  await sleep(70);
  selectValue(page, fieldSelect(page, "Active todo project"), "other");
  await sleep(30);
  assert.deepStrictEqual(payload, { action: "select", project: "other" });
});

test("PM search and filters preserve matching task identity", async () => {
  const page = await openPage("/pm", { respond: editablePM });
  await sleep(70);
  const search = page.doc.querySelector('input[type="search"]');
  search.value = "Normal"; search.dispatchEvent(new page.dom.window.Event("input", { bubbles: true }));
  assert.strictEqual(page.doc.querySelectorAll(".pm-task").length, 1);
  assert.match(page.doc.querySelector(".pm-task").textContent, /Normal task/);
});

test("PM add generates an identity and sends one request while busy", async () => {
  let resolvePost, payload;
  const page = await openPage("/pm", { respond: editablePM, onPost: async (_api, init) => {
    payload = JSON.parse(init.body);
    return new Promise(resolve => { resolvePost = resolve; });
  } });
  await sleep(70);
  buttonNamed(page, "+ Add").click();
  const text = page.doc.querySelector("textarea"); text.value = "New todo";
  text.dispatchEvent(new page.dom.window.Event("input", { bubbles: true }));
  const form = page.doc.querySelector("form");
  form.dispatchEvent(new page.dom.window.Event("submit", { bubbles: true, cancelable: true }));
  form.dispatchEvent(new page.dom.window.Event("submit", { bubbles: true, cancelable: true }));
  await sleep(20);
  assert.strictEqual(page.posts.length, 1);
  assert.match(payload.id, /^[a-f0-9]{32}$/);
  assert.strictEqual(payload.action, "add");
  assert.strictEqual(payload.text, "New todo");
  resolvePost({ ok: true, status: 200, json: async () => ({ workspace: TASKS, warning: "Saved locally; GitHub sync failed" }) });
  await sleep(20);
  assert.match(page.text("view"), /Saved locally/);
});

test("PM completion sends task identity rather than sorted list number", async () => {
  let payload;
  const page = await openPage("/pm", { respond: editablePM, onPost: async (_api, init) => {
    payload = JSON.parse(init.body);
    return { ok: true, status: 200, json: async () => ({ workspace: TASKS }) };
  } });
  await sleep(70);
  const checkbox = page.doc.querySelector('.pm-task input[type="checkbox"]');
  checkbox.checked = true; checkbox.dispatchEvent(new page.dom.window.Event("change", { bubbles: true }));
  await sleep(20);
  assert.strictEqual(payload.id, "a".repeat(32));
  assert.strictEqual(payload.status, "done");
});

test("PM new project draft survives heartbeat", async () => {
  const page = await openPage("/pm", { respond: editablePM });
  await sleep(70);
  buttonNamed(page, "New project").click();
  const input = page.doc.querySelector("form input"); input.value = "future-project";
  input.dispatchEvent(new page.dom.window.Event("input", { bubbles: true })); input.focus();
  await page.dom.window.eval("refresh()");
  assert.strictEqual(page.doc.querySelector("form input"), input);
  assert.strictEqual(input.value, "future-project");
});


test("PM select values stay present when Telegram changes its theme", async () => {
  const page = await openPage("/pm", { respond: editablePM });
  await sleep(70);
  for (const theme of ["dark", "light"]) {
    page.dom.window.Telegram.WebApp.colorScheme = theme;
    page.dom.window.eval("applyColorScheme()");
    assert.strictEqual(page.doc.documentElement.dataset.theme, theme);
    for (const label of ["Active todo project", "Status", "Priority", "Sort"]) {
      const select = fieldSelect(page, label);
      assert.ok(select.selectedOptions[0].textContent.trim());
    }
  }
});


test("native Back from a todo editor returns to the list before the dashboard", async () => {
  const page = await openPage("/pm", { respond: editablePM });
  await sleep(70);
  buttonNamed(page, "Normal task").click();
  page.back.handler();
  await sleep(30);
  assert.strictEqual(page.dom.window.location.pathname, "/pm");
  assert.strictEqual(page.doc.querySelector("textarea"), null);
  assert.ok(page.doc.querySelector(".pm-task-list"));
  page.back.handler();
  assert.strictEqual(page.dom.window.location.pathname, "/");
});

test("editor Back to todos and Cancel stay within PM", async () => {
  const page = await openPage("/pm", { respond: editablePM });
  await sleep(70);
  for (const label of ["Back to todos", "Cancel"]) {
    buttonNamed(page, "Normal task").click();
    buttonNamed(page, label).click();
    await sleep(20);
    assert.strictEqual(page.dom.window.location.pathname, "/pm");
    assert.ok(page.doc.querySelector(".pm-task-list"));
  }
});

test("native Back also closes the Add todo and New project subviews", async () => {
  const page = await openPage("/pm", { respond: editablePM });
  await sleep(70);
  for (const label of ["+ Add", "New project"]) {
    buttonNamed(page, label).click();
    page.back.handler();
    await sleep(20);
    assert.strictEqual(page.dom.window.location.pathname, "/pm");
    assert.strictEqual(page.doc.querySelector("form"), null);
  }
});


test("returning from the dashboard opens the TODO list rather than a cached editor", async () => {
  const respond = async name => name === "pm" ? editablePM() : { ok: true, status: 200, json: async () => DATA[name] };
  const page = await openPage("/pm", { respond });
  await sleep(70);
  buttonNamed(page, "Normal task").click();
  page.dom.window.eval('navigate("")');
  await sleep(40);
  page.dom.window.eval('navigate("pm")');
  await sleep(40);
  assert.ok(page.doc.querySelector(".pm-task-list"));
  assert.strictEqual(page.doc.querySelector("textarea"), null);
  assert.deepStrictEqual(page.errors, []);
});


test("PM list collapses to three sorted items and expands without changing filters", async () => {
  const workspace = { ...TASKS, items: [
    ...TASKS.items,
    { id: "d".repeat(32), text: "Extra low", priority: "low", status: "open" },
    { id: "e".repeat(32), text: "Extra high", priority: "high", status: "open" },
    { id: "f".repeat(32), text: "Extra normal", priority: "normal", status: "open" },
  ] };
  const respond = async () => ({ ok: true, status: 200, json: async () => ({ ...PM, editing: { ok: true, workspace } }) });
  const page = await openPage("/pm", { respond });
  await sleep(70);
  assert.strictEqual(page.doc.querySelectorAll(".pm-task").length, 3);
  assert.deepStrictEqual([...page.doc.querySelectorAll(".pm-task-title")].map(n => n.textContent), ["High priority task", "Extra high", "Normal task"]);
  buttonNamed(page, "Show all (5)").click();
  assert.strictEqual(page.doc.querySelectorAll(".pm-task").length, 5);
  await page.dom.window.eval("refresh()");
  assert.strictEqual(page.doc.querySelectorAll(".pm-task").length, 5);
  buttonNamed(page, "Show fewer").click();
  assert.strictEqual(page.doc.querySelectorAll(".pm-task").length, 3);
});

const DEPLOYMENT_STATE = { ok: true, targets: [{
  name: "ai-pm-agent", status: "healthy",
  current: { commit: "b".repeat(40), version: "v2" },
  previous: { commit: "a".repeat(40), version: "v1", verified_at: 123 },
}] };
const opsDeployments = (deployments) => async () => ({ ok: true, status: 200,
  json: async () => ({ ...OPS, deployments }),
});

test("deployment status shows verified versions and confirms exact rollback target", async () => {
  const page = await openPage("/ops", { respond: opsDeployments(DEPLOYMENT_STATE) });
  await sleep(50);
  assert.match(page.doc.querySelector("main").textContent, /Current revisionv2 · bbbbbbbb/);
  let answer;
  page.dom.window.Telegram.WebApp.showConfirm = (message, callback) => {
    assert.match(message, /ai-pm-agent to v1 · aaaaaaaa/);
    answer = callback;
  };
  let payload;
  page.dom.window.fetch = async (_url, init) => {
    if (init.method === "POST") payload = JSON.parse(init.body);
    return { ok: true, status: 202, json: async () => ({ ...OPS, deployments: DEPLOYMENT_STATE }) };
  };
  const button = [...page.doc.querySelectorAll("button")].find((item) => item.textContent === "Roll back");
  button.click();
  button.click();
  assert.strictEqual(payload, undefined);
  answer(true);
  await sleep(50);
  assert.deepStrictEqual(payload, { target: "ai-pm-agent", expected_commit: "a".repeat(40) });
  page.dom.window.close();
});

test("deployment manager missing and rollback failures are visible", async () => {
  const missing = await openPage("/ops", { respond: opsDeployments({ ok: false, error: "Deployment manager is not installed" }) });
  await sleep(50);
  assert.match(missing.doc.querySelector("main").textContent, /manager is not installed/);
  missing.dom.window.close();
  const failed = await openPage("/ops", { respond: opsDeployments({ ok: true, targets: [{ name: "ai-dashboard", status: "rollback_failed", error: "Health check failed" }] }) });
  await sleep(50);
  assert.match(failed.doc.querySelector("main").textContent, /rollback failed/);
  assert.match(failed.doc.querySelector("main").textContent, /Health check failed/);
  assert.strictEqual([...failed.doc.querySelectorAll("button")].some((button) => button.textContent === "Roll back"), false);
  failed.dom.window.close();
});

test("rollback controls disable during a job and declining confirmation sends nothing", async () => {
  const busy = await openPage("/ops", { respond: opsDeployments({ ...DEPLOYMENT_STATE,
    targets: [{ ...DEPLOYMENT_STATE.targets[0], status: "rolling_back" }] }) });
  await sleep(50);
  const busyButton = [...busy.doc.querySelectorAll("button")].find((button) => button.textContent === "Roll back");
  assert.strictEqual(busyButton.disabled, true);
  busy.dom.window.close();
  const page = await openPage("/ops", { respond: opsDeployments(DEPLOYMENT_STATE) });
  await sleep(50);
  page.dom.window.Telegram.WebApp.showConfirm = (_message, answer) => answer(false);
  const button = [...page.doc.querySelectorAll("button")].find((item) => item.textContent === "Roll back");
  button.click();
  assert.strictEqual(button.disabled, false);
  assert.deepStrictEqual(page.posts, []);
  page.dom.window.close();
});


test("failed recovery disables every rollback control and shows server recovery guidance", async () => {
  const state = { ok: true, targets: [
    { ...DEPLOYMENT_STATE.targets[0], status: "rollback_failed", current: { commit: "b".repeat(40), version: "v2", verified_at: "2026-10-02T11:00:00+00:00" } },
    { ...DEPLOYMENT_STATE.targets[0], name: "ai-dashboard" },
  ] };
  const page = await openPage("/ops", { respond: opsDeployments(state) });
  await sleep(50);
  const buttons = [...page.doc.querySelectorAll("button")].filter(button => button.textContent === "Roll back");
  assert.strictEqual(buttons.length, 2);
  assert.strictEqual(buttons.every(button => button.disabled), true);
  assert.match(page.doc.querySelector("main").textContent, /ai-deploy recover/);
  assert.match(page.doc.querySelector("main").textContent, /Last health verification2026/);
  page.dom.window.close();
});

// ---------------------------------------------------------------- coding setup

const SETUP = {
  projects: [
    { name: "repo", repository: "owner/repo", active: true },
    { name: "channel-cast", repository: "ramunl/channelcast", active: false },
  ],
  planner: "codex", implementer: "codex",
  planner_options: ["codex", "claude"], implementer_options: ["codex", "claude"],
  busy: null,
  models: [
    { tool: "claude", model: "claude-sonnet-4-6", manageable: true, note: "", choices: ["claude-sonnet-4-6", "claude-opus-4-1"], choices_error: null },
    { tool: "codex", model: "gpt-5-codex", manageable: false, note: "Set in Codex's own config.", choices: [], choices_error: null },
  ],
  actions: [],
};
// Serves the coding window with a setup; results can be swapped in later.
function codingServer(setup = SETUP) {
  const state = { setup };
  const respond = async (name) => ({
    ok: true, status: 200,
    json: async () => (name === "coding"
      ? { ...CODING, snapshot: { ...CODING.snapshot, setup: state.setup } }
      : DATA[name]),
  });
  const onPost = async () => ({ ok: true, status: 202, json: async () => ({ id: "abc123" }) });
  return { state, options: { latencyMs: 10, respond, onPost } };
}
const buttonsIn = (page, text) => [...page.doc.querySelectorAll("main button")].filter((b) => b.textContent === text);

test("Coding window links to Projects and AI tools, and Back returns to Coding", async () => {
  const server = codingServer();
  const page = await openPage("/coding", server.options);
  await sleep(60);
  const links = [...page.doc.querySelectorAll("main a.nav-row")].map((a) => a.getAttribute("href"));
  assert.deepStrictEqual(links, ["/coding/projects", "/coding/ai"]);
  page.doc.querySelector('a[href="/coding/projects"]').click();
  await sleep(60);
  assert.strictEqual(page.state().path, "/coding/projects");
  assert.strictEqual(page.state().backVisible, true);
  page.back.handler();
  await sleep(400);
  assert.strictEqual(page.state().path, "/coding");
  assert.ok(page.dom.window.history.length <= 2);
});

test("a sub-window opened directly goes Back to its parent, not the overview", async () => {
  const page = await openPage("/coding/ai", codingServer().options);
  await sleep(60);
  page.back.handler();
  await sleep(60);
  assert.strictEqual(page.state().path, "/coding");
});

test("switching project sends the request and follows the agent's result", async () => {
  const server = codingServer();
  const page = await openPage("/coding/projects", server.options);
  await sleep(60);
  assert.match(page.doc.querySelector("main").textContent, /repoowner\/repoActive/);
  buttonsIn(page, "Use")[0].click();
  await sleep(60);
  assert.deepStrictEqual(page.bodies, [{ action: "use_project", args: { name: "channel-cast" } }]);
  assert.strictEqual(buttonsIn(page, "Switching…").length, 1);

  // The agent refuses: its message is shown and the button comes back.
  server.state.setup = { ...SETUP, actions: [{ id: "abc123", status: "failed", message: "Cannot switch projects while a task is running." }] };
  page.dom.window.eval("refresh()");
  await sleep(60);
  assert.match(page.text("alert"), /Cannot switch projects while a task is running/);
  assert.strictEqual(buttonsIn(page, "Use").length, 1);
});

test("busy agent: project buttons are disabled with the reason", async () => {
  const page = await openPage("/coding/projects", codingServer({ ...SETUP, busy: "2 task(s) are queued" }).options);
  await sleep(60);
  assert.strictEqual(buttonsIn(page, "Use")[0].disabled, true);
  assert.match(page.doc.querySelector("main").textContent, /Switching is disabled: 2 task\(s\) are queued/);
});

test("add repository: validated input, kept while typing, then sent", async () => {
  const page = await openPage("/coding/projects", codingServer().options);
  await sleep(60);
  const input = page.doc.querySelector("main input");
  const add = buttonsIn(page, "Add")[0];
  assert.strictEqual(add.disabled, true);
  input.focus();
  input.value = "ramunl/ai-dashb";
  input.dispatchEvent(new page.dom.window.Event("input"));
  page.dom.window.eval("refresh()");  // a timer refresh while typing
  await sleep(60);
  assert.strictEqual(page.doc.querySelector("main input"), input, "field replaced while typing");
  assert.strictEqual(input.value, "ramunl/ai-dashb");
  input.value = "not a repo; rm -rf /";
  input.dispatchEvent(new page.dom.window.Event("input"));
  assert.strictEqual(add.disabled, true);
  input.value = "ramunl/ai-dashboard";
  input.dispatchEvent(new page.dom.window.Event("input"));
  assert.strictEqual(add.disabled, false);
  add.click();
  await sleep(60);
  assert.deepStrictEqual(page.bodies, [{ action: "add_repository", args: { repository: "ramunl/ai-dashboard" } }]);
});

test("planner and implementer are chosen with buttons, current one pressed", async () => {
  const page = await openPage("/coding/ai", codingServer().options);
  await sleep(60);
  const groups = [...page.doc.querySelectorAll(".segmented")];
  assert.strictEqual(groups.length, 2);
  const [codex, claude] = groups[0].querySelectorAll("button");
  assert.strictEqual(codex.getAttribute("aria-pressed"), "true");
  assert.strictEqual(codex.disabled, true);
  claude.click();
  await sleep(60);
  assert.deepStrictEqual(page.bodies, [{ action: "set_planner", args: { value: "claude" } }]);
});

test("switching the Claude model asks first; Codex is read-only", async () => {
  const page = await openPage("/coding/ai", codingServer().options);
  await sleep(60);
  const text = page.doc.querySelector("main").textContent;
  assert.match(text, /claude-sonnet-4-6Current/);
  assert.match(text, /gpt-5-codex.*Read-only\. Set in Codex's own config\./s);

  const asked = [];
  page.dom.window.Telegram.WebApp.showConfirm = (message, callback) => { asked.push(message); callback(false); };
  buttonsIn(page, "Use")[0].click();
  await sleep(30);
  assert.deepStrictEqual(page.bodies, []);
  page.dom.window.Telegram.WebApp.showConfirm = (message, callback) => { asked.push(message); callback(true); };
  buttonsIn(page, "Use")[0].click();
  await sleep(60);
  assert.match(asked[0], /restarts/);
  assert.deepStrictEqual(page.bodies, [{ action: "switch_model", args: { tool: "claude", model: "claude-opus-4-1" } }]);
});

test("an older agent without setup data gets a clear note", async () => {
  const page = await openPage("/coding/projects", { latencyMs: 10 });
  await sleep(60);
  assert.match(page.doc.querySelector("main").textContent, /Update the coding agent to manage its setup here/);
});
