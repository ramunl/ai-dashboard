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
const SERVICE_CONTROL = { ok: true, services: [
  { unit: "ai-coding-agent", state: "active", up_seconds: 3600 },
  { unit: "ai-pm-agent", state: "failed", up_seconds: null },
  { unit: "ai-dashboard", state: "active", up_seconds: 120 },
] };
const OPS = { ...LAUNCHER, service_control: SERVICE_CONTROL,
  cleanup: { report: REPORT, report_at: 1, running: false, last_run: null } };
const LOGS = {
  ok: true, unit: "ai-coding-agent", errors_only: false,
  units: ["ai-coding-agent", "ai-pm-agent", "ai-ops-agent"],
  lines: ["2026-10-07T00:00:01+0300 vps python[1]: started", "2026-10-07T00:00:02+0300 vps python[1]: idle"],
};
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
  const logRequests = [];
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
        if (name.startsWith("logs?")) {
          logRequests.push(name);
          const answer = options.logs ? options.logs(name) : LOGS;
          return { ok: true, status: 200, json: async () => answer };
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
    doc, posts, bodies, logRequests,
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
  assert.deepStrictEqual(page.state(), { path: "/coding", title: "Coding agent", cards: 6, backVisible: true });
  assert.match(page.text("subtitle"), /^project: repo · /);
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
  assert.deepStrictEqual(cardTitles(ops), ["Needs attention", "Operations", "Services", "Deployments", "Disk usage", "Updates", "AI tools", "Server resources", "Logs"]);
  assert.match(ops.doc.querySelector("main").textContent, /Up3h 2m/);

  const calm = await openPage("/ops", { respond: answer({ ...WITH_PROBLEM, problems: [] }) });
  await sleep(60);
  assert.deepStrictEqual(cardTitles(calm), ["Operations", "Services", "Deployments", "Disk usage", "Updates", "AI tools", "Server resources", "Logs"]);
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
  buttonNamed(page, "Done 1").click();
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
  buttonNamed(page, "Add with details").click();
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
    for (const label of ["Active todo project", "Priority", "Sort"]) {
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
  for (const label of ["Add with details", "New project"]) {
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


test("PM list shows ten sorted items and expands without changing filters", async () => {
  const extra = Array.from({ length: 11 }, (_, n) => ({ id: String(n).padStart(32, "0"), text: `Extra ${n}`, priority: n === 0 ? "high" : "low", status: "open" }));
  const workspace = { ...TASKS, items: [...TASKS.items, ...extra] };
  const respond = async () => ({ ok: true, status: 200, json: async () => ({ ...PM, editing: { ok: true, workspace } }) });
  const page = await openPage("/pm", { respond });
  await sleep(70);
  assert.strictEqual(page.doc.querySelectorAll(".pm-task").length, 10);
  assert.deepStrictEqual([...page.doc.querySelectorAll(".pm-task-title")].slice(0, 3).map(n => n.textContent), ["High priority task", "Extra 0", "Normal task"]);
  assert.match(page.doc.querySelector(".pm-count").textContent, /13 shown · sorted by priority/);
  buttonNamed(page, "Show all (13)").click();
  assert.strictEqual(page.doc.querySelectorAll(".pm-task").length, 13);
  await page.dom.window.eval("refresh()");
  assert.strictEqual(page.doc.querySelectorAll(".pm-task").length, 13);
  buttonNamed(page, "Show fewer").click();
  assert.strictEqual(page.doc.querySelectorAll(".pm-task").length, 10);
});

// ---------------------------------------------------------------- PM redesign

const quickAdd = (page) => page.doc.querySelector(".pm-quick input");
const pressEnter = (page, input) => input.dispatchEvent(new page.dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));

test("PM quick add saves a normal todo on Enter, once, and keeps the field ready", async () => {
  const bodies = [];
  const page = await openPage("/pm", { respond: editablePM, onPost: async (_api, init) => {
    bodies.push(JSON.parse(init.body));
    return { ok: true, status: 200, json: async () => ({ workspace: TASKS }) };
  } });
  await sleep(70);
  pressEnter(page, quickAdd(page));  // empty: nothing sent
  const input = quickAdd(page);
  input.value = "  buy   milk ";
  input.dispatchEvent(new page.dom.window.Event("input", { bubbles: true }));
  pressEnter(page, input);
  pressEnter(page, input);  // double Enter
  await sleep(40);
  assert.strictEqual(bodies.length, 1);
  assert.match(bodies[0].id, /^[a-f0-9]{32}$/);
  assert.deepStrictEqual({ ...bodies[0], id: "" }, { action: "add", id: "", project: "app", revision: "r1", text: "buy milk", priority: "normal", status: "open" });
  assert.strictEqual(quickAdd(page).value, "");
  assert.strictEqual(page.doc.activeElement, quickAdd(page));
});

test("PM quick add keeps the text when saving fails, and survives a heartbeat", async () => {
  const page = await openPage("/pm", { respond: editablePM, onPost: async () => ({ ok: false, status: 409, json: async () => ({ error: "List changed; refresh first" }) }) });
  await sleep(70);
  const input = quickAdd(page);
  input.value = "keep me";
  input.dispatchEvent(new page.dom.window.Event("input", { bubbles: true }));
  input.focus();
  await page.dom.window.eval("refresh()");
  assert.strictEqual(quickAdd(page), input);
  assert.strictEqual(page.doc.activeElement, input);
  pressEnter(page, input);
  await sleep(40);
  assert.strictEqual(quickAdd(page).value, "keep me");
  assert.match(page.text("view"), /List changed; refresh first/);
});

test("PM switch filters Open / Done / All with counts; rare filters hide behind Filter", async () => {
  const page = await openPage("/pm", { respond: editablePM });
  await sleep(70);
  const pressed = () => [...page.doc.querySelectorAll(".pm-switch-button")].map((b) => [b.textContent, b.getAttribute("aria-pressed")]);
  assert.deepStrictEqual(pressed(), [["Open 2", "true"], ["Done 1", "false"], ["All", "false"]]);
  buttonNamed(page, "All").click();
  assert.strictEqual(page.doc.querySelectorAll(".pm-task").length, 3);
  assert.deepStrictEqual(pressed().map((item) => item[1]), ["false", "false", "true"]);
  const panel = page.doc.querySelector(".pm-filter-panel");
  assert.strictEqual(panel.hidden, true);
  buttonNamed(page, "Filter").click();
  assert.strictEqual(panel.hidden, false);
  assert.strictEqual(buttonNamed(page, "Filter").getAttribute("aria-expanded"), "true");
  selectValue(page, fieldSelect(page, "Priority"), "low");
  assert.deepStrictEqual([...page.doc.querySelectorAll(".pm-task-title")].map((n) => n.textContent), ["Completed task"]);
});

test("PM rows are one line: a badge only for High and for unusual statuses", async () => {
  const page = await openPage("/pm", { respond: editablePM });
  await sleep(70);
  const rows = [...page.doc.querySelectorAll(".pm-task")].map((row) => row.textContent);
  assert.deepStrictEqual(rows, ["High priority taskHighBlocked", "Normal task"]);
});

test("PM page puts todos and the side card in one layout; rules and About share a card", async () => {
  const page = await openPage("/pm", { respond: editablePM });
  await sleep(70);
  const layout = page.doc.querySelector("main > .pm-layout");
  assert.strictEqual(layout.children.length, 2);
  assert.strictEqual(layout.children[1].querySelector("h2").textContent, "Rules");
  assert.ok(layout.children[1].querySelector("details.pm-about"));
  assert.ok(buttonNamed(page, "New project") && buttonNamed(page, "Sync"));
  const css = fs.readFileSync(path.join(__dirname, "../../ai_dashboard/static/styles.css"), "utf8");
  assert.match(css, /@media \(min-width: 52rem\) \{ \.pm-layout \{ grid-template-columns: minmax\(0, 1fr\) 17rem;/);
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
  assert.match(page.doc.querySelector("main").textContent, /Currentv2 · bbbbbbb/);
  let answer;
  page.dom.window.Telegram.WebApp.showConfirm = (message, callback) => {
    assert.match(message, /ai-pm-agent to v1 · aaaaaaa\?/);
    answer = callback;
  };
  let payload;
  page.dom.window.fetch = async (_url, init) => {
    if (init.method === "POST") payload = JSON.parse(init.body);
    return { ok: true, status: 202, json: async () => ({ ...OPS, deployments: DEPLOYMENT_STATE }) };
  };
  const button = [...page.doc.querySelectorAll("button")].find((item) => item.textContent.startsWith("Roll back"));
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
  assert.strictEqual([...failed.doc.querySelectorAll("button")].some((button) => button.textContent.startsWith("Roll back")), false);
  failed.dom.window.close();
});

test("rollback controls disable during a job and declining confirmation sends nothing", async () => {
  const busy = await openPage("/ops", { respond: opsDeployments({ ...DEPLOYMENT_STATE,
    targets: [{ ...DEPLOYMENT_STATE.targets[0], status: "rolling_back" }] }) });
  await sleep(50);
  const busyButton = [...busy.doc.querySelectorAll("button")].find((button) => button.textContent.startsWith("Roll back"));
  assert.strictEqual(busyButton.disabled, true);
  busy.dom.window.close();
  const page = await openPage("/ops", { respond: opsDeployments(DEPLOYMENT_STATE) });
  await sleep(50);
  page.dom.window.Telegram.WebApp.showConfirm = (_message, answer) => answer(false);
  const button = [...page.doc.querySelectorAll("button")].find((item) => item.textContent.startsWith("Roll back"));
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
  const buttons = [...page.doc.querySelectorAll("button")].filter(button => button.textContent.startsWith("Roll back"));
  assert.strictEqual(buttons.length, 2);
  assert.strictEqual(buttons.every(button => button.disabled), true);
  assert.match(page.doc.querySelector("main").textContent, /ai-deploy recover/);
  assert.match(page.doc.querySelector("main").textContent, /ai-pm-agentrollback failed/);
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
    { tool: "claude", model: "claude-sonnet-4-6", manageable: true, note: "", choices: ["claude-opus-5-5", "claude-sonnet-5-5"], choices_error: null },
    { tool: "codex", model: "gpt-5-codex", manageable: false, note: "Set in Codex's own config.", choices: [], choices_error: null },
    { tool: "claude-code", model: "opus", manageable: false, note: "Set in Claude Code's own config.", choices: [], choices_error: null },
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

const radios = (page, name) => [...page.doc.querySelectorAll(`main input[type=radio][name="${name}"]`)];
const pick = (page, radio) => { radio.checked = true; radio.dispatchEvent(new page.dom.window.Event("change")); };
const checkedValue = (page, name) => (radios(page, name).find((r) => r.checked) || {}).value;

test("projects are radios; picking one sends the switch and shows the agent's refusal", async () => {
  const server = codingServer();
  const page = await openPage("/coding/projects", server.options);
  await sleep(60);
  assert.strictEqual(page.doc.querySelectorAll("main button").length, 1);  // only "Add"
  assert.strictEqual(checkedValue(page, "project"), "repo");
  pick(page, radios(page, "project")[1]);
  await sleep(60);
  assert.deepStrictEqual(page.bodies, [{ action: "use_project", args: { name: "channel-cast" } }]);
  server.state.setup = { ...SETUP, actions: [{ id: "abc123", status: "failed", message: "Cannot switch projects while a task is running." }] };
  page.dom.window.eval("refresh()");
  await sleep(60);
  assert.match(page.text("alert"), /Cannot switch projects while a task is running/);
  assert.strictEqual(checkedValue(page, "project"), "repo");
});

test("busy agent: project radios are disabled with the reason", async () => {
  const page = await openPage("/coding/projects", codingServer({ ...SETUP, busy: "2 task(s) are queued" }).options);
  await sleep(60);
  assert.ok(radios(page, "project").every((r) => r.disabled));
  assert.match(page.doc.querySelector("main").textContent, /Switching is disabled: 2 task\(s\) are queued/);
});

test("a picked radio does not stop the page from refreshing", async () => {
  const server = codingServer();
  const page = await openPage("/coding/ai", server.options);
  await sleep(60);
  radios(page, "planner")[0].focus();
  server.state.setup = { ...SETUP, planner: "claude" };
  page.dom.window.eval("refresh()");
  await sleep(60);
  assert.strictEqual(checkedValue(page, "planner"), "claude");
});

test("add repository: validated input, kept while typing, then sent", async () => {
  const page = await openPage("/coding/projects", codingServer().options);
  await sleep(60);
  const input = page.doc.querySelector("main input[type=text]");
  const add = buttonsIn(page, "Add")[0];
  assert.strictEqual(add.disabled, true);
  input.focus();
  input.value = "ramunl/ai-dashb";
  input.dispatchEvent(new page.dom.window.Event("input"));
  page.dom.window.eval("refresh()");
  await sleep(60);
  assert.strictEqual(page.doc.querySelector("main input[type=text]"), input, "field replaced while typing");
  input.value = "not a repo; rm -rf /";
  input.dispatchEvent(new page.dom.window.Event("input"));
  assert.strictEqual(add.disabled, true);
  input.value = "ramunl/ai-dashboard";
  input.dispatchEvent(new page.dom.window.Event("input"));
  add.click();
  await sleep(60);
  assert.deepStrictEqual(page.bodies, [{ action: "add_repository", args: { repository: "ramunl/ai-dashboard" } }]);
});

test("roles are radios and the models card follows the tools in use", async () => {
  const server = codingServer({ ...SETUP, planner: "claude", implementer: "codex" });
  const page = await openPage("/coding/ai", server.options);
  await sleep(60);
  let text = page.doc.querySelector("main").textContent;
  assert.match(text, /Claude API · planner/);
  assert.match(text, /Codex · implementer/);
  assert.doesNotMatch(text, /Claude Code/);
  pick(page, radios(page, "implementer")[1]);
  await sleep(60);
  assert.deepStrictEqual(page.bodies, [{ action: "set_implementer", args: { value: "claude" } }]);

  server.state.setup = { ...SETUP, planner: "codex", implementer: "claude" };
  page.dom.window.eval("refresh()");
  await sleep(60);
  text = page.doc.querySelector("main").textContent;
  assert.match(text, /Codex · planner/);
  assert.match(text, /Claude Code · implementer/);
  assert.doesNotMatch(text, /Claude API/);
  assert.strictEqual(radios(page, "model-claude").length, 0);
});

test("the current Claude model is shown and selected even if the API list omits it", async () => {
  const page = await openPage("/coding/ai", codingServer({ ...SETUP, planner: "claude" }).options);
  await sleep(60);
  assert.match(page.doc.querySelector("main").textContent, /Currentclaude-sonnet-4-6/);
  assert.deepStrictEqual(radios(page, "model-claude").map((r) => r.value),
    ["claude-sonnet-4-6", "claude-opus-5-5", "claude-sonnet-5-5"]);
  assert.strictEqual(checkedValue(page, "model-claude"), "claude-sonnet-4-6");
});

test("switching the model asks first; declining keeps the current one selected", async () => {
  const page = await openPage("/coding/ai", codingServer({ ...SETUP, planner: "claude" }).options);
  await sleep(60);
  const asked = [];
  page.dom.window.Telegram.WebApp.showConfirm = (message, callback) => { asked.push(message); callback(false); };
  pick(page, radios(page, "model-claude")[1]);
  await sleep(30);
  assert.deepStrictEqual(page.bodies, []);
  assert.strictEqual(checkedValue(page, "model-claude"), "claude-sonnet-4-6");
  page.dom.window.Telegram.WebApp.showConfirm = (message, callback) => { asked.push(message); callback(true); };
  pick(page, radios(page, "model-claude")[1]);
  await sleep(60);
  assert.match(asked[0], /Switch Claude API to claude-opus-5-5\?.*restarts/);
  assert.deepStrictEqual(page.bodies, [{ action: "switch_model", args: { tool: "claude", model: "claude-opus-5-5" } }]);
});

test("an older agent without setup data gets a clear note", async () => {
  const page = await openPage("/coding/projects", { latencyMs: 10 });
  await sleep(60);
  assert.match(page.doc.querySelector("main").textContent, /Update the coding agent to manage its setup here/);
});

test("deployments are compact rows; rollback only when there is an earlier version", async () => {
  const now = new Date(Date.now() - 120 * 1000).toISOString();
  const same = { commit: "c".repeat(40), version: "0.3.0", verified_at: now };
  const state = { ok: true, targets: [
    { name: "ai-coding-agent", status: "healthy", current: same, previous: same },
    { name: "ai-pm-agent", status: "healthy", current: { ...same, commit: "d".repeat(40) },
      previous: { commit: "e".repeat(40), version: "0.0.9", verified_at: now } },
  ] };
  const page = await openPage("/ops", { respond: opsDeployments(state) });
  await sleep(60);
  const items = [...page.doc.querySelectorAll("details.deploy-item")];
  assert.strictEqual(items.length, 2);
  assert.ok(items.every((item) => !item.open), "details start closed");
  assert.match(items[0].querySelector("summary").textContent, /ai-coding-agentverified 2m ago0\.3\.0 · ccccccc/);
  const deployCard = page.doc.querySelector("details.deploy-item").closest("section");
  assert.doesNotMatch(deployCard.textContent, /2026-|T\d\d:\d\d/);
  // Same commit before and after: nothing to roll back to.
  assert.strictEqual(items[0].querySelector("button.danger-button"), null);
  assert.match(items[0].textContent, /No earlier verified version/);
  assert.strictEqual(items[1].querySelector("button.danger-button").textContent, "Roll back to 0.0.9 · eeeeeee");
  assert.ok(items.every((item) => item.querySelector("button.deploy-button")), "every agent can be deployed");
});

test("an opened deployment stays open across refreshes", async () => {
  const page = await openPage("/ops", { respond: opsDeployments(DEPLOYMENT_STATE) });
  await sleep(60);
  const item = page.doc.querySelector("details.deploy-item");
  item.open = true;
  item.dispatchEvent(new page.dom.window.Event("toggle"));
  page.dom.window.eval("refresh()");
  await sleep(60);
  assert.strictEqual(page.doc.querySelector("details.deploy-item").open, true);
});

test("last model switch result remains visible after its temporary notice expires", async () => {
  const setup = { ...SETUP, actions: [{ id: "old", action: "switch_model", status: "failed", message: "Restart could not be scheduled", at: 1 }] };
  const server = codingServer(setup);
  const page = await openPage("/coding/ai", server.options);
  await sleep(60);
  assert.match(page.doc.querySelector("main").textContent, /Last model switchfailed: Restart could not be scheduled/);
  await page.dom.window.eval("refresh()");
  assert.match(page.doc.querySelector("main").textContent, /Restart could not be scheduled/);
  page.dom.window.close();
});


test("Claude limits show age of real usage readings without claiming freshness", async () => {
  const page = await openPage("/coding", { latencyMs: 10 });
  await sleep(60);
  const limits = { claude: { status: "ok", checked_at: Date.now() / 1000 - 7200, windows: [] } };
  page.dom.window.eval(`document.getElementById("view").replaceChildren(limitsCard(${JSON.stringify(limits)}))`);
  assert.match(page.text("view"), /Read 2h.*ago · last known reading/);
  page.dom.window.close();
});

test("cards flow in columns without gaps; alerts span the full width", async () => {
  const css = fs.readFileSync(path.join(__dirname, "../../ai_dashboard/static/styles.css"), "utf8");
  assert.match(css, /#view \{[^}]*columns: 20rem;/s);
  assert.match(css, /#view > section \{[^}]*break-inside: avoid;/s);
  assert.match(css, /#view > :not\(section\) \{ column-span: all; \}/);
  const page = await openPage("/", { respond: answer(WITH_PROBLEM) });
  await sleep(60);
  const attention = [...page.doc.querySelectorAll("main section")]
    .find((node) => node.querySelector("h2").textContent === "Needs attention");
  assert.ok(attention.classList.contains("card-wide"));
  const agents = [...page.doc.querySelectorAll("main section")]
    .find((node) => node.querySelector("h2").textContent === "Agents");
  assert.ok(!agents.classList.contains("card-wide"));
  // Full-width nodes come first whatever order the page lists them in.
  const order = page.dom.window.eval(`layoutOrder([card("A"), wideCard("W"), (() => { const n = card("L"); n.classList.add("card-wide", "card-last"); return n; })(), el("div", "note"), card("B")]).map((n) => n.textContent)`);
  assert.deepStrictEqual([...order], ["W", "note", "A", "B", "L"]);
});

// ---------------------------------------------------------------- logs card

const logsCardOf = (page) => [...page.doc.querySelectorAll("main section")]
  .find((node) => node.querySelector("h2") && node.querySelector("h2").textContent === "Logs");

test("Ops window loads logs once and shows the lines, full width at the end", async () => {
  const page = await openPage("/ops", { latencyMs: 10 });
  await sleep(80);
  const card = logsCardOf(page);
  assert.ok(card.classList.contains("card-wide") && card.classList.contains("card-last"));
  assert.match(card.querySelector("pre").textContent, /started\n.*idle/s);
  assert.deepStrictEqual(page.logRequests, ["logs?unit=&errors=0"]);
  // The 5-second refresh redraws the window but neither reloads nor replaces the card.
  page.dom.window.eval("refresh()");
  await sleep(60);
  assert.strictEqual(logsCardOf(page), card);
  assert.strictEqual(page.logRequests.length, 1);
});

test("picking a service or the errors filter reloads with that choice", async () => {
  const page = await openPage("/ops", {
    latencyMs: 10,
    logs: (name) => ({ ...LOGS, unit: new URLSearchParams(name.split("?")[1]).get("unit") || "ai-coding-agent", lines: [] }),
  });
  await sleep(80);
  const pick = (label) => [...logsCardOf(page).querySelectorAll("button")].find((b) => b.textContent === label).click();
  pick("ai-pm-agent");
  await sleep(60);
  pick("Errors (24 h)");
  await sleep(60);
  assert.deepStrictEqual(page.logRequests.slice(1), ["logs?unit=ai-pm-agent&errors=0", "logs?unit=ai-pm-agent&errors=1"]);
  const pressed = [...logsCardOf(page).querySelectorAll('button[aria-pressed="true"]')].map((b) => b.textContent);
  assert.deepStrictEqual(pressed, ["ai-pm-agent", "Errors (24 h)"]);
  assert.match(logsCardOf(page).textContent, /No errors in the last 24 hours/);
});

test("a failed logs request is shown in the card", async () => {
  const page = await openPage("/ops", { latencyMs: 10, logs: () => ({ ok: false, error: "journalctl is not available or timed out", units: [] }) });
  await sleep(80);
  assert.match(logsCardOf(page).textContent, /journalctl is not available/);
});

// ---------------------------------------------------------------- services card

const servicesCardOf = (page) => [...page.doc.querySelectorAll("main section")]
  .find((node) => node.querySelector("h2") && node.querySelector("h2").textContent === "Services");
const restartButtons = (page) => [...servicesCardOf(page).querySelectorAll("button")];
const opsServer = (overrides = {}) => ({
  latencyMs: 10,
  respond: async (name) => ({ ok: true, status: 200,
    json: async () => (name === "ops" ? { ...OPS, ...overrides } : DATA[name]) }),
});

test("Services card lists the whitelisted services with state and uptime", async () => {
  const page = await openPage("/ops", opsServer());
  await sleep(60);
  const text = servicesCardOf(page).textContent;
  assert.match(text, /ai-coding-agentactive · up 1h 0mRestart/);
  assert.match(text, /ai-pm-agentfailedRestart/);
  assert.strictEqual(restartButtons(page).length, 3);
});

test("restart asks first, then sends only the service name", async () => {
  const page = await openPage("/ops", opsServer());
  await sleep(60);
  const asked = [];
  page.dom.window.Telegram.WebApp.showConfirm = (message, callback) => { asked.push(message); callback(false); };
  restartButtons(page)[1].click();
  await sleep(30);
  assert.deepStrictEqual(page.posts, []);
  assert.strictEqual(restartButtons(page)[1].disabled, false);
  page.dom.window.Telegram.WebApp.showConfirm = (message, callback) => { asked.push(message); callback(true); };
  restartButtons(page)[1].click();
  await sleep(60);
  assert.strictEqual(asked[0], "Restart ai-pm-agent?");
  assert.deepStrictEqual(page.posts, ["/api/ops/restart"]);
  assert.deepStrictEqual(page.bodies, [{ service: "ai-pm-agent" }]);
  assert.strictEqual(restartButtons(page)[1].textContent, "Restarting…");
});

test("restart warnings: a running task, and the dashboard itself", async () => {
  const agents = LAUNCHER.agents.map((agent) => (agent.name === "coding"
    ? { ...agent, unit: "ai-coding-agent", detail: "running feature/x · Polling CI" } : agent));
  const page = await openPage("/ops", opsServer({ agents }));
  await sleep(60);
  const asked = [];
  page.dom.window.Telegram.WebApp.showConfirm = (message, callback) => { asked.push(message); callback(false); };
  restartButtons(page)[0].click();
  restartButtons(page)[2].click();
  await sleep(30);
  assert.match(asked[0], /task will be interrupted/);
  assert.match(asked[1], /dashboard reconnects in a few seconds/);
});

test("a refused restart is shown and the button comes back", async () => {
  const page = await openPage("/ops", {
    ...opsServer(),
    onPost: async () => ({ ok: false, status: 502, json: async () => ({ ok: false, error: "Unit not found" }) }),
  });
  await sleep(60);
  page.dom.window.Telegram.WebApp.showConfirm = (message, callback) => callback(true);
  restartButtons(page)[0].click();
  await sleep(60);
  assert.match(page.text("alert"), /Restart of ai-coding-agent failed: Unit not found/);
  assert.strictEqual(restartButtons(page)[0].textContent, "Restart");
});

test("without ai-service the card explains instead of offering buttons", async () => {
  const page = await openPage("/ops", opsServer({ service_control: { ok: false, error: "ai-service is not installed on this server", services: [] } }));
  await sleep(60);
  assert.match(servicesCardOf(page).textContent, /ai-service is not installed/);
  assert.strictEqual(restartButtons(page).length, 0);
});

// ---------------------------------------------------------------- updates card

const updatesCardOf = (page) => [...page.doc.querySelectorAll("main section")]
  .find((node) => node.querySelector("h2") && node.querySelector("h2").textContent === "Updates");
const updateButtons = (page) => [...updatesCardOf(page).querySelectorAll("button")];
const PACKAGE_REPORT = { ok: true, total: 3, security: ["openssl"], stable: ["curl"], untested: ["vim"],
  checked_at: Date.now() / 1000 - 120, reboot_required: true };
const withPackages = (packages) => opsServer({ packages: { running: null, report: null, last_upgrade: null, ...packages } });

test("Updates card offers only a check until one has run", async () => {
  const page = await openPage("/ops", withPackages({}));
  await sleep(60);
  assert.match(updatesCardOf(page).textContent, /Not checked since the dashboard started/);
  assert.deepStrictEqual(updateButtons(page).map((button) => button.textContent), ["Check for updates"]);
  updateButtons(page)[0].click();
  await sleep(60);
  assert.deepStrictEqual(page.posts, ["/api/ops/packages"]);
  assert.deepStrictEqual(page.bodies, [{ action: "check" }]);
});

test("Updates card lists what is available and asks before upgrading", async () => {
  const page = await openPage("/ops", withPackages({ report: PACKAGE_REPORT }));
  await sleep(60);
  const text = updatesCardOf(page).textContent;
  assert.match(text, /Available3Security1openssl, curl, vimChecked2m/);
  assert.match(text, /Rebootrequired to finish updates/);
  let asked = confirmWith(page, false);
  updateButtons(page)[1].click();
  await sleep(60);
  assert.match(asked[0], /Upgrade 3 packages\?/);
  assert.deepStrictEqual(page.posts, []);
  asked = confirmWith(page, true);
  updateButtons(page)[1].click();
  updateButtons(page)[1].click();  // double tap
  await sleep(60);
  assert.strictEqual(asked.length, 1);
  assert.deepStrictEqual(page.bodies, [{ action: "upgrade" }]);
});

test("Updates card is locked while a run is active and shows the last upgrade", async () => {
  const page = await openPage("/ops", withPackages({ running: "upgrade", report: PACKAGE_REPORT,
    last_upgrade: { ok: false, error: "E: dpkg was interrupted" } }));
  await sleep(60);
  assert.deepStrictEqual(updateButtons(page).map((button) => [button.textContent, button.disabled]),
    [["Check for updates", true], ["Upgrading…", true]]);
  assert.match(updatesCardOf(page).textContent, /Last upgradefailedE: dpkg was interrupted/);
});

test("Updates card hides Upgrade when nothing is pending and reports a refused start", async () => {
  const page = await openPage("/ops", { ...withPackages({ report: { ...PACKAGE_REPORT, total: 0, security: [], stable: [], untested: [] } }),
    onPost: async () => ({ ok: false, status: 409, json: async () => ({ error: "a package run is already active" }) }) });
  await sleep(60);
  assert.match(updatesCardOf(page).textContent, /Availableup to date/);
  assert.strictEqual(updateButtons(page).length, 1);
  updateButtons(page)[0].click();
  await sleep(60);
  assert.match(page.text("alert"), /Package check did not start: a package run is already active/);
  assert.strictEqual(updateButtons(page)[0].disabled, false);
});

// ---------------------------------------------------------------- AI tools card

const toolsCardOf = (page) => [...page.doc.querySelectorAll("main section")]
  .find((node) => node.querySelector("h2") && node.querySelector("h2").textContent === "AI tools");
const toolButtons = (page) => [...toolsCardOf(page).querySelectorAll("button")];
const TOOL_REPORT = { ok: true, checked_at: Date.now() / 1000 - 120, tools: [
  { name: "codex", package: "@openai/codex", version: null, latest: "0.9.0", update_available: false },
  { name: "claude", package: "@anthropic-ai/claude-code", version: "2.1.0 (Claude Code)", latest: "2.2.0", update_available: true },
] };
const withTools = (state) => opsServer({ ai_tools: { running: null, report: null, last_update: null, ...state } });

test("AI tools card offers only a check until one has run", async () => {
  const page = await openPage("/ops", withTools({}));
  await sleep(60);
  assert.deepStrictEqual(toolButtons(page).map((button) => button.textContent), ["Check versions"]);
  toolButtons(page)[0].click();
  await sleep(60);
  assert.deepStrictEqual(page.posts, ["/api/ops/tools"]);
  assert.deepStrictEqual(page.bodies, [{ action: "check" }]);
});

test("AI tools card offers Update only where a newer version exists, after a confirmation", async () => {
  const page = await openPage("/ops", withTools({ report: TOOL_REPORT }));
  await sleep(60);
  const text = toolsCardOf(page).textContent;
  assert.match(text, /codexnot installed/);
  assert.match(text, /claude2\.1\.0 \(Claude Code\) · 2\.2\.0 availableUpdate/);
  assert.deepStrictEqual(toolButtons(page).map((button) => button.textContent), ["Update", "Check versions"]);
  let asked = confirmWith(page, false);
  toolButtons(page)[0].click();
  await sleep(60);
  assert.match(asked[0], /Update claude to 2\.2\.0\?/);
  assert.deepStrictEqual(page.posts, []);
  asked = confirmWith(page, true);
  toolButtons(page)[0].click();
  toolButtons(page)[0].click();  // double tap
  await sleep(60);
  assert.strictEqual(asked.length, 1);
  assert.deepStrictEqual(page.bodies, [{ action: "update", tool: "claude" }]);
});

test("AI tools card is locked while a run is active and shows a failed update", async () => {
  const page = await openPage("/ops", withTools({ running: "claude", report: TOOL_REPORT,
    last_update: { ok: false, name: "claude", error: "npm ERR! EACCES" } }));
  await sleep(60);
  assert.deepStrictEqual(toolButtons(page).map((button) => [button.textContent, button.disabled]),
    [["Updating…", true], ["Check versions", true]]);
  assert.match(toolsCardOf(page).textContent, /Last updateclaude failednpm ERR! EACCES/);
});

// ---------------------------------------------------------------- reboot

const rebootButtonOf = (page) => page.doc.querySelector("button.reboot-button");
const answerInTurn = (page, answers) => {
  const asked = [];
  page.dom.window.Telegram.WebApp.showConfirm = (message, callback) => { asked.push(message); callback(answers[asked.length - 1]); };
  return asked;
};

test("reboot needs two confirmations and sends only the fixed body", async () => {
  const page = await openPage("/ops", opsServer());
  await sleep(60);
  let asked = answerInTurn(page, [false]);
  rebootButtonOf(page).click();
  await sleep(30);
  assert.match(asked[0], /Reboot the server\?/);
  asked = answerInTurn(page, [true, false]);
  rebootButtonOf(page).click();
  await sleep(30);
  assert.deepStrictEqual(asked.length, 2);
  assert.deepStrictEqual(page.posts, []);
  answerInTurn(page, [true, true]);
  const button = rebootButtonOf(page);
  button.click();
  button.click();  // double tap
  await sleep(60);
  assert.deepStrictEqual(page.posts, ["/api/ops/reboot"]);
  assert.deepStrictEqual(page.bodies, [{ confirm: "reboot" }]);
  assert.strictEqual(rebootButtonOf(page).textContent, "Rebooting…");
  assert.strictEqual(rebootButtonOf(page).disabled, true);
});

test("a refused reboot says why and frees the button; no ai-service, no button", async () => {
  const refused = await openPage("/ops", { ...opsServer({ packages: { running: null, last_upgrade: null,
    report: { ok: true, total: 0, security: [], stable: [], untested: [], checked_at: 1, reboot_required: true } } }),
    onPost: async () => ({ ok: false, status: 409, json: async () => ({ error: "a package upgrade is running" }) }) });
  await sleep(60);
  assert.match(refused.doc.querySelector("main").textContent, /A reboot is required to finish installed updates/);
  answerInTurn(refused, [true, true]);
  rebootButtonOf(refused).click();
  await sleep(60);
  assert.match(refused.text("alert"), /Reboot did not start: a package upgrade is running/);
  assert.strictEqual(rebootButtonOf(refused).disabled, false);
  const missing = await openPage("/ops", opsServer({ service_control: { ok: false, error: "ai-service is not installed", services: [] } }));
  await sleep(60);
  assert.strictEqual(rebootButtonOf(missing), null);
});

// ---------------------------------------------------------------- deploy latest

const deployButtonOf = (page) => page.doc.querySelector("button.deploy-button");

test("Deploy latest main asks first, then sends only the target", async () => {
  const page = await openPage("/ops", { respond: opsDeployments(DEPLOYMENT_STATE) });
  await sleep(50);
  let asked = confirmWith(page, false);
  deployButtonOf(page).click();
  await sleep(30);
  assert.match(asked[0], /Deploy the latest main to ai-pm-agent\? The service will restart\./);
  assert.deepStrictEqual(page.posts, []);
  assert.strictEqual(deployButtonOf(page).disabled, false);
  asked = confirmWith(page, true);
  const button = deployButtonOf(page);
  button.click();
  button.click();  // double tap
  await sleep(60);
  assert.strictEqual(asked.length, 1);
  assert.deepStrictEqual(page.posts, ["/api/ops/deploy"]);
  assert.deepStrictEqual(page.bodies, [{ target: "ai-pm-agent" }]);
});

test("Deploy is disabled while a deployment runs and a refusal is shown", async () => {
  const busy = await openPage("/ops", { respond: opsDeployments({ ...DEPLOYMENT_STATE,
    targets: [{ ...DEPLOYMENT_STATE.targets[0], status: "deploying" }] }) });
  await sleep(50);
  assert.strictEqual(deployButtonOf(busy).disabled, true);
  const page = await openPage("/ops", { respond: opsDeployments(DEPLOYMENT_STATE),
    onPost: async () => ({ ok: false, status: 409, json: async () => ({ error: "A deployment operation is already running" }) }) });
  await sleep(50);
  confirmWith(page, true);
  deployButtonOf(page).click();
  await sleep(60);
  assert.match(page.text("alert"), /Deployment request failed: A deployment operation is already running/);
});

// ---------------------------------------------------------------- coding work card

const workCardOf = (page) => [...page.doc.querySelectorAll("main section")]
  .find((node) => node.querySelector("h2") && node.querySelector("h2").textContent === "Work");
const workButtons = (page) => [...workCardOf(page).querySelectorAll("button")].map((button) => button.textContent);
const codingWork = (work, extra = {}) => ({
  latencyMs: 10,
  respond: async (name) => ({ ok: true, status: 200,
    json: async () => (name === "coding" ? { ...CODING, snapshot: { ...CODING.snapshot, ...work } } : DATA[name]) }),
  ...extra,
});
const queuedPost = { onPost: async () => ({ ok: true, status: 202, json: async () => ({ id: "abcd1234" }) }) };

test("Work card offers to start new work when nothing is pending", async () => {
  const page = await openPage("/coding", codingWork({}));
  await sleep(60);
  assert.match(workCardOf(page).textContent, /QueueemptyLast runnone yet/);
  assert.ok(workCardOf(page).querySelector("textarea.work-draft"));
  assert.deepStrictEqual(workButtons(page), ["Plan", "Implement", "Bugfix"]);
});

test("an unapproved plan offers Approve and Cancel; Approve sends at once, only once", async () => {
  const page = await openPage("/coding", codingWork({ pending_plan: { id: "p", feature: "add login", revision: 2, approved: false } }, queuedPost));
  await sleep(60);
  assert.match(workCardOf(page).textContent, /Planadd login · revision 2waiting for approval/);
  assert.deepStrictEqual(workButtons(page), ["Approve", "Cancel"]);
  const approve = buttonNamed(page, "Approve");
  approve.click();
  approve.click();  // double tap
  await sleep(60);
  assert.deepStrictEqual(page.posts, ["/api/coding/actions"]);
  assert.deepStrictEqual(page.bodies, [{ action: "approve_plan", args: {} }]);
});

test("an approved plan runs only after a confirmation that names the cost", async () => {
  const page = await openPage("/coding", codingWork({ pending_branch: "feat/login",
    pending_plan: { id: "p", feature: "add login", revision: 2, approved: true } }, queuedPost));
  await sleep(60);
  assert.deepStrictEqual(workButtons(page), ["Confirm and run", "Cancel"]);
  let asked = confirmWith(page, false);
  buttonNamed(page, "Confirm and run").click();
  await sleep(30);
  assert.match(asked[0], /Queue feat\/login and run it\? This uses AI tokens and opens a pull request\./);
  assert.deepStrictEqual(page.posts, []);
  assert.strictEqual(buttonNamed(page, "Confirm and run").disabled, false);
  asked = confirmWith(page, true);
  buttonNamed(page, "Confirm and run").click();
  await sleep(60);
  assert.deepStrictEqual(page.bodies, [{ action: "confirm_work", args: {} }]);
});

test("Cancel and Remove ask first and send the exact target", async () => {
  const page = await openPage("/coding", codingWork({ pending_branch: "fix/crash", running: { status: "RUNNING", branch: "feat/a", phase: "tests" },
    queue: [{ id: 7, branch: "feat/b", label: "implementation" }, { id: 8, branch: "fix/c", label: "bugfix" }] }, queuedPost));
  await sleep(60);
  assert.deepStrictEqual(workButtons(page), ["Confirm and run", "Cancel", "Remove", "Remove"]);
  const asked = confirmWith(page, true);
  [...workCardOf(page).querySelectorAll("button")][3].click();
  await sleep(60);
  assert.match(asked[0], /Remove queued task #8 \(fix\/c\)\?/);
  assert.deepStrictEqual(page.bodies, [{ action: "remove_queued", args: { task: "8" } }]);
});

test("a queue left without a runner can be started; a bugfix question points to the chat", async () => {
  const stalled = await openPage("/coding", codingWork({ queue: [{ id: 7, branch: "feat/b", label: "implementation" }] }));
  await sleep(60);
  assert.deepStrictEqual(workButtons(stalled), ["Plan", "Implement", "Bugfix", "Remove", "Run the queue"]);
  const bugfix = await openPage("/coding", codingWork({ awaiting_bugfix_answer: true }));
  await sleep(60);
  assert.match(workCardOf(bugfix).textContent, /Answer in the bot chat with \/answer\./);
  assert.deepStrictEqual(workButtons(bugfix), ["Cancel"]);
});

test("a refused work request is shown and the last run keeps its PR link", async () => {
  const page = await openPage("/coding", codingWork({ pending_branch: "feat/x",
    last_execution: { branch: "feat/old", tests: "passed", files_changed: ["a", "b"], pr_url: "https://github.com/o/r/pull/1" } },
  { onPost: async () => ({ ok: false, status: 409, json: async () => ({ error: "agent inbox is not configured" }) }) }));
  await sleep(60);
  assert.match(workCardOf(page).textContent, /feat\/oldpassed · 2 file\(s\)/);
  assert.ok(workCardOf(page).querySelector("a"));
  confirmWith(page, true);
  buttonNamed(page, "Cancel").click();
  await sleep(60);
  assert.match(page.text("alert"), /Not sent: agent inbox is not configured/);
});

// ---------------------------------------------------------------- start new work

const typeDraft = (page, text) => {
  const draft = workCardOf(page).querySelector("textarea");
  draft.value = text;
  draft.dispatchEvent(new page.dom.window.Event("input", { bubbles: true }));
};

test("starting work needs text and a confirmation, and sends one normalized line", async () => {
  const page = await openPage("/coding", codingWork({}, queuedPost));
  await sleep(60);
  const asked = confirmWith(page, true);
  buttonNamed(page, "Plan").click();
  assert.match(page.text("alert"), /Describe the feature or the bug first/);
  assert.strictEqual(asked.length, 0);
  typeDraft(page, "  add a login\n page  ");
  const implement = buttonNamed(page, "Implement");
  implement.click();
  implement.click();  // double tap
  await sleep(60);
  assert.strictEqual(asked.length, 1);
  assert.match(asked[0], /Plan and prepare "add a login page"\? This uses AI tokens/);
  assert.deepStrictEqual(page.bodies, [{ action: "start_work", args: { kind: "implement", text: "add a login page" } }]);
});

test("declining keeps the draft; the draft survives a refresh until the agent accepts it", async () => {
  const state = { actions: [] };
  const page = await openPage("/coding", {
    latencyMs: 10,
    respond: async (name) => ({ ok: true, status: 200,
      json: async () => (name === "coding" ? { ...CODING, snapshot: { ...CODING.snapshot, setup: { ...SETUP, actions: state.actions } } } : DATA[name]) }),
    onPost: async () => ({ ok: true, status: 202, json: async () => ({ id: "abcd1234" }) }),
  });
  await sleep(60);
  typeDraft(page, "fix the crash on start");
  confirmWith(page, false);
  buttonNamed(page, "Bugfix").click();
  await sleep(30);
  assert.deepStrictEqual(page.posts, []);
  await page.dom.window.eval("refresh()");
  await sleep(40);
  assert.strictEqual(workCardOf(page).querySelector("textarea").value, "fix the crash on start");
  confirmWith(page, true);
  buttonNamed(page, "Bugfix").click();
  await sleep(60);
  assert.deepStrictEqual(page.bodies, [{ action: "start_work", args: { kind: "bugfix", text: "fix the crash on start" } }]);
  assert.strictEqual(workCardOf(page).querySelector("textarea").value, "fix the crash on start");
  state.actions = [{ id: "abcd1234", action: "start_work", status: "done", message: "Checking whether the bug report is actionable..." }];
  await page.dom.window.eval("refresh()");
  await sleep(40);
  await page.dom.window.eval("refresh()");
  await sleep(40);
  assert.strictEqual(workCardOf(page).querySelector("textarea").value, "");
  assert.match(page.text("alert"), /Checking whether the bug report is actionable\.\.\. The result will arrive in the bot chat\./);
});

test("a refused start keeps the draft and shows the agent's reason", async () => {
  const state = { actions: [] };
  const page = await openPage("/coding", {
    latencyMs: 10,
    respond: async (name) => ({ ok: true, status: 200,
      json: async () => (name === "coding" ? { ...CODING, snapshot: { ...CODING.snapshot, setup: { ...SETUP, actions: state.actions } } } : DATA[name]) }),
    onPost: async () => ({ ok: true, status: 202, json: async () => ({ id: "abcd1234" }) }),
  });
  await sleep(60);
  typeDraft(page, "add search");
  confirmWith(page, true);
  buttonNamed(page, "Plan").click();
  await sleep(60);
  state.actions = [{ id: "abcd1234", action: "start_work", status: "failed", message: "A request is already being planned; wait for the bot chat." }];
  await page.dom.window.eval("refresh()");
  await sleep(40);
  await page.dom.window.eval("refresh()");
  await sleep(40);
  assert.match(page.text("alert"), /already being planned/);
  assert.strictEqual(workCardOf(page).querySelector("textarea").value, "add search");
});

// ---------------------------------------------------------------- plan details

const PLAN = { id: "p1", feature: "add login", revision: 2, approved: false, branch: "feature/login",
  summary: "Add a login page with a session cookie.", files: ["app/login.py", "tests/test_login.py"],
  steps: ["Write the form", "Check the password", "Add tests"], risks: ["Sessions are new here"] };

test("a pending plan shows its summary, with files, steps and risks under Details", async () => {
  const page = await openPage("/coding", codingWork({ pending_plan: PLAN }));
  await sleep(60);
  const card = workCardOf(page);
  assert.strictEqual(card.querySelector(".plan-summary").textContent, "Add a login page with a session cookie.");
  const details = card.querySelector("details.plan-details");
  assert.strictEqual(details.open, false);
  assert.strictEqual(details.querySelector("summary").textContent, "Details · 3 steps · 2 files");
  assert.match(details.textContent, /Branchfeature\/login/);
  assert.deepStrictEqual([...details.querySelectorAll("ol li")].map((n) => n.textContent), PLAN.steps);
  assert.deepStrictEqual([...details.querySelectorAll("ul li")].map((n) => n.textContent), [...PLAN.files, ...PLAN.risks]);
  assert.deepStrictEqual(workButtons(page), ["Approve", "Cancel"]);
});

test("opened plan details stay open across refreshes, until the plan changes", async () => {
  const state = { plan: PLAN };
  const page = await openPage("/coding", {
    latencyMs: 10,
    respond: async (name) => ({ ok: true, status: 200,
      json: async () => (name === "coding" ? { ...CODING, snapshot: { ...CODING.snapshot, pending_plan: state.plan } } : DATA[name]) }),
  });
  await sleep(60);
  const details = () => workCardOf(page).querySelector("details.plan-details");
  details().open = true;
  details().dispatchEvent(new page.dom.window.Event("toggle"));
  await page.dom.window.eval("refresh()");
  await sleep(40);
  assert.strictEqual(details().open, true);
  state.plan = { ...PLAN, revision: 3 };
  await page.dom.window.eval("refresh()");
  await sleep(40);
  assert.strictEqual(details().open, false);
});

test("plan text is never treated as markup, and an older agent shows no details", async () => {
  const hostile = await openPage("/coding", codingWork({ pending_plan: { ...PLAN, summary: "<img src=x onerror=alert(1)>", steps: ["<b>bold</b>"] } }));
  await sleep(60);
  assert.strictEqual(workCardOf(hostile).querySelector("img"), null);
  assert.strictEqual(workCardOf(hostile).querySelector("ol li").textContent, "<b>bold</b>");
  const old = await openPage("/coding", codingWork({ pending_plan: { id: "p", feature: "add login", revision: 2, approved: false } }));
  await sleep(60);
  assert.strictEqual(workCardOf(old).querySelector(".plan-details"), null);
  assert.deepStrictEqual(workButtons(old), ["Approve", "Cancel"]);
});
