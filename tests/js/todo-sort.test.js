// Unit tests for the PM todo sort (ai_dashboard/static/js/views/todo-sort.js).
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const SOURCE = fs.readFileSync(path.join(__dirname, "../../ai_dashboard/static/js/views/todo-sort.js"), "utf8");

// A fresh page scope per test, so "log once" state does not leak between tests.
function load() {
  const warnings = [];
  const context = vm.createContext({ console: { warn: (message) => warnings.push(message) } });
  vm.runInContext(SOURCE, context);
  return { sortTodos: vm.runInContext("sortTodos", context), modes: vm.runInContext("SORT_MODES", context), warnings };
}
const ids = (todos) => todos.map((todo) => todo.id);

const TODOS = [
  { id: "a", priority: "low", created: "2026-10-01T09:00:00Z" },
  { id: "b", priority: "high", created: "2026-10-03T09:00:00Z" },
  { id: "c", priority: "normal", created: "2026-10-02T09:00:00Z" },
  { id: "d", priority: "high", created: "2026-09-30T09:00:00Z" },
];

test("sort modes are Manual, Created and Priority", () => {
  assert.deepStrictEqual(Object.keys(load().modes), ["manual", "created", "priority"]);
});

test("each mode orders the todos", () => {
  const { sortTodos } = load();
  assert.deepStrictEqual(ids(sortTodos(TODOS, "manual")), ["a", "b", "c", "d"]);
  assert.deepStrictEqual(ids(sortTodos(TODOS, "created")), ["b", "c", "a", "d"]);
  assert.deepStrictEqual(ids(sortTodos(TODOS, "priority")), ["b", "d", "c", "a"]);
});

test("manual order follows the snapshot index, not the array position", () => {
  const { sortTodos } = load();
  const todos = [{ id: "x", index: 2 }, { id: "y", index: 0 }, { id: "z", index: 1 }];
  assert.deepStrictEqual(ids(sortTodos(todos, "manual")), ["y", "z", "x"]);
});

test("ties fall back to the manual index", () => {
  const { sortTodos } = load();
  const todos = [{ id: "p", priority: "high", index: 1 }, { id: "q", priority: "high", index: 0 }];
  assert.deepStrictEqual(ids(sortTodos(todos, "priority")), ["q", "p"]);
  assert.deepStrictEqual(ids(sortTodos(todos, "created")), ["q", "p"]);
});

test("ISO dates and epoch seconds or milliseconds compare together", () => {
  const { sortTodos } = load();
  const todos = [
    { id: "iso", created: "2026-10-02T00:00:00Z" },
    { id: "seconds", created: Date.parse("2026-10-03T00:00:00Z") / 1000 },
    { id: "ms", created: Date.parse("2026-10-01T00:00:00Z") },
  ];
  assert.deepStrictEqual(ids(sortTodos(todos, "created")), ["seconds", "iso", "ms"]);
});

test("missing created or priority sorts last, in manual order", () => {
  const { sortTodos, warnings } = load();
  const todos = [
    { id: "old1" },
    { id: "new", created: "2026-10-01T00:00:00Z", priority: "low" },
    { id: "old2", created: "", priority: null },
  ];
  assert.deepStrictEqual(ids(sortTodos(todos, "created")), ["new", "old1", "old2"]);
  assert.deepStrictEqual(ids(sortTodos(todos, "priority")), ["new", "old1", "old2"]);
  assert.deepStrictEqual(warnings, []);
});

test("unknown priorities are kept, sorted after known ones, and logged once", () => {
  const { sortTodos, warnings } = load();
  const todos = [{ id: "u", priority: "P1" }, { id: "m" }, { id: "l", priority: "low" }];
  assert.deepStrictEqual(ids(sortTodos(todos, "priority")), ["l", "u", "m"]);
  sortTodos(todos, "priority");
  assert.deepStrictEqual(warnings, ["Unknown todo priority: P1"]);
});

test("an unknown mode is logged and falls back to manual", () => {
  const { sortTodos, warnings } = load();
  assert.deepStrictEqual(ids(sortTodos(TODOS, "alphabetic")), ["a", "b", "c", "d"]);
  assert.deepStrictEqual(warnings, ["Unknown todo sort mode: alphabetic"]);
});

test("sorting returns a copy and leaves the saved order unchanged", () => {
  const { sortTodos } = load();
  const todos = TODOS.map((todo) => ({ ...todo }));
  const before = JSON.stringify(todos);
  const sorted = sortTodos(todos, "priority");
  assert.notStrictEqual(sorted, todos);
  assert.strictEqual(JSON.stringify(todos), before);
});
