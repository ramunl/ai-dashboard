// Browser-level tests for scroll keeping in the Coding logs window: the log
// box keeps its place while lines update, follows the tail only at the bottom,
// offers "New lines", and survives a lock / unlock cycle. Run: npm test
const test = require("node:test");
const assert = require("node:assert");
const { sleep, lines, openLogs } = require("./logs-harness");

test("new lines are appended without re-rendering or moving the scroll", async () => {
  const server = { lines: lines("a", 1, 20) };
  const page = await openLogs(server);
  const before = page.nodes();
  page.scrollTo(30); // the user reads older lines
  server.lines = lines("a", 3, 22); // the journal window slid by two lines
  await page.tick();
  assert.deepStrictEqual(page.texts(), lines("a", 1, 22));
  assert.ok(before.every((node, index) => page.nodes()[index] === node), "old line nodes were replaced");
  assert.strictEqual(page.box().scrollTop, 30);
  assert.strictEqual(page.button().hidden, false);
  assert.strictEqual(page.button().textContent, "New lines (2)");
  server.lines = lines("a", 4, 23);
  await page.tick();
  assert.strictEqual(page.button().textContent, "New lines (3)");
  assert.strictEqual(page.box().scrollTop, 30);
});

test("following the tail scrolls to new lines; unchanged answers touch nothing", async () => {
  const server = { lines: lines("a", 1, 20) };
  const page = await openLogs(server);
  const before = page.nodes();
  await page.tick();
  assert.ok(before.every((node, index) => page.nodes()[index] === node));
  server.lines = lines("a", 1, 23);
  await page.tick();
  assert.strictEqual(page.box().scrollTop, 130);
  assert.strictEqual(page.button().hidden, true);
});

test("the New lines button jumps down and resumes following; scrolling down clears it", async () => {
  const server = { lines: lines("a", 1, 20) };
  const page = await openLogs(server);
  page.scrollTo(0);
  server.lines = lines("a", 1, 22);
  await page.tick();
  page.button().click();
  assert.strictEqual(page.box().scrollTop, 120);
  assert.strictEqual(page.button().hidden, true);
  server.lines = lines("a", 1, 24);
  await page.tick();
  assert.strictEqual(page.box().scrollTop, 140); // following again
  page.scrollTo(0);
  server.lines = lines("a", 1, 25);
  await page.tick();
  assert.strictEqual(page.button().hidden, false);
  page.scrollTo(page.box().scrollHeight); // the user scrolls down by hand
  assert.strictEqual(page.button().hidden, true);
});

test("a rotated log replaces the lines and keeps the scroll position", async () => {
  const server = { lines: lines("a", 1, 20) };
  const page = await openLogs(server);
  page.scrollTo(30); // 170 px above the bottom
  server.lines = lines("b", 1, 25);
  await page.tick();
  assert.deepStrictEqual(page.texts(), server.lines);
  assert.strictEqual(page.box().scrollTop, 30);
  assert.strictEqual(page.button().hidden, false);
});

test("the scroll position survives a lock and unlock with new lines", async () => {
  const server = { lines: lines("a", 1, 20) };
  const page = await openLogs(server);
  const lock = page.doc.querySelector(".logs-lock-button");
  page.scrollTo(30);
  lock.click();
  server.lines = lines("a", 3, 22);
  lock.click(); // unlock: one fresh answer
  await sleep(20);
  assert.deepStrictEqual(page.texts(), lines("a", 1, 22));
  assert.strictEqual(page.box().scrollTop, 30);
  assert.strictEqual(page.button().textContent, "New lines (2)");
});

test("patch restores document and box scroll even if layout moves them", async () => {
  const server = { lines: lines("a", 1, 20) };
  const page = await openLogs(server);
  const win = page.dom.window;
  win.scrollTo(0, 350);
  page.scrollTo(30);
  const list = page.doc.querySelector(".log-tail-lines");
  const append = list.append.bind(list);
  list.append = (...nodes) => {
    append(...nodes);
    win.scrollTo(0, 0); // simulate browser anchoring/layout during a patch
    page.box().scrollTop = 0;
  };
  server.lines = lines("a", 1, 23);
  await page.tick();
  assert.strictEqual(win.scrollY, 350);
  assert.strictEqual(page.box().scrollTop, 30);
});

test("a window refresh keeps the log box attached", async () => {
  const server = { lines: lines("a", 1, 20) };
  const page = await openLogs(server);
  const box = page.box();
  page.scrollTo(30);
  const changes = [];
  new page.dom.window.MutationObserver((records) => changes.push(...records))
    .observe(page.doc.getElementById("view"), { childList: true });
  page.dom.window.eval("refresh()");
  await sleep(40);
  assert.deepStrictEqual(changes, []);
  assert.strictEqual(page.box(), box);
  assert.strictEqual(box.scrollTop, 30);
});
