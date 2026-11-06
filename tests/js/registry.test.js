const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

// The DS05 registry is read by registry.js and rendered by the Coding AI tools,
// Tasks and Limits views. The full page is loaded (as in the browser) so the
// script-level constants in registry.js are visible to every view, and each
// card can be exercised through its real entry point rather than a stub.
const root = path.join(__dirname, "../../ai_dashboard/static");
const source = fs.readFileSync(path.join(root, "index.html"), "utf8")
  .replace('<script src="/static/vendor/telegram-web-app.js"></script>', "")
  .replace(/<script src="\/static\/(.+?)"><\/script>/g, (_, file) =>
    `<script>${fs.readFileSync(path.join(root, file), "utf8")}</script>`);
const tick = () => new Promise(resolve => setTimeout(resolve, 20));

function registrySnapshot() {
  return {
    format: 2,
    updated_at: 1793132265,
    registry: {
      format: 1,
      roles: {
        planner: { tool: "codex", options: ["codex", "gpt"] },
        implementer: { tool: "gpt", options: ["gpt", "codex"] },
      },
      tools: {
        codex: { label: "Codex", provider: "openai", model: "default",
          models: ["default"], manageable: true, note: null, models_error: null },
        gpt: { label: "GPT", provider: "openai", model: "gpt-4",
          models: ["gpt-4"], manageable: false, note: "Set in GPT config.", models_error: null },
      },
      providers: {
        openai: { label: "OpenAI", kind: "subscription", limits: "openai" },
        anthropic: { label: "Anthropic", kind: "api", limits: "anthropic" },
      },
    },
  };
}

async function open(t, path = "/coding") {
  const dom = new JSDOM(source, {
    url: `https://dashboard.test${path}`, runScripts: "dangerously", pretendToBeVisual: true,
    beforeParse(w) {
      w.Telegram = { WebApp: { initData: "signed", ready() {}, expand() {},
        showConfirm() {}, BackButton: { show() {}, hide() {}, onClick() {} } } };
      w.fetch = async () => ({ ok: true, json: async () => ({ snapshot: null }) });
      w.setInterval = () => 0;
    },
  });
  t.after(() => dom.window.close());
  await tick();
  return dom.window;
}

function render(w, ...nodes) {
  w.document.querySelector("main").replaceChildren(...nodes);
  return w.document.querySelector("main").textContent;
}

// Objects built inside the jsdom window live in another realm, so strip their
// prototypes before a strict deep comparison against Node-side fixtures.
const plain = (value) => JSON.parse(JSON.stringify(value));

test("registry validation accepts the DS05 shape and rejects malformed data", async t => {
  const w = await open(t);
  const registry = registrySnapshot().registry;
  assert.deepEqual(w.codingRegistry(registrySnapshot()), registry);
  const cases = [
    null, {}, "registry",
    { ...registry, format: "1" },
    { ...registry, format: 2 },
    { ...registry, tools: { ...registry.tools, gpt: { ...registry.tools.gpt, manageable: "no" } } },
    { ...registry, tools: { ...registry.tools, gpt: { ...registry.tools.gpt, model: "../x" } } },
    { ...registry, tools: { ...registry.tools, "bad id": registry.tools.codex } },
    { ...registry, roles: { ...registry.roles, planner: { tool: "gpt", options: [] } } },
    { ...registry, roles: { ...registry.roles, implementer: { tool: "gpt", options: ["gpt", "missing"] } } },
  ];
  for (const value of cases) {
    assert.equal(w.codingRegistry({ registry: value }), null, JSON.stringify(value));
  }
});

test("codingToolsModel normalizes a registry and falls back to legacy setup", async t => {
  const w = await open(t);
  const model = w.codingToolsModel(registrySnapshot());
  assert.equal(model.registry, true);
  assert.equal(model.roles.planner.current, "codex");
  assert.equal(model.roles.planner.tool, "codex");
  assert.deepEqual(plain(model.roles.planner.options), [
    { value: "codex", label: "Codex" }, { value: "gpt", label: "GPT" },
  ]);
  assert.equal(model.roles.implementer.current, "gpt");
  assert.deepEqual(plain(model.tools.codex), {
    tool: "codex", label: "Codex", provider: "openai", model: "default",
    models: ["default"], manageable: true, note: "", modelsError: null,
  });
  assert.equal(model.tools.gpt.manageable, false);
  assert.equal(model.tools.gpt.note, "Set in GPT config.");

  const legacy = w.codingToolsModel({
    format: 2,
    setup: { planner: "claude", implementer: "codex",
      models: [{ tool: "claude", model: "claude-x", manageable: true, choices: ["claude-y"] }] },
  });
  assert.equal(legacy.registry, false);
  assert.equal(legacy.roles.planner.current, "claude");
  assert.equal(legacy.roles.planner.tool, "claude");
  assert.equal(legacy.tools.claude.label, "Claude API");
});

test("codingRegistryProviders returns limit rows and falls back on malformed data", async t => {
  const w = await open(t);
  assert.deepEqual(plain(w.codingRegistryProviders(registrySnapshot().registry)), [
    { id: "openai", label: "OpenAI", kind: "subscription", limits: "openai" },
    { id: "anthropic", label: "Anthropic", kind: "api", limits: "anthropic" },
  ]);
  assert.equal(w.codingRegistryProviders(null), null);
  assert.equal(w.codingRegistryProviders({ providers: { bad: { label: "", kind: "x", limits: "y" } } }), null);
});

test("AI tools render registry roles and per-tool model controls", async t => {
  const w = await open(t, "/coding/ai");
  const snapshot = registrySnapshot();
  const page = w.aiToolsPage({ snapshot, problem: null });
  const text = render(w, ...page.nodes);
  assert.match(text, /Codex · planner/);
  assert.match(text, /GPT · implementer/);
  assert.match(text, /CLI default/);
  assert.match(text, /Set in GPT config/);
  // The planner's radios come from the registry options, with its labels.
  const planner = [...w.document.querySelectorAll('input[name="planner"]')].map(r => r.value);
  assert.deepEqual(planner, ["codex", "gpt"]);
  // No provider name is hard-coded: only the registry's labels are shown.
  assert.doesNotMatch(text, /OpenAI/);
});

test("tasks retry and resume pick the registry implementer options", async t => {
  const w = await open(t, "/tasks");
  const model = w.codingToolsModel(registrySnapshot());
  w.eval(`taskTools = ${JSON.stringify(model)}`);
  assert.deepEqual(plain(w.retryChoices(true)),
    [{ id: "gpt", label: "GPT" }, { id: "codex", label: "Codex" }]);
  assert.deepEqual(plain(w.retryChoices(false)),
    [{ id: "codex", label: "Codex" }, { id: "gpt", label: "GPT" }]);
  // A legacy snapshot keeps the old codex/claude pair and order.
  w.eval("taskTools = null");
  assert.deepEqual(plain(w.retryChoices(true)),
    [{ id: "codex", label: "Codex" }, { id: "claude", label: "Claude" }]);
  assert.deepEqual(plain(w.retryChoices(false)),
    [{ id: "claude", label: "Claude" }, { id: "codex", label: "Codex" }]);
});

test("limits render registry providers and keep API funds out of quota", async t => {
  const w = await open(t);
  const snapshot = registrySnapshot();
  const limits = {
    openai: { status: "ok", checked_at: 1793132265, windows: [
      { bucket: "OpenAI", remaining_percent: 72, window_minutes: 10080, resets_at: 1800100000 },
    ] },
    anthropic: { status: "ok", checked_at: 1793132265,
      balance: { amount: 1.5, currency: "USD", checked_at: 1793132265 },
      windows: [] },
  };
  const text = render(w, w.limitsCard(limits, snapshot.registry));
  assert.match(text, /OpenAI/);
  assert.match(text, /Weekly/);
  assert.match(text, /72% remaining/);
  assert.match(text, /Anthropic/);
  assert.match(text, /API balance/);
  assert.match(text, /1\.50 USD/);
  // The API balance is money, never drawn as a quota meter.
  assert.equal(w.document.querySelectorAll("progress").length, 1);
  // A malformed or missing registry keeps the legacy provider rows.
  const legacy = render(w, w.limitsCard(limits, null));
  assert.match(legacy, /Codex/);
  assert.match(legacy, /Claude Code/);
  assert.match(legacy, /Claude API/);
});
