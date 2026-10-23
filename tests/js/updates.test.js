// Ops › Updates card in the page: cached versus verified counts, failed and
// unknown upgrades, and the start lock across polls and navigation. Each test
// builds its own page with its own server answers.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM, VirtualConsole } = require("jsdom");

const STATIC = path.join(__dirname, "../../ai_dashboard/static");
const PAGE = fs.readFileSync(path.join(STATIC, "index.html"), "utf8")
  .replace('<script src="/static/vendor/telegram-web-app.js"></script>', "")
  .replace('<link rel="stylesheet" href="/static/styles.css">', "")
  .replace(/<script src="\/static\/(.+?)"><\/script>/g, (_tag, file) =>
    `<script>${fs.readFileSync(path.join(STATIC, file), "utf8")}</script>`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const NOW = () => Date.now() / 1000;

const LAUNCHER = { resources: null, services: [], problems: [], agents: [
  { name: "ops", label: "Ops agent", path: "ops", service: "active", problem: null, detail: "Server health" },
] };
const opsView = (packages) => ({ ...LAUNCHER, packages: { running: null, report: null, last_upgrade: null,
  upgrade_blocked: null, reconciling: false, ...packages } });

const CACHED = { ok: true, total: 9, security: [], stable: ["curl"], untested: [], checked_at: NOW() - 36000,
  reboot_required: false, source: "check", stale: true };
const VERIFIED = { ok: true, total: 4, security: null, stable: null, untested: null, checked_at: NOW() - 60,
  reboot_required: false, source: "upgrade", stale: false };
const EMPTY_FAILURE = { state: "failed", ok: false, started_at: NOW() - 90, finished_at: NOW() - 80,
  error: "ai-packages upgrade failed (exit code 1): no output", triggered_by: "ops" };

// options.world: the server's answers, mutable by the test; onPost: the answer
// to a POST; opsDelay: latency of the Ops window; graceMs: start grace period.
function open({ world, onPost = null, opsDelay = 5, graceMs = 15000, url = "/ops" } = {}) {
  const state = world || { ops: opsView({}) };
  const posts = [];
  const bodies = [];
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error) => errors.push(error.message));
  const source = PAGE.replace("const START_GRACE_MS = 15000;", `const START_GRACE_MS = ${graceMs};`);
  const dom = new JSDOM(source, { url: "https://dashboard.test" + url, runScripts: "dangerously",
    pretendToBeVisual: true, virtualConsole,
    beforeParse(window) {
      window.Telegram = { WebApp: { initData: "signed", ready() {}, expand() {}, openLink() {},
        BackButton: { show() {}, hide() {}, onClick() {} } } };
      window.setInterval = () => 0;  // polls are driven by the test: refresh()
      window.fetch = async (api, init) => {
        if (init && init.method === "POST") {
          posts.push(api);
          bodies.push(JSON.parse(init.body));
          if (onPost) return onPost(api, init);
          return { ok: true, status: 202, json: async () => ({ started: JSON.parse(init.body).action }) };
        }
        const name = api.split("/").pop();
        await sleep(name === "ops" ? opsDelay : 5);
        return { ok: true, status: 200, json: async () => (name === "ops" ? state.ops : LAUNCHER) };
      };
    } });
  const doc = dom.window.document;
  const page = {
    dom, doc, errors, posts, bodies, world: state,
    poll: async () => { await dom.window.eval("refresh()"); await sleep(20); },
    navigate: (to) => dom.window.eval(`navigate('${to}')`),
    text: (id) => doc.getElementById(id).textContent,
    confirm: (answer) => {
      const asked = [];
      dom.window.Telegram.WebApp.showConfirm = (message, callback) => { asked.push(message); callback(answer); };
      return asked;
    },
  };
  return page;
}

const updatesCard = (page) => [...page.doc.querySelectorAll("main section")]
  .find((node) => node.querySelector("h2") && node.querySelector("h2").textContent === "Updates");
const buttons = (page) => [...updatesCard(page).querySelectorAll("button")]
  .map((button) => [button.textContent, button.disabled]);
const cardText = (page) => updatesCard(page).textContent;
const upgradeButton = (page) => [...updatesCard(page).querySelectorAll("button")].find((b) => /^Upgrade/.test(b.textContent));
const checkButton = (page) => [...updatesCard(page).querySelectorAll("button")].find((b) => /Check|Starting|Checking/.test(b.textContent));

async function settle(page) {
  await sleep(60);
  assert.deepStrictEqual(page.errors, []);
}

test("cached counts after a failed upgrade are shown as cached and offer no upgrade", async (t) => {
  const page = open({ world: { ops: opsView({ report: CACHED, last_upgrade: EMPTY_FAILURE }) } });
  t.after(() => page.dom.window.close());
  await settle(page);
  assert.match(cardText(page), /Available \(cached\)9/);
  assert.match(cardText(page), /Checked10h 0m ago/);
  assert.match(cardText(page), /Cached: not verified since the last upgrade/);
  assert.match(cardText(page), /Last upgradefailedai-packages upgrade failed \(exit code 1\): no output/);
  assert.deepStrictEqual(buttons(page), [["Check for updates", false]]);
});

test("counts verified after a partial failure offer a retry, after the owner confirms", async (t) => {
  const partial = { ...EMPTY_FAILURE, error: "ai-packages upgrade failed (exit code 1): dpkg broke",
    diagnostics: ["E: dpkg was interrupted"] };
  const page = open({ world: { ops: opsView({ report: VERIFIED, last_upgrade: partial }) } });
  t.after(() => page.dom.window.close());
  await settle(page);
  assert.match(cardText(page), /Available4/);
  assert.match(cardText(page), /Verified1m ago/);
  assert.match(cardText(page), /Last output: E: dpkg was interrupted/);
  assert.deepStrictEqual(buttons(page), [["Check for updates", false], ["Upgrade 4 packages", false]]);
  let asked = page.confirm(false);
  upgradeButton(page).click();
  await sleep(40);
  assert.match(asked[0], /Upgrade 4 packages\?/);
  assert.deepStrictEqual(page.posts, []);
  asked = page.confirm(true);
  upgradeButton(page).click();
  await sleep(40);
  assert.deepStrictEqual(page.posts, ["/api/ops/packages"]);
  assert.deepStrictEqual(page.bodies, [{ action: "upgrade" }]);
});

test("an unknown outcome says so and blocks any upgrade until a check settles it", async (t) => {
  const unknown = { state: "unknown", ok: null, started_at: NOW() - 90,
    error: "Outcome unknown: ai-packages upgrade timed out after 1020 s. It may still be running; check for updates before upgrading." };
  const page = open({ world: { ops: opsView({ report: CACHED, last_upgrade: unknown,
    upgrade_blocked: "the last upgrade's outcome is unknown; check for updates first" }) } });
  t.after(() => page.dom.window.close());
  await settle(page);
  assert.match(cardText(page), /Last upgradeoutcome unknown/);
  assert.match(cardText(page), /It may still be running/);
  assert.deepStrictEqual(buttons(page), [["Check for updates", false]]);
});

test("a start stays locked across polls until the server reports the run", async (t) => {
  const page = open({ onPost: async () => { await sleep(120); return { ok: true, status: 202, json: async () => ({}) }; } });
  t.after(() => page.dom.window.close());
  await settle(page);
  checkButton(page).click();
  await sleep(5);
  assert.deepStrictEqual(buttons(page), [["Starting…", true]]);
  await page.poll();  // a poll asked before the server heard of the start
  assert.deepStrictEqual(buttons(page), [["Starting…", true]]);
  await sleep(150);  // the answer arrived and the card was refreshed
  assert.deepStrictEqual(buttons(page), [["Starting…", true]]);
  page.world.ops = opsView({ running: "check", report: CACHED });
  await page.poll();
  assert.deepStrictEqual(buttons(page), [["Checking…", true]]);
  page.world.ops = opsView({ report: CACHED });
  await page.poll();
  assert.deepStrictEqual(buttons(page), [["Check for updates", false]]);
  assert.deepStrictEqual(page.posts, ["/api/ops/packages"]);
});

test("a second tap while the confirmation is open asks once and posts once", async (t) => {
  const page = open({ world: { ops: opsView({ report: VERIFIED }) } });
  t.after(() => page.dom.window.close());
  await settle(page);
  const held = [];
  const asked = [];
  page.dom.window.Telegram.WebApp.showConfirm = (message, callback) => { asked.push(message); held.push(callback); };
  const button = upgradeButton(page);
  button.click();
  button.click();  // the same button, before the confirmation is answered
  assert.equal(asked.length, 1);
  held[0](true);
  button.click();  // answered: the start is locked now, even on an old node
  await sleep(40);
  assert.equal(asked.length, 1);
  assert.deepStrictEqual(page.posts, ["/api/ops/packages"]);
});

test("leaving the window during a start keeps the card locked when the owner returns", async (t) => {
  const page = open({ world: { ops: opsView({ report: CACHED }) },
    onPost: async () => { await sleep(200); return { ok: true, status: 202, json: async () => ({}) }; } });
  t.after(() => page.dom.window.close());
  await settle(page);
  checkButton(page).click();
  await sleep(10);
  page.navigate("/");
  await sleep(300);  // the start answered while another window was showing
  page.navigate("/ops");
  await sleep(60);
  assert.deepStrictEqual(buttons(page), [["Starting…", true]]);
  page.world.ops = opsView({ running: "check", report: CACHED });
  await page.poll();
  assert.deepStrictEqual(buttons(page), [["Checking…", true]]);
  assert.deepStrictEqual(page.posts, ["/api/ops/packages"]);
});

test("a start the server never reports is released after the grace period", async (t) => {
  const page = open({ graceMs: 60, world: { ops: opsView({ report: CACHED }) } });
  t.after(() => page.dom.window.close());
  await settle(page);
  checkButton(page).click();
  await sleep(10);
  assert.deepStrictEqual(buttons(page), [["Starting…", true]]);
  await sleep(120);
  await page.poll();
  assert.deepStrictEqual(buttons(page), [["Check for updates", false]]);
});

test("a refused upgrade says why and unlocks the card", async (t) => {
  const page = open({ world: { ops: opsView({ report: VERIFIED }) },
    onPost: async () => ({ ok: false, status: 409, json: async () => ({ error: "a package run is already active" }) }) });
  t.after(() => page.dom.window.close());
  await settle(page);
  page.confirm(true);
  upgradeButton(page).click();
  await sleep(60);
  assert.equal(page.text("alert"), "Package upgrade did not start: a package run is already active");
  assert.deepStrictEqual(buttons(page), [["Check for updates", false], ["Upgrade 4 packages", false]]);
});

test("an answer for the Ops window that arrives after leaving it is not shown", async (t) => {
  const page = open({ opsDelay: 300, world: { ops: opsView({ report: CACHED }) } });
  t.after(() => page.dom.window.close());
  await sleep(10);
  page.navigate("/");
  await sleep(400);
  assert.deepStrictEqual(page.errors, []);
  assert.equal(updatesCard(page), undefined);
  assert.match(page.doc.querySelector("main").textContent, /Ops agent/);
});
