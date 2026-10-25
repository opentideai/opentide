// @layer mcp — outbound MCP server: projects the core tool surface over MCP
// (OpenTide §4). This module is the transport-agnostic heart: it turns the
// existing tool definitions into an MCP tool list and routes MCP tool calls
// through the EXISTING dispatch. It re-exposes the verbs agents already speak
// and is NOT a new API — public tool names are a stable contract (§2 non-goal),
// so it never renames them.
//
// Layer rule (§3.2): mcp (L2) may import only core (L1). It reaches the tool
// catalog + dispatch + the capability introspection, all core, and nothing in
// verification/agent. The composition root (mcp-main.ts) assembles those
// upper-layer handlers into the Kernel's composition (cli/assembly.ts); this
// module only reads whether they are present so it can hide verbs that would
// otherwise throw.
import type { Kernel } from "../core/registries.ts";
import type { Changeset } from "../core/types.ts";
import type { ChangeContext } from "../core/changelog.ts";
import { AGENT_TOOLS, type CustomToolDef } from "../core/tools/definitions.ts";
import {
  dispatchTool,
  isDestructiveTool,
  isIdempotentTool,
  isOpenWorldTool,
  isReadOnlyTool,
  MAY_BILL_TOOLS,
  type ToolResult,
} from "../core/tools/dispatch.ts";
import {
  canBillUnder,
  isToolCapabilityAvailable,
} from "../core/tool-capabilities.ts";
import { checkToolArgs, formatArgIssues } from "../core/tools/validate-args.ts";
import type { CompositionContext } from "../core/composition.ts";
import { canonicalizeJson, hashParts } from "../core/fingerprint.ts";
import { MCP_SURFACE_VERSION } from "../core/config.ts";
import { encodeBase64, errorMessage } from "../core/util.ts";
import type { CreatedTaskWithServe } from "../shared/tasks.ts";
import { taskConnect } from "./mcp-connect.ts";
import { SHOW_APP, showAppListing, showAppResult } from "./mcp-app-preview.ts";

// The standard MCP tool annotations (SDK ToolAnnotationsSchema). All advisory
// hints: clients use them to auto-approve reads, warn on destructive calls, etc.
// They never change what a verb does; input schemas and names are untouched.
export interface McpToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

// An MCP tool as advertised over `tools/list`. Shape matches the MCP spec's
// Tool (name + description + JSON-Schema inputSchema + optional annotations),
// which is what the core CustomToolDef already carries — only the field name
// differs — plus the derived annotations this layer adds.
export interface McpToolListing {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: McpToolAnnotations;
  // Free-form per-tool metadata (SDK Tool._meta). Today it carries only the
  // deprecation marker (MCP_DEPRECATED_META_KEY); absent on non-deprecated verbs.
  _meta?: Record<string, unknown>;
}

// A content block in an MCP `tools/call` result. We emit text (the JSON tool
// data or an error message) and image blocks (screenshots surfaced by dispatch).
export type McpContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export interface McpToolResult {
  content: McpContent[];
  isError?: boolean;
  // Data for an MCP App rendering the result (show_app's URL); the model reads
  // `content`.
  structuredContent?: Record<string, unknown>;
}

// Verbs that survive into AGENT_TOOLS (they matter to the integrated IDE agent)
// but are meaningless to a headless external MCP agent: they address the Genie
// IDE chat-session / launcher model, which does not exist when an external agent
// drives a single loaded project over MCP. We hide them at the PROJECTION layer
// — NOT via the core AGENT_TOOL_EXCLUDE — because MCP is a thin projection that
// may advertise a narrower surface than the catalog while the integrated agent
// keeps the full set (§4 non-goal: public tool names are unchanged, we just do
// not advertise these over this face).
//
//   summarize_session / get_session_context / manage_sessions — operate on
//     Genie IDE chat sessions; a headless agent has its own conversation, so
//     there is no Genie session to summarize, read, or manage.
//   list_projects       — the launcher's cross-project list (with recent-session
//     summaries); the MCP agent drives the one project loaded via --project, not
//     the launcher.
//   get_project_context — its distinguishing value (cross-project @mention
//     resolution, recent sessions) is launcher/session-scoped; its current-project
//     entity counts are already covered by list_routes/handlers/schemas/modules.
// Verbs only this face has, not in AGENT_TOOLS: show_app (the IDE has its own
// preview pane). They carry their own listing and annotations.
export const MCP_ONLY_TOOLS: ReadonlySet<string> = new Set([SHOW_APP]);

const MCP_EXCLUDED_TOOLS: ReadonlySet<string> = new Set([
  "summarize_session",
  "get_session_context",
  "manage_sessions",
  "list_projects",
  "get_project_context",
]);

// Why a verb is (not) exposed over MCP. `excluded` = an IDE-only session/launcher
// verb that this face never advertises; `no-capability` = its handler layer is
// not assembled in this build. This is the single classifier that defines the
// MCP surface — projectedMcpTools advertises exactly the `ok` verbs, and
// dispatchMcpTool derives its two distinct refusal messages from the same
// result, so the advertised list equals the callable list with no double-check.
type ToolAvailability = "ok" | "excluded" | "no-capability";

function toolAvailability(
  composition: CompositionContext,
  name: string,
): ToolAvailability {
  if (MCP_EXCLUDED_TOOLS.has(name)) return "excluded";
  // Capability gating is owned by the core registry (tool-capabilities.ts): a
  // verb whose required handler class is absent from this Kernel's composition is
  // hidden rather than advertised as callable. This keeps the advertised list in
  // lock-step with what the running assembly can actually dispatch — no
  // hand-maintained list here.
  if (!isToolCapabilityAvailable(composition, name)) return "no-capability";
  return "ok";
}

// An isError tool result carrying a single text block. The three failure exits
// below (tool error, hidden verb, thrown error) all share this shape.
function textError(text: string): McpToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

// A few core tool descriptions assume the integrated IDE / human-approval
// context, which does not exist for a headless external agent. For the MCP face
// we overlay a corrected description here — mirroring the F1 MCP_EXCLUDED_TOOLS
// projection-layer pattern — rather than editing core CUSTOM_TOOLS, so the
// integrated IDE agent's surface is unchanged. Only the advisory description text
// changes; names and input schemas never do.
//
//   create_changeset — core tells the agent to "wait for the user to approve",
//     but this face auto-approves the changeset to in_progress (Slice B), so that
//     instruction is actively wrong here and would strand a headless agent.
//   amend_changeset_plan — core says the amendment goes back to the user for
//     approval; this face re-approves it automatically (projectAutoAdvance).
//   export_project   — core says "the user can download the archive from the UI";
//     there is no UI for an MCP agent.
const MCP_DESCRIPTION_OVERRIDES: Readonly<Record<string, string>> = {
  create_changeset:
    "Propose a detailed plan for a complex request. Include what will be done, " +
    "how it will be implemented, why it is needed, and why this implementation " +
    "strategy fits the existing app. Creates a changeset and, on this MCP " +
    "interface, auto-approves it to 'in_progress' so you can begin work " +
    "immediately — there is no separate human approval step. The " +
    "completion/readiness gate still applies at complete_changeset.",
  amend_changeset_plan:
    "Amend the active changeset's plan when the work outgrows it: add steps, " +
    "acceptance criteria, verification plan entries, or formal specs, and append " +
    "to the summary. Amending a light-lane changeset escalates it to standard. " +
    "On this MCP interface the amended changeset is re-approved and restarted " +
    "automatically, so carry on with the work straight after.",
  export_project:
    "Export the current app as a standalone Deno project. Pass `out` to write the " +
    "export tree to a directory inside the project (default dist/v<version>) — on " +
    "this interface that is the only way to get files on disk, and it is done by " +
    "the process that already holds the project lock, so never run the `opentide " +
    "export` CLI against a project this server has open. Without `out` you get " +
    "file metadata and nothing written. Always generates .env.example if secrets " +
    "are defined. Optionally includes .env with resolved secret values, and " +
    "manifest.json with per-file hashes and a sourceFingerprint via includeManifest.",
};

// --- Surface versioning + deprecation (F4, OpenTide §10) ---
//
// The projected MCP tool surface is a PUBLISHED external contract, so it is
// versioned and evolvable without silent breakage. Two `_meta` namespaces carry
// that governance on the wire (both are standard SDK `_meta` channels — the
// tools/list result `_meta` is spec-loose, per-tool `_meta` is a free record):
//   - opentide/surface   — on the tools/list RESULT: the surface version +
//                          structural fingerprint + tool count (mcpSurfaceMeta).
//   - opentide/deprecated — on a deprecated TOOL: the structured deprecation
//                          record (deprecationMetaValue).
// Keys are namespaced constants (no magic strings); a client keys on them.
export const MCP_SURFACE_META_KEY = "opentide/surface";
export const MCP_DEPRECATED_META_KEY = "opentide/deprecated";

// One deprecated verb's contract metadata. `since`/`removeAfter` are
// MCP_SURFACE_VERSION strings. Deprecating a verb does NOT change what it does
// (it still dispatches unchanged) — it is an advisory signal that the verb is on
// a removal path, so pinned clients can migrate before a future major bump.
export interface McpDeprecation {
  since: string; // surface version in which the verb was deprecated
  removeAfter?: string; // earliest surface MAJOR version it may be removed at
  supersededBy?: string; // the replacement verb name, if any
  note?: string; // human explanation / migration guidance
}

// The per-verb deprecation registry — an mcp-projection OVERLAY, mirroring F1's
// MCP_EXCLUDED_TOOLS and F3's MCP_DESCRIPTION_OVERRIDES. Deprecation is a property
// of the PUBLISHED MCP face (the frozen external contract, §10), not of the
// intrinsic core verb: the integrated IDE agent's surface versions with the app
// and needs no deprecation signal, so core CUSTOM_TOOLS stays untouched and this
// lives here.
//
// It is EMPTY today — no verb is deprecated. F4 ships the mechanism + policy, not
// a deprecation. A verb is added here only when it is genuinely on a removal path;
// the policy (docs/mcp-connect.md) then governs when/whether it may ever leave.
export const MCP_DEPRECATIONS: Readonly<Record<string, McpDeprecation>> = {};

// The human-visible deprecation banner prepended to a deprecated verb's
// description, so clients that surface only the description to the model (not
// _meta) still see the signal. The structured _meta record is the authoritative
// machine form; this mirrors it.
function deprecationDescription(entry: McpDeprecation, base: string): string {
  const parts = [`since v${entry.since}`];
  if (entry.supersededBy) parts.push(`use "${entry.supersededBy}" instead`);
  if (entry.removeAfter) {
    parts.push(`may be removed after v${entry.removeAfter}`);
  }
  const banner = `DEPRECATED (${parts.join("; ")}).` +
    (entry.note ? ` ${entry.note}` : "");
  return `${banner}\n\n${base}`;
}

// The structured deprecation record placed under _meta[MCP_DEPRECATED_META_KEY].
// A plain object copy (no undefined optional keys) so the wire payload is clean.
function deprecationMetaValue(entry: McpDeprecation): Record<string, unknown> {
  const value: Record<string, unknown> = { since: entry.since };
  if (entry.removeAfter) value.removeAfter = entry.removeAfter;
  if (entry.supersededBy) value.supersededBy = entry.supersededBy;
  if (entry.note) value.note = entry.note;
  return value;
}

// Overlay a deprecation onto a base listing: prepend the human banner to the
// description and attach the structured _meta record (both wire signals). The
// single seam toListing uses — exported so the mechanism is directly testable
// with a synthetic entry while MCP_DEPRECATIONS is empty (F4 ships the mechanism,
// not a deprecation).
export function applyDeprecation(
  listing: McpToolListing,
  entry: McpDeprecation,
): McpToolListing {
  return {
    ...listing,
    description: deprecationDescription(entry, listing.description),
    _meta: {
      ...listing._meta,
      [MCP_DEPRECATED_META_KEY]: deprecationMetaValue(entry),
    },
  };
}

// Verb-name segments to upper-case whole in a humanized title; other words are
// Title-Cased. Only segments that actually occur in a tool name belong here
// (today just "sql", from execute_sql) — add one when a verb that needs it ships.
const TITLE_ACRONYMS: Readonly<Record<string, string>> = {
  sql: "SQL",
};

// A human-readable display name derived from the snake_case verb, e.g.
// "define_handler" → "Define Handler". Derived, not a per-tool table.
function humanizeToolName(name: string): string {
  return name
    .split("_")
    .map((word) =>
      TITLE_ACRONYMS[word] ?? (word.charAt(0).toUpperCase() + word.slice(1))
    )
    .join(" ");
}

// Derive the standard MCP annotations for a verb from the core behavioral
// classifiers (dispatch.ts) — no per-tool table in this layer. readOnlyHint comes
// from the explicit READ_ONLY_TOOLS allowlist (never the complement of
// MODIFICATION_TOOLS). destructiveHint/idempotentHint are only meaningful for
// writers, so they are emitted only when the verb is not read-only. A humanized
// title and openWorldHint are emitted for every verb.
function toolAnnotations(name: string): McpToolAnnotations {
  const readOnly = isReadOnlyTool(name);
  const annotations: McpToolAnnotations = {
    title: humanizeToolName(name),
    readOnlyHint: readOnly,
    openWorldHint: isOpenWorldTool(name),
  };
  if (!readOnly) {
    annotations.destructiveHint = isDestructiveTool(name);
    annotations.idempotentHint = isIdempotentTool(name);
  }
  return annotations;
}

// Prepended to every verb that can spend the user's model API key. It goes in
// the description because that is what reaches the model: clients do not show
// it a tool's _meta or annotations.
export const BILLED_DESCRIPTION_PREFIX =
  "BILLS the user's model API key (runs an LLM). Call only when the user asked for it.";

function toListing(
  tool: CustomToolDef,
  composition: CompositionContext,
): McpToolListing {
  const base = MCP_DESCRIPTION_OVERRIDES[tool.name] ?? tool.description;
  const listing: McpToolListing = {
    name: tool.name,
    description: MAY_BILL_TOOLS.has(tool.name) &&
        canBillUnder(composition, tool.name)
      ? `${BILLED_DESCRIPTION_PREFIX}${
        tool.name === "index_codebase"
          ? ' (Only with classification "assist".)'
          : ""
      }\n\n${base}`
      : base,
    inputSchema: tool.input_schema,
    annotations: toolAnnotations(tool.name),
  };
  const deprecation = MCP_DEPRECATIONS[tool.name];
  return deprecation ? applyDeprecation(listing, deprecation) : listing;
}

// The tool list advertised over MCP: the integrated agent's catalog
// (AGENT_TOOLS = the full tool surface minus UI-local verbs), minus the IDE-only
// session/launcher verbs (MCP_EXCLUDED_TOOLS), and capability-gated to what the
// current assembly can actually run. Reuses the existing definitions verbatim —
// no forked schemas, no renamed verbs.
export function projectedMcpTools(
  composition: CompositionContext,
): McpToolListing[] {
  return [
    ...AGENT_TOOLS
      .filter((t) => toolAvailability(composition, t.name) === "ok")
      .map((t) => toListing(t, composition)),
    // MCP-only: the IDE has its own preview pane.
    showAppListing(),
  ];
}

// A deterministic fingerprint of the STRUCTURAL tool contract — the tool names +
// input schemas an external agent pins against. Reuses the core order-independent
// set hash (fingerprint.ts hashParts), whose FNV-1a threat model (accidental
// drift, not adversarial collision) is exactly ours. DELIBERATELY excludes
// descriptions and annotations: those are advisory/non-breaking (F3), so a
// wording tweak must NOT force a surface-version bump. A test pins this value so
// any name/schema change fails until MCP_SURFACE_VERSION is consciously bumped
// (§10 anti-silent-drift).
export function mcpSurfaceFingerprint(
  tools: McpToolListing[],
): string {
  return hashParts(
    tools.map((t) =>
      `${t.name}\n${JSON.stringify(canonicalizeJson(t.inputSchema))}`
    ),
  );
}

// The surface metadata advertised in the tools/list result `_meta`
// (opentide/surface). The human-set contract version, the structural fingerprint,
// and the tool count — everything a client needs to detect that the surface it is
// pinned against has changed. Accepts the already-projected list to avoid a second
// projection when the caller (mcp-server.ts) has one in hand.
export interface McpSurfaceMeta {
  version: string;
  fingerprint: string;
  toolCount: number;
}

export function mcpSurfaceMeta(
  tools: McpToolListing[],
): McpSurfaceMeta {
  return {
    version: MCP_SURFACE_VERSION,
    fingerprint: mcpSurfaceFingerprint(tools),
    toolCount: tools.length,
  };
}

// Core refusals are written for the integrated IDE, where a human approves every
// changeset. Over MCP nobody does — create/amend auto-advance — so the IDE's
// "STOP and wait for the user" would strand a headless agent forever. Same
// overlay pattern as MCP_DESCRIPTION_OVERRIDES: core text stays right for the
// IDE, this face rewrites the parts that are wrong here. Keyed by error code;
// an absent field keeps core's text.
const MCP_ERROR_OVERRIDES: Readonly<
  Record<string, { message?: (name: string) => string; suggestion?: string }>
> = {
  CHANGESET_REQUIRED: {
    message: (name) =>
      `Tool "${name}" needs an in-progress changeset and there is none.`,
    suggestion:
      "Call create_changeset with your plan. On this MCP interface it is " +
      "approved and started automatically, so retry this call straight after.",
  },
  CHANGE_CLASS_EXCEEDED: {
    suggestion:
      "Call amend_changeset_plan with the added scope. That escalates the " +
      "changeset to the standard lane and, on this MCP interface, re-approves it " +
      "automatically, so retry this call straight after.",
  },
};

// Readiness issue actions that assume a human approver. Rewritten inside the
// INCOMPLETE_VERIFICATION message, which joins every issue's action into text.
const MCP_READINESS_ACTION_OVERRIDES: ReadonlyArray<[string, string]> = [
  [
    "Approve and start the changeset before completing it.",
    "Over MCP a changeset is started automatically by create_changeset or " +
    "amend_changeset_plan; if it is not in_progress, it was completed, " +
    "abandoned, or never created. Check list_changesets.",
  ],
];

function mcpErrorText(
  name: string,
  err: NonNullable<ToolResult["error"]>,
): string {
  const override = MCP_ERROR_OVERRIDES[err.code];
  let message = override?.message?.(name) ?? err.message;
  for (const [from, to] of MCP_READINESS_ACTION_OVERRIDES) {
    message = message.split(from).join(to);
  }
  const suggestion = override?.suggestion ?? err.suggestion;
  return [`Error [${err.code}]: ${message}`, suggestion].filter(Boolean)
    .join("\n");
}

// Map a core ToolResult onto an MCP tool-call result. Success serializes the
// tool data as JSON text plus any surfaced images; failure becomes an isError
// result carrying the semantic code/message/suggestion so the calling agent can
// react. Never throws.
function toMcpResult(name: string, result: ToolResult): McpToolResult {
  if (!result.ok) {
    return textError(
      result.error ? mcpErrorText(name, result.error) : "Tool call failed.",
    );
  }
  const content: McpContent[] = [
    { type: "text", text: JSON.stringify(result.data ?? null, null, 2) },
  ];
  for (const image of result._images ?? []) {
    content.push({
      type: "image",
      data: encodeBase64(image.png),
      mimeType: "image/png",
    });
  }
  return { content };
}

// The single policy seam for changeset approval on the MCP face (Phase 3 Slice
// B). A REST-driven changeset waits for a human to approve() then startWork()
// it (control-server.ts). A headless external MCP agent has neither a human nor
// a REST caller, so it would be stranded in `planning` — the mutation gate
// (dispatch.ts) only lets an `in_progress` changeset through. Here we
// auto-advance a freshly-created changeset to `in_progress` by REUSING the same
// core lifecycle primitives the REST handler calls — no forked transitions.
//
// This auto-satisfies ONLY the human intent-approval checkpoint, which
// structurally cannot exist headless. It deliberately does NOT touch the
// completion/readiness gate (checkChangesetReadiness inside complete_changeset),
// which is the safeguard that matters and still applies unchanged. Any future MCP-face
// approval policy lives here and nowhere else.
async function autoAdvanceChangeset(
  kernel: Kernel,
  changeset: Changeset,
): Promise<Changeset> {
  await kernel.changesets.approve(changeset.id); // planning → approved
  return await kernel.changesets.startWork(changeset.id); // approved → in_progress
}

// The verbs whose successful result leaves a changeset waiting for human
// approval: create_changeset (planning) and amend_changeset_plan (back to
// planning). Over MCP both are auto-advanced to in_progress.
const AUTO_ADVANCE_TOOLS: ReadonlySet<string> = new Set([
  "create_changeset",
  "amend_changeset_plan",
]);

// Wrap a successful create/amend result: auto-advance the changeset to
// in_progress and surface the transition IN the tool result so it shows in the
// agent's transcript (the agent must see it is cleared to build, headless). A
// failed transition becomes a clean isError, never a throw.
async function projectAutoAdvance(
  name: string,
  kernel: Kernel,
  result: ToolResult,
): Promise<McpToolResult> {
  const changeset = result._changeset as Changeset;
  const verb = name === "create_changeset" ? "created" : "amended";
  try {
    // An amendment of an in_progress changeset that did not go back to planning
    // needs no transition; only advance what is actually waiting.
    const started = changeset.status === "in_progress"
      ? changeset
      : await autoAdvanceChangeset(kernel, changeset);
    // Reuse the standard success projection for the changeset JSON block (same
    // serialization as every other tool), then prepend the transition note so
    // it is visible in the headless agent's transcript.
    const projected = toMcpResult(name, { ...result, data: started });
    const notes = [
      `Changeset "${started.id}" ${verb}, auto-approved and started ` +
      `(headless MCP mode): status is now "${started.status}". You can ` +
      `now make changes; the completion/readiness gate still applies at ` +
      `complete_changeset.`,
    ];
    // Only a criterion written as "must" lands here: a bare string or a missing
    // priority is stored as "should" (normalizeAcceptanceCriteria). Asking for
    // "must" is legitimate, but it is billed, so it is said out loud.
    const must = (started.plan.acceptanceCriteria ?? [])
      .filter((c) => c.priority === "must")
      .map((c) => c.id);
    if (must.length > 0) {
      notes.push(
        `Warning: ${must.join(", ")} ${must.length === 1 ? "is" : "are"} ` +
          `priority "must". complete_changeset runs a refutation agent on ` +
          `"must" criteria, billed to the user's model API key. A priority ` +
          `cannot be lowered once the changeset has started, so if the user ` +
          `did not ask for this, tell them before calling complete_changeset.`,
      );
    }
    return {
      content: [
        ...notes.map((text) => ({ type: "text" as const, text })),
        ...projected.content,
      ],
    };
  } catch (err) {
    return textError(
      `Changeset "${changeset.id}" was ${verb} but could not be auto-advanced ` +
        `to in_progress: ${errorMessage(err)}`,
    );
  }
}

const AGENT_TOOLS_BY_NAME: ReadonlyMap<string, CustomToolDef> = new Map(
  AGENT_TOOLS.map((t) => [t.name, t]),
);

// Dispatch an MCP `tools/call` through the existing core dispatch. The optional
// ChangeContext carries the MCP session id so the mutation gate (dispatch.ts)
// can resolve THIS agent's active changeset. Unknown tool names and any thrown
// error (including a NOT_REGISTERED capability throw from a verb whose handler
// is absent) become clean isError results — the transport must never see an
// exception.
export async function dispatchMcpTool(
  name: string,
  args: Record<string, unknown>,
  kernel: Kernel,
  rebuild: () => void,
  context?: ChangeContext,
): Promise<McpToolResult> {
  if (name === SHOW_APP) return showAppResult(kernel, args);
  const availability = toolAvailability(kernel.composition, name);
  if (availability === "excluded") {
    return textError(
      `Tool "${name}" is not exposed over MCP: it targets the Genie IDE session/launcher, which is not present for a headless external agent.`,
    );
  }
  if (availability === "no-capability") {
    return textError(
      `Tool "${name}" is not available in this MCP server assembly (its handler layer is not installed).`,
    );
  }
  // Refuse arguments the tool does not declare before dispatch ignores them.
  // An agent on this face has no IDE watching its calls, so a silently dropped
  // `query` (for `sql`) or `code` (for `source`) costs it a confused session.
  const def = AGENT_TOOLS_BY_NAME.get(name);
  if (def) {
    const checked = checkToolArgs(name, def.input_schema, args);
    if (checked.issues.length > 0) {
      return textError(
        `Error [INVALID_ARGUMENTS]: ${formatArgIssues(name, checked.issues)}`,
      );
    }
    args = checked.args;
  }
  try {
    const result = await dispatchTool(name, args, kernel, rebuild, context);
    if (AUTO_ADVANCE_TOOLS.has(name) && result.ok && result._changeset) {
      return await projectAutoAdvance(name, kernel, result);
    }
    if (name === "project_status" && result.ok) {
      // Core knows the contract version; only this face knows what it actually
      // advertises (exclusions, capability gating), so it fills in the rest.
      const data = result.data as Record<string, unknown>;
      return toMcpResult(name, {
        ...result,
        data: {
          ...data,
          surface: mcpSurfaceMeta(projectedMcpTools(kernel.composition)),
        },
      });
    }
    if (name === "start_task" && result.ok) {
      // Core can't build a client config; this face knows its own invocation.
      const data = result.data as CreatedTaskWithServe;
      return toMcpResult(name, {
        ...result,
        data: { ...data, connect: taskConnect(data.task.path) },
      });
    }
    return toMcpResult(name, result);
  } catch (err) {
    return textError(`Tool "${name}" failed: ${errorMessage(err)}`);
  }
}
