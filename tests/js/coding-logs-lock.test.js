// Browser-level tests for the Lock / Unlock logs button of the Coding logs
// window (views/coding-logs-lock.js, views/coding-logs.js). Run: npm test
const test = require("node:test");
const assert = require("node:assert");
const { sleep, lines, UNITS, openLogs, held } = require("./logs-harness");

const lockButton = (page) => page.doc.querySelector(".logs-lock-button");

test("the lock button says what a tap does and reports the state", async () => {
  const page = await openLogs({ lines: lines("a", 1, 20) });
  const lock = lockButton(page);
  assert.strictEqual(lock.type, "button");
  assert.strictEqual(lock.textContent, "Lock logs");
  assert.strictEqual(lock.getAttribute("aria-pressed"), "false");
  assert.match(page.doc.querySelector(".logs-lock-status").textContent, /Updates live/);
  lock.click();
  assert.strictEqual(lock.textContent, "Unlock logs");
  assert.strictEqual(lock.getAttribute("aria-pressed"), "true");
  assert.match(page.doc.querySelector(".logs-lock-status").textContent, /Updates paused/);
  lock.click();
  assert.strictEqual(lock.textContent, "Lock logs");
  assert.strictEqual(lock.getAttribute("aria-pressed"), "false");
});

test("locked: polls are skipped and the log lines are not re-rendered", async () => {
  const server = { lines: lines("a", 1, 20) };
  const page = await openLogs(server);
  const list = page.doc.querySelector(".log-tail-lines");
  const changes = [];
  new page.dom.window.MutationObserver((records) => changes.push(...records))
    .observe(list, { childList: true, subtree: true, characterData: true });
  const before = page.nodes();
  lockButton(page).click();
  server.lines = lines("a", 1, 30);
  const requests = page.requests.length;
  await page.tick();
  await page.tick();
  await sleep(20);
  assert.strictEqual(page.requests.length, requests, "a poll ran while locked");
  assert.deepStrictEqual(page.texts(), lines("a", 1, 20));
  assert.ok(before.every((node, index) => page.nodes()[index] === node));
  assert.deepStrictEqual(changes, []);
});

test("unlock sends one fresh no-store GET, then polling carries on", async () => {
  const server = { lines: lines("a", 1, 20) };
  const page = await openLogs(server);
  lockButton(page).click();
  server.lines = lines("a", 1, 23);
  const requests = page.requests.length;
  lockButton(page).click(); // unlock
  assert.strictEqual(page.requests.length, requests + 1, "unlock did not refresh exactly once");
  const fresh = page.requests.at(-1);
  assert.strictEqual(fresh.cache, "no-store");
  assert.strictEqual(fresh.signal.aborted, false);
  await sleep(20);
  assert.deepStrictEqual(page.texts(), lines("a", 1, 23));
  await page.tick(); // the timer's next poll runs again
  assert.strictEqual(page.requests.length, requests + 2);
});

test("a tap on Lock cancels a slow poll, and Unlock still shows new lines", async () => {
  // The bug report: logs stopped updating after a tap. A slow answer that is
  // in flight when the user taps Lock and then Unlock must not block the
  // refresh that Unlock starts.
  const server = { lines: lines("a", 1, 20) };
  const page = await openLogs(server);
  const slow = held();
  server.answer = slow.answer;
  const pending = page.tick();
  const slowSignal = page.requests.at(-1).signal;
  lockButton(page).click();
  assert.ok(slowSignal.aborted, "the slow poll was not cancelled by Lock");
  server.answer = null; // the server answers promptly again
  server.lines = lines("a", 1, 23);
  lockButton(page).click();
  await sleep(20);
  assert.deepStrictEqual(page.texts(), lines("a", 1, 23), "the lines did not update after unlock");
  slow.release({ ok: true, unit: "ai-coding-agent", units: UNITS, lines: ["stale"] });
  await pending;
  assert.deepStrictEqual(page.texts(), lines("a", 1, 23), "a stale answer changed the lines");
  server.lines = lines("a", 1, 24);
  await page.tick();
  assert.deepStrictEqual(page.texts(), lines("a", 1, 24));
  assert.deepStrictEqual(page.errors, []);
});

test("a hung poll does not freeze the view: Lock and Unlock still work", async () => {
  const server = { lines: lines("a", 1, 5) };
  const page = await openLogs(server);
  server.answer = held().answer; // never answers; only the timeout ends it
  await page.tick();
  assert.strictEqual(page.error().hidden, false);
  lockButton(page).click();
  server.answer = null; // the server answers promptly again
  server.lines = lines("a", 1, 6);
  lockButton(page).click();
  await sleep(20);
  assert.deepStrictEqual(page.texts(), lines("a", 1, 6));
  assert.strictEqual(page.error().hidden, true);
});

test("an answer that arrives while locked does not patch the lines", async () => {
  const server = { lines: lines("a", 1, 5) };
  const page = await openLogs(server);
  const slow = held();
  server.answer = slow.answer;
  const pending = page.tick();
  lockButton(page).click();
  slow.release({ ok: true, unit: "ai-coding-agent", units: UNITS, lines: lines("a", 1, 9) });
  await pending;
  assert.deepStrictEqual(page.texts(), lines("a", 1, 5));
  assert.strictEqual(page.requests.length, 2);
});

test("ordinary taps on the log box do not pause or unpause", async () => {
  const server = { lines: lines("a", 1, 20) };
  const page = await openLogs(server);
  page.box().click();
  await page.tick();
  assert.strictEqual(page.requests.length, 2);
  assert.strictEqual(lockButton(page).getAttribute("aria-pressed"), "false");
});

test("leaving the window resets the lock and an aborted response cannot patch a new visit", async () => {
  const server = { lines: lines("a", 1, 20) };
  const page = await openLogs(server);
  let release;
  server.answer = () => new Promise((resolve) => { release = resolve; });
  const pending = page.tick();
  lockButton(page).click();
  page.dom.window.eval("navigate('/coding')");
  assert.ok(page.requests.at(-1).signal.aborted);
  server.answer = null;
  page.dom.window.eval("navigate('/coding/logs')");
  await sleep(40);
  release({ ok: true, unit: "ai-coding-agent", units: UNITS, lines: ["stale"] });
  await pending;
  assert.strictEqual(lockButton(page).getAttribute("aria-pressed"), "false");
  assert.strictEqual(lockButton(page).textContent, "Lock logs");
  assert.deepStrictEqual(page.texts(), server.lines);
});
