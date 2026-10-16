// Browser-level tests for the Coding logs window (views/coding-logs.js and
// views/log-tail.js): loading, in-place updates, poll hygiene and errors.
// Scroll and lock tests are in coding-logs-scroll.test.js and
// coding-logs-lock.test.js. Run: npm test
const test = require("node:test");
const assert = require("node:assert");
const { sleep, lines, UNITS, openLogs, held } = require("./logs-harness");

test("the window loads the coding agent's lines and follows the tail", async () => {
  const server = { lines: lines("a", 1, 20) };
  const page = await openLogs(server);
  assert.strictEqual(page.doc.getElementById("title").textContent, "Coding logs");
  assert.deepStrictEqual(page.texts(), server.lines);
  assert.strictEqual(page.box().scrollTop, 100); // 200 px of lines, 100 px box
  assert.strictEqual(page.button().hidden, true);
  assert.deepStrictEqual(page.errors, []);
});

test("repeated identical lines are replaced, not guessed", async () => {
  const server = { lines: ["same", "same", "same"] };
  const page = await openLogs(server);
  server.lines = ["same", "same", "same", "same"];
  await page.tick();
  assert.deepStrictEqual(page.texts(), server.lines);
});

test("a shorter answer replaces the lines", async () => {
  const server = { lines: lines("a", 1, 20) };
  const page = await openLogs(server);
  server.lines = lines("a", 15, 20);
  await page.tick();
  assert.deepStrictEqual(page.texts(), server.lines);
});

test("a tick is skipped while the previous request is in flight", async () => {
  const server = { lines: lines("a", 1, 5) };
  const page = await openLogs(server);
  const gate = held();
  server.answer = gate.answer;
  const first = page.tick();
  await page.tick();
  await page.tick();
  assert.strictEqual(page.requests.length, 2); // the first load and one poll
  gate.release({ ok: true, unit: "ai-coding-agent", units: UNITS, lines: lines("a", 1, 6) });
  await first;
  assert.deepStrictEqual(page.texts(), lines("a", 1, 6));
  server.answer = null;
  await page.tick();
  assert.strictEqual(page.requests.length, 3);
});

test("a hung request times out with an error and keeps the lines", async () => {
  const server = { lines: lines("a", 1, 5) };
  const page = await openLogs(server);
  server.answer = held().answer;
  await page.tick();
  assert.strictEqual(page.error().hidden, false);
  assert.match(page.error().textContent, /Logs not updated: no answer within 0.4 s/);
  assert.deepStrictEqual(page.texts(), lines("a", 1, 5));
  server.answer = null;
  await page.tick(); // the next poll works again
  assert.strictEqual(page.error().hidden, true);
});

test("a server error is shown above the kept lines", async () => {
  const server = { lines: lines("a", 1, 5) };
  const page = await openLogs(server);
  server.answer = async () => ({ ok: false, error: "journalctl is not available or timed out", units: UNITS, unit: "ai-coding-agent" });
  await page.tick();
  assert.match(page.error().textContent, /journalctl is not available/);
  assert.deepStrictEqual(page.texts(), lines("a", 1, 5));
});

test("leaving the window cancels the poll and ignores its late answer", async () => {
  const server = { lines: lines("a", 1, 5) };
  const page = await openLogs(server);
  const box = page.box();
  const gate = held();
  server.answer = gate.answer;
  const pending = page.tick();
  page.dom.window.eval("navigate('/coding')");
  assert.ok(page.requests[page.requests.length - 1].signal.aborted, "the poll was not cancelled");
  await pending;
  assert.deepStrictEqual([...box.querySelectorAll(".log-tail-line")].map((n) => n.textContent), lines("a", 1, 5));
  // The error note sits next to the box, in the (now detached) log tail.
  assert.strictEqual(box.closest(".log-tail").querySelector(".log-tail-error").hidden, true);
  const count = page.requests.length;
  await page.tick(); // a timer tick after leaving does not poll
  assert.strictEqual(page.requests.length, count);
  await sleep(40);
  assert.strictEqual(page.doc.getElementById("title").textContent, "Coding agent");
});

test("the first answer for another unit is asked again for the coding agent", async () => {
  const server = { lines: lines("a", 1, 3) };
  server.answer = async (query) => {
    const unit = new URLSearchParams(query.split("?")[1]).get("unit") || "ai-pm-agent";
    return { ok: true, unit, units: ["ai-pm-agent", ...UNITS], lines: [`${unit} line`] };
  };
  const page = await openLogs(server);
  await sleep(20);
  assert.deepStrictEqual(page.requests.map((r) => r.query), ["logs?unit=&errors=0", "logs?unit=ai-coding-agent&errors=0"]);
  assert.deepStrictEqual(page.texts(), ["ai-coding-agent line"]);
});
