const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");
function setup(state) {
  const dom = new JSDOM("<main></main>", {runScripts: "outside-only"});
  for (const file of ["dom.js", "views/backups.js"]) dom.window.eval(fs.readFileSync(path.join(__dirname, "../../ai_dashboard/static/js", file), "utf8"));
  dom.window.tg = null;
  dom.window.formatDuration = () => "3 days";
  dom.window.formatBytes = () => "10 KB";
  dom.window.document.body.append(dom.window.backupsCard({backups: state}));
  return dom;
}
test("backup status shows stale, missing and delivery errors safely", () => {
  const dom = setup({ok:true,last_ok:{at:1,bytes:10,skipped:["<script>bad</script>"]},delivery:{message:"Telegram failed"}});
  assert.match(dom.window.document.body.textContent, /over two days/);
  assert.match(dom.window.document.body.textContent, /Telegram failed/);
  assert.equal(dom.window.document.querySelector("script"),null);
  dom.window.close();
});
test("backup button disables immediately and restores on failure", async () => {
  const dom = setup({ok:true});
  let reject;
  dom.window.postAction = (route) => {assert.equal(route,"ops/backup");return new Promise((_,r)=>{reject=r;});};
  dom.window.showAlert = () => {};
  const button=dom.window.document.querySelector("button");
  button.click(); assert.equal(button.disabled,true);
  reject(new Error("network"));
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(button.disabled,false);
  dom.window.close();
});
test("running backup disables action; missing helper has no button", () => {
  const running=setup({ok:true,running:true});
  assert.equal(running.window.document.querySelector("button").disabled,true);
  running.window.close();
  const missing=setup({ok:false,error:"not installed"});
  assert.equal(missing.window.document.querySelector("button"),null);
  missing.window.close();
});
