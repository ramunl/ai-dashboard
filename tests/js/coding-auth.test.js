const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");
const STATIC = path.join(__dirname, "../../ai_dashboard/static");
const NOW = 1793132265;
const AUTH = { status: "authenticated", method: "oauth", checked_at: NOW,
  stale: false, relogin_at: null, days_remaining: null,
  countdown_support: "no_authoritative_deadline", warnings: [] };

function render(t, auth = AUTH, setup) {
  const dom = new JSDOM("<main></main>", { runScripts: "outside-only" });
  t.after(() => dom.window.close());
  for (const file of ["dom.js", "views/coding-auth.js"]) {
    dom.window.eval(fs.readFileSync(path.join(STATIC, "js", file), "utf8"));
  }
  const node = dom.window.codingAuthCard(setup === undefined ? {
    models: ["codex", "claude-code", "claude"].map(tool => ({ tool, auth })),
  } : setup, NOW);
  return node;
}

test("all tools and authentication states are distinct and readable", t => {
  for (const [status, label] of Object.entries({ authenticated: "Authenticated", logged_out: "Logged out",
    configured_unverified: "Configured, unverified", unknown: "Unknown", unavailable: "Check unavailable" })) {
    const text = render(t, { ...AUTH, status }).textContent;
    for (const expected of [label, "Codex", "Claude Code", "Claude API", "Last checked", "Unsupported"])
      assert.ok(text.includes(expected), expected);
  }
});

test("only supported deadlines count down, using time not cached days", t => {
  for (const [seconds, expected] of [[172801, "3 days"], [86400, "1 day"],
    [86399, "Under one day"], [1, "Under one day"], [0, "Overdue"], [-86400, "Overdue"]]) {
    const text = render(t, { ...AUTH, countdown_support: "supported", relogin_at: NOW + seconds, days_remaining: -99 }).textContent;
    assert.ok(text.includes(expected));
    assert.ok(!text.includes("-99"));
  }
  assert.match(render(t, { ...AUTH, relogin_at: NOW + 100, days_remaining: 1, expires_at: NOW + 100 }).textContent, /Unsupported/);
});

test("freshness follows observation time, failed checks and producer flags", t => {
  assert.doesNotMatch(render(t, { ...AUTH, checked_at: NOW - 899 }).textContent, /historical/);
  for (const change of [{ checked_at: NOW - 900 }, { stale: true }, { stale: undefined },
    { checked_at: null }, { checked_at: NOW + 1 }, { warnings: ["check_unavailable"] }, { warnings: ["auth_stale"] }]) {
    const text = render(t, { ...AUTH, countdown_support: "supported", relogin_at: NOW + 86400, ...change }).textContent;
    assert.match(text, /historical \/ unverified/);
    assert.doesNotMatch(text, /days? remaining/);
  }
});

test("older and malformed snapshots are explicit and cannot throw", t => {
  for (const setup of [null, {}, { models: {} }, { models: [null, {}, { tool: "codex", auth: [] }] }])
    assert.match(render(t, null, setup).textContent, /no observation/);
  for (const value of [null, "123", -1, 0, Infinity, NaN, {}, 1e100]) {
    const text = render(t, { ...AUTH, checked_at: value, relogin_at: value, countdown_support: "supported" }).textContent;
    assert.match(text, /invalid timestamp/);
    assert.match(text, /invalid deadline/);
  }
  const text = render(t, { status: "future-state", warnings: {} }).textContent;
  assert.match(text, /unrecognized status/);
  assert.match(text, /Warnings unavailable/);
  assert.match(text, /missing or unknown support/);
});

test("warnings are safe text and stale warnings are historical", t => {
  const attack = '<img src=x onerror="alert(1)">';
  const node = render(t, { ...AUTH, stale: true, warnings: ["login_required", "relogin_soon", "check_unavailable", "auth_stale", attack, {}] });
  assert.equal(node.querySelector("img"), null);
  assert.ok(node.textContent.includes(attack));
  for (const label of ["Login required", "Relogin soon", "check failed", "observation stale", "Malformed", "Historical / unverified warning"])
    assert.ok(node.textContent.includes(label), label);
});

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const response = body => ({ ok: true, json: async () => body });
const body = { service: "active", snapshot: { format: 2, updated_at: NOW, setup: {
  planner: "codex", implementer: "codex", planner_options: ["codex"], implementer_options: ["codex"],
  models: [{ tool: "codex", model: "default", manageable: false, auth: AUTH }],
} } };
function browser(t, fetch) {
  const html = fs.readFileSync(path.join(STATIC, "index.html"), "utf8")
    .replace('<script src="/static/vendor/telegram-web-app.js"></script>', "")
    .replace(/<script src="\/static\/(.+?)"><\/script>/g, (_, file) =>
      `<script>${fs.readFileSync(path.join(STATIC, file), "utf8").replace("const FETCH_TIMEOUT_MS = 15000;", "const FETCH_TIMEOUT_MS = 100;")}</script>`);
  const dom = new JSDOM(html, { url: "https://dashboard.test/coding/ai", runScripts: "dangerously",
    beforeParse(win) {
      win.Telegram = { WebApp: { initData: "signed", ready() {}, expand() {} } };
      win.fetch = fetch;
      win.setInterval = () => 0;
    } });
  t.after(() => dom.window.close());
  return dom.window;
}

test("slow Coding API loads authentication without additional probes", async t => {
  const calls = [];
  const win = browser(t, async (url, options) => {
    calls.push(url);
    assert.equal(options.headers.Authorization, "tma signed");
    await sleep(30);
    return response(body);
  });
  assert.match(win.document.getElementById("view").textContent, /Loading/);
  await sleep(70);
  assert.match(win.document.getElementById("view").textContent, /Authentication/);
  assert.deepEqual(calls, ["/api/coding"]);
});

test("hung request times out visibly and can recover", async t => {
  let hung = true;
  const win = browser(t, async (_, { signal }) => hung ? new Promise((resolve, reject) => {
    signal.addEventListener("abort", () => reject(new Error("aborted")));
  }) : response(body));
  await sleep(160);
  assert.match(win.document.getElementById("alert").textContent, /no answer within/);
  hung = false;
  await win.refresh();
  assert.match(win.document.getElementById("view").textContent, /Authentication/);
});

test("late responses after navigation cannot overwrite the active page", async t => {
  let resolveOld;
  let calls = 0;
  const win = browser(t, async () => ++calls === 1 ? new Promise(resolve => { resolveOld = resolve; }) :
    response({ service: "active", snapshot: null }));
  win.navigate("coding");
  await sleep(20);
  resolveOld(response(body));
  await sleep(20);
  assert.equal(win.document.getElementById("title").textContent, "Coding agent");
  assert.doesNotMatch(win.document.getElementById("view").textContent, /Authentication/);
  win.navigate("coding/ai");
  await sleep(20);
  assert.match(win.document.getElementById("view").textContent, /no observation/);
});
