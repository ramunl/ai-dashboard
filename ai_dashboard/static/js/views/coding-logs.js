// Coding › Logs window (/coding/logs): the coding agent's journal, polled on
// its own timer and updated in place by the log tail box (log-tail.js), so a
// poll never resets the scroll position. Reads the Ops logs endpoint.

const CODING_LOGS_PATH = "coding/logs";
const CODING_LOGS_POLL_MS = 3000;

let isLogsLocked = false;
let isLogsFetchInFlight = false;
let logsAbort = null;

const codingLogs = {
  node: null, // the window's card, built once and reused
  tail: null,
  loaded: null, // "Loaded …" note
  unit: "", // chosen from the server's list after the first answer
  lockButton: null,
  lockStatus: null,
  isPolling: false,
  timer: 0,
};

// The coding agent's unit from the readable ones (the first one otherwise).
function codingLogsUnitOf(body) {
  const units = body.units || [];
  return units.find((unit) => unit.includes("coding")) || body.unit || "";
}

function codingLogsCard() {
  if (!codingLogs.node) {
    codingLogs.tail = createLogTail();
    codingLogs.loaded = el("div", "Loading…", "card-note");
    codingLogs.node = el("section", null, "card-wide");
    codingLogs.lockButton = el("button", "Lock: off", "logs-lock-button");
    codingLogs.lockButton.type = "button";
    codingLogs.lockButton.addEventListener("click", toggleCodingLogsLock);
    codingLogs.lockStatus = el("span", null, "logs-lock-status");
    codingLogs.lockStatus.setAttribute("role", "status");
    const controls = el("div", null, "logs-lock-controls");
    controls.append(codingLogs.lockButton, codingLogs.lockStatus);
    codingLogs.node.append(el("h2", "Coding agent logs"), controls, codingLogs.tail.node, codingLogs.loaded);
    syncCodingLogsLock();
  }
  return codingLogs.node;
}

function syncCodingLogsLock() {
  if (!codingLogs.lockButton) return;
  codingLogs.lockButton.textContent = `Lock: ${isLogsLocked ? "on" : "off"}`;
  codingLogs.lockButton.setAttribute("aria-pressed", String(isLogsLocked));
  codingLogs.lockStatus.textContent = isLogsLocked ? "Updates paused" : "Updates live";
}

function toggleCodingLogsLock() {
  isLogsLocked = !isLogsLocked;
  // Discard an in-flight answer so it cannot change lines while locked.
  if (isLogsLocked && logsAbort) logsAbort.abort();
  logsAbort = null;
  isLogsFetchInFlight = false;
  syncCodingLogsLock();
  if (!isLogsLocked) codingLogsTick();
}

function startCodingLogs() {
  if (codingLogs.isPolling) return;
  codingLogs.isPolling = true;
  codingLogs.timer = setInterval(codingLogsTick, CODING_LOGS_POLL_MS);
  codingLogsTick();
}

// Leaving the window: stop the timer and cancel the poll in flight.
function stopCodingLogs() {
  codingLogs.isPolling = false;
  clearInterval(codingLogs.timer);
  if (logsAbort) logsAbort.abort();
  logsAbort = null;
  isLogsFetchInFlight = false;
  isLogsLocked = false;
  syncCodingLogsLock();
}

async function codingLogsTick() {
  if (currentPath() !== CODING_LOGS_PATH) {
    stopCodingLogs();
    return;
  }
  if (isLogsLocked) {
    console.debug("Logs poll skipped: Updates paused (lock on)");
    return;
  }
  if (isLogsFetchInFlight) {
    console.debug("Logs poll skipped: the previous one is still in flight");
    return;
  }
  const controller = new AbortController();
  logsAbort = controller;
  isLogsFetchInFlight = true;
  const query = new URLSearchParams({ unit: codingLogs.unit, errors: "0" });
  try {
    const body = await fetchWindow(`ops/logs?${query}`, tg ? tg.initData : "", controller);
    if (logsAbort !== controller) return; // left the window meanwhile
    const unit = codingLogsUnitOf(body);
    if (unit && unit !== body.unit) {
      // The first answer was another unit's: ask again for the right one.
      if (codingLogs.unit !== unit) setTimeout(codingLogsTick, 0);
      codingLogs.unit = unit;
      return;
    }
    codingLogs.unit = unit;
    if (!body.ok) {
      logTailShowError(codingLogs.tail, `Logs not updated: ${body.error}`);
      return;
    }
    const restoreScroll = preserveLogsScroll(codingLogs.tail.box);
    codingLogs.tail.isFollowingTail = logTailIsAtBottom(codingLogs.tail.box);
    logTailUpdate(codingLogs.tail, body.lines || []);
    const count = body.lines && body.lines.length ? "" : " · no log lines";
    codingLogs.loaded.textContent = `${unit} · loaded ${new Date().toLocaleTimeString()}${count}`;
    restoreScroll();
  } catch (error) {
    if (logsAbort !== controller) return;
    logTailShowError(codingLogs.tail, `Logs not updated: ${error.message}`);
  } finally {
    if (logsAbort === controller) {
      logsAbort = null;
      isLogsFetchInFlight = false;
    }
  }
}

function codingLogsPage(view) {
  const node = codingLogsCard();
  startCodingLogs();
  return {
    title: "Coding logs",
    subtitle: codingLogs.unit,
    status: view.problem ? "bad" : "ok",
    alert: view.problem ? `coding agent ${view.problem}` : "",
    nodes: [node],
  };
}
