const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");
const root = path.join(__dirname, "../../ai_dashboard/static");

function setup(t) {
  const dom = new JSDOM('<form id="view"></form>', { runScripts: "outside-only", url: "https://dashboard.test/coding" });
  t.after(() => dom.window.close());
  const w = dom.window;
  const created = [], revoked = [], uploads = [];
  w.URL.createObjectURL = (file) => { const url = `blob:test-${created.length}`; created.push({ file, url }); return url; };
  w.URL.revokeObjectURL = (url) => revoked.push(url);
  let source = `let tg = null, isWorkBusy = false, actionNotice = null;
    const NOTICE_MS = 1000;
    function refresh() {}
    function hasPendingActions() { return false; }
    function workButton(label, key, cls, callback) { const b = el('button', label, cls); b.type = 'button'; b.onclick = () => callback(b); return b; }
    function workActions(...buttons) { const box = el('div'); box.append(...buttons); return box; }
    function plannerText() { return ''; }
    function showAlert(message) { throw Error(message); }
    function readJson(response) { return response.json(); }
    function requestAction(key, action, args, done) { window.sent = { action, args }; done({ message: 'OK' }); }
  `;
  for (const file of ["dom.js", "views/coding-create-task.js", "views/attachment-preview.js", "views/coding-worker.js", "views/coding-start.js"]) {
    const location = path.join(root, "js", file);
    if (fs.existsSync(location)) source += "\n" + fs.readFileSync(location, "utf8");
  }
  w.eval(source + "\nworkRepo = 'repo'; window.workImageCount = () => workImages.length;");
  w.confirm = () => true;
  w.fetch = async (url, options) => { uploads.push({ url, options }); return { ok: true, json: async () => ({ id: 'image-id' }) }; };
  w.eval(`document.getElementById('view').append(...startWorkRows());`);
  const form = w.document.querySelector('form');
  const pick = (...names) => {
    const input = form.querySelector('input[type=file]');
    const files = names.map(name => new w.File(['image'], name, { type: 'image/png' }));
    Object.defineProperty(input, 'files', { configurable: true, value: files });
    input.focus();
    input.dispatchEvent(new w.Event('change', { bubbles: true }));
    return files;
  };
  return { w, form, pick, created, revoked, uploads };
}

test('selection renders thumbnails immediately below text without refresh or submit', t => {
  const { form, pick, created, uploads } = setup(t);
  pick('one.png', '<two>.png');
  const preview = form.querySelector('textarea').nextElementSibling;
  assert.ok(preview.classList.contains('attachment-preview'));
  assert.equal(preview.querySelectorAll('.attachment-thumb img').length, 2);
  assert.equal(created.length, 2);
  assert.equal(uploads.length, 0);
  assert.match(preview.textContent, /<two>.png/);
  assert.equal(preview.querySelector('[style]'), null);
});

test('removal revokes its URL and only remaining files use the unchanged upload', async t => {
  const { w, form, pick, revoked, uploads } = setup(t);
  const files = pick('one.png', 'two.png');
  const remove = form.querySelector('.attachment-thumb button');
  assert.equal(remove.type, 'button');
  assert.match(remove.getAttribute('aria-label'), /one.png/);
  remove.click();
  assert.deepEqual(revoked, ['blob:test-0']);
  assert.equal(form.querySelectorAll('.attachment-thumb').length, 1);
  const text = form.querySelector('textarea');
  text.value = 'Implement this';
  text.dispatchEvent(new w.Event('input'));
  [...form.querySelectorAll('button')].find(b => b.textContent === 'Plan').click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].url, '/api/coding/images');
  assert.equal(uploads[0].options.method, 'POST');
  assert.equal(uploads[0].options.body.get('image').name, files[1].name);
  assert.deepEqual(JSON.parse(JSON.stringify(w.sent)), { action: 'create_task', args: { repo: 'repo', text: 'Implement this', todo: '-', images: 'image-id' } });
});

test('reset releases previews and clears selection', t => {
  const { w, form, pick, revoked } = setup(t);
  pick('one.png');
  form.reset();
  assert.deepEqual(revoked, ['blob:test-0']);
  assert.equal(form.querySelectorAll('.attachment-thumb').length, 0);
  assert.equal(w.workImageCount(), 0);
});

test('navigation removes the form and releases URLs', async t => {
  const { form, pick, revoked } = setup(t);
  pick('one.png');
  form.replaceChildren();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(revoked, ['blob:test-0']);
});

test('pagehide releases URLs and pageshow restores previews', t => {
  const { w, form, pick, revoked, created } = setup(t);
  pick('one.png');
  w.dispatchEvent(new w.Event('pagehide'));
  assert.deepEqual(revoked, ['blob:test-0']);
  w.dispatchEvent(new w.Event('pageshow'));
  assert.equal(created.length, 2);
  assert.equal(form.querySelector('img').src, 'blob:test-1');
});

test('unsupported object URLs and decode failures keep a visible filename and remove button', t => {
  const { w, form, pick, revoked } = setup(t);
  pick('broken.png');
  form.querySelector('img').dispatchEvent(new w.Event('error'));
  assert.match(form.querySelector('.attachment-thumb').textContent, /Preview unavailable/);
  assert.deepEqual(revoked, ['blob:test-0']);
  form.querySelector('.attachment-thumb button').click();
  w.URL.createObjectURL = undefined;
  pick('unsupported.png');
  assert.match(form.querySelector('.attachment-thumb').textContent, /unsupported.png.*Preview unavailable/);
  assert.ok(form.querySelector('.attachment-thumb button'));
});

test('rebuilding the editor releases old URLs and recreates previews for retained files', async t => {
  const { w, form, pick, revoked, created } = setup(t);
  pick('retained.png');
  w.eval("document.getElementById('view').replaceChildren(...startWorkRows());");
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(revoked, ['blob:test-0']);
  assert.equal(created.length, 2);
  assert.equal(form.querySelector('img').src, 'blob:test-1');
  form.querySelector('.attachment-thumb button').click();
  assert.equal(w.workImageCount(), 0);
  assert.deepEqual(revoked, ['blob:test-0', 'blob:test-1']);
});

test('discarded render results allocate no URLs; pasted images preview immediately', async t => {
  const { w, form, pick, created } = setup(t);
  pick('picked.png');
  w.startWorkRows(); // The shell can discard rows while the input has focus.
  assert.equal(created.length, 1);
  const paste = new w.Event('paste', { cancelable: true });
  Object.defineProperty(paste, 'clipboardData', {
    value: { files: [new w.File(['image'], 'pasted.png', { type: 'image/png' })] },
  });
  form.querySelector('textarea').dispatchEvent(paste);
  assert.equal(paste.defaultPrevented, true);
  assert.equal(form.querySelectorAll('.attachment-thumb').length, 2);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(created.length, 2);
});
