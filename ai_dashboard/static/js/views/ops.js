// Ops window (/ops): the ops service, what fills the disk, and disk cleanup.
// Shared cards (problems, resources) come from views/launcher.js.

function operationsCard(view) {
  const ops = view.agents.find((agent) => agent.name === "ops");
  if (!ops) return card("Operations", muted("Ops agent is not configured"));
  const rows = [
    row("Service", ops.service),
    row("Restarts", ops.restarts || 0),
    row("Errors in last hour", ops.errors_last_hour || 0),
  ];
  if (typeof ops.up_seconds === "number") rows.push(row("Up", formatDuration(ops.up_seconds)));
  return card("Operations", ...rows);
}

function categoryRows(category) {
  return [row(category.label, formatBytes(category.bytes)), el("div", category.detail, "card-note")];
}

function cleanupButton(cleanup) {
  const button = el("button", null, "action-button");
  button.type = "button";
  const reclaimable = cleanup.report.reclaimable_bytes || 0;
  if (cleanup.running) {
    button.textContent = "Cleaning up…";
    button.disabled = true;
  } else if (!reclaimable) {
    button.textContent = "Nothing to clean up";
    button.disabled = true;
  } else {
    button.textContent = `Clean up · frees ~${formatBytes(reclaimable)}`;
    button.addEventListener("click", () => confirmCleanup(button, reclaimable));
  }
  return button;
}

function confirmCleanup(button, reclaimable) {
  const message =
    `Free about ${formatBytes(reclaimable)}? This removes unused packages, ` +
    "the apt cache, logs older than 7 days, old snap revisions, and pip/npm caches.";
  askConfirmation(message, async (isConfirmed) => {
    if (!isConfirmed) return;
    button.disabled = true;  // no double start; the server would refuse it too
    button.textContent = "Starting…";
    try {
      await postAction("ops/cleanup", tg ? tg.initData : "");
      refresh();
    } catch (error) {
      button.disabled = false;
      button.textContent = `Clean up · frees ~${formatBytes(reclaimable)}`;
      showAlert("Cleanup did not start: " + error.message);
    }
  });
}

function lastCleanupRows(lastRun) {
  if (!lastRun) return [];
  if (lastRun.error) return [row("Last cleanup", "failed"), el("div", lastRun.error, "card-note")];
  const ago = formatDuration(Math.max(0, Date.now() / 1000 - lastRun.finished_at));
  const rows = [row("Last cleanup", `freed ${formatBytes(lastRun.freed_bytes || 0)} · ${ago} ago`)];
  for (const step of lastRun.steps || []) {
    if (!step.ok) rows.push(el("div", `${step.label} failed: ${step.message}`, "card-note"));
  }
  return rows;
}

function diskUsageCard(view) {
  const cleanup = view.cleanup;
  if (!cleanup || !cleanup.report) return card("Disk usage", muted("Measuring disk usage…"));
  if (!cleanup.report.ok) return card("Disk usage", muted(cleanup.report.error));
  const rows = cleanup.report.categories.flatMap(categoryRows);
  const largest = (cleanup.report.largest || []).slice(0, 5);
  if (largest.length) {
    rows.push(el("div", "Largest directories", "card-subtitle"));
    for (const entry of largest) rows.push(row(entry.path, formatBytes(entry.bytes)));
  }
  return card("Disk usage", ...rows, cleanupButton(cleanup), ...lastCleanupRows(cleanup.last_run));
}

function opsPage(view) {
  return {
    title: "Ops agent",
    subtitle: serverSubtitle(view),
    status: pageStatus(view),
    alert: "",
    nodes: [operationsCard(view), servicesCard(view), deploymentsCard(view), ...problemsCards(view), diskUsageCard(view), updatesCard(view), aiToolsCard(view), resourcesCard(view), ...rebootCards(view), logsCard()],
  };
}
