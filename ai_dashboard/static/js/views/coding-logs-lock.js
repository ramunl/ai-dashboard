// Coding › Logs lock: the Lock/Unlock button above the log box. Locked, the
// poll is skipped and the lines are not re-rendered, so they can be read or
// selected without moving. Unlocking drops any request still in flight, fetches
// once, and polling goes on. The state is not saved: a page reload unlocks.

let isLogsLocked = false;

function codingLogsLockControls() {
  codingLogs.lockButton = el("button", "Lock logs", "logs-lock-button");
  codingLogs.lockButton.type = "button";
  codingLogs.lockButton.addEventListener("click", toggleCodingLogsLock);
  codingLogs.lockStatus = el("span", null, "logs-lock-status");
  codingLogs.lockStatus.setAttribute("role", "status");
  syncCodingLogsLock();
  const controls = el("div", null, "logs-lock-controls");
  controls.append(codingLogs.lockButton, codingLogs.lockStatus);
  return controls;
}

function syncCodingLogsLock() {
  if (!codingLogs.lockButton) return;
  codingLogs.lockButton.textContent = isLogsLocked ? "Unlock logs" : "Lock logs";
  codingLogs.lockButton.setAttribute("aria-pressed", String(isLogsLocked));
  codingLogs.lockStatus.textContent = isLogsLocked ? "Updates paused" : "Updates live";
}

// Either way the request in flight is dropped: while locked it must not change
// the lines, and after unlocking the fetch below replaces it.
function toggleCodingLogsLock() {
  isLogsLocked = !isLogsLocked;
  if (logsAbort) logsAbort.abort();
  logsAbort = null;
  isLogsFetchInFlight = false;
  syncCodingLogsLock();
  if (!isLogsLocked) codingLogsTick();
}
