const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {JSDOM} = require("jsdom");
function setup(state) {
  const dom = new JSDOM("<main></main>", {runScripts: "outside-only"});
  for (const file of ["dom.js", "views/clients.js"]) dom.window.eval(fs.readFileSync(path.join(__dirname, "../../ai_dashboard/static/js", file), "utf8"));
  dom.window.tg = null;
  dom.window.document.body.append(dom.window.clientsCard({clients: state}));
  return dom;
}
test("client card distinguishes service units, zero, unavailable and stale readings", () => {
  const dom = setup({report:{ok:true,checked_at:1,services:[
    {name:"VPN",available:true,active:2,unit:"recently active devices",configured:3,clients:[{name:"<script>Phone</script>",active:true,last_seen_seconds:10,rx_bytes:100,tx_bytes:200}],sample:{since:1,peak:2,daily:{rx_bytes:30},incomplete:true},rx_bytes:500,rx_bps:10},
    {name:"Telegram",available:true,active:0,unit:"incoming connections"},
    {name:"Media",available:false,error:"Probe unavailable"}
  ]}});
  const text = dom.window.document.body.textContent;
  assert.match(text,/VPN · 2 recently active devices/);
  assert.match(text,/Telegram · 0 incoming connections/);
  assert.match(text,/Media · Unavailable/);
  assert.match(text,/readings are stale/);
  assert.match(text,/daily usage may be incomplete/);
  assert.match(text,/sampled today/);
  assert.equal(dom.window.document.querySelector("script"),null);
  dom.window.close();
});
test("refresh uses the fixed endpoint without options and handles failures", async () => {
  const dom = setup({running:false});
  let reject;
  dom.window.postAction = route => {assert.equal(route,"ops/clients");return new Promise((_,r)=>{reject=r;});};
  dom.window.showAlert=()=>{};
  const button=dom.window.document.querySelector("button");
  button.click(); assert.equal(button.disabled,true);
  reject(new Error("offline"));
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(button.disabled,false);
  dom.window.close();
});
