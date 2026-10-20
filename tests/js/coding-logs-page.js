// Shared harness for the Coding logs tests (coding-logs*.test.js): the page
// with its scripts inlined, a fake log box layout, and a scriptable logs
// endpoint. Not a test file: node --test runs only *.test.js.
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
    lock: () => doc.querySelector(".logs-lock-button"),
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

module.exports = { sleep, lines, UNITS, TEST_TIMEOUT_MS, openLogs, held };
