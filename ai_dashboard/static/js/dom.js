// Element helpers: every value goes through textContent, never HTML.
const STATUS_LABELS = { ok: "OK", warn: "Warning", bad: "Problem", info: "Info" };

function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined && text !== null) node.textContent = String(text);
  if (className) node.className = className;
  return node;
}

function row(label, value) {
  const node = el("div", null, "row");
  node.append(el("span", label), value instanceof Node ? value : el("span", value ?? "—"));
  return node;
}

function card(title, ...children) {
  const node = el("section");
  node.append(el("h2", title), ...children);
  return node;
}

// A card that spans every column of the grid (alerts, long lines).
function wideCard(title, ...children) {
  const node = card(title, ...children);
  node.classList.add("card-wide");
  return node;
}

// Full-width nodes first, cards in their given order, a card-last node at the
// end: a full-width node in the middle would cut the columns of cards in two.
function layoutOrder(nodes) {
  const isLast = (node) => node.classList.contains("card-last");
  const isWide = (node) => node.tagName !== "SECTION" || node.classList.contains("card-wide");
  return [
    ...nodes.filter((node) => isWide(node) && !isLast(node)),
    ...nodes.filter((node) => !isWide(node) && !isLast(node)),
    ...nodes.filter(isLast),
  ];
}

function muted(text) {
  return el("div", text, "muted");
}

function statusDot(status) {
  const node = el("span", null, "status-dot");
  node.dataset.status = status;
  return node;
}

// A dot never stands alone: the text says what its color means.
function statusText(status, text) {
  const node = el("span");
  node.append(statusDot(status), " ", text ?? STATUS_LABELS[status]);
  return node;
}

function openLink(url) {
  const link = el("a", url);
  link.href = url;
  link.addEventListener("click", (event) => {
    if (tg && tg.openLink) {
      event.preventDefault();
      tg.openLink(url);
    }
  });
  return link;
}

function formatBytes(bytes) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(unit ? 1 : 0)} ${units[unit]}`;
}

function formatDuration(seconds) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days) return `${days}d ${hours}h`;
  return hours ? `${hours}h ${minutes}m` : `${minutes}m`;
}

// Telegram's confirm dialog when available, the browser's otherwise.
function askConfirmation(message, onAnswer) {
  if (tg && tg.showConfirm) tg.showConfirm(message, onAnswer);
  else onAnswer(window.confirm(message));
}
