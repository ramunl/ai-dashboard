// Page tests for the PM todo sort bar and drag reorder (pm-workspace.js).
// Sorting is the browser's view only: no request, saved order unchanged.
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

// Array order differs from the saved (index) order on purpose; "old" predates dates.
const WORKSPACE = {
  project: "app", active_project: "app", revision: "r1",
  projects: [{ name: "app", open: 3, done: 1 }, { name: "other", open: 1, done: 0 }],
  items: [
    { id: "b".repeat(32), text: "Second", priority: "high", status: "open", index: 2, created: "2026-10-03T09:00:00Z" },
    { id: "a".repeat(32), text: "First", priority: "low", status: "open", index: 0, created: "2026-10-01T09:00:00Z" },
    { id: "d".repeat(32), text: "Done one", priority: "normal", status: "done", index: 1, created: "2026-10-02T09:00:00Z" },
    { id: "o".repeat(32), text: "Old", priority: "normal", status: "open", index: 3 },
  ],
};
const PM = { agent: "pm", service: "active", problem: null, age_seconds: 1, snapshot: {
  format: 1, active_project: "app", todos: null, projects: [], rules: [], version: "v", core: "c" } };

// state.workspace: what the next poll returns; state.latencyMs: its delay.
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
          const workspace = state.onPost ? state.onPost(body) : state.workspace;
          return { ok: true, status: 200, json: async () => ({ ok: true, workspace }) };
        }
        const workspace = state.workspace;
        await sleep(state.latencyMs || 0);
        return { ok: true, status: 200, json: async () => ({ ...PM, editing: { ok: true, workspace } }) };
      };
      window.setInterval = () => 0;  // polls happen only when a test calls refresh()
    },
  });
  await sleep(40);
  const doc = dom.window.document;
  return {
    dom, doc, bodies, errors,
    titles: () => [...doc.querySelectorAll(".pm-task-title")].map((node) => node.textContent),
    sortButton: (label) => [...doc.querySelectorAll(".todo-sort-button")].find((b) => b.textContent === label),
    pressed: () => doc.querySelector('.todo-sort-button[aria-pressed="true"]').textContent,
    handleOf: (text) => [...doc.querySelectorAll(".pm-task")].find((row) => row.querySelector(".pm-task-title").textContent === text).querySelector(".pm-drag-handle"),
  };
}

test("sort bar orders by Manual, Created and Priority without a request", async () => {
  const page = await openPm({ workspace: WORKSPACE });
  assert.deepStrictEqual([...page.doc.querySelectorAll(".todo-sort-button")].map((b) => b.textContent), ["Manual", "Created", "Priority"]);
  assert.strictEqual(page.pressed(), "Priority");
  assert.deepStrictEqual(page.titles(), ["Second", "Old", "First"]);
  page.sortButton("Manual").click();
  assert.strictEqual(page.pressed(), "Manual");
  assert.deepStrictEqual(page.titles(), ["First", "Second", "Old"]);
  page.sortButton("Created").click();
  assert.deepStrictEqual(page.titles(), ["Second", "First", "Old"]);  // no date: last
  assert.match(page.doc.querySelector(".pm-count").textContent, /newest first/);
  assert.deepStrictEqual(page.bodies, []);
  assert.deepStrictEqual(page.errors, []);
});

test("sorting leaves the saved order unchanged", async () => {
  const page = await openPm({ workspace: WORKSPACE });
  const saved = () => page.dom.window.eval("pmUi.workspace.items.map((item) => item.id).join()");
  const before = saved();
  for (const label of ["Created", "Priority", "Manual"]) page.sortButton(label).click();
  assert.strictEqual(saved(), before);
  assert.strictEqual(before, WORKSPACE.items.map((item) => item.id).join());
});

test("drag handles appear only in Manual, otherwise a hint", async () => {
  const page = await openPm({ workspace: WORKSPACE });
  for (const label of ["Priority", "Created"]) {
    page.sortButton(label).click();
    assert.strictEqual(page.doc.querySelectorAll(".pm-drag-handle").length, 0);
    assert.strictEqual(page.doc.querySelector(".todo-sort-hint").textContent, "Switch to Manual to reorder");
  }
  page.sortButton("Manual").click();
  assert.strictEqual(page.doc.querySelectorAll(".pm-drag-handle").length, 3);
  assert.strictEqual(page.doc.querySelector(".todo-sort-hint"), null);
});

test("reorder sends the snapshot's manual index, not the displayed position", async () => {
  const page = await openPm({ workspace: WORKSPACE });
  page.sortButton("Manual").click();
  // Shown: First, Second, Old (Done one is filtered out). Second is shown 2nd but saved at 2.
  page.handleOf("First").dispatchEvent(new page.dom.window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  await sleep(10);
  assert.deepStrictEqual(page.bodies.pop(), { action: "move", id: "a".repeat(32), project: "app", revision: "r1", index: 2 });

  // Pointer drag of Old onto First.
  const first = [...page.doc.querySelectorAll(".pm-task-title")].find((node) => node.textContent === "First");
  page.doc.elementFromPoint = () => first;
  const handle = page.handleOf("Old");
  for (const type of ["pointerdown", "pointermove", "pointerup"]) {
    handle.dispatchEvent(new page.dom.window.MouseEvent(type, { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));
  }
  await sleep(10);
  assert.deepStrictEqual(page.bodies.pop(), { action: "move", id: "o".repeat(32), project: "app", revision: "r1", index: 0 });
  assert.deepStrictEqual(page.errors, []);
});

test("the chosen mode survives a slow poll and re-sorts the new data", async () => {
  const state = { workspace: WORKSPACE };
  const page = await openPm(state);
  page.sortButton("Created").click();
  const newest = { id: "n".repeat(32), text: "Newest", priority: "low", status: "open", index: 4, created: 1791900000 };
  state.workspace = { ...WORKSPACE, revision: "r2", items: [...WORKSPACE.items, newest] };
  state.latencyMs = 150;
  const poll = page.dom.window.eval("refresh()");
  await sleep(50);
  assert.strictEqual(page.pressed(), "Created");  // still in flight
  await poll;
  await sleep(10);
  assert.strictEqual(page.pressed(), "Created");
  assert.deepStrictEqual(page.titles(), ["Newest", "Second", "First", "Old"]);
});

test("the chosen mode is kept when the active project changes", async () => {
  const other = { ...WORKSPACE, project: "other", active_project: "other", items: [
    { id: "x".repeat(32), text: "Low one", priority: "low", status: "open", index: 0 },
    { id: "y".repeat(32), text: "High one", priority: "high", status: "open", index: 1 },
  ] };
  const page = await openPm({ workspace: WORKSPACE, onPost: () => other });
  page.sortButton("Manual").click();
  const picker = page.doc.querySelector(".pm-project select");
  picker.value = "other";
  picker.dispatchEvent(new page.dom.window.Event("change", { bubbles: true }));
  await sleep(20);
  assert.deepStrictEqual(page.bodies, [{ action: "select", project: "other" }]);
  assert.strictEqual(page.pressed(), "Manual");
  assert.deepStrictEqual(page.titles(), ["Low one", "High one"]);
});

function assertPriorityRows(page, expected) {
  const rows = [...page.doc.querySelectorAll(".pm-task")];
  assert.strictEqual(rows.length, expected.length);
  rows.forEach((row, index) => {
    const [title, key, label] = expected[index];
    assert.strictEqual(row.querySelector(".pm-task-title").textContent, title);
    const priority = row.querySelector(".pm-priority");
    assert.strictEqual(priority.dataset.priority, key);
    assert.strictEqual(priority.textContent, label);
    assert.strictEqual(priority.hasAttribute("aria-hidden"), false);
    assert.strictEqual(priority.querySelector("span:not(.pm-priority-dot)").hasAttribute("aria-hidden"), false);
    const dots = priority.querySelectorAll(".pm-priority-dot");
    assert.strictEqual(dots.length, 1);
    assert.strictEqual(dots[0].getAttribute("aria-hidden"), "true");
    assert.strictEqual(dots[0].textContent, "");
    assert.strictEqual(priority.querySelector("button, input, [tabindex]"), null);
    const checkbox = row.querySelector('input[type="checkbox"]');
    assert.strictEqual(checkbox.getAttribute("aria-label"), `${checkbox.checked ? "Reopen" : "Mark done"}: ${title}`);
    assert.strictEqual(checkbox.disabled, false);
  });
}

test("priority dots and readable labels survive sorting, filtering and polling", async (t) => {
  const state = { workspace: WORKSPACE };
  const page = await openPm(state);
  t.after(() => page.dom.window.close());
  const high = ["Second", "high", "High priority"];
  const low = ["First", "low", "Low priority"];
  const normal = ["Old", "normal", "Normal priority"];
  assertPriorityRows(page, [high, normal, low]);
  for (const [mode, expected] of [
    ["Manual", [low, high, normal]],
    ["Created", [high, low, normal]],
    ["Priority", [high, normal, low]],
  ]) {
    page.sortButton(mode).click();
    assertPriorityRows(page, expected);
  }
  [...page.doc.querySelectorAll("button")].find(b => b.textContent === "Filter").click();
  const filter = page.doc.querySelector(".pm-filter-panel select");
  for (const [key, expected] of [["low", low], ["normal", normal], ["high", high]]) {
    filter.value = key;
    filter.dispatchEvent(new page.dom.window.Event("change", { bubbles: true }));
    assertPriorityRows(page, [expected]);
  }
  filter.value = "all";
  filter.dispatchEvent(new page.dom.window.Event("change", { bubbles: true }));
  const search = page.doc.querySelector('input[type="search"]');
  search.value = "First";
  search.dispatchEvent(new page.dom.window.Event("input", { bubbles: true }));
  assertPriorityRows(page, [low]);
  search.value = "";
  search.dispatchEvent(new page.dom.window.Event("input", { bubbles: true }));
  [...page.doc.querySelectorAll(".pm-switch-button")].find(b => b.textContent === "All").click();
  assertPriorityRows(page, [high, ["Done one", "normal", "Normal priority"], normal, low]);

  // Poll replaces priorities as well as rows while retaining the selected sort.
  state.workspace = { ...WORKSPACE, revision: "r2", items: WORKSPACE.items.map(item =>
    ({ ...item, priority: item.text === "First" ? "high" : "low" })) };
  await page.dom.window.eval("refresh()");
  assertPriorityRows(page, [
    ["First", "high", "High priority"], ["Done one", "low", "Low priority"],
    ["Second", "low", "Low priority"], ["Old", "low", "Low priority"],
  ]);
  assert.deepStrictEqual(page.bodies, []);
  assert.deepStrictEqual(page.errors, []);
});

test("missing and unknown priorities have neutral safe labels", async (t) => {
  const values = [undefined, null, "", "medium", "urgent", "toString", "__proto__", '<img src=x onerror="alert(1)">'];
  const state = { workspace: { ...WORKSPACE, items: values.map((priority, index) =>
    ({ id: String(index), text: `Unknown ${index}`, priority, status: "open", index })) } };
  const page = await openPm(state);
  t.after(() => page.dom.window.close());
  const expected = values.map((_, index) => [`Unknown ${index}`, "unknown", "Unknown priority"]);
  assertPriorityRows(page, page.titles().map(title => [title, "unknown", "Unknown priority"]));
  assert.strictEqual(page.doc.querySelector(".pm-task-list img"), null);
  page.sortButton("Manual").click();
  assertPriorityRows(page, expected);
  await page.dom.window.eval("refresh()");
  assertPriorityRows(page, expected);
  assert.deepStrictEqual(page.errors, []);
});
