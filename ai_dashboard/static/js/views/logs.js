// Ops › Logs card: recent journal lines of one service, loaded on demand.
// The card keeps one DOM node and redraws only itself, so the 5-second window
// refresh neither reloads logs nor resets the scroll position. Lock pauses the
// polling and drops responses still in flight (toggleOpsLogsLock).

const logsState = {
  unit: "",
  isErrorsOnly: false,
  units: [],
  lines: null,
  error: "",
  isLoading: false,
  isLocked: false, // Like Coding logs, never persisted.
  loadedAt: 0,
  node: null,
  controller: null,
  timer: null,
};

function stopOpsLogs() {
  clearInterval(logsState.timer);
  if (logsState.controller) logsState.controller.abort();
  logsState.controller = null;
  logsState.timer = null;
  logsState.isLoading = false;
  logsState.isLocked = false;
  logsState.node = null;
}

function toggleOpsLogsLock() {
  logsState.isLocked = !logsState.isLocked;
  // Invalidate even responses whose transport does not honor abort. The
  // visible pause notice explains why pending updates are not displayed.
  if (logsState.controller) logsState.controller.abort();
  logsState.controller = null;
  logsState.isLoading = false;
  drawLogs();
  if (!logsState.isLocked) loadLogs();
}

async function loadLogs() {
  if (!logsState.node || logsState.isLocked || logsState.isLoading) return;
  const controller = new AbortController();
  logsState.controller = controller;
  logsState.isLoading = true;
  logsState.error = "";
  drawLogs();
  const query = new URLSearchParams({ unit: logsState.unit, errors: logsState.isErrorsOnly ? "1" : "0" });
  try {
    const body = await fetchWindow(`ops/logs?${query}`, tg ? tg.initData : "", controller);
    if (logsState.controller !== controller || logsState.isLocked) return;
    if (!body.ok) throw new Error(body.error || "Logs unavailable");
    logsState.units = body.units || [];
    logsState.unit = body.unit || logsState.unit;
    logsState.lines = body.lines || [];
    logsState.loadedAt = Date.now();
    drawLogs(true);
  } catch (error) {
    if (logsState.controller === controller) logsState.error = `Logs not loaded: ${error.message}`;
  } finally {
    if (logsState.controller === controller) {
      logsState.controller = null;
      logsState.isLoading = false;
      drawLogs();
    }
  }
}

function logsChoice(label, isPressed, onPick) {
  const button = el("button", label);
  button.type = "button";
  button.setAttribute("aria-pressed", String(isPressed));
  button.addEventListener("click", onPick);
  return button;
}

function logsControls() {
  const units = el("div", null, "segmented logs-units");
  for (const unit of logsState.units) {
    units.append(logsChoice(unit, unit === logsState.unit, () => {
      logsState.unit = unit;
      loadLogs();
    }));
  }
  const filter = el("div", null, "segmented");
  filter.append(
    logsChoice("All", !logsState.isErrorsOnly, () => { logsState.isErrorsOnly = false; loadLogs(); }),
    logsChoice("Errors (24 h)", logsState.isErrorsOnly, () => { logsState.isErrorsOnly = true; loadLogs(); }),
  );
  const bar = el("div", null, "logs-controls logs-filters");
  bar.append(units, filter);
  return bar;
}

function logsBody() {
  if (logsState.lines === null) return muted("No log lines loaded yet");
  if (!logsState.lines.length) {
    return muted(logsState.isErrorsOnly ? "No errors in the last 24 hours" : "No log lines");
  }
  return el("pre", logsState.lines.join("\n"), "logs-text");
}

function drawLogs(isNewData = false) {
  const node = logsState.node;
  if (!node) return;
  const lock = node.querySelector(".logs-lock-button");
  lock.textContent = logsState.isLocked ? "Unlock logs" : "Lock logs";
  lock.setAttribute("aria-pressed", String(logsState.isLocked));
  node.querySelector(".logs-lock-status").textContent = logsState.isLocked
    ? "Updates paused" : logsState.isLoading ? "Loading…" : "Updates live";
  const reload = node.querySelector(".logs-refresh");
  reload.textContent = logsState.isLoading ? "Loading…" : "Refresh";
  reload.disabled = logsState.isLoading || logsState.isLocked;
  node.querySelector(".logs-error").textContent = logsState.error;
  if (isNewData) {
    node.querySelector(".logs-filters").replaceWith(logsControls());
    node.querySelector(".logs-body").replaceChildren(logsBody());
    const text = node.querySelector(".logs-text");
    if (text) text.scrollTop = text.scrollHeight;
  }
  for (const button of node.querySelectorAll(".logs-filters button")) {
    button.disabled = logsState.isLoading || logsState.isLocked;
  }
  node.querySelector(".logs-loaded").textContent = logsState.loadedAt
    ? `Loaded ${new Date(logsState.loadedAt).toLocaleTimeString()}` : "";
}

function logsCard() {
  if (!logsState.node) {
    const lock = el("button", "Lock logs", "logs-lock-button");
    lock.type = "button";
    lock.addEventListener("click", toggleOpsLogsLock);
    const reload = el("button", "Refresh", "logs-refresh");
    reload.type = "button";
    reload.addEventListener("click", loadLogs);
    const header = el("div", null, "logs-controls logs-header");
    header.append(el("h2", "Logs"), reload, lock);
    const status = el("div", null, "logs-lock-status");
    status.setAttribute("role", "status");
    const error = el("div", null, "card-note logs-error");
    error.setAttribute("role", "alert");
    const body = el("div", null, "logs-body");
    body.append(logsBody());
    logsState.node = el("section", null, "card-wide card-last");
    logsState.node.append(header, status, logsControls(), error, body, el("div", null, "card-note logs-loaded"));
    drawLogs();
    loadLogs();
    logsState.timer = setInterval(loadLogs, 5000);
  }
  return logsState.node;
}
