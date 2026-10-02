// Deployment reads and confirmed rollback requests; the manager executes jobs.
let rollbackPending = false;

function deploymentRevision(revision) {
  if (!revision) return "Not recorded";
  return `${revision.version || "unknown version"} · ${(revision.commit || "unknown").slice(0, 8)}`;
}

function deploymentRollbackButton(target, isBusy) {
  const button = el("button", "Roll back", "action-button");
  button.type = "button";
  button.disabled = isBusy || rollbackPending;
  button.addEventListener("click", () => {
    if (rollbackPending) return;
    // Reserve before showing the asynchronous Telegram confirmation dialog.
    rollbackPending = true;
    button.disabled = true;
    askConfirmation(`Roll back ${target.name} to ${deploymentRevision(target.previous)}? The service will restart.`, async (confirmed) => {
      if (!confirmed) {
        rollbackPending = false;
        button.disabled = isBusy;
        return;
      }
      button.textContent = "Queuing…";
      try {
        await postAction("ops/rollback", tg ? tg.initData : "", {
          target: target.name, expected_commit: target.previous.commit,
        });
        button.textContent = "Queued";
        refresh();
      } catch (error) {
        showAlert("Rollback request failed: " + error.message);
        button.textContent = "Roll back";
      } finally {
        rollbackPending = false;
        refresh();
      }
    });
  });
  return button;
}

function deploymentsCard(view) {
  const deployments = view.deployments;
  if (!deployments || !deployments.ok) {
    return card("Deployments", muted((deployments && deployments.error) || "Deployment status unavailable"));
  }
  const isBusy = deployments.targets.some((target) => ["queued", "deploying", "rolling_back"].includes(target.status));
  const rows = [];
  for (const target of deployments.targets) {
    rows.push(el("h3", target.name, "card-subtitle"));
    rows.push(row("Status", target.status.replaceAll("_", " ")));
    rows.push(row("Current revision", deploymentRevision(target.current)));
    if (target.current) rows.push(row("Health verified", target.current.verified_at ? "Yes" : "Not yet"));
    if (target.previous) rows.push(row("Previous verified", deploymentRevision(target.previous)));
    if (target.error) rows.push(el("div", target.error, "card-note"));
    if (target.previous && target.previous.commit && target.previous.verified_at) {
      rows.push(deploymentRollbackButton(target, isBusy));
    }
  }
  return card("Deployments", ...rows);
}
