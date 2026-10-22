const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {JSDOM} = require("jsdom");
function setup() {
  const dom = new JSDOM("<main></main>", {runScripts:"outside-only"});
  for (const file of ["dom.js", "views/security.js", "views/limits.js", "views/tasks.js", "views/pm.js", "views/pm-toolbar.js"]) {
    dom.window.eval(fs.readFileSync(path.join(__dirname,"../../ai_dashboard/static/js",file),"utf8"));
  }
  return dom;
}
const tick = dom => new Promise(resolve=>dom.window.setTimeout(resolve,10));
test("security findings and attackers keep explicit open/closed choices through refreshed and reordered data", async () => {
  const dom=setup(), w=dom.window, root=w.document.querySelector("main");
  const finding=port=>({title:`port ${port}/tcp is public`,level:"low",detail:"Before",fix:"Check it"});
  const render=(ports,failed)=>{
    const nodes=[...w.securityStatRows({ssh:{available:true,failed,top_attackers:[{ip:"192.0.2.1",count:failed}],login_groups:[{user:"roman",from:"192.0.2.10",method:"publickey",key:"ED25519 …ijklmnop",count:failed,last:1}]}}),...ports.map(p=>w.securityFinding({...finding(p),detail:`Updated ${failed}`}))];
    root.replaceChildren(...nodes);
  };
  render([2398,8080],1);
  root.querySelector(".security-details:not(.security-logins)").open=true;
  root.querySelector(".security-logins").open=true;
  root.querySelector(".security-finding").open=true;
  render([8080,2398,9000],2); // before toggle events; order changes
  await tick(dom);
  assert.equal(root.querySelector(".security-details:not(.security-logins)").open,true);
  assert.equal(root.querySelector(".security-logins").open,true);
  const findings=root.querySelectorAll(".security-finding");
  assert.equal(findings[0].open,false);
  assert.equal(findings[1].open,true);
  assert.equal(findings[2].open,false);
  assert.match(findings[1].textContent,/Updated 2/);
  findings[1].open=false;
  root.querySelector(".security-details:not(.security-logins)").open=false;
  root.querySelector(".security-logins").open=false;
  render([2398,8080],3);
  await tick(dom);
  assert.equal(root.querySelector(".security-details:not(.security-logins)").open,false);
  assert.equal(root.querySelector(".security-finding").open,false);
  assert.equal(root.querySelector(".security-logins").open,false);
  dom.window.close();
});
test("PM about and task evidence retain expansion without sharing state with other tasks", async () => {
  const dom=setup(), w=dom.window, root=w.document.querySelector("main");
  w.taskButton=()=>w.document.createElement("button");
  w.workActions=(...nodes)=>{const box=w.document.createElement("div");box.append(...nodes);return box;};
  const task=id=>({id,evidence:["Evidence"]});
  const render=()=>root.replaceChildren(w.pmAbout({version:"v1"}),...w.proposalActions(task("one")),...w.proposalActions(task("two")));
  render();root.querySelector(".pm-about").open=true;root.querySelector(".task-evidence").open=true;
  render(); await tick(dom);
  assert.equal(root.querySelector(".pm-about").open,true);
  assert.equal(root.querySelectorAll(".task-evidence")[0].open,true);
  assert.equal(root.querySelectorAll(".task-evidence")[1].open,false);
  dom.window.close();
});
