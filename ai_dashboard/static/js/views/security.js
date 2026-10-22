// Ops › Security card: ai-audit's stats (SSH attacks, bans, sessions, ports)
// and what to fix. The dashboard keeps the last report and refreshes it every
// 15 minutes; Check now runs the audit at once. Nothing here changes the server.

const SECURITY_ICONS = { high: "🔴", medium: "🟠", low: "🟡" };

// Acknowledgements are local review notes, never access-control rules.
function securityReviewSet(kind) {
  try {
    const saved = JSON.parse(localStorage.getItem(`security-reviewed-${kind}`) || "[]");
    return new Set(Array.isArray(saved) ? saved.filter((value) => typeof value === "string") : []);
  } catch (_) { return new Set(); }
}

function securityReviewButton(kind, identity, expected) {
  const button = el("button", expected ? "Review again" : "Mark expected", "row-button");
  button.type = "button";
  button.addEventListener("click", () => {
    const saved = securityReviewSet(kind);
    if (expected) saved.delete(identity); else saved.add(identity);
    try {
      localStorage.setItem(`security-reviewed-${kind}`, JSON.stringify([...saved]));
      refresh();
    } catch (_) { showAlert("Could not save this review in your browser."); }
  });
  return button;
}

function securityPortIdentity(item) {
  return JSON.stringify([item.proto, item.port, item.process]);
}

function securityLoginIdentity(item) {
  return JSON.stringify([item.user, item.from, item.method, item.key || ""]);
}

function securityExposureRows(ports) {
  const expected = securityReviewSet("ports");
  const rows = [];
  for (const reviewed of [false, true]) {
    const group = ports.filter((item) => expected.has(securityPortIdentity(item)) === reviewed);
    if (!group.length) continue;
    rows.push(el("h3", reviewed ? "Expected listening services" : "Unreviewed exposure"));
    for (const item of group) {
      rows.push(row(`${item.port}/${item.proto} ${item.process}`,
        securityReviewButton("ports", securityPortIdentity(item), reviewed)));
    }
  }
  if (ports.length) rows.push(muted("Listening on public interfaces does not prove internet reachability. Expected means reviewed, not verified safe."));
  return rows;
}

function securityCount(value) {
  return Number(value || 0).toLocaleString("en-US");
}

function securityStatRows(stats) {
  const rows = [];
  const ssh = stats.ssh || {};
  if (ssh.available) {
    rows.push(el("h3", "Blocked attempts and bans"));
    rows.push(muted("Failed SSH attempts are rejected logins, not evidence of a successful intrusion."));
    rows.push(row("Failed SSH logins, 24 h", `${securityCount(ssh.failed)} from ${securityCount(ssh.failed_ips)} IPs`));

  } else {
    rows.push(row("SSH logins", "journal not readable"));
  }
  const ban = stats.fail2ban || {};
  if (ban.installed) {
    const jails = ban.jails || [];
    const now = jails.reduce((sum, jail) => sum + (jail.banned_now || 0), 0);
    const total = jails.reduce((sum, jail) => sum + (jail.banned_total || 0), 0);
    rows.push(row("Banned now", securityCount(now)), row("Banned in total", securityCount(total)));
  } else {
    rows.push(row("fail2ban", "not installed"));
  }
  rows.push(el("h3", "Successful logins"));
  if (ssh.available) {
    const byPassword = ssh.password_logins ? ` (${ssh.password_logins} by password)` : "";
    rows.push(row("Successful logins, 24 h", `${securityCount(ssh.accepted)}${byPassword}`));
  }
  rows.push(muted("Login reviews are saved only in this browser. A new address or changed displayed key needs review; this is not compromise detection."));
  const sessions = stats.sessions || [];
  rows.push(row("Logged in now", sessions.length
    ? sessions.map((item) => `${item.user} from ${item.from}`).join(", ") : "nobody"));
  rows.push(row("Firewall", stats.firewall || "?"));
  const ports = stats.ports || [];

  const logins = ssh.login_groups || [];
  if (logins.length) {
    const details = rememberDetails(el("details", null, "security-details security-logins"), ["security", "logins"]);
    details.append(el("summary", "Who logged in"));
    const expectedLogins = securityReviewSet("logins");
    for (const item of logins) {
      const when = typeof item.last === "number" ? ` · last ${clockTime(item.last)}` : "";
      const key = item.key ? `, key ${item.key}` : "";
      details.append(row(`${item.user} from ${item.from}`, `×${securityCount(item.count)} (${item.method}${key})${when}`));
      const reviewed = expectedLogins.has(securityLoginIdentity(item));
      details.append(row(reviewed ? "Expected identity" : "Unfamiliar identity — review", securityReviewButton("logins", securityLoginIdentity(item), reviewed)));
    }
    rows.push(details);
  }
  if (ssh.accepted && !logins.length) rows.push(muted("Login identity details unavailable — familiarity cannot be assessed."));
  const attackers = ssh.top_attackers || [];
  if (attackers.length) {
    const details = rememberDetails(el("details", null, "security-details"), ["security", "attackers"]);
    details.append(el("summary", "Top attackers and tried users"));
    for (const item of attackers) details.append(row(item.ip, `×${securityCount(item.count)}`));
    for (const item of ssh.top_users || []) details.append(row(`user ${item.user}`, `×${securityCount(item.count)}`));
    rows.push(details);
  }
  rows.push(...securityExposureRows(ports));
  return rows;
}

function securityFinding(item) {
  const details = rememberDetails(el("details", null, "security-finding"), ["security", "finding", item.title]);
  details.dataset.level = item.level;
  details.append(el("summary", `${SECURITY_ICONS[item.level] || "•"} ${item.title}`),
    el("div", item.detail, "card-note"), el("div", `Fix: ${item.fix}`, "security-fix"));
  return details;
}

function securityCheckButton(running) {
  const button = el("button", running ? "Checking…" : "Check now", "action-button");
  button.type = "button";
  button.disabled = Boolean(running);
  button.addEventListener("click", async () => {
    button.disabled = true;
    button.textContent = "Checking…";
    try {
      await postAction("ops/security", tg ? tg.initData : "");
      refresh();
    } catch (error) {
      button.disabled = false;
      button.textContent = "Check now";
      showAlert(`Security check did not start: ${error.message}`);
    }
  });
  return button;
}

function securityCard(view) {
  const state = view.security;
  if (!state) return card("Security", muted("Update the dashboard to see security."));
  const report = state.report;
  if (!report) return card("Security", muted("Checking for the first time…"), securityCheckButton(true));
  if (!report.ok) {
    return card("Security", el("div", report.error || "The security check failed.", "card-note"),
      securityCheckButton(state.running));
  }
  // Old audits report every nonstandard listening port as a finding. Present
  // those separately without dropping unrelated configuration warnings.
  const stats = report.stats || {};
  const portTitles = new Set((stats.ports || []).map((item) =>
    `port ${item.port}/${item.proto} is public (${item.process})`));
  const findings = (report.findings || []).filter((item) => !portTitles.has(item.title));
  const pendingPorts = (stats.ports || []).filter((item) => !securityReviewSet("ports").has(securityPortIdentity(item))).length;
  const pendingLogins = ((stats.ssh || {}).login_groups || []).filter((item) => !securityReviewSet("logins").has(securityLoginIdentity(item))).length;
  const worst = findings.some((item) => item.level === "high") ? "high" : "";
  const head = el("div", null, "row");
  const title = el("div");
  title.append(statusDot(worst === "high" ? "bad" : findings.length || pendingPorts || pendingLogins ? "warn" : "ok"),
    ` ${findings.length} configuration issue(s) · ${pendingPorts} service(s) to review · ${pendingLogins} login identity/identities to review`);
  head.append(title, el("span", `checked ${formatDuration(Math.max(0, Date.now() / 1000 - report.checked_at))} ago`, "card-note"));
  return card("Security", head, ...securityStatRows(report.stats || {}),
    ...(findings.length ? [el("h3", "Configuration issues"), ...findings.map(securityFinding)] : []),
    muted("Reviews are stored in this browser; clearing browser data resets them. This card cannot certify that the server is uncompromised."), securityCheckButton(state.running));
}
