// Ops › Server card: reboot the whole server. Two confirmations; the server
// refuses while an upgrade, cleanup, tool update or deployment is running.

const REBOOT_WATCH_MS = 3 * 60 * 1000;
let rebootRequestedAt = 0;  // ms; 0 when no reboot is pending

function isRebootPending(view) {
  if (!rebootRequestedAt) return false;
  const age = Date.now() - rebootRequestedAt;
  const uptime = view.resources && view.resources.uptime_seconds;
  // Done once the server has been up for less time than has passed since
  // the request, or after a few minutes whatever happened.
  const isBack = typeof uptime === "number" && uptime * 1000 < age;
  if (isBack || age > REBOOT_WATCH_MS) {
    rebootRequestedAt = 0;
    return false;
  }
  return true;
}

function rebootWarning(view) {
  const isCoding = view.agents.some((agent) => /^running\b/.test(agent.detail || ""));
  return isCoding ? " A coding task is running and will be interrupted." : "";
}

async function requestReboot(button) {
  button.disabled = true;  // no double start
  button.textContent = "Rebooting…";
  try {
    await postAction("ops/reboot", tg ? tg.initData : "", { confirm: "reboot" });
    rebootRequestedAt = Date.now();
  } catch (error) {
    button.disabled = false;
    button.textContent = "Reboot server";
    showAlert(`Reboot did not start: ${error.message}`);
  }
}

function rebootButton(view) {
  const button = el("button", "Reboot server", "danger-button reboot-button");
  button.type = "button";
  if (isRebootPending(view)) {
    button.disabled = true;
    button.textContent = "Rebooting…";
  }
  button.addEventListener("click", () => {
    const first = `Reboot the server? Every agent, the dashboard and the proxy go down for about a minute.${rebootWarning(view)}`;
    askConfirmation(first, (isConfirmed) => {
      if (!isConfirmed) return;
      askConfirmation("Really reboot now?", (isSure) => {
        if (isSure) requestReboot(button);
      });
    });
  });
  return button;
}

function rebootCards(view) {
  const control = view.service_control;
  if (!control || !control.ok) return [];  // the Services card says why
  const rows = [];
  const report = view.packages && view.packages.report;
  if (report && report.ok && report.reboot_required) {
    rows.push(el("div", "A reboot is required to finish installed updates.", "card-note"));
  }
  return [card("Server", ...rows, rebootButton(view))];
}
