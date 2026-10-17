// The Disk row of Server resources (overview and Ops). One line that opens to
// show the disk meter and the coding agent's task image storage against its
// cap. The figures come from the agent's snapshot: unknown when it has none.
const UNKNOWN_IMAGES = { used_bytes: null, cap_bytes: null, updated_at: null };

function diskRow(disk, images) {
  const percent = Math.round((100 * disk.used) / disk.total);
  const summary = el("summary", null, "row disk-summary");
  summary.append(
    el("span", "Disk"),
    el("span", `${formatBytes(disk.used)} of ${formatBytes(disk.total)} (${percent}%)`),
  );
  const item = rememberDetails(el("details", null, "disk-item"), ["disk"]);
  item.append(summary, usageMeter(disk.used, disk.total, "Disk usage"), imageStorageRow(images || UNKNOWN_IMAGES));
  return item;
}

// Task image storage used against the cap, the snapshot's time beside it.
function imageStorageRow(images) {
  if (images.used_bytes === null) return unknownImagesRow();
  const { used_bytes: used, cap_bytes: cap, updated_at: at } = images;
  const percent = Math.round((100 * used) / cap);
  const asOf = at ? ` · as of ${snapshotClock(at)}` : "";
  const bar = el("div", null, "meter-label");
  bar.append(
    usageMeter(used, cap, "Task image storage usage"),
    el("span", `${formatBytes(used)} of ${formatBytes(cap)} (${percent}%)${asOf}`, "meter-text"),
  );
  return row("Task images", bar);
}

function unknownImagesRow() {
  const node = el("div", null, "disk-images");
  node.append(row("Task images", "unknown"), muted("Update the coding agent to report image storage."));
  return node;
}

function snapshotClock(seconds) {
  return new Date(seconds * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
