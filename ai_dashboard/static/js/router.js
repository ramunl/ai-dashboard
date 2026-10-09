// Navigation between windows: paths, history, Telegram's Back button.
// path -> { api window, page builder, title shown while loading, parent }
// Back goes to the parent window; top-level windows have the launcher ("").
const ROUTES = {
  "": { api: "launcher", page: launcherPage, title: "AI Agents" },
  ops: { api: "ops", page: opsPage, title: "Ops agent" },
  coding: { api: "coding", page: codingPage, title: "Coding agent" },
  "coding/projects": { api: "coding", page: projectsPage, title: "Projects", parent: "coding" },
  "coding/ai": { api: "coding", page: aiToolsPage, title: "AI tools", parent: "coding" },
  pm: { api: "pm", page: pmPage, title: "PM agent" },
  tasks: { api: "coding", page: tasksPage, title: "Tasks" },
};
const POPSTATE_GRACE_MS = 300;

let isAwaitingPopstate = false;

function normalizePath(path) {
  return path.replace(/^\/+|\/+$/g, "");
}

function currentPath() {
  const path = normalizePath(location.pathname);
  return ROUTES[path] ? path : "";
}

function currentRoute() {
  return ROUTES[currentPath()];
}

function parentOf(path) {
  return (ROUTES[path] && ROUTES[path].parent) || "";
}

function navigate(path) {
  const target = normalizePath(path);
  if (target === currentPath()) return;
  if (currentPath() === "pm" && !pmUi.busy) pmUi.editor = null;
  history.pushState({ from: currentPath() }, "", "/" + target);
  show();
}

function showInPlace(path) {
  history.replaceState({}, "", "/" + path);
  show();
}

// Back from a window goes to its parent: step back in history when we came
// from the parent, otherwise (opened straight from a bot) replace this entry
// with the parent. Either way history does not grow with every round trip.
function goBack() {
  if (currentPath() === "pm" && pmUi.editor) {
    pmCloseEditor();
    return;
  }
  const parent = parentOf(currentPath());
  if (!(history.state && history.state.from === parent)) {
    showInPlace(parent);
    return;
  }
  isAwaitingPopstate = true;
  history.back(); // fires popstate -> show()
  // Telegram's WebViews do not always fire popstate; never leave Back undone.
  setTimeout(() => {
    if (!isAwaitingPopstate) return;
    isAwaitingPopstate = false;
    console.warn("No popstate after history.back(); showing the parent directly");
    showInPlace(parent);
  }, POPSTATE_GRACE_MS);
}

function onPopstate() {
  isAwaitingPopstate = false;
  if (currentPath() !== "pm" && !pmUi.busy) pmUi.editor = null;
  show();
}

// Telegram's native Back: on any window other than the launcher.
function syncBackButton() {
  if (!tg || !tg.BackButton) return;
  if (currentPath()) tg.BackButton.show();
  else tg.BackButton.hide();
}

function initRouter() {
  if (tg && tg.BackButton) tg.BackButton.onClick(goBack);
  window.addEventListener("popstate", onPopstate);
}
