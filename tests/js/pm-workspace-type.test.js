// Page tests for the PM todo type: row icons beside priority, the editor's Type
// select, and the add/update payloads (pm-workspace.js, pm-toolbar.js).
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM, VirtualConsole } = require("jsdom");

const STATIC = path.join(__dirname, "../../ai_dashboard/static");
const PAGE = fs.readFileSync(path.join(STATIC, "index.html"), "utf8")
  .replace('<script src="/static/vendor/telegram-web-app.js"></script>', "")
  .replace('<link rel="stylesheet" href="/static/styles.css">', "")
  .replace(/<script src="\/static\/(.+?)"><\/script>/g, (_tag, file) => `<script>${fs.readFileSync(path.join(STATIC, file), "utf8")}</script>`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const PM = { agent: "pm", service: "active", problem: null, age_seconds: 1, snapshot: {
  format: 1, active_project: "app", todos: null, projects: [], rules: [], version: "v", core: "c" } };
const WORKSPACE = {
  project: "app", active_project: "app", revision: "r1",
  projects: [{ name: "app", open: 4, done: 0 }],
  items: [
    { id: "a".repeat(32), text: "Typed bug", priority: "high", type: "bug", status: "open", index: 0 },
    { id: "b".repeat(32), text: "Typed notice", priority: "normal", type: "notice", status: "open", index: 1 },
    { id: "c".repeat(32), text: "Untyped", priority: "low", status: "open", index: 2 },
    { id: "d".repeat(32), text: "Unknown value", priority: "low", type: "epic", status: "open", index: 3 },
    { id: "e".repeat(32), text: "Proto value", priority: "low", type: "__proto__", status: "open", index: 4 },
    { id: "f".repeat(32), text: "Injected", priority: "low", type: '<img src=x onerror="alert(1)">', status: "open", index: 5 },
  ],
};

async function openPm(state) {
  const bodies = [];
  const virtualConsole = new VirtualConsole();
  const errors = [];
  virtualConsole.on("jsdomError", (error) => errors.push(error.message));
  const dom = new JSDOM(PAGE, {
    url: "https://dashboard.test/pm", runScripts: "dangerously", pretendToBeVisual: true, virtualConsole,
    beforeParse(window) {
      window.Telegram = { WebApp: { initData: "signed", ready() {}, expand() {}, openLink() {},
        BackButton: { show() {}, hide() {}, onClick() {} } } };
      window.fetch = async (_api, init) => {
        if (init && init.method === "POST") {
          const body = JSON.parse(init.body);
          bodies.push(body);
          return { ok: true, status: 200, json: async () => ({ ok: true, workspace: state.workspace }) };
        }
        return { ok: true, status: 200, json: async () => ({ ...PM, editing: { ok: true, workspace: state.workspace } }) };
      };
      window.setInterval = () => 0;
    },
  });
  await sleep(40);
  const doc = dom.window.document;
  const select = (label) => [...doc.querySelectorAll("label")].find((l) => l.querySelector("span").textContent === label).querySelector("select");
  const button = (text) => [...doc.querySelectorAll("button")].find((b) => b.textContent === text);
  const choose = (node, value) => {
    node.value = value;
    node.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  };
  const save = () => doc.querySelector("form").dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
  return {
    dom, doc, bodies, errors, select, button, choose, save,
    row: (title) => [...doc.querySelectorAll(".pm-task")].find((r) => r.querySelector(".pm-task-title").textContent === title),
    open: (title) => { button(title).click(); },
    options: (label) => [...select(label).options].map((o) => [o.value, o.textContent]),
  };
}

test("rows show accessible type icons beside priority, with a neutral fallback", async (t) => {
  const page = await openPm({ workspace: WORKSPACE });
  t.after(() => page.dom.window.close());
  const typeOf = (title) => {
    const type = page.row(title).querySelector(".pm-type");
    assert.strictEqual(type.getAttribute("role"), "img");
    assert.strictEqual(type.title, type.getAttribute("aria-label"));
    return [type.textContent, type.dataset.type, type.previousElementSibling.classList.contains("pm-priority"), type.getAttribute("aria-label")];
  };
  assert.deepStrictEqual(typeOf("Typed bug"), ["🐞", "bug", true, "Bug"]);
  assert.deepStrictEqual(typeOf("Typed notice"), ["ℹ️", "notice", true, "Notice"]);
  assert.deepStrictEqual(typeOf("Untyped"), ["?", "unknown", true, "Unknown type"]);
  assert.deepStrictEqual(typeOf("Unknown value"), ["?", "unknown", true, "Unknown type"]);
  assert.deepStrictEqual(typeOf("Proto value"), ["?", "unknown", true, "Unknown type"]);
  assert.deepStrictEqual(typeOf("Injected"), ["?", "unknown", true, "Unknown type"]);
  const feature = page.dom.window.pmTaskRow({ id: "g".repeat(32), text: "Feature example", priority: "normal", type: "feature", status: "open" }).querySelector(".pm-type");
  assert.strictEqual(feature.textContent, "✨");
  assert.strictEqual(feature.getAttribute("aria-label"), "Feature");
  assert.strictEqual(page.doc.querySelector(".pm-task-list img"), null);
  assert.deepStrictEqual(page.errors, []);
});

test("an untyped todo shows Unset and saving it sends no type", async (t) => {
  const page = await openPm({ workspace: WORKSPACE });
  t.after(() => page.dom.window.close());
  page.open("Untyped");
  assert.deepStrictEqual(page.options("Type"), [["", "Unset"], ["feature", "Feature"], ["bug", "Bug"], ["notice", "Notice"]]);
  assert.strictEqual(page.select("Type").value, "");
  page.save();
  await sleep(20);
  assert.strictEqual(page.bodies.length, 1);
  assert.strictEqual("type" in page.bodies[0], false);
  assert.deepStrictEqual(page.bodies[0], { action: "update", id: "c".repeat(32), project: "app", revision: "r1", text: "Untyped", priority: "low", status: "open" });
});

test("choosing a type sends it in the update payload", async (t) => {
  const page = await openPm({ workspace: WORKSPACE });
  t.after(() => page.dom.window.close());
  page.open("Untyped");
  page.choose(page.select("Type"), "bug");
  page.save();
  await sleep(20);
  assert.strictEqual(page.bodies[0].type, "bug");
  assert.deepStrictEqual(page.errors, []);
});

test("an unknown stored type stays selected and is sent back unchanged", async (t) => {
  const page = await openPm({ workspace: WORKSPACE });
  t.after(() => page.dom.window.close());
  page.open("Unknown value");
  assert.strictEqual(page.select("Type").value, "epic");
  assert.deepStrictEqual(page.options("Type").at(-1), ["epic", "Unknown type"]);
  page.save();
  await sleep(20);
  assert.strictEqual(page.bodies[0].type, "epic");
});

test("a proto-named unknown type is preserved like any other unknown value", async (t) => {
  const page = await openPm({ workspace: WORKSPACE });
  t.after(() => page.dom.window.close());
  page.open("Proto value");
  assert.strictEqual(page.select("Type").value, "__proto__");
  page.save();
  await sleep(20);
  assert.strictEqual(page.bodies[0].type, "__proto__");
});

test("add with details defaults to Feature and sends it", async (t) => {
  const page = await openPm({ workspace: WORKSPACE });
  t.after(() => page.dom.window.close());
  page.button("Add with details").click();
  assert.strictEqual(page.select("Type").value, "feature");
  const text = page.doc.querySelector("textarea");
  text.value = "Write notes";
  text.dispatchEvent(new page.dom.window.Event("input", { bubbles: true }));
  page.save();
  await sleep(20);
  assert.strictEqual(page.bodies[0].action, "add");
  assert.strictEqual(page.bodies[0].type, "feature");
  assert.deepStrictEqual(page.errors, []);
});
