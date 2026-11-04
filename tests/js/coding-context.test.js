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
const tick = () => new Promise(resolve => setTimeout(resolve, 20));

const base = {
  project: { name: "repo", repository: "ramunl/repo", branch: "main" },
  setup: { projects: [{ name: "repo", active: true }], models: [],
    planner: "codex", implementer: "claude", actions: [] },
  running: null,
  queue: [],
  planning_agent: "codex",
  implementation_agent: "claude",
  verbosity: "normal",
  limits: null,
  version: "1",
  core: "2",
};

const initiative = (over = {}) => ({
  id: "5a9c68fe",
  health: "ok",
  freshness: "fresh",
  age_seconds: 3600,
  omissions: 0,
  truncations: 1,
  packets: [{ packet_id: "p1", sha256: "a".repeat(64) }],
  blockers: ["dependency:repo:ramunl/ai-dashboard"],
  decision: { code: "dependency:repo:ramunl/ai-dashboard", revision: 2 },
  ...over,
});

async function page(t, snapshot = {}) {
  const state = { posts: [], confirmations: [], actions: [],
    snapshot: structuredClone({ ...base, ...snapshot }),
    post: async () => ({ id: "request1" }) };
  const dom = new JSDOM(source, {
    url: "https://dashboard.test/coding", runScripts: "dangerously", pretendToBeVisual: true,
    beforeParse(w) {
      w.Telegram = { WebApp: { initData: "signed", ready() {}, expand() {},
        showConfirm(message, callback) { state.confirmations.push({ message, callback }); },
        BackButton: { show() {}, hide() {}, onClick() {} } } };
      w.fetch = async (url, init) => {
        if (init.method === "POST") {
          state.posts.push(JSON.parse(init.body));
          const answer = await state.post(init);
          return { ok: true, json: async () => answer };
        }
        if (state.get) return state.get(url, init);
        return { ok: true, json: async () => ({ snapshot: state.snapshot }) };
      };
    },
  });
  t.after(() => dom.window.close());
  state.w = dom.window;
  state.buttons = () => [...dom.window.document.querySelectorAll("button")];
  state.button = label => state.buttons().find(b => b.textContent === label);
  state.refresh = async () => { await dom.window.refresh(); await tick(); };
  await tick();
  return state;
}

test("context card renders health, freshness, age, counts, packets and blockers", async t => {
  const p = await page(t, { initiatives: [initiative()] });
  const card = [...p.w.document.querySelectorAll("section")]
    .find(s => s.querySelector("h2") && s.querySelector("h2").textContent === "Context");
  assert.ok(card);
  assert.match(card.textContent, /5a9c68fe/);
  assert.match(card.textContent, /Healthy/);
  assert.match(card.textContent, /freshness fresh/);
  assert.match(card.textContent, /age 1h 0m/);
  assert.match(card.textContent, /1 truncated/);
  assert.match(card.textContent, /packet p1/);
  assert.match(card.textContent, /sha256 a{64}/);
  assert.match(card.textContent, /Blocked by: dependency:repo:ramunl\/ai-dashboard/);
});

test("initiative fields are HTML-escaped, never injected", async t => {
  const attack = '<img src=x onerror="globalThis.pwned=1">';
  const p = await page(t, { initiatives: [initiative({
    freshness: attack, packets: [{ packet_id: attack, sha256: attack }], blockers: [attack],
  })] });
  const card = [...p.w.document.querySelectorAll("section")]
    .find(s => s.querySelector("h2") && s.querySelector("h2").textContent === "Context");
  assert.ok(card);
  assert.ok(!card.querySelector("img"));
  assert.ok(!card.innerHTML.includes("<img"));
  assert.equal(p.w.eval("globalThis.pwned"), undefined);
  assert.ok(card.textContent.includes(attack));
});

test("old snapshots degrade to an empty card; unknown health stays unknown", async t => {
  const p = await page(t, {});
  assert.match(p.w.document.body.textContent, /No context published yet/);
  p.snapshot.initiatives = [initiative({ health: "unknown", freshness: undefined,
    age_seconds: undefined, packets: [], blockers: [] })];
  await p.refresh();
  assert.match(p.w.document.body.textContent, /Unknown/);
  assert.match(p.w.document.body.textContent, /age unknown/);
});

test("context_recovery_pending surfaces a warning line", async t => {
  const p = await page(t, { context_recovery_pending: true, initiatives: [initiative()] });
  assert.match(p.w.document.body.textContent, /Context recovery/);
  assert.match(p.w.document.body.textContent, /pending context recovery/);
});

test("inspect and link queue envelopes after confirmation", async t => {
  const p = await page(t, { initiatives: [initiative()] });
  p.button("Inspect").click();
  assert.equal(p.confirmations.length, 1);
  assert.match(p.confirmations[0].message, /uses AI tokens/);
  p.confirmations[0].callback(true);
  await tick();
  assert.deepEqual(p.posts, [{ action: "context_inspect_v1",
    args: { scope: "initiative", kind: "evidence", id: "5a9c68fe" } }]);
  // The agent settles the inspect request, so Link is available again.
  p.snapshot.setup.actions = [{ id: "request1", status: "done", message: "ok" }];
  await p.refresh();
  p.posts.length = 0;
  p.button("Link").click();
  p.confirmations[1].callback(true);
  await tick();
  assert.deepEqual(p.posts, [{ action: "context_link_v1",
    args: { scope: "initiative", kind: "packet", id: "5a9c68fe" } }]);
});

test("approve opens a revision input seeded with the published revision", async t => {
  const p = await page(t, { initiatives: [initiative()] });
  p.button("Approve").click();
  await tick();
  const input = p.w.document.querySelector('input[aria-label="Decision revision"]');
  assert.ok(input);
  assert.equal(input.value, "2");
  p.button("Send approve").click();
  assert.equal(p.confirmations.length, 1);
  assert.match(p.confirmations[0].message, /Approve decision dependency:repo:ramunl\/ai-dashboard at revision 2/);
  p.confirmations[0].callback(true);
  await tick(); await p.refresh();
  assert.deepEqual(p.posts, [{ action: "context_approve_v1",
    args: { scope: "initiative", id: "5a9c68fe",
      decision: "dependency:repo:ramunl/ai-dashboard", revision: "2" } }]);
});

test("reject uses the revision the owner typed", async t => {
  const p = await page(t, { initiatives: [initiative()] });
  p.button("Reject").click();
  await tick();
  const input = p.w.document.querySelector('input[aria-label="Decision revision"]');
  input.value = "7";
  input.dispatchEvent(new p.w.Event("input", { bubbles: true }));
  p.button("Send reject").click();
  assert.match(p.confirmations[0].message, /Reject decision .* at revision 7/);
  p.confirmations[0].callback(true);
  await tick();
  assert.deepEqual(p.posts, [{ action: "context_reject_v1",
    args: { scope: "initiative", id: "5a9c68fe",
      decision: "dependency:repo:ramunl/ai-dashboard", revision: "7" } }]);
});

test("a slow context submit shows pending, then times out when the agent never settles", async t => {
  const p = await page(t, { initiatives: [initiative()] });
  let resolve;
  p.post = () => new Promise(r => { resolve = r; });
  p.button("Inspect").click();
  p.confirmations[0].callback(true);
  await tick();
  assert.ok(p.button("Sending…").disabled);
  resolve({ id: "slow" });
  await tick();
  p.w.eval('pendingActions.get("slow").startedAt = Date.now() - ACTION_TIMEOUT_MS - 1');
  await p.refresh();
  assert.equal(p.w.document.getElementById("alert").textContent, "No answer from the coding agent.");
});

test("navigation cancels an in-flight context confirmation", async t => {
  const p = await page(t, { initiatives: [initiative()] });
  p.button("Approve").click();
  await tick();
  p.button("Send approve").click();
  p.w.navigate("tasks");
  await tick();
  p.confirmations[0].callback(true);
  assert.equal(p.posts.length, 0);
  assert.equal(p.w.location.pathname, "/tasks");
});
