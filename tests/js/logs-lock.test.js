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
const flush = () => new Promise((resolve) => setImmediate(resolve));
const answer = (line) => ({ ok: true, unit: "ops", units: ["ops"], lines: [line] });

async function openOps(t) {
  const calls = [], timers = new Map(), timeouts = new Map();
  let id = 0;
  const server = { answer: () => answer("original") };
  const dom = new JSDOM(source, {
    url: "https://dashboard.test/ops", runScripts: "dangerously", pretendToBeVisual: true,
    beforeParse(window) {
      window.Telegram = { WebApp: { initData: "signed", ready() {}, expand() {},
        BackButton: { show() {}, hide() {}, onClick() {} } } };
      window.setInterval = (fn) => { timers.set(++id, fn); return id; };
      window.clearInterval = (key) => timers.delete(key);
      window.setTimeout = (fn) => { timeouts.set(++id, fn); return id; };
      window.clearTimeout = (key) => timeouts.delete(key);
      window.fetch = async (url, options) => {
        let body;
        if (url.includes("logs?")) {
          calls.push(options.signal);
          body = await server.answer(options.signal);
        } else body = { agents: [], problems: [], services: [], resources: {
          hostname: "test", cpus: 1, load: [0, 0, 0], memory: { total: 100, available: 50 }, disk: { total: 100, used: 50, free: 50 }, uptime_seconds: 1,
        } };
        return { ok: true, json: async () => body };
      };
    },
  });
  t.after(() => dom.window.close());
  await flush();
  const doc = dom.window.document;
  assert.ok(doc.querySelector(".logs-text"), doc.getElementById("alert").textContent);
  return { dom, doc, calls, timers, timeouts, server,
    lock: () => doc.querySelector(".logs-lock-button"),
    box: () => doc.querySelector(".logs-text"),
    tick: () => dom.window.eval("loadLogs()"),
  };
}

test("Ops lock freezes ticks and shell refreshes, preserving focus and selection", async (t) => {
  const p = await openOps(t);
  const box = p.box();
  box.scrollTop = 23;
  p.lock().focus();
  const range = p.doc.createRange();
  range.selectNodeContents(box);
  p.dom.window.getSelection().removeAllRanges();
  p.dom.window.getSelection().addRange(range);
  p.lock().click();
  assert.equal(p.lock().getAttribute("aria-pressed"), "true");
  assert.equal(p.lock().textContent, "Unlock logs");
  assert.match(p.doc.querySelector(".logs-lock-status").textContent, /Updates paused/);
  assert.equal(p.dom.window.getSelection().toString(), "original", "before shell tick");
  for (const tick of p.timers.values()) await tick();
  assert.equal(p.calls.length, 1);
  assert.equal(p.box(), box);
  assert.equal(box.scrollTop, 23);
  assert.equal(p.dom.window.getSelection().toString(), "original");
  assert.equal(p.doc.activeElement, p.lock());
  p.server.answer = () => answer("latest");
  p.lock().click();
  assert.match(p.doc.querySelector(".logs-lock-status").textContent, /Loading/);
  await flush();
  assert.equal(p.box().textContent, "latest");
  assert.equal(p.doc.activeElement, p.lock());
  await p.tick();
  assert.equal(p.calls.length, 3);
});

test("slow responses arriving while locked or after unlock cannot overwrite logs", async (t) => {
  const p = await openOps(t);
  let release;
  p.server.answer = () => new Promise((resolve) => { release = resolve; });
  const pending = p.tick();
  p.lock().click();
  assert.equal(p.calls.at(-1).aborted, true);
  release(answer("stale while locked"));
  await pending;
  assert.equal(p.box().textContent, "original");
  assert.match(p.doc.querySelector(".logs-lock-status").textContent, /Updates paused/);
  p.lock().click();
  const oldRelease = release;
  p.lock().click();
  p.server.answer = () => answer("fresh");
  p.lock().click();
  await flush();
  oldRelease(answer("stale after unlock"));
  await flush();
  assert.equal(p.box().textContent, "fresh");
});

test("never-answering requests time out visibly and unlock retries immediately", async (t) => {
  const p = await openOps(t);
  p.server.answer = (signal) => new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(new Error("aborted")));
  });
  const pending = p.tick();
  await p.tick();
  assert.equal(p.calls.length, 2);
  for (const timeout of [...p.timeouts.values()]) timeout();
  await pending;
  assert.match(p.doc.querySelector(".logs-error").textContent, /no answer within 15 s/);
  assert.equal(p.box().textContent, "original");
  p.lock().click();
  p.server.answer = () => ({ ok: false, error: "journal unavailable" });
  p.lock().click();
  await flush();
  assert.match(p.doc.querySelector(".logs-error").textContent, /journal unavailable/);
  p.server.answer = () => answer("recovered");
  await p.tick();
  assert.equal(p.box().textContent, "recovered");
  assert.equal(p.doc.querySelector(".logs-error").textContent, "");
});

test("navigation aborts requests, removes polling, resets lock and rejects old responses", async (t) => {
  const p = await openOps(t);
  let release;
  p.server.answer = () => new Promise((resolve) => { release = resolve; });
  const pending = p.tick();
  const signal = p.calls.at(-1);
  p.dom.window.eval("navigate('/')");
  assert.equal(signal.aborted, true);
  assert.equal(p.timers.size, 1); // only the app shell remains
  await flush();
  p.server.answer = () => answer("returned");
  p.dom.window.eval("navigate('/ops')");
  await flush();
  release(answer("previous visit"));
  await pending;
  assert.equal(p.box().textContent, "returned");
  p.lock().click();
  p.dom.window.eval("navigate('/')");
  await flush();
  p.dom.window.eval("navigate('/ops')");
  await flush();
  assert.equal(p.lock().getAttribute("aria-pressed"), "false");
});
