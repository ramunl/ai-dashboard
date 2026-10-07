// Ops › Updates card: system packages. "Check" refreshes the package indexes
// and lists what can be upgraded; "Upgrade" installs it. Both run in the ops
// agent's ai-packages command; this card only starts them and shows the result.

const PACKAGE_NAMES_SHOWN = 8;

function startPackageRun(action, button, idleText) {
  button.disabled = true;  // no double start; the server would refuse it too
  button.textContent = "Starting…";
  postAction("ops/packages", tg ? tg.initData : "", { action })
    .then(() => refresh())
    .catch((error) => {
      button.disabled = false;
      button.textContent = idleText;
      showAlert(`Package ${action} did not start: ${error.message}`);
    });
}

function checkButton(packages) {
  const idleText = "Check for updates";
  const button = el("button", idleText, "action-button update-button");
  button.type = "button";
  button.disabled = Boolean(packages.running);
  if (packages.running === "check") button.textContent = "Checking…";
  button.addEventListener("click", () => startPackageRun("check", button, idleText));
  return button;
}

function upgradeButton(packages) {
  const total = packages.report.total;
  const idleText = `Upgrade ${total} package${total === 1 ? "" : "s"}`;
  const button = el("button", idleText, "action-button update-button");
  button.type = "button";
  button.disabled = Boolean(packages.running);
  if (packages.running === "upgrade") button.textContent = "Upgrading…";
  button.addEventListener("click", () => {
    const message = `${idleText}? Services being upgraded restart; this can take several minutes.`;
    askConfirmation(message, (isConfirmed) => {
      if (isConfirmed) startPackageRun("upgrade", button, idleText);
    });
  });
  return button;
}

function packageNames(report) {
  const names = [...report.security, ...report.stable, ...report.untested];
  if (!names.length) return [];
  const shown = names.slice(0, PACKAGE_NAMES_SHOWN).join(", ");
  const rest = names.length - PACKAGE_NAMES_SHOWN;
  return [el("div", rest > 0 ? `${shown} and ${rest} more` : shown, "card-note")];
}

function reportRows(report) {
  if (!report) return [muted("Not checked since the dashboard started")];
  if (!report.ok) return [row("Last check", "failed"), el("div", report.error, "card-note")];
  const ago = formatDuration(Math.max(0, Date.now() / 1000 - report.checked_at));
  const rows = [row("Available", report.total ? String(report.total) : "up to date")];
  if (report.security.length) rows.push(row("Security", String(report.security.length)));
  rows.push(...packageNames(report), row("Checked", `${ago} ago`));
  if (report.reboot_required) rows.push(row("Reboot", "required to finish updates"));
  return rows;
}

function lastUpgradeRows(lastUpgrade) {
  if (!lastUpgrade) return [];
  if (!lastUpgrade.ok) return [row("Last upgrade", "failed"), el("div", lastUpgrade.error, "card-note")];
  const ago = formatDuration(Math.max(0, Date.now() / 1000 - lastUpgrade.finished_at));
  return [row("Last upgrade", `${lastUpgrade.upgraded} upgraded · ${ago} ago`)];
}

function updatesCard(view) {
  const packages = view.packages;
  if (!packages) return card("Updates", muted("Package status unavailable"));
  const buttons = [checkButton(packages)];
  const hasUpgrades = packages.report && packages.report.ok && packages.report.total > 0;
  if (hasUpgrades) buttons.push(upgradeButton(packages));
  return card("Updates", ...reportRows(packages.report), ...lastUpgradeRows(packages.last_upgrade), ...buttons);
}
