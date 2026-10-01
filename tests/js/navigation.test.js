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

const DATA = { launcher: LAUNCHER, coding: CODING, pm: PM };

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
    doc,
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
  assert.deepStrictEqual(page.state(), { path: "/coding", title: "repo", cards: 7, backVisible: true });
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
const answer = (body) => async (name) =>
  ({ ok: true, status: 200, json: async () => (name === "launcher" ? body : DATA[name]) });
const cardTitles = (page) => [...page.doc.querySelectorAll("main h2")].map((node) => node.textContent);

test("Ops window shows its own cards, never the agent list", async () => {
  const overview = await openPage("/", { respond: answer(WITH_PROBLEM) });
  await sleep(60);
  assert.deepStrictEqual(cardTitles(overview), ["Needs attention", "Agents", "Server resources"]);

  const ops = await openPage("/ops", { respond: answer(WITH_PROBLEM) });
  await sleep(60);
  assert.deepStrictEqual(cardTitles(ops), ["Operations", "Needs attention", "Server resources"]);
  assert.match(ops.doc.querySelector("main").textContent, /Up3h 2m/);

  const calm = await openPage("/ops", { respond: answer({ ...WITH_PROBLEM, problems: [] }) });
  await sleep(60);
  assert.deepStrictEqual(cardTitles(calm), ["Operations", "Server resources"]);
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
