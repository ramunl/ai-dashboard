// Browser-level tests for the Disk row (views/disk-row.js) and the image picker
// of the Make task sheet (views/coding-create-task.js): the always-visible disk row with
// the task image storage against its cap, the picker's limits, and uploads that
// are slow or never answer. Run: npm test
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM, VirtualConsole } = require("jsdom");

const STATIC = path.join(__dirname, "../../ai_dashboard/static");
const TEST_TIMEOUT_MS = 400;
const UPLOAD_TIMEOUT_MS = 150;

// The page with its scripts inlined, and the two timeouts shortened.
function pageSource() {
  return fs
    .readFileSync(path.join(STATIC, "index.html"), "utf8")
    .replace('<script src="/static/vendor/telegram-web-app.js"></script>', "")
    .replace('<link rel="stylesheet" href="/static/styles.css">', "")
    .replace(/<script src="\/static\/(.+?)"><\/script>/g, (_tag, file) => {
      const code = fs.readFileSync(path.join(STATIC, file), "utf8")
        .replace("const FETCH_TIMEOUT_MS = 15000;", `const FETCH_TIMEOUT_MS = ${TEST_TIMEOUT_MS};`)
        .replace("const IMAGE_UPLOAD_TIMEOUT_MS = 60 * 1000;", `const IMAGE_UPLOAD_TIMEOUT_MS = ${UPLOAD_TIMEOUT_MS};`);
      return `<script>${code}</script>`;
    });
}
const PAGE = pageSource();
if (!PAGE.includes(`const IMAGE_UPLOAD_TIMEOUT_MS = ${UPLOAD_TIMEOUT_MS};`)) {
  throw new Error("the upload timeout in coding-create-task.js changed; update this test");
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// A request that never answers until the page aborts it.
const hang = (signal) => new Promise((_resolve, reject) => {
  signal.addEventListener("abort", () => reject(new Error("aborted")));
});
const answer = (body, status = 200) => ({ ok: status < 300, status, json: async () => body });

const LAUNCHER = {
  resources: { hostname: "vps", cpus: 1, load: [0.1, 0.1, 0.1],
    memory: { total: 1e9, available: 5e8 }, disk: { total: 2e10, used: 1e10, free: 1e10 }, uptime_seconds: 3600 },
  services: [{ unit: "ai-pm-agent", load_state: "loaded", state: "active", restarts: 0, errors_last_hour: 0 }],
  agents: [
    { name: "coding", label: "Coding agent", path: "coding", service: "active", problem: null, detail: "idle" },
    { name: "pm", label: "PM agent", path: "pm", service: "active", problem: null, detail: "cc · 1 open" },
  ],
  problems: [],
};
const KNOWN_IMAGES = { used_bytes: 1.2 * 1024 ** 3, cap_bytes: 5 * 1024 ** 3, updated_at: 1792145939 };
const PROJECTS = [
  { name: "ai-dashboard", repository: "o/ai-dashboard", active: true },
  { name: "ai-ops-agent", repository: "o/ai-ops-agent", active: false },
];
const CODING = { agent: "coding", service: "active", problem: null, age_seconds: 1, snapshot: {
  format: 1, updated_at: 1792145939, running: null, queue: [], pending_plan: null, pending_branch: null,
  awaiting_bugfix_answer: false, planning_agent: "codex", implementation_agent: "codex", verbosity: "concise",
  last_execution: null, project: { name: "ai-dashboard", repository: "o/ai-dashboard", branch: "main" },
  version: "v", core: "core: v1.1", tasks: [], setup: { projects: PROJECTS, actions: [] } } };

// options.launcher: the launcher data; options.onPost(api, init): the answer
// to a POST (the upload or an action), a promise allowed.
async function openPage(url, options = {}) {
  const posts = [];
  const bodies = [];
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error) => errors.push(error.message));
  const dom = new JSDOM(PAGE, {
    url: "https://dashboard.test" + url, runScripts: "dangerously", pretendToBeVisual: true,
    virtualConsole,
    beforeParse(window) {
      window.Telegram = { WebApp: { initData: "signed", ready() {}, expand() {}, openLink() {},
        BackButton: { show() {}, hide() {}, onClick() {} } } };
      window.URL.createObjectURL = (file) => `blob:${file.name}`;
      window.URL.revokeObjectURL = () => {};
      window.fetch = async (api, init = {}) => {
        if (init.method === "POST") {
          posts.push(api);
          bodies.push(typeof init.body === "string" ? JSON.parse(init.body) : init.body);
          if (options.onPost) return options.onPost(api, init);
          return answer({ id: "beef0001" }, 202);
        }
        await sleep(10);
        const name = api.split("/").pop();
        return answer(name === "launcher" ? (options.launcher || LAUNCHER) : (options.coding || CODING));
      };
      window.setInterval = () => 0;  // no timer: each test refreshes by hand
    },
  });
  await sleep(60);
  return { dom, doc: dom.window.document, posts, bodies, errors };
}

const confirmWith = (page, answer) => {
  const asked = [];
  page.dom.window.Telegram.WebApp.showConfirm = (message, callback) => { asked.push(message); callback(answer); };
  return asked;
};
const buttonNamed = (page, text) => [...page.doc.querySelectorAll("button")].find((b) => b.textContent === text);
const alertText = (page) => page.doc.getElementById("alert").textContent;

// The Make task sheet, opened the way the PM window's Make task does it.
async function openSheet(options = {}) {
  const page = await openPage("/tasks", options);
  await page.dom.window.eval(`taskDraft = { text: "Normal task", todo: "-" }; refresh();`);
  await sleep(60);
  return page;
}
const sheetOf = (page) => [...page.doc.querySelectorAll("main section")]
  .find((node) => node.querySelector("h2") && node.querySelector("h2").textContent === "Make a task");
const pickerInput = (page) => sheetOf(page).querySelector('input[type="file"]');
const previews = (page) => [...sheetOf(page).querySelectorAll("figure.task-image")];
const makeFile = (page, name, type, size = 10) => {
  const file = new page.dom.window.File(["x"], name, { type });
  if (size !== file.size) Object.defineProperty(file, "size", { value: size });
  return file;
};
function pick(page, files) {
  const input = pickerInput(page);
  Object.defineProperty(input, "files", { configurable: true, value: files });
  input.dispatchEvent(new page.dom.window.Event("change"));
}

test("disk and task image storage are always visible, including after refresh", async () => {
  const page = await openPage("/", { launcher: { ...LAUNCHER, images: KNOWN_IMAGES } });
  await sleep(40);
  const disk = page.doc.querySelector(".disk-item");
  assert.ok(disk, "disk information is present");
  assert.strictEqual(disk.tagName, "DIV");
  assert.strictEqual(disk.querySelector("summary"), null);
  assert.deepStrictEqual([...disk.querySelector(".disk-summary").querySelectorAll("span")].map((s) => s.textContent),
    ["Disk", "9.3 GB of 18.6 GB (50%)"]);
  const label = disk.querySelector(".meter-label .meter-text");
  assert.match(label.textContent, /^1\.2 GB of 5\.0 GB \(24%\) · as of \d{1,2}:\d{2}/);
  const bar = disk.querySelector('progress[aria-label="Task image storage usage"]');
  assert.ok(bar, "the image bar is labelled for assistive tech");
  assert.strictEqual(bar.parentElement, label.parentElement, "the text sits beside its bar");
  assert.strictEqual(Number(bar.max), KNOWN_IMAGES.cap_bytes);
  assert.strictEqual(Number(bar.value), KNOWN_IMAGES.used_bytes);
  await page.dom.window.eval("refresh()");
  await sleep(60);
  assert.strictEqual(page.doc.querySelector(".disk-item").tagName, "DIV");
  assert.ok(page.doc.querySelector('.disk-item progress[aria-label="Task image storage usage"]'));
  assert.deepStrictEqual(page.errors, []);
});

test("an agent without the image field shows the image storage as unknown, not a guess", async () => {
  for (const launcher of [LAUNCHER, { ...LAUNCHER, images: { used_bytes: null, cap_bytes: null, updated_at: null } }]) {
    const page = await openPage("/", { launcher });
    await sleep(40);
    const images = page.doc.querySelector(".disk-item .disk-images");
    assert.match(images.textContent, /Task images\s*unknown/);
    assert.strictEqual(images.querySelector("progress"), null);
    assert.deepStrictEqual(page.errors, []);
  }
});

test("the picker takes up to three images, accepts only image files, and names them as text", async () => {
  const page = await openSheet();
  const input = pickerInput(page);
  assert.strictEqual(input.accept, "image/*");
  assert.strictEqual(input.multiple, true);
  const hostile = makeFile(page, '<img src=x onerror="alert(1)">.png', "image/png");
  pick(page, [makeFile(page, "a.png", "image/png"), makeFile(page, "b.gif", "image/gif"), hostile,
    makeFile(page, "d.png", "image/png")]);
  await sleep(40);
  assert.strictEqual(previews(page).length, 3);
  assert.strictEqual(alertText(page), "A task takes up to 3 images.");
  const names = previews(page).map((figure) => figure.querySelector("figcaption").textContent);
  assert.deepStrictEqual(names, ["a.png", "b.gif", '<img src=x onerror="alert(1)">.png']);
  assert.strictEqual(sheetOf(page).querySelectorAll("figure img").length, 3, "a file name never becomes markup");
  assert.strictEqual(previews(page)[0].querySelector("img").src, "blob:a.png");
  buttonNamed(page, "Remove image").click();
  await sleep(40);
  assert.strictEqual(previews(page).length, 2);
  pick(page, [makeFile(page, "notes.txt", "text/plain"), makeFile(page, "big.png", "image/png", 6 * 1024 * 1024)]);
  await sleep(40);
  assert.strictEqual(previews(page).length, 2);
  assert.strictEqual(alertText(page), "big.png is larger than 5 MB.");
  assert.deepStrictEqual(page.errors, []);
});

test("Make task with images confirms first, sends each image, then the task with their ids", async () => {
  const uploads = [];
  const page = await openSheet({
    onPost: async (api, init) => {
      if (api === "/api/coding/images") {
        uploads.push(init.body.get("image").name);
        return answer({ id: `${uploads.length}`.padStart(16, "0") }, 201);
      }
      return answer({ id: "beef0002" }, 202);
    },
  });
  pick(page, [makeFile(page, "one.png", "image/png"), makeFile(page, "two.jpg", "image/jpeg")]);
  await sleep(40);
  const asked = confirmWith(page, true);
  buttonNamed(page, "Make task and plan").click();
  await sleep(80);
  assert.match(asked[0], /^Make a task in ai-dashboard with 2 images and start planning it\? This uses AI tokens\.$/);
  assert.deepStrictEqual(uploads, ["one.png", "two.jpg"]);
  assert.deepStrictEqual(page.posts, ["/api/coding/images", "/api/coding/images", "/api/coding/actions"]);
  assert.deepStrictEqual(page.bodies[2], { action: "create_task", args: {
    repo: "ai-dashboard", text: "Normal task", todo: "-", images: "0000000000000001,0000000000000002" } });
  assert.deepStrictEqual(page.errors, []);
});

test("Autopilot refuses attached images instead of dropping them, and sends nothing", async () => {
  const page = await openSheet();
  const box = sheetOf(page).querySelector(".task-autopilot input");
  box.checked = true;
  box.dispatchEvent(new page.dom.window.Event("change", { bubbles: true }));
  pick(page, [makeFile(page, "one.png", "image/png")]);
  await sleep(40);
  confirmWith(page, true);
  buttonNamed(page, "Make task and plan").click();
  await sleep(40);
  assert.strictEqual(alertText(page), "Autopilot tasks take no images. Remove them or untick Autopilot.");
  assert.deepStrictEqual(page.posts, []);
  assert.deepStrictEqual(page.errors, []);
});

test("an upload that never answers is given up: the sheet says so and nothing is sent", async () => {
  const page = await openSheet({
    onPost: async (api, init) => (api === "/api/coding/images" ? hang(init.signal) : answer({ id: "beef0003" }, 202)),
  });
  pick(page, [makeFile(page, "slow.png", "image/png")]);
  await sleep(40);
  confirmWith(page, true);
  buttonNamed(page, "Make task and plan").click();
  await sleep(40);
  const sending = buttonNamed(page, "Sending images…");
  assert.ok(sending && sending.disabled, "the sheet waits, and cannot be sent twice");
  assert.strictEqual(buttonNamed(page, "Remove image").disabled, true);
  await sleep(UPLOAD_TIMEOUT_MS + 120);
  assert.match(alertText(page), /^Image not sent: no answer within 0\.15 s$/);
  assert.deepStrictEqual(page.posts, ["/api/coding/images"]);
  const retry = buttonNamed(page, "Make task and plan");
  assert.ok(retry && !retry.disabled, "the sheet can be sent again");
  assert.deepStrictEqual(page.errors, []);
});

test("a slow upload that answers in time still makes the task", async () => {
  const page = await openSheet({
    onPost: async (api) => {
      if (api === "/api/coding/images") {
        await sleep(60);
        return answer({ id: "0123456789abcdef" }, 201);
      }
      return answer({ id: "beef0004" }, 202);
    },
  });
  pick(page, [makeFile(page, "slow.png", "image/png")]);
  await sleep(40);
  confirmWith(page, true);
  buttonNamed(page, "Make task and plan").click();
  await sleep(160);
  assert.deepStrictEqual(page.bodies.at(-1), { action: "create_task", args: {
    repo: "ai-dashboard", text: "Normal task", todo: "-", images: "0123456789abcdef" } });
  assert.strictEqual(alertText(page), "");
});

test("a draft cancelled while its images are still going is not sent", async () => {
  const page = await openSheet({
    onPost: async (api) => {
      if (api === "/api/coding/images") {
        await sleep(60);
        return answer({ id: "0123456789abcdef" }, 201);
      }
      return answer({ id: "beef0005" }, 202);
    },
  });
  pick(page, [makeFile(page, "late.png", "image/png")]);
  await sleep(40);
  confirmWith(page, true);
  buttonNamed(page, "Make task and plan").click();
  await sleep(20);
  buttonNamed(page, "Cancel").click();
  await sleep(160);
  assert.deepStrictEqual(page.posts, ["/api/coding/images"]);
  assert.strictEqual(sheetOf(page), undefined);
});

// ------------------------------------------------- Coding › Work card images

const workCardOf = (page) => [...page.doc.querySelectorAll("main section")]
  .find((node) => node.querySelector("h2") && node.querySelector("h2").textContent === "Work");
// The Coding window needs the full setup (models, tools) to render.
const CODING_FULL = { ...CODING, snapshot: { ...CODING.snapshot, setup: { ...CODING.snapshot.setup,
  planner: "codex", implementer: "codex", planner_options: ["codex", "claude"], implementer_options: ["codex", "claude"],
  models: [{ tool: "codex", model: "default", options: [] }, { tool: "claude", model: "claude-opus-5-5", options: [] }] } } };
async function openWork(options = {}) {
  const page = await openPage("/coding", { coding: CODING_FULL, ...options });
  const box = workCardOf(page).querySelector("textarea");
  box.value = "The logs card jumps";
  box.dispatchEvent(new page.dom.window.Event("input"));
  return page;
}

test("Work card: a picked image makes Plan a task in the active project with it", async () => {
  const page = await openWork({
    onPost: async (api) => (api === "/api/coding/images" ? answer({ id: "0000000000000001" }, 201) : answer({ id: "beef0010" }, 202)),
  });
  const input = workCardOf(page).querySelector('input[type="file"]');
  Object.defineProperty(input, "files", { configurable: true, value: [makeFile(page, "shot.png", "image/png")] });
  input.dispatchEvent(new page.dom.window.Event("change"));
  await sleep(40);
  assert.strictEqual(workCardOf(page).querySelectorAll("figure.attachment-thumb").length, 1);
  assert.match(workCardOf(page).textContent, /makes a task in the active project/);
  const asked = confirmWith(page, true);
  buttonNamed(page, "Plan").click();
  await sleep(80);
  assert.match(asked[0], /^Plan "The logs card jumps" with 1 image.*\? It becomes a task in ai-dashboard; this uses AI tokens\.$/);
  assert.deepStrictEqual(page.posts, ["/api/coding/images", "/api/coding/actions"]);
  assert.deepStrictEqual(page.bodies[1], { action: "create_task", args: {
    repo: "ai-dashboard", text: "The logs card jumps", todo: "-", images: "0000000000000001" } });
  assert.deepStrictEqual(page.errors, []);
});

test("Work card: a pasted screenshot is added; Bugfix with images explains instead of sending", async () => {
  const page = await openWork();
  const box = workCardOf(page).querySelector("textarea");
  const paste = new page.dom.window.Event("paste", { bubbles: true, cancelable: true });
  paste.clipboardData = { files: [makeFile(page, "clipboard.png", "image/png")] };
  box.dispatchEvent(paste);
  await sleep(40);
  assert.ok(paste.defaultPrevented);
  assert.strictEqual(workCardOf(page).querySelectorAll("figure.attachment-thumb").length, 1);
  buttonNamed(page, "Bugfix").click();
  await sleep(20);
  assert.match(alertText(page), /Images go with Plan or Implement/);
  assert.deepStrictEqual(page.posts, []);
  // Text pastes are left to the browser.
  const textPaste = new page.dom.window.Event("paste", { bubbles: true, cancelable: true });
  textPaste.clipboardData = { files: [] };
  workCardOf(page).querySelector("textarea").dispatchEvent(textPaste);
  assert.strictEqual(textPaste.defaultPrevented, false);
});

test("Work card: without images, Plan still sends start_work", async () => {
  const page = await openWork();
  confirmWith(page, true);
  buttonNamed(page, "Plan").click();
  await sleep(60);
  assert.deepStrictEqual(page.bodies, [{ action: "start_work", args: { kind: "plan", text: "The logs card jumps" } }]);
});

test("Work locks every start button during upload and slow POST, then waits for the agent", async () => {
  let uploadDone, postDone;
  const page = await openWork({ onPost: (api) => new Promise((resolve) => {
    if (api === "/api/coding/images") uploadDone = resolve;
    else postDone = resolve;
  }) });
  const input = workCardOf(page).querySelector('input[type="file"]');
  Object.defineProperty(input, "files", { configurable: true, value: [makeFile(page, "shot.png", "image/png")] });
  input.dispatchEvent(new page.dom.window.Event("change"));
  confirmWith(page, true);
  const implement = buttonNamed(page, "Implement");
  implement.click();
  implement.click();
  assert.match(implement.textContent, /Sending images/);
  assert.ok(buttonNamed(page, "Plan").disabled);
  assert.ok(workCardOf(page).querySelector("textarea").disabled);
  await sleep(30);
  assert.ok([...workCardOf(page).querySelectorAll("button")].every((button) => button.disabled));
  uploadDone(answer({ id: "0000000000000001" }, 201));
  await sleep(30);
  const starts = [...workCardOf(page).querySelectorAll("[data-work-start]")];
  assert.ok(starts.every((button) => button.disabled));
  starts.forEach((button) => button.click());
  assert.strictEqual(page.posts.filter((api) => api === "/api/coding/actions").length, 1);
  postDone(answer({ id: "beef0030" }, 202));
  await sleep(50);
  assert.ok([...workCardOf(page).querySelectorAll("[data-work-start]")].every((button) => button.disabled));
  page.dom.window.eval('settleActions({actions:[{id:"beef0030",status:"done",message:"Task created"}]}); refresh();');
  await sleep(50);
  assert.strictEqual(workCardOf(page).querySelector("textarea").value, "");
  assert.strictEqual(buttonNamed(page, "Plan").disabled, false);
  assert.deepStrictEqual(page.errors, []);
});

test("Work cancellation and send failure unlock the draft without losing it", async () => {
  const page = await openWork({ onPost: async () => answer({ error: "offline" }, 503) });
  confirmWith(page, false);
  buttonNamed(page, "Plan").click();
  await sleep(50);
  assert.strictEqual(buttonNamed(page, "Implement").disabled, false);
  confirmWith(page, true);
  buttonNamed(page, "Implement").click();
  assert.ok(buttonNamed(page, "Plan").disabled);
  await sleep(60);
  assert.strictEqual(buttonNamed(page, "Plan").disabled, false);
  assert.strictEqual(workCardOf(page).querySelector("textarea").value, "The logs card jumps");
  assert.match(alertText(page), /Not sent/);
});
