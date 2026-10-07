// Ops › Logs card: recent journal lines of one service, loaded on demand.
// The card keeps one DOM node and redraws only itself, so the 5-second window
// refresh neither reloads logs nor resets the scroll position.

const logsState = {
  unit: "", // "" lets the server pick the first unit
  isErrorsOnly: false,
  units: [],
  lines: null, // null: not loaded yet
  error: "",
  isLoading: false,
  loadedAt: 0,
  node: null,
};

async function loadLogs() {
  if (logsState.isLoading) return;
  logsState.isLoading = true;
  drawLogs();
  const query = new URLSearchParams({ unit: logsState.unit, errors: logsState.isErrorsOnly ? "1" : "0" });
  try {
    const body = await fetchWindow(`ops/logs?${query}`, tg ? tg.initData : "", new AbortController());
    logsState.units = body.units || [];
    logsState.unit = body.unit || logsState.unit;
    logsState.lines = body.ok ? body.lines : null;
    logsState.error = body.ok ? "" : body.error;
    logsState.loadedAt = Date.now();
  } catch (error) {
    logsState.error = `Logs not loaded: ${error.message}`;
  } finally {
    logsState.isLoading = false;
    drawLogs(true);
  }
}

function logsChoice(label, isPressed, onPick) {
  const button = el("button", label);
  button.type = "button";
  button.setAttribute("aria-pressed", String(isPressed));
  button.disabled = logsState.isLoading;
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
  const reload = logsChoice(logsState.isLoading ? "Loading…" : "Refresh", false, loadLogs);
  const bar = el("div", null, "logs-controls");
  bar.append(units, filter, reload);
  return bar;
}

function logsBody() {
  if (logsState.error) return el("div", logsState.error, "card-note");
  if (logsState.lines === null) return muted("Loading…");
  if (!logsState.lines.length) {
    return muted(logsState.isErrorsOnly ? "No errors in the last 24 hours" : "No log lines");
  }
  return el("pre", logsState.lines.join("\n"), "logs-text");
}

// Redraw the card's contents; after new lines arrive, show the newest ones.
function drawLogs(isNewData = false) {
  const node = logsState.node;
  if (!node) return;
  const nodes = [el("h2", "Logs"), logsControls(), logsBody()];
  if (logsState.loadedAt) {
    nodes.push(el("div", `Loaded ${new Date(logsState.loadedAt).toLocaleTimeString()}`, "card-note"));
  }
  node.replaceChildren(...nodes);
  const text = node.querySelector(".logs-text");
  if (text && isNewData) text.scrollTop = text.scrollHeight;
}

function logsCard() {
  if (!logsState.node) {
    logsState.node = el("section", null, "card-wide card-last");
    drawLogs();
    loadLogs();
  }
  return logsState.node;
}
