// Encrypted local backup and delivery to the owner's Ops bot chat.
function backupsCard(view) {
  const state = view.backups;
  if (!state || !state.ok) return card("Backups", muted(state?.error || "Backup status unavailable"));
  const rows = [];
  const last = state.last_ok;
  if (last) {
    const age = Math.max(0, Date.now() / 1000 - last.at);
    rows.push(row("Last saved", `${formatDuration(age)} ago`), row("Size", formatBytes(last.bytes)));
    if (age > 2 * 86400) rows.push(el("div", "No successful backup for over two days", "card-note"));
    if (last.skipped?.length) rows.push(el("div", `Missing: ${last.skipped.join(", ")}`, "card-note"));
  } else rows.push(muted("No successful backup yet"));
  if (state.last && !state.last.ok) rows.push(el("div", state.last.error || "Last backup failed", "card-note"));
  if (state.delivery) rows.push(el("div", `Last dashboard request: ${state.delivery.message}`, "card-note"));
  rows.push(muted("Creates an encrypted archive and sends it to your Ops bot chat."));
  const button = el("button", state.running ? "Backing up…" : "Back up now", "action-button");
  button.type = "button";
  button.disabled = Boolean(state.running);
  button.addEventListener("click", async () => {
    button.disabled = true;
    button.textContent = "Backing up…";
    try {
      await postAction("ops/backup", tg ? tg.initData : "");
      refresh();
    } catch (error) {
      button.disabled = false;
      button.textContent = "Back up now";
      showAlert(`Backup did not start: ${error.message}`);
    }
  });
  return card("Backups", ...rows, button);
}
