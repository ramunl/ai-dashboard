// DS05 coding snapshot registry + the legacy codex/claude fallback. This file
// mirrors ai_dashboard/agent_actions.py: the registry is validated whole, and
// a missing or malformed registry falls back to the pre-DS05 setup shape so an
// older agent keeps the same controls it had before.
//
//   registry = {
//     format: 1,
//     roles: {
//       planner:     { tool: "<tool id>", options: ["<tool id>", ...] },
//       implementer: { tool: "<tool id>", options: ["<tool id>", ...] },
//     },
//     tools: {
//       "<tool id>": { label, provider, model, models, manageable, note, models_error },
//     },
//     providers: {
//       "<provider id>": { label, kind: "subscription" | "api", limits },
//     },
//   }

const CODING_REGISTRY_FORMAT = 1;
// Legacy labels for the pre-DS05 tools; "claude" resolves to Claude API for the
// planner and Claude Code for the implementer, exactly as before.
const LEGACY_TOOL_LABELS = { codex: "Codex", claude: "Claude API", "claude-code": "Claude Code" };
const LEGACY_ROLE_TOOL = {
  planner: { codex: "codex", claude: "claude" },
  implementer: { codex: "codex", claude: "claude-code" },
};
// Retry/resume buttons re-run implementation; the old snapshot names these two.
const LEGACY_RETRY_TOOLS = [
  { id: "codex", label: "Codex" },
  { id: "claude", label: "Claude" },
];
// The pre-DS05 limits rows, in their old order and with their old renderers.
const LEGACY_LIMIT_PROVIDERS = [
  { id: "codex", label: "Codex", kind: "subscription", limits: "codex" },
  { id: "claude-code", label: "Claude Code", kind: "subscription", limits: "claude_code" },
  { id: "claude", label: "Claude API", kind: "api", limits: "claude" },
];

function codingRegistryId(value) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value);
}

function codingRegistryModel(value) {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{1,100}$/.test(value);
}

function codingRegistryTool(id, tool) {
  if (!tool || typeof tool !== "object" || Array.isArray(tool)) return false;
  if (typeof tool.label !== "string" || !tool.label.trim()) return false;
  if (!codingRegistryId(tool.provider)) return false;
  if (typeof tool.manageable !== "boolean") return false;
  if (tool.model !== null && !codingRegistryModel(tool.model)) return false;
  if (!Array.isArray(tool.models) || !tool.models.every(codingRegistryModel)) return false;
  return true;
}

// The validated DS05 registry, or null when the snapshot has none or its
// registry is malformed (the same rule the Python allowlist check applies).
function codingRegistry(snapshot) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return null;
  const registry = snapshot.registry;
  if (!registry || typeof registry !== "object" || Array.isArray(registry)) return null;
  if (registry.format !== CODING_REGISTRY_FORMAT) return null;
  const tools = registry.tools;
  const roles = registry.roles;
  if (!tools || typeof tools !== "object" || Array.isArray(tools)) return null;
  if (!roles || typeof roles !== "object" || Array.isArray(roles)) return null;
  for (const [id, tool] of Object.entries(tools)) {
    if (!codingRegistryId(id) || !codingRegistryTool(id, tool)) return null;
  }
  for (const role of ["planner", "implementer"]) {
    const entry = roles[role];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
    if (!codingRegistryId(entry.tool) || !tools[entry.tool]) return null;
    if (!Array.isArray(entry.options) || !entry.options.length) return null;
    if (!entry.options.every((option) => codingRegistryId(option) && tools[option])) return null;
    if (!entry.options.includes(entry.tool)) return null;
  }
  return registry;
}

// The validated limit providers, or null to keep the legacy limits rows.
function codingRegistryProviders(registry) {
  const providers = registry && typeof registry === "object" ? registry.providers : null;
  if (!providers || typeof providers !== "object" || Array.isArray(providers)) return null;
  const rows = [];
  for (const [id, entry] of Object.entries(providers)) {
    if (!codingRegistryId(id) || !entry || typeof entry !== "object" || Array.isArray(entry)) return null;
    if (typeof entry.label !== "string" || !entry.label.trim()) return null;
    if (entry.kind !== "subscription" && entry.kind !== "api") return null;
    if (typeof entry.limits !== "string" || !entry.limits) return null;
    rows.push({ id, label: entry.label, kind: entry.kind, limits: entry.limits });
  }
  return rows;
}

// A normalized view used by the Coding AI tools, Setup and Tasks views:
// { registry: bool, roles: { planner, implementer }, tools: { id: {...} } }.
// role.options are { value, label }; role.tool is the tool id for model lookup
// and role.current is the value actually sent in set_planner/set_implementer.
function codingToolsModel(snapshot) {
  const registry = codingRegistry(snapshot);
  if (registry) return codingToolsFromRegistry(registry);
  if (snapshot && typeof snapshot === "object" && snapshot.setup) {
    return codingToolsFromSetup(snapshot.setup);
  }
  return null;
}

function codingToolsFromRegistry(registry) {
  const tools = {};
  for (const [id, tool] of Object.entries(registry.tools)) {
    tools[id] = {
      tool: id,
      label: tool.label,
      provider: tool.provider,
      model: tool.model,
      models: tool.models || [],
      manageable: tool.manageable === true,
      note: typeof tool.note === "string" ? tool.note : "",
      modelsError: typeof tool.models_error === "string" ? tool.models_error : null,
    };
  }
  return {
    registry: true,
    roles: {
      planner: codingRegistryRole(registry.roles.planner, tools),
      implementer: codingRegistryRole(registry.roles.implementer, tools),
    },
    tools,
  };
}

function codingRegistryRole(entry, tools) {
  return {
    current: entry.tool,
    tool: entry.tool,
    options: entry.options.map((id) => ({ value: id, label: tools[id].label })),
  };
}

function codingToolsFromSetup(setup) {
  const tools = {};
  for (const entry of Array.isArray(setup.models) ? setup.models : []) {
    if (!entry || typeof entry !== "object" || !codingRegistryId(entry.tool)) continue;
    tools[entry.tool] = {
      tool: entry.tool,
      label: LEGACY_TOOL_LABELS[entry.tool] || entry.tool,
      provider: entry.tool,
      model: entry.model,
      models: Array.isArray(entry.choices) ? entry.choices : [],
      manageable: entry.manageable === true,
      note: typeof entry.note === "string" ? entry.note : "",
      modelsError: entry.choices_error || null,
    };
  }
  return {
    registry: false,
    roles: {
      planner: codingLegacyRole("planner", setup, tools),
      implementer: codingLegacyRole("implementer", setup, tools),
    },
    tools,
  };
}

function codingLegacyRole(role, setup, tools) {
  const current = typeof setup[role] === "string" ? setup[role] : "";
  const tool = LEGACY_ROLE_TOOL[role][current] || current;
  const options = (Array.isArray(setup[`${role}_options`]) ? setup[`${role}_options`] : [current])
    .filter((value) => typeof value === "string")
    .map((value) => ({ value, label: value }));
  return { current, tool, options };
}
