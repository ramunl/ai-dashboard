// Browser-level tests for the dashboard page (ai_dashboard/static/index.html).
// Run: npm install && npm test
//
// Guards the navigation race that once left a window blank with a stale
// header: navigating while a request was in flight skipped the new request,
// and the old response was discarded, so nothing ever rendered.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

const PAGE = fs
  .readFileSync(path.join(__dirname, "../../ai_dashboard/static/index.html"), "utf8")
  .replace('<script src="https://telegram.org/js/telegram-web-app.js"></script>', "");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const LAUNCHER = {
  resources: { hostname: "vps", cpus: 1, load: [0.1, 0.1, 0.1],
    memory: { total: 1e9, available: 5e8 }, disk: { total: 2e10, used: 1e10, free: 1e10 }, uptime_seconds: 3600 },
  services: [{ unit: "ai-pm-agent", load_state: "loaded", state: "active", restarts: 0, errors_last_hour: 0 }],
  agents: [
    { name: "coding", label: "Coding agent", path: "coding", service: "active", problem: null, detail: "idle" },
    { name: "pm", label: "PM agent", path: "pm", service: "active", problem: null, detail: "cc · 1 open" },
  ],
  problems: [],
};
const PM = { agent: "pm", service: "active", problem: null, age_seconds: 2, snapshot: {
  format: 1, active_project: "cc", todos: { project: "cc", open: ["release apk"], open_count: 1, done: 0 },
  projects: [{ name: "cc", open: 1, done: 0 }], rules: [], version: "v", core: "core: v1.1" } };

async function openPage(url, latencyMs = 150) {
  const back = { handler: null, visible: false };
  const errors = [];
  const dom = new JSDOM(PAGE, {
    url: "https://dashboard.test" + url, runScripts: "dangerously", pretendToBeVisual: true,
    beforeParse(window) {
      window.Telegram = { WebApp: { initData: "signed", ready() {}, expand() {}, openLink() {},
        BackButton: { show() { back.visible = true; }, hide() { back.visible = false; },
                      onClick(handler) { back.handler = handler; } } } };
      window.fetch = async (api) => {
        await sleep(latencyMs);  // a slow 1-CPU server
        return { ok: true, json: async () => (api.endsWith("/launcher") ? LAUNCHER : PM) };
      };
      window.setInterval = () => 0;  // no timer: navigation alone must render
    },
  });
  dom.virtualConsole.on("jsdomError", (error) => errors.push(error.message));
  const doc = dom.window.document;
  return {
    dom, back, errors,
    state: () => ({
      path: dom.window.location.pathname,
      title: doc.getElementById("title").textContent,
      cards: doc.querySelectorAll("main section").length,
      backVisible: back.visible,
    }),
    tapAgent: (index) => doc.querySelectorAll(".nav")[index].click(),
  };
}

test("Back pressed before the window loads still renders the launcher", async () => {
  const page = await openPage("/");
  await sleep(250);
  page.tapAgent(1);
  await sleep(50);
  page.back.handler();
  await sleep(600);
  assert.deepStrictEqual(page.state(), { path: "/", title: "Server", cards: 4, backVisible: false });
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
  assert.strictEqual(page.state().cards, 4);
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
  assert.deepStrictEqual(page.state(), { path: "/", title: "Server", cards: 4, backVisible: false });
  assert.strictEqual(page.dom.window.history.length, 1);
});
