// Browser-level tests for scroll position in the Coding logs window while the
// Lock button is used: a reader's place survives a lock and an unlock refresh,
// and the box follows the newest line only when unlocked and at the bottom.
// Run: npm test
const test = require("node:test");
const assert = require("node:assert");
const { sleep, lines, openLogs } = require("./coding-logs-page");

// 20 lines are 200 px; the box shows 100 px, so the bottom is scrollTop 100.
test("scroll position survives a lock, a journal update, and an unlock", async () => {
  const server = { lines: lines("a", 1, 20) };
  const page = await openLogs(server);
  page.scrollTo(30); // the user reads older lines
  page.lock().click();
  server.lines = lines("a", 3, 22); // the journal moved on while locked
  await page.tick(); // skipped, nothing changes
  assert.strictEqual(page.box().scrollTop, 30);
  page.lock().click();
  await sleep(10);
  assert.deepStrictEqual(page.texts(), lines("a", 1, 22));
  assert.strictEqual(page.box().scrollTop, 30);
  assert.strictEqual(page.button().hidden, false);
  assert.strictEqual(page.button().textContent, "New lines (2)");
});

test("the window keeps the reader's place when a poll replaces the lines", async () => {
  const server = { lines: lines("a", 1, 20) };
  const page = await openLogs(server);
  page.scrollTo(30);
  server.lines = lines("b", 1, 25); // a rotated log replaces every line
  await page.tick();
  assert.strictEqual(page.box().scrollTop, 30);
  assert.strictEqual(page.button().hidden, false);
});

test("unlocking at the bottom follows the newest line", async () => {
  const server = { lines: lines("a", 1, 20) };
  const page = await openLogs(server);
  assert.strictEqual(page.box().scrollTop, 100);
  page.lock().click();
  server.lines = lines("a", 1, 23);
  page.lock().click();
  await sleep(10);
  assert.strictEqual(page.box().scrollTop, 130);
  assert.strictEqual(page.button().hidden, true);
});

test("a place the user chose while locked is kept on unlock", async () => {
  const server = { lines: lines("a", 1, 20) };
  const page = await openLogs(server);
  page.lock().click();
  page.scrollTo(50); // scrolling a locked view is allowed
  server.lines = lines("a", 1, 24);
  page.lock().click();
  await sleep(10);
  assert.strictEqual(page.box().scrollTop, 50);
  assert.strictEqual(page.button().textContent, "New lines (4)");
});
