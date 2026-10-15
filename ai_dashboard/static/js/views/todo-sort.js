// Sort orders for the PM todo list. Sorting returns a copy, so the saved
// (manual) order the PM agent keeps is never changed from here.
const SORT_MODES = { manual: "Manual", created: "Created", priority: "Priority" };
// The PM agent's priorities (see PM_PRIORITIES); unknown ones sort after these.
const TODO_PRIORITY_RANK = { high: 0, normal: 1, low: 2 };
const todoSortLogged = new Set();  // log each unknown value once, not every poll

function todoSortWarn(message) {
  if (todoSortLogged.has(message)) return;
  todoSortLogged.add(message);
  console.warn(message);
}

// The saved position: the snapshot's index, else the order the agent sent.
function todoManualIndex(todo, position) {
  return Number.isInteger(todo.index) ? todo.index : position;
}

// Milliseconds, or null when missing (todos made before dates were kept).
// Accepts ISO dates and epoch seconds or milliseconds.
function todoCreatedTime(created) {
  if (typeof created === "number" && Number.isFinite(created)) return created < 1e12 ? created * 1000 : created;
  if (typeof created !== "string" || !created.trim()) return null;
  const time = Date.parse(created);
  if (Number.isNaN(time)) todoSortWarn(`Unknown todo created date: ${created}`);
  return Number.isNaN(time) ? null : time;
}

function todoPriorityRank(priority) {
  if (priority === undefined || priority === null || priority === "") return null;
  if (Object.hasOwn(TODO_PRIORITY_RANK, priority)) return TODO_PRIORITY_RANK[priority];
  todoSortWarn(`Unknown todo priority: ${priority}`);
  return Object.keys(TODO_PRIORITY_RANK).length;
}

// Smaller sorts first; Infinity (a missing value) sorts last.
function todoSortKey(todo, mode) {
  if (mode === "created") {
    const time = todoCreatedTime(todo.created);
    return time === null ? Infinity : -time;  // newest first
  }
  if (mode === "priority") {
    const rank = todoPriorityRank(todo.priority);
    return rank === null ? Infinity : rank;
  }
  return 0;
}

// A sorted copy of todos; ties (and Manual) keep the saved manual order.
function sortTodos(todos, mode) {
  if (!Object.hasOwn(SORT_MODES, mode)) {
    todoSortWarn(`Unknown todo sort mode: ${mode}`);
    mode = "manual";
  }
  const keyed = todos.map((todo, position) => ({ todo, manual: todoManualIndex(todo, position), key: todoSortKey(todo, mode) }));
  // Infinity - Infinity is NaN, which falls through to the manual index.
  keyed.sort((a, b) => (a.key - b.key) || (a.manual - b.manual));
  return keyed.map((entry) => entry.todo);
}
