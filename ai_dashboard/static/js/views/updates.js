// Ops › Updates card: system packages. "Check" refreshes the package indexes
// and lists what can be upgraded; "Upgrade" installs it. Both run in the ops
// agent's ai-packages command; this card only starts them and shows the result.
// Counts marked stale are cached, not verified, and never offer an upgrade.

const PACKAGE_NAMES_SHOWN = 8;
const START_GRACE_MS = 15000; // how long a start may take to show as running

// The start sent from this page, kept here: the card is rebuilt on every poll,
// so the buttons must not forget a start between two polls or after a visit
// to another window. { action, at } until the server reports a run.
let packageStart = null;
let packageAsking = false; // the upgrade confirmation is open

// The action this page has sent and the server has not reported yet, or null.
function startingAction(packages) {
  if (!packageStart) return null;
  const expired = Date.now() - packageStart.at > START_GRACE_MS;
  if (packages.running || expired) packageStart = null;  // the server's state takes over
  return packageStart ? packageStart.action : null;
}

function startPackageRun(action, button) {
  if (packageStart) return;  // no double start; the server would refuse it too
  packageStart = { action, at: Date.now() };
  const idleText = button.textContent;
  button.disabled = true;
  button.textContent = "Starting…";
  postAction("ops/packages", tg ? tg.initData : "", { action })
    .then(() => refresh())
    .catch((error) => {
      // No refresh here: a refresh would clear the message just shown.
      packageStart = null;
      button.disabled = false;
      button.textContent = idleText;
      showAlert(`Package ${action} did not start: ${error.message}`);
    });
}

function checkButton(packages, starting) {
  const button = el("button", "Check for updates", "action-button update-button");
  button.type = "button";
  button.disabled = Boolean(packages.running || starting);
  if (packages.running === "check") button.textContent = "Checking…";
  else if (starting === "check") button.textContent = "Starting…";
  button.addEventListener("click", () => startPackageRun("check", button));
  return button;
}

function upgradeButton(packages, starting) {
  const total = packages.report ? packages.report.total : 0;
  const idleText = `Upgrade ${total} package${total === 1 ? "" : "s"}`;
  const button = el("button", idleText, "action-button update-button");
  button.type = "button";
  button.disabled = Boolean(packages.running || starting);
  if (packages.running === "upgrade") button.textContent = "Upgrading…";
  else if (starting === "upgrade") button.textContent = "Starting…";
  button.addEventListener("click", () => {
    if (packageStart || packageAsking) return;
    const message = `${idleText}? Services being upgraded restart; this can take several minutes.`;
    packageAsking = true;
    askConfirmation(message, (isConfirmed) => {
      packageAsking = false;
      if (isConfirmed) startPackageRun("upgrade", button);
    });
  });
  return button;
}

// Only verified, current counts may offer an upgrade; the server refuses the rest.
function canUpgrade(packages) {
  const report = packages.report;
  return Boolean(report && report.ok && !report.stale && report.total > 0 && !packages.upgrade_blocked);
}

function packageAgo(timestamp) {
  if (typeof timestamp !== "number") return "at an unknown time";
  return `${formatDuration(Math.max(0, Date.now() / 1000 - timestamp))} ago`;
}

function packageNames(report) {
  const names = [...(report.security || []), ...(report.stable || []), ...(report.untested || [])];
  if (!names.length) return [];
  const shown = names.slice(0, PACKAGE_NAMES_SHOWN).join(", ");
  const rest = names.length - PACKAGE_NAMES_SHOWN;
  return [el("div", rest > 0 ? `${shown} and ${rest} more` : shown, "card-note")];
}

function reportRows(report) {
  if (!report) return [muted("Not checked since the dashboard started")];
  if (!report.ok) return [row("Last check", "failed"), el("div", report.error, "card-note")];
  const label = report.stale ? "Available (cached)" : "Available";
  const rows = [row(label, report.total ? String(report.total) : "up to date")];
  if (report.security && report.security.length) rows.push(row("Security", String(report.security.length)));
  rows.push(...packageNames(report));
  // A count from a check is "Checked"; one proven by an upgrade's own status is "Verified".
  const stamp = report.source && report.source !== "check" ? "Verified" : "Checked";
  rows.push(row(stamp, packageAgo(report.checked_at)));
  if (report.stale) {
    rows.push(el("div", "Cached: not verified since the last upgrade. Check for updates before upgrading.", "card-note"));
  }
  if (report.reboot_required) rows.push(row("Reboot", "required to finish updates"));
  return rows;
}

function lastUpgradeRows(upgrade) {
  if (!upgrade) return [];
  const state = upgrade.state || (upgrade.ok ? "completed" : "failed");
  if (state === "accepted" || state === "running") return [row("Last upgrade", "in progress")];
  if (state === "completed") {
    const count = typeof upgrade.upgraded === "number" ? `${upgrade.upgraded} upgraded · ` : "";
    return [row("Last upgrade", `${count}${packageAgo(upgrade.finished_at)}`)];
  }
  if (state === "unknown") {
    return [row("Last upgrade", "outcome unknown"),
      el("div", upgrade.error || "It may still be running; check for updates before upgrading.", "card-note")];
  }
  const rows = [row("Last upgrade", "failed"), el("div", upgrade.error || "no details", "card-note")];
  if (Array.isArray(upgrade.diagnostics) && upgrade.diagnostics.length) {
    rows.push(el("div", `Last output: ${upgrade.diagnostics.slice(-2).join(" | ")}`, "card-note"));
  }
  return rows;
}

function updatesCard(view) {
  const packages = view.packages;
  if (!packages) return card("Updates", muted("Package status unavailable"));
  const starting = startingAction(packages);
  const buttons = [checkButton(packages, starting)];
  if (packages.running === "upgrade" || starting === "upgrade" || canUpgrade(packages)) {
    buttons.push(upgradeButton(packages, starting));
  }
  return card("Updates", ...reportRows(packages.report), ...lastUpgradeRows(packages.last_upgrade), ...buttons);
}
