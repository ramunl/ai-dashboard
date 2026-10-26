const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {JSDOM} = require("jsdom");
const tick = () => new Promise(resolve => setImmediate(resolve));
function open() {
  const dom = new JSDOM("<main></main>", {runScripts:"outside-only"});
  for (const file of ["dom.js", "views/services.js", "views/clients.js"]) {
    dom.window.eval(fs.readFileSync(path.join(__dirname, "../../ai_dashboard/static/js", file), "utf8"));
  }
  dom.window.tg = {initData:"signed"};
  dom.window.refresh = () => {};
  dom.window.showAlert = () => {};
  const view = {agents:[], service_control:{ok:true,services:[{unit:"iptv-proxy",state:"active"}]},
    clients:{report:{ok:true,checked_at:Date.now()/1000,services:[{id:"media",name:"Media / IPTV proxy",
      available:true,active:138,unit:"incoming connections"}]}}};
  const render = () => dom.window.document.body.replaceChildren(dom.window.clientsCard(view));
  render();
  return {dom, view, render, buttons:() => [...dom.window.document.querySelectorAll(".iptv-controls button")]};
}

test("IPTV buttons appear in the expanded client card; cancellation sends nothing", async () => {
  const {dom, buttons} = open();
  let called = false;
  dom.window.postAction = async () => {called = true;};
  dom.window.askConfirmation = (message, reply) => {assert.match(message,/disconnects all IPTV clients/);reply(false);};
  assert.deepEqual(buttons().map(b=>b.textContent), ["Start IPTV","Shut down IPTV"]);
  buttons()[1].click();
  await tick();
  assert.equal(called,false);
  assert.equal(buttons()[1].disabled,false);
  dom.window.close();
});

test("confirmed stop uses authenticated fixed endpoint and keeps lock across renders", async () => {
  const {dom, buttons, render} = open();
  let resolve, count = 0;
  dom.window.askConfirmation = (_message, reply) => reply(true);
  dom.window.postAction = (route, auth, body, timeout) => {
    count++;
    assert.equal(route,"ops/service");assert.equal(auth,"signed");
    assert.equal(JSON.stringify(body),JSON.stringify({service:"iptv-proxy",action:"stop",confirm:"stop"}));
    assert.ok(timeout > 120000);
    return new Promise(r=>{resolve=r;});
  };
  buttons()[1].click();
  render();
  assert.ok(buttons().every(b=>b.disabled));
  buttons()[1].click();assert.equal(count,1);
  resolve({ok:true,unit:"inactive",port_open:false});await tick();render();
  assert.match(dom.window.document.body.textContent,/inactive · port 8080 closed/);
  assert.ok(buttons().every(b=>!b.disabled));
  dom.window.close();
});

test("start omits stop confirmation; failures remain visible after refresh", async () => {
  const {dom, buttons, render} = open();
  dom.window.askConfirmation = (_message, reply) => reply(true);
  dom.window.postAction = async (_route,_auth,body) => {
    assert.equal(JSON.stringify(body),JSON.stringify({service:"iptv-proxy",action:"start"}));
    throw new Error("port verification failed");
  };
  buttons()[0].click();await tick();render();
  assert.match(dom.window.document.body.textContent,/port verification failed/);
  assert.ok(buttons().every(b=>!b.disabled));
  dom.window.close();
});

test("controls require Ops whitelist and are absent for unrelated client services", () => {
  const {dom, view, render} = open();
  view.service_control.services = [];
  render();
  assert.equal(dom.window.document.querySelectorAll(".iptv-controls button").length,0);
  assert.match(dom.window.document.body.textContent,/Update the Ops agent/);
  view.clients.report.services[0].id = "ssh";
  render();
  assert.doesNotMatch(dom.window.document.body.textContent,/Shut down IPTV/);
  dom.window.close();
});
