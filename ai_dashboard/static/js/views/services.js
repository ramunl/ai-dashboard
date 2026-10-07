// Ops › Services card: each restartable service with its state and a Restart
// button. The list comes from the ops agent's whitelist (ai-service list).

const restartsPending = new Map(); // unit -> time the restart was requested (ms)
const RESTART_WATCH_MS = 60 * 1000;

function isRestartPending(row) {
  const requestedAt = restartsPending.get(row.unit);
  if (!requestedAt) return false;
  const age = Date.now() - requestedAt;
  // Done once the service is up again and has been up for less time than
  // has passed since the request, or after a minute whatever happened.
  const isBack = row.state === "active" && typeof row.up_seconds === "number"
    && row.up_seconds * 1000 < age;
  if (isBack || age > RESTART_WATCH_MS) {
    restartsPending.delete(row.unit);
    return false;
  }
  return true;
}

function restartWarning(unit, view) {
  if (unit === "ai-dashboard") return " The dashboard reconnects in a few seconds.";
  const agent = view.agents.find((item) => item.unit === unit);
  if (agent && /^running\b/.test(agent.detail || "")) {
    return " It is running a task right now; the task will be interrupted.";
  }
  return "";
}

function restartButton(row, view) {
  const button = el("button", "Restart", "row-button restart-button");
  button.type = "button";
  button.disabled = isRestartPending(row);
  if (button.disabled) button.textContent = "Restarting…";
  button.addEventListener("click", () => {
    button.disabled = true;
    askConfirmation(`Restart ${row.unit}?${restartWarning(row.unit, view)}`, async (isConfirmed) => {
      if (!isConfirmed) {
        button.disabled = false;
        return;
      }
      button.textContent = "Restarting…";
      try {
        await postAction("ops/restart", tg ? tg.initData : "", { service: row.unit });
        restartsPending.set(row.unit, Date.now());
      } catch (error) {
        showAlert(`Restart of ${row.unit} failed: ${error.message}`);
        button.disabled = false;
        button.textContent = "Restart";
      }
    });
  });
  return button;
}

function serviceRow(row, view) {
  const node = el("div", null, "setup-row");
  const label = el("div");
  const title = el("div");
  title.append(statusDot(row.state === "active" ? "ok" : "bad"), " ", row.unit);
  const detail = [row.state];
  if (typeof row.up_seconds === "number") detail.push(`up ${formatDuration(row.up_seconds)}`);
  label.append(title, el("div", detail.join(" · "), "nav-detail"));
  node.append(label, restartButton(row, view));
  return node;
}

function servicesCard(view) {
  const control = view.service_control;
  if (!control) return card("Services", muted("Service status unavailable"));
  if (!control.ok) return card("Services", muted(control.error));
  return card("Services", ...control.services.map((row) => serviceRow(row, view)));
}
