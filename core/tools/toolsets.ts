// @layer core — toolsets: the named groups the tool surface is listed in.
//
// Every verb an agent can be offered belongs to exactly one toolset. `core` is
// always listed; the rest are off unless a connection selects them (opentide.json
// `toolsets`, `opentide mcp --tools`, `/mcp?toolsets=`) or the agent turns one on
// with set_toolset. The order here is the listing order: `core` first, and inside
// it project_status and the changeset flow, so a client that keeps only the first
// N tools keeps the work loop.
import type { CustomToolDef } from "./definitions.ts";

export const TOOLSETS = {
  core: [
    "project_status",
    "create_changeset",
    "update_changeset_plan",
    "amend_changeset_plan",
    "approve_changeset",
    "update_changeset_step",
    "check_changeset_readiness",
    "record_verification_run",
    "complete_changeset",
    "abandon_changeset",
    "adopt_changeset",
    "get_changeset",
    "list_changesets",
    "get_changeset_context",
    "request_review",
    "submit_review",
    "verify_formal_specs",
    "define_handler",
    "define_function",
    "register_route",
    "define_schema",
    "alter_schema",
    "define_type",
    "define_template",
    "define_test",
    "edit_entity_text",
    "remove_entity",
    "execute_sql",
    "upload_text_asset",
    "upload_asset",
    "list_assets",
    "install_package",
    "list_packages",
    "define_secret",
    "list_secrets",
    "define_env_var",
    "list_env_vars",
    "run_tests",
    "test_app",
    "screenshot_app",
    "show_app",
    "run_script",
    "lint_code",
    "list_routes",
    "list_handlers",
    "list_functions",
    "list_schemas",
    "list_types",
    "list_templates",
    "list_modules",
    "list_tests",
    "get_logs",
    "query_database",
    "get_code_context",
    "find_similar_entities",
    "blast_radius",
    // Readiness warns when AGENT.md is stale; this is the fix, so it stays in reach.
    "generate_project_docs",
    "set_toolset",
  ],
  sessions: [
    "get_session_context",
    "manage_sessions",
    "open_session",
    "append_session_messages",
    "link_session_message",
    "set_session_summary",
    "record_usage",
    // The integrated agent's own session and launcher verbs; never on MCP.
    "summarize_session",
    "list_projects",
    "get_project_context",
  ],
  docs: [
    "document_query",
    "document_write",
    "document_pin",
  ],
  devtools: [
    "define_dev_view",
    "list_dev_views",
    "define_dev_tool",
    "list_dev_tools",
    "call_dev_tool",
    "get_platform_docs",
  ],
  project: [
    "write_project_file",
    "flush_project_state",
    "export_project",
    "rename_module",
    "move_to_module",
    "set_system_prompt",
  ],
  quality: [
    "test_coverage",
    "check_export_types",
    "analyze",
    "find_unused_packages",
    "check_package_security",
    "list_audits",
    "define_audit",
  ],
  changelog: [
    "search_changes",
    "list_turns",
    "get_change",
    "goto_change",
    "undo_change",
    "redo_change",
    "undo_turn",
    "redo_turn",
  ],
  tasks: ["start_task", "list_tasks", "merge_task", "discard_task"],
  source: ["index_codebase", "preview_project_file", "apply_project_file"],
  git: [
    "git_status",
    "git_init",
    "git_add_tide_gitignore",
    "git_set_remote",
    "git_commit",
    "git_push",
  ],
  data: ["export_data", "import_data", "reset_data"],
  snapshots: [
    "create_branch",
    "switch_branch",
    "delete_branch",
    "take_snapshot",
    "restore_snapshot",
  ],
  config: [
    "set_config",
    "list_configs",
    "delete_config",
    "set_env",
    "list_env",
    "delete_env",
  ],
} as const satisfies Record<string, readonly string[]>;

export type Toolset = keyof typeof TOOLSETS;

export const CORE_TOOLSET: Toolset = "core";
// Source-backed projects always get it: they're edited through these verbs.
export const SOURCE_TOOLSET: Toolset = "source";
// Selects every toolset.
export const ALL_TOOLSETS = "all";

export const TOOLSET_NAMES: readonly Toolset[] = Object.keys(
  TOOLSETS,
) as Toolset[];

// One line per toolset, for set_toolset's description and the docs.
export const TOOLSET_SUMMARIES: Readonly<Record<Toolset, string>> = {
  core: "the build-and-verify loop (always on)",
  sessions: "read past sessions and write this session's history",
  docs: "the durable document store",
  devtools: "dev views, dev tools and platform docs",
  project: "project files, state flush, export, modules, custom instructions",
  quality: "coverage, type check, static analysis, package audits, AI audits",
  changelog: "search, inspect, undo and redo past changes",
  tasks: "fork the project into parallel tasks and merge them back",
  source: "index and edit an imported source-backed project's files",
  git: "status, init, remotes, commit and push",
  data: "export, import and reset fixture data",
  snapshots: "state snapshots and snapshot branches (not Git)",
  config: "app config values and changeset-free env vars",
};

const TOOLSET_BY_TOOL: ReadonlyMap<string, Toolset> = new Map(
  TOOLSET_NAMES.flatMap((set) =>
    TOOLSETS[set].map((tool): [string, Toolset] => [tool, set])
  ),
);

const LISTING_ORDER: ReadonlyMap<string, number> = new Map(
  TOOLSET_NAMES.flatMap((set) => TOOLSETS[set]).map((tool, i) => [tool, i]),
);

export function isToolset(value: unknown): value is Toolset {
  return typeof value === "string" && Object.hasOwn(TOOLSETS, value);
}

// The toolset a verb belongs to, or null for a verb that's in none.
export function toolsetOf(tool: string): Toolset | null {
  return TOOLSET_BY_TOOL.get(tool) ?? null;
}

// Which toolsets are on. Always holds `core`.
export type ToolsetSelection = ReadonlySet<Toolset>;

export interface ParsedToolsets {
  selection: ToolsetSelection;
  // Names that aren't toolsets, in the order given.
  unknown: string[];
}

// A selection from names as written (opentide.json, --tools, ?toolsets=).
// `all` selects every toolset; `core` is added whatever is given.
export function parseToolsets(names: readonly string[]): ParsedToolsets {
  const selection = new Set<Toolset>([CORE_TOOLSET]);
  const unknown: string[] = [];
  for (const raw of names) {
    const name = raw.trim();
    if (!name) continue;
    if (name === ALL_TOOLSETS) TOOLSET_NAMES.forEach((s) => selection.add(s));
    else if (isToolset(name)) selection.add(name);
    else unknown.push(name);
  }
  return { selection, unknown };
}

// A comma-separated list (--tools git,docs; ?toolsets=git,docs).
export function parseToolsetList(list: string): ParsedToolsets {
  return parseToolsets(list.split(","));
}

export const CORE_ONLY: ToolsetSelection = new Set([CORE_TOOLSET]);
export const EVERY_TOOLSET: ToolsetSelection = new Set(TOOLSET_NAMES);

// Whether the selection lists `tool`. A verb in no toolset is never listed.
export function selects(selection: ToolsetSelection, tool: string): boolean {
  const set = toolsetOf(tool);
  return set !== null && selection.has(set);
}

// The selection's toolsets in TOOLSETS order, for results and messages.
export function selectionNames(selection: ToolsetSelection): Toolset[] {
  return TOOLSET_NAMES.filter((s) => selection.has(s));
}

// Sort tools into listing order; tools in no toolset go last, as given.
export function inListingOrder<T extends { name: string }>(
  tools: readonly T[],
): T[] {
  const rank = (t: T) => LISTING_ORDER.get(t.name) ?? LISTING_ORDER.size;
  return [...tools].sort((a, b) => rank(a) - rank(b));
}

// --- set_toolset ---

export const SET_TOOLSET = "set_toolset";

export const SET_TOOLSET_TOOL: CustomToolDef = {
  type: "custom",
  name: SET_TOOLSET,
  description:
    "Turn one toolset on or off for this connection. Tools outside the " +
    "toolsets that are on aren't listed and are refused with TOOLSET_OFF. " +
    "Returns the toolsets on after the call; calling it with the state " +
    "already set changes nothing. Toolsets: " +
    TOOLSET_NAMES.filter((s) => s !== CORE_TOOLSET)
      .map((s) => `${s} (${TOOLSET_SUMMARIES[s]})`).join("; ") +
    ". core is always on.",
  input_schema: {
    type: "object",
    properties: {
      toolset: {
        type: "string",
        enum: TOOLSET_NAMES.filter((s) => s !== CORE_TOOLSET),
        description: "The toolset to turn on or off.",
      },
      enabled: {
        type: "boolean",
        description: "true turns it on, false turns it off.",
      },
    },
    required: ["toolset", "enabled"],
  },
};

export type SetToolsetResult =
  | { ok: true; selection: ToolsetSelection; changed: boolean }
  | { ok: false; error: { code: string; message: string } };

// Apply one set_toolset call to `selection`. Pure: returns the new selection.
export function applySetToolset(
  selection: ToolsetSelection,
  args: Record<string, unknown>,
): SetToolsetResult {
  const { toolset, enabled } = args;
  if (toolset === CORE_TOOLSET) {
    return {
      ok: false,
      error: { code: "TOOLSET_REQUIRED", message: "core is always on." },
    };
  }
  if (!isToolset(toolset)) {
    return {
      ok: false,
      error: {
        code: "UNKNOWN_TOOLSET",
        message: `"${String(toolset)}" isn't a toolset. Toolsets: ${
          TOOLSET_NAMES.join(", ")
        }.`,
      },
    };
  }
  if (typeof enabled !== "boolean") {
    return {
      ok: false,
      error: {
        code: "INVALID_ARGUMENTS",
        message: "enabled must be true or false.",
      },
    };
  }
  if (selection.has(toolset) === enabled) {
    return { ok: true, selection, changed: false };
  }
  const next = new Set(selection);
  if (enabled) next.add(toolset);
  else next.delete(toolset);
  return { ok: true, selection: next, changed: true };
}

// What set_toolset returns to the agent.
export function setToolsetData(selection: ToolsetSelection, changed: boolean) {
  return { toolsets: selectionNames(selection), changed };
}

export const TOOLSET_OFF = "TOOLSET_OFF";

// The refusal for a call to a verb whose toolset is off.
export function toolsetOffMessage(tool: string, set: Toolset): string {
  return `${tool} is in the "${set}" toolset, which is off. Call ` +
    `${SET_TOOLSET} with toolset "${set}" and enabled true, or add "${set}" ` +
    `to "toolsets" in opentide.json.`;
}
