// Ops › Security card: ai-audit's stats (SSH attacks, bans, sessions, ports)
// and what to fix. The dashboard keeps the last report and refreshes it every
// 15 minutes; Check now runs the audit at once. Nothing here changes the server.

const SECURITY_ICONS = { high: "🔴", medium: "🟠", low: "🟡" };

function securityCount(value) {
  return Number(value || 0).toLocaleString("en-US");
}

function securityStatRows(stats) {
  const rows = [];
  const ssh = stats.ssh || {};
  if (ssh.available) {
    rows.push(row("Failed SSH logins, 24 h", `${securityCount(ssh.failed)} from ${securityCount(ssh.failed_ips)} IPs`));
    const byPassword = ssh.password_logins ? ` (${ssh.password_logins} by password)` : "";
    rows.push(row("Successful logins, 24 h", `${securityCount(ssh.accepted)}${byPassword}`));
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
  const sessions = stats.sessions || [];
  rows.push(row("Logged in now", sessions.length
    ? sessions.map((item) => `${item.user} from ${item.from}`).join(", ") : "nobody"));
  rows.push(row("Firewall", stats.firewall || "?"));
  const ports = stats.ports || [];
  if (ports.length) rows.push(row("Public ports", ports.map((item) => `${item.port}/${item.proto} ${item.process}`).join(", ")));
  const logins = ssh.login_groups || [];
  if (logins.length) {
    const details = rememberDetails(el("details", null, "security-details security-logins"), ["security", "logins"]);
    details.append(el("summary", "Who logged in"));
    for (const item of logins) {
      const when = typeof item.last === "number" ? ` · last ${clockTime(item.last)}` : "";
      const key = item.key ? `, key ${item.key}` : "";
      details.append(row(`${item.user} from ${item.from}`, `×${securityCount(item.count)} (${item.method}${key})${when}`));
    }
    rows.push(details);
  }
  const attackers = ssh.top_attackers || [];
  if (attackers.length) {
    const details = rememberDetails(el("details", null, "security-details"), ["security", "attackers"]);
    details.append(el("summary", "Top attackers and tried users"));
    for (const item of attackers) details.append(row(item.ip, `×${securityCount(item.count)}`));
    for (const item of ssh.top_users || []) details.append(row(`user ${item.user}`, `×${securityCount(item.count)}`));
    rows.push(details);
  }
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
  const findings = report.findings || [];
  const worst = findings.length ? findings[0].level : "";
  const head = el("div", null, "row");
  const title = el("div");
  title.append(statusDot(worst === "high" ? "bad" : findings.length ? "warn" : "ok"),
    ` ${findings.length ? `${findings.length} to fix` : "Nothing to fix"}`);
  head.append(title, el("span", `checked ${formatDuration(Math.max(0, Date.now() / 1000 - report.checked_at))} ago`, "card-note"));
  return card("Security", head, ...securityStatRows(report.stats || {}),
    ...findings.map(securityFinding), securityCheckButton(state.running));
}
