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

test("app polling leaves the logs shell alone while log ticks keep working", async (t) => {
  const timers = new Map();
  const requests = [];
  const dom = new JSDOM(source, {
    url: "https://dashboard.test/coding/logs", runScripts: "dangerously",
    beforeParse(window) {
      window.Telegram = { WebApp: { initData: "signed", ready() {}, expand() {},
        BackButton: { show() {}, hide() {}, onClick() {} } } };
      window.setInterval = (callback, ms) => { timers.set(ms, callback); return ms; };
      window.clearInterval = (id) => timers.delete(id);
      window.scrollTo = () => {};
      window.fetch = async (url) => {
        requests.push(url);
        return { ok: true, json: async () => url.includes("logs?")
          ? { ok: true, unit: "coding", units: ["coding"], lines: ["line"] }
          : { problem: null, snapshot: null } };
      };
    },
  });
  t.after(() => dom.window.close());
  await new Promise((resolve) => setTimeout(resolve, 20));
  const title = dom.window.document.getElementById("title");
  const mutations = [];
  new dom.window.MutationObserver((records) => mutations.push(...records))
    .observe(title, { childList: true });
  const count = requests.length;
  await timers.get(5000)();
  assert.equal(requests.length, count);
  assert.equal(mutations.length, 0);
  await timers.get(3000)();
  assert.equal(requests.length, count + 1);
  dom.window.document.querySelector(".logs-lock-button").click();
  await timers.get(3000)();
  await timers.get(5000)();
  assert.equal(requests.length, count + 1);
  dom.window.document.querySelector(".logs-lock-button").click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(requests.length, count + 2);
  await timers.get(3000)();
  assert.equal(requests.length, count + 3);
  dom.window.eval("navigate('/coding')");
  assert.equal(timers.has(3000), false);
  await new Promise((resolve) => setTimeout(resolve, 10));
});

test("page scripts have unique global function and state names", () => {
  const names = new Map();
  const scripts = [...fs.readFileSync(path.join(root, "index.html"), "utf8")
    .matchAll(/<script src="\/static\/(js\/.+?)"><\/script>/g)];
  for (const [, file] of scripts) {
    const code = fs.readFileSync(path.join(root, file), "utf8");
    for (const match of code.matchAll(/^(?:async function|function|const|let)\s+(\w+)/gm)) {
      assert.ok(!names.has(match[1]), `${match[1]} in ${file} and ${names.get(match[1])}`);
      names.set(match[1], file);
    }
  }
});
