// Browser-level tests for the Coding logs Lock/Unlock button (views/coding-logs-lock.js):
// a locked view does not poll or re-render, unlocking fetches once and resumes
// polling, and a slow or hanging server never freezes the button.
// Run: npm test
const test = require("node:test");
const assert = require("node:assert");
const { sleep, lines, UNITS, TEST_TIMEOUT_MS, openLogs, held } = require("./coding-logs-page");

// Records what the page logs to the console.debug channel.
function captureDebug(page) {
  const messages = [];
  page.dom.window.console.debug = (...args) => messages.push(args.join(" "));
  return messages;
}

// Reproduces "logs not updating after tap": the poll is slow, the user taps
// Lock and then Unlock, and the lines must show up without waiting for the
// next timer tick.
test("a slow poll, then Lock and Unlock taps: the lines update at once", async () => {
  const server = { lines: lines("a", 1, 20) };
  const page = await openLogs(server);
  const gate = held();
  server.answer = gate.answer;
  const pending = page.tick(); // a slow poll is in flight
  page.lock().click(); // the user taps Lock
  server.answer = null;
  server.lines = lines("a", 1, 25);
  page.lock().click(); // and Unlock
  await sleep(20);
  assert.deepStrictEqual(page.texts(), server.lines);
  assert.strictEqual(page.requests.length, 3); // first load, the slow poll, the unlock fetch
  await pending;
  assert.deepStrictEqual(page.texts(), server.lines);
  assert.deepStrictEqual(page.errors, []);
});

test("the lock button reads Lock logs / Unlock logs and reports its state", async () => {
  const page = await openLogs({ lines: lines("a", 1, 5) });
  const lock = page.lock();
  assert.strictEqual(lock.textContent, "Lock logs");
  assert.strictEqual(lock.getAttribute("aria-pressed"), "false");
  lock.click();
  assert.strictEqual(lock.textContent, "Unlock logs");
  assert.strictEqual(lock.getAttribute("aria-pressed"), "true");
  assert.match(page.doc.querySelector(".logs-lock-status").textContent, /Updates paused/);
  lock.click();
  assert.strictEqual(lock.textContent, "Lock logs");
  assert.strictEqual(lock.getAttribute("aria-pressed"), "false");
  assert.match(page.doc.querySelector(".logs-lock-status").textContent, /Updates live/);
});

test("locked: polls are skipped with a logged reason and the lines are not re-rendered", async () => {
  const server = { lines: lines("a", 1, 20) };
  const page = await openLogs(server);
  const debug = captureDebug(page);
  const before = page.nodes();
  const changes = [];
  new page.dom.window.MutationObserver((records) => changes.push(...records))
    .observe(page.box(), { childList: true, subtree: true, characterData: true });
  page.lock().click();
  const count = page.requests.length;
  server.lines = lines("a", 1, 30);
  await page.tick();
  await page.tick();
  assert.strictEqual(page.requests.length, count, "a locked tick sent a request");
  assert.deepStrictEqual(page.texts(), lines("a", 1, 20));
  assert.ok(before.every((node, index) => page.nodes()[index] === node), "lines were re-rendered");
  await sleep(10);
  assert.deepStrictEqual(changes, []);
  assert.ok(debug.some((message) => /Logs poll skipped: Updates paused/.test(message)));
});

test("unlocking drops nothing stale, fetches once without cache, and polling resumes", async () => {
  const server = { lines: lines("a", 1, 20) };
  const page = await openLogs(server);
  page.lock().click();
  const count = page.requests.length;
  page.lock().click();
  await sleep(10);
  assert.strictEqual(page.requests.length, count + 1, "unlock did not fetch exactly once");
  assert.strictEqual(page.requests.at(-1).cache, "no-store");
  assert.strictEqual(page.requests.at(-1).signal.aborted, false);
  server.lines = lines("a", 1, 21);
  await page.tick();
  assert.deepStrictEqual(page.texts(), server.lines);
  assert.strictEqual(page.requests.length, count + 2);
});

test("a hanging poll does not freeze the lock button; it times out and the next poll works", async () => {
  const server = { lines: lines("a", 1, 5) };
  const page = await openLogs(server);
  server.answer = held().answer;
  const pending = page.tick(); // hangs until the request timeout
  page.lock().click();
  assert.strictEqual(page.lock().textContent, "Unlock logs");
  page.lock().click();
  assert.strictEqual(page.lock().textContent, "Lock logs");
  await sleep(TEST_TIMEOUT_MS + 100);
  await pending;
  server.answer = null;
  await page.tick();
  assert.deepStrictEqual(page.texts(), lines("a", 1, 5));
  assert.strictEqual(page.error().hidden, true);
});

test("a hung fetch made by Unlock is shown as an error once it times out", async () => {
  const server = { lines: lines("a", 1, 5) };
  const page = await openLogs(server);
  page.lock().click();
  server.answer = held().answer;
  page.lock().click(); // unlock: one fetch that hangs
  await sleep(TEST_TIMEOUT_MS + 100);
  assert.match(page.error().textContent, /Logs not updated: no answer within 0.4 s/);
  assert.deepStrictEqual(page.texts(), lines("a", 1, 5));
  assert.strictEqual(page.error().hidden, false);
  server.answer = async () => ({ ok: true, unit: "ai-coding-agent", units: UNITS, lines: lines("a", 1, 6) });
  await page.tick();
  assert.strictEqual(page.error().hidden, true);
});
