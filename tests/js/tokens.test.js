const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM, VirtualConsole } = require("jsdom");
const root = path.join(__dirname, "../../ai_dashboard/static");
const page = fs.readFileSync(path.join(root, "index.html"), "utf8")
  .replace('<script src="/static/vendor/telegram-web-app.js"></script>', "")
  .replace(/<script src="\/static\/(.+?)"><\/script>/g, (_, file) =>
    `<script>${fs.readFileSync(path.join(root, file), "utf8").replace("const FETCH_TIMEOUT_MS = 15000;", "const FETCH_TIMEOUT_MS = 200;")}</script>`);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const totals = [
  { role: "planner", tool: "codex", tokens: 1200, calls: 3, unknown: 1 },
  { role: "planner", tool: "claude", tokens: 0, calls: 1, unknown: 0 },
  { role: "implementer", tool: "claude", tokens: null, calls: 1, unknown: 1 },
];
const period = { period: "2024-02-29", start: "2024-02-29", end: "2024-02-29", reported_days: 1, calendar_days: 1, partial: true, totals };
const usage = { available: true, timezone: "UTC", warnings: [], stale: false, age_seconds: 2,
  coverage: { window_days: 90, start: "2023-12-03", end: "2024-03-01", reported_days: 1 },
  totals, periods: { day: [period], week: [{ ...period, period: "2024-W09" }], month: [{ ...period, period: "2024-02" }] } };
const launcher = { resources: null, services: [], agents: [], problems: [] };
const answer = body => ({ ok: true, json: async () => body });
function open(respond, url = "/tokens", popstate = true) {
  const errors = [];
  const requests = [];
  const console = new VirtualConsole();
  console.on("jsdomError", error => errors.push(error.message));
  const dom = new JSDOM(page, { url: "https://test.invalid" + url, runScripts: "dangerously", virtualConsole: console,
    beforeParse(window) {
      window.Telegram = { WebApp: { initData: "signed", ready() {}, expand() {}, BackButton: { show() {}, hide() {}, onClick() {} } } };
      window.setInterval = () => 0;
      if (!popstate) window.history.back = () => {};
      window.fetch = (url, init) => {
        requests.push({ url, init });
        return respond ? respond(url, init) : Promise.resolve(answer(url === "/api/tokens" ? usage : launcher));
      };
    } });
  return { dom, errors, requests, doc: dom.window.document, text: () => dom.window.document.body.textContent };
}

test("Tokens renders accessible totals, measured zero, unavailable, coverage and launcher link", async t => {
  const p = open(); t.after(() => p.dom.window.close());
  await sleep(30);
  assert.deepEqual(p.errors, []);
  assert.match(p.text(), /1,200/);
  assert.match(p.text(), /Unavailable/);
  assert.match(p.text(), /UTC/);
  assert.match(p.text(), /Partial coverage/);
  assert.ok(p.doc.querySelector('th[scope="row"]'));
  assert.ok([...p.doc.querySelectorAll("td")].some(n => n.textContent === "0"));
  assert.equal(p.doc.querySelectorAll("caption").length, 4);
  assert.equal(p.requests[0].init.headers.Authorization, "tma signed");
  assert.ok(p.requests.every(r => !r.init.method));
  p.dom.window.goBack(); await sleep(30);
  assert.equal(p.dom.window.location.pathname, "/");
  p.doc.querySelector('a[href="/tokens"]').click(); await sleep(30);
  assert.equal(p.dom.window.location.pathname, "/tokens");
});

test("Tokens treats malicious text as text and shows stale warnings", async t => {
  const evil = '<img src=x onerror="alert(1)">';
  const data = { ...usage, stale: true, warnings: [evil], totals: [{ ...totals[0], role: evil }] };
  const p = open(() => Promise.resolve(answer(data))); t.after(() => p.dom.window.close());
  await sleep(30);
  assert.match(p.text(), /Stale data/);
  assert.ok(p.text().includes(evil));
  assert.equal(p.doc.querySelector("img"), null);
});

for (const available of [false, true]) {
  test(`Tokens empty state, available=${available}, never displays measured zero`, async t => {
    const p = open(() => Promise.resolve(answer({ ...usage, available, periods: { day: [], week: [], month: [] } })));
    t.after(() => p.dom.window.close()); await sleep(30);
    assert.match(p.text(), available ? /No reported usage/ : /Usage unavailable/);
    assert.equal(p.doc.querySelector("table"), null);
  });
}

test("Tokens server errors are visible and safe", async t => {
  const p = open(() => Promise.resolve({ ok: false, status: 500, json: async () => ({ error: "<b>failed</b>" }) }));
  t.after(() => p.dom.window.close()); await sleep(30);
  assert.match(p.text(), /Cannot load this window: <b>failed<\/b>/);
  assert.equal(p.doc.querySelector("b"), null);
});

test("slow Tokens load survives a refresh attempt", async t => {
  const p = open(async () => { await sleep(100); return answer(usage); });
  t.after(() => p.dom.window.close());
  p.dom.window.refresh(); await sleep(150);
  assert.equal(p.requests.length, 1);
  assert.ok(p.doc.querySelector("table"));
});

test("hung Tokens request times out and can recover", async t => {
  let recover = false;
  const p = open((_url, init) => recover ? Promise.resolve(answer(usage)) : new Promise((resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(new Error("aborted")));
  }));
  t.after(() => p.dom.window.close()); await sleep(260);
  assert.match(p.text(), /no answer within/);
  assert.doesNotMatch(p.doc.getElementById("view").textContent, /Loading/);
  recover = true; p.dom.window.refresh(); await sleep(30);
  assert.ok(p.doc.querySelector("table"));
});

test("late Tokens response cannot overwrite a newer visit", async t => {
  let finish;
  let count = 0;
  const p = open(url => {
    if (url !== "/api/tokens") return Promise.resolve(answer(launcher));
    if (++count === 1) return new Promise(resolve => { finish = resolve; });
    return Promise.resolve(answer(usage));
  });
  t.after(() => p.dom.window.close());
  p.dom.window.navigate(""); await sleep(20);
  p.dom.window.navigate("tokens"); await sleep(20);
  finish(answer({ ...usage, warnings: ["OBSOLETE"] })); await sleep(20);
  assert.doesNotMatch(p.text(), /OBSOLETE/);
  assert.equal(p.doc.getElementById("title").textContent, "Tokens");
  assert.ok(p.doc.querySelector("table"));
});

test("Tokens Back fallback works without popstate", async t => {
  const p = open(null, "/", false); t.after(() => p.dom.window.close());
  await sleep(20); p.dom.window.navigate("tokens"); await sleep(20);
  p.dom.window.goBack(); await sleep(360);
  assert.equal(p.dom.window.location.pathname, "/");
  assert.equal(p.doc.getElementById("title").textContent, "AI Agents");
});
