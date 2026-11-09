const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {JSDOM} = require("jsdom");
function setup(state) {
  const dom = new JSDOM("<main></main>", {runScripts: "outside-only"});
  for (const file of ["dom.js", "views/services.js", "views/coding-work.js", "views/clients.js"]) dom.window.eval(fs.readFileSync(path.join(__dirname, "../../ai_dashboard/static/js", file), "utf8"));
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
test("polling preserves service and device expansion by stable identity, including explicit closes", async () => {
  const service = {id:"vpn",name:"VPN",available:true,active:2,unit:"devices",clients:[
    {id:"phone",name:"Phone",active:true}, {id:"laptop",name:"Laptop",active:true}
  ]};
  const state = services => ({report:{ok:true,checked_at:Date.now()/1000,services}});
  const dom = setup(state([service]));
  const doc = dom.window.document;
  const render = services => {
    const next = dom.window.clientsCard({clients:state(services)});
    doc.body.replaceChildren(next);
  };
  doc.querySelector(".clients-service").open = true;
  doc.querySelector(".clients-peer").open = true;
  // Refresh before queued toggle events have fired, with changed text and order.
  const updated = {...service,name:"Amnezia VPN",active:1,clients:[
    service.clients[1], {...service.clients[0],name:"Renamed phone",active:false}
  ]};
  render([updated]);
  await new Promise(resolve=>dom.window.setTimeout(resolve,10));
  assert.equal(doc.querySelector(".clients-service").open,true);
  const peers = doc.querySelectorAll(".clients-peer");
  assert.equal(peers[0].open,false);
  assert.equal(peers[1].open,true);
  assert.match(doc.body.textContent,/Amnezia VPN · 1 devices/);
  assert.match(peers[1].textContent,/Renamed phone · idle/);
  peers[1].open = false;
  doc.querySelector(".clients-service").open = false;
  render([updated]);
  await new Promise(resolve=>dom.window.setTimeout(resolve,10));
  assert.equal(doc.querySelector(".clients-service").open,false);
  assert.equal(doc.querySelectorAll(".clients-peer")[1].open,false);
  dom.window.close();
});


test("MTG displays a full accept queue independently of live connection counts", () => {
  const dom = setup({report:{ok:true,checked_at:Date.now()/1000,services:[{
    id:"mtg",name:"Telegram mtg",available:true,active:0,unit:"incoming connections",
    accept_queue_available:true,accept_queue:4097,accept_queue_capacity:4096,
    accept_queue_full:true,close_wait_connections:4000,
    sample:{since:1,peak:27,accept_queue_peak:4097}
  }]}});
  const text=dom.window.document.body.textContent;
  assert.match(text,/accept queue full/);
  assert.match(text,/Queued connections awaiting accept4,097/);
  assert.match(text,/Accept queue capacity4,096/);
  assert.match(text,/Sampled queue peak today4,097/);
  assert.match(text,/CLOSE_WAIT/);
  assert.match(text,/Update Ops service controls/);
  dom.window.close();
});

test("MTG restart requires confirmation, uses the fixed endpoint and reports failure", async () => {
  const dom=setup({}); const w=dom.window;
  let confirm; const posts=[]; const alerts=[];
  w.askConfirmation=(message,callback)=>{assert.match(message,/disconnected/);confirm=callback;};
  w.postAction=async (...args)=>{posts.push(args);throw new Error("restart failed");};
  w.showAlert=message=>alerts.push(message);
  const control={ok:true,services:[{unit:"mtg",state:"active",up_seconds:null}]};
  const node=w.clientServiceDetails({id:"mtg",name:"MTG",available:true,active:14,unit:"connections"},control);
  w.document.body.append(node);
  const button=node.querySelector("button");
  button.click(); assert.equal(button.disabled,true); assert.equal(posts.length,0);
  confirm(false); assert.equal(button.disabled,false);
  button.click(); await confirm(true);
  assert.equal(posts.length,1);
  assert.equal(posts[0][0],"ops/restart");
  assert.equal(posts[0][2].service,"mtg");
  assert.match(alerts[0],/restart failed/);
  assert.equal(button.disabled,false);
  dom.window.close();
});
