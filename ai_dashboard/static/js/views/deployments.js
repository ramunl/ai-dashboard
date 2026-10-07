// Deployment reads, and confirmed deploy and rollback requests; the manager
// executes jobs. One compact row per agent; details and actions open on tap.

let rollbackPending = false;
const openDeployments = new Set(); // names whose details are open, kept across refreshes
const DEPLOY_BUSY = ["queued", "deploying", "rolling_back", "rollback_failed"];

function deploymentRevision(revision) {
  if (!revision) return "Not recorded";
  return `${revision.version || "unknown version"} · ${(revision.commit || "unknown").slice(0, 7)}`;
}

// "verified 2 min ago" from an ISO time or epoch seconds.
function verifiedAgo(value) {
  if (value === null || value === undefined || value === "") return "not verified";
  const time = typeof value === "number" ? value * 1000 : Date.parse(value);
  if (Number.isNaN(time)) return "not verified";
  const seconds = Math.max(0, (Date.now() - time) / 1000);
  return seconds < 60 ? "verified just now" : `verified ${formatDuration(seconds)} ago`;
}

function deploymentStatus(target) {
  if (target.status === "healthy") return "ok";
  if (["failed", "rollback_failed"].includes(target.status)) return "bad";
  return "warn";
}

function canRollBack(target) {
  const previous = target.previous;
  return Boolean(previous && previous.commit && previous.verified_at
    && (!target.current || previous.commit !== target.current.commit));
}

function deploymentRollbackButton(target, isBusy) {
  const label = `Roll back to ${deploymentRevision(target.previous)}`;
  const button = el("button", label, "danger-button");
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
        rollbackPending = false;
        refresh();
      } catch (error) {
        // No refresh here: redrawing the page would clear the message.
        rollbackPending = false;
        button.disabled = isBusy;
        button.textContent = label;
        showAlert("Rollback request failed: " + error.message);
      }
    });
  });
  return button;
}

function deploymentDeployButton(target, isBusy, view) {
  const label = "Deploy latest main";
  const button = el("button", label, "action-button deploy-button");
  button.type = "button";
  button.disabled = isBusy || rollbackPending;
  button.addEventListener("click", () => {
    if (rollbackPending) return;
    // Reserve before showing the asynchronous Telegram confirmation dialog.
    rollbackPending = true;
    button.disabled = true;
    const question = `Deploy the latest main to ${target.name}? The service will restart.${restartWarning(target.name, view)}`;
    askConfirmation(question, async (isConfirmed) => {
      if (!isConfirmed) {
        rollbackPending = false;
        button.disabled = isBusy;
        return;
      }
      button.textContent = "Queuing…";
      try {
        await postAction("ops/deploy", tg ? tg.initData : "", { target: target.name });
        button.textContent = "Queued";
        rollbackPending = false;
        refresh();
      } catch (error) {
        // No refresh here: redrawing the page would clear the message.
        rollbackPending = false;
        button.disabled = isBusy;
        button.textContent = label;
        showAlert("Deployment request failed: " + error.message);
      }
    });
  });
  return button;
}

function deploymentSummary(target) {
  const summary = el("summary", null, "deploy-summary");
  const title = el("div");
  title.append(statusDot(deploymentStatus(target)), " ", target.name);
  const detail = target.status === "healthy"
    ? verifiedAgo(target.current && target.current.verified_at)
    : target.status.replaceAll("_", " ");
  const left = el("div");
  left.append(title, el("div", detail, "nav-detail"));
  summary.append(left, el("span", deploymentRevision(target.current), "deploy-revision"));
  return summary;
}

function deploymentDetails(target, isBusy, view) {
  const nodes = [
    row("Current", `${deploymentRevision(target.current)} · ${verifiedAgo(target.current && target.current.verified_at)}`),
  ];
  if (canRollBack(target)) {
    nodes.push(row("Previous", `${deploymentRevision(target.previous)} · ${verifiedAgo(target.previous.verified_at)}`));
    nodes.push(deploymentRollbackButton(target, isBusy));
  } else {
    nodes.push(el("div", "No earlier verified version to roll back to.", "card-note"));
  }
  nodes.push(deploymentDeployButton(target, isBusy, view));
  return nodes;
}

function deploymentItem(target, isBusy, view) {
  const item = el("details", null, "deploy-item");
  item.open = openDeployments.has(target.name);
  item.addEventListener("toggle", () => {
    if (item.open) openDeployments.add(target.name);
    else openDeployments.delete(target.name);
  });
  item.append(deploymentSummary(target), ...deploymentDetails(target, isBusy, view));
  // Problems stay visible without opening the row.
  const outside = [];
  if (target.error) outside.push(el("div", target.error, "card-note"));
  if (target.status === "rollback_failed") {
    outside.push(muted("Recovery required on the server: ai-deploy recover. Rollback controls remain disabled until recovery succeeds."));
  }
  return [item, ...outside];
}

function deploymentsCard(view) {
  const deployments = view.deployments;
  if (!deployments || !deployments.ok) {
    return card("Deployments", muted((deployments && deployments.error) || "Deployment status unavailable"));
  }
  const isBusy = deployments.targets.some((target) => DEPLOY_BUSY.includes(target.status));
  return card("Deployments", ...deployments.targets.flatMap((target) => deploymentItem(target, isBusy, view)));
}
