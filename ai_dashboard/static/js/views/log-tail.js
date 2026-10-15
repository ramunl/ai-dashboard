// Log tail box: a scrollable list of log lines that is built once and then
// updated in place. New lines are appended; the box follows the newest line
// only while the user is already at the bottom, otherwise it keeps the scroll
// position and offers a "New lines (N)" button.
//
// The server sends the last N journal lines with no ids or offsets, so new
// lines are found by overlap: the end of the previous answer must match the
// start of the new one in exactly one way. No match (rotation), a shorter
// answer, or several matches (repeated identical lines) replace the whole
// list, keeping the scroll position by its distance from the bottom.

// Close enough to the bottom to count as following: iOS bounce and viewport
// resizes leave a few pixels off.
const LOG_TAIL_BOTTOM_PX = 24;
// Lines kept in the box; older ones are dropped from the top.
const LOG_TAIL_MAX_LINES = 2000;

function createLogTail() {
  const tail = {
    node: el("div", null, "log-tail"),
    error: el("div", null, "card-note log-tail-error"),
    box: el("div", null, "log-tail-box"),
    list: el("div", null, "log-tail-lines"),
    button: el("button", null, "new-lines-button"),
    lastLines: null, // the previous server answer; null: nothing shown yet
    isFollowingTail: true,
    unseen: 0, // lines appended while the user was scrolled up
  };
  tail.error.setAttribute("role", "alert");
  tail.error.hidden = true;
  tail.box.tabIndex = 0;
  tail.box.setAttribute("role", "log");
  tail.button.type = "button";
  tail.button.hidden = true;
  tail.button.addEventListener("click", () => logTailJumpToEnd(tail));
  tail.box.addEventListener("scroll", () => logTailOnScroll(tail), { passive: true });
  tail.box.append(tail.list, tail.button);
  tail.node.append(tail.error, tail.box);
  return tail;
}

function logTailIsAtBottom(box) {
  return box.scrollHeight - box.scrollTop - box.clientHeight <= LOG_TAIL_BOTTOM_PX;
}

function logTailOnScroll(tail) {
  tail.isFollowingTail = logTailIsAtBottom(tail.box);
  if (tail.isFollowingTail) logTailClearUnseen(tail);
}

function logTailScrollToEnd(tail) {
  tail.box.scrollTop = tail.box.scrollHeight;
}

function logTailJumpToEnd(tail) {
  tail.isFollowingTail = true;
  logTailScrollToEnd(tail);
  logTailClearUnseen(tail);
}

function logTailClearUnseen(tail) {
  tail.unseen = 0;
  tail.button.hidden = true;
}

function logTailMarkUnseen(tail, count) {
  tail.unseen += count;
  tail.button.textContent = `New lines (${tail.unseen})`;
  tail.button.hidden = false;
}

function logTailLine(text) {
  return el("div", text, "log-tail-line");
}

function logTailSameLines(a, b) {
  return a.length === b.length && a.every((line, index) => line === b[index]);
}

// How many leading lines of `next` were already the trailing lines of `last`:
// the overlap length, or -1 when there is none or more than one fits.
function logTailOverlap(last, next) {
  let found = -1;
  for (let size = Math.min(last.length, next.length); size > 0; size--) {
    const start = last.length - size;
    let isMatch = true;
    for (let i = 0; i < size && isMatch; i++) isMatch = last[start + i] === next[i];
    if (!isMatch) continue;
    if (found !== -1) return -1; // ambiguous: repeated identical lines
    found = size;
  }
  return found;
}

// Drop the oldest lines past the cap without moving what the user looks at.
function logTailTrim(tail) {
  let removed = 0;
  while (tail.list.childElementCount > LOG_TAIL_MAX_LINES) {
    const first = tail.list.firstElementChild;
    removed += first.offsetHeight || 0;
    first.remove();
  }
  if (removed && !tail.isFollowingTail) tail.box.scrollTop -= removed;
}

function logTailReplace(tail, lines) {
  const box = tail.box;
  const fromBottom = box.scrollHeight - box.scrollTop;
  tail.list.replaceChildren(...lines.map(logTailLine));
  logTailTrim(tail);
  if (tail.isFollowingTail) logTailScrollToEnd(tail);
  else box.scrollTop = Math.max(0, box.scrollHeight - fromBottom);
}

// Lines added below the visible ones leave scrollTop as it is.
function logTailAppend(tail, lines) {
  tail.list.append(...lines.map(logTailLine));
  logTailTrim(tail);
  if (tail.isFollowingTail) logTailScrollToEnd(tail);
  else logTailMarkUnseen(tail, lines.length);
}

// Show a new server answer (the last lines of the log, oldest first).
// Returns how the box changed: "same", "append" or "replace".
function logTailUpdate(tail, lines) {
  logTailShowError(tail, "");
  const last = tail.lastLines;
  tail.lastLines = lines.slice();
  if (last && logTailSameLines(last, lines)) return "same";
  const overlap = last && last.length && lines.length >= last.length ? logTailOverlap(last, lines) : -1;
  if (overlap > 0) {
    logTailAppend(tail, lines.slice(overlap));
    return "append";
  }
  logTailReplace(tail, lines);
  // Without an overlap the exact count is unknown; at least one line is new.
  if (!tail.isFollowingTail && last) logTailMarkUnseen(tail, Math.max(lines.length - last.length, 1));
  return "replace";
}

// A failed poll: say so above the box and keep the lines already shown.
function logTailShowError(tail, message) {
  tail.error.textContent = message || "";
  tail.error.hidden = !message;
}
