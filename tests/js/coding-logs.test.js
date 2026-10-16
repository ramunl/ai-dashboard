// Browser-level tests for the Coding logs window (views/coding-logs.js and
// views/log-tail.js): in-place updates, scroll keeping, follow-tail, the
// "New lines" button, and poll hygiene. Run: npm test
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM, VirtualConsole } = require("jsdom");

const STATIC = path.join(__dirname, "../../ai_dashboard/static");
const TEST_TIMEOUT_MS = 400;
const LINE_PX = 10; // fake layout: every log line is 10 px tall
const BOX_PX = 100; // and the box shows 10 of them

// The page with its scripts inlined, as jsdom does not fetch /static/ files.
const PAGE = fs
  .readFileSync(path.join(STATIC, "index.html"), "utf8")
  .replace('<script src="/static/vendor/telegram-web-app.js"></script>', "")
  .replace('<link rel="stylesheet" href="/static/styles.css">', "")
  .replace(/<script src="\/static\/(.+?)"><\/script>/g, (_tag, file) => {
    const code = fs.readFileSync(path.join(STATIC, file), "utf8")
      .replace("const FETCH_TIMEOUT_MS = 15000;", `const FETCH_TIMEOUT_MS = ${TEST_TIMEOUT_MS};`);
    return `<script>${code}</script>`;
  });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const lines = (prefix, from, to) => Array.from({ length: to - from + 1 }, (_, i) => `${prefix} ${from + i}`);

const CODING = { agent: "coding", service: "active", problem: null, age_seconds: 1, snapshot: null };
const UNITS = ["ai-coding-agent", "ai-pm-agent", "ai-ops-agent"];

// jsdom has no layout: give the log box a scroll height from its line count
// and a scrollTop clamped like a browser's.
function fakeScrollLayout(window) {
  const proto = window.HTMLDivElement.prototype;
  const tops = new WeakMap();
  const isBox = (node) => node.classList.contains("log-tail-box");
  const height = (node) => node.querySelectorAll(".log-tail-line").length * LINE_PX;
  Object.defineProperty(proto, "scrollHeight", { configurable: true, get() { return isBox(this) ? height(this) : 0; } });
  Object.defineProperty(proto, "clientHeight", { configurable: true, get() { return isBox(this) ? BOX_PX : 0; } });
  Object.defineProperty(proto, "scrollTop", {
    configurable: true,
    get() { return tops.get(this) || 0; },
    set(value) { tops.set(this, Math.max(0, Math.min(value, height(this) - BOX_PX))); },
  });
}

// server.lines: what the logs endpoint answers; server.answer(query, signal):
// a custom answer (a promise) for the next requests while set.
async function openLogs(server) {
  const requests = [];
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error) => errors.push(error.message));
  const dom = new JSDOM(PAGE, {
    url: "https://dashboard.test/coding/logs", runScripts: "dangerously", pretendToBeVisual: true,
    virtualConsole,
    beforeParse(window) {
      window.Telegram = { WebApp: { initData: "signed", ready() {}, expand() {}, openLink() {},
        BackButton: { show() {}, hide() {}, onClick() {} } } };
      fakeScrollLayout(window);
      window.scrollTo = (x, y) => { window.scrollX = x; window.scrollY = y; };
      window.fetch = async (api, init) => {
        const name = api.split("/").pop();
        if (name.startsWith("logs?")) {
          requests.push({ query: name, signal: init.signal, cache: init.cache });
          const answer = server.answer ? await server.answer(name, init.signal)
            : { ok: true, unit: "ai-coding-agent", errors_only: false, units: UNITS, lines: server.lines };
          return { ok: true, status: 200, json: async () => answer };
        }
        await sleep(5);
        return { ok: true, status: 200, json: async () => CODING };
      };
      window.setInterval = () => 0; // no timer: tests call codingLogsTick()
    },
  });
  await sleep(40);
  const doc = dom.window.document;
  Object.defineProperty(doc.documentElement, "scrollHeight", { configurable: true, get: () => 2000 });
  const page = {
    dom, doc, requests, errors,
    box: () => doc.querySelector(".log-tail-box"),
    button: () => doc.querySelector(".new-lines-button"),
    error: () => doc.querySelector(".log-tail-error"),
    texts: () => [...doc.querySelectorAll(".log-tail-line")].map((node) => node.textContent),
    nodes: () => [...doc.querySelectorAll(".log-tail-line")],
    tick: () => dom.window.eval("codingLogsTick()"),
    scrollTo(top) {
      page.box().scrollTop = top;
      page.box().dispatchEvent(new dom.window.Event("scroll"));
    },
  };
  return page;
}

// A request held open until the test releases it (or the page aborts it).
function held() {
  const gate = {};
  gate.answer = (_query, signal) => new Promise((resolve, reject) => {
    gate.release = resolve;
    signal.addEventListener("abort", () => reject(new Error("aborted")));
  });
  return gate;
}

test("the window loads the coding agent's lines and follows the tail", async () => {
  const server = { lines: lines("a", 1, 20) };
  const page = await openLogs(server);
  assert.strictEqual(page.doc.getElementById("title").textContent, "Coding logs");
  assert.deepStrictEqual(page.texts(), server.lines);
  assert.strictEqual(page.box().scrollTop, 100); // 200 px of lines, 100 px box
  assert.strictEqual(page.button().hidden, true);
  assert.deepStrictEqual(page.errors, []);
});

test("new lines are appended without re-rendering or moving the scroll", async () => {
  const server = { lines: lines("a", 1, 20) };
  const page = await openLogs(server);
  const before = page.nodes();
  page.scrollTo(30); // the user reads older lines
  server.lines = lines("a", 3, 22); // the journal window slid by two lines
  await page.tick();
  assert.deepStrictEqual(page.texts(), lines("a", 1, 22));
  assert.ok(before.every((node, index) => page.nodes()[index] === node), "old line nodes were replaced");
  assert.strictEqual(page.box().scrollTop, 30);
  assert.strictEqual(page.button().hidden, false);
  assert.strictEqual(page.button().textContent, "New lines (2)");
  server.lines = lines("a", 4, 23);
  await page.tick();
  assert.strictEqual(page.button().textContent, "New lines (3)");
  assert.strictEqual(page.box().scrollTop, 30);
});

test("following the tail scrolls to new lines; unchanged answers touch nothing", async () => {
  const server = { lines: lines("a", 1, 20) };
  const page = await openLogs(server);
  const before = page.nodes();
  await page.tick();
  assert.ok(before.every((node, index) => page.nodes()[index] === node));
  server.lines = lines("a", 1, 23);
  await page.tick();
  assert.strictEqual(page.box().scrollTop, 130);
  assert.strictEqual(page.button().hidden, true);
});

test("the New lines button jumps down and resumes following; scrolling down clears it", async () => {
  const server = { lines: lines("a", 1, 20) };
  const page = await openLogs(server);
  page.scrollTo(0);
  server.lines = lines("a", 1, 22);
  await page.tick();
  page.button().click();
  assert.strictEqual(page.box().scrollTop, 120);
  assert.strictEqual(page.button().hidden, true);
  server.lines = lines("a", 1, 24);
  await page.tick();
  assert.strictEqual(page.box().scrollTop, 140); // following again
  page.scrollTo(0);
  server.lines = lines("a", 1, 25);
  await page.tick();
  assert.strictEqual(page.button().hidden, false);
  page.scrollTo(page.box().scrollHeight); // the user scrolls down by hand
  assert.strictEqual(page.button().hidden, true);
});

test("a rotated log replaces the lines and keeps the scroll position", async () => {
  const server = { lines: lines("a", 1, 20) };
  const page = await openLogs(server);
  page.scrollTo(30); // 170 px above the bottom
  server.lines = lines("b", 1, 25);
  await page.tick();
  assert.deepStrictEqual(page.texts(), server.lines);
  assert.strictEqual(page.box().scrollTop, 30);
  assert.strictEqual(page.button().hidden, false);
});

test("repeated identical lines are replaced, not guessed", async () => {
  const server = { lines: ["same", "same", "same"] };
  const page = await openLogs(server);
  server.lines = ["same", "same", "same", "same"];
  await page.tick();
  assert.deepStrictEqual(page.texts(), server.lines);
});

test("a shorter answer replaces the lines", async () => {
  const server = { lines: lines("a", 1, 20) };
  const page = await openLogs(server);
  server.lines = lines("a", 15, 20);
  await page.tick();
  assert.deepStrictEqual(page.texts(), server.lines);
});

test("a tick is skipped while the previous request is in flight", async () => {
  const server = { lines: lines("a", 1, 5) };
  const page = await openLogs(server);
  const gate = held();
  server.answer = gate.answer;
  const first = page.tick();
  await page.tick();
  await page.tick();
  assert.strictEqual(page.requests.length, 2); // the first load and one poll
  gate.release({ ok: true, unit: "ai-coding-agent", units: UNITS, lines: lines("a", 1, 6) });
  await first;
  assert.deepStrictEqual(page.texts(), lines("a", 1, 6));
  server.answer = null;
  await page.tick();
  assert.strictEqual(page.requests.length, 3);
});

test("a hung request times out with an error and keeps the lines", async () => {
  const server = { lines: lines("a", 1, 5) };
  const page = await openLogs(server);
  server.answer = held().answer;
  await page.tick();
  assert.strictEqual(page.error().hidden, false);
  assert.match(page.error().textContent, /Logs not updated: no answer within 0.4 s/);
  assert.deepStrictEqual(page.texts(), lines("a", 1, 5));
  server.answer = null;
  await page.tick(); // the next poll works again
  assert.strictEqual(page.error().hidden, true);
});

test("a server error is shown above the kept lines", async () => {
  const server = { lines: lines("a", 1, 5) };
  const page = await openLogs(server);
  server.answer = async () => ({ ok: false, error: "journalctl is not available or timed out", units: UNITS, unit: "ai-coding-agent" });
  await page.tick();
  assert.match(page.error().textContent, /journalctl is not available/);
  assert.deepStrictEqual(page.texts(), lines("a", 1, 5));
});

test("leaving the window cancels the poll and ignores its late answer", async () => {
  const server = { lines: lines("a", 1, 5) };
  const page = await openLogs(server);
  const box = page.box();
  const gate = held();
  server.answer = gate.answer;
  const pending = page.tick();
  page.dom.window.eval("navigate('/coding')");
  assert.ok(page.requests[page.requests.length - 1].signal.aborted, "the poll was not cancelled");
  await pending;
  assert.deepStrictEqual([...box.querySelectorAll(".log-tail-line")].map((n) => n.textContent), lines("a", 1, 5));
  // The error note sits next to the box, in the (now detached) log tail.
  assert.strictEqual(box.closest(".log-tail").querySelector(".log-tail-error").hidden, true);
  const count = page.requests.length;
  await page.tick(); // a timer tick after leaving does not poll
  assert.strictEqual(page.requests.length, count);
  await sleep(40);
  assert.strictEqual(page.doc.getElementById("title").textContent, "Coding agent");
});

test("a window refresh keeps the log box attached", async () => {
  const server = { lines: lines("a", 1, 20) };
  const page = await openLogs(server);
  const box = page.box();
  page.scrollTo(30);
  const changes = [];
  new page.dom.window.MutationObserver((records) => changes.push(...records))
    .observe(page.doc.getElementById("view"), { childList: true });
  page.dom.window.eval("refresh()");
  await sleep(40);
  assert.deepStrictEqual(changes, []);
  assert.strictEqual(page.box(), box);
  assert.strictEqual(box.scrollTop, 30);
});

test("the first answer for another unit is asked again for the coding agent", async () => {
  const server = { lines: lines("a", 1, 3) };
  server.answer = async (query) => {
    const unit = new URLSearchParams(query.split("?")[1]).get("unit") || "ai-pm-agent";
    return { ok: true, unit, units: ["ai-pm-agent", ...UNITS], lines: [`${unit} line`] };
  };
  const page = await openLogs(server);
  await sleep(20);
  assert.deepStrictEqual(page.requests.map((r) => r.query), ["logs?unit=&errors=0", "logs?unit=ai-coding-agent&errors=0"]);
  assert.deepStrictEqual(page.texts(), ["ai-coding-agent line"]);
});

test("lock skips polls, unlock fetches immediately, and ordinary taps do not pause", async () => {
  const server = { lines: lines("a", 1, 20) };
  const page = await openLogs(server);
  const lock = page.doc.querySelector(".logs-lock-button");
  assert.ok(lock);
  assert.strictEqual(lock.getAttribute("aria-pressed"), "false");
  lock.click();
  assert.strictEqual(lock.textContent, "Lock: on");
  assert.match(page.doc.querySelector(".logs-lock-status").textContent, /Updates paused/);
  await page.tick();
  assert.strictEqual(page.requests.length, 1);
  lock.click();
  assert.strictEqual(page.requests.length, 2);
  await sleep(10);
  page.box().click();
  await page.tick();
  assert.strictEqual(page.requests.length, 3);
  assert.ok(page.requests.every((request) => request.cache === "no-store"));
});

test("patch restores document and box scroll even if layout moves them", async () => {
  const server = { lines: lines("a", 1, 20) };
  const page = await openLogs(server);
  const win = page.dom.window;
  win.scrollTo(0, 350);
  page.scrollTo(30);
  const list = page.doc.querySelector(".log-tail-lines");
  const append = list.append.bind(list);
  list.append = (...nodes) => {
    append(...nodes);
    win.scrollTo(0, 0); // simulate browser anchoring/layout during a patch
    page.box().scrollTop = 0;
  };
  server.lines = lines("a", 1, 23);
  await page.tick();
  assert.strictEqual(win.scrollY, 350);
  assert.strictEqual(page.box().scrollTop, 30);
});

test("leaving resets lock and an aborted response cannot patch a new visit", async () => {
  const server = { lines: lines("a", 1, 20) };
  const page = await openLogs(server);
  let release;
  server.answer = () => new Promise((resolve) => { release = resolve; });
  const pending = page.tick();
  page.doc.querySelector(".logs-lock-button").click();
  page.dom.window.eval("navigate('/coding')");
  assert.ok(page.requests.at(-1).signal.aborted);
  server.answer = null;
  page.dom.window.eval("navigate('/coding/logs')");
  await sleep(40);
  release({ ok: true, unit: "ai-coding-agent", units: UNITS, lines: ["stale"] });
  await pending;
  assert.strictEqual(page.doc.querySelector(".logs-lock-button").getAttribute("aria-pressed"), "false");
  assert.deepStrictEqual(page.texts(), server.lines);
});
