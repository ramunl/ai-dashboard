// Lock / Unlock logs button of the Coding logs window. The lock state and the
// poll gating live in coding-logs.js; this file only builds and shows the
// button. Locked means the lines stay as they are and no poll runs.

const LOGS_LOCK_LABELS = { open: "Lock logs", locked: "Unlock logs" };

// The button and its status line, built once with the window's card.
// onToggle runs on every tap.
function createLogsLock(onToggle) {
  const lock = {
    button: el("button", null, "logs-lock-button"),
    status: el("span", null, "logs-lock-status"),
    node: el("div", null, "logs-lock-controls"),
  };
  lock.button.type = "button";
  lock.button.addEventListener("click", onToggle);
  lock.status.setAttribute("role", "status");
  lock.node.append(lock.button, lock.status);
  return lock;
}

// Show the state: the label names what a tap does, aria-pressed the state.
function renderLogsLock(lock, isLocked) {
  lock.button.textContent = isLocked ? LOGS_LOCK_LABELS.locked : LOGS_LOCK_LABELS.open;
  lock.button.setAttribute("aria-pressed", String(isLocked));
  lock.status.textContent = isLocked ? "Updates paused" : "Updates live";
}
