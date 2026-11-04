// Coding › Context card (CTX05): the prerequisite evidence the coding agent
// keeps for each initiative. Only non-secret facts are rendered — the
// initiative id, health/freshness labels, age, omission/truncation counts,
// packet_id + sha256 refs and blocker codes. Never summaries, paths or
// transcripts. An agent without the fields degrades to an empty card.

const CONTEXT_HEALTH = {
  ok: { label: "Healthy", tone: "done" },
  stale: { label: "Stale", tone: "attention" },
  blocked: { label: "Blocked", tone: "attention" },
  unknown: { label: "Unknown", tone: "todo" },
};

// The inline revision editor: which initiative's decision is being approved
// or rejected, and the revision the owner has typed.
let contextEditor = null;
let contextRevisionDraft = "";

function contextAge(seconds) {
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) return "age unknown";
  return `age ${formatDuration(Math.max(0, seconds))}`;
}

// A packet reference: only its id and checksum, never its contents.
function contextPacket(packet) {
  if (!packet || typeof packet !== "object" || Array.isArray(packet)) return null;
  const parts = [];
  if (typeof packet.packet_id === "string" && packet.packet_id) {
    parts.push(`packet ${packet.packet_id}`);
  }
  if (typeof packet.sha256 === "string" && packet.sha256) {
    parts.push(`sha256 ${packet.sha256}`);
  }
  return parts.length ? el("div", parts.join(" · "), "card-note context-packet") : null;
}

function contextBlockers(blockers) {
  if (!Array.isArray(blockers) || !blockers.length) return [];
  return [el("div", `Blocked by: ${blockers.join(" · ")}`, "card-note context-blockers")];
}

// Confirm, then queue the request. Navigation or a new pending action is
// re-checked before the send, like every other dashboard action.
function contextButton(label, key, action, args, question) {
  const button = el("button", label, "row-button");
  button.type = "button";
  button.disabled = hasPendingActions();
  if (isActionPending(key)) button.textContent = "Sending…";
  button.addEventListener("click", () => {
    if (button.disabled) return;
    button.disabled = true;
    const origin = generation;
    askConfirmation(question, (isConfirmed) => {
      if (origin !== generation) return;
      if (isConfirmed) requestAction(key, action, args);
      else button.disabled = hasPendingActions();
    });
  });
  return button;
}

// Approve / reject needs a revision: open an inline input seeded with the
// agent's latest published revision, then send after confirmation.
function decisionButton(label, action, scope, id, code, revision) {
  const key = `context:${action}:${id}`;
  const button = el("button", label, "row-button");
  button.type = "button";
  button.disabled = hasPendingActions();
  if (isActionPending(key)) button.textContent = "Sending…";
  button.addEventListener("click", () => {
    if (button.disabled) return;
    const isOpen = contextEditor && contextEditor.key === key;
    contextEditor = isOpen ? null : { key, scope, id, code, action, revision };
    contextRevisionDraft = String(revision ?? "");
    refresh();
  });
  return button;
}

function contextEditorRows(initiative) {
  if (!contextEditor || contextEditor.scope !== "initiative" || contextEditor.id !== initiative.id) {
    return [];
  }
  const input = el("input");
  input.type = "number";
  input.min = "1";
  input.step = "1";
  input.value = contextRevisionDraft;
  input.disabled = hasPendingActions();
  input.setAttribute("aria-label", "Decision revision");
  input.addEventListener("input", () => { contextRevisionDraft = input.value; });

  const verb = contextEditor.action === "approve" ? "Approve" : "Reject";
  const key = contextEditor.key;
  const validRevision = /^[1-9][0-9]{0,8}$/.test(contextRevisionDraft.trim());
  const send = el("button", `Send ${verb.toLowerCase()}`, "row-button");
  send.type = "button";
  send.disabled = hasPendingActions() || !validRevision;
  send.addEventListener("click", () => {
    if (send.disabled) return;
    const revision = contextRevisionDraft.trim();
    const origin = generation;
    askConfirmation(
      `${verb} decision ${contextEditor.code} at revision ${revision}? The coding agent confirms this in your chat before it applies.`,
      (isConfirmed) => {
        if (origin !== generation) return;
        if (!isConfirmed) return;
        requestAction(key, `context_${contextEditor.action}_v1`, {
          scope: contextEditor.scope,
          id: contextEditor.id,
          decision: contextEditor.code,
          revision,
        });
        contextEditor = null;
      },
    );
  });

  const cancel = el("button", "Cancel", "row-button work-secondary");
  cancel.type = "button";
  cancel.addEventListener("click", () => { contextEditor = null; refresh(); });
  const editor = el("div", null, "work-actions");
  editor.append(input, send, cancel);
  return [editor];
}

function contextActions(initiative) {
  const id = initiative.id;
  const buttons = [
    contextButton("Inspect", `context:inspect:${id}`, "context_inspect_v1",
      { scope: "initiative", kind: "evidence", id },
      `Re-check the context evidence for initiative ${id}? This uses AI tokens.`),
    contextButton("Link", `context:link:${id}`, "context_link_v1",
      { scope: "initiative", kind: "packet", id },
      `Re-link the handoff packet for initiative ${id}? This uses AI tokens.`),
  ];
  const decision = initiative.decision;
  if (decision && typeof decision === "object" && typeof decision.code === "string" && decision.code) {
    buttons.push(
      decisionButton("Approve", "approve", "initiative", id, decision.code, decision.revision),
      decisionButton("Reject", "reject", "initiative", id, decision.code, decision.revision),
    );
  }
  return workActions(...buttons);
}

function initiativeRow(initiative) {
  const health = CONTEXT_HEALTH[initiative.health] || CONTEXT_HEALTH.unknown;
  const node = el("article", null, "task context-initiative");
  const head = el("div");
  const badge = el("span", health.label, "task-status");
  badge.dataset.tone = health.tone;
  head.append(el("span", initiative.id, "task-title"), badge);
  node.append(head);

  const meta = [];
  if (typeof initiative.freshness === "string" && initiative.freshness) {
    meta.push(`freshness ${initiative.freshness}`);
  }
  meta.push(contextAge(initiative.age_seconds));
  if (Number.isInteger(initiative.omissions) || Number.isInteger(initiative.truncations)) {
    const counts = [];
    if (Number.isInteger(initiative.omissions)) counts.push(`${initiative.omissions} omitted`);
    if (Number.isInteger(initiative.truncations)) counts.push(`${initiative.truncations} truncated`);
    meta.push(counts.join(", "));
  }
  if (meta.length) node.append(el("div", meta.join(" · "), "task-meta"));

  const packets = Array.isArray(initiative.packets) ? initiative.packets : [];
  for (const packet of packets) {
    const line = contextPacket(packet);
    if (line) node.append(line);
  }
  node.append(...contextBlockers(initiative.blockers));
  node.append(contextActions(initiative), ...contextEditorRows(initiative));
  return node;
}

function contextCard(snapshot) {
  const initiatives = snapshot.initiatives;
  if (!Array.isArray(initiatives) || !initiatives.length) {
    return card("Context",
      muted("No context published yet. Update the coding agent to manage prerequisite evidence here."));
  }
  return card("Context", ...initiatives.map(initiativeRow));
}

function contextRecoveryWarning(snapshot) {
  if (snapshot.context_recovery_pending !== true) return null;
  return wideCard("Context recovery",
    statusText("warn", "The coding agent has pending context recovery. Approve or reject the pending decision below."));
}

// Nodes for the Coding window: a warning line (when the agent asks for a
// decision) followed by the Context card. Old snapshots yield only the empty
// card, so the window never breaks.
function contextCards(snapshot) {
  const warning = contextRecoveryWarning(snapshot);
  const nodes = [];
  if (warning) nodes.push(warning);
  nodes.push(contextCard(snapshot));
  return nodes;
}
