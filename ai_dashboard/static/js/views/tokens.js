// Read-only reported usage and optional cost/billing. No missing provider or
// calendar bucket becomes zero, and no historical dollar is invented.
function tokensLauncherLink() {
  const link = el("a", "Tokens · usage by role and tool ›", "nav-row");
  link.href = "/tokens";
  link.addEventListener("click", (event) => {
    event.preventDefault();
    navigate("tokens");
  });
  return link;
}

function tokensToolLabel(total) {
  return `${total.role} / ${total.tool_label || total.tool}`;
}

function tokensProviderModel(total) {
  const parts = [];
  if (typeof total.provider === "string" && total.provider) parts.push(total.provider);
  if (typeof total.model === "string" && total.model) parts.push(total.model);
  return parts.join(" · ") || "Unavailable";
}

// Estimated and reported costs stay in separate columns, each with its own
// currency and rate bases; a mixed-currency total is unavailable, never merged.
function tokensCostCell(cost) {
  const cell = el("td");
  if (!cost || typeof cost.amount !== "number" || !Number.isFinite(cost.amount)) {
    cell.textContent = "Unavailable";
    return cell;
  }
  const currency = typeof cost.currency === "string" && cost.currency ? ` ${cost.currency}` : "";
  cell.append(el("span", `${cost.amount.toFixed(2)}${currency}`));
  const bases = Array.isArray(cost.rate_bases) ? cost.rate_bases.filter((basis) => typeof basis === "string" && basis) : [];
  if (bases.length) cell.append(el("div", bases.join(", "), "muted"));
  return cell;
}

function tokensTotalsTable(totals, caption) {
  const table = el("table", null, "tokens-table");
  table.append(el("caption", caption));
  const head = el("thead");
  const headings = el("tr");
  for (const title of ["Role / tool", "Provider / model", "Reported tokens", "Calls", "Unknown calls", "Estimated cost", "Reported cost"]) {
    const cell = el("th", title);
    cell.scope = "col";
    headings.append(cell);
  }
  head.append(headings);
  const body = el("tbody");
  for (const total of totals) {
    const line = el("tr");
    const label = el("th", tokensToolLabel(total));
    label.scope = "row";
    line.append(label);
    line.append(el("td", tokensProviderModel(total)));
    for (const key of ["tokens", "calls", "unknown"]) {
      const value = total[key];
      line.append(el("td", value == null ? "Unavailable" : value.toLocaleString()));
    }
    line.append(tokensCostCell(total.cost_estimated));
    line.append(tokensCostCell(total.cost_reported));
    body.append(line);
  }
  table.append(head, body);
  return table;
}

function tokensBilling(view) {
  const billing = view.billing;
  if (!billing || typeof billing !== "object") return null;
  const nodes = [];
  const balance = billing.balance;
  if (!balance || typeof balance !== "object") {
    nodes.push(row("Account balance", "Unavailable"));
  } else {
    const amount = Number(balance.amount);
    const currency = typeof balance.currency === "string" && balance.currency ? ` ${balance.currency}` : "";
    nodes.push(row("Account balance", Number.isFinite(amount) ? `${amount.toFixed(2)}${currency}` : "Unavailable"));
    if (balance.kind === "estimated" || balance.kind === "reported") {
      nodes.push(muted(`${balance.kind === "estimated" ? "Estimated" : "Reported"} balance`));
    }
  }
  return card("Billing", ...nodes);
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
  const tokenNote = view.registry
    ? "Reported tokens and costs follow each provider's own counts. Estimated and reported costs are shown separately and never combined; a snapshot without cost fields shows no dollars. Unknown calls are excluded from token totals."
    : "Reported tokens follow provider counts. Claude planner counts input + output, excluding cache reads/writes. Codex counts are unverified upstream; Claude implementer counts are unavailable. Unknown calls are excluded from token totals.";
  const nodes = [card("Coverage",
    row("Bucket timezone", view.timezone),
    row("Retention", `${view.coverage.window_days} days · ${view.coverage.start} – ${view.coverage.end}`),
    row("Days with reported buckets", view.coverage.reported_days),
    muted("Partial coverage: tracking start and continuity are unknown. Missing days and tools are unavailable, not measured zero. Today's bucket is still in progress."),
    muted(tokenNote))];
  const billing = tokensBilling(view);
  if (billing) nodes.push(billing);
  if (!view.available) nodes.push(card("Usage unavailable", muted("Coding has not published supported usage data.")));
  else if (!view.periods.day.length) nodes.push(card("No reported usage", muted("No valid retained buckets are available. This does not establish zero usage.")));
  else {
    nodes.push(wideCard("Retained totals", tokensTotalsTable(view.totals, "Reported totals by role and tool")));
    for (const kind of ["day", "week", "month"]) nodes.push(tokensPeriodCard(kind, view.periods[kind]));
  }
  return { title: "Tokens", subtitle: "Coding snapshot · UTC", status: warnings.length || !view.available ? "warn" : "info",
    alert: warnings.join(" · "), nodes };
}
