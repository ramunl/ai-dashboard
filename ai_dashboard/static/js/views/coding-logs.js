// Coding › Logs window (/coding/logs): the coding agent's journal, polled on
// its own timer and updated in place by the log tail box (log-tail.js), so a
// poll never resets the scroll position. Reads the Ops logs endpoint.

const CODING_LOGS_PATH = "coding/logs";
const CODING_LOGS_POLL_MS = 3000;

const codingLogs = {
  node: null, // the window's card, built once and reused
  tail: null,
  loaded: null, // "Loaded …" note
  unit: "", // chosen from the server's list after the first answer
  request: null, // AbortController of the poll in flight
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
    codingLogs.node.append(el("h2", "Coding agent logs"), codingLogs.tail.node, codingLogs.loaded);
  }
  return codingLogs.node;
}

function startCodingLogs() {
  if (codingLogs.isPolling) return;
  codingLogs.isPolling = true;
  codingLogs.timer = setInterval(codingLogsTick, CODING_LOGS_POLL_MS);
  codingLogsTick();
}

// Leaving the window: stop the timer and cancel the poll in flight.
function stopCodingLogs() {
  if (!codingLogs.isPolling) return;
  codingLogs.isPolling = false;
  clearInterval(codingLogs.timer);
  if (codingLogs.request) codingLogs.request.abort();
  codingLogs.request = null;
}

async function codingLogsTick() {
  if (currentPath() !== CODING_LOGS_PATH) {
    stopCodingLogs();
    return;
  }
  if (codingLogs.request) {
    console.debug("Logs poll skipped: the previous one is still in flight");
    return;
  }
  const controller = new AbortController();
  codingLogs.request = controller;
  const query = new URLSearchParams({ unit: codingLogs.unit, errors: "0" });
  try {
    const body = await fetchWindow(`ops/logs?${query}`, tg ? tg.initData : "", controller);
    if (codingLogs.request !== controller) return; // left the window meanwhile
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
    logTailUpdate(codingLogs.tail, body.lines || []);
    const count = body.lines && body.lines.length ? "" : " · no log lines";
    codingLogs.loaded.textContent = `${unit} · loaded ${new Date().toLocaleTimeString()}${count}`;
  } catch (error) {
    if (codingLogs.request !== controller) return;
    logTailShowError(codingLogs.tail, `Logs not updated: ${error.message}`);
  } finally {
    if (codingLogs.request === controller) codingLogs.request = null;
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
