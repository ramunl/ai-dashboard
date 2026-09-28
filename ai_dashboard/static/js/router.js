// Navigation between windows: paths, history, Telegram's Back button.
// path -> { api window, page builder, title shown while loading }
const ROUTES = {
  "": { api: "launcher", page: launcherPage, title: "Server" },
  coding: { api: "coding", page: codingPage, title: "Coding agent" },
  pm: { api: "pm", page: pmPage, title: "PM agent" },
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

function navigate(path) {
  const target = normalizePath(path);
  if (target === currentPath()) return;
  history.pushState({ isFromLauncher: currentPath() === "" }, "", "/" + target);
  show();
}

function showLauncherInPlace() {
  history.replaceState({}, "", "/");
  show();
}

// Back from a window: step back in history when we came from the launcher,
// otherwise (opened straight from a bot) replace this entry with the launcher.
// Either way history does not grow with every round trip.
function goBack() {
  if (!(history.state && history.state.isFromLauncher)) {
    showLauncherInPlace();
    return;
  }
  isAwaitingPopstate = true;
  history.back(); // fires popstate -> show()
  // Telegram's WebViews do not always fire popstate; never leave Back undone.
  setTimeout(() => {
    if (!isAwaitingPopstate) return;
    isAwaitingPopstate = false;
    console.warn("No popstate after history.back(); showing the launcher directly");
    showLauncherInPlace();
  }, POPSTATE_GRACE_MS);
}

function onPopstate() {
  isAwaitingPopstate = false;
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
