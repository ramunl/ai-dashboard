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
function open({ world, onPost = null, opsDelay = 5, graceMs = 15000, timeoutMs = 15000, url = "/ops" } = {}) {
  const state = world || { ops: opsView({}) };
  const posts = [];
  const bodies = [];
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error) => errors.push(error.message));
  const source = PAGE.replace("const START_GRACE_MS = 15000;", `const START_GRACE_MS = ${graceMs};`).replace("const FETCH_TIMEOUT_MS = 15000;", `const FETCH_TIMEOUT_MS = ${timeoutMs};`);
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

test("evidence: confirmed upgrade posts successfully but must explain the unchanged result", async (t) => {
  const report = { ...VERIFIED, total: 1, checked_at: 1793013908.119061 };
  const page = open({ world: { ops: opsView({ report }) } });
  t.after(() => page.dom.window.close());
  await settle(page);
  page.confirm(true);
  upgradeButton(page).click();
  await sleep(40);
  assert.deepStrictEqual(page.posts, ["/api/ops/packages"]);
  assert.deepStrictEqual(page.bodies, [{ action: "upgrade" }]);
  page.world.ops = opsView({ report, last_upgrade: { ok: true, upgraded: 0, remaining: 1, finished_at: 1793013908.119061 } });
  await page.poll();
  assert.deepStrictEqual(page.errors, []);
  assert.match(cardText(page), /0 upgraded/);
  assert.match(cardText(page), /Reason unavailable/);
  assert.match(cardText(page), /Package details unavailable/);
});

test("a fast completed run clears Starting even when no poll saw it running", async (t) => {
  const page = open({ world: { ops: opsView({ report: VERIFIED }) } });
  t.after(() => page.dom.window.close());
  await settle(page);
  page.confirm(true);
  upgradeButton(page).click();
  await sleep(30);
  page.world.ops = opsView({ report: VERIFIED, last_upgrade: { ok: true, upgraded: 0,
    finished_at: NOW(), unchanged_reason: "fixture: package held", package_results: [
      { name: "curl", installed_version: "1", candidate_version: "2", outcome: "unchanged", reason: "fixture: held" },
    ] } });
  await page.poll();
  assert.doesNotMatch(cardText(page), /Starting/);
  assert.match(cardText(page), /fixture: package held/);
  assert.match(cardText(page), /curl1 → 2 · unchanged · fixture: held/);
});

for (const failure of ["non-ok", "timeout"]) {
  test(`${failure} start error remains visible after polling`, async (t) => {
    const page = open({ world: { ops: opsView({ report: VERIFIED }) }, timeoutMs: 20, onPost: async (_api, init) => {
      if (failure === "timeout") return new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted"))));
      return { ok: false, status: 409, json: async () => ({ error: "server refused upgrade" }) };
    } });
    t.after(() => page.dom.window.close());
    await settle(page);
    page.confirm(true);
    upgradeButton(page).click();
    await sleep(40);
    await page.poll();
    assert.match(cardText(page), failure === "timeout" ? /no answer within 0.02 s/ : /server refused upgrade/);
    assert.deepStrictEqual(page.errors, []);
  });
}

test("remaining packages and all per-package outcomes render as text", async (t) => {
  const page = open({ world: { ops: opsView({ report: { ...VERIFIED,
    packages: [{ name: "<img src=x>", installed_version: "1", candidate_version: "2" }] },
    last_upgrade: { ok: false, error: "fixture failure", package_results: [
      { name: "a", outcome: "upgraded" }, { name: "b", outcome: "unchanged", reason: "fixture reason" },
      { name: "c", outcome: "failed", reason: "fixture error" },
    ] } }) } });
  t.after(() => page.dom.window.close());
  await settle(page);
  assert.match(cardText(page), /<img src=x>1 → 2/);
  assert.equal(updatesCard(page).querySelector("img"), null);
  assert.match(cardText(page), /aupgradedbunchanged · fixture reasoncfailed · fixture error/);
});

test("server upgrade timeout remains visible as an unknown outcome", async (t) => {
  const page = open({ world: { ops: opsView({ report: VERIFIED, last_upgrade: {
    state: "unknown", ok: null, error: "Outcome unknown: ai-packages upgrade timed out after 1020 s. It may still be running; check for updates before upgrading."
  } }) } });
  t.after(() => page.dom.window.close());
  await settle(page);
  assert.match(cardText(page), /outcome unknown/);
  assert.match(cardText(page), /ai-packages upgrade timed out after 1020 s/);
});

test("last known names stay on the card, marked, when the latest run listed only counts", async (t) => {
  const report = { ...VERIFIED, total: 1, details_stale: true,
    packages: [{ name: "curl", installed_version: "1", candidate_version: "2" }] };
  const page = open({ world: { ops: opsView({ report }) } });
  t.after(() => page.dom.window.close());
  await settle(page);
  assert.match(cardText(page), /Last known list/);
  assert.match(cardText(page), /curl1 → 2/);
});

test("a pending POST stays locked beyond the display grace period", async (t) => {
  let release;
  const page = open({ graceMs: 10, world: { ops: opsView({ report: VERIFIED }) },
    onPost: () => new Promise(resolve => { release = resolve; }) });
  t.after(() => page.dom.window.close());
  await settle(page);
  page.confirm(true);
  upgradeButton(page).click();
  await sleep(30);
  await page.poll();
  assert.equal(upgradeButton(page), undefined); // its label is Starting…
  assert.deepStrictEqual(buttons(page), [["Check for updates", true], ["Starting…", true]]);
  release({ ok: true, status: 202, json: async () => ({ started: "upgrade" }) });
  await sleep(30);
  assert.equal(page.posts.length, 1);
});
