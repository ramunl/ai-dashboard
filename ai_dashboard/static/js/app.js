// App shell: shows the current window, keeps it fresh, reports failures.
const REFRESH_MS = 5000;

// ---- page-wide state
let generation = 0; // bumped on every navigation; older responses are ignored
let request = null; // { generation, controller } of the request in flight
let hasData = false; // the current window shows data, not a placeholder

function showAlert(message) {
  const box = document.getElementById("alert");
  box.textContent = message || "";
  box.hidden = !message;
}

function setHeader(title, subtitle, status) {
  document.getElementById("title").textContent = title;
  document.getElementById("subtitle").textContent = subtitle;
  document.getElementById("status-dot").dataset.status = status || "";
  document.getElementById("status-label").textContent = STATUS_LABELS[status] || "";
}

function renderLoading() {
  setHeader(currentRoute().title, "", "");
  showAlert("");
  document.getElementById("view").replaceChildren(muted("Loading…"));
  document.getElementById("updated").textContent = "Loading…";
}

function renderPage(page, body) {
  setHeader(page.title, page.subtitle, page.status);
  showAlert(page.alert);
  document.getElementById("view").replaceChildren(...page.nodes);
  const age = typeof body.age_seconds === "number"
    ? ` · data ${Math.round(body.age_seconds)} s old`
    : "";
  document.getElementById("updated").textContent =
    "Updated " + new Date().toLocaleTimeString() + age;
}

function renderFailure(message) {
  showAlert(message);
  if (!hasData) document.getElementById("view").replaceChildren(muted("Not loaded."));
  document.getElementById("updated").textContent =
    "Update failed at " + new Date().toLocaleTimeString();
}

function cancelRequest() {
  if (!request) return;
  request.controller.abort();
  request = null;
}

function show() {
  generation++;
  hasData = false;
  cancelRequest();
  syncBackButton();
  renderLoading();
  refresh();
}

async function refresh() {
  const initData = tg ? tg.initData : "";
  if (!initData) {
    renderFailure("Open this dashboard from a bot's Dashboard button in Telegram.");
    return;
  }
  if (request && request.generation === generation) {
    console.debug("Refresh skipped: this window's request is still in flight");
    return;
  }
  const mine = { generation, controller: new AbortController() };
  request = mine;
  const route = currentRoute();
  try {
    const body = await fetchWindow(route.api, initData, mine.controller);
    if (mine.generation !== generation) return; // user moved on; that page loads itself
    renderPage(route.page(body), body);
    hasData = true;
  } catch (error) {
    if (mine.generation === generation) renderFailure("Cannot load this window: " + error.message);
  } finally {
    if (request === mine) request = null;
  }
}

function reportUncaught(message) {
  showAlert("Page error: " + message);
}

window.addEventListener("error", (event) => reportUncaught(event.message));
window.addEventListener("unhandledrejection", (event) =>
  reportUncaught(event.reason && event.reason.message ? event.reason.message : String(event.reason)));

initTelegram();
initRouter();
show();
setInterval(refresh, REFRESH_MS);
