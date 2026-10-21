// Read-only reported usage. No missing provider or calendar bucket becomes zero.
function tokensLauncherLink() {
  const link = el("a", "Tokens · usage by role and tool ›", "nav-row");
  link.href = "/tokens";
  link.addEventListener("click", (event) => {
    event.preventDefault();
    navigate("tokens");
  });
  return link;
}

function tokensTotalsTable(totals, caption) {
  const table = el("table", null, "tokens-table");
  table.append(el("caption", caption));
  const head = el("thead");
  const headings = el("tr");
  for (const title of ["Role / tool", "Reported tokens", "Calls", "Unknown calls"]) {
    const cell = el("th", title);
    cell.scope = "col";
    headings.append(cell);
  }
  head.append(headings);
  const body = el("tbody");
  for (const total of totals) {
    const line = el("tr");
    const label = el("th", `${total.role} / ${total.tool}`);
    label.scope = "row";
    line.append(label);
    for (const key of ["tokens", "calls", "unknown"]) {
      const value = total[key];
      line.append(el("td", value === null ? "Unavailable" : value.toLocaleString()));
    }
    body.append(line);
  }
  table.append(head, body);
  return table;
}

function tokensPeriodCard(kind, periods) {
  const section = card({ day: "Daily", week: "ISO weeks", month: "Months" }[kind]);
  for (const period of periods) {
    const details = rememberDetails(el("details"), ["tokens", kind, period.period]);
    details.append(el("summary", `${period.period} · Partial coverage`),
      muted(`${period.start} – ${period.end} · ${period.reported_days} of ${period.calendar_days} calendar days have buckets`),
      tokensTotalsTable(period.totals, `${period.period} reported totals`));
    section.append(details);
  }
  return section;
}

function tokensPage(view) {
  const warnings = [...view.warnings];
  if (view.stale) warnings.unshift("Stale data or unknown snapshot freshness.");
  const nodes = [card("Coverage",
    row("Bucket timezone", view.timezone),
    row("Retention", `${view.coverage.window_days} days · ${view.coverage.start} – ${view.coverage.end}`),
    row("Days with reported buckets", view.coverage.reported_days),
    muted("Partial coverage: tracking start and continuity are unknown. Missing days and tools are unavailable, not measured zero. Today's bucket is still in progress."),
    muted("Reported tokens follow provider counts. Claude planner counts input + output, excluding cache reads/writes. Codex counts are unverified upstream; Claude implementer counts are unavailable. Unknown calls are excluded from token totals."))];
  if (!view.available) nodes.push(card("Usage unavailable", muted("Coding has not published supported usage data.")));
  else if (!view.periods.day.length) nodes.push(card("No reported usage", muted("No valid retained buckets are available. This does not establish zero usage.")));
  else {
    nodes.push(wideCard("Retained totals", tokensTotalsTable(view.totals, "Reported totals by role and tool")));
    for (const kind of ["day", "week", "month"]) nodes.push(tokensPeriodCard(kind, view.periods[kind]));
  }
  return { title: "Tokens", subtitle: "Coding snapshot · UTC", status: warnings.length || !view.available ? "warn" : "info",
    alert: warnings.join(" · "), nodes };
}
