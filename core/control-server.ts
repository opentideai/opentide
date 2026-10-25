import { type Context, Hono, type MiddlewareHandler } from "hono";
import { upgradeWebSocket } from "hono/deno";
import type { ChatEventHandler, ChatRuntime } from "./chat-contract.ts";
import type { RecoveryChatRuntime } from "./recovery-chat.ts";
import {
  diagnoseRecoveryProject,
  recoveryInitialMessage,
} from "./recovery-diagnostics.ts";
// The chat contract lives in core (chat-contract.ts); the control server no
// longer imports the agent (chat.ts). Re-exported so existing importers/tests
// keep resolving these names from control-server.
export type {
  ChatEvent,
  ChatEventHandler,
  ChatRuntime,
} from "./chat-contract.ts";
import { MCPManager, type MCPServerConfig } from "./mcp.ts";
import {
  parseMcpServerConfigInput,
  resolveProjectFilePath,
} from "./control-helpers.ts";
import {
  auditSnapshot,
  dispatchTool,
  isMutationTool,
  reindexSourceBackedCodebase,
  runFormalSpecVerification,
  runKernelTests,
  type TestRunProgressEvent,
} from "./tools/dispatch.ts";
import {
  commitSourceEdit,
  selectRelatedTests,
  type SourceEditRequest,
  stageSourceEdit,
} from "./codebase/index.ts";
import {
  commitProjectTextFile,
  type ProjectTextFileRequest,
  stageProjectTextFile,
} from "./project-files.ts";
import type { CommandRunResult, CommandSelector } from "./command-runner.ts";
import type { ProjectCommand } from "./codebase/types.ts";
import type { VerificationEvidence } from "../shared/verification.ts";
import type { Kernel } from "./registries.ts";
import { CUSTOM_TOOLS } from "./tools/definitions.ts";
import { checkProjectAwareReadiness } from "./project-readiness.ts";
import {
  BINARY_COMPILE_TARGETS,
  type BinaryCompileTarget,
  buildDockerZip,
  buildDocsMarkdown,
  buildDocsSite,
  type BuildOptions,
  bumpVersion,
  checkExportTypes,
  defaultBinaryCompileTarget,
  getBuild,
  getVersion,
  isBinaryCompileTarget,
  setVersion,
} from "./build.ts";
import { errorMessage, stripModelContextContent } from "./util.ts";
import { contextOccupancyTokens, PRICING_VERIFIED_AS_OF } from "./usage.ts";
import { type RouteSchema, sortRoutes } from "./types.ts";
import { DOCUMENT_SCOPES, type DocumentScope } from "./documents.ts";
import { generateOpenAPISpec } from "./openapi.ts";
import { type DocsPackageRegistryInfo, generateAppDocs } from "./app-docs.ts";
import { isEditableTextAssetMime } from "./assets.ts";
import { getMergedDiagnostics } from "./diagnostics.ts";
import {
  deleteDataFixture,
  exportDataFixture,
  importDataFixture,
  resetDataTables,
} from "./data-fixtures.ts";
import { doctorProject } from "./project-doctor.ts";
import { extractCallGraph } from "./analysis.ts";
import { blastRadiusReport, buildKnowledgeGraph } from "./knowledge-graph.ts";
import { DebugManager } from "./debug-manager.ts";
import { LocalStateStore } from "./local-state.ts";
import { formatShellTranscript, runShellCommand } from "./shell.ts";
import {
  BUILTIN_AUDIT_CATEGORIES,
  type BuiltInAuditCategory,
  type Changeset,
  type ChangesetReadiness,
  type ChangesetStatus,
  type SessionWithLastMessage,
  type StoredMessage,
} from "./types.ts";
import type { SessionVerificationSummary } from "../shared/sessions.ts";
import {
  runtimeDependencies,
  runtimeDependencyNote,
} from "./runtime-dependencies.ts";
import {
  getPricingStatusReport,
  type PricingRefreshReport,
  refreshPricingReport,
} from "./pricing-workflow.ts";

// RouteSchema for GET /api/codebase. The control server is plain Hono and does
// not wire schemas into an OpenAPI surface (unlike user-app routes), so this
// documents the endpoint contract per the "every route has a RouteSchema" rule
// and is exported for docs/tests. Error bodies still follow the terser control
// API `{ error: string }` convention, not the user-app `{ error, code, message }`.
export const CODEBASE_ROUTE_SCHEMA: RouteSchema = {
  summary: "Get the cached source-backed codebase graph",
  tags: ["codebase"],
  responses: {
    "200": {
      description:
        "The latest indexed CodebaseGraph, or { graph: null } when the project has not been indexed yet.",
    },
    "400": { description: "No project is open." },
  },
};

// RouteSchemas for the source-backed dev-server control endpoints (project import,
// Slice 3). Same status as CODEBASE_ROUTE_SCHEMA: the control server is plain Hono
// (not OpenAPI-wired), so these document the contract per the "every route has a
// RouteSchema" rule and follow the terser `{ error: string }` control convention.
export const DEV_SERVER_START_ROUTE_SCHEMA: RouteSchema = {
  summary:
    "Start the source-backed project's dev server behind the app preview",
  tags: ["preview"],
  body: {
    type: "object",
    properties: {
      command: { type: "string" },
      cwd: { type: "string" },
      port: { type: "number" },
    },
  },
  responses: {
    "200": {
      description: "Dev server started; app preview now proxies to it.",
    },
    "400": {
      description: "No project open, not source-backed, or no dev command.",
    },
    "409": { description: "The dev server is already running." },
    "500": { description: "The dev server failed to start." },
  },
};

export const DEV_SERVER_STOP_ROUTE_SCHEMA: RouteSchema = {
  summary: "Stop the source-backed dev server and clear the preview proxy",
  tags: ["preview"],
  responses: {
    "200": { description: "Dev server stopped (idempotent)." },
    "400": { description: "No project is open." },
  },
};

export const DEV_SERVER_STATUS_ROUTE_SCHEMA: RouteSchema = {
  summary: "Get source-backed dev-server status (running, port, log tail)",
  tags: ["preview"],
  responses: {
    "200": { description: "The current DevServerStatus." },
    "400": { description: "No project is open." },
  },
};

// RouteSchemas for the source-backed file-edit endpoints (project-import Slice 5).
// Same status as the schemas above: documentation for plain-Hono control routes,
// terser `{ error }` convention. Both are mode-gated — a registry-native project is
// refused (400) and never written. The body accepts exactly one authoring mode
// (full `content`, an `anchor` region edit, or `delete`); the server materializes
// the full afterSnapshot before staging (see core/codebase/source-edit.ts).
const SOURCE_FILE_EDIT_BODY = {
  type: "object" as const,
  required: ["path"],
  properties: {
    path: { type: "string", description: "Project-root-relative POSIX path." },
    content: { type: "string", description: "Full replacement file content." },
    anchor: {
      type: "object",
      description:
        "Anchored region edit: replace the unique `find` with `replace`.",
      properties: { find: { type: "string" }, replace: { type: "string" } },
    },
    delete: { type: "boolean", description: "Delete the file." },
    baseFingerprint: {
      type: "string",
      description:
        "Fingerprint from a prior preview; enforced on apply (PATCH_CONFLICT if disk moved).",
    },
    userMessage: {
      type: "string",
      description: "Optional changelog rationale.",
    },
  },
};

export const SOURCE_FILE_PREVIEW_ROUTE_SCHEMA: RouteSchema = {
  summary: "Preview a source-backed file edit (before/after diff, no write)",
  tags: ["codebase"],
  body: SOURCE_FILE_EDIT_BODY,
  responses: {
    "200": {
      description:
        "StagedSourceEdit: { key, action, before, after, baseFingerprint }.",
    },
    "400": {
      description: "No project open, not source-backed, or an invalid edit.",
    },
  },
};

export const SOURCE_FILE_APPLY_ROUTE_SCHEMA: RouteSchema = {
  summary: "Apply a source-backed file edit (write to disk, record, re-index)",
  tags: ["codebase"],
  body: SOURCE_FILE_EDIT_BODY,
  responses: {
    "200": {
      description:
        "The recorded ChangeRecord plus the refreshed codebase graph summary.",
    },
    "400": {
      description: "No project open, not source-backed, or an invalid edit.",
    },
    "409": {
      description: "The file changed on disk since preview (PATCH_CONFLICT).",
    },
  },
};

// RouteSchemas for the source-backed command + related-test surface (project-import
// Slice 6). Same status as the schemas above: documentation for plain-Hono control
// routes, terser `{ error }` convention. All are mode-gated — a registry-native
// project is refused (400). Commands are run from the codebase graph's allow-list
// only (never a raw caller string), one at a time per project. Per the 128-tool
// budget these are control endpoints only — no new agent tool, so MCP_SURFACE_VERSION
// and the pinned surface fingerprint are untouched (as in Slices 3–5).
export const COMMANDS_LIST_ROUTE_SCHEMA: RouteSchema = {
  summary: "List the runnable project commands from the cached codebase graph",
  tags: ["codebase"],
  responses: {
    "200": { description: "{ commands: ProjectCommand[], running }." },
    "400": { description: "No project open or not source-backed." },
  },
};

export const COMMANDS_RUN_ROUTE_SCHEMA: RouteSchema = {
  summary: "Run one discovered project command (streamed to the kernel log)",
  tags: ["codebase"],
  body: {
    type: "object",
    properties: {
      kind: {
        type: "string",
        description:
          "Command kind to run (install|dev|test|typecheck|lint|build|format).",
      },
      id: {
        type: "string",
        description: "Exact ProjectCommand node id (alternative to kind).",
      },
      recordVerification: {
        type: "boolean",
        description:
          "For a test run, attach the result to the active changeset as self-reported evidence.",
      },
      changesetId: {
        type: "string",
        description:
          "Changeset to attach evidence to (defaults to the active one).",
      },
    },
  },
  responses: {
    "200": {
      description: "The CommandRunResult (exit code + captured transcript).",
    },
    "400": {
      description:
        "No project open, not source-backed, or command not in the graph.",
    },
    "409": { description: "Another command is already running." },
  },
};

export const COMMANDS_CANCEL_ROUTE_SCHEMA: RouteSchema = {
  summary: "Cancel the running project command and kill its process tree",
  tags: ["codebase"],
  responses: {
    "200": {
      description: "The CommandRunnerStatus after cancellation (idempotent).",
    },
    "400": { description: "No project open or not source-backed." },
  },
};

export const COMMANDS_STATUS_ROUTE_SCHEMA: RouteSchema = {
  summary: "Get the source-backed command runner status (running, log tail)",
  tags: ["codebase"],
  responses: {
    "200": { description: "The current CommandRunnerStatus." },
    "400": { description: "No project open or not source-backed." },
  },
};

export const TESTS_RELATED_ROUTE_SCHEMA: RouteSchema = {
  summary: "Select the tests related to a changed file/entity from the graph",
  tags: ["codebase"],
  params: {
    path: {
      type: "string",
      description:
        "Changed source file path or graph node id to find tests for.",
    },
  },
  responses: {
    "200": {
      description: "A RelatedTestsSelection (tests + the test command).",
    },
    "400": {
      description: "No project open, not source-backed, or missing `path`.",
    },
  },
};

// RouteSchemas for the read-only Documents surface (document store Phase 4 Slice 1,
// plan §7/§9). Same status as the schemas above: documentation for plain-Hono control
// routes, terser `{ error }` convention, requireKernel-guarded. These are control
// endpoints only (no agent tool verb), so MCP_SURFACE_VERSION and the pinned surface
// fingerprint are untouched. Slice 1 is READ-ONLY — no create/update/archive/scope/pin.
const TASK_CLAIMS_SCHEMA = {
  type: "array",
  items: { type: "string" },
  description:
    "category:key scopes the task expects to touch (e.g. handler:calcTotal). Advisory: overlaps are reported, never refused.",
};

export const TASKS_LIST_ROUTE_SCHEMA: RouteSchema = {
  summary: "List this project's task forks",
  tags: ["tasks"],
  responses: {
    "200": {
      description:
        "TaskRecord[] with `overlaps`: other open tasks claiming the same scopes.",
    },
    "400": { description: "No project is open." },
  },
};

export const TASKS_CREATE_ROUTE_SCHEMA: RouteSchema = {
  summary: "Fork the project into a new task",
  tags: ["tasks"],
  body: {
    type: "object",
    required: ["title"],
    properties: {
      title: { type: "string", description: "What the task is for." },
      claims: TASK_CLAIMS_SCHEMA,
      serve: {
        type: "boolean",
        description:
          "Start the fork's `opentide serve` (default true). false copies only; `opentide mcp --project <fork>` starts it later.",
      },
    },
  },
  responses: {
    "201": {
      description:
        "{ task, overlaps, serve: { pid, port, mcpUrl, logPath, started } }, or `serveError` in place of `serve` when the fork was created but its serve didn't start.",
    },
    "400": {
      description:
        "No project, bad title or claim, TASK_SOURCE_BACKED or TASK_EXTERNAL_DB.",
    },
    "409": { description: "TASK_LIMIT: too many open tasks." },
    "500": { description: "TASK_FORK_FAILED: the copy failed; nothing kept." },
  },
};

export const TASKS_PATCH_ROUTE_SCHEMA: RouteSchema = {
  summary: "Replace a task's claims",
  tags: ["tasks"],
  params: { id: { type: "string", description: "Task id" } },
  body: {
    type: "object",
    required: ["claims"],
    properties: { claims: TASK_CLAIMS_SCHEMA },
  },
  responses: {
    "200": { description: "{ task, overlaps }" },
    "400": { description: "Bad claim, or the task isn't open." },
    "404": { description: "No such task." },
  },
};

export const TASKS_DISCARD_ROUTE_SCHEMA: RouteSchema = {
  summary: "Discard a task: stop its serve, delete the fork",
  tags: ["tasks"],
  params: { id: { type: "string", description: "Task id" } },
  responses: {
    "200": { description: "The task record, now discarded. Idempotent." },
    "404": { description: "No such task." },
    "409": { description: "TASK_BUSY: the fork is still open elsewhere." },
  },
};

export const TASKS_DIFF_ROUTE_SCHEMA: RouteSchema = {
  summary: "Preview what merging a task would do",
  tags: ["tasks"],
  params: { id: { type: "string", description: "Task id" } },
  responses: {
    "200": {
      description:
        "{ task, apply, conflicts, notMerged, blocked }: changes only the fork made, in apply order; entities both sides changed differently; what a merge never carries. `blocked` is true when a conflict or a blocking note rules the merge out.",
    },
    "400": { description: "The task isn't open." },
    "404": { description: "No such task." },
    "409": {
      description:
        "TASK_FORK_UNREACHABLE: the fork's serve holds it but didn't flush.",
    },
    "500": { description: "TASK_STATE_UNREADABLE: a state file is corrupt." },
  },
};

export const TASKS_MERGE_ROUTE_SCHEMA: RouteSchema = {
  summary:
    "Merge a task into main: stop its serve, replay its changes, run main's tests",
  tags: ["tasks"],
  params: { id: { type: "string", description: "Task id" } },
  responses: {
    "200": {
      description:
        "{ task, outcome, changesetId, applied, failure?, tests?, readiness?, notMerged }. `outcome` is `merged` (main's changeset completed), `unverified` (applied; the changeset stays in_progress and `readiness` says why) or `apply-failed` (stopped at `failure`; what's in `applied` landed, the changeset stays in_progress and the task stays open).",
    },
    "400": { description: "The task isn't open." },
    "404": { description: "No such task." },
    "409": {
      description:
        "TASK_BUSY: the fork has a changeset open or is held by another process. CHANGESET_ACTIVE: main has a changeset open. TASK_MERGE_BLOCKED: conflicts or blocking notes, listed in the message; the fork is untouched.",
    },
    "500": { description: "TASK_STATE_UNREADABLE: a state file is corrupt." },
  },
};

export const STATE_FLUSH_ROUTE_SCHEMA: RouteSchema = {
  summary: "Write the in-memory registries to the project's state files",
  tags: ["project"],
  responses: {
    "200": { description: "{ ok: true }" },
    "400": { description: "No project is open." },
  },
};

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

// Status for a task refusal. Everything not listed is a caller error.
const TASK_ERROR_STATUS: Record<string, 404 | 409 | 500> = {
  TASK_NOT_FOUND: 404,
  TASK_LIMIT: 409,
  TASK_IN_FORK: 409,
  TASK_BUSY: 409,
  TASK_MERGE_BLOCKED: 409,
  CHANGESET_ACTIVE: 409,
  TASK_FORK_UNREACHABLE: 409,
  TASK_FORK_FAILED: 500,
  TASK_STATE_UNREADABLE: 500,
};

export const DOCUMENTS_LIST_ROUTE_SCHEMA: RouteSchema = {
  summary: "List documents in the store (filterable by scope/session)",
  tags: ["documents"],
  responses: {
    "200": {
      description:
        "DocumentRecord[] (newest-first), excluding internal provenance docs by " +
        "default; pass `include_internal=1` to include them. `session_id` scopes " +
        "to docs visible from that session (project + global + that session's " +
        "session-docs) and adds `resident: boolean` per row.",
    },
    "400": { description: "No project is open." },
  },
};

export const DOCUMENTS_GET_ROUTE_SCHEMA: RouteSchema = {
  summary: "Get a document's metadata and version history",
  tags: ["documents"],
  params: { id: { type: "string", description: "Document id." } },
  responses: {
    "200": { description: "{ document, versions } (versions newest-first)." },
    "400": { description: "No project is open." },
    "404": { description: "No such document." },
  },
};

export const DOCUMENTS_REFS_ROUTE_SCHEMA: RouteSchema = {
  summary: 'List a document\'s backlinks ("used in")',
  tags: ["documents"],
  params: { id: { type: "string", description: "Document id." } },
  responses: {
    "200": {
      description:
        "DocumentRef[] (newest-first); the panel groups these by ref_type.",
    },
    "400": { description: "No project is open." },
  },
};

export const DOCUMENTS_PIN_ROUTE_SCHEMA: RouteSchema = {
  summary: "Pin/unpin a document into a session's working set",
  tags: ["documents"],
  params: { id: { type: "string", description: "Document id." } },
  responses: {
    "200": {
      description:
        "{ id, pinned } — the resident state after the toggle. Body: { pinned: boolean, session_id: string }.",
    },
    "400": {
      description:
        "No project is open, or `pinned`/`session_id` is missing or invalid.",
    },
    "404": { description: "No such document." },
    "409": {
      description:
        "Pinning would push the session working set past its token cap (WORKING_SET_BUDGET_EXCEEDED); the error message carries the release-first suggestion.",
    },
  },
};

// The text kinds a user may create through the panel form (document store Phase 4
// Slice 4). This slice writes TEXT only — binary/file upload (drag/paste, multipart,
// base64) is a deferred follow-up, so the create route rejects any other kind. Labels
// live beside the values so the panel's kind <select> stays free of magic strings.
export const DOCUMENT_CREATE_KINDS = [
  { value: "text/markdown", label: "Markdown" },
  { value: "text/plain", label: "Plain text" },
] as const;
const DOCUMENT_CREATE_KIND_VALUES: readonly string[] = DOCUMENT_CREATE_KINDS
  .map(
    (k) => k.value,
  );

export const DOCUMENTS_CREATE_ROUTE_SCHEMA: RouteSchema = {
  summary: "Create a document in the store (text body, or upload file bytes)",
  tags: ["documents"],
  responses: {
    "201": {
      description:
        "The created DocumentRecord. Two request shapes, selected by Content-Type: " +
        "(1) application/json (the default text path) — Body: { name, kind, scope, " +
        "content, session_id? } where kind is a text/* create kind and content is a " +
        "string. (2) multipart/form-data (Slice 9 file upload) — fields: file (the " +
        "uploaded File/Blob; text/* files are stored as editable text documents, while " +
        "binary files must be in the previewable-binary allowlist — image/png, " +
        "image/jpeg, image/gif, image/webp, application/pdf), plus optional name " +
        "(defaults to the file's filename), scope, and session_id. Previewable binary " +
        "uploads are magic-byte sniffed against the declared kind (a mismatch is " +
        `rejected), and capped at ${DOCUMENT_UPLOAD_MAX_BYTES} bytes (the larger ` +
        'binary cap). Text uploads use the text cap. In both shapes `createdBy` is forced to "user".',
    },
    "400": {
      description:
        "Text path: missing/blank name, missing/non-string content, unsupported kind, " +
        "invalid scope, a session scope without `session_id`, content past the cap, or " +
        "(session/project scope) no project loaded. Upload path: missing file, a kind " +
        "that is neither text/* nor previewable binary, a magic-byte/declared-kind " +
        "mismatch for previewable binary, bytes past the relevant cap, invalid scope, " +
        "or a session scope without `session_id`.",
    },
  },
};

export const DOCUMENTS_UPDATE_ROUTE_SCHEMA: RouteSchema = {
  summary: "Update a text document's content (new immutable version)",
  tags: ["documents"],
  params: { id: { type: "string", description: "Document id." } },
  responses: {
    "200": {
      description:
        "The updated DocumentRecord (head moved to the new version; prior versions " +
        'stay). Body: { content: string }; `createdBy` is forced to "user" (the panel ' +
        "is the human path). Idempotent: re-issuing unchanged content is a byte-dedupe " +
        "no-op that adds no version.",
    },
    "400": {
      description:
        "Missing/non-string content, a non-text document (binary editing is a later " +
        "slice), content past the cap, or no project open.",
    },
    "404": { description: "No such document." },
    "409": { description: "The document is archived and cannot be updated." },
  },
};

export const DOCUMENTS_ARCHIVE_ROUTE_SCHEMA: RouteSchema = {
  summary: "Archive (soft-delete) a document — tombstone, versions preserved",
  tags: ["documents"],
  params: { id: { type: "string", description: "Document id." } },
  responses: {
    "200": {
      description:
        "The tombstoned DocumentRecord (`archived: true`). One-way: there is no " +
        "unarchive this slice. Idempotent: re-archiving an already-archived doc is a " +
        "no-op success (re-sets `archived: true`, bumps `updatedAt`). Archived docs are " +
        "hidden from GET /api/documents unless `include_archived` is set; the detail GET " +
        "still returns them and all immutable versions/provenance are preserved.",
    },
    "400": { description: "No project is open, or another engine error." },
    "404": { description: "No such document." },
  },
};

export const DOCUMENTS_PROMOTE_ROUTE_SCHEMA: RouteSchema = {
  summary: "Promote a document's scope (session → project → global)",
  tags: ["documents"],
  params: { id: { type: "string", description: "Document id." } },
  responses: {
    "200": {
      description:
        'The updated DocumentRecord at the wider scope. Body: { scope: "project" | ' +
        '"global" }. One-way UP only (you cannot promote to session or demote). ' +
        "Idempotent: re-promoting to the current scope is a 200 no-op. Promoting →global " +
        "copies each version's blob into the global store; session→project is " +
        "metadata-only (same on-disk root). Promoting away from session clears " +
        "sessionId; →global also clears projectId.",
    },
    "400": {
      description:
        "Missing/invalid target scope, `session` as a target (not a promotion), a " +
        "demotion (INVALID_SCOPE_PROMOTION), no project open (PROJECT_REQUIRED), or a " +
        "missing blob.",
    },
    "404": { description: "No such document." },
    "409": { description: "The document is archived and cannot be promoted." },
  },
};

// Text-like extensions whose browser File.type may be empty or application/* even
// though the content is meant to be stored/editable as utf-8 text. Multipart uploads
// normalize these to a text/* document kind so the existing content/edit routes work.
const TEXT_UPLOAD_KIND_BY_EXTENSION: Record<string, string> = {
  ".txt": "text/plain",
  ".text": "text/plain",
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".html": "text/html",
  ".htm": "text/html",
  ".css": "text/css",
  ".csv": "text/csv",
  ".xml": "text/xml",
  ".json": "text/plain",
  ".jsonl": "text/plain",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".cjs": "text/javascript",
  ".ts": "text/plain",
  ".tsx": "text/plain",
  ".jsx": "text/plain",
  ".yaml": "text/plain",
  ".yml": "text/plain",
  ".toml": "text/plain",
  ".ini": "text/plain",
  ".log": "text/plain",
};

function normalizeTextUploadKind(type: string, name: string): string | null {
  if (type.startsWith("text/")) return type;
  const dot = name.lastIndexOf(".");
  if (dot < 0) return null;
  return TEXT_UPLOAD_KIND_BY_EXTENSION[name.slice(dot).toLowerCase()] ?? null;
}

// The one allowlist that governs the store's binary handling end-to-end (document
// store Phase 4 Slices 8 + 9): the ONLY binary kinds the /raw route serves INLINE as
// active-safe content in the first-party IDE's origin (Slice 8), AND the only kinds
// the multipart upload branch of POST /api/documents accepts (Slice 9) — upload and
// inline-serve must agree exactly, so we only ever store a binary we can also preview.
// Deliberately excludes text/html and image/svg+xml — both can carry script, so they
// are never uploadable here and, if seeded another way, fall through to the /raw
// attachment path and can never execute in the IDE's origin. No magic strings: this is
// the single allowlist both call sites consult.
export const PREVIEWABLE_BINARY_KINDS = new Set<string>([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "application/pdf",
]);

// Magic-byte signatures for the previewable kinds — defense-in-depth beside the /raw
// route's nosniff header (Slice 9). A multipart upload declares its kind via the file's
// MIME type; we additionally verify the leading bytes match that declaration so a
// mislabeled or crafted blob (e.g. HTML wearing an image/png Content-Type) is rejected
// at the boundary rather than trusted. Each entry is the fixed prefix; WEBP also needs a
// discontiguous "WEBP" tag at offset 8, checked separately.
const BINARY_MAGIC_PREFIXES: Record<string, readonly number[]> = {
  "image/png": [0x89, 0x50, 0x4e, 0x47],
  "image/jpeg": [0xff, 0xd8, 0xff],
  "image/gif": [0x47, 0x49, 0x46, 0x38],
  "image/webp": [0x52, 0x49, 0x46, 0x46], // "RIFF"; "WEBP" at offset 8 checked below
  "application/pdf": [0x25, 0x50, 0x44, 0x46], // "%PDF"
};
const WEBP_TAG = [0x57, 0x45, 0x42, 0x50]; // "WEBP" at byte offset 8 within the RIFF header

// Confirm `bytes` actually begins with the signature of its DECLARED `kind` (which the
// caller has already checked is in PREVIEWABLE_BINARY_KINDS). Rejects a MIME/content
// mismatch. Not a full format validation — a cheap, high-signal leading-bytes gate.
function matchesDeclaredKind(bytes: Uint8Array, kind: string): boolean {
  const prefix = BINARY_MAGIC_PREFIXES[kind];
  if (!prefix) return false;
  if (bytes.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (bytes[i] !== prefix[i]) return false;
  }
  if (kind === "image/webp") {
    if (bytes.length < 8 + WEBP_TAG.length) return false;
    for (let i = 0; i < WEBP_TAG.length; i++) {
      if (bytes[8 + i] !== WEBP_TAG[i]) return false;
    }
  }
  return true;
}

export const DOCUMENTS_RAW_ROUTE_SCHEMA: RouteSchema = {
  summary:
    "Get a document version's raw bytes (inline image/pdf; other kinds download)",
  tags: ["documents"],
  params: { id: { type: "string", description: "Document id." } },
  responses: {
    "200": {
      description:
        "The raw blob bytes for the head version, or the exact `?version=<hash>` " +
        "when pinned. Kinds in the inline allowlist (image/png|jpeg|gif|webp, " +
        "application/pdf) are served with their real Content-Type and " +
        "`Content-Disposition: inline` for a <img>/<iframe> preview; every other " +
        "kind — notably text/html and image/svg+xml (active content) and all text " +
        "kinds — is served as `application/octet-stream` with " +
        "`Content-Disposition: attachment` so a stored document can never execute " +
        "in the IDE's origin. `X-Content-Type-Options: nosniff` is always set. " +
        "Blobs are content-addressed (immutable per version), so a pinned " +
        "`?version` is safely long-cacheable.",
    },
    "400": {
      description:
        "No project is open (PROJECT_REQUIRED), the blob is missing on disk " +
        "(BLOB_MISSING), or another engine error.",
    },
    "404": { description: "No such document or version." },
  },
};

export const DOCUMENTS_CONTENT_ROUTE_SCHEMA: RouteSchema = {
  summary:
    "Get a document version's text content (binary kinds return a placeholder)",
  tags: ["documents"],
  params: { id: { type: "string", description: "Document id." } },
  responses: {
    "200": {
      description:
        "For text/* kinds: { kind, versionHash, content }. For binary kinds: { kind, versionHash, size, binary: true } — no bytes this slice.",
    },
    "400": { description: "No project is open." },
    "404": { description: "No such document or version." },
  },
};

function isIgnorableEmptySessionMessage(message: StoredMessage): boolean {
  if (message.role !== "system") return false;
  if (message.pinned || message.projectPinned) return false;
  if (message.toolCalls) return false;
  const content = stripModelContextContent(message.content).trim();
  return content.startsWith("Agent context was ") &&
    content.endsWith("Recent conversation was reloaded from local history.");
}

const runtimeDependencyManifest = runtimeDependencies();
// Wire compatibility for older IDE builds; the product/UI name is now Runtime.
const platformPackages = runtimeDependencyManifest.map((dependency) => ({
  ...dependency,
  platform: true as const,
}));
const BUILTIN_AUDIT_DESCRIPTIONS: Record<BuiltInAuditCategory, string> = {
  security:
    "Finds unsafe input handling, auth gaps, secret exposure, and other security risks.",
  performance:
    "Finds inefficient queries, avoidable recomputation, and runtime bottlenecks.",
  seo:
    "Finds metadata, routing, and content issues that hurt search visibility.",
  accessibility:
    "Finds keyboard, semantic, contrast, and screen reader issues.",
  "code-quality":
    "Finds maintainability issues, brittle patterns, duplication, and missing tests.",
};
import {
  loadProject,
  type ProjectContext,
  ProjectLockedError,
  unloadProject,
} from "./project-loader.ts";
import { acquireProjectLock } from "./project-lock.ts";
import { isAllowedWebSocketRequest } from "./loopback-guard.ts";
import { resolveServerToken, writeServerToken } from "./server-token.ts";
import type { CompositionContext } from "./composition.ts";
import { DynamicSchemaRestoreError } from "./db.ts";
import {
  attemptRepairDatabase,
  PgliteCorruptError,
  resetAndCreateDatabase,
} from "./db/factory.ts";
import {
  formatPinnedMessagesContext,
  formatProjectContext,
  formatSessionContext,
  getPinnedMessageInfos,
  getProjectSummary,
  getSessionContext,
  listProjectMentionTargets,
  type ProjectSummary,
  resolveProject,
} from "./project-context.ts";
import type { CoreRouteContext, RouteMounter } from "./route-mount.ts";
import {
  getSessionSummaryStatus,
  normalizeSummaryKind,
  summarizeSession,
} from "./session-summary.ts";
import { ReplSession } from "./terminal.ts";
import { runtimeMetadata } from "./runtime.ts";
import {
  saveBranchSnapshots,
  saveKernelState,
  saveProjectStateData,
} from "./persistence.ts";
import {
  gitAddTideGitignore,
  gitCommit,
  gitInit,
  GitProjectError,
  gitPush,
  gitSetRemote,
  gitStatus,
} from "./git.ts";
import { resolveGitCommitMessage } from "./git-message.ts";
import {
  createBackup,
  deleteBackup,
  listBackups,
  loadBackup,
  restoreBranchSnapshots,
  restoreDbTables,
  saveBackup,
} from "./backup.ts";
import { maybePeriodicBackup, noteBackupTaken } from "./backup-cadence.ts";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  normalize,
  relative,
  resolve,
} from "node:path";
import {
  createProject,
  duplicateProject,
  getProjectPaths,
  importProject,
  listProjects,
  PREVIEW_PORT_AUTO,
  type PreviewPort,
  PROJECT_MODE_SOURCE_BACKED,
  type ProjectEntry,
  readProjectMode,
  readProjectPreviewPort,
  removeProject,
  renameProject,
  type SourceBackedRunConfig,
  writeProjectPreviewPort,
  writeProjectRunConfig,
} from "./project-manager.ts";
import { resolveDevRunConfig } from "./dev-server.ts";
import { SecretsStore } from "./secrets.ts";
import {
  APP_PORT_AUTO,
  appPreviewUrl,
  clearOpenaiBaseUrl,
  clearProviderKey,
  CONSENT_VERSION,
  DEFAULT_AGENT_MODEL,
  DEFAULT_CODE_MODEL,
  DEV_SERVER_HOST,
  DOCUMENT_UPLOAD_MAX_BYTES,
  getAgentModel,
  getAgentModelForRequest,
  getAvailableModels,
  getImportModel,
  getImportModelForRequest,
  getKernelSettings,
  getOpenaiBaseUrl,
  getPlanningModel,
  getPlanningModelForRequest,
  getPricingProvenance,
  getProviderKey,
  getProviderKeyStatuses,
  getRecommendedModels,
  getTelemetrySettings,
  getUtilityModel,
  getUtilityModelForRequest,
  getVerificationModel,
  getVerificationModelForRequest,
  hasAnyProviderKey,
  isKnownProviderId,
  type KernelSettings,
  MAX_FILE_CONTENT_BYTES,
  MODEL_UNCONFIGURED_LABEL,
  type ModelProviderId,
  obfuscateKey,
  ORCHESTRATOR_DASHBOARD_PORT,
  PROJECT_FILE_IGNORED_DIRS,
  PROJECT_FILE_IGNORED_FILES,
  providerFor,
  refreshAvailableModels,
  REGISTRY_CACHE_MAX_AGE_MS,
  SERVER_SHUTDOWN_GRACE_MS,
  setAgentModel,
  setImportModel,
  setKernelSettings,
  setOpenaiBaseUrl,
  setPlanningModel,
  setProviderKey,
  setRecommendedModels,
  setTelemetrySettings,
  setUtilityModel,
  setVerificationModel,
  SOURCE_EDIT_CHANGE_CATEGORY,
  type TelemetrySettings,
} from "./config.ts";
import { isOrchestratedChild } from "./orchestrator/handshake.ts";
import { callUtilityModel } from "./utility-model.ts";
import { recommendModelsFromCatalog } from "./model-recommend.ts";
import { egressAllowed, TelemetryManager } from "./telemetry.ts";
import { entitySurvivalRate } from "./episodes.ts";
import { canReadUserSession, type CurrentUser } from "./auth.ts";
import { type AuthProvider, LocalAuthProvider } from "./auth-provider.ts";
import type { ChangeContext, ChangeRecord, TurnGroup } from "./changelog.ts";
import {
  discardTaskFork,
  listTasks,
  startTask,
  updateTaskClaims,
} from "./tasks/fork.ts";
import { diffTask, STATE_FLUSH_PATH } from "./tasks/task-diff.ts";
import { mergeTask } from "./tasks/task-merge.ts";
import { rewindForAbandon } from "./changeset-snapshots.ts";

export interface ControlServer {
  server: Deno.HttpServer<Deno.NetAddr>;
  chat: ChatRuntime | null;
  setProject: {
    open: (path: string) => Promise<ProjectEntry>;
    current: () => ProjectContext | null;
    // Closes the open project with its project-close listeners, as a switch does.
    close: () => Promise<void>;
  };
}

// Stop the HTTP server, waiting at most `graceMs` for in-flight responses (a
// client's SSE stream, an IDE log stream). Callers close the project first, so
// what's cut off past that is a connection, not state. Resolves false when the
// grace ran out.
export function shutdownHttpServer(
  server: Deno.HttpServer<Deno.NetAddr>,
  graceMs: number = SERVER_SHUTDOWN_GRACE_MS,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    server.shutdown().then(() => true),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), graceMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

export type BuildTargetExtraTarget = "deno" | "node" | "binary";
export type BuildLockTarget = "deno-source" | "node";

export interface BuildTargetExtraResult {
  ok: boolean;
  detail: string;
}

export interface BuildTargetExtraOptions {
  buildOptions: BuildOptions;
  projectName: string;
  projectVersion: string;
}

export interface BuildTargetExtras {
  refreshLocksBeforeBuild?: (
    ctx: ProjectContext,
    targets: readonly BuildLockTarget[],
    options: BuildTargetExtraOptions,
  ) => Promise<BuildTargetExtraResult>;
  runSmokeTest?: (
    ctx: ProjectContext,
    target: BuildTargetExtraTarget,
    options: BuildTargetExtraOptions,
  ) => Promise<BuildTargetExtraResult>;
}

export interface ControlServerOptions {
  chatFactory?: (
    ctx: ProjectContext,
    mcpManager: MCPManager,
  ) => ChatRuntime;
  recoveryChatFactory?: () => RecoveryChatRuntime;
  staticUiDir?: string;
  projectAppPort?: number;
  // The identity seam (OpenTide §3.3). Defaults to the open LocalAuthProvider —
  // no auth — so a bare core / `opentide serve` runs like a dev server. The Tide
  // product injects a CloudAuthProvider to enforce sign-in.
  authProvider?: AuthProvider;
  // Upper-layer route contributors (OpenTide §3.3). Each is invoked with the
  // Hono app + a CoreRouteContext after the core routes are registered.
  mountRoutes?: RouteMounter[];
  // Optional upper-layer build extras. Core owns the build endpoints; verification
  // layers can inject lock refresh and smoke gates without core importing upward.
  buildTargetExtras?: BuildTargetExtras;
  // The assembled upper-layer seams, threaded into every project this server
  // loads (initial load happens in the root; project switches happen here).
  composition?: CompositionContext;
}

const STATIC_UI_RESERVED_PREFIXES = [
  "/api",
  "/chat",
  "/debug",
  "/mcp",
  "/terminal",
];
const MAX_SESSION_LIST_LIMIT = 100;
const SESSION_LIST_VERIFICATION_CHANGESET_LIMIT = 500;
const CLOSE_ACTIVE_TURN_TIMEOUT_MS = 5_000;

// A1 (Stream A): the control-panel mutation endpoints below (env vars, secrets,
// app configs, package add/remove) are operator-initiated — a human acting
// directly through the IDE, outside any agent turn. They do NOT flow through
// dispatchTool's authorOrigin choke point, so each stamps its origin here as
// "human". Shared, never mutated. See docs/stream-a-data-foundation-plan.md.
// A human write from the IDE. A project has one writer at a time, so when a
// changeset is open the write belongs to it.
async function operatorChangeContext(kernel: Kernel): Promise<ChangeContext> {
  const active = await kernel.activeChangesetId();
  return {
    authorOrigin: "human",
    ...(active ? { changesetId: active } : {}),
  };
}

// The project's .env file holds local values, often credentials, so its records
// name the variable and never carry the value. Not undoable for the same reason.
async function recordDotEnvChange(
  kernel: Kernel,
  name: string,
  action: "create" | "update" | "delete",
): Promise<void> {
  await kernel.changelog.record({
    category: "env_var",
    key: name,
    action,
    beforeSnapshot: action === "create" ? null : { key: name, source: ".env" },
    afterSnapshot: action === "delete" ? null : { key: name, source: ".env" },
    context: await operatorChangeContext(kernel),
    undoable: false,
  });
}

type ChangesetWithReadiness = Changeset & {
  readiness?: ChangesetReadiness;
};

async function enrichChangesetTokenUsageOnRead(
  tokenUsage: Changeset["tokenUsage"],
  changesetId: string,
  kernel: Kernel,
): Promise<Changeset["tokenUsage"]> {
  if (
    !tokenUsage ||
    tokenUsage.cacheCreationInputTokens !== undefined ||
    tokenUsage.cacheReadInputTokens !== undefined
  ) {
    return tokenUsage;
  }
  const rows = await kernel.sessions.getModelUsagesForChangeset(changesetId);
  if (rows.length === 0) return tokenUsage;
  return {
    ...tokenUsage,
    cacheCreationInputTokens: rows.reduce(
      (sum, row) => sum + row.cacheCreationInputTokens,
      0,
    ),
    cacheReadInputTokens: rows.reduce(
      (sum, row) => sum + row.cacheReadInputTokens,
      0,
    ),
  };
}

type SessionVerificationStatus = NonNullable<
  SessionVerificationSummary["status"]
>;

const SESSION_ATTENTION_CODES = new Set([
  "CLAIM_REFUTED",
  "UNVERIFIED_FORMAL_SPEC",
  "VERIFICATION_NOT_PASSING",
  "VERIFICATION_EVIDENCE_NOT_PASSING",
  "CLAIM_RESULTS_NOT_PASSING",
  "UNPLANNED_MANUAL_VERIFICATION",
  "INCOMPLETE_STEPS",
  "MISSING_ACCEPTANCE_CRITERIA",
  "MISSING_VERIFICATION_PLAN",
  "UNCOVERED_ACCEPTANCE_CRITERIA",
  "MISSING_REFERENCED_EVIDENCE",
  "CHANGESET_NOT_IN_PROGRESS",
  "PROJECT_CONSISTENCY_ERRORS",
]);

const OPEN_CHANGESET_STATUSES = new Set<ChangesetStatus>([
  "planning",
  "approved",
  "in_progress",
]);

function isOpenVerificationChangeset(changeset: Changeset): boolean {
  return OPEN_CHANGESET_STATUSES.has(changeset.status);
}

function deriveChangesetVerificationStatus(
  changeset: ChangesetWithReadiness,
): SessionVerificationStatus {
  const readiness = changeset.readiness ?? null;
  const issues = readiness ? [...readiness.errors, ...readiness.warnings] : [];
  if (issues.some((issue) => SESSION_ATTENTION_CODES.has(issue.code))) {
    return "needs_attention";
  }
  if (readiness?.passed === true) return "verified";
  return "needs_verification";
}

function deriveSessionVerificationSummary(
  changesets: ChangesetWithReadiness[],
): SessionVerificationSummary {
  let worst: {
    status: SessionVerificationStatus;
    rank: number;
    changesetId: string;
  } | null = null;

  for (const changeset of changesets) {
    if (!isOpenVerificationChangeset(changeset)) continue;
    const status = deriveChangesetVerificationStatus(changeset);
    const rank = sessionStatusRank(status);
    if (!worst || rank > worst.rank) {
      worst = { status, rank, changesetId: changeset.id };
    }
  }

  if (!worst) {
    return { status: null, label: "No open verification work" };
  }
  return {
    status: worst.status,
    label: sessionStatusLabel(worst.status),
    changesetId: worst.changesetId,
  };
}

function sessionStatusRank(status: SessionVerificationStatus): number {
  switch (status) {
    case "needs_attention":
      return 3;
    case "needs_verification":
      return 2;
    case "verified":
      return 1;
  }
}

function sessionStatusLabel(status: SessionVerificationStatus): string {
  switch (status) {
    case "needs_attention":
      return "Open changeset needs attention";
    case "needs_verification":
      return "Open changeset needs verification";
    case "verified":
      return "Open changeset is verified and ready";
  }
}

async function enrichSessionsWithVerification(
  ctx: ProjectContext,
  sessions: SessionWithLastMessage[],
): Promise<SessionWithLastMessage[]> {
  if (sessions.length === 0) return sessions;
  try {
    const sessionIds = new Set(sessions.map((session) => session.id));
    const grouped = new Map<string, ChangesetWithReadiness[]>();
    const consistencyReport = ctx.kernel.projectDir
      ? await doctorProject(ctx.kernel.projectDir, ctx.kernel.db)
      : undefined;
    const changesets = await ctx.kernel.changesets.list({
      limit: SESSION_LIST_VERIFICATION_CHANGESET_LIMIT,
    });

    for (const changeset of changesets) {
      if (!changeset.sessionId || !sessionIds.has(changeset.sessionId)) {
        continue;
      }
      if (!isOpenVerificationChangeset(changeset)) continue;
      const enriched: ChangesetWithReadiness = {
        ...changeset,
        readiness: await checkProjectAwareReadiness(
          ctx.kernel,
          changeset,
          undefined,
          consistencyReport,
        ),
      };
      const list = grouped.get(changeset.sessionId) ?? [];
      list.push(enriched);
      grouped.set(changeset.sessionId, list);
    }

    return sessions.map((session) => ({
      ...session,
      verification: deriveSessionVerificationSummary(
        grouped.get(session.id) ?? [],
      ),
    }));
  } catch {
    return sessions;
  }
}

// Moved to loopback-guard.ts so the MCP endpoint shares it; re-exported for the
// existing callers.
export { isAllowedWebSocketRequest };

const STATIC_UI_MIME_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function shouldServeStaticUi(pathname: string): boolean {
  return !STATIC_UI_RESERVED_PREFIXES.some((prefix) =>
    pathname === prefix || pathname.startsWith(`${prefix}/`)
  );
}

function resolveStaticUiPath(root: string, pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes("\0")) return null;
  const candidate = resolve(root, `.${normalize(decoded)}`);
  const rel = relative(root, candidate);
  if (rel.startsWith("..") || isAbsolute(rel)) return null;
  return candidate;
}

async function staticFileExists(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isFile;
  } catch {
    return false;
  }
}

async function serveStaticFile(
  c: Context,
  path: string,
): Promise<Response> {
  const body = c.req.method === "HEAD" ? null : await Deno.readFile(path);
  const headers = new Headers();
  const contentType = STATIC_UI_MIME_TYPES[extname(path).toLowerCase()];
  if (contentType) headers.set("content-type", contentType);
  if (path.split(/[\\/]/).includes("immutable")) {
    headers.set("cache-control", "public, max-age=31536000, immutable");
  }
  return new Response(body, { headers });
}

async function serveStaticUi(
  c: Context,
  root: string,
): Promise<Response> {
  const pathname = new URL(c.req.url).pathname;
  if (!shouldServeStaticUi(pathname)) return c.notFound();

  const filePath = resolveStaticUiPath(root, pathname);
  if (!filePath) return c.text("Not found", 404);

  if (await staticFileExists(filePath)) {
    return serveStaticFile(c, filePath);
  }

  const dirIndexPath = join(filePath, "index.html");
  if (await staticFileExists(dirIndexPath)) {
    return serveStaticFile(c, dirIndexPath);
  }

  if (!extname(pathname)) {
    const fallbackPath = join(root, "index.html");
    if (await staticFileExists(fallbackPath)) {
      return serveStaticFile(c, fallbackPath);
    }
  }

  return c.text("Not found", 404);
}

export function resolveScreenshotArtifactPath(
  projectDir: string,
  name: string,
): string | null {
  if (
    !name || basename(name) !== name ||
    extname(name).toLowerCase() !== ".png"
  ) {
    return null;
  }
  return join(getProjectPaths(projectDir).screenshotArtifactsDir, name);
}

function addAttachmentSourcesToContent(
  content: string,
  attachments?: Array<{ name: string; type: string; data: string }>,
): string {
  if (!attachments?.length) return content;
  const match = content.match(/<attachments>([\s\S]*?)<\/attachments>/);
  if (!match) return content;

  try {
    const parsed = JSON.parse(match[1]!) as Array<
      { name: string; type: string; thumb?: string; src?: string }
    >;
    const withSources = parsed.map((meta, index) => {
      const attachment = attachments[index];
      if (!attachment || !attachment.type.startsWith("image/")) return meta;
      return {
        ...meta,
        src: `data:${attachment.type};base64,${attachment.data}`,
      };
    });
    return content.replace(
      match[0],
      `<attachments>${JSON.stringify(withSources)}</attachments>`,
    );
  } catch {
    return content;
  }
}

export async function startControlServer(
  initialProject: ProjectContext | null,
  port = 3003,
  opts: ControlServerOptions = {},
): Promise<ControlServer> {
  let ctx = initialProject;
  let chat: ChatRuntime | null = null;
  let busy = false;
  let activeTurnPromise: Promise<void> | null = null;
  let resolveActiveTurn: (() => void) | null = null;
  let pendingCompaction: { sessionId: string; user: CurrentUser } | null = null;
  let compactionFlushInFlight = false;
  // deno-lint-ignore no-explicit-any
  let currentChatWs: any = null;
  let debugManager: DebugManager | null = null;
  const mcpManager = new MCPManager();
  // The current project's MCP bearer token (core/server-token.ts). Set by
  // advertiseProject once the listener is bound, cleared on close.
  let serverToken: string | null = null;
  const projectCloseListeners: (() => Promise<void>)[] = [];
  const telemetry = new TelemetryManager({
    getContext: () => ctx,
    getCurrentSessionId: () => chat?.getCurrentSessionId() ?? null,
  });
  const auth: AuthProvider = opts.authProvider ?? new LocalAuthProvider();
  const requestUsers = new WeakMap<Request, CurrentUser>();

  class CloseActiveTurnTimeoutError extends Error {
    constructor() {
      super(
        "Timed out waiting for active chat turn to settle after cancellation",
      );
      this.name = "CloseActiveTurnTimeoutError";
    }
  }

  function beginActiveTurn(): void {
    activeTurnPromise = new Promise<void>((resolve) => {
      resolveActiveTurn = resolve;
    });
  }

  function finishActiveTurn(): void {
    const resolve = resolveActiveTurn;
    resolveActiveTurn = null;
    activeTurnPromise = null;
    resolve?.();
  }

  function isRecoverableDatabaseOpenError(err: unknown): boolean {
    return err instanceof PgliteCorruptError ||
      err instanceof DynamicSchemaRestoreError;
  }

  function recoverableDatabaseError(c: Context, err: unknown): Response {
    return c.json({ error: errorMessage(err), code: "DB_CORRUPT" }, 500);
  }

  // Another process already has the project open. 409, not 500: nothing is
  // broken — the request conflicts with the state of the system, and the fix is
  // the caller's to make. Distinct from DB_CORRUPT on purpose, because the IDE's
  // recovery dialog must NOT offer to reset a database that is merely busy.
  function projectLockedResponse(c: Context, err: unknown): Response | null {
    if (!(err instanceof ProjectLockedError)) return null;
    return c.json({
      error: err.message,
      code: err.code,
      ...(err.detail.suggestion ? { suggestion: err.detail.suggestion } : {}),
    }, 409);
  }

  async function waitForActiveTurnToSettle(): Promise<void> {
    const turn = activeTurnPromise;
    if (!turn) return;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    try {
      await Promise.race([
        turn,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new CloseActiveTurnTimeoutError()),
            CLOSE_ACTIVE_TURN_TIMEOUT_MS,
          );
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  interface RegistryInfoEntry {
    description: string;
    homepage: string;
    license: string;
    latest: string;
    cachedAt: string;
  }
  type RegistryCacheData = Record<string, RegistryInfoEntry>;

  let registryInfoCache: RegistryCacheData = {};

  function loadRegistryCache(): void {
    if (!ctx) {
      registryInfoCache = {};
      return;
    }
    const cachePath = getProjectPaths(ctx.entry.path).registryCache;
    if (!existsSync(cachePath)) {
      registryInfoCache = {};
      return;
    }
    try {
      registryInfoCache = JSON.parse(
        readFileSync(cachePath, "utf-8"),
      ) as RegistryCacheData;
    } catch {
      registryInfoCache = {};
    }
    pruneRegistryCache();
  }

  function saveRegistryCache(): void {
    if (!ctx) return;
    const cachePath = getProjectPaths(ctx.entry.path).registryCache;
    if (!existsSync(dirname(cachePath))) return;
    const tmpPath = cachePath + ".tmp";
    try {
      writeFileSync(tmpPath, JSON.stringify(registryInfoCache));
      renameSync(tmpPath, cachePath);
    } catch {
      // Registry warming is best-effort and can finish after test/temp project cleanup.
    }
  }

  function resolvePackageVersion(name: string): string | null {
    const projectPkg = ctx?.kernel.runtime.getPackageEntry?.(
      ctx.kernel,
      name,
    );
    if (projectPkg) {
      const m = projectPkg.specifier.match(/@([^@]+)$/);
      return m ? m[1]! : null;
    }
    const platPkg = platformPackages.find((p) => p.name === name);
    return platPkg?.version ?? null;
  }

  function isCacheEntryStale(entry: RegistryInfoEntry): boolean {
    return Date.now() - new Date(entry.cachedAt).getTime() >
      REGISTRY_CACHE_MAX_AGE_MS;
  }

  function normalizeRegistryHomepage(value: unknown): string {
    if (typeof value !== "string" || !value.trim()) return "";
    const normalized = value.trim().replace(/^git\+/, "").replace(/\.git$/, "");
    try {
      const url = new URL(normalized);
      return url.protocol === "http:" || url.protocol === "https:"
        ? url.toString()
        : "";
    } catch {
      return "";
    }
  }

  function registryHomepageFromData(data: {
    homepage?: unknown;
    repository?: { url?: unknown };
  }): string {
    return normalizeRegistryHomepage(data.homepage) ||
      normalizeRegistryHomepage(data.repository?.url);
  }

  function pruneRegistryCache(): void {
    if (!ctx) return;
    const installedKeys = new Set<string>();
    for (const pkg of ctx.kernel.runtime.listPackages?.(ctx.kernel) ?? []) {
      const version = resolvePackageVersion(pkg.name);
      if (version) installedKeys.add(`${pkg.name}@${version}`);
    }
    for (const pkg of platformPackages) {
      installedKeys.add(`${pkg.name}@${pkg.version}`);
    }
    let pruned = false;
    for (const key of Object.keys(registryInfoCache)) {
      if (!installedKeys.has(key)) {
        delete registryInfoCache[key];
        pruned = true;
      }
    }
    if (pruned) saveRegistryCache();
  }

  function allPackageNames(): string[] {
    const names: string[] = [];
    if (ctx) {
      for (const pkg of ctx.kernel.runtime.listPackages?.(ctx.kernel) ?? []) {
        names.push(pkg.name);
      }
    }
    for (const pkg of platformPackages) names.push(pkg.name);
    return names;
  }

  async function warmRegistryCache(): Promise<void> {
    const names = allPackageNames();
    if (names.length === 0) return;
    const toFetch: string[] = [];
    for (const name of names) {
      const version = resolvePackageVersion(name);
      const cacheKey = version ? `${name}@${version}` : null;
      if (
        !cacheKey || !registryInfoCache[cacheKey] ||
        isCacheEntryStale(registryInfoCache[cacheKey]!)
      ) {
        toFetch.push(name);
      }
    }
    if (toFetch.length === 0) return;
    await Promise.all(toFetch.map(async (name) => {
      try {
        const res = await fetch(
          `https://registry.npmjs.org/${encodeURIComponent(name)}/latest`,
        );
        if (!res.ok) return;
        const data = await res.json();
        const version = resolvePackageVersion(name);
        if (!version) return;
        registryInfoCache[`${name}@${version}`] = {
          description: data.description ?? "",
          homepage: registryHomepageFromData(data),
          license: typeof data.license === "string"
            ? data.license
            : (data.license?.type ?? ""),
          latest: data.version ?? "",
          cachedAt: new Date().toISOString(),
        };
      } catch { /* skip failed fetches */ }
    }));
    saveRegistryCache();
  }

  async function getPackageRegistryInfo(
    names: string[],
  ): Promise<
    Record<string, DocsPackageRegistryInfo & { description: string } | null>
  > {
    const results: Record<
      string,
      DocsPackageRegistryInfo & { description: string } | null
    > = {};
    const toFetch: string[] = [];

    for (const name of names) {
      const version = resolvePackageVersion(name);
      const cacheKey = version ? `${name}@${version}` : null;
      const cached = cacheKey ? registryInfoCache[cacheKey] : undefined;
      if (cached && !isCacheEntryStale(cached)) {
        results[name] = {
          description: cached.description,
          homepage: normalizeRegistryHomepage(cached.homepage),
          license: cached.license,
          latest: cached.latest,
        };
      } else {
        toFetch.push(name);
      }
    }

    if (toFetch.length > 0) {
      await Promise.all(toFetch.map(async (name) => {
        try {
          const res = await fetch(
            `https://registry.npmjs.org/${encodeURIComponent(name)}/latest`,
          );
          if (!res.ok) {
            results[name] = null;
            return;
          }
          const data = await res.json();
          const info = {
            description: data.description ?? "",
            homepage: registryHomepageFromData(data),
            license: typeof data.license === "string"
              ? data.license
              : (data.license?.type ?? ""),
            latest: data.version ?? "",
          };
          results[name] = info;
          const version = resolvePackageVersion(name);
          if (version) {
            registryInfoCache[`${name}@${version}`] = {
              ...info,
              cachedAt: new Date().toISOString(),
            };
          }
        } catch {
          results[name] = null;
        }
      }));
      saveRegistryCache();
    }

    return results;
  }

  if (ctx) {
    loadRegistryCache();
    warmRegistryCache();
  }
  refreshAvailableModels();

  function getMcpServers(): MCPServerConfig[] {
    if (!ctx) return [];
    return (ctx.kernel.configs.get("_genie_mcp_servers") as
      | MCPServerConfig[]
      | undefined) ?? [];
  }

  function saveMcpServers(servers: MCPServerConfig[]): void {
    if (!ctx) return;
    ctx.kernel.configs.set("_genie_mcp_servers", servers);
    const paths = getProjectPaths(ctx.entry.path);
    saveKernelState(ctx.kernel, paths.stateDir);
  }

  async function syncMcp(): Promise<{ errors: string[] }> {
    const result = await mcpManager.sync(getMcpServers());
    if (ctx && result.errors.length > 0) {
      for (const err of result.errors) {
        ctx.kernel.log.log("error", "system", `MCP: ${err}`);
      }
    }
    return result;
  }

  async function initChat(): Promise<void> {
    if (!ctx) return;
    // The integrated agent is an optional plug-in (OpenTide §3.3). Without a
    // registered chat provider the core runs LLM-neutral: no agent, no MCP sync.
    if (!opts.chatFactory) {
      console.log("  No agent configured — chat disabled.");
      return;
    }
    // Skip the whole MCP-connect + agent-init cold start when NO provider key is
    // configured — MCP tools are only ever consumed by the agent, and the agent
    // can't be created without a key (F-06). Gate on any provider (not Anthropic
    // alone) so an OpenAI-only install still initializes the agent; the resolved
    // agent model then decides per turn whether its provider's key is present
    // (a missing one is refused with MODEL_UNCONFIGURED, not a dead id). Setting a
    // key later via PUT /api/config/api-key re-runs initChat(), so this is lazy.
    if (!hasAnyProviderKey()) {
      console.log(
        "  No API key — chat disabled until a key is set in Settings.",
      );
      return;
    }
    console.log("  Connecting MCP servers...");
    const { errors } = await syncMcp();
    for (const e of errors) console.log(`  MCP error: ${e}`);

    const orchestrator = opts.chatFactory(ctx, mcpManager);
    const paths = getProjectPaths(ctx.entry.path);
    // The interval, the disabled check and the failure handling all live in
    // backup-cadence.ts, which the MCP tool-dispatch path also goes through — so the
    // two faces share one clock over this project instead of each keeping its own and
    // evicting the other's backups under maxDbBackups.
    orchestrator.setOnTurnComplete(() => {
      if (!ctx) return;
      saveKernelState(ctx.kernel, paths.stateDir);
      maybePeriodicBackup(ctx.kernel, ctx.entry.path)
        .then((meta) => {
          if (!meta) return;
          sendToChat({
            type: "backup_created",
            trigger: "periodic",
            tableCount: meta.tableCount,
            rowCount: meta.rowCount,
            branchSnapshotCount: meta.branchSnapshotCount,
            includesProjectState: meta.includesProjectState,
          });
        })
        .catch(() => {});
    });
    console.log("  Initializing AI agent...");
    await orchestrator.initialize();
    chat = orchestrator;
    console.log("  AI agent ready");
  }

  if (ctx) {
    try {
      await initChat();
    } catch (err) {
      console.log(`  AI agent failed to initialize: ${errorMessage(err)}`);
      console.log(
        "  Chat will be unavailable. Set a valid API key in Settings to enable it.",
      );
    }
  }

  const app = new Hono();

  // Reject WebSocket upgrades from foreign Origins / non-loopback Hosts before
  // they reach upgradeWebSocket. Applied to the /chat, /debug, /terminal routes.
  const wsOriginGuard: MiddlewareHandler = async (c, next) => {
    const origin = c.req.header("origin");
    const host = c.req.header("host");
    if (!isAllowedWebSocketRequest(origin, host)) {
      return c.text("Forbidden", 403);
    }
    await next();
  };

  async function resolveRequestUser(c: Context): Promise<CurrentUser | null> {
    const cached = requestUsers.get(c.req.raw);
    if (cached) return cached;
    const user = await auth.resolveUser(c.req.raw);
    if (user) requestUsers.set(c.req.raw, user);
    return user;
  }

  function currentUser(c: Context): CurrentUser {
    const user = requestUsers.get(c.req.raw);
    if (!user) throw new Error("Authenticated user is required.");
    return user;
  }

  function canReadSession(
    user: CurrentUser,
    session: { ownerUserId?: string; visibility?: "private" | "project" },
  ): boolean {
    return canReadUserSession(user, session);
  }

  function filterProjectSummaryForUser(
    user: CurrentUser,
    summary: ProjectSummary,
  ): ProjectSummary {
    if (!summary.sessions) return summary;
    return {
      ...summary,
      sessions: summary.sessions.filter((session) =>
        canReadSession(user, session)
      ),
    };
  }

  function requireTrustedRestOrigin(c: Context): Response | null {
    if (
      isAllowedWebSocketRequest(c.req.header("origin"), c.req.header("host"))
    ) {
      return null;
    }
    return c.json({ error: "Forbidden" }, 403);
  }

  async function requireReadableSession(c: Context, sessionId: string) {
    const session = await ctx!.kernel.sessions.getSession(sessionId);
    if (!session) return c.json({ error: "Session not found" }, 404);
    if (!canReadSession(currentUser(c), session)) {
      return c.json({ error: "Forbidden" }, 403);
    }
    return session;
  }

  async function clearActiveChatSessionIf(sessionId: string): Promise<void> {
    const activeChat = chat;
    if (!activeChat || sessionId !== activeChat.getCurrentSessionId()) return;
    await ctx!.kernel.sessions.endSession(sessionId);
    if (pendingCompaction?.sessionId === sessionId) pendingCompaction = null;
    activeChat.clearCurrentSession();
    await activeChat.clearContext();
  }

  async function queueCompactionForCurrentSession(
    user: CurrentUser,
  ): Promise<
    | { ok: true; sessionId: string; coalesced: boolean }
    | { ok: false; status: number; error: string }
  > {
    const activeChat = chat;
    const sessionId = activeChat?.getCurrentSessionId();
    if (!activeChat || !sessionId) {
      return { ok: false, status: 400, error: "No active session" };
    }

    const session = await ctx!.kernel.sessions.getSession(sessionId);
    if (!session) return { ok: false, status: 404, error: "Session not found" };
    if (!canReadSession(user, session)) {
      return { ok: false, status: 403, error: "Forbidden" };
    }
    if (session.archived) {
      return {
        ok: false,
        status: 409,
        error: "Archived sessions must be unarchived before compacting",
      };
    }

    const coalesced = pendingCompaction?.sessionId === sessionId;
    if (!coalesced) {
      pendingCompaction = {
        sessionId,
        user,
      };
    }
    return { ok: true, sessionId, coalesced };
  }

  async function flushPendingCompaction(
    activeChat: ChatRuntime,
    onEvent?: ChatEventHandler,
  ): Promise<void> {
    if (compactionFlushInFlight || !pendingCompaction || !ctx) return;
    const pending = pendingCompaction;
    if (activeChat.getCurrentSessionId() !== pending.sessionId) return;
    compactionFlushInFlight = true;
    try {
      pendingCompaction = null;
      const session = await ctx.kernel.sessions.getSession(pending.sessionId);
      if (
        !session ||
        session.archived ||
        !canReadSession(pending.user, session)
      ) {
        return;
      }
      const summarized = await summarizeSession(ctx.kernel, {
        sessionId: pending.sessionId,
        kind: "handoff",
        store: true,
        refresh: true,
        requester: "user",
        accountingCaller: "session_compaction",
      });
      const summary = summarized?.summary ?? session.summary ?? "";
      if (!summary.trim()) return;
      const compacted = await activeChat.compactSession(summary, pending.user);
      onEvent?.({
        type: "session_compacted",
        sessionId: compacted.sessionId,
        sessionName: session.name,
        text: "Context compacted after the current agent turn completed.",
      });
    } catch (err) {
      const msg = errorMessage(err);
      ctx?.kernel.log.log("error", "agent", `queued compaction failed: ${msg}`);
      onEvent?.({ type: "error", text: `Queued compaction failed: ${msg}` });
    } finally {
      compactionFlushInFlight = false;
    }
  }

  async function shouldRedactPrivateSession(
    user: CurrentUser,
    sessionId: string | null | undefined,
  ): Promise<boolean> {
    if (!sessionId) return false;
    const session = await ctx?.kernel.sessions.getSession(sessionId);
    return Boolean(
      session && session.visibility === "private" &&
        session.ownerUserId !== user.id,
    );
  }

  async function redactChangeRecordForUser(
    user: CurrentUser,
    record: ChangeRecord,
  ): Promise<ChangeRecord> {
    if (!await shouldRedactPrivateSession(user, record.context?.sessionId)) {
      return record;
    }
    return {
      ...record,
      context: record.context
        ? { ...record.context, userMessage: "Private request." }
        : record.context,
      rationale: record.rationale ? "Private request." : record.rationale,
      implementation: record.implementation
        ? "Private request."
        : record.implementation,
    };
  }

  async function redactTurnGroupForUser(
    user: CurrentUser,
    group: TurnGroup,
  ): Promise<TurnGroup> {
    const changes = [];
    let redacted = false;
    for (const change of group.changes) {
      const next = await redactChangeRecordForUser(user, change);
      redacted ||= next !== change;
      changes.push(next);
    }
    return redacted
      ? { ...group, userMessage: "Private request.", changes }
      : { ...group, changes };
  }

  app.get("/api/auth/me", async (c) => {
    const user = await resolveRequestUser(c);
    if (!user) return c.json({ error: "Unauthorized" }, 401);
    return c.json({
      user,
      accountEntitlementsSupported: auth.accountEntitlementsSupported !== false,
    });
  });

  // The cloud auth surface (login/logout/OAuth callback/entitlements) is a
  // Tide-product concern, NOT OpenTide — it lives in tide/auth-routes.ts
  // (mountAuthRoutes) and is contributed via the mountRoutes hook by the Tide
  // composition roots. In open mode (LocalAuthProvider) there is no login surface
  // at all. Core keeps only the thin /api/auth/me identity endpoint above.

  app.use("/api/*", async (c, next) => {
    if (c.req.path.startsWith("/api/auth/")) return next();
    const user = await resolveRequestUser(c);
    if (!user) return c.json({ error: "Unauthorized" }, 401);
    if (ctx) return await ctx.kernel.changelog.withActor(user.id, next);
    await next();
  });

  // --- Project management (always available) ---

  app.get("/api/project", (c) => {
    if (!ctx) return c.json({ project: null });
    const orchestrated = isOrchestratedChild();
    return c.json({
      project: {
        path: ctx.entry.path,
        name: ctx.entry.name,
        mode: readProjectMode(ctx.entry.path),
        orchestrated,
        orchestratorDashboardUrl: orchestrated
          ? `http://${DEV_SERVER_HOST}:${ORCHESTRATOR_DASHBOARD_PORT}/projects`
          : null,
      },
    });
  });

  app.get("/api/projects", (c) => {
    return c.json(listProjects());
  });

  function currentProjectAccess() {
    return {
      projectPath: ctx?.entry.path,
      kernel: ctx?.kernel,
      sessions: ctx?.kernel.sessions,
    };
  }

  function resolveContextProject(ref: {
    projectPath?: string;
    projectName?: string;
  }) {
    if (ctx) {
      if (!ref.projectPath && !ref.projectName) return ctx.entry;
      if (ref.projectPath && ref.projectPath === ctx.entry.path) {
        return ctx.entry;
      }
      if (
        ref.projectName &&
        ctx.entry.name.toLowerCase() === ref.projectName.toLowerCase()
      ) {
        return ctx.entry;
      }
    }
    return resolveProject(ref, ctx?.entry.path);
  }

  app.get("/api/project-mentions", async (c) => {
    const limit = Number(c.req.query("limit") ?? 20);
    const user = currentUser(c);
    return c.json({
      projects: (await listProjectMentionTargets(
        currentProjectAccess(),
        limit,
      )).map((summary) => filterProjectSummaryForUser(user, summary)),
    });
  });

  app.post("/api/context/project", async (c) => {
    const body = await c.req.json<
      { projectPath?: string; projectName?: string }
    >().catch(() => null);
    const project = resolveContextProject({
      projectPath: body?.projectPath,
      projectName: body?.projectName,
    });
    if (!project) return c.json({ error: "Project not found" }, 404);
    const summary = filterProjectSummaryForUser(
      currentUser(c),
      await getProjectSummary(project, currentProjectAccess(), {
        includeSessions: true,
        sessionLimit: 20,
      }),
    );
    return c.json({ project: summary, context: formatProjectContext(summary) });
  });

  app.post("/api/context/session", async (c) => {
    const body = await c.req.json<{
      projectPath?: string;
      projectName?: string;
      sessionId?: string;
      messageLimit?: number;
    }>().catch(() => null);
    if (!body?.sessionId) {
      return c.json({ error: "sessionId is required" }, 400);
    }
    const project = resolveContextProject({
      projectPath: body.projectPath,
      projectName: body.projectName,
    });
    if (!project) return c.json({ error: "Project not found" }, 404);
    const session = await getSessionContext(
      project,
      body.sessionId,
      currentProjectAccess(),
      body.messageLimit ?? 50,
    );
    if (!session) return c.json({ error: "Session not found" }, 404);
    if (!session.session || !canReadSession(currentUser(c), session.session)) {
      return c.json({ error: "Forbidden" }, 403);
    }
    return c.json({ ...session, context: formatSessionContext(session) });
  });

  async function closeCurrentProject(): Promise<void> {
    if (!ctx) return;
    if (busy && chat) {
      chat.abort();
      await waitForActiveTurnToSettle();
    }
    if (debugManager) {
      await debugManager.stop().catch(() => {});
      debugManager = null;
      debugEventsSubscribed = false;
    }
    if (chat) await chat.close();
    await mcpManager.closeAll();
    for (const listener of projectCloseListeners) {
      await listener().catch((err) =>
        ctx!.kernel.log.log(
          "warn",
          "system",
          `Project-close listener failed: ${errorMessage(err)}`,
        )
      );
    }
    serverToken = null;
    await unloadProject(ctx);
    ctx = null;
    chat = null;
  }

  // Tell other processes this project is served here: the lock record names the
  // control port, and the token file holds the bearer the MCP endpoint wants.
  // Only callable once the listener is bound.
  function advertiseProject(): void {
    if (!ctx) return;
    serverToken = resolveServerToken();
    const written = writeServerToken(ctx.entry.path, serverToken);
    if (!written.ok) {
      ctx.kernel.log.log("warn", "system", written.error.message);
    }
    ctx.lock?.advertise({
      role: "serve",
      controlPort: (server.addr as Deno.NetAddr).port,
    });
  }

  async function openAndInitProject(path: string): Promise<void> {
    ctx = await loadProject(path, {
      appPort: opts.projectAppPort,
      composition: opts.composition,
    });
    advertiseProject();
    loadRegistryCache();
    warmRegistryCache();
    try {
      await initChat();
    } catch (err) {
      console.log(`  AI agent failed to initialize: ${errorMessage(err)}`);
    }
    telemetry.track("project_opened", await projectTelemetryProperties("open"));
    maybeSyncTelemetry();
  }

  function flushCurrentProjectState(): void {
    if (!ctx) return;
    const paths = getProjectPaths(ctx.entry.path);
    ctx.kernel.log.save();
    saveKernelState(ctx.kernel, paths.stateDir);
    saveBranchSnapshots(ctx.kernel, paths.branchSnapshots);
  }

  function gitJsonError(c: Context, err: unknown): Response {
    if (err instanceof GitProjectError) {
      return c.json({ ok: false, code: err.code, error: err.message }, 400);
    }
    return c.json(
      { ok: false, code: "GIT_ERROR", error: errorMessage(err) },
      500,
    );
  }

  const PROJECT_OPERATION_BAD_REQUEST_PATTERNS = [
    "Project name must not be empty",
    "Project folder name must not be empty",
    "Invalid project folder name",
    "Project folder name must be a single folder segment",
    "Project folder must stay within",
  ];
  const PROJECT_OPERATION_CONFLICT_PATTERNS = [
    "already exists",
    "Destination already exists",
    "No OpenTide project found",
    "Corrupt project manifest",
    "Not a directory",
  ];

  function projectOperationError(c: Context, err: unknown): Response {
    const message = errorMessage(err);
    if (
      PROJECT_OPERATION_BAD_REQUEST_PATTERNS.some((p) => message.includes(p))
    ) {
      return c.json({ error: message }, 400);
    }
    if (PROJECT_OPERATION_CONFLICT_PATTERNS.some((p) => message.includes(p))) {
      return c.json({ error: message }, 409);
    }
    return c.json({ error: message }, 500);
  }

  app.post("/api/projects/create", async (c) => {
    const body = await c.req.json<{ path: string; name: string }>().catch(() =>
      null
    );
    if (!body?.path || !body?.name) {
      return c.json({ error: "path and name are required" }, 400);
    }

    try {
      await closeCurrentProject();
      const entry = createProject(body.path, body.name);
      await openAndInitProject(entry.path);
      telemetry.track("project_created", {
        ...(await projectTelemetryProperties("new_project_dialog")),
        creation_source: "new_project_dialog",
      });
      maybeSyncTelemetry();
      return c.json({
        project: { path: ctx!.entry.path, name: ctx!.entry.name },
      }, 201);
    } catch (err) {
      const locked = projectLockedResponse(c, err);
      if (locked) return locked;
      if (isRecoverableDatabaseOpenError(err)) {
        return recoverableDatabaseError(c, err);
      }
      return c.json({ error: errorMessage(err) }, 400);
    }
  });

  // Adopt an existing code directory as a source-backed project, then index it —
  // the GUI on-ramp for project import (adopt-to-run). Sits beside create/open
  // (same plain-control-route convention) and returns the graph summary (framework
  // + command counts) so the picker can show what was detected.
  app.post("/api/projects/import", async (c) => {
    const body = await c.req.json<{ path: string; name?: string }>().catch(() =>
      null
    );
    if (!body?.path) {
      return c.json({ error: "path is required" }, 400);
    }

    try {
      await closeCurrentProject();
      const entry = importProject(
        body.path,
        typeof body.name === "string" ? body.name : undefined,
      );
      await openAndInitProject(entry.path);
      // Index the adopted codebase so GET /api/codebase + the overlays are populated
      // (best-effort — reindexSourceBackedCodebase swallows + logs its own errors).
      const summary = await reindexSourceBackedCodebase(ctx!.kernel);
      telemetry.track("project_imported", {
        ...(await projectTelemetryProperties("import_project_dialog")),
        creation_source: "import_project_dialog",
      });
      maybeSyncTelemetry();
      return c.json({
        project: { path: ctx!.entry.path, name: ctx!.entry.name },
        summary,
      }, 201);
    } catch (err) {
      const locked = projectLockedResponse(c, err);
      if (locked) return locked;
      if (isRecoverableDatabaseOpenError(err)) {
        return recoverableDatabaseError(c, err);
      }
      return c.json({ error: errorMessage(err) }, 400);
    }
  });

  app.post("/api/projects/duplicate", async (c) => {
    const body = await readJsonObject(c);
    if (body instanceof Response) return body;
    const path = stringField(body, "path");
    if (!path) return c.json({ error: "path is required" }, 400);
    if (ctx && resolve(path) === resolve(ctx.entry.path)) {
      return c.json({
        error: "Close the current project before duplicating it.",
      }, 409);
    }

    try {
      const entry = duplicateProject(path);
      return c.json({ project: { path: entry.path, name: entry.name } }, 201);
    } catch (err) {
      return projectOperationError(c, err);
    }
  });

  app.post("/api/projects/rename", async (c) => {
    const body = await readJsonObject(c);
    if (body instanceof Response) return body;
    const path = stringField(body, "path");
    const name = stringField(body, "name");
    const folderName = stringField(body, "folderName");
    if (!path || !name || !folderName) {
      return c.json({ error: "path, name, and folderName are required" }, 400);
    }
    if (ctx && resolve(path) === resolve(ctx.entry.path)) {
      return c.json({
        error: "Close the current project before renaming it.",
      }, 409);
    }

    try {
      const entry = renameProject(path, { name, folderName });
      return c.json({ project: { path: entry.path, name: entry.name } });
    } catch (err) {
      return projectOperationError(c, err);
    }
  });

  app.post("/api/projects/open", async (c) => {
    const body = await c.req.json<{ path: string }>().catch(() => null);
    if (!body?.path) return c.json({ error: "path is required" }, 400);

    try {
      await closeCurrentProject();
      await openAndInitProject(body.path);
      return c.json({
        project: { path: ctx!.entry.path, name: ctx!.entry.name },
      });
    } catch (err) {
      const locked = projectLockedResponse(c, err);
      if (locked) return locked;
      if (isRecoverableDatabaseOpenError(err)) {
        return recoverableDatabaseError(c, err);
      }
      return c.json({ error: errorMessage(err) }, 400);
    }
  });

  app.post("/api/projects/close", async (c) => {
    if (!ctx) return c.json({ error: "No project is open" }, 400);
    if (isOrchestratedChild()) {
      return c.json({
        error:
          "This project is managed by the orchestrator. Stop it from the project dashboard.",
      }, 409);
    }

    try {
      await closeCurrentProject();
      return c.json({ ok: true });
    } catch (err) {
      if (err instanceof CloseActiveTurnTimeoutError) {
        return c.json({ error: err.message }, 409);
      }
      return c.json({ error: errorMessage(err) }, 500);
    }
  });

  app.post("/api/projects/reset-db", async (c) => {
    const body = await readJsonObject(c);
    if (body instanceof Response) return body;
    const path = stringField(body, "path");
    if (!path) return c.json({ error: "path is required" }, 400);
    const backupId = stringField(body, "backupId");
    const resetEmpty = body.empty === true || body.resetEmpty === true;

    try {
      const paths = getProjectPaths(path);
      const selectedBackup = resetEmpty
        ? null
        : backupId
        ? loadBackup(paths.backups, backupId)
        : (() => {
          const backups = listBackups(paths.backups);
          return backups.length > 0
            ? loadBackup(paths.backups, backups[0]!.id)
            : null;
        })();
      if (backupId && !selectedBackup) {
        return c.json({ error: "Backup not found" }, 404);
      }

      await closeCurrentProject();

      // This wipes the data directory. If another process has the project open,
      // that is destroying a live database out from under it — so take the lock
      // first and refuse rather than proceed. Released before the reopen below,
      // which takes it again through loadProject.
      const guard = acquireProjectLock(path, "this kernel");
      if (!guard.ok) {
        return c.json({
          error: guard.error.message,
          code: guard.error.code,
          ...(guard.error.suggestion
            ? { suggestion: guard.error.suggestion }
            : {}),
        }, guard.error.code === "PROJECT_ALREADY_OPEN" ? 409 : 500);
      }
      try {
        // Write kernel state from backup before opening (loadKernelState reads it on load)
        if (selectedBackup?.kernelState) {
          saveProjectStateData(selectedBackup.kernelState, paths.stateDir);
        }
        rmSync(paths.schemaDir, { recursive: true, force: true });

        const resetConnection = await resetAndCreateDatabase({
          driver: "pglite",
          dataDir: paths.dataDir,
        });
        await resetConnection.close();
      } finally {
        guard.data.release();
      }
      await openAndInitProject(path);
      if (selectedBackup && ctx) ctx.backupOnUnload = false;

      // Restore DB tables and branch snapshots from backup
      let restoredFrom: string | null = null;
      let restoredTableCount = 0;
      let restoredRowCount = 0;
      if (selectedBackup && ctx) {
        const result = await restoreDbTables(selectedBackup, ctx.kernel.db);
        restoredTableCount = result.restored;
        restoredRowCount = result.restoredRows;
        if (result.errors.length > 0) {
          return c.json({
            error: "Backup restore failed",
            code: "BACKUP_RESTORE_FAILED",
            errors: result.errors,
            project: { path: ctx.entry.path, name: ctx.entry.name },
            restoredFrom: selectedBackup.metadata.id,
            restoredTableCount,
            restoredRowCount,
          }, 500);
        }
        const snapshotCount = restoreBranchSnapshots(
          selectedBackup,
          ctx.kernel,
        );
        if (snapshotCount > 0) {
          saveBranchSnapshots(ctx.kernel, paths.branchSnapshots);
        }
        restoredFrom = selectedBackup.metadata.id;
        console.log(
          `  Restored ${result.restored} tables, ${snapshotCount} branch snapshots from backup ${restoredFrom}`,
        );
      }
      if (ctx) ctx.backupOnUnload = true;

      return c.json({
        project: { path: ctx!.entry.path, name: ctx!.entry.name },
        dbWasReset: true,
        restoredFrom,
        restoredTableCount,
        restoredRowCount,
      });
    } catch (err) {
      const locked = projectLockedResponse(c, err);
      if (locked) return locked;
      if (isRecoverableDatabaseOpenError(err)) {
        return recoverableDatabaseError(c, err);
      }
      return c.json({ error: errorMessage(err), code: "RESET_DB_FAILED" }, 500);
    }
  });

  app.post("/api/projects/backup-info", async (c) => {
    const body = await c.req.json<{ path: string }>().catch(() => null);
    if (!body?.path) return c.json({ error: "path is required" }, 400);
    try {
      const paths = getProjectPaths(body.path);
      const backups = listBackups(paths.backups);
      let snapshotCount = 0;
      if (existsSync(paths.branchSnapshots)) {
        snapshotCount = readdirSync(paths.branchSnapshots).filter((f) =>
          f.endsWith(".json")
        ).length;
      }
      return c.json({ backups, snapshotCount });
    } catch (err) {
      return c.json({ error: errorMessage(err) }, 500);
    }
  });

  app.post("/api/projects/recovery/diagnostics", async (c) => {
    const body = await readJsonObject(c);
    if (body instanceof Response) return body;
    const projectPath = stringField(body, "projectPath") ??
      stringField(body, "path");
    if (!projectPath) return c.json({ error: "projectPath is required" }, 400);
    const failedOpenError = stringField(body, "failedOpenError");
    try {
      const diagnostics = await diagnoseRecoveryProject(
        projectPath,
        failedOpenError ?? undefined,
      );
      return c.json({
        diagnostics,
        initialMessage: recoveryInitialMessage(diagnostics),
      });
    } catch (err) {
      return c.json({ error: errorMessage(err) }, 500);
    }
  });

  app.post("/api/projects/attempt-repair", async (c) => {
    const body = await c.req.json<{ path: string }>().catch(() => null);
    if (!body?.path) return c.json({ error: "path is required" }, 400);
    try {
      await closeCurrentProject();
      // Repair deletes WAL segments. Doing that under a process that has the
      // project open destroys it — and a busy project is the likeliest reason
      // someone reached for repair in the first place.
      const guard = acquireProjectLock(body.path, "this kernel");
      if (!guard.ok) {
        return c.json({
          error: guard.error.message,
          code: guard.error.code,
          ...(guard.error.suggestion
            ? { suggestion: guard.error.suggestion }
            : {}),
        }, guard.error.code === "PROJECT_ALREADY_OPEN" ? 409 : 500);
      }
      try {
        const paths = getProjectPaths(body.path);
        const result = await attemptRepairDatabase(paths.dataDir);
        return c.json(result);
      } finally {
        guard.data.release();
      }
    } catch (err) {
      return c.json({ error: errorMessage(err) }, 500);
    }
  });

  app.delete("/api/projects", async (c) => {
    const body = await readJsonObject(c);
    if (body instanceof Response) return body;
    const path = stringField(body, "path");
    if (!path) return c.json({ error: "path is required" }, 400);
    if (ctx && ctx.entry.path === path) {
      return c.json({ error: "Cannot delete the currently open project" }, 400);
    }
    SecretsStore.deleteProjectSecrets(path);
    removeProject(path, body.deleteFiles === true);
    return c.json({ ok: true });
  });

  // --- Filesystem browsing (for folder picker) ---

  function isPathWithinOrEqual(path: string, parent: string): boolean {
    const rel = relative(parent, path);
    return rel === "" || (!!rel && !rel.startsWith("..") && !isAbsolute(rel));
  }

  app.get("/api/fs/list", (c) => {
    const home = normalize(resolve(Deno.env.get("HOME") || "/"));
    const raw = c.req.query("path") || home;
    const dir = normalize(resolve(raw));
    const isInsideHome = isPathWithinOrEqual(dir, home);
    const isAncestorOfHome = isPathWithinOrEqual(home, dir);
    if (!isInsideHome && !isAncestorOfHome) {
      return c.json({ path: dir, entries: [], error: "Access denied" });
    }
    try {
      const entries: { name: string; isDir: boolean }[] = [];
      for (const entry of Deno.readDirSync(dir)) {
        if (entry.name.startsWith(".")) continue;
        entries.push({ name: entry.name, isDir: entry.isDirectory });
      }
      entries.sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      return c.json({ path: dir, entries });
    } catch {
      return c.json({ path: dir, entries: [], error: "Cannot read directory" });
    }
  });

  app.post("/api/fs/mkdir", async (c) => {
    const home = normalize(resolve(Deno.env.get("HOME") || "/"));
    const body = await readJsonObject(c);
    if (body instanceof Response) return body;
    const path = stringField(body, "path");
    if (!path) return c.json({ error: "path is required" }, 400);
    const dir = normalize(resolve(path));
    if (!isPathWithinOrEqual(dir, home)) {
      return c.json({ error: "Access denied" }, 403);
    }
    try {
      Deno.mkdirSync(dir, { recursive: true });
      return c.json({ path: dir });
    } catch {
      return c.json({ error: "Failed to create directory" }, 500);
    }
  });

  // --- Kernel guard middleware for IDE endpoints ---

  function requireKernel(
    c: { json: (body: unknown, status?: number) => Response },
  ) {
    if (!ctx) return c.json({ error: "No project open" }, 400);
    return null;
  }

  function localState(): LocalStateStore {
    return new LocalStateStore(getProjectPaths(ctx!.entry.path).localState);
  }

  const MAX_CHAT_DRAFT_TEXT_LENGTH = 100_000;
  type ChatDraftMap = Record<string, string>;

  async function getLocalJsonState<T>(
    key: string,
    fallback: T,
  ): Promise<T> {
    const local = localState().get<T>(key);
    if (local !== null) return local;

    // Backward compatibility: these UI-state keys used to live in
    // .opentide/history/meta.json. Read them, but never write them back there.
    const legacy = await ctx!.kernel.changelog.getMeta(key);
    if (!legacy) return fallback;
    try {
      return JSON.parse(legacy) as T;
    } catch {
      return fallback;
    }
  }

  app.get("/api/project/doctor", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    return c.json(await doctorProject(ctx!.entry.path, ctx!.kernel.db));
  });

  app.get("/api/project/consistency-check", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    return c.json(await doctorProject(ctx!.entry.path, ctx!.kernel.db));
  });

  // --- App preview port (Feature A / A3) ---
  // The manifest holds the *preference* (auto | fixed N); the app server holds
  // the *actual* bound port, which diverges from a fixed pref on a collision
  // fallback (locked decision #1). A boot-time fallback is therefore visible to
  // the IDE as mode="fixed" && requestedPort != null && actualPort !==
  // requestedPort — no dedicated event needed (Feature A / A5).
  app.get("/api/project/preview-port", (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const pref = readProjectPreviewPort(ctx!.entry.path);
    const isFixed = pref !== PREVIEW_PORT_AUTO;
    return c.json({
      mode: isFixed ? "fixed" : "auto",
      requestedPort: isFixed ? pref : null,
      actualPort: ctx!.appServer.port,
      listening: ctx!.appServer.listening,
    });
  });

  app.put("/api/project/preview-port", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const body = await c.req.json<{ mode?: string; port?: number }>().catch(
      () => null,
    );
    if (!body || (body.mode !== "auto" && body.mode !== "fixed")) {
      return c.json({ error: 'mode must be "auto" or "fixed"' }, 400);
    }
    const value: PreviewPort = body.mode === "fixed"
      ? (body.port ?? Number.NaN)
      : PREVIEW_PORT_AUTO;
    // Persist first (validates the fixed port and preserves other manifest
    // keys), then live-rebind the listener. rebind honors the same collision
    // fallback as first bind, so actualPort may differ from a fixed request.
    const written = writeProjectPreviewPort(ctx!.entry.path, value);
    if (!written.ok) return c.json({ error: written.error.message }, 400);
    const resolved = value === PREVIEW_PORT_AUTO ? APP_PORT_AUTO : value;
    const actualPort = await ctx!.appServer.rebind(resolved);
    const fellBack = value !== PREVIEW_PORT_AUTO && actualPort !== value;
    return c.json({ actualPort, fellBack });
  });

  // Cheap, advisory availability probe (non-authoritative — the port can be
  // taken between this check and a later Save; the save-time fallback is the
  // real safety net). Test-binds and immediately releases the port.
  app.get("/api/project/preview-port/check", (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const port = Number(c.req.query("port"));
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return c.json({ error: "port must be an integer in [1, 65535]" }, 400);
    }
    let available = false;
    try {
      const probe = Deno.listen({ hostname: DEV_SERVER_HOST, port });
      probe.close();
      available = true;
    } catch { /* AddrInUse (or any bind error) ⇒ not available */ }
    return c.json({ available });
  });

  // --- Source-backed dev server (project import, Slice 3) ---
  // Spawns the imported project's native dev command and points the app-preview
  // listener at it (appServer.setProxy). Gated on source-backed mode inside
  // resolveDevRunConfig — a registry-native project can NEVER auto-spawn. Contracts:
  // DEV_SERVER_{START,STOP,STATUS}_ROUTE_SCHEMA.
  app.post("/api/preview/dev-server/start", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    if (ctx!.devServer.running) {
      return c.json({ error: "Dev server is already running" }, 409);
    }
    const body = await c.req.json<
      { command?: string; cwd?: string; port?: number }
    >().catch(() => ({} as { command?: string; cwd?: string; port?: number }));
    const explicit: Partial<SourceBackedRunConfig> = {
      ...(typeof body.command === "string" ? { command: body.command } : {}),
      ...(typeof body.cwd === "string" ? { cwd: body.cwd } : {}),
      ...(typeof body.port === "number" ? { port: body.port } : {}),
    };
    const resolved = resolveDevRunConfig(
      ctx!.kernel,
      ctx!.entry.path,
      explicit,
    );
    if (!resolved.ok) {
      // Mode/command problems are caller errors (400); everything else is the run.
      return c.json({ error: resolved.error.message }, 400);
    }
    const started = await ctx!.devServer.start(resolved.data);
    if (!started.ok) {
      const status = started.error.code === "DEV_SERVER_ALREADY_RUNNING"
        ? 409
        : 500;
      return c.json({ error: started.error.message }, status);
    }
    // Persist the resolved run config as source-backed run metadata so a later
    // start reuses it (default absent ⇒ auto-detect). Best-effort: a failed write
    // must not undo a successful start.
    const persist: SourceBackedRunConfig = {
      command: resolved.data.command,
      ...(resolved.data.cwd ? { cwd: resolved.data.cwd } : {}),
      ...(started.data.detectedPort
        ? { port: started.data.detectedPort }
        : resolved.data.port
        ? { port: resolved.data.port }
        : {}),
    };
    const written = writeProjectRunConfig(ctx!.entry.path, persist);
    if (!written.ok) {
      ctx!.kernel.log.log(
        "warn",
        "system",
        `Dev server started but run config not persisted: ${written.error.message}`,
      );
    }
    return c.json(started.data);
  });

  app.post("/api/preview/dev-server/stop", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const stopped = await ctx!.devServer.stop();
    if (!stopped.ok) return c.json({ error: stopped.error.message }, 500);
    return c.json(stopped.data);
  });

  app.get("/api/preview/dev-server/status", (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    return c.json(ctx!.devServer.status());
  });

  app.get("/api/git/status", (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    try {
      return c.json({
        ok: true,
        status: gitStatus(ctx!.entry.path, flushCurrentProjectState),
      });
    } catch (err) {
      return gitJsonError(c, err);
    }
  });

  app.post("/api/git/init", (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    try {
      return c.json({ ok: true, status: gitInit(ctx!.entry.path) });
    } catch (err) {
      return gitJsonError(c, err);
    }
  });

  app.post("/api/git/gitignore", (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    try {
      return c.json({ ok: true, ...gitAddTideGitignore(ctx!.entry.path) });
    } catch (err) {
      return gitJsonError(c, err);
    }
  });

  app.post("/api/git/remote", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const body = await c.req.json<{ name?: string; url?: string }>().catch(
      () => null,
    );
    try {
      return c.json({
        ok: true,
        status: gitSetRemote(
          ctx!.entry.path,
          body?.url ?? "",
          body?.name ?? "origin",
        ),
      });
    } catch (err) {
      return gitJsonError(c, err);
    }
  });

  app.post("/api/git/commit", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const body = await c.req.json<{ message?: string }>().catch(() => null);
    try {
      const resolvedMessage = await resolveGitCommitMessage(
        ctx!.entry.path,
        body?.message,
        flushCurrentProjectState,
        {
          recordUsage: (input) => ctx!.kernel.sessions.recordModelUsage(input),
        },
      );
      return c.json({
        ok: true,
        status: gitCommit(ctx!.entry.path, resolvedMessage.message),
        message: resolvedMessage.message,
        messageGenerated: resolvedMessage.generated,
        messageGeneratedBy: resolvedMessage.generatedBy,
      });
    } catch (err) {
      return gitJsonError(c, err);
    }
  });

  app.post("/api/git/push", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const body = await c.req.json<{ name?: string; branch?: string }>().catch(
      () => null,
    );
    try {
      return c.json({
        ok: true,
        status: gitPush(
          ctx!.entry.path,
          body?.name ?? "origin",
          body?.branch,
          flushCurrentProjectState,
        ),
      });
    } catch (err) {
      return gitJsonError(c, err);
    }
  });

  app.get("/api/project/data/fixtures", (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const fixturesDir = join(ctx!.entry.path, "fixtures");
    if (!existsSync(fixturesDir)) return c.json({ fixtures: [] });
    const fixtures = readdirSync(fixturesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const dir = join(fixturesDir, entry.name);
        const manifestPath = join(fixturesDir, entry.name, "manifest.json");
        let rowCount = 0;
        let tables = 0;
        const statPath = existsSync(manifestPath) ? manifestPath : dir;
        const modifiedAt = statSync(statPath).mtime.toISOString();
        if (existsSync(manifestPath)) {
          try {
            const manifest = JSON.parse(
              readFileSync(manifestPath, "utf-8"),
            ) as {
              tables?: Array<{ rowCount?: number }>;
            };
            tables = manifest.tables?.length ?? 0;
            rowCount = manifest.tables?.reduce(
              (sum, table) => sum + (table.rowCount ?? 0),
              0,
            ) ?? 0;
          } catch { /* ignore unreadable manifests */ }
        }
        return {
          name: entry.name,
          tables,
          rowCount,
          path: relative(ctx!.entry.path, dir),
          modifiedAt,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
    return c.json({ fixtures });
  });

  app.delete("/api/project/data/fixtures/:name", (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    try {
      const result = deleteDataFixture(ctx!.entry.path, c.req.param("name"));
      return c.json(result);
    } catch (err) {
      return c.json({ error: errorMessage(err) }, 400);
    }
  });

  app.post("/api/project/data/export", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const body: { name?: string; tables?: string[] } = await c.req.json<{
      name?: string;
      tables?: string[];
    }>().catch(() => ({}));
    try {
      const result = await exportDataFixture(ctx!.kernel.db, ctx!.entry.path, {
        name: body.name,
        tables: body.tables,
      });
      return c.json(result);
    } catch (err) {
      return c.json({ error: errorMessage(err) }, 400);
    }
  });

  app.post("/api/project/data/import", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const body: {
      name?: string;
      tables?: string[];
      mode?: "truncate" | "append";
    } = await c.req.json<{
      name?: string;
      tables?: string[];
      mode?: "truncate" | "append";
    }>().catch(() => ({}));
    try {
      const result = await importDataFixture(ctx!.kernel.db, ctx!.entry.path, {
        name: body.name,
        tables: body.tables,
        mode: body.mode,
      });
      return c.json(result);
    } catch (err) {
      return c.json({ error: errorMessage(err) }, 400);
    }
  });

  app.post("/api/project/data/reset", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const body: { tables?: string[] } = await c.req.json<{
      tables?: string[];
    }>().catch(() => ({}));
    try {
      const result = await resetDataTables(ctx!.kernel.db, body.tables);
      return c.json(result);
    } catch (err) {
      return c.json({ error: errorMessage(err) }, 400);
    }
  });

  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  async function readJsonObject(
    c: {
      req: { json: <T = unknown>() => Promise<T> };
      json: (body: unknown, status?: number) => Response;
    },
  ): Promise<Record<string, unknown> | Response> {
    const body = await c.req.json().catch(() => null);
    if (!isRecord(body)) {
      return c.json({ error: "Request body must be a JSON object" }, 400);
    }
    return body;
  }

  function stringField(
    body: Record<string, unknown>,
    key: string,
  ): string | null {
    const value = body[key];
    return typeof value === "string" && value.trim() ? value.trim() : null;
  }

  async function projectTelemetryProperties(source: string) {
    if (!ctx) return { source };
    const schemas = await ctx.kernel.db.listSchemas().catch(() => []);
    return {
      source,
      project_local_id: undefined,
      runtime_id: ctx.kernel.runtimeId,
      route_count: ctx.kernel.routes.list().length,
      handler_count: ctx.kernel.handlers.list().length,
      function_count: ctx.kernel.functions.list().length,
      schema_count: schemas.length,
      test_count: ctx.kernel.tests.list().length,
    };
  }

  function maybeSyncTelemetry(): void {
    const settings = getTelemetrySettings();
    if (!settings.endpoint.trim()) return;
    // Fire only when some category is permitted to egress. Feedback consent is
    // independent of the passive-telemetry master switch, so a feedback-only
    // consent still flushes; sync() itself filters per-record via egressAllowed.
    if (
      !egressAllowed(settings, "event") && !egressAllowed(settings, "feedback")
    ) {
      return;
    }
    telemetry.sync().catch((err) => {
      console.warn(`Telemetry sync failed: ${errorMessage(err)}`);
    });
  }

  function bucketTokens(value: number): string {
    if (value <= 0) return "0";
    if (value <= 1_000) return "1-1k";
    if (value <= 5_000) return "1k-5k";
    if (value <= 20_000) return "5k-20k";
    if (value <= 100_000) return "20k-100k";
    return "100k+";
  }

  function bucketCost(value: number): string {
    if (value <= 0) return "0";
    if (value <= 0.01) return "0-0.01";
    if (value <= 0.10) return "0.01-0.10";
    if (value <= 1) return "0.10-1";
    if (value <= 10) return "1-10";
    return "10+";
  }

  function modelFamily(model: string): string {
    if (model.includes("opus")) return "claude-opus";
    if (model.includes("sonnet")) return "claude-sonnet";
    if (model.includes("haiku")) return "claude-haiku";
    return "other";
  }

  // --- IDE endpoints (require an open project) ---

  app.get("/api/status", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const kernel = ctx!.kernel;
    return c.json({
      routes: kernel.routes.list().length,
      handlers: kernel.handlers.list().length,
      functions: kernel.functions.list().length,
      schemas: (await kernel.db.listSchemas()).length,
      configKeys: kernel.configs.list().length,
      runtime: runtimeMetadata(kernel.runtime),
    });
  });

  app.get("/api/chat/status", (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const detail = c.req.query("detail") === "full" ? "full" : "compact";
    const inProgress = chat?.getInProgressState(detail) ?? null;
    return c.json({
      busy,
      currentSessionId: chat?.getCurrentSessionId() ?? null,
      inProgress,
    });
  });

  app.get("/api/inspect", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const kernel = ctx!.kernel;
    const envVars = kernel.envVars.listEnriched();
    const [schemas, changelog, changelogCursor] = await Promise.all([
      kernel.db.listSchemas(),
      kernel.changelog.recent(50),
      kernel.changelog.getCursor(),
    ]);
    return c.json({
      runtime: runtimeMetadata(kernel.runtime),
      routes: sortRoutes(kernel.routes.list()),
      handlers: kernel.handlers.serialize(),
      functions: kernel.functions.serialize(),
      configs: kernel.configs.serialize(),
      templates: kernel.templates.serialize(),
      assets: kernel.assets.list(),
      schemas,
      packages: kernel.runtime.listPackages?.(kernel) ?? [],
      runtimeDependencies: runtimeDependencyManifest,
      platformPackages,
      pinnedPackages: (kernel.configs.get("_genie_pinned_packages") as
        | string[]
        | undefined) ?? [],
      logs: kernel.log.recent(100),
      activeBranch: kernel.branches.getActive(),
      branches: kernel.branches.list(),
      requests: kernel.requestLog.recent(50),
      changelog,
      changelogCursor,
      devViews: kernel.devViews.list().map((v) => {
        const linkedType = !v.builtIn
          ? kernel.types.get(v.targetType)
          : undefined;
        return {
          name: v.name,
          targetType: v.targetType,
          title: v.title,
          source: v.source,
          builtIn: v.builtIn,
          registeredAt: v.registeredAt,
          ...(v.module ? { module: v.module } : {}),
          ...(v.runtimeId ? { runtimeId: v.runtimeId } : {}),
          ...(v.language ? { language: v.language } : {}),
          ...(linkedType ? { forTypeName: linkedType.name } : {}),
        };
      }),
      devTools: kernel.devTools.list().map((t) => ({
        name: t.name,
        description: t.description,
        args: t.args,
        registeredAt: t.registeredAt,
        ...(t.module ? { module: t.module } : {}),
        ...(t.runtimeId ? { runtimeId: t.runtimeId } : {}),
        ...(t.language ? { language: t.language } : {}),
      })),
      auditCategories: [
        ...BUILTIN_AUDIT_CATEGORIES.map((name) => ({
          name,
          description: BUILTIN_AUDIT_DESCRIPTIONS[name],
          builtin: true,
        })),
        ...kernel.customAudits.list().map((a) => ({
          name: a.name,
          description: a.description,
          builtin: false,
          ...(a.module ? { module: a.module } : {}),
        })),
      ],
      tests: kernel.tests.list().map((t) => ({
        name: t.name,
        source: t.source,
        registeredAt: t.registeredAt,
        ...(t.module ? { module: t.module } : {}),
        ...(t.changesetId ? { changesetId: t.changesetId } : {}),
        ...(t.verification ? { verification: t.verification } : {}),
        ...(t.lastResult ? { lastResult: t.lastResult } : {}),
        ...(t.runtimeId ? { runtimeId: t.runtimeId } : {}),
        ...(t.language ? { language: t.language } : {}),
      })),
      secrets: kernel.secrets.list().map((s) => ({
        key: s.key,
        description: s.description,
        status: kernel.secrets.status(s.key),
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
      })),
      envVars: envVars.map((v) => ({
        key: v.key,
        description: v.description,
        status: v.status,
        createdAt: v.createdAt,
        updatedAt: v.updatedAt,
      })),
      types: kernel.types.serialize().map((t) => {
        const view = kernel.devViews.list().find((v) =>
          !v.builtIn && v.targetType === t.name
        );
        return { ...t, ...(view ? { devViewName: view.name } : {}) };
      }),
      latestAudits: [
        ...BUILTIN_AUDIT_CATEGORIES,
        ...kernel.customAudits.list().map((a) => a.name),
      ].map((cat) => {
        const r = kernel.audits.latest(cat);
        return r
          ? {
            category: cat,
            score: r.score,
            issueCount: r.issues.length,
            status: r.status,
          }
          : null;
      }).filter(Boolean),
      appPort: ctx!.appServer.port,
    });
  });

  // Serve the cached source-backed codebase graph (project-import Slice 1). The
  // graph is populated in-memory by the index_codebase tool; { graph: null }
  // until a first index runs. Contract documented by CODEBASE_ROUTE_SCHEMA.
  app.get("/api/codebase", (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    return c.json({ graph: ctx!.kernel.codebaseGraph ?? null });
  });

  app.get("/api/schema-counts", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const kernel = ctx!.kernel;
    const schemas = await kernel.db.listSchemas();
    const counts: Record<string, number> = {};
    for (const s of schemas) {
      try {
        const rows = await kernel.db.query(
          `SELECT count(*)::int AS total FROM "${s.tableName}"`,
        );
        counts[s.tableName] = (rows[0]?.total as number) ?? 0;
      } catch {
        counts[s.tableName] = -1;
      }
    }
    return c.json(counts);
  });

  app.get("/api/schemas/:tableName/migrations", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const tableName = c.req.param("tableName");
    const migrations = await ctx!.kernel.db.listMigrations(tableName);
    return c.json(migrations);
  });

  app.post("/api/schemas/:tableName/migrations/undo", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const tableName = c.req.param("tableName");
    const result = await ctx!.kernel.db.undoMigration(tableName);
    if (!result.ok) return c.json(result.error, 400);
    return c.json(result.data);
  });

  app.post("/api/schemas/:tableName/migrations/redo", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const tableName = c.req.param("tableName");
    const result = await ctx!.kernel.db.redoMigration(tableName);
    if (!result.ok) return c.json(result.error, 400);
    return c.json(result.data);
  });

  app.post("/api/schemas/:tableName/rollback", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const tableName = c.req.param("tableName");
    const body = await c.req.json<{ version: number }>().catch(() => null);
    if (!body || typeof body.version !== "number") {
      return c.json({ error: "version is required" }, 400);
    }
    const result = await ctx!.kernel.db.rollbackToVersion(
      tableName,
      body.version,
    );
    if (!result.ok) return c.json(result.error, 400);
    return c.json(result.data);
  });

  app.get("/api/modules", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const kernel = ctx!.kernel;
    const modules = kernel.listModules();
    const data: Array<
      { name: string; entities: Record<string, number>; total: number }
    > = [];
    for (const mod of modules) {
      const entities = await kernel.getModuleEntities(mod);
      const counts: Record<string, number> = {};
      let total = 0;
      for (const [cat, arr] of Object.entries(entities)) {
        if ((arr as unknown[]).length > 0) {
          counts[cat] = (arr as unknown[]).length;
          total += (arr as unknown[]).length;
        }
      }
      data.push({ name: mod, entities: counts, total });
    }
    return c.json({ modules: data, count: modules.length });
  });

  app.get("/api/openapi", (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const kernel = ctx!.kernel;
    const spec = generateOpenAPISpec(kernel.routes.list(), {
      serverUrl: appPreviewUrl(ctx!.appServer.port, "/"),
    });
    return c.json(spec);
  });

  app.get("/api/docs", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const kernel = ctx!.kernel;
    let packageRegistryInfo:
      | Record<string, DocsPackageRegistryInfo | null>
      | undefined;
    try {
      const packages = kernel.runtime.listPackages?.(kernel) ?? [];
      if (packages.length) {
        packageRegistryInfo = await getPackageRegistryInfo(
          packages.map((pkg) => pkg.name),
        );
      }
    } catch {
      packageRegistryInfo = undefined;
    }
    const docs = await generateAppDocs(kernel, { packageRegistryInfo });
    return c.json(docs);
  });

  app.post("/api/app/restart", (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    ctx!.appServer.restart();
    return c.json({ ok: true });
  });

  app.post("/api/kernel/restart", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const projectPath = ctx!.entry.path;
    try {
      await closeCurrentProject();
      await openAndInitProject(projectPath);
      return c.json({ ok: true });
    } catch (err) {
      if (isRecoverableDatabaseOpenError(err)) {
        return c.json({
          ok: false,
          error: true,
          code: "DB_CORRUPT",
          message: errorMessage(err),
        }, 500);
      }
      return c.json({
        ok: false,
        error: true,
        code: "RESTART_FAILED",
        message: errorMessage(err),
      }, 500);
    }
  });

  app.put("/api/entities/:category/:name", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const category = c.req.param("category");
    const entityName = c.req.param("name");
    const body = await c.req.json<{ source: string }>().catch(() => null);
    if (!body?.source && body?.source !== "") {
      return c.json({ error: "source is required" }, 400);
    }

    const toolMap: Record<
      string,
      { tool: string; input: Record<string, unknown> } | null
    > = {
      handler: {
        tool: "define_handler",
        input: { name: entityName, source: body.source },
      },
      function: {
        tool: "define_function",
        input: { name: entityName, source: body.source },
      },
      template: {
        tool: "define_template",
        input: { name: entityName, content: body.source },
      },
      test: {
        tool: "define_test",
        input: { name: entityName, source: body.source },
      },
      asset: null,
      dev_view: null,
    };

    if (category === "asset") {
      const existing = ctx!.kernel.assets.get(entityName);
      if (!existing) {
        return c.json({ error: `Asset "${entityName}" not found` }, 404);
      }
      if (!isEditableTextAssetMime(existing.mimeType)) {
        return c.json({
          error: `Cannot edit binary asset "${entityName}" in Code`,
        }, 400);
      }
      toolMap.asset = {
        tool: "upload_text_asset",
        input: {
          name: entityName,
          content: body.source,
          mimeType: existing.mimeType,
        },
      };
    }

    if (category === "dev_view") {
      const existing = ctx!.kernel.devViews.get(entityName);
      if (!existing) {
        return c.json({ error: `Dev view "${entityName}" not found` }, 404);
      }
      if (existing.builtIn) {
        return c.json({
          error: `Cannot edit built-in dev view "${entityName}"`,
        }, 400);
      }
      toolMap.dev_view = {
        tool: "define_dev_view",
        input: {
          name: entityName,
          targetType: existing.targetType,
          title: existing.title,
          source: body.source,
        },
      };
    }

    const entry = toolMap[category];
    if (!entry) {
      return c.json({ error: `Cannot save category "${category}"` }, 400);
    }

    const result = await dispatchTool(
      entry.tool,
      entry.input,
      ctx!.kernel,
      ctx!.rebuild,
      { userMessage: "Manual edit from Code panel", manualEdit: true },
    );
    const paths = getProjectPaths(ctx!.entry.path);
    saveKernelState(ctx!.kernel, paths.stateDir);
    if (result.ok) return c.json(result.data);
    return c.json({
      error: (result.error as { message: string })?.message ?? "Save failed",
    }, 400);
  });

  // --- Package management ---

  app.get("/api/packages/unused", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const kernel = ctx!.kernel;
    const packages = kernel.runtime.listPackages?.(kernel) ?? [];
    if (packages.length === 0) return c.json({ used: [], unused: [] });
    if (!kernel.runtime.findUnusedPackages) {
      return c.json({
        error:
          `Runtime "${kernel.runtimeId}" does not support unused package analysis`,
      }, 501);
    }
    return c.json(await kernel.runtime.findUnusedPackages(kernel));
  });

  app.delete("/api/packages/:name", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const name = c.req.param("name");
    if (
      !ctx!.kernel.runtime.removePackage || !ctx!.kernel.runtime.getPackageEntry
    ) {
      return c.json({
        error: `Runtime "${
          ctx!.kernel.runtimeId
        }" does not support package removal`,
      }, 501);
    }
    const existing = ctx!.kernel.runtime.getPackageEntry(ctx!.kernel, name);
    if (!existing) return c.json({ error: `Package "${name}" not found` }, 404);
    const versionMatch = existing.specifier.match(/@([^@]+)$/);
    if (versionMatch) delete registryInfoCache[`${name}@${versionMatch[1]}`];
    ctx!.kernel.runtime.removePackage(ctx!.kernel, name);
    await ctx!.kernel.changelog.record({
      category: "package",
      key: name,
      action: "delete",
      beforeSnapshot: { name: existing.name, specifier: existing.specifier },
      afterSnapshot: null,
      context: await operatorChangeContext(ctx!.kernel),
      undoable: false,
    });
    const paths = getProjectPaths(ctx!.entry.path);
    saveKernelState(ctx!.kernel, paths.stateDir);
    saveRegistryCache();
    return c.json({ ok: true });
  });

  app.post("/api/packages/registry-info", async (c) => {
    const body = await c.req.json<{ packages: string[] }>();
    const names = body.packages ?? [];
    return c.json(await getPackageRegistryInfo(names));
  });

  app.post("/api/packages/:name/pin", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const name = c.req.param("name");
    const body = await c.req.json<{ pinned: boolean }>().catch(() => null);
    if (body?.pinned === undefined) {
      return c.json({ error: "pinned is required" }, 400);
    }
    const pinned = (ctx!.kernel.configs.get("_genie_pinned_packages") as
      | string[]
      | undefined) ?? [];
    const set = new Set(pinned);
    if (body.pinned) set.add(name);
    else set.delete(name);
    ctx!.kernel.configs.set("_genie_pinned_packages", [...set]);
    const paths = getProjectPaths(ctx!.entry.path);
    saveKernelState(ctx!.kernel, paths.stateDir);
    return c.json({ ok: true, pinnedPackages: [...set] });
  });

  app.put("/api/packages/:name", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const name = c.req.param("name");
    if (
      !ctx!.kernel.runtime.installPackage ||
      !ctx!.kernel.runtime.getPackageEntry
    ) {
      return c.json({
        error: `Runtime "${
          ctx!.kernel.runtimeId
        }" does not support package updates`,
      }, 501);
    }
    const existing = ctx!.kernel.runtime.getPackageEntry(ctx!.kernel, name);
    if (!existing) return c.json({ error: `Package "${name}" not found` }, 404);
    const body = await c.req.json<{ version: string }>();
    const version = body.version;
    if (!version) return c.json({ error: "version is required" }, 400);
    const beforeSpecifier = existing.specifier;
    const oldVersionMatch = beforeSpecifier.match(/@([^@]+)$/);
    try {
      await ctx!.kernel.runtime.installPackage(ctx!.kernel, name, version);
    } catch (err) {
      return c.json({ error: `Failed to update: ${errorMessage(err)}` }, 500);
    }
    if (oldVersionMatch) {
      delete registryInfoCache[`${name}@${oldVersionMatch[1]}`];
    }
    await ctx!.kernel.changelog.record({
      category: "package",
      key: name,
      action: "update",
      beforeSnapshot: { name, specifier: beforeSpecifier },
      afterSnapshot: { name, specifier: `npm:${name}@${version}` },
      context: await operatorChangeContext(ctx!.kernel),
      undoable: false,
    });
    const paths = getProjectPaths(ctx!.entry.path);
    saveKernelState(ctx!.kernel, paths.stateDir);
    saveRegistryCache();
    // Mirrors the install_package note in core/tools/dispatch.ts. This endpoint
    // bypasses dispatch (and its changeset gate) entirely, so the diagnostic has to be
    // stated here too — same reason the audit's RESERVED_NAME check is mirrored at both
    // entry points. Informational only, and NOT user-visible yet: the IDE's
    // `updatePackage` goes through `mutate`, which discards the response body. The
    // panel's own runtime-dependencies section already lists the colliding name, so
    // this is the machine-readable form rather than the only signal.
    const runtimeNote = runtimeDependencyNote(name);
    return c.json({
      ok: true,
      specifier: `npm:${name}@${version}`,
      ...(runtimeNote ? { note: runtimeNote } : {}),
    });
  });

  app.get("/api/export", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const includeEnvFile = c.req.query("includeEnvFile") === "true";
    const includeSeedData = c.req.query("includeSeedData") === "true";
    if (!ctx!.kernel.runtime.exportProject) {
      return c.json({
        error: `Runtime "${ctx!.kernel.runtimeId}" does not support export`,
      }, 501);
    }
    const { tarball } = await ctx!.kernel.runtime.exportProject(ctx!.kernel, {
      includeEnvFile,
      includeSeedData,
      projectName: ctx!.entry.name,
    });
    return new Response(tarball as unknown as BodyInit, {
      headers: {
        "Content-Type": "application/x-tar",
        "Content-Disposition": "attachment; filename=genie-project.tar",
      },
    });
  });

  // --- Build endpoints ---

  app.get("/api/build/version", (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    return c.json({ version: getVersion(ctx!.entry.path) });
  });

  app.post("/api/build/version/bump", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const body = await c.req.json<{ bump: "patch" | "minor" | "major" }>();
    if (!["patch", "minor", "major"].includes(body.bump)) {
      return c.json({ error: "bump must be patch, minor, or major" }, 400);
    }
    return c.json({ version: bumpVersion(ctx!.entry.path, body.bump) });
  });

  app.post("/api/build/version/set", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const body = await c.req.json<{ version: string }>();
    if (!body.version || !/^\d+\.\d+\.\d+$/.test(body.version)) {
      return c.json(
        { error: "version must be in semver format (e.g. 1.2.3)" },
        400,
      );
    }
    return c.json({ version: setVersion(ctx!.entry.path, body.version) });
  });

  function buildOptionsFromBody(
    body: Partial<BuildOptions> | null | undefined,
  ): BuildOptions {
    return {
      includeEnvFile: body?.includeEnvFile === true,
      includeSeedData: body?.includeSeedData === true,
      includeMigrations: body?.includeMigrations !== false,
      includeReferenceSeeds: body?.includeReferenceSeeds !== false,
      includeReadme: body?.includeReadme !== false,
      includeAgent: body?.includeAgent !== false,
      includeGitignore: body?.includeGitignore !== false,
      includeDocsMarkdown: body?.includeDocsMarkdown !== false,
      includeDocsSite: body?.includeDocsSite !== false,
      includeManifest: body?.includeManifest === true,
      includeDenoLock: false,
      includePackageLock: false,
    };
  }

  function buildOptionsFromQuery(c: Context): BuildOptions {
    const queryBool = (key: keyof BuildOptions) => c.req.query(key) === "true";
    const queryDefaultTrue = (key: keyof BuildOptions) =>
      c.req.query(key) !== "false";
    return {
      includeEnvFile: queryBool("includeEnvFile"),
      includeSeedData: queryBool("includeSeedData"),
      includeMigrations: queryDefaultTrue("includeMigrations"),
      includeReferenceSeeds: queryDefaultTrue("includeReferenceSeeds"),
      includeReadme: queryDefaultTrue("includeReadme"),
      includeAgent: queryDefaultTrue("includeAgent"),
      includeGitignore: queryDefaultTrue("includeGitignore"),
      includeDocsMarkdown: queryDefaultTrue("includeDocsMarkdown"),
      includeDocsSite: queryDefaultTrue("includeDocsSite"),
      includeManifest: queryBool("includeManifest"),
      includeDenoLock: false,
      includePackageLock: false,
    };
  }

  interface BuildRequestOptions {
    buildOptions: BuildOptions;
    refreshLocksBeforeBuild: boolean;
    runSmokeTest: boolean;
  }

  function buildRequestOptionsFromBody(
    body:
      | (Partial<BuildOptions> & {
        refreshLocksBeforeBuild?: boolean;
        runSmokeTest?: boolean;
      })
      | null
      | undefined,
  ): BuildRequestOptions {
    return {
      buildOptions: buildOptionsFromBody(body),
      refreshLocksBeforeBuild: body?.refreshLocksBeforeBuild === true,
      runSmokeTest: body?.runSmokeTest === true,
    };
  }

  function buildRequestOptionsFromQuery(c: Context): BuildRequestOptions {
    return {
      buildOptions: buildOptionsFromQuery(c),
      refreshLocksBeforeBuild:
        c.req.query("refreshLocksBeforeBuild") === "true",
      runSmokeTest: c.req.query("runSmokeTest") === "true",
    };
  }

  function rejectUnsafeBuildDownloadQuery(
    c: Context,
    request: BuildRequestOptions,
  ): Response | null {
    if (!request.refreshLocksBeforeBuild && !request.runSmokeTest) return null;
    return c.json({
      error:
        "Refresh locks and smoke tests require a POST build download request",
    }, 405);
  }

  function buildExtraOptions(
    buildOptions: BuildOptions,
    projectName: string,
    projectVersion: string,
  ): BuildTargetExtraOptions {
    return { buildOptions, projectName, projectVersion };
  }

  async function runRefreshLocksBeforeBuild(
    targets: readonly BuildLockTarget[],
    options: BuildTargetExtraOptions,
  ): Promise<Response | null> {
    if (!opts.buildTargetExtras?.refreshLocksBeforeBuild) {
      return new Response(
        JSON.stringify({ error: "Lock refresh is not available" }),
        {
          status: 501,
          headers: { "Content-Type": "application/json" },
        },
      );
    }
    const result = await opts.buildTargetExtras.refreshLocksBeforeBuild(
      ctx!,
      targets,
      options,
    );
    if (!result.ok) {
      return new Response(JSON.stringify({ error: result.detail }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
    return null;
  }

  async function runTargetSmokeTest(
    target: BuildTargetExtraTarget,
    options: BuildTargetExtraOptions,
  ): Promise<Response | null> {
    if (!opts.buildTargetExtras?.runSmokeTest) {
      return new Response(
        JSON.stringify({ error: "Smoke testing is not available" }),
        {
          status: 501,
          headers: { "Content-Type": "application/json" },
        },
      );
    }
    const result = await opts.buildTargetExtras.runSmokeTest(
      ctx!,
      target,
      options,
    );
    if (!result.ok) {
      return new Response(JSON.stringify({ error: result.detail }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
    return null;
  }

  app.post("/api/build/deno", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const body = await c.req.json<Partial<BuildOptions>>().catch(() => null);
    const request = buildRequestOptionsFromBody(body);
    const buildOpts = {
      ...request.buildOptions,
      includeDenoLock: request.refreshLocksBeforeBuild,
    };
    const version = getVersion(ctx!.entry.path);
    const name = ctx!.entry.name || "genie-project";
    const extraOptions = buildExtraOptions(buildOpts, name, version);
    if (request.refreshLocksBeforeBuild) {
      const refreshError = await runRefreshLocksBeforeBuild(
        ["deno-source"],
        extraOptions,
      );
      if (refreshError) return refreshError;
    }
    if (request.runSmokeTest) {
      const smokeError = await runTargetSmokeTest("deno", extraOptions);
      if (smokeError) return smokeError;
    }
    if (!ctx!.kernel.runtime.buildDenoProject) {
      return c.json({
        error: `Runtime "${ctx!.kernel.runtimeId}" does not support Deno build`,
      }, 501);
    }
    const result = await ctx!.kernel.runtime.buildDenoProject(
      ctx!.kernel,
      ctx!.entry.path,
      version,
      buildOpts,
    );
    return c.json(result);
  });

  app.post("/api/build/docker", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const body = await c.req.json<
      Partial<BuildOptions> & {
        includeCompose?: boolean;
        refreshLocksBeforeBuild?: boolean;
      }
    >().catch(() => ({
      includeCompose: false,
      includeReadme: true,
    }));
    const request = buildRequestOptionsFromBody(body);
    const buildOpts = {
      ...request.buildOptions,
      includeDenoLock: request.refreshLocksBeforeBuild,
    };
    const version = getVersion(ctx!.entry.path);
    const name = ctx!.entry.name || "genie-project";
    if (request.runSmokeTest) {
      return c.json({ error: "Docker smoke testing is not available" }, 400);
    }
    if (request.refreshLocksBeforeBuild) {
      const refreshError = await runRefreshLocksBeforeBuild(
        ["deno-source"],
        buildExtraOptions(buildOpts, name, version),
      );
      if (refreshError) return refreshError;
    }
    if (!ctx!.kernel.runtime.buildDocker) {
      return c.json({
        error: `Runtime "${
          ctx!.kernel.runtimeId
        }" does not support Docker build`,
      }, 501);
    }
    const result = await ctx!.kernel.runtime.buildDocker(
      ctx!.kernel,
      ctx!.entry.path,
      version,
      body.includeCompose ?? false,
      buildOpts,
    );
    return c.json(result);
  });

  app.get("/api/build/zip", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const version = getVersion(ctx!.entry.path);
    const name = ctx!.entry.name || "genie-project";
    const request = buildRequestOptionsFromQuery(c);
    const unsafeQuery = rejectUnsafeBuildDownloadQuery(c, request);
    if (unsafeQuery) return unsafeQuery;
    const buildOpts = {
      ...request.buildOptions,
      includeDenoLock: request.refreshLocksBeforeBuild,
    };
    if (!ctx!.kernel.runtime.buildZip) {
      return c.json({
        error: `Runtime "${ctx!.kernel.runtimeId}" does not support zip build`,
      }, 501);
    }
    const zip = await ctx!.kernel.runtime.buildZip(
      ctx!.kernel,
      name,
      version,
      buildOpts,
      ctx!.entry.path,
    );
    return new Response(zip as unknown as BodyInit, {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename=${name}-v${version}.zip`,
      },
    });
  });

  app.post("/api/build/zip", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const body = await c.req.json<Partial<BuildOptions>>().catch(() => null);
    const version = getVersion(ctx!.entry.path);
    const name = ctx!.entry.name || "genie-project";
    const request = buildRequestOptionsFromBody(body);
    const buildOpts = {
      ...request.buildOptions,
      includeDenoLock: request.refreshLocksBeforeBuild,
    };
    const extraOptions = buildExtraOptions(buildOpts, name, version);
    if (request.refreshLocksBeforeBuild) {
      const refreshError = await runRefreshLocksBeforeBuild(
        ["deno-source"],
        extraOptions,
      );
      if (refreshError) return refreshError;
    }
    if (request.runSmokeTest) {
      const smokeError = await runTargetSmokeTest("deno", extraOptions);
      if (smokeError) return smokeError;
    }
    if (!ctx!.kernel.runtime.buildZip) {
      return c.json({
        error: `Runtime "${ctx!.kernel.runtimeId}" does not support zip build`,
      }, 501);
    }
    const zip = await ctx!.kernel.runtime.buildZip(
      ctx!.kernel,
      name,
      version,
      buildOpts,
      ctx!.entry.path,
    );
    return new Response(zip as unknown as BodyInit, {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename=${name}-v${version}.zip`,
      },
    });
  });

  app.get("/api/build/docker/zip", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const version = getVersion(ctx!.entry.path);
    const name = ctx!.entry.name || "genie-project";
    const request = buildRequestOptionsFromQuery(c);
    const unsafeQuery = rejectUnsafeBuildDownloadQuery(c, request);
    if (unsafeQuery) return unsafeQuery;
    const buildOpts = {
      ...request.buildOptions,
      includeDenoLock: request.refreshLocksBeforeBuild,
    };
    const includeCompose = c.req.query("includeCompose") === "true";
    const zip = await buildDockerZip(
      ctx!.kernel,
      name,
      version,
      includeCompose,
      buildOpts,
      ctx!.entry.path,
    );
    return new Response(zip as unknown as BodyInit, {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition":
          `attachment; filename=${name}-v${version}-docker.zip`,
      },
    });
  });

  app.post("/api/build/docker/zip", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const body = await c.req.json<
      Partial<BuildOptions> & { includeCompose?: boolean }
    >().catch(() => null);
    const version = getVersion(ctx!.entry.path);
    const name = ctx!.entry.name || "genie-project";
    const request = buildRequestOptionsFromBody(body);
    const buildOpts = {
      ...request.buildOptions,
      includeDenoLock: request.refreshLocksBeforeBuild,
    };
    const includeCompose = body?.includeCompose === true;
    if (request.runSmokeTest) {
      return c.json({ error: "Docker smoke testing is not available" }, 400);
    }
    if (request.refreshLocksBeforeBuild) {
      const refreshError = await runRefreshLocksBeforeBuild(
        ["deno-source"],
        buildExtraOptions(buildOpts, name, version),
      );
      if (refreshError) return refreshError;
    }
    const zip = await buildDockerZip(
      ctx!.kernel,
      name,
      version,
      includeCompose,
      buildOpts,
      ctx!.entry.path,
    );
    return new Response(zip as unknown as BodyInit, {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition":
          `attachment; filename=${name}-v${version}-docker.zip`,
      },
    });
  });

  app.post("/api/build/node", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const body = await c.req.json<Partial<BuildOptions>>().catch(() => null);
    const request = buildRequestOptionsFromBody(body);
    const buildOpts = {
      ...request.buildOptions,
      includePackageLock: request.refreshLocksBeforeBuild,
    };
    const version = getVersion(ctx!.entry.path);
    const name = ctx!.entry.name || "genie-project";
    const extraOptions = buildExtraOptions(buildOpts, name, version);
    if (request.refreshLocksBeforeBuild) {
      const refreshError = await runRefreshLocksBeforeBuild(
        ["node"],
        extraOptions,
      );
      if (refreshError) return refreshError;
    }
    if (request.runSmokeTest) {
      const smokeError = await runTargetSmokeTest("node", extraOptions);
      if (smokeError) return smokeError;
    }
    if (!ctx!.kernel.runtime.buildNodeProject) {
      return c.json({
        error: `Runtime "${ctx!.kernel.runtimeId}" does not support Node build`,
      }, 501);
    }
    const result = await ctx!.kernel.runtime.buildNodeProject(
      ctx!.kernel,
      ctx!.entry.path,
      name,
      version,
      buildOpts,
    );
    return c.json(result);
  });

  app.get("/api/build/node/zip", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const version = getVersion(ctx!.entry.path);
    const name = ctx!.entry.name || "genie-project";
    const request = buildRequestOptionsFromQuery(c);
    const unsafeQuery = rejectUnsafeBuildDownloadQuery(c, request);
    if (unsafeQuery) return unsafeQuery;
    const buildOpts = {
      ...request.buildOptions,
      includePackageLock: request.refreshLocksBeforeBuild,
    };
    if (!ctx!.kernel.runtime.buildNodeZip) {
      return c.json({
        error: `Runtime "${
          ctx!.kernel.runtimeId
        }" does not support Node zip build`,
      }, 501);
    }
    const zip = await ctx!.kernel.runtime.buildNodeZip(
      ctx!.kernel,
      ctx!.entry.path,
      name,
      version,
      buildOpts,
    );
    return new Response(zip as unknown as BodyInit, {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition":
          `attachment; filename=${name}-v${version}-node.zip`,
      },
    });
  });

  app.post("/api/build/node/zip", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const body = await c.req.json<Partial<BuildOptions>>().catch(() => null);
    const version = getVersion(ctx!.entry.path);
    const name = ctx!.entry.name || "genie-project";
    const request = buildRequestOptionsFromBody(body);
    const buildOpts = {
      ...request.buildOptions,
      includePackageLock: request.refreshLocksBeforeBuild,
    };
    const extraOptions = buildExtraOptions(buildOpts, name, version);
    if (request.refreshLocksBeforeBuild) {
      const refreshError = await runRefreshLocksBeforeBuild(
        ["node"],
        extraOptions,
      );
      if (refreshError) return refreshError;
    }
    if (request.runSmokeTest) {
      const smokeError = await runTargetSmokeTest("node", extraOptions);
      if (smokeError) return smokeError;
    }
    if (!ctx!.kernel.runtime.buildNodeZip) {
      return c.json({
        error: `Runtime "${
          ctx!.kernel.runtimeId
        }" does not support Node zip build`,
      }, 501);
    }
    const zip = await ctx!.kernel.runtime.buildNodeZip(
      ctx!.kernel,
      ctx!.entry.path,
      name,
      version,
      buildOpts,
    );
    return new Response(zip as unknown as BodyInit, {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition":
          `attachment; filename=${name}-v${version}-node.zip`,
      },
    });
  });

  app.post("/api/build/docs/markdown", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const version = getVersion(ctx!.entry.path);
    const name = ctx!.entry.name || "genie-project";
    const result = await buildDocsMarkdown(
      ctx!.kernel,
      ctx!.entry.path,
      name,
      version,
    );
    return c.json(result);
  });

  app.post("/api/build/docs/site", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const version = getVersion(ctx!.entry.path);
    const name = ctx!.entry.name || "genie-project";
    const result = await buildDocsSite(
      ctx!.kernel,
      ctx!.entry.path,
      name,
      version,
    );
    return c.json(result);
  });

  app.post("/api/build/check", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const body = await c.req.json<Partial<BuildOptions>>().catch(() => null);
    const opts = buildOptionsFromBody(body);
    try {
      const result = await checkExportTypes(ctx!.kernel, ctx!.entry.path, opts);
      return c.json(result);
    } catch (err) {
      return c.json({
        ok: false,
        output: `Type check could not run: ${errorMessage(err)}`,
        error: errorMessage(err),
        fileCount: 0,
      }, 500);
    }
  });

  app.get("/api/build/binary/targets", (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    return c.json({
      targets: BINARY_COMPILE_TARGETS,
      defaultTarget: defaultBinaryCompileTarget(),
    });
  });

  app.post("/api/build/binary", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const body = await c.req.json<
      Partial<BuildOptions> & {
        targets?: unknown;
        refreshLocksBeforeBuild?: boolean;
        runSmokeTest?: boolean;
      }
    >().catch(() => null);
    const request = buildRequestOptionsFromBody(body);
    const buildOpts = {
      ...request.buildOptions,
      includeDenoLock: request.refreshLocksBeforeBuild,
    };
    const version = getVersion(ctx!.entry.path);
    const name = ctx!.entry.name || "genie-project";
    if (!ctx!.kernel.runtime.buildBinary) {
      return c.json({
        error: `Runtime "${
          ctx!.kernel.runtimeId
        }" does not support binary build`,
      }, 501);
    }
    const requestedTargets = Array.isArray(body?.targets) ? body.targets : null;
    if (requestedTargets !== null) {
      if (requestedTargets.length === 0) {
        return c.json({ error: "At least one binary target is required" }, 400);
      }
      const invalidTarget = requestedTargets.find((target) =>
        !isBinaryCompileTarget(target)
      );
      if (invalidTarget !== undefined) {
        return c.json({
          error: `Unsupported binary target: ${String(invalidTarget)}`,
          supportedTargets: BINARY_COMPILE_TARGETS.map((target) => target.id),
        }, 400);
      }
    }

    const targets = requestedTargets === null
      ? [undefined]
      : requestedTargets as BinaryCompileTarget[];
    if (new Set(targets).size !== targets.length) {
      return c.json({ error: "Binary targets must be unique" }, 400);
    }
    const hostTarget = defaultBinaryCompileTarget();
    const selectedTargets = targets.map((target) => target ?? hostTarget);
    const extraOptions = buildExtraOptions(buildOpts, name, version);
    if (request.runSmokeTest && !selectedTargets.includes(hostTarget)) {
      return c.json({
        error:
          `Binary smoke test can only run for the host target (${hostTarget})`,
      }, 400);
    }
    if (request.refreshLocksBeforeBuild) {
      const refreshError = await runRefreshLocksBeforeBuild(
        ["deno-source"],
        extraOptions,
      );
      if (refreshError) return refreshError;
    }
    if (request.runSmokeTest) {
      const smokeError = await runTargetSmokeTest("binary", extraOptions);
      if (smokeError) return smokeError;
    }

    const builds = await Promise.all(
      targets.map(async (target) => ({
        target,
        buildId: await ctx!.kernel.runtime.buildBinary!(
          ctx!.kernel,
          ctx!.entry.path,
          name,
          version,
          buildOpts,
          target,
          false,
        ),
      })),
    );
    const buildId = builds[0]?.buildId;
    if (requestedTargets !== null) return c.json({ builds });
    return c.json({ buildId });
  });

  app.get("/api/build/binary/:id", (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const job = getBuild(c.req.param("id"));
    if (!job) return c.json({ error: "Build not found" }, 404);
    return c.json(job);
  });

  app.get("/api/build/binary/:id/download", (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const job = getBuild(c.req.param("id"));
    if (!job || job.status !== "done" || !job.outputPath) {
      return c.json({ error: "Build not ready" }, 404);
    }
    try {
      const binary = Deno.readFileSync(job.outputPath);
      const filename = job.outputPath.split("/").pop() ?? "app";
      return new Response(binary as unknown as BodyInit, {
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Disposition": `attachment; filename=${filename}`,
        },
      });
    } catch {
      return c.json({ error: "Binary file not found" }, 404);
    }
  });

  // --- Asset serving (for inspector previews) ---

  app.get("/api/assets/:name", (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const asset = ctx!.kernel.assets.get(c.req.param("name"));
    if (!asset) return c.json({ error: "Asset not found" }, 404);
    return new Response(asset.content as unknown as BodyInit, {
      headers: { "Content-Type": asset.mimeType },
    });
  });

  // --- Project files ---

  // The browse/edit ignore lists + the text round-trip byte cap live in config.ts
  // so the file browser (here) and the source-backed editor (core/codebase/
  // source-edit.ts) agree on what is hidden, protected, and too large.
  const IGNORED_FILES = new Set<string>(PROJECT_FILE_IGNORED_FILES);
  const IGNORED_DIRS = new Set<string>(PROJECT_FILE_IGNORED_DIRS);
  const MAX_FILES = 200;

  function listProjectFiles(
    dir: string,
    root: string,
    out: Array<{ path: string; size: number }>,
    depth = 0,
  ): void {
    if (depth > 4 || out.length >= MAX_FILES) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= MAX_FILES) return;
      if (entry.name.startsWith(".") && depth === 0 && entry.isDirectory()) {
        continue;
      }
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        listProjectFiles(join(dir, entry.name), root, out, depth + 1);
      } else {
        if (IGNORED_FILES.has(entry.name)) continue;
        const fullPath = join(dir, entry.name);
        const rel = relative(root, fullPath);
        try {
          const st = statSync(fullPath);
          out.push({ path: rel, size: st.size });
        } catch { /* skip unreadable */ }
      }
    }
  }

  app.get("/api/files", (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const root = ctx!.entry.path;
    const files: Array<{ path: string; size: number }> = [];
    listProjectFiles(root, root, files);
    return c.json(files);
  });

  app.get("/api/files/*", (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const filePath = c.req.path.replace("/api/files/", "");
    const root = ctx!.entry.path;
    const resolved = resolveProjectFilePath(root, filePath);
    if (!resolved) return c.json({ error: "Invalid path" }, 400);
    try {
      const raw = readFileSync(resolved.fullPath);
      const truncated = raw.byteLength > MAX_FILE_CONTENT_BYTES;
      const content = new TextDecoder().decode(
        raw.subarray(0, MAX_FILE_CONTENT_BYTES),
      );
      return c.json({
        path: resolved.relativePath,
        content,
        truncated,
        size: raw.byteLength,
        maxBytes: MAX_FILE_CONTENT_BYTES,
      });
    } catch {
      return c.json({ error: "File not found" }, 404);
    }
  });

  // --- Source-backed file editing (project-import Slice 5) ---
  //
  // A source-backed project's code lives in on-disk files, not registry entities,
  // so edits are whole-file snapshots routed through the SAME changeset/changelog
  // rails: preview (diff, no write) → apply (write + record + re-index). Undo/redo
  // ride the existing POST /api/undo · /api/redo — applySnapshot now restores a
  // source-backed record's file bytes (core/tools/dispatch.ts). All are mode-gated:
  // a registry-native project is refused and never written. Contracts:
  // SOURCE_FILE_{PREVIEW,APPLY}_ROUTE_SCHEMA.

  // Refuses unless the loaded project is source-backed. Returns a 400 Response to
  // short-circuit, or null to proceed. A registry-native project can never be
  // written by these endpoints (edits there go through registry tools).
  const requireSourceBackedProject = (c: Context): Response | null => {
    const mode = readProjectMode(ctx!.entry.path);
    if (mode !== PROJECT_MODE_SOURCE_BACKED) {
      return c.json({
        error:
          `Source-backed file editing requires a source-backed project; this project is "${mode}".`,
      }, 400);
    }
    return null;
  };

  // Records a completed source-backed TEST run onto a changeset as self-reported
  // evidence (project import, Slice 6, deliverable 4). The evidence kind is "manual"
  // — NOT "test_result" — so it is treated as a self-reported/manual-tier item and
  // does not trip UNATTESTED_EVIDENCE in checkChangesetReadiness (a source-backed run
  // has no kernel-minted attestation/fingerprint). A failing run records failed
  // evidence so the completion gate blocks; a passing run records a manual-tier run.
  // No-op (with a note) when the command was not a test, or no changeset is active.
  const recordSourceBackedTestRun = async (
    result: CommandRunResult,
    changesetId?: string,
  ): Promise<{ recorded: boolean; changesetId?: string; note?: string }> => {
    if (result.commandKind !== "test") {
      return { recorded: false, note: "Only test-kind commands are recorded." };
    }
    const changesets = ctx!.kernel.changesets;
    if (!changesets) {
      return { recorded: false, note: "Verification is not available." };
    }
    // A project has one writer at a time (changesets.create refuses a second
    // session), so the project's active changeset is the one this belongs to.
    const target = changesetId ??
      (await changesets.getActive().catch(() => null))?.id;
    if (!target) {
      return {
        recorded: false,
        note: "No active changeset to attach evidence to.",
      };
    }

    const evidence: VerificationEvidence = {
      id: `ev_srcrun_${crypto.randomUUID()}`,
      kind: "manual",
      summary: `Source-backed test run: ${result.command} — exit ${
        result.exitCode ?? "unknown"
      }${result.timedOut ? " (timed out)" : ""}`,
      status: result.ok ? "passed" : "failed",
      data: {
        command: result.command,
        commandKind: result.commandKind,
        exitCode: result.exitCode,
        signal: result.signal,
        timedOut: result.timedOut,
        canceled: result.canceled,
        durationMs: result.durationMs,
        transcript: result.transcript,
      },
      createdAt: new Date().toISOString(),
    };
    try {
      await changesets.recordVerificationRun(target, {
        status: result.ok ? "manual" : "failed",
        summary: `Source-backed ${result.commandName} run (exit ${
          result.exitCode ?? "unknown"
        })`,
        evidence: [evidence],
        claimResults: [],
        residualRisks: [],
      });
      return { recorded: true, changesetId: target };
    } catch (err) {
      return { recorded: false, note: errorMessage(err) };
    }
  };

  // Parses the shared edit body into a SourceEditRequest, or null if malformed. The
  // one/exactly-one authoring-mode check lives in source-edit.ts (materializeAfter).
  const parseSourceEditBody = (body: unknown): SourceEditRequest | null => {
    if (!body || typeof body !== "object") return null;
    const b = body as Record<string, unknown>;
    if (typeof b.path !== "string" || b.path.trim() === "") return null;
    const req: SourceEditRequest = { path: b.path };
    if (typeof b.content === "string") req.content = b.content;
    if (b.delete === true) req.delete = true;
    if (b.anchor && typeof b.anchor === "object") {
      const a = b.anchor as Record<string, unknown>;
      if (typeof a.find === "string" && typeof a.replace === "string") {
        req.anchor = { find: a.find, replace: a.replace };
      }
    }
    if (typeof b.baseFingerprint === "string") {
      req.baseFingerprint = b.baseFingerprint;
    } else if (b.baseFingerprint === null) {
      req.baseFingerprint = null;
    }
    return req;
  };

  const parseProjectTextFileBody = (
    body: unknown,
  ): ProjectTextFileRequest | null => {
    if (!body || typeof body !== "object") return null;
    const b = body as Record<string, unknown>;
    if (typeof b.path !== "string" || b.path.trim() === "") return null;
    const req: ProjectTextFileRequest = { path: b.path };
    if (typeof b.content === "string") req.content = b.content;
    if (b.delete === true) req.delete = true;
    if (typeof b.baseFingerprint === "string") {
      req.baseFingerprint = b.baseFingerprint;
    } else if (b.baseFingerprint === null) {
      req.baseFingerprint = null;
    } else if ("baseFingerprint" in b) {
      return null;
    }
    return req;
  };

  app.post("/api/files/preview", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const gate = requireSourceBackedProject(c);
    if (gate) return gate;
    const body = await c.req.json().catch(() => null);
    const req = parseSourceEditBody(body);
    if (!req) return c.json({ error: "A string `path` is required." }, 400);
    const staged = stageSourceEdit(ctx!.entry.path, req);
    if (!staged.ok) return c.json({ error: staged.error.message }, 400);
    return c.json(staged.data);
  });

  app.post("/api/project-files/preview", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const body = await c.req.json().catch(() => null);
    const req = parseProjectTextFileBody(body);
    if (!req) return c.json({ error: "A string `path` is required." }, 400);
    const staged = stageProjectTextFile(ctx!.entry.path, req);
    if (!staged.ok) return c.json({ error: staged.error.message }, 400);
    return c.json(staged.data);
  });

  app.post("/api/project-files/apply", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const body = await c.req.json().catch(() => null);
    const req = parseProjectTextFileBody(body);
    if (!req) return c.json({ error: "A string `path` is required." }, 400);

    const committed = commitProjectTextFile(ctx!.entry.path, req);
    if (!committed.ok) {
      const status = committed.error.code === "PATCH_CONFLICT" ? 409 : 400;
      return c.json({ error: committed.error.message }, status);
    }
    const edit = committed.data;

    // A project has one writer at a time (changesets.create refuses a second
    // session), so the project's active changeset is the one this belongs to.
    const active = await ctx!.kernel.changesets.getActive().catch(() => null);
    const bodyObj = body && typeof body === "object"
      ? body as Record<string, unknown>
      : {};
    const userMessage =
      typeof bodyObj.userMessage === "string" && bodyObj.userMessage.trim()
        ? bodyObj.userMessage
        : "Project file edit";
    const record = await ctx!.kernel.changelog.record({
      category: SOURCE_EDIT_CHANGE_CATEGORY,
      key: edit.key,
      action: edit.action,
      beforeSnapshot: edit.before,
      afterSnapshot: edit.after,
      context: {
        authorOrigin: "human",
        manualEdit: true,
        sourceBacked: true,
        projectFile: true,
        userMessage,
        ...(active?.id ? { changesetId: active.id } : {}),
      },
    });

    const summary =
      readProjectMode(ctx!.entry.path) === PROJECT_MODE_SOURCE_BACKED
        ? await reindexSourceBackedCodebase(ctx!.kernel)
        : null;
    return c.json({ change: record, file: edit, summary });
  });

  app.post("/api/files/apply", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const gate = requireSourceBackedProject(c);
    if (gate) return gate;
    const body = await c.req.json().catch(() => null);
    const req = parseSourceEditBody(body);
    if (!req) return c.json({ error: "A string `path` is required." }, 400);

    const committed = commitSourceEdit(ctx!.entry.path, req);
    if (!committed.ok) {
      const status = committed.error.code === "PATCH_CONFLICT" ? 409 : 400;
      return c.json({ error: committed.error.message }, status);
    }
    const edit = committed.data;

    // Ride the changeset workflow: attach the active changeset (if any) so the edit
    // groups into its history and undo/redo, exactly like a registry entity write.
    // One writer per project, so the project's active changeset is the right one.
    const active = await ctx!.kernel.changesets.getActive().catch(() => null);
    const bodyObj = body && typeof body === "object"
      ? body as Record<string, unknown>
      : {};
    const userMessage =
      typeof bodyObj.userMessage === "string" && bodyObj.userMessage.trim()
        ? bodyObj.userMessage
        : "Source-backed file edit";
    const record = await ctx!.kernel.changelog.record({
      category: SOURCE_EDIT_CHANGE_CATEGORY,
      key: edit.key,
      action: edit.action,
      beforeSnapshot: edit.before,
      afterSnapshot: edit.after,
      context: {
        authorOrigin: "human",
        manualEdit: true,
        sourceBacked: true,
        userMessage,
        ...(active?.id ? { changesetId: active.id } : {}),
      },
    });

    // Re-index so GET /api/codebase + the framework overlay reflect the new source.
    const summary = await reindexSourceBackedCodebase(ctx!.kernel);
    return c.json({ change: record, summary });
  });

  // --- Source-backed project commands + related tests (project import, Slice 6) ---
  // Surfaces the imported project's own discovered commands (from graph.commands)
  // as runnable — streamed, cancellable, no orphaned descendants — and selects the
  // tests related to a changed file/entity from the graph edges. All mode-gated:
  // a registry-native project is refused and never runs a command. Control endpoints
  // only (no new agent tool), so the 128-tool budget + MCP surface are untouched.
  // Contracts: COMMANDS_{LIST,RUN,CANCEL,STATUS}_ROUTE_SCHEMA, TESTS_RELATED_ROUTE_SCHEMA.

  // The runnable commands the graph knows about (empty until a first index). Gated
  // on source-backed so the surface only appears for imported projects.
  app.get("/api/commands", (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const gate = requireSourceBackedProject(c);
    if (gate) return gate;
    const commands: ProjectCommand[] = ctx!.kernel.codebaseGraph?.commands ??
      [];
    return c.json({ commands, running: ctx!.commandRunner.status() });
  });

  app.get("/api/commands/status", (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const gate = requireSourceBackedProject(c);
    if (gate) return gate;
    return c.json(ctx!.commandRunner.status());
  });

  app.post("/api/commands/run", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const gate = requireSourceBackedProject(c);
    if (gate) return gate;
    const body = await c.req.json<
      {
        kind?: string;
        id?: string;
        recordVerification?: boolean;
        changesetId?: string;
      }
    >().catch(() => ({} as Record<string, never>));
    const selector: CommandSelector = {
      ...(typeof body.id === "string" ? { id: body.id } : {}),
      ...(typeof body.kind === "string"
        ? { kind: body.kind as ProjectCommand["commandKind"] }
        : {}),
    };
    if (!selector.id && !selector.kind) {
      return c.json({ error: "A command `kind` or `id` is required." }, 400);
    }

    const run = await ctx!.commandRunner.run(selector);
    if (!run.ok) {
      // A busy runner is a conflict; everything else (mode/graph/unknown) is a 400.
      const status = run.error.code === "COMMAND_ALREADY_RUNNING" ? 409 : 400;
      return c.json({ error: run.error.message }, status);
    }
    const result = run.data;

    // Optionally close the verification loop for a source-backed edit: attach a test
    // run to the active (or named) changeset as a self-reported (manual-tier) evidence
    // item — NOT a grounded attestation, since a source-backed run has no kernel-minted
    // entity fingerprint (see checkChangesetReadiness / GROUNDED_EVIDENCE_KINDS).
    let verification: {
      recorded: boolean;
      changesetId?: string;
      note?: string;
    } = {
      recorded: false,
    };
    if (body.recordVerification === true) {
      verification = await recordSourceBackedTestRun(
        result,
        typeof body.changesetId === "string" ? body.changesetId : undefined,
      );
    }
    return c.json({ result, verification });
  });

  app.post("/api/commands/cancel", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const gate = requireSourceBackedProject(c);
    if (gate) return gate;
    const canceled = await ctx!.commandRunner.cancel();
    if (!canceled.ok) return c.json({ error: canceled.error.message }, 500);
    return c.json(canceled.data);
  });

  // Select the tests related to a changed file path (a source-backed ChangeRecord
  // key) or graph node id, from the cached graph's tested-by edges + test targets.
  app.get("/api/tests/related", (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const gate = requireSourceBackedProject(c);
    if (gate) return gate;
    const path = c.req.query("path");
    if (!path || path.trim() === "") {
      return c.json({ error: "A `path` query parameter is required." }, 400);
    }
    const graph = ctx!.kernel.codebaseGraph;
    if (!graph) {
      return c.json({ error: "The project has not been indexed yet." }, 400);
    }
    return c.json(selectRelatedTests(graph, path));
  });

  app.get("/api/artifacts/screenshots/:name", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const name = c.req.param("name");
    const fullPath = resolveScreenshotArtifactPath(ctx!.entry.path, name);
    if (!fullPath) return c.text("Not found", 404);
    if (!await staticFileExists(fullPath)) return c.text("Not found", 404);
    return serveStaticFile(c, fullPath);
  });

  // --- API Keys (per-provider, stored in ~/.config/opentide/config.json) ---

  // Narrow a `:provider` path param to a known ModelProviderId, or null (→ 400).
  const parseProviderParam = (raw: string): ModelProviderId | null =>
    isKnownProviderId(raw) ? (raw as ModelProviderId) : null;

  // Shared post-write side effects for a key change (set OR clear), identical to the
  // pre-Stage-6 Anthropic-only endpoint: re-run discovery, then rebuild the chat
  // context (or lazily init it on a first set) and notify the user. `verb` reads into
  // the system_message notice ("changed" / "was removed").
  const afterProviderKeyChange = async (
    providerId: ModelProviderId,
    verb: string,
  ) => {
    refreshAvailableModels();
    if (chat) {
      await chat.reloadApiKey();
      sendToChat({
        type: "system_message",
        text:
          `Agent context was rebuilt because the ${providerId} API key ${verb}. Recent conversation was reloaded from local history.`,
      });
    } else if (ctx) {
      try {
        await initChat();
      } catch (err) {
        console.log(`  AI agent failed to initialize: ${errorMessage(err)}`);
      }
    }
  };

  const providerKeyStatusResponse = (providerId: ModelProviderId) => {
    const status = getProviderKeyStatuses().find((s) => s.id === providerId);
    return { set: status?.set ?? false, display: status?.display ?? null };
  };

  // One key row per provider (drives the settings UI without hardcoding the list).
  app.get("/api/config/providers", (c) => {
    return c.json({ providers: getProviderKeyStatuses() });
  });

  app.get("/api/config/api-key/:provider", (c) => {
    const providerId = parseProviderParam(c.req.param("provider"));
    if (!providerId) return c.json({ error: "unknown provider" }, 400);
    return c.json(providerKeyStatusResponse(providerId));
  });

  app.put("/api/config/api-key/:provider", async (c) => {
    const providerId = parseProviderParam(c.req.param("provider"));
    if (!providerId) return c.json({ error: "unknown provider" }, 400);
    const body = await c.req.json<{ key: string }>().catch(() => null);
    if (!body?.key?.trim()) return c.json({ error: "key is required" }, 400);
    setProviderKey(providerId, body.key.trim());
    await afterProviderKeyChange(providerId, "changed");
    return c.json({ set: true, display: obfuscateKey(body.key.trim()) });
  });

  app.delete("/api/config/api-key/:provider", async (c) => {
    const providerId = parseProviderParam(c.req.param("provider"));
    if (!providerId) return c.json({ error: "unknown provider" }, 400);
    clearProviderKey(providerId);
    await afterProviderKeyChange(providerId, "was removed");
    return c.json({ set: false, display: null });
  });

  // Legacy Anthropic-only endpoint — kept as a deprecated alias so pre-Stage-6
  // clients keep working; delegates to the per-provider path with "anthropic".
  const legacyAnthropic: ModelProviderId = "anthropic";

  app.get("/api/config/api-key", (c) => {
    return c.json(providerKeyStatusResponse(legacyAnthropic));
  });

  app.put("/api/config/api-key", async (c) => {
    const body = await c.req.json<{ key: string }>().catch(() => null);
    if (!body?.key?.trim()) return c.json({ error: "key is required" }, 400);
    setProviderKey(legacyAnthropic, body.key.trim());
    await afterProviderKeyChange(legacyAnthropic, "changed");
    return c.json({ set: true, display: obfuscateKey(body.key.trim()) });
  });

  app.delete("/api/config/api-key", async (c) => {
    clearProviderKey(legacyAnthropic);
    await afterProviderKeyChange(legacyAnthropic, "was removed");
    return c.json({ set: false, display: null });
  });

  // --- OpenAI base URL (route the openai provider at any compatible endpoint) ---
  //
  // A base-URL change reroutes chat + utility + discovery, so it runs the same
  // afterProviderKeyChange side effects as a key change ("openai": re-discover, reload
  // the chat client). Accepts only an http(s) URL; empty/absent clears back to default.
  const openaiProvider: ModelProviderId = "openai";
  const isHttpUrl = (raw: string): boolean => {
    try {
      const parsed = new URL(raw);
      return parsed.protocol === "http:" || parsed.protocol === "https:";
    } catch {
      return false;
    }
  };

  app.get("/api/config/openai-base-url", (c) => {
    return c.json({ baseUrl: getOpenaiBaseUrl() ?? null });
  });

  app.put("/api/config/openai-base-url", async (c) => {
    const body = await c.req.json<{ baseUrl: string }>().catch(() => null);
    const baseUrl = body?.baseUrl?.trim();
    if (!baseUrl || !isHttpUrl(baseUrl)) {
      return c.json({ error: "invalid base URL" }, 400);
    }
    setOpenaiBaseUrl(baseUrl);
    await afterProviderKeyChange(openaiProvider, "changed");
    return c.json({ baseUrl });
  });

  app.delete("/api/config/openai-base-url", async (c) => {
    clearOpenaiBaseUrl();
    await afterProviderKeyChange(openaiProvider, "changed");
    return c.json({ baseUrl: null });
  });

  // --- Model Configuration ---

  // The shared shape returned by every models endpoint (GET / refresh / recommend):
  // `roles.*` is the raw stored selection ("default" → follows recommended, or an
  // explicit pin); `resolved.*` is the concrete model each role runs on right now —
  // or MODEL_UNCONFIGURED_LABEL when the role is unconfigured (D9: keyless / empty
  // catalog / no recommendation), so the shape stays stable rather than dropping the
  // key; `recommended.*` is what a "default" role points at (a partial map, D9).
  // Back-compat fields (agentModel/codeModel) keep pre-G1 clients working.
  const modelsResponseBody = () => ({
    available: getAvailableModels(),
    roles: {
      agent: getAgentModel(),
      planning: getPlanningModel(),
      import: getImportModel(),
      utility: getUtilityModel(),
      verification: getVerificationModel(),
    },
    resolved: {
      agent: getAgentModelForRequest() ?? MODEL_UNCONFIGURED_LABEL,
      planning: getPlanningModelForRequest() ?? MODEL_UNCONFIGURED_LABEL,
      import: getImportModelForRequest() ?? MODEL_UNCONFIGURED_LABEL,
      utility: getUtilityModelForRequest() ?? MODEL_UNCONFIGURED_LABEL,
      verification: getVerificationModelForRequest() ??
        MODEL_UNCONFIGURED_LABEL,
    },
    recommended: getRecommendedModels(),
    agentModel: getAgentModel(),
    codeModel: getUtilityModel(),
    defaults: { agent: DEFAULT_AGENT_MODEL, code: DEFAULT_CODE_MODEL },
    // How fresh the prices in `available[].pricing` are. PRICING_VERIFIED_AS_OF is
    // the GLOBAL fallback (seed tiers never agent-verified). Per-tier provenance
    // from the D10 verification gate (agent-written tiers) is preferred where present
    // — pricingProvenance carries sourceUrl/extractedAt/model/agreement per tier.
    pricingVerifiedAsOf: PRICING_VERIFIED_AS_OF,
    pricingProvenance: getPricingProvenance(),
  });

  function logPricingRefreshReport(report: PricingRefreshReport): void {
    if (!ctx) return;
    const counts = {
      updated: report.updated.length,
      unchanged: report.unchanged.length,
      missing: report.missing.length,
      rejected: report.rejected.length,
      errors: report.errors.length,
      written: report.written.length,
    };
    const level = counts.errors > 0
      ? "error"
      : counts.missing > 0 || counts.rejected > 0
      ? "warn"
      : "info";
    const provider = report.provider ? ` for ${report.provider}` : "";
    const message = counts.errors > 0
      ? `Pricing check failed${provider}: ${counts.errors} error${
        counts.errors === 1 ? "" : "s"
      }`
      : `Pricing check completed${provider}: ${counts.updated} update${
        counts.updated === 1 ? "" : "s"
      }, ${counts.unchanged} unchanged, ${counts.missing} missing, ${counts.rejected} rejected`;
    ctx.kernel.log.log(level, "system", message, {
      metadata: {
        pricing: true,
        reportOnly: !report.apply,
        applied: report.applied,
        provider: report.provider ?? null,
        sourceUrl: report.sourceUrl ?? null,
        extractedAt: report.extractedAt ?? null,
        counts,
        errors: report.errors,
        missing: report.missing,
        rejected: report.rejected,
        updated: report.updated,
        unchanged: report.unchanged,
        written: report.written,
        gate: report.gate ?? null,
      },
    });
  }

  // The model roles (Feature G).
  app.get("/api/config/models", (c) => {
    return c.json(modelsResponseBody());
  });

  app.get("/api/config/models/pricing/status", (c) => {
    return c.json(getPricingStatusReport());
  });

  app.post("/api/config/models/pricing/refresh", async (c) => {
    const body: {
      provider?: ModelProviderId;
      apply?: boolean;
    } = await c.req.json<{
      provider?: ModelProviderId;
      apply?: boolean;
    }>().catch(() => ({}));
    const provider = body.provider;
    if (provider !== undefined && !isKnownProviderId(provider)) {
      return c.json({ error: "Invalid provider" }, 400);
    }
    try {
      const result = await refreshPricingReport({
        provider,
        apply: body.apply === true,
        recordUsage: ctx
          ? (input) => ctx!.kernel.sessions.recordModelUsage(input)
          : undefined,
      });
      if (!result.ok) {
        return c.json({ error: result.error.message }, 500);
      }
      logPricingRefreshReport(result.data);
      return c.json(result.data);
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : String(err) },
        500,
      );
    }
  });

  app.put("/api/config/models", async (c) => {
    const body = await c.req.json<{
      agentModel?: string;
      planningModel?: string;
      importModel?: string;
      utilityModel?: string;
      verificationModel?: string;
      codeModel?: string;
    }>()
      .catch(() => null);
    if (!body) return c.json({ error: "Invalid body" }, 400);
    if (body.agentModel) setAgentModel(body.agentModel);
    if (body.planningModel) setPlanningModel(body.planningModel);
    if (body.importModel) setImportModel(body.importModel);
    // `codeModel` is the deprecated alias for the utility role; an explicit
    // `utilityModel` wins if both are sent.
    if (body.codeModel) setUtilityModel(body.codeModel);
    if (body.utilityModel) setUtilityModel(body.utilityModel);
    if (body.verificationModel) setVerificationModel(body.verificationModel);
    if (chat) {
      await chat.reloadModel();
      if (body.agentModel) {
        sendToChat({
          type: "system_message",
          text:
            "Agent context was rebuilt because the agent model changed. Recent conversation was reloaded from local history.",
        });
      }
    }
    return c.json({
      roles: {
        agent: getAgentModel(),
        planning: getPlanningModel(),
        import: getImportModel(),
        utility: getUtilityModel(),
        verification: getVerificationModel(),
      },
    });
  });

  // Re-fetch the live model catalog (Models API → models-cache.json) and return
  // the same body as GET so the picker can repopulate without a page reload.
  // `refreshAvailableModels()` is a no-op (returns the cached list) without an API key.
  app.post("/api/config/models/refresh", async (c) => {
    try {
      await refreshAvailableModels();
      return c.json(modelsResponseBody());
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : String(err) },
        500,
      );
    }
  });

  // Run the deterministic recommend engine over the live catalog and persist the
  // picks (Feature G, G3). setRecommendedModels writes ONLY the recommendedModels
  // map, so the new recommendation flows to every role on "default" and never
  // touches an explicit pin (the G5 structural guarantee). If the agent role is on
  // "default" and its resolved model actually changed, rebuild the chat context —
  // matching the PUT's reload/system_message behavior rather than inventing new
  // semantics. Deterministic-only: the optional agent-assisted refinement (G3) is a
  // closed-brain concern and is deferred behind this seam (see model-recommend.ts).
  app.post("/api/config/models/recommend", async (c) => {
    try {
      const beforeAgentModel = getAgentModelForRequest();
      setRecommendedModels(recommendModelsFromCatalog(getAvailableModels()));
      const agentModelChanged = getAgentModelForRequest() !== beforeAgentModel;
      if (chat && agentModelChanged) {
        await chat.reloadModel();
        sendToChat({
          type: "system_message",
          text:
            "Agent context was rebuilt because the recommended agent model changed. Recent conversation was reloaded from local history.",
        });
      }
      return c.json(modelsResponseBody());
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : String(err) },
        500,
      );
    }
  });

  app.get("/api/config/kernel", (_c) => {
    return _c.json(getKernelSettings());
  });

  app.put("/api/config/kernel", async (c) => {
    const body = await c.req.json<KernelSettings>().catch(() => null);
    if (!body) return c.json({ error: "Invalid body" }, 400);
    setKernelSettings(body);
    return c.json(getKernelSettings());
  });

  // --- Feedback & Telemetry ---

  app.get("/api/config/telemetry", (c) => {
    // currentConsentVersion is the version the first-run modal must compare the
    // user's stored consentVersion against (a runtime constant the type-only shared
    // wire contract can't carry, so it rides the response instead).
    return c.json({
      ...getTelemetrySettings(),
      currentConsentVersion: CONSENT_VERSION,
    });
  });

  app.put("/api/config/telemetry", async (c) => {
    const body = await c.req.json<TelemetrySettings>().catch(() => null);
    if (!body) return c.json({ error: "Invalid body" }, 400);
    return c.json(setTelemetrySettings(body));
  });

  app.post("/api/telemetry/events", async (c) => {
    const body = await c.req.json().catch(() => null);
    const inputs = Array.isArray(body?.events)
      ? body.events
      : Array.isArray(body)
      ? body
      : body
      ? [body]
      : [];
    if (inputs.length === 0) {
      return c.json({ error: "No telemetry events provided" }, 400);
    }

    const accepted: string[] = [];
    for (const input of inputs) {
      if (!isRecord(input)) continue;
      const eventName = typeof input.event_name === "string"
        ? input.event_name
        : typeof input.eventName === "string"
        ? input.eventName
        : null;
      if (!eventName) continue;
      const properties = isRecord(input.properties) ? input.properties : {};
      try {
        const event = telemetry.track(eventName, properties);
        accepted.push(event.event_id);
      } catch {
        // Invalid event names are ignored rather than breaking UI flows.
      }
    }
    maybeSyncTelemetry();
    return c.json({ ok: true, accepted_event_ids: accepted });
  });

  app.post("/api/feedback", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!isRecord(body)) return c.json({ error: "Invalid body" }, 400);
    try {
      const report = await telemetry.submitFeedback({
        kind: body.kind,
        severity: body.severity,
        message: body.message,
        contactEmail: body.contactEmail ?? body.contact_email,
        includeDiagnostics: body.includeDiagnostics ??
          body.include_diagnostics,
        currentPanel: body.currentPanel ?? body.current_panel,
        currentRoute: body.currentRoute ?? body.current_route,
      });
      maybeSyncTelemetry();
      return c.json({ ok: true, feedback_id: report.feedback_id });
    } catch (err) {
      return c.json({ error: errorMessage(err) }, 400);
    }
  });

  app.get("/api/telemetry/status", (c) => {
    return c.json(telemetry.getStatus());
  });

  app.post("/api/telemetry/sync", async (c) => {
    return c.json(await telemetry.sync());
  });

  // --- Metrics (Stream C) ---

  // Entity Survival Rate: the read-only surface over A4's source-free survival log.
  // Returns an honest empty (null-rate) metric — never a 500 — when no project is open
  // or the episode log is off/empty, so the IDE can render a "not enough data" state.
  app.get("/api/metrics/survival", (c) => {
    const observations = ctx?.kernel.episodeLog?.readObservations() ?? [];
    return c.json(entitySurvivalRate(observations, Date.now()));
  });

  // --- Task forks (docs/opentide-task-forks-plan.md) ---
  // Contracts in the TASKS_*_ROUTE_SCHEMA consts above.

  function taskFailure(
    c: { json: (body: unknown, status?: number) => Response },
    error: { code: string; message: string; suggestion?: string },
  ) {
    return c.json(
      {
        error: error.message,
        code: error.code,
        ...(error.suggestion ? { suggestion: error.suggestion } : {}),
      },
      TASK_ERROR_STATUS[error.code] ?? 400,
    );
  }

  app.get("/api/tasks", (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const result = listTasks(ctx!.kernel);
    return result.ok ? c.json(result.data) : taskFailure(c, result.error);
  });

  app.post("/api/tasks", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    type CreateBody = { title?: unknown; claims?: unknown; serve?: unknown };
    const body = await c.req.json<CreateBody>().catch(() => ({} as CreateBody));
    if (typeof body.title !== "string") {
      return c.json({ error: "title must be a string" }, 400);
    }
    if (!isStringArray(body.claims ?? [])) {
      return c.json({ error: "claims must be an array of strings" }, 400);
    }
    if (body.serve !== undefined && typeof body.serve !== "boolean") {
      return c.json({ error: "serve must be a boolean" }, 400);
    }
    const started = await startTask(
      ctx!.kernel,
      { title: body.title, claims: (body.claims ?? []) as string[] },
      { serve: body.serve !== false },
    );
    return started.ok
      ? c.json(started.data, 201)
      : taskFailure(c, started.error);
  });

  app.patch("/api/tasks/:id", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const body = await c.req.json<{ claims?: unknown }>()
      .catch(() => ({} as { claims?: unknown }));
    if (!isStringArray(body.claims)) {
      return c.json({ error: "claims must be an array of strings" }, 400);
    }
    const result = updateTaskClaims(
      ctx!.kernel,
      c.req.param("id"),
      body.claims,
    );
    return result.ok ? c.json(result.data) : taskFailure(c, result.error);
  });

  app.delete("/api/tasks/:id", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const result = await discardTaskFork(ctx!.kernel, c.req.param("id"));
    return result.ok ? c.json(result.data) : taskFailure(c, result.error);
  });

  app.get("/api/tasks/:id/diff", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const result = await diffTask(ctx!.kernel, c.req.param("id"));
    return result.ok ? c.json(result.data) : taskFailure(c, result.error);
  });

  app.post("/api/tasks/:id/merge", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const result = await mergeTask(
      ctx!.kernel,
      c.req.param("id"),
      ctx!.rebuild,
    );
    return result.ok ? c.json(result.data) : taskFailure(c, result.error);
  });

  // A task diff in main's serve asks the fork's serve for this before reading
  // the fork's state off disk.
  app.post(STATE_FLUSH_PATH, (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    flushCurrentProjectState();
    return c.json({ ok: true });
  });

  // --- Environment Variables ---

  app.get("/api/env", (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    return c.json(ctx!.kernel.env.list());
  });

  app.put("/api/env/:name", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const name = c.req.param("name");
    const body = await c.req.json<{ value: string }>();
    const existed = ctx!.kernel.env.get(name) !== undefined;
    ctx!.kernel.env.set(name, body.value);
    await recordDotEnvChange(ctx!.kernel, name, existed ? "update" : "create");
    return c.json({ message: `Environment variable "${name}" set.` });
  });

  app.delete("/api/env/:name", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const name = c.req.param("name");
    if (!ctx!.kernel.env.delete(name)) {
      return c.json({ error: `"${name}" not found.` }, 404);
    }
    await recordDotEnvChange(ctx!.kernel, name, "delete");
    return c.json({ message: `Environment variable "${name}" deleted.` });
  });

  // --- Env Vars ---

  app.get("/api/env-vars", (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    return c.json(ctx!.kernel.envVars.listEnriched());
  });

  app.post("/api/env-vars", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const body = await c.req.json<
      { key: string; value?: string; description?: string }
    >().catch(() => null);
    if (!body?.key?.trim()) return c.json({ error: "key is required" }, 400);
    const key = body.key.trim();
    const existing = ctx!.kernel.envVars.get(key);
    const before = existing
      ? {
        key: existing.key,
        value: existing.value,
        description: existing.description,
      }
      : null;
    const entry = ctx!.kernel.envVars.define(
      key,
      body.value,
      body.description?.trim(),
    );
    await ctx!.kernel.changelog.record({
      category: "env_var",
      key,
      action: before ? "update" : "create",
      beforeSnapshot: before,
      afterSnapshot: {
        key,
        value: entry.value,
        description: entry.description,
      },
      context: await operatorChangeContext(ctx!.kernel),
    });
    return c.json(entry, 201);
  });

  app.put("/api/env-vars/:key", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const key = c.req.param("key");
    const body = await c.req.json<{ value?: string; description?: string }>()
      .catch(() => null);
    if (!body) return c.json({ error: "Request body required" }, 400);
    const existing = ctx!.kernel.envVars.get(key);
    if (!existing) return c.json({ error: `Env var "${key}" not found` }, 404);
    const before = {
      key,
      value: existing.value,
      description: existing.description,
    };
    if (body.description !== undefined) {
      ctx!.kernel.envVars.define(key, undefined, body.description);
    }
    if (body.value !== undefined) {
      if (body.value === "") {
        ctx!.kernel.envVars.clearValue(key);
      } else {
        ctx!.kernel.envVars.setValue(key, body.value);
      }
    }
    const updated = ctx!.kernel.envVars.get(key);
    await ctx!.kernel.changelog.record({
      category: "env_var",
      key,
      action: "update",
      beforeSnapshot: before,
      afterSnapshot: {
        key,
        value: updated?.value ?? null,
        description: updated?.description,
      },
      context: await operatorChangeContext(ctx!.kernel),
    });
    return c.json({
      key,
      status: ctx!.kernel.envVars.status(key),
      message: `Env var "${key}" updated.`,
    });
  });

  app.delete("/api/env-vars/:key", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const key = c.req.param("key");
    const existing = ctx!.kernel.envVars.get(key);
    if (!existing) return c.json({ error: `Env var "${key}" not found` }, 404);
    ctx!.kernel.envVars.remove(key);
    await ctx!.kernel.changelog.record({
      category: "env_var",
      key,
      action: "delete",
      beforeSnapshot: {
        key: existing.key,
        value: existing.value,
        description: existing.description,
      },
      afterSnapshot: null,
      context: await operatorChangeContext(ctx!.kernel),
    });
    return c.json({ message: `Env var "${key}" deleted.` });
  });

  // --- App Configs ---

  app.get("/api/configs", (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    return c.json(ctx!.kernel.configs.serialize());
  });

  app.put("/api/configs/:name", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const name = c.req.param("name");
    const body = await c.req.json() as {
      value: unknown;
      description?: string;
      module?: string;
    };
    const kernel = ctx!.kernel;
    const existing = kernel.configs.getEntry(name);
    const before = existing
      ? {
        name: existing.name,
        value: existing.value,
        description: existing.description,
      }
      : null;

    try {
      kernel.configs.set(name, body.value, body.description, body.module);
    } catch (err) {
      return c.json({ error: errorMessage(err) }, 400);
    }

    await kernel.changelog.record({
      category: "config",
      key: name,
      action: before ? "update" : "create",
      beforeSnapshot: before,
      afterSnapshot: { name, value: body.value, description: body.description },
      context: await operatorChangeContext(ctx!.kernel),
    });
    const putPaths = getProjectPaths(ctx!.entry.path);
    saveKernelState(ctx!.kernel, putPaths.stateDir);
    return c.json({
      message: `Config "${name}" ${before ? "updated" : "created"}.`,
    });
  });

  app.delete("/api/configs/:name", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const name = c.req.param("name");
    const kernel = ctx!.kernel;
    const existing = kernel.configs.getEntry(name);
    if (!existing) return c.json({ error: `Config "${name}" not found` }, 404);

    kernel.configs.delete(name);

    await kernel.changelog.record({
      category: "config",
      key: name,
      action: "delete",
      beforeSnapshot: {
        name: existing.name,
        value: existing.value,
        description: existing.description,
      },
      afterSnapshot: null,
      context: await operatorChangeContext(ctx!.kernel),
    });
    const delPaths = getProjectPaths(ctx!.entry.path);
    saveKernelState(ctx!.kernel, delPaths.stateDir);
    return c.json({ message: `Config "${name}" deleted.` });
  });

  // --- Secrets ---

  app.get("/api/secrets", (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    return c.json(
      ctx!.kernel.secrets.list().map((s) => ({
        key: s.key,
        description: s.description,
        hasValue: s.value !== undefined,
        resolvedValue: undefined,
        status: ctx!.kernel.secrets.status(s.key),
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
      })),
    );
  });

  app.post("/api/secrets", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const body = await c.req.json<{ key: string; description?: string }>()
      .catch(() => null);
    if (!body?.key?.trim()) return c.json({ error: "key is required" }, 400);
    const key = body.key.trim();
    const existing = ctx!.kernel.secrets.get(key);
    const before = existing
      ? { key: existing.key, description: existing.description }
      : null;
    const entry = ctx!.kernel.secrets.define(key, body.description?.trim());
    await ctx!.kernel.changelog.record({
      category: "secret",
      key,
      action: before ? "update" : "create",
      beforeSnapshot: before,
      afterSnapshot: { key, description: entry.description },
      context: await operatorChangeContext(ctx!.kernel),
    });
    const { value: _v, ...safe } = entry;
    return c.json(safe, 201);
  });

  app.put("/api/secrets/:key", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const key = c.req.param("key");
    const body = await c.req.json<{ value?: string; description?: string }>()
      .catch(() => null);
    if (!body) return c.json({ error: "Request body required" }, 400);
    const existing = ctx!.kernel.secrets.get(key);
    if (!existing) return c.json({ error: `Secret "${key}" not found` }, 404);
    const before = {
      key,
      hasValue: existing.value !== undefined,
      description: existing.description,
    };
    if (body.description !== undefined) {
      ctx!.kernel.secrets.define(key, body.description);
    }
    if (body.value !== undefined) {
      if (body.value === "") {
        ctx!.kernel.secrets.clearValue(key);
      } else {
        ctx!.kernel.secrets.setValue(key, body.value);
      }
    }
    const updated = ctx!.kernel.secrets.get(key);
    await ctx!.kernel.changelog.record({
      category: "secret",
      key,
      action: "update",
      beforeSnapshot: before,
      afterSnapshot: {
        key,
        hasValue: updated?.value !== undefined,
        description: updated?.description,
      },
      context: await operatorChangeContext(ctx!.kernel),
    });
    return c.json({
      key,
      status: ctx!.kernel.secrets.status(key),
      message: `Secret "${key}" updated.`,
    });
  });

  app.delete("/api/secrets/:key", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const key = c.req.param("key");
    const existing = ctx!.kernel.secrets.get(key);
    if (!existing) return c.json({ error: `Secret "${key}" not found` }, 404);
    ctx!.kernel.secrets.remove(key);
    await ctx!.kernel.changelog.record({
      category: "secret",
      key,
      action: "delete",
      beforeSnapshot: { key: existing.key, description: existing.description },
      afterSnapshot: null,
      context: await operatorChangeContext(ctx!.kernel),
    });
    return c.json({ message: `Secret "${key}" deleted.` });
  });

  // --- MCP Servers ---

  app.get("/api/mcp-servers", (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const servers = getMcpServers();
    return c.json(servers.map((s) => ({
      ...s,
      ...mcpManager.getStatus(s.name),
    })));
  });

  app.post("/api/mcp-servers", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const body = await readJsonObject(c);
    if (body instanceof Response) return body;
    const parsed = parseMcpServerConfigInput(body);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);

    const servers = getMcpServers();
    if (servers.some((s) => s.name === parsed.config.name)) {
      return c.json(
        { error: `Server "${parsed.config.name}" already exists` },
        409,
      );
    }

    const config = parsed.config;
    servers.push(config);
    saveMcpServers(servers);
    const { errors } = await syncMcp();
    const status = mcpManager.getStatus(config.name);
    return c.json({ ok: true, ...status, syncErrors: errors }, 201);
  });

  app.put("/api/mcp-servers/:name", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const name = c.req.param("name");
    const body = await readJsonObject(c);
    if (body instanceof Response) return body;
    const servers = getMcpServers();
    const server = servers.find((s) => s.name === name);
    if (!server) return c.json({ error: `Server "${name}" not found` }, 404);

    if (body.url !== undefined) {
      if (typeof body.url !== "string") {
        return c.json({ error: "url must be a string" }, 400);
      }
      server.url = body.url;
    }
    if (body.authToken !== undefined) {
      if (typeof body.authToken !== "string") {
        return c.json({ error: "authToken must be a string" }, 400);
      }
      server.authToken = body.authToken;
    }
    if (body.command !== undefined) {
      if (typeof body.command !== "string") {
        return c.json({ error: "command must be a string" }, 400);
      }
      server.command = body.command;
    }
    if (body.args !== undefined) {
      if (
        !Array.isArray(body.args) ||
        !body.args.every((a) => typeof a === "string")
      ) return c.json({ error: "args must be an array of strings" }, 400);
      server.args = body.args;
    }
    if (body.env !== undefined) {
      if (
        !isRecord(body.env) ||
        !Object.values(body.env).every((v) => typeof v === "string")
      ) return c.json({ error: "env must be an object of string values" }, 400);
      server.env = body.env as Record<string, string>;
    }
    if (body.enabled !== undefined) {
      if (typeof body.enabled !== "boolean") {
        return c.json({ error: "enabled must be a boolean" }, 400);
      }
      server.enabled = body.enabled;
    }

    saveMcpServers(servers);
    const { errors } = await syncMcp();
    const status = mcpManager.getStatus(name);
    return c.json({ ok: true, ...status, syncErrors: errors });
  });

  app.delete("/api/mcp-servers/:name", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const name = c.req.param("name");
    const servers = getMcpServers();
    const idx = servers.findIndex((s) => s.name === name);
    if (idx === -1) return c.json({ error: `Server "${name}" not found` }, 404);
    servers.splice(idx, 1);
    saveMcpServers(servers);
    await syncMcp();
    return c.json({ ok: true });
  });

  app.post("/api/mcp-servers/sync", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const { errors } = await syncMcp();
    return c.json({ ok: true, errors });
  });

  // --- Skills ---

  app.get("/api/skills", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    return c.json(await ctx!.kernel.skills.list());
  });

  app.post("/api/skills", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const body = await c.req.json<
      { name?: string; description?: string; prompt?: string }
    >().catch(() => null);
    if (!body?.name?.trim()) return c.json({ error: "name is required" }, 400);
    if (!body.prompt?.trim()) {
      return c.json({ error: "prompt is required" }, 400);
    }
    try {
      const skill = await ctx!.kernel.skills.create(
        body.name.trim(),
        body.description?.trim() ?? "",
        body.prompt.trim(),
      );
      return c.json(skill, 201);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("UNIQUE constraint")) {
        return c.json({ error: `Skill "${body.name}" already exists` }, 409);
      }
      return c.json({ error: msg }, 500);
    }
  });

  app.put("/api/skills/:id", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const id = Number(c.req.param("id"));
    if (Number.isNaN(id)) return c.json({ error: "Invalid skill id" }, 400);
    const body = await readJsonObject(c);
    if (body instanceof Response) return body;
    const patch: Partial<
      { name: string; description: string; prompt: string; enabled: boolean }
    > = {};
    for (const key of ["name", "description", "prompt"] as const) {
      if (body[key] !== undefined) {
        if (typeof body[key] !== "string") {
          return c.json({ error: `${key} must be a string` }, 400);
        }
        patch[key] = body[key];
      }
    }
    if (body.enabled !== undefined) {
      if (typeof body.enabled !== "boolean") {
        return c.json({ error: "enabled must be a boolean" }, 400);
      }
      patch.enabled = body.enabled;
    }
    const updated = await ctx!.kernel.skills.update(id, patch);
    if (!updated) return c.json({ error: "Skill not found" }, 404);
    return c.json(updated);
  });

  app.delete("/api/skills/:id", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const id = Number(c.req.param("id"));
    if (Number.isNaN(id)) return c.json({ error: "Invalid skill id" }, 400);
    const deleted = await ctx!.kernel.skills.delete(id);
    if (!deleted) return c.json({ error: "Skill not found" }, 404);
    return c.json({ ok: true });
  });

  app.get("/api/branches", (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const kernel = ctx!.kernel;
    return c.json({
      branches: kernel.branches.serialize(),
      active: kernel.branches.getActive(),
    });
  });

  app.post("/api/branches", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const body = await c.req.json<{ name: string }>().catch(() => null);
    if (!body?.name) return c.json({ error: "name is required" }, 400);
    const existing = ctx!.kernel.branches.list().find((b) =>
      b.name === body.name
    );
    if (existing) {
      return c.json({ error: `Branch "${body.name}" already exists` }, 409);
    }
    const branch = await ctx!.kernel.branches.create(body.name, ctx!.kernel);
    const paths = getProjectPaths(ctx!.entry.path);
    saveKernelState(ctx!.kernel, paths.stateDir);
    saveBranchSnapshots(ctx!.kernel, paths.branchSnapshots);
    return c.json(branch, 201);
  });

  app.post("/api/branches/:name/switch", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const name = c.req.param("name");
    const result = await ctx!.kernel.branches.switch(
      name,
      ctx!.kernel,
      ctx!.rebuild,
    );
    if (!result.ok) return c.json({ error: result.error }, 404);
    const paths = getProjectPaths(ctx!.entry.path);
    saveKernelState(ctx!.kernel, paths.stateDir);
    saveBranchSnapshots(ctx!.kernel, paths.branchSnapshots);
    return c.json({ message: `Switched to branch "${name}".` });
  });

  app.delete("/api/branches/:name", (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const name = c.req.param("name");
    const removed = ctx!.kernel.branches.delete(name, ctx!.kernel);
    if (!removed) return c.json({ error: "Branch not found" }, 404);
    const paths = getProjectPaths(ctx!.entry.path);
    saveKernelState(ctx!.kernel, paths.stateDir);
    saveBranchSnapshots(ctx!.kernel, paths.branchSnapshots);
    return c.json({ message: `Branch "${name}" deleted.` });
  });

  // --- Changesets ---

  app.get("/api/changesets", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const sessionId = c.req.query("session_id") || undefined;
    const status = c.req.query("status") as
      | import("./types.ts").ChangesetStatus
      | undefined;
    const limit = c.req.query("limit")
      ? Number(c.req.query("limit"))
      : undefined;
    return c.json(
      await ctx!.kernel.changesets.list({ sessionId, status, limit }),
    );
  });

  app.get("/api/changesets/:id", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const id = c.req.param("id");
    const cs = await ctx!.kernel.changesets.get(id);
    if (!cs) return c.json({ error: "Not found" }, 404);
    const changes = await ctx!.kernel.changelog.listByChangeset(id);
    const tokenUsage = await enrichChangesetTokenUsageOnRead(
      cs.tokenUsage,
      id,
      ctx!.kernel,
    );
    return c.json({
      ...cs,
      tokenUsage,
      changes: await Promise.all(
        changes.map((change) =>
          redactChangeRecordForUser(currentUser(c), change)
        ),
      ),
    });
  });

  app.patch("/api/changesets/:id", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const id = c.req.param("id");
    const body = await c.req.json<{ title?: string; description?: string }>()
      .catch(() => null);
    if (!body) return c.json({ error: "Invalid body" }, 400);
    const cs = await ctx!.kernel.changesets.get(id);
    if (!cs) return c.json({ error: "Not found" }, 404);
    if (body.title || body.description) {
      await ctx!.kernel.changesets.patch(id, body);
    }
    return c.json(await ctx!.kernel.changesets.get(id));
  });

  app.post("/api/changesets/:id/approve", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const id = c.req.param("id");
    try {
      const existing = await ctx!.kernel.changesets.get(id);
      if (!existing) return c.json({ error: "Not found" }, 404);

      let cs = existing;
      if (existing.status === "planning") {
        await ctx!.kernel.changesets.approve(id);
        cs = await ctx!.kernel.changesets.startWork(id);
      } else if (existing.status === "approved") {
        cs = await ctx!.kernel.changesets.startWork(id);
      } else if (existing.status !== "in_progress") {
        return c.json(
          { error: `Cannot approve changeset in status "${existing.status}"` },
          400,
        );
      }
      const changes = await ctx!.kernel.changelog.listByChangeset(id);
      telemetry.track("changeset_approved", {
        change_count: changes.length,
        had_tests_run: ctx!.kernel.tests.list().some((t) => t.lastResult),
      });
      maybeSyncTelemetry();
      return c.json(cs);
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : String(err) },
        400,
      );
    }
  });

  app.post("/api/changesets/:id/approval-message", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const id = c.req.param("id");
    const body = await c.req.json<{ messageId?: number }>().catch(() => null);
    if (!body || typeof body.messageId !== "number") {
      return c.json({ error: "messageId is required" }, 400);
    }
    try {
      const message = await ctx!.kernel.sessions.getMessage(body.messageId);
      if (!message) return c.json({ error: "Message not found" }, 404);
      const cs = await ctx!.kernel.changesets.get(id);
      if (!cs) return c.json({ error: "Not found" }, 404);
      if (cs.sessionId && message.sessionId !== cs.sessionId) {
        return c.json(
          { error: "Message is not in the changeset session" },
          400,
        );
      }
      const updated = await ctx!.kernel.changesets.setApprovalMessageId(
        id,
        body.messageId,
      );
      return c.json(updated);
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : String(err) },
        400,
      );
    }
  });

  app.post("/api/changesets/:id/verification-runs", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const id = c.req.param("id");
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({}));
    const result = await dispatchTool(
      "record_verification_run",
      { ...body, changeset_id: id },
      ctx!.kernel,
      ctx!.rebuild,
    );
    if (!result.ok) {
      return c.json(
        { error: result.error?.message ?? "Verification run failed" },
        400,
      );
    }
    return c.json(result.data);
  });

  app.post("/api/changesets/:id/complete", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const id = c.req.param("id");
    try {
      const existing = await ctx!.kernel.changesets.get(id);
      if (!existing) return c.json({ error: "Not found" }, 404);

      if ((existing.plan.formalSpecs ?? []).length > 0) {
        const specResult = await runFormalSpecVerification(
          ctx!.kernel,
          existing,
        );
        if (!specResult.ok) {
          return c.json(
            {
              error: specResult.error?.message ??
                "Formal spec verification failed",
            },
            400,
          );
        }
      }

      const changeset = await ctx!.kernel.changesets.get(id) ?? existing;
      const readiness = await checkProjectAwareReadiness(
        ctx!.kernel,
        changeset,
      );
      if (!readiness.passed) {
        return c.json(
          {
            error: readiness.summary,
            readiness,
          },
          400,
        );
      }

      const completed = await ctx!.kernel.changesets.complete(id);
      const aggregated = await ctx!.kernel.changesets.aggregate(
        completed.id,
        ctx!.kernel.sessions,
        ctx!.kernel.changelog,
      );
      return c.json(aggregated);
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : String(err) },
        400,
      );
    }
  });

  app.post("/api/changesets/:id/reject", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const id = c.req.param("id");
    try {
      const existing = await ctx!.kernel.changesets.get(id);
      if (!existing) return c.json({ error: "Not found" }, 404);
      if (existing.status !== "planning" && existing.status !== "rejected") {
        return c.json(
          { error: `Cannot reject changeset in status "${existing.status}"` },
          400,
        );
      }
      const cs = await ctx!.kernel.changesets.reject(id);
      return c.json(cs);
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : String(err) },
        400,
      );
    }
  });

  // Frees a project held by another session's active changeset, typically one a
  // dead MCP client left behind. Rewinds to the changeset's start snapshot when
  // there is one; the response's `rewind` says whether it did.
  app.post("/api/changesets/:id/abandon", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const id = c.req.param("id");
    try {
      const existing = await ctx!.kernel.changesets.get(id);
      if (!existing) return c.json({ error: "Not found" }, 404);
      if (existing.status === "abandoned") return c.json(existing);
      if (
        existing.status !== "planning" && existing.status !== "approved" &&
        existing.status !== "in_progress"
      ) {
        return c.json(
          { error: `Cannot abandon changeset in status "${existing.status}"` },
          400,
        );
      }
      const rewind = await rewindForAbandon(ctx!.kernel, id, ctx!.rebuild);
      const cs = await ctx!.kernel.changesets.abandon(id);
      return c.json({ ...cs, rewind });
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : String(err) },
        400,
      );
    }
  });

  app.patch("/api/changesets/:id/formal-specs/:specId", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const id = c.req.param("id");
    const specId = c.req.param("specId");
    const body = await c.req
      .json<{ enforcement?: "hard" | "soft"; remove?: boolean }>()
      .catch(() => null);
    if (!body) return c.json({ error: "Invalid body" }, 400);
    const hasEnforcement = body.enforcement === "hard" ||
      body.enforcement === "soft";
    if (!hasEnforcement && !body.remove) {
      return c.json(
        { error: "Provide enforcement ('hard'|'soft') or remove: true" },
        400,
      );
    }
    try {
      const existing = await ctx!.kernel.changesets.get(id);
      if (!existing) return c.json({ error: "Not found" }, 404);
      const cs = await ctx!.kernel.changesets.patchFormalSpec(id, specId, {
        enforcement: body.remove ? undefined : body.enforcement,
        remove: body.remove,
      });
      return c.json(cs);
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : String(err) },
        400,
      );
    }
  });

  app.post("/api/changesets/:id/rollback", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const id = c.req.param("id");
    const changes = await ctx!.kernel.changelog.listByChangeset(id);
    if (changes.length === 0) {
      return c.json({ error: "No changes to rollback" }, 400);
    }
    const minId = Math.min(...changes.map((ch) => ch.id));
    const targetId = minId - 1;
    const result = await dispatchTool(
      "goto_change",
      { id: targetId > 0 ? targetId : 0 },
      ctx!.kernel,
      ctx!.rebuild,
    );
    if (!result.ok) return c.json(result.error, 500);
    try {
      await ctx!.kernel.changesets.abandon(id);
    } catch { /* may already be abandoned */ }
    return c.json({ rolledBack: changes.length, targetId });
  });

  app.post("/api/changesets/:id/branch", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const id = c.req.param("id");
    const cs = await ctx!.kernel.changesets.get(id);
    if (!cs) return c.json({ error: "Not found" }, 404);
    let branchName =
      cs.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
        .slice(0, 50) || "changeset";
    if (ctx!.kernel.branches.list().find((b) => b.name === branchName)) {
      branchName = `${branchName}-${Date.now().toString(36).slice(-4)}`;
    }
    const branch = await ctx!.kernel.branches.create(branchName, ctx!.kernel);
    const paths = getProjectPaths(ctx!.entry.path);
    saveKernelState(ctx!.kernel, paths.stateDir);
    saveBranchSnapshots(ctx!.kernel, paths.branchSnapshots);
    return c.json(branch, 201);
  });

  // --- Documents (document store Phase 4 Slice 1 — read-only browse + provenance) ---
  // The Documents right-sidebar panel reads these; all four are read-only. Contracts
  // documented by the DOCUMENTS_*_ROUTE_SCHEMA consts above.

  app.get("/api/documents", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const scope = c.req.query("scope") as DocumentScope | undefined;
    const sessionId = c.req.query("session_id") || undefined;
    const includeArchived = c.req.query("include_archived") === "1" ||
      c.req.query("include_archived") === "true";
    const includeInternal = c.req.query("include_internal") === "1" ||
      c.req.query("include_internal") === "true";
    // `session_id` scopes the VIEW to what is visible from that session — the shared
    // project/global docs PLUS that session's own session-scoped docs — never another
    // session's session docs. (This mirrors the @-mention picker's client-side filter.)
    // We therefore list without a hard session filter and relax it here; a strict
    // scope filter, when given, still applies. An explicit `scope` is passed through.
    const result = await ctx!.kernel.documents.list({
      scope,
      includeArchived,
      includeInternal,
    });
    if (!result.ok) return c.json({ error: result.error.message }, 400);
    if (sessionId) {
      try {
        const visible = result.data.filter(
          (d) => d.scope !== "session" || d.sessionId === sessionId,
        );
        // Optional Tier-2 surface: flag which visible docs are resident in this
        // session's working set. Read-only — no pin/unpin toggle this slice.
        // listPinned returns a bare array, so wrap it in our own try/catch.
        const resident = new Set(
          await ctx!.kernel.documents.listPinned(sessionId),
        );
        return c.json(
          visible.map((d) => ({ ...d, resident: resident.has(d.id) })),
        );
      } catch (err) {
        return c.json(
          { error: err instanceof Error ? err.message : String(err) },
          500,
        );
      }
    }
    return c.json(result.data);
  });

  // Create a document in the store (document store Phase 4 Slices 4 + 9, plan §7/§9).
  // The panel's "New document" form drives this — the human path, distinct from the
  // document_write agent verb (so MCP surface is untouched); createdBy is hardcoded
  // "user". Two request shapes selected by Content-Type: the default application/json
  // TEXT path (Slice 4), and a multipart/form-data FILE UPLOAD branch (Slice 9) that
  // accepts text files plus image/pdf files the /raw route can preview inline. Both funnel into the
  // same engine create + the same Result→HTTP mapping below. Contract in
  // DOCUMENTS_CREATE_ROUTE_SCHEMA above. Terser `{ error }` convention.
  app.post("/api/documents", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;

    // Shared engine-Result → HTTP mapping for both request shapes: PROJECT_REQUIRED
    // surfaces its "create it global" hint verbatim; every other error is a 400; ok is 201.
    const respondCreate = (
      result: Awaited<
        ReturnType<NonNullable<typeof ctx>["kernel"]["documents"]["create"]>
      >,
    ) => {
      if (!result.ok) {
        if (
          result.error.code === "PROJECT_REQUIRED" && result.error.suggestion
        ) {
          return c.json(
            { error: `${result.error.message} ${result.error.suggestion}` },
            400,
          );
        }
        return c.json({ error: result.error.message }, 400);
      }
      return c.json(result.data, 201);
    };

    const contentType = c.req.header("content-type") ?? "";

    // --- File upload branch (Slice 9): multipart/form-data with a `file` field. ---
    if (contentType.startsWith("multipart/form-data")) {
      const form = await c.req.formData().catch(() => null);
      if (!form) {
        return c.json({ error: "invalid multipart/form-data body" }, 400);
      }
      const file = form.get("file");
      if (!(file instanceof File)) {
        return c.json({ error: "`file` (a file upload) is required" }, 400);
      }
      const declaredKind = file.type;
      const textKind = normalizeTextUploadKind(declaredKind, file.name);
      const kind = textKind ?? declaredKind;
      const previewableBinary = PREVIEWABLE_BINARY_KINDS.has(kind);
      if (!textKind && !previewableBinary) {
        return c.json({
          error: `\`file\` kind must be text/* or one of: ${
            [...PREVIEWABLE_BINARY_KINDS].join(", ")
          }`,
        }, 400);
      }
      const scopeField = form.get("scope");
      const scope = typeof scopeField === "string" ? scopeField : "";
      if (!DOCUMENT_SCOPES.includes(scope as DocumentScope)) {
        return c.json({
          error: `\`scope\` must be one of: ${DOCUMENT_SCOPES.join(", ")}`,
        }, 400);
      }
      const sessionField = form.get("session_id");
      const sessionId = typeof sessionField === "string" && sessionField
        ? sessionField
        : null;
      if (scope === "session" && !sessionId) {
        return c.json(
          { error: "`session_id` is required for a session document" },
          400,
        );
      }
      const nameField = form.get("name");
      const name = typeof nameField === "string" && nameField.trim()
        ? nameField.trim()
        : file.name;
      if (!name.trim()) {
        return c.json({ error: "`name` is required" }, 400);
      }
      const bytes = new Uint8Array(await file.arrayBuffer());
      // Defense-in-depth beside /raw's nosniff: reject a blob whose leading bytes
      // don't match its declared (allowlisted) kind.
      if (previewableBinary && !matchesDeclaredKind(bytes, kind)) {
        return c.json(
          { error: `\`file\` bytes do not match the declared kind "${kind}"` },
          400,
        );
      }
      return respondCreate(
        await ctx!.kernel.documents.create({
          name,
          kind,
          content: bytes,
          scope: scope as DocumentScope,
          sessionId: scope === "session" ? sessionId : null,
          createdBy: "user",
        }),
      );
    }

    // --- Text path (Slice 4): application/json body, text/* kinds only. ---
    const body = await c.req.json<{
      name?: string;
      kind?: string;
      scope?: string;
      content?: string;
      session_id?: string;
    }>().catch(() => null);
    if (!body?.name?.trim()) {
      return c.json({ error: "`name` is required" }, 400);
    }
    if (typeof body.content !== "string") {
      return c.json({ error: "`content` (string) is required" }, 400);
    }
    if (!DOCUMENT_CREATE_KIND_VALUES.includes(body.kind ?? "")) {
      return c.json({
        error: `\`kind\` must be one of: ${
          DOCUMENT_CREATE_KIND_VALUES.join(", ")
        }`,
      }, 400);
    }
    if (!DOCUMENT_SCOPES.includes(body.scope as DocumentScope)) {
      return c.json({
        error: `\`scope\` must be one of: ${DOCUMENT_SCOPES.join(", ")}`,
      }, 400);
    }
    const scope = body.scope as DocumentScope;
    if (scope === "session" && !body.session_id) {
      return c.json({
        error: "`session_id` is required for a session document",
      }, 400);
    }
    return respondCreate(
      await ctx!.kernel.documents.create({
        name: body.name,
        kind: body.kind!,
        content: body.content,
        scope,
        sessionId: scope === "session" ? body.session_id : null,
        createdBy: "user",
      }),
    );
  });

  app.get("/api/documents/:id", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const id = c.req.param("id");
    const result = await ctx!.kernel.documents.read(id);
    if (!result.ok) {
      if (result.error.code === "DOCUMENT_NOT_FOUND") {
        return c.json({ error: "Not found" }, 404);
      }
      return c.json({ error: result.error.message }, 400);
    }
    return c.json(result.data);
  });

  app.get("/api/documents/:id/refs", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const id = c.req.param("id");
    // listRefs returns a bare array (backlinks), so wrap it in our own try/catch.
    try {
      return c.json(await ctx!.kernel.documents.listRefs(id));
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : String(err) },
        500,
      );
    }
  });

  app.get("/api/documents/:id/content", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const id = c.req.param("id");
    const version = c.req.query("version") || undefined;
    const meta = await ctx!.kernel.documents.read(id);
    if (!meta.ok) {
      if (meta.error.code === "DOCUMENT_NOT_FOUND") {
        return c.json({ error: "Not found" }, 404);
      }
      return c.json({ error: meta.error.message }, 400);
    }
    const doc = meta.data.document;
    const targetHash = version ?? doc.currentVersionHash;
    const versionRow = meta.data.versions.find((v) =>
      v.versionHash === targetHash
    );
    if (!versionRow) {
      return c.json(
        { error: `No version "${targetHash}" for document "${id}".` },
        404,
      );
    }
    // Text-only guard: return utf-8 text for text/* kinds; for binary kinds return
    // a metadata placeholder (size + versionHash), NOT bytes. Binary preview (image
    // data-URL, pdf embed) is a later slice — utf-8-decoding a PNG's bytes yields
    // garbage, so this endpoint never streams a blob it cannot render as text.
    if (!doc.kind.startsWith("text/")) {
      return c.json({
        kind: doc.kind,
        versionHash: targetHash,
        size: versionRow.size,
        binary: true,
      });
    }
    const content = await ctx!.kernel.documents.readContent(id, version);
    if (!content.ok) return c.json({ error: content.error.message }, 400);
    return c.json({
      kind: doc.kind,
      versionHash: content.data.version.versionHash,
      content: content.data.content,
    });
  });

  // Stream a document version's raw blob bytes (document store Phase 4 Slice 8,
  // plan §9 "Preview pane"). This is the sibling the /content route deliberately
  // is NOT: /content never streams a blob it can't render as utf-8 text, so image
  // and pdf previews need real bytes from here. Contract in
  // DOCUMENTS_RAW_ROUTE_SCHEMA above. Terser `{ error }` control convention.
  //
  // SECURITY: this is a same-origin file server for the first-party IDE, so an
  // attacker-authored document must never execute as active content in the IDE's
  // origin. Only PREVIEWABLE_BINARY_KINDS are served inline with their real Content-Type;
  // everything else — text/html, image/svg+xml, all text kinds — is forced to
  // application/octet-stream + attachment. X-Content-Type-Options: nosniff is
  // always set so the browser can't sniff a download into an executable type.
  app.get("/api/documents/:id/raw", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const id = c.req.param("id");
    const version = c.req.query("version") || undefined;
    const result = await ctx!.kernel.documents.readContentBytes(id, version);
    if (!result.ok) {
      if (
        result.error.code === "DOCUMENT_NOT_FOUND" ||
        result.error.code === "VERSION_NOT_FOUND"
      ) {
        return c.json({ error: "Not found" }, 404);
      }
      return c.json({ error: result.error.message }, 400);
    }
    const { document: doc, bytes } = result.data;
    const inline = PREVIEWABLE_BINARY_KINDS.has(doc.kind);
    // Blobs are content-addressed (immutable per version), so a pinned ?version is
    // safely long-cacheable; the head (no ?version) can move, so don't cache it.
    const headers: Record<string, string> = {
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": version
        ? "public, max-age=31536000, immutable"
        : "no-cache",
    };
    if (inline) {
      headers["Content-Type"] = doc.kind;
      headers["Content-Disposition"] = "inline";
    } else {
      // Sanitize the stored name into a header-safe filename (no quotes, control
      // chars, or path separators) so the attachment fallback can't smuggle a
      // header break or traversal.
      const safeName = doc.name.replace(/[^\w.\-]+/g, "_") || "document";
      headers["Content-Type"] = "application/octet-stream";
      headers["Content-Disposition"] = `attachment; filename="${safeName}"`;
    }
    return new Response(bytes as unknown as BodyInit, { headers });
  });

  // Pin/unpin a document into a session's Tier-2 working set (document store Phase 4
  // Slice 3, plan §5/§7). The first MUTATING documents control route — the panel
  // toggle's path (the AGENT's path is the document_pin verb). The engine
  // (DocumentStore.setPinned) enforces the working-set budget; we just map its Result
  // to HTTP. Contract in DOCUMENTS_PIN_ROUTE_SCHEMA above. Terser `{ error }` control
  // convention. No agent tool verb, so MCP surface is untouched.
  app.post("/api/documents/:id/pin", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const id = c.req.param("id");
    const body = await c.req.json<{ pinned?: boolean; session_id?: string }>()
      .catch(() => null);
    if (typeof body?.pinned !== "boolean") {
      return c.json({ error: "`pinned` (boolean) is required" }, 400);
    }
    if (!body.session_id) {
      return c.json({ error: "`session_id` is required" }, 400);
    }
    const result = await ctx!.kernel.documents.setPinned(
      id,
      body.pinned,
      body.session_id,
    );
    if (!result.ok) {
      if (result.error.code === "DOCUMENT_NOT_FOUND") {
        return c.json({ error: "Not found" }, 404);
      }
      if (result.error.code === "WORKING_SET_BUDGET_EXCEEDED") {
        // Surface the budget message + release-first suggestion verbatim so the
        // panel can show the user exactly how far past the cap they are.
        const suggestion = result.error.suggestion;
        return c.json({
          error: suggestion
            ? `${result.error.message} ${suggestion}`
            : result.error.message,
        }, 409);
      }
      return c.json({ error: result.error.message }, 400);
    }
    return c.json(result.data);
  });

  // Update a text document's content, producing a new immutable version (document
  // store Phase 4 Slice 5, plan §7). The panel detail-view editor's path (the AGENT's
  // path is the document_write verb, action=update). The engine (DocumentStore.update)
  // preserves the doc's kind and only swaps bytes — it does not guard text-vs-binary —
  // so we guard at the boundary: read the doc first, reject anything that is not a
  // text/* kind (binary editing is a deferred slice). PUT is idempotent: re-issuing the
  // same content is a genuine no-op via the engine's content-address byte-dedupe (no new
  // version). Contract in DOCUMENTS_UPDATE_ROUTE_SCHEMA above. Terser `{ error }`
  // convention. No agent tool verb, so MCP surface is untouched.
  app.put("/api/documents/:id", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const id = c.req.param("id");
    const meta = await ctx!.kernel.documents.read(id);
    if (!meta.ok) {
      if (meta.error.code === "DOCUMENT_NOT_FOUND") {
        return c.json({ error: "Not found" }, 404);
      }
      return c.json({ error: meta.error.message }, 400);
    }
    // Text-only guard (mirrors the content GET): this slice edits utf-8 text; binary
    // content editing/upload is a deferred follow-up.
    if (!meta.data.document.kind.startsWith("text/")) {
      return c.json(
        {
          error:
            `Document "${id}" is not a text document; only text/* content is editable.`,
        },
        400,
      );
    }
    const body = await c.req.json<{ content?: string }>().catch(() => null);
    if (typeof body?.content !== "string") {
      return c.json({ error: "`content` (string) is required" }, 400);
    }
    const result = await ctx!.kernel.documents.update(id, {
      content: body.content,
      createdBy: "user",
    });
    if (!result.ok) {
      if (result.error.code === "DOCUMENT_NOT_FOUND") {
        return c.json({ error: "Not found" }, 404);
      }
      if (result.error.code === "DOCUMENT_ARCHIVED") {
        // A tombstoned doc can't take a new version — a conflict, not a validation
        // error, so the panel can distinguish it (409 vs 400).
        return c.json({ error: result.error.message }, 409);
      }
      // Anything else (incl. CONTENT_TOO_LARGE) is a validation-level 400.
      return c.json({ error: result.error.message }, 400);
    }
    return c.json(result.data);
  });

  // Archive (soft-delete) a document (document store Phase 4 Slice 6, plan §7/§9). The
  // panel detail-view "Archive" action's path (the AGENT's path is the document_write
  // verb, action=archive). A one-way tombstone: the engine (DocumentStore.archive) sets
  // `archived: true` and preserves every immutable version/provenance (D2/§4 — we never
  // hard-delete cited blobs), and there is no unarchive this slice. DELETE is idempotent:
  // the engine does not guard an already-archived doc, so re-issuing just re-sets
  // `archived: true` and returns 200 with the same tombstoned state (only `updatedAt`
  // moves) — a genuine no-op success. Contract in DOCUMENTS_ARCHIVE_ROUTE_SCHEMA above.
  // Terser `{ error }` convention. No agent tool verb, so MCP surface is untouched.
  app.delete("/api/documents/:id", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const id = c.req.param("id");
    const result = await ctx!.kernel.documents.archive(id);
    if (!result.ok) {
      if (result.error.code === "DOCUMENT_NOT_FOUND") {
        return c.json({ error: "Not found" }, 404);
      }
      return c.json({ error: result.error.message }, 400);
    }
    return c.json(result.data);
  });

  // Promote a document's scope (document store Phase 4 Slice 7, plan §7/§9). The panel
  // detail-view "Promote" action's path — widens where a doc is visible (session →
  // project → global). One-way UP only: the target is restricted to project|global here
  // (you cannot promote TO session), and the engine (DocumentStore.promoteScope) rejects
  // a demotion with INVALID_SCOPE_PROMOTION. Idempotent: promoting to the doc's current
  // scope is an engine no-op success (200, unchanged). A →global promotion copies each
  // version's blob into the global store; session→project is metadata-only. Contract in
  // DOCUMENTS_PROMOTE_ROUTE_SCHEMA above. Terser `{ error }` convention. No agent tool
  // verb, so MCP surface is untouched.
  app.post("/api/documents/:id/scope", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const id = c.req.param("id");
    const body = await c.req.json<{ scope?: string }>().catch(() => null);
    // Accept only promotion targets: project|global. A missing/invalid scope, or
    // `session` (you cannot promote TO session), is a validation-level 400.
    if (body?.scope !== "project" && body?.scope !== "global") {
      return c.json(
        {
          error:
            '`scope` must be "project" or "global" (promotion targets only)',
        },
        400,
      );
    }
    const result = await ctx!.kernel.documents.promoteScope(
      id,
      body.scope as DocumentScope,
    );
    if (!result.ok) {
      if (result.error.code === "DOCUMENT_NOT_FOUND") {
        return c.json({ error: "Not found" }, 404);
      }
      if (result.error.code === "DOCUMENT_ARCHIVED") {
        // A tombstoned doc isn't promotable — a conflict, not a validation error.
        return c.json({ error: result.error.message }, 409);
      }
      // INVALID_SCOPE_PROMOTION / PROJECT_REQUIRED / BLOB_MISSING / anything else → 400.
      return c.json({ error: result.error.message }, 400);
    }
    return c.json(result.data);
  });

  app.get("/api/logs", (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    return c.json(ctx!.kernel.log.query({
      level: c.req.query("level") || undefined,
      source: c.req.query("source") || undefined,
      limit: Number(c.req.query("limit") ?? 100),
      search: c.req.query("search") || undefined,
    }));
  });

  app.delete("/api/logs", (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    ctx!.kernel.log.clear();
    return c.json({ ok: true });
  });

  app.get("/api/changelog/turns", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const limit = Number(c.req.query("limit") ?? 30);
    const includeSnapshots = c.req.query("includeSnapshots") === "1" ||
      c.req.query("includeSnapshots") === "true";
    const turns = await ctx!.kernel.changelog.listTurns(limit, {
      includeSnapshots,
    });
    const turnIds = turns.map((t) => t.turnId).filter((id) =>
      !id.startsWith("solo_")
    );
    const [messageIdMap, ...usages] = await Promise.all([
      ctx!.kernel.sessions.getUserMessageIdsByTurnIds(turnIds),
      ...turns.map((t) => ctx!.kernel.sessions.getTurnUsage(t.turnId)),
    ]);
    const user = currentUser(c);
    const enriched = await Promise.all(turns.map(async (t, i) => ({
      ...await redactTurnGroupForUser(user, t),
      usage: usages[i] ?? undefined,
      changesetId: t.changesetId ?? undefined,
      messageId: messageIdMap.get(t.turnId) ?? undefined,
    })));
    return c.json(enriched);
  });

  app.get("/api/changelog/:id{[0-9]+}", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const id = Number(c.req.param("id"));
    const record = await ctx!.kernel.changelog.get(id);
    if (!record) return c.json({ error: "Not found" }, 404);
    return c.json(await redactChangeRecordForUser(currentUser(c), record));
  });

  app.post("/api/changelog/goto/:id{[0-9]+}", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const id = Number(c.req.param("id"));
    const result = await dispatchTool(
      "goto_change",
      { id },
      ctx!.kernel,
      ctx!.rebuild,
    );
    if (!result.ok) {
      return c.json(
        result.error,
        result.error?.code === "NOT_FOUND" ? 404 : 500,
      );
    }
    return c.json(result.data);
  });

  app.post("/api/changelog/:id{[0-9]+}/branch", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const changeId = Number(c.req.param("id"));
    const body = await c.req.json<{ name?: string }>().catch((): {
      name?: string;
    } => ({}));
    const branchName = body.name?.trim() || `branch-at-${changeId}`;

    const existing = ctx!.kernel.branches.list().find((b) =>
      b.name === branchName
    );
    if (existing) {
      return c.json({ error: `Branch "${branchName}" already exists` }, 409);
    }

    await ctx!.kernel.branches.saveActive(ctx!.kernel);

    const gotoResult = await dispatchTool(
      "goto_change",
      { id: changeId },
      ctx!.kernel,
      ctx!.rebuild,
    );
    if (!gotoResult.ok) {
      return c.json(
        gotoResult.error,
        gotoResult.error?.code === "NOT_FOUND" ? 404 : 500,
      );
    }

    const branch = await ctx!.kernel.branches.create(branchName, ctx!.kernel);
    const paths = getProjectPaths(ctx!.entry.path);
    saveKernelState(ctx!.kernel, paths.stateDir);
    saveBranchSnapshots(ctx!.kernel, paths.branchSnapshots);
    return c.json(branch, 201);
  });

  app.post("/api/undo", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const result = await dispatchTool(
      "undo_change",
      {},
      ctx!.kernel,
      ctx!.rebuild,
    );
    if (!result.ok) return c.json(result.error, 400);
    return c.json(result.data);
  });

  app.post("/api/redo", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const result = await dispatchTool(
      "redo_change",
      {},
      ctx!.kernel,
      ctx!.rebuild,
    );
    if (!result.ok) return c.json(result.error, 400);
    return c.json(result.data);
  });

  app.post("/api/undo-turn", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const result = await dispatchTool(
      "undo_turn",
      {},
      ctx!.kernel,
      ctx!.rebuild,
    );
    if (!result.ok) return c.json(result.error, 400);
    return c.json(result.data);
  });

  app.post("/api/redo-turn", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const result = await dispatchTool(
      "redo_turn",
      {},
      ctx!.kernel,
      ctx!.rebuild,
    );
    if (!result.ok) return c.json(result.error, 400);
    return c.json(result.data);
  });

  app.get("/api/nav-history", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    return c.json(
      await getLocalJsonState("nav_history", { entries: [null], cursor: 0 }),
    );
  });

  app.get("/api/changelog/entity/:category/:key", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const category = c.req.param("category");
    const key = decodeURIComponent(c.req.param("key"));
    const limit = Number(c.req.query("limit") ?? 50);
    const history = await ctx!.kernel.changelog.entityHistory(
      category,
      key,
      limit,
    );
    return c.json(
      await Promise.all(
        history.map((record) =>
          redactChangeRecordForUser(currentUser(c), record)
        ),
      ),
    );
  });

  app.get("/api/editor-positions", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    return c.json(await getLocalJsonState("editor_positions", {}));
  });

  app.put("/api/editor-positions", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const body = await c.req.json();
    localState().set("editor_positions", body);
    return c.json({ ok: true });
  });

  app.get("/api/editor-drafts", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    return c.json(await getLocalJsonState("editor_drafts", {}));
  });

  app.put("/api/editor-drafts", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const body = await c.req.json();
    if (Object.keys(body).length === 0) {
      localState().delete("editor_drafts");
    } else {
      localState().set("editor_drafts", body);
    }
    return c.json({ ok: true });
  });

  app.get("/api/chat-drafts/:sessionId", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const sessionId = c.req.param("sessionId");
    const session = await requireReadableSession(c, sessionId);
    if (session instanceof Response) return session;
    const drafts = localState().get<ChatDraftMap>("chat_drafts") ?? {};
    return c.json({ text: drafts[sessionId] ?? "" });
  });

  app.put("/api/chat-drafts/:sessionId", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const sessionId = c.req.param("sessionId");
    const session = await requireReadableSession(c, sessionId);
    if (session instanceof Response) return session;
    const body = await readJsonObject(c);
    if (body instanceof Response) return body;
    const text = body.text;
    if (typeof text !== "string") {
      return c.json({ error: "text is required" }, 400);
    }

    const store = localState();
    const drafts = { ...(store.get<ChatDraftMap>("chat_drafts") ?? {}) };
    if (text.trim().length === 0) {
      delete drafts[sessionId];
    } else {
      drafts[sessionId] = text.slice(0, MAX_CHAT_DRAFT_TEXT_LENGTH);
    }
    if (Object.keys(drafts).length === 0) {
      store.delete("chat_drafts");
    } else {
      store.set("chat_drafts", drafts);
    }
    return c.json({ ok: true });
  });

  app.delete("/api/chat-drafts/:sessionId", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const sessionId = c.req.param("sessionId");
    const session = await requireReadableSession(c, sessionId);
    if (session instanceof Response) return session;
    const store = localState();
    const drafts = { ...(store.get<ChatDraftMap>("chat_drafts") ?? {}) };
    delete drafts[sessionId];
    if (Object.keys(drafts).length === 0) {
      store.delete("chat_drafts");
    } else {
      store.set("chat_drafts", drafts);
    }
    return c.json({ ok: true });
  });

  app.put("/api/nav-history", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const body = await c.req.json<{ entries: unknown[]; cursor: number }>();
    const MAX_NAV_ENTRIES = 100;
    let { entries, cursor } = body;
    if (entries.length > MAX_NAV_ENTRIES) {
      const excess = entries.length - MAX_NAV_ENTRIES;
      entries = entries.slice(excess);
      cursor = Math.max(0, cursor - excess);
    }
    localState().set("nav_history", { entries, cursor });
    return c.json({ ok: true });
  });

  app.get("/api/snapshots", (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    return c.json(ctx!.kernel.snapshots.list());
  });

  app.post("/api/snapshots", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const body = await c.req.json<{ description?: string }>().catch(() => ({
      description: "",
    }));
    const meta = await ctx!.kernel.snapshots.save(
      ctx!.kernel,
      body.description ?? "",
    );
    return c.json(meta, 201);
  });

  app.post("/api/snapshots/:id/restore", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const id = c.req.param("id");
    const result = await ctx!.kernel.snapshots.restore(
      id,
      ctx!.kernel,
      ctx!.rebuild,
    );
    if (!result.ok) return c.json({ error: result.error }, 404);
    return c.json({ message: `Snapshot "${id}" restored.` });
  });

  // --- Backups ---

  app.get("/api/backups", (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const paths = getProjectPaths(ctx!.entry.path);
    return c.json(listBackups(paths.backups));
  });

  app.post("/api/backups", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const paths = getProjectPaths(ctx!.entry.path);
    const settings = getKernelSettings();
    mkdirSync(paths.backups, { recursive: true });
    const backup = await createBackup(ctx!.kernel, ctx!.kernel.db, "manual");
    saveBackup(backup, paths.backups, settings.maxDbBackups);
    // An explicit backup restarts the periodic clock — asking for one and then getting
    // an automatic duplicate a moment later is just eviction pressure on maxDbBackups.
    noteBackupTaken(ctx!.entry.path);
    sendToChat({
      type: "backup_created",
      trigger: "manual",
      tableCount: backup.metadata.tableCount,
      rowCount: backup.metadata.rowCount,
      branchSnapshotCount: backup.metadata.branchSnapshotCount,
      includesProjectState: backup.metadata.includesProjectState,
    });
    return c.json(backup.metadata, 201);
  });

  app.post("/api/backups/:id/restore", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const id = c.req.param("id");
    const paths = getProjectPaths(ctx!.entry.path);
    const backup = loadBackup(paths.backups, id);
    if (!backup) return c.json({ error: "Backup not found" }, 404);

    // Restore kernel state
    if (backup.kernelState) {
      saveProjectStateData(backup.kernelState, paths.stateDir);
    }

    // Restore DB tables and branch snapshots
    const result = await restoreDbTables(backup, ctx!.kernel.db);
    const snapshotCount = restoreBranchSnapshots(backup, ctx!.kernel, {
      restoreBranchList: true,
    });
    if (snapshotCount > 0) {
      saveBranchSnapshots(ctx!.kernel, paths.branchSnapshots);
    }
    return c.json({
      message: `Restored from backup "${id}"`,
      ...result,
      branchSnapshotsRestored: snapshotCount,
    });
  });

  app.get("/api/backups/:id/download", (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const id = c.req.param("id");
    const paths = getProjectPaths(ctx!.entry.path);
    const backup = loadBackup(paths.backups, id);
    if (!backup) return c.json({ error: "Backup not found" }, 404);
    const name = ctx!.entry.name.replace(/[^a-zA-Z0-9_-]/g, "_").toLowerCase();
    return new Response(JSON.stringify(backup), {
      headers: {
        "Content-Type": "application/json",
        "Content-Disposition": `attachment; filename="${name}_${id}.json"`,
      },
    });
  });

  app.post("/api/backups/import", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const paths = getProjectPaths(ctx!.entry.path);
    const settings = getKernelSettings();
    const body = await c.req.json().catch(() => null);
    if (
      !body?.metadata?.id || !body?.kernelState || !Array.isArray(body?.tables)
    ) {
      return c.json({ error: "Invalid backup format" }, 400);
    }
    const backup = body as import("./backup.ts").BackupData;
    mkdirSync(paths.backups, { recursive: true });
    saveBackup(backup, paths.backups, settings.maxDbBackups);
    return c.json({ ok: true, metadata: backup.metadata }, 201);
  });

  app.delete("/api/backups/:id", (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const paths = getProjectPaths(ctx!.entry.path);
    const deleted = deleteBackup(paths.backups, c.req.param("id"));
    if (!deleted) return c.json({ error: "Backup not found" }, 404);
    return c.json({ ok: true });
  });

  app.get("/api/dev-views", (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    return c.json(
      ctx!.kernel.devViews.list().map((v) => ({
        name: v.name,
        targetType: v.targetType,
        title: v.title,
        builtIn: v.builtIn,
        registeredAt: v.registeredAt,
      })),
    );
  });

  app.get("/api/dev-views/:name/source", (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const entry = ctx!.kernel.devViews.get(c.req.param("name"));
    if (!entry) return c.json({ error: "Not found" }, 404);
    return c.json({
      name: entry.name,
      targetType: entry.targetType,
      title: entry.title,
      source: entry.source,
      builtIn: entry.builtIn,
    });
  });

  app.post("/api/dev-views/:name/render", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const viewName = c.req.param("name");
    const entry = ctx!.kernel.devViews.get(viewName);
    if (!entry) {
      const available = ctx!.kernel.devViews.list().map((v) => v.name);
      const message =
        `Dev view "${viewName}" not found while rendering. The UI may be using a stale inspector tab; choose one of the available dev views or refresh the project state.`;
      ctx!.kernel.log.log("warn", "system", message, {
        metadata: {
          viewName,
          availableDevViews: available,
          endpoint: `/api/dev-views/${viewName}/render`,
        },
      });
      return c.json({
        ok: false,
        code: "DEV_VIEW_NOT_FOUND",
        error: message,
        viewName,
        availableDevViews: available,
      }, 404);
    }

    const body = await c.req.json<{ object: unknown }>().catch(() => null);
    if (!body) {
      return c.json({
        ok: false,
        error: "Request body must contain { object }",
      }, 400);
    }

    try {
      const descriptor = await Promise.resolve(entry.fn(body.object));
      return c.json({ ok: true, descriptor });
    } catch (err) {
      return c.json({ ok: false, error: errorMessage(err) }, 500);
    }
  });

  // --- Built-in Tools (UI-runnable subset) ---

  const UI_TOOLS = new Set([
    "doctor_project",
    "find_dead_code",
    "find_unused_packages",
    "lint_code",
    "check_package_security",
    "analyze_complexity",
    "list_routes",
    "list_handlers",
    "list_functions",
    "list_schemas",
    "list_templates",
    "list_types",
    "list_env",
    "list_secrets",
    "list_tests",
    "get_logs",
    "get_recent_errors",
    "get_recent_requests",
    "get_kernel_status",
    "query_database",
    "execute_sql",
    "run_tests",
    "check_export_types",
    "verify_formal_specs",
    "test_coverage",
    "search_changes",
    "list_turns",
    "screenshot_app",
    "browser_status",
    "list_snapshots",
    "list_branches",
    "git_status",
    "git_init",
    "git_add_tide_gitignore",
    "git_set_remote",
    "git_commit",
    "git_push",
    "rename_session",
  ]);

  app.get("/api/tools/builtin", (c) => {
    const tools = CUSTOM_TOOLS
      .filter((t) => UI_TOOLS.has(t.name))
      .map((t) => {
        const schema = t.input_schema as {
          properties?: Record<string, { type?: string; description?: string }>;
          required?: string[];
        };
        const props = schema.properties ?? {};
        const required = new Set(schema.required ?? []);
        const args = Object.entries(props).map(([name, prop]) => ({
          name,
          type: prop.type ?? "string",
          description: prop.description ?? "",
          required: required.has(name),
        }));
        return {
          name: t.name,
          description: t.description,
          args,
          builtIn: true,
        };
      });
    return c.json(tools);
  });

  app.post("/api/tools/builtin/:name/run", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const name = c.req.param("name");
    if (!UI_TOOLS.has(name)) {
      return c.json({ ok: false, error: "Tool not found" }, 404);
    }
    const body = await c.req.json<{ args?: Record<string, unknown> }>().catch(
      () => null,
    );
    const input = body?.args ?? {};
    if (name === "rename_session" && !input.session_id) {
      const currentId = chat?.getCurrentSessionId();
      if (currentId) input.session_id = currentId;
    }
    const result = await dispatchTool(name, input, ctx!.kernel, ctx!.rebuild);
    if (result.ok) {
      return c.json({ ok: true, result: result.data });
    }
    return c.json({ ok: false, error: result.error?.message ?? "Tool failed" });
  });

  // --- Dev Tools ---

  app.post("/api/dev-tools/:name/run", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const kernel = ctx!.kernel;
    const entry = kernel.devTools.get(c.req.param("name"));
    if (!entry) return c.json({ ok: false, error: "Dev tool not found" }, 404);

    const body = await c.req.json<{ args?: Record<string, unknown> }>().catch(
      () => null,
    );
    const argsRecord = body?.args ?? {};

    for (const arg of entry.args) {
      if (arg.required && argsRecord[arg.name] === undefined) {
        return c.json({
          ok: false,
          error: `Required argument "${arg.name}" is missing.`,
        }, 400);
      }
    }

    const orderedArgs = entry.args.map((a) => argsRecord[a.name]);

    try {
      const timeout = new Promise<never>((_, reject) => {
        setTimeout(
          () => reject(new Error("Dev tool timed out after 30s")),
          30_000,
        );
      });
      const result = await Promise.race([
        Promise.resolve(entry.fn(...orderedArgs)),
        timeout,
      ]);
      return c.json({ ok: true, result });
    } catch (err) {
      return c.json({ ok: false, error: errorMessage(err) }, 500);
    }
  });

  // --- Function runner ---

  app.post("/api/functions/:name/run", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const kernel = ctx!.kernel;
    const name = c.req.param("name");
    const entry = kernel.functions.getEntry(name);
    if (!entry) return c.json({ ok: false, error: "Function not found" }, 404);

    const body = await c.req.json<{ args?: unknown[] }>().catch(() => null);
    const args = body?.args ?? [];

    try {
      const timeout = new Promise<never>((_, reject) => {
        setTimeout(
          () => reject(new Error("Function timed out after 30s")),
          30_000,
        );
      });
      const result = await Promise.race([
        Promise.resolve(entry.fn(...args)),
        timeout,
      ]);
      return c.json({
        ok: true,
        result,
        ...(entry.returnType ? { returnType: entry.returnType } : {}),
      });
    } catch (err) {
      return c.json({ ok: false, error: errorMessage(err) }, 500);
    }
  });

  // --- Tests ---

  app.post("/api/tests/run", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const kernel = ctx!.kernel;
    const body = await c.req.json<{ pattern?: string }>().catch(() => null);
    const started = performance.now();
    telemetry.track("test_run_started", {
      pattern_provided: Boolean(body?.pattern),
    });

    const result = await dispatchTool(
      "run_tests",
      { pattern: body?.pattern },
      kernel,
      ctx!.rebuild,
    );
    if (!result.ok) {
      telemetry.track("test_run_completed", {
        status: "failed",
        duration_ms: Math.round(performance.now() - started),
      });
      maybeSyncTelemetry();
      return c.json(result, 500);
    }
    const data = result.data as {
      total?: number;
      failed?: number;
      passed?: number;
    };
    telemetry.track("test_run_completed", {
      status: (data.failed ?? 0) > 0 ? "failed" : "passed",
      test_count: data.total ?? 0,
      failed_count: data.failed ?? 0,
      passed_count: data.passed ?? 0,
      duration_ms: Math.round(performance.now() - started),
    });
    maybeSyncTelemetry();
    return c.json(result.data);
  });

  app.post("/api/tests/run-progress", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const kernel = ctx!.kernel;
    const body = await c.req.json<{ pattern?: string }>().catch(() => null);
    const encoder = new TextEncoder();

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const send = (event: TestRunProgressEvent) => {
          if (c.req.raw.signal.aborted) return;
          try {
            controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
          } catch {
            // Client may have already closed the stream.
          }
        };

        (async () => {
          try {
            const result = await runKernelTests(
              kernel,
              body?.pattern,
              send,
              c.req.raw.signal,
            );
            if (result.ok && result.data) {
              send({ type: "summary", ...result.data });
            } else {
              send({
                type: "error",
                code: result.error?.code,
                message: result.error?.message ?? "Run tests failed",
              });
            }
          } catch (err) {
            if (!c.req.raw.signal.aborted) {
              send({ type: "error", message: errorMessage(err) });
            }
          } finally {
            try {
              controller.close();
            } catch {
              // Client may have already closed the stream.
            }
          }
        })();
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "application/x-ndjson",
        "Cache-Control": "no-cache",
      },
    });
  });

  app.get("/api/tests/:name/source", (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const entry = ctx!.kernel.tests.get(c.req.param("name"));
    if (!entry) return c.json({ error: "Test not found" }, 404);
    return c.json({
      name: entry.name,
      source: entry.source,
      registeredAt: entry.registeredAt,
    });
  });

  // --- Session Management ---

  app.get("/api/sessions", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const parsedLimit = Number(c.req.query("limit") ?? 20);
    const parsedOffset = Number(c.req.query("offset") ?? 0);
    const limit = Number.isFinite(parsedLimit)
      ? Math.min(Math.max(0, parsedLimit), MAX_SESSION_LIST_LIMIT)
      : 20;
    const offset = Number.isFinite(parsedOffset)
      ? Math.max(0, parsedOffset)
      : 0;
    const user = currentUser(c);
    const target = offset + limit;
    const batchSize = Math.max(target, 100);
    const readable: SessionWithLastMessage[] = [];
    let scanned = 0;
    while (readable.length < target) {
      const batch = await ctx!.kernel.sessions.listSessions(batchSize, scanned);
      if (batch.length === 0) break;
      readable.push(
        ...batch.filter((session) => canReadSession(user, session)),
      );
      scanned += batch.length;
      if (batch.length < batchSize) break;
    }
    const page = readable.slice(offset, target);
    return c.json(await enrichSessionsWithVerification(ctx!, page));
  });

  app.get("/api/sessions/current", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const id = chat?.getCurrentSessionId();
    if (!id) return c.json({ error: "No active session" }, 404);
    const session = await ctx!.kernel.sessions.getSession(id);
    if (!session) return c.json({ error: "Session not found" }, 404);
    if (session.archived) {
      await clearActiveChatSessionIf(id);
      return c.json({ error: "No active session" }, 404);
    }
    if (!canReadSession(currentUser(c), session)) {
      return c.json({ error: "Forbidden" }, 403);
    }
    return c.json(session);
  });

  app.get("/api/sessions/:id", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const session = await requireReadableSession(c, c.req.param("id"));
    if (session instanceof Response) return session;
    return c.json(session);
  });

  app.get("/api/sessions/:id/messages", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const sessionId = c.req.param("id");
    const session = await requireReadableSession(c, sessionId);
    if (session instanceof Response) return session;
    const limitParam = c.req.query("limit");
    const limit = limitParam === "all" ? undefined : Number(limitParam ?? 100);
    const offset = Number(c.req.query("offset") ?? 0);
    const pinnedOnly = c.req.query("pinned") === "true";
    const messages = await ctx!.kernel.sessions.getMessages(sessionId, {
      limit,
      offset,
      pinnedOnly,
    });
    const usages = await ctx!.kernel.sessions.getTurnUsagesForSession(
      sessionId,
    );
    const usageByTurnId = new Map(usages.map((usage) => [
      usage.turnId,
      usage,
    ]));
    const usageMessageIds = new Set<number>();
    const assignedTurnIds = new Set<string>();
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i]!;
      if (
        message.role !== "assistant" ||
        !message.turnId ||
        assignedTurnIds.has(message.turnId) ||
        !usageByTurnId.has(message.turnId)
      ) {
        continue;
      }
      usageMessageIds.add(message.id);
      assignedTurnIds.add(message.turnId);
    }

    return c.json(
      messages.map((message) =>
        message.turnId && usageMessageIds.has(message.id)
          ? { ...message, usage: usageByTurnId.get(message.turnId) }
          : message
      ),
    );
  });

  app.post("/api/chat/shell", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const originGuard = requireTrustedRestOrigin(c);
    if (originGuard) return originGuard;
    const body = await c.req.json<{ command?: unknown }>().catch(() => null);
    const command = typeof body?.command === "string"
      ? body.command.trim()
      : "";
    if (!command) return c.json({ error: "command is required" }, 400);

    const sessionId = chat?.getCurrentSessionId();
    if (!sessionId) return c.json({ error: "No active session" }, 400);
    const session = await requireReadableSession(c, sessionId);
    if (session instanceof Response) return session;
    if (session.archived) {
      await clearActiveChatSessionIf(sessionId);
      return c.json({
        error: "Archived sessions must be unarchived before sending",
      }, 409);
    }

    const result = await runShellCommand(command, { cwd: ctx!.entry.path });
    const content = formatShellTranscript(result);
    const message = await ctx!.kernel.sessions.addMessage({
      sessionId,
      role: "system",
      kind: "shell",
      content,
      authorUserId: currentUser(c).id,
    });
    return c.json({ message, result });
  });

  app.get("/api/sessions/:id/context", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const session = await requireReadableSession(c, c.req.param("id"));
    if (session instanceof Response) return session;
    return c.json(await ctx!.kernel.sessions.getContextInfo(c.req.param("id")));
  });

  app.post("/api/sessions/:id/summarize", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const session = await requireReadableSession(c, c.req.param("id"));
    if (session instanceof Response) return session;
    if (busy) {
      return c.json({
        error: "Agent is busy. Wait for the current turn to complete.",
      }, 409);
    }
    type SummarizeRequest = {
      kind?: string;
      throughMessageId?: number;
      store?: boolean;
      refresh?: boolean;
    };
    const body: SummarizeRequest = await c.req.json<SummarizeRequest>().catch(
      () => ({}),
    );
    const result = await summarizeSession(ctx!.kernel, {
      sessionId: c.req.param("id"),
      kind: normalizeSummaryKind(body?.kind),
      throughMessageId: body?.throughMessageId,
      store: body?.store ?? true,
      refresh: body?.refresh ?? false,
      requester: "user",
    });
    if (!result) return c.json({ error: "Session not found" }, 404);
    return c.json(result);
  });

  app.get("/api/sessions/:id/summary-status", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const session = await requireReadableSession(c, c.req.param("id"));
    if (session instanceof Response) return session;
    const result = await getSessionSummaryStatus(
      ctx!.kernel,
      c.req.param("id"),
    );
    if (!result) return c.json({ error: "Session not found" }, 404);
    return c.json(result);
  });

  app.get("/api/sessions/:id/pins", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const session = await requireReadableSession(c, c.req.param("id"));
    if (session instanceof Response) return session;
    const scope = c.req.query("scope") === "project" ? "project" : "session";
    if (c.req.query("format") === "summary") {
      return c.json(
        await getPinnedMessageInfos(
          ctx!.kernel.sessions,
          scope,
          c.req.param("id"),
        ),
      );
    }
    return c.json(
      await ctx!.kernel.sessions.getPinnedMessages(c.req.param("id"), scope),
    );
  });

  app.get("/api/project/pins", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const user = currentUser(c);
    const pins = [];
    for (
      const pin of await getPinnedMessageInfos(ctx!.kernel.sessions, "project")
    ) {
      const session = await ctx!.kernel.sessions.getSession(pin.sessionId);
      if (session && canReadSession(user, session)) pins.push(pin);
    }
    if (c.req.query("format") === "context") {
      return c.text(
        formatPinnedMessagesContext("Pinned project messages", pins),
      );
    }
    return c.json(pins);
  });

  app.post("/api/sessions/new", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    if (chat) {
      const result = await chat.clearSession(currentUser(c));
      return c.json(result);
    }
    const user = currentUser(c);
    const session = await ctx!.kernel.sessions.createSession(undefined, {
      ownerUserId: user.id,
      userProfile: user,
    });
    return c.json({ newSessionId: session.id });
  });

  app.post("/api/sessions/clear", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    if (!chat) return c.json({ error: "Chat not initialized" }, 500);
    if (busy) {
      return c.json({
        error: "Agent is busy. Wait for the current turn to complete.",
      }, 409);
    }
    await chat.clearContext();
    return c.json({ ok: true });
  });

  app.post("/api/sessions/compact", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    if (!chat) return c.json({ error: "Chat not initialized" }, 500);
    const body = await c.req.json<{ summary?: string; defer?: boolean }>()
      .catch(() => null);
    if (busy) {
      if (body?.defer) {
        const queued = await queueCompactionForCurrentSession(currentUser(c));
        if (!queued.ok) {
          if (queued.status === 403) {
            return c.json({ error: queued.error }, 403);
          }
          if (queued.status === 404) {
            return c.json({ error: queued.error }, 404);
          }
          if (queued.status === 409) {
            return c.json({ error: queued.error }, 409);
          }
          return c.json({ error: queued.error }, 400);
        }
        return c.json(
          {
            queued: true,
            sessionId: queued.sessionId,
            coalesced: queued.coalesced,
          },
          202,
        );
      }
      return c.json({
        error: "Agent is busy. Wait for the current turn to complete.",
      }, 409);
    }
    if (!body?.summary) return c.json({ error: "summary is required" }, 400);
    try {
      const result = await chat.compactSession(body.summary, currentUser(c));
      return c.json(result);
    } catch (err) {
      return c.json({ error: errorMessage(err) }, 500);
    }
  });

  app.post("/api/sessions/resume", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const body = await c.req.json<{ sessionId: string }>().catch(() => null);
    if (!body?.sessionId) {
      return c.json({ error: "sessionId is required" }, 400);
    }
    const readable = await requireReadableSession(c, body.sessionId);
    if (readable instanceof Response) return readable;
    if (readable.archived) {
      return c.json({
        error: "Archived sessions must be unarchived before resuming",
      }, 409);
    }
    if (!chat) {
      const session = await ctx!.kernel.sessions.getSession(body.sessionId);
      if (!session) return c.json({ error: "Session not found" }, 404);
      await ctx!.kernel.sessions.reopenSession(session.id);
      return c.json({
        newSessionId: session.id,
        session: await ctx!.kernel.sessions.getSession(session.id),
      });
    }
    if (busy) {
      return c.json({
        error: "Agent is busy. Wait for the current turn to complete.",
      }, 409);
    }
    try {
      const result = await chat.resumeSession(body.sessionId, currentUser(c));
      return c.json({
        ...result,
        session: await ctx!.kernel.sessions.getSession(result.newSessionId),
      });
    } catch (err) {
      return c.json({ error: errorMessage(err) }, 500);
    }
  });

  app.post("/api/sessions/:id/rename", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const session = await requireReadableSession(c, c.req.param("id"));
    if (session instanceof Response) return session;
    const body = await c.req.json<{ name: string }>().catch(() => null);
    if (!body?.name) return c.json({ error: "name is required" }, 400);
    await ctx!.kernel.sessions.renameSession(c.req.param("id"), body.name);
    return c.json({ ok: true });
  });

  app.post("/api/sessions/:id/focus", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const session = await requireReadableSession(c, c.req.param("id"));
    if (session instanceof Response) return session;
    const body = await c.req.json<{ pattern: string | null }>().catch(() =>
      null
    );
    await ctx!.kernel.sessions.updateFocus(
      c.req.param("id"),
      body?.pattern ?? null,
    );
    return c.json({ ok: true });
  });

  app.patch("/api/sessions/:id/privacy", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const session = await ctx!.kernel.sessions.getSession(c.req.param("id"));
    if (!session) return c.json({ error: "Session not found" }, 404);
    if (session.ownerUserId !== currentUser(c).id) {
      return c.json({ error: "Forbidden" }, 403);
    }
    const body = await c.req.json<{ visibility?: string }>().catch(() => null);
    if (
      body?.visibility !== "private" && body?.visibility !== "project"
    ) {
      return c.json({ error: "visibility must be private or project" }, 400);
    }
    if (body.visibility === "private" && session.visibility !== "private") {
      const projectPins = await ctx!.kernel.sessions.getPinnedMessages(
        session.id,
        "project",
      );
      await Promise.all(
        projectPins.map((message) =>
          ctx!.kernel.sessions.unpinMessage(message.id, "project")
        ),
      );
    }
    await ctx!.kernel.sessions.updateVisibility(session.id, body.visibility);
    return c.json({
      ok: true,
      session: await ctx!.kernel.sessions.getSession(session.id),
    });
  });

  app.delete("/api/sessions/:id", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const id = c.req.param("id");
    const session = await ctx!.kernel.sessions.getSession(id);
    if (!session) return c.json({ error: "Session not found" }, 404);
    if (!canReadSession(currentUser(c), session)) {
      return c.json({ error: "Forbidden" }, 403);
    }
    const [messages, changesets] = await Promise.all([
      ctx!.kernel.sessions.getMessages(id),
      ctx!.kernel.changesets.list({ sessionId: id, limit: 1 }),
    ]);
    const hardDeleteAllowed = changesets.length === 0 &&
      messages.every(isIgnorableEmptySessionMessage);
    if (!hardDeleteAllowed) {
      await ctx!.kernel.sessions.archiveSession(id);
      await clearActiveChatSessionIf(id);
      return c.json({ ok: true, archived: true, deleted: false });
    }
    await ctx!.kernel.sessions.deleteSession(id);
    if (id === chat?.getCurrentSessionId()) {
      chat?.clearCurrentSession();
      await chat?.clearContext();
    }
    return c.json({ ok: true, archived: false, deleted: true });
  });

  app.post("/api/sessions/:id/archive", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const id = c.req.param("id");
    const session = await ctx!.kernel.sessions.getSession(id);
    if (!session) return c.json({ error: "Session not found" }, 404);
    if (!canReadSession(currentUser(c), session)) {
      return c.json({ error: "Forbidden" }, 403);
    }
    await ctx!.kernel.sessions.archiveSession(id);
    await clearActiveChatSessionIf(id);
    return c.json({
      ok: true,
      session: await ctx!.kernel.sessions.getSession(id),
    });
  });

  app.post("/api/sessions/:id/unarchive", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const id = c.req.param("id");
    const session = await ctx!.kernel.sessions.getSession(id);
    if (!session) return c.json({ error: "Session not found" }, 404);
    if (!canReadSession(currentUser(c), session)) {
      return c.json({ error: "Forbidden" }, 403);
    }
    await ctx!.kernel.sessions.unarchiveSession(id);
    return c.json({
      ok: true,
      session: await ctx!.kernel.sessions.getSession(id),
    });
  });

  app.post("/api/messages/:id/pin", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const body: { scope?: string } = await c.req.json<{ scope?: string }>()
      .catch(() => ({}));
    const scope = body.scope === "project" ? "project" : "session";
    const message = await ctx!.kernel.sessions.getMessage(
      Number(c.req.param("id")),
    );
    if (!message) return c.json({ error: "Message not found" }, 404);
    const session = await ctx!.kernel.sessions.getSession(message.sessionId);
    if (!session) return c.json({ error: "Session not found" }, 404);
    if (!canReadSession(currentUser(c), session)) {
      return c.json({ error: "Forbidden" }, 403);
    }
    if (scope === "project" && session.visibility === "private") {
      return c.json({
        error: "Cannot project-pin messages from a private session",
      }, 400);
    }
    await ctx!.kernel.sessions.pinMessage(Number(c.req.param("id")), scope);
    return c.json({ ok: true });
  });

  app.post("/api/messages/:id/unpin", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const body: { scope?: string } = await c.req.json<{ scope?: string }>()
      .catch(() => ({}));
    const scope = body.scope === "project" ? "project" : "session";
    const message = await ctx!.kernel.sessions.getMessage(
      Number(c.req.param("id")),
    );
    if (!message) return c.json({ error: "Message not found" }, 404);
    const session = await ctx!.kernel.sessions.getSession(message.sessionId);
    if (!session) return c.json({ error: "Session not found" }, 404);
    if (!canReadSession(currentUser(c), session)) {
      return c.json({ error: "Forbidden" }, 403);
    }
    await ctx!.kernel.sessions.unpinMessage(Number(c.req.param("id")), scope);
    return c.json({ ok: true });
  });

  app.delete("/api/messages/:id", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const message = await ctx!.kernel.sessions.getMessage(
      Number(c.req.param("id")),
    );
    if (!message) return c.json({ error: "Message not found" }, 404);
    const session = await ctx!.kernel.sessions.getSession(message.sessionId);
    if (!session) return c.json({ error: "Session not found" }, 404);
    if (!canReadSession(currentUser(c), session)) {
      return c.json({ error: "Forbidden" }, 403);
    }
    const deleted = await ctx!.kernel.sessions.deleteMessage(
      Number(c.req.param("id")),
    );
    if (!deleted) return c.json({ error: "Message not found" }, 404);
    return c.json({ ok: true });
  });

  // --- Usage tracking ---

  app.get("/api/sessions/:id/usage", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const session = await requireReadableSession(c, c.req.param("id"));
    if (session instanceof Response) return session;
    return c.json(
      await ctx!.kernel.sessions.getSessionUsage(c.req.param("id")),
    );
  });

  app.get("/api/usage", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    return c.json(
      await ctx!.kernel.sessions.getProjectUsage({
        since: ctx!.entry.createdAt,
      }),
    );
  });

  app.get("/api/usage/turns/:turnId", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const usage = await ctx!.kernel.sessions.getTurnUsage(
      c.req.param("turnId"),
    );
    if (!usage) return c.json({ error: "Not found" }, 404);
    return c.json(usage);
  });

  app.get("/api/messages/search", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const query = c.req.query("q") ?? "";
    const sessionId = c.req.query("session") || undefined;
    const limit = Number(c.req.query("limit") ?? 20);
    if (!query) return c.json([]);
    if (sessionId) {
      const session = await requireReadableSession(c, sessionId);
      if (session instanceof Response) return session;
    }
    const user = currentUser(c);
    const results = [];
    for (
      const message of await ctx!.kernel.sessions.searchMessages(query, {
        sessionId,
        limit,
      })
    ) {
      const session = await ctx!.kernel.sessions.getSession(message.sessionId);
      if (session && canReadSession(user, session)) results.push(message);
    }
    return c.json(results);
  });

  // --- Analysis ---

  app.get("/api/analysis/call-graph", (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const graph = extractCallGraph(ctx!.kernel);
    return c.json(graph);
  });

  // B1c: "what depends on X" before approving a change to X. Build the graph on
  // demand (O(project) regex scan, same choice as call-graph/B1a — no persistence)
  // and project the reverse index. An unknown or non-graph-node entity is not an
  // error: it returns empty arrays + zero counts (a leaf legitimately affects
  // nothing). :name is decoded — route-style names may contain slashes. Read-only.
  app.get("/api/analysis/blast-radius/:category/:name", (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const category = decodeURIComponent(c.req.param("category"));
    const name = decodeURIComponent(c.req.param("name"));
    const graph = buildKnowledgeGraph(ctx!.kernel);
    return c.json(blastRadiusReport(graph, category, name));
  });

  // --- Audits ---

  // --- Custom Audits ---

  app.get("/api/custom-audits", (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    return c.json(ctx!.kernel.customAudits.list());
  });

  app.get("/api/custom-audits/:name", (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const entry = ctx!.kernel.customAudits.get(c.req.param("name"));
    if (!entry) {
      return c.json({
        error: true,
        code: "NOT_FOUND",
        message: "Custom audit not found",
      }, 404);
    }
    return c.json(entry);
  });

  app.put("/api/custom-audits/:name", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const name = c.req.param("name");
    const body = await readJsonObject(c);
    if (body instanceof Response) return body;
    const description = stringField(body, "description");
    const prompt = stringField(body, "prompt");
    const module = typeof body.module === "string" && body.module.trim()
      ? body.module.trim()
      : undefined;
    if (!description || !prompt) {
      return c.json({
        error: true,
        code: "INVALID_INPUT",
        message: "description and prompt are required",
      }, 400);
    }
    if (BUILTIN_AUDIT_CATEGORIES.includes(name as BuiltInAuditCategory)) {
      return c.json({
        error: true,
        code: "RESERVED_NAME",
        message: `"${name}" is a built-in audit category`,
      }, 400);
    }
    const existing = ctx!.kernel.customAudits.get(name);
    ctx!.kernel.customAudits.register(name, description, prompt, module);
    await ctx!.kernel.changelog.record({
      category: "audit",
      key: name,
      action: existing ? "update" : "create",
      beforeSnapshot: existing ? auditSnapshot(existing) : null,
      afterSnapshot: auditSnapshot(ctx!.kernel.customAudits.get(name)!),
      context: await operatorChangeContext(ctx!.kernel),
    });
    const paths = getProjectPaths(ctx!.entry.path);
    saveKernelState(ctx!.kernel, paths.stateDir);
    return c.json({ ok: true, name });
  });

  app.delete("/api/custom-audits/:name", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const name = c.req.param("name");
    const existing = ctx!.kernel.customAudits.get(name);
    const removed = ctx!.kernel.customAudits.remove(name);
    if (existing && removed) {
      await ctx!.kernel.changelog.record({
        category: "audit",
        key: name,
        action: "delete",
        beforeSnapshot: auditSnapshot(existing),
        afterSnapshot: null,
        context: await operatorChangeContext(ctx!.kernel),
      });
    }
    if (!removed) {
      return c.json({
        error: true,
        code: "NOT_FOUND",
        message: "Custom audit not found",
      }, 404);
    }
    const paths = getProjectPaths(ctx!.entry.path);
    saveKernelState(ctx!.kernel, paths.stateDir);
    return c.json({ ok: true });
  });

  // --- Traces ---

  app.get("/api/traces", (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const limit = Number(c.req.query("limit") ?? 20);
    return c.json(ctx!.kernel.tracer.getRecentTraces(limit || 20));
  });

  app.get("/api/traces/:requestId", (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const trace = ctx!.kernel.tracer.getTrace(c.req.param("requestId"));
    if (!trace) return c.json({ error: "Trace not found" }, 404);
    return c.json(trace);
  });

  app.post("/api/traces/generate", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;

    const routes = ctx!.kernel.routes.list();
    const getRoutes = routes.filter((r) => r.method === "GET");
    if (getRoutes.length === 0) {
      return c.json({ error: "No GET routes to trace" }, 400);
    }

    const port = ctx!.appServer.port;
    const results: Array<{ method: string; path: string; status: number }> = [];
    for (const route of getRoutes) {
      try {
        const res = await fetch(appPreviewUrl(port, route.path));
        results.push({
          method: route.method,
          path: route.path,
          status: res.status,
        });
      } catch {
        results.push({ method: route.method, path: route.path, status: 0 });
      }
    }

    return c.json({ generated: results.length, results });
  });

  // --- Debugger ---

  const debugClients = new Set<{ send: (data: string) => void }>();
  let debugEventsSubscribed = false;

  function subscribeDebugEvents() {
    if (debugEventsSubscribed || !debugManager) return;
    debugEventsSubscribed = true;
    const broadcast = (type: string, payload?: unknown) => {
      const msg = JSON.stringify(
        type === "paused"
          ? { type, pauseState: payload }
          : type === "error"
          ? { type, message: payload }
          : type === "logpoint"
          ? { type, output: payload }
          : { type },
      );
      for (const client of debugClients) {
        try {
          client.send(msg);
        } catch {
          debugClients.delete(client);
        }
      }
    };
    debugManager!.on("paused", (data) => broadcast("paused", data));
    debugManager!.on("resumed", () => broadcast("resumed"));
    debugManager!.on("started", () => broadcast("started"));
    debugManager!.on("stopped", () => broadcast("stopped"));
    debugManager!.on("error", (data) => broadcast("error", data));
    debugManager!.on("logpoint", (data) => broadcast("logpoint", data));
  }

  function requireDebugManager(
    c: { json: (body: unknown, status?: number) => Response },
  ) {
    const guard = requireKernel(c);
    if (guard) return guard;
    if (!debugManager) {
      debugManager = new DebugManager(
        ctx!.kernel,
        ctx!.appServer,
        ctx!.entry.path,
      );

      debugEventsSubscribed = false;
      subscribeDebugEvents();
    }
    return null;
  }

  app.get("/api/debug/status", (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    if (!debugManager) {
      return c.json({
        active: false,
        paused: false,
        pauseState: null,
        appPort: 0,
        breakpoints: [],
        watches: [],
      });
    }
    return c.json(debugManager.status());
  });

  app.post("/api/debug/start", async (c) => {
    const guard = requireDebugManager(c);
    if (guard) return guard;
    if (debugManager!.active) {
      return c.json({ error: "Debug session already active" }, 409);
    }
    try {
      await debugManager!.start();
      return c.json({ ok: true, appPort: debugManager!.debugAppPort });
    } catch (err) {
      ctx!.kernel.log.log(
        "error",
        "system",
        `Debug session failed to start: ${err}`,
      );
      await debugManager!.stop().catch(() => {});
      return c.json({ error: `Failed to start debug session: ${err}` }, 500);
    }
  });

  app.post("/api/debug/stop", async (c) => {
    const guard = requireDebugManager(c);
    if (guard) return guard;
    await debugManager!.stop();
    return c.json({ ok: true });
  });

  app.get("/api/debug/breakpoints", (c) => {
    const guard = requireDebugManager(c);
    if (guard) return guard;
    return c.json(debugManager!.listBreakpoints());
  });

  app.post("/api/debug/breakpoints", async (c) => {
    const guard = requireDebugManager(c);
    if (guard) return guard;
    const body = await c.req.json<
      {
        entityType: string;
        entityName: string;
        line: number;
        condition?: string;
        logMessage?: string;
      }
    >().catch(() => null);
    if (!body?.entityType || !body?.entityName || !body?.line) {
      return c.json(
        { error: "entityType, entityName, and line are required" },
        400,
      );
    }
    const id = await debugManager!.setBreakpoint(
      body.entityType,
      body.entityName,
      body.line,
      body.condition,
      body.logMessage,
    );
    return c.json({ id }, 201);
  });

  app.delete("/api/debug/breakpoints/:id", async (c) => {
    const guard = requireDebugManager(c);
    if (guard) return guard;
    await debugManager!.removeBreakpoint(c.req.param("id"));
    return c.json({ ok: true });
  });

  app.patch("/api/debug/breakpoints/:id/toggle", async (c) => {
    const guard = requireDebugManager(c);
    if (guard) return guard;
    await debugManager!.toggleBreakpoint(c.req.param("id"));
    return c.json({ ok: true });
  });

  app.post("/api/debug/breakpoints/enable-all", async (c) => {
    const guard = requireDebugManager(c);
    if (guard) return guard;
    await debugManager!.enableAllBreakpoints(true);
    return c.json({ ok: true });
  });

  app.post("/api/debug/breakpoints/disable-all", async (c) => {
    const guard = requireDebugManager(c);
    if (guard) return guard;
    await debugManager!.enableAllBreakpoints(false);
    return c.json({ ok: true });
  });

  app.delete("/api/debug/breakpoints", async (c) => {
    const guard = requireDebugManager(c);
    if (guard) return guard;
    await debugManager!.removeAllBreakpoints();
    return c.json({ ok: true });
  });

  app.get("/api/debug/watches", (c) => {
    const guard = requireDebugManager(c);
    if (guard) return guard;
    return c.json(debugManager!.listWatches());
  });

  app.post("/api/debug/watches", async (c) => {
    const guard = requireDebugManager(c);
    if (guard) return guard;
    const body = await c.req.json<{ expression: string }>().catch(() => null);
    if (!body?.expression) {
      return c.json({ error: "expression is required" }, 400);
    }
    debugManager!.addWatch(body.expression);
    return c.json({ ok: true }, 201);
  });

  app.delete("/api/debug/watches/:expression", (c) => {
    const guard = requireDebugManager(c);
    if (guard) return guard;
    debugManager!.removeWatch(decodeURIComponent(c.req.param("expression")));
    return c.json({ ok: true });
  });

  app.post("/api/debug/continue", async (c) => {
    const guard = requireDebugManager(c);
    if (guard) return guard;
    await debugManager!.resume();
    return c.json({ ok: true });
  });

  app.post("/api/debug/step-over", async (c) => {
    const guard = requireDebugManager(c);
    if (guard) return guard;
    await debugManager!.stepOver();
    return c.json({ ok: true });
  });

  app.post("/api/debug/step-into", async (c) => {
    const guard = requireDebugManager(c);
    if (guard) return guard;
    await debugManager!.stepInto();
    return c.json({ ok: true });
  });

  app.post("/api/debug/step-out", async (c) => {
    const guard = requireDebugManager(c);
    if (guard) return guard;
    await debugManager!.stepOut();
    return c.json({ ok: true });
  });

  app.post("/api/debug/pause", async (c) => {
    const guard = requireDebugManager(c);
    if (guard) return guard;
    await debugManager!.pause();
    return c.json({ ok: true });
  });

  app.get("/api/debug/variables/:frameId", async (c) => {
    const guard = requireDebugManager(c);
    if (guard) return guard;
    const vars = await debugManager!.getVariables(c.req.param("frameId"));
    return c.json(vars);
  });

  app.post("/api/debug/evaluate", async (c) => {
    const guard = requireDebugManager(c);
    if (guard) return guard;
    const body = await c.req.json<
      { expression: string; callFrameId?: string }
    >().catch(() => null);
    if (!body?.expression) {
      return c.json({ error: "expression is required" }, 400);
    }
    const result = await debugManager!.evaluate(
      body.expression,
      body.callFrameId,
    );
    return c.json(result);
  });

  app.post("/api/debug/expand", async (c) => {
    const guard = requireDebugManager(c);
    if (guard) return guard;
    const body = await c.req.json<{ objectId: string }>().catch(() => null);
    if (!body?.objectId) return c.json({ error: "objectId is required" }, 400);
    const vars = await debugManager!.expandObject(body.objectId);
    return c.json(vars);
  });

  app.get(
    "/debug",
    wsOriginGuard,
    upgradeWebSocket((c) => {
      const userPromise = auth.resolveUser(c.req.raw);
      return {
        async onOpen(_evt, ws) {
          const user = await userPromise;
          if (!user) {
            ws.close(1008, "Unauthorized");
            return;
          }
          debugClients.add(ws);
          if (debugManager) subscribeDebugEvents();
        },
        onClose(_evt, ws) {
          debugClients.delete(ws);
        },
      };
    }),
  );

  // --- Language Service ---

  const VALID_ENTITY_TYPES = new Set(["handler", "function", "test"]);
  const ENTITY_NAME_RE = /^[a-zA-Z0-9_-]+$/;

  function validateEntity(
    c: Context,
    entityType: string,
    entityName: string,
    line?: unknown,
    column?: unknown,
  ) {
    if (!VALID_ENTITY_TYPES.has(entityType)) {
      return c.json({ error: "Invalid entityType" }, 400);
    }
    if (!ENTITY_NAME_RE.test(entityName)) {
      return c.json({ error: "Invalid entityName" }, 400);
    }
    if (line !== undefined && (typeof line !== "number" || !isFinite(line))) {
      return c.json({ error: "line must be a finite number" }, 400);
    }
    if (
      column !== undefined && (typeof column !== "number" || !isFinite(column))
    ) {
      return c.json({ error: "column must be a finite number" }, 400);
    }
    return null;
  }

  app.post("/api/language/completions", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const { entityType, entityName, line, column, content } = await c.req.json<{
      entityType: string;
      entityName: string;
      line: number;
      column: number;
      content?: string;
    }>();
    const v = validateEntity(c, entityType, entityName, line, column);
    if (v) return v;
    try {
      const items = await ctx!.kernel.runtime.getCompletions?.(
        entityType,
        entityName,
        line,
        column,
        ctx!.kernel,
        content,
      ) ?? [];
      return c.json({ items });
    } catch {
      return c.json({ items: [] });
    }
  });

  app.post("/api/language/diagnostics", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const { entityType, entityName, content } = await c.req.json<{
      entityType: string;
      entityName: string;
      content?: string;
    }>();
    const v = validateEntity(c, entityType, entityName);
    if (v) return v;
    try {
      // Same merged path (TS ⊕ QC ⊕ verification) the LSP push uses, so the payload
      // carries a per-diagnostic `source` and the IDE lint gutter shows QC violations
      // alongside compiler errors (docs/lsp-support-plan.md Stage 2).
      const diagnostics = await getMergedDiagnostics(
        ctx!.kernel,
        entityType,
        entityName,
        content,
      );
      return c.json({ diagnostics });
    } catch {
      return c.json({ diagnostics: [] });
    }
  });

  app.post("/api/language/hover", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const { entityType, entityName, line, column, content } = await c.req.json<{
      entityType: string;
      entityName: string;
      line: number;
      column: number;
      content?: string;
    }>();
    const v = validateEntity(c, entityType, entityName, line, column);
    if (v) return v;
    try {
      const result = await ctx!.kernel.runtime.getHoverInfo?.(
        entityType,
        entityName,
        line,
        column,
        ctx!.kernel,
        content,
      ) ?? null;
      return c.json({ result });
    } catch {
      return c.json({ result: null });
    }
  });

  app.post("/api/language/definition", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const { entityType, entityName, line, column, content } = await c.req.json<{
      entityType: string;
      entityName: string;
      line: number;
      column: number;
      content?: string;
    }>();
    const v = validateEntity(c, entityType, entityName, line, column);
    if (v) return v;
    try {
      const definitions = await ctx!.kernel.runtime.getDefinition?.(
        entityType,
        entityName,
        line,
        column,
        ctx!.kernel,
        content,
      ) ?? [];
      return c.json({ definitions });
    } catch {
      return c.json({ definitions: [] });
    }
  });

  app.post("/api/language/references", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const { entityType, entityName, line, column, content } = await c.req.json<{
      entityType: string;
      entityName: string;
      line: number;
      column: number;
      content?: string;
    }>();
    const v = validateEntity(c, entityType, entityName, line, column);
    if (v) return v;
    try {
      const references = await ctx!.kernel.runtime.getReferences?.(
        entityType,
        entityName,
        line,
        column,
        ctx!.kernel,
        content,
      ) ?? [];
      return c.json({ references });
    } catch {
      return c.json({ references: [] });
    }
  });

  app.post("/api/language/highlights", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const { entityType, entityName, line, column, content } = await c.req.json<{
      entityType: string;
      entityName: string;
      line: number;
      column: number;
      content?: string;
    }>();
    const v = validateEntity(c, entityType, entityName, line, column);
    if (v) return v;
    try {
      const highlights = await ctx!.kernel.runtime.getDocumentHighlights?.(
        entityType,
        entityName,
        line,
        column,
        ctx!.kernel,
        content,
      ) ?? [];
      return c.json({ highlights });
    } catch {
      return c.json({ highlights: [] });
    }
  });

  app.post("/api/language/rename-locations", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const { entityType, entityName, line, column, content } = await c.req.json<{
      entityType: string;
      entityName: string;
      line: number;
      column: number;
      content?: string;
    }>();
    const v = validateEntity(c, entityType, entityName, line, column);
    if (v) return v;
    try {
      const locations = await ctx!.kernel.runtime.getRenameLocations?.(
        entityType,
        entityName,
        line,
        column,
        ctx!.kernel,
        content,
      ) ?? [];
      return c.json({ locations });
    } catch {
      return c.json({ locations: [] });
    }
  });

  app.post("/api/language/ai-completions", async (c) => {
    const guard = requireKernel(c);
    if (guard) return guard;
    const {
      entityType,
      entityName,
      content,
      line,
      column,
      language,
      siblingContext,
    } = await c.req.json<{
      entityType: string;
      entityName: string;
      content: string;
      line: number;
      column: number;
      language?: string;
      siblingContext?: string;
    }>();
    if (!content) return c.json({ suggestions: [] });

    const lines = content.split("\n");
    const prefix = lines.slice(0, line - 1).join("\n") +
      (line > 1 ? "\n" : "") + (lines[line - 1]?.slice(0, column - 1) ?? "");
    const suffix = (lines[line - 1]?.slice(column - 1) ?? "") + "\n" +
      lines.slice(line).join("\n");

    const langHint = language ? ` (${language})` : "";
    const contextBlock = siblingContext
      ? `\n\nAvailable entities in this project:\n${siblingContext}`
      : "";

    // D9: no configured utility model → no suggestions rather than a modelless call.
    const model = getUtilityModelForRequest();
    if (!model) return c.json({ suggestions: [] });
    const apiKey = getProviderKey(providerFor(model));
    if (!apiKey) {
      return c.json({ error: "No API key configured" }, 500);
    }

    try {
      const { text } = await callUtilityModel({
        model,
        maxTokens: 512,
        system:
          `You are an inline code completion engine for a ${entityType} named "${entityName}"${langHint}. Given code with a cursor position marked by <CURSOR>, return 1-3 short code completions that would naturally continue from the cursor. Each completion should be a code snippet (just the inserted text, no explanation). Return ONLY a JSON array of strings, nothing else.${contextBlock}`,
        user: `Complete the ${
          language ?? "code"
        } at <CURSOR>:\n\n${prefix}<CURSOR>${suffix}`,
        accounting: {
          role: "utility",
          caller: "inline_completion",
          recordUsage: (input) => ctx!.kernel.sessions.recordModelUsage(input),
          metadata: {
            entityType,
            entityName,
            language: language ?? null,
            line,
            column,
          },
        },
      });

      const match = text.match(/\[[\s\S]*\]/);
      if (!match) return c.json({ suggestions: [] });
      const suggestions = JSON.parse(match[0]) as string[];
      return c.json({
        suggestions: suggestions.filter((s): s is string =>
          typeof s === "string" && s.length > 0
        ).slice(0, 3),
      });
    } catch {
      return c.json({ suggestions: [] });
    }
  });

  app.get(
    "/terminal",
    wsOriginGuard,
    upgradeWebSocket((c) => {
      const userPromise = auth.resolveUser(c.req.raw);
      const repl = new ReplSession();
      return {
        async onOpen(_evt, ws) {
          const user = await userPromise;
          if (!user) {
            ws.close(1008, "Unauthorized");
            return;
          }
          if (ctx) {
            repl.attach(ctx.kernel);
            repl.setCwd(ctx.entry.path);
          }
          repl.setAgentFn(async (question: string) => {
            if (!chat) {
              return "\x1b[91mNo agent connected. Set an API key in Settings.\x1b[0m";
            }
            if (busy) {
              return "\x1b[91mAgent is busy. Wait for current turn to finish.\x1b[0m";
            }
            const activeChat = chat;
            busy = true;
            beginActiveTurn();
            try {
              await ctx!.kernel.changelog.withActor(
                user.id,
                () =>
                  activeChat.sendMessage(
                    question,
                    (event) => {
                      if (event.type === "text_delta" && event.text) {
                        ws.send(
                          JSON.stringify({
                            type: "agent_delta",
                            text: event.text,
                          }),
                        );
                      } else if (
                        event.type === "tool_use_start" && event.toolName
                      ) {
                        ws.send(
                          JSON.stringify({
                            type: "agent_delta",
                            text:
                              `\x1b[90m[calling ${event.toolName}...]\x1b[0m\n`,
                          }),
                        );
                      }
                    },
                    undefined,
                    undefined,
                    undefined,
                    user,
                  ),
              );
              ws.send(JSON.stringify({ type: "agent_delta", text: "\r\n" }));
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              ws.send(
                JSON.stringify({
                  type: "agent_delta",
                  text: `\x1b[91m${msg}\x1b[0m\r\n`,
                }),
              );
            } finally {
              await flushPendingCompaction(activeChat);
              busy = false;
              finishActiveTurn();
            }
            return "";
          });
          ws.send(JSON.stringify({ type: "ready" }));
        },
        onMessage(evt, ws) {
          try {
            const msg = JSON.parse(String(evt.data)) as {
              type: string;
              code?: string;
              command?: string;
              line?: string;
              pos?: number;
            };
            if (msg.type === "shell" && msg.command) {
              repl.shell(msg.command).then((result) => {
                ws.send(JSON.stringify({ type: "result", ...result }));
              });
            } else if (msg.type === "eval" && msg.code) {
              if (!ctx) {
                ws.send(
                  JSON.stringify({ type: "error", value: "No project open" }),
                );
                return;
              }
              repl.attach(ctx.kernel);
              repl.setCwd(ctx.entry.path);
              repl.eval(msg.code).then((result) => {
                ws.send(JSON.stringify({ type: "result", ...result }));
              });
            } else if (
              msg.type === "complete" && msg.line != null && msg.pos != null
            ) {
              if (ctx) {
                repl.attach(ctx.kernel);
                repl.setCwd(ctx.entry.path);
              }
              const result = repl.complete(msg.line, msg.pos);
              ws.send(JSON.stringify({ type: "completions", ...result }));
            }
          } catch {
            ws.send(
              JSON.stringify({ type: "error", value: "Invalid message" }),
            );
          }
        },
        onClose() {},
      };
    }),
  );

  app.get(
    "/api/projects/recovery/chat",
    wsOriginGuard,
    upgradeWebSocket((c) => {
      const userPromise = auth.resolveUser(c.req.raw);
      let runtime: RecoveryChatRuntime | null = null;
      let recoveryBusy = false;
      return {
        async onOpen(_evt, ws) {
          const user = await userPromise;
          if (!user) {
            ws.close(1008, "Unauthorized");
            return;
          }
          ws.send(JSON.stringify({ type: "ready" }));
        },
        async onMessage(evt, ws) {
          const user = await userPromise;
          if (!user) {
            ws.close(1008, "Unauthorized");
            return;
          }
          let data: {
            type?: string;
            projectPath?: string;
            path?: string;
            text?: string;
            content?: string;
            failedOpenError?: string;
          };
          try {
            data = JSON.parse(String(evt.data));
          } catch {
            ws.send(JSON.stringify({ type: "error", text: "Invalid JSON" }));
            return;
          }
          if (data.type === "cancel") {
            runtime?.abort();
            return;
          }
          const projectPath = data.projectPath ?? data.path;
          const text = data.text ?? data.content;
          if (!projectPath || !text) {
            ws.send(
              JSON.stringify({
                type: "error",
                text: "Expected { projectPath, text }",
              }),
            );
            return;
          }
          if (recoveryBusy) {
            ws.send(
              JSON.stringify({
                type: "error",
                text: "Recovery console is busy. Wait for message_complete.",
              }),
            );
            return;
          }
          if (!opts.recoveryChatFactory) {
            ws.send(
              JSON.stringify({
                type: "error",
                text:
                  "Recovery console assistant is not initialized. Use the recovery actions shown.",
              }),
            );
            return;
          }
          recoveryBusy = true;
          runtime = opts.recoveryChatFactory();
          try {
            await runtime.sendMessage(
              {
                projectPath,
                text,
                ...(data.failedOpenError
                  ? { failedOpenError: data.failedOpenError }
                  : {}),
              },
              (event) => {
                try {
                  ws.send(JSON.stringify(event));
                } catch { /* ws closing */ }
              },
            );
          } finally {
            runtime = null;
            recoveryBusy = false;
          }
        },
        onClose() {
          runtime?.abort();
          runtime = null;
          recoveryBusy = false;
        },
      };
    }),
  );

  function sendToChat(data: unknown): void {
    try {
      currentChatWs?.send(JSON.stringify(data));
    } catch { /* ws closing */ }
  }

  app.get(
    "/chat",
    wsOriginGuard,
    upgradeWebSocket((c) => {
      const userPromise = auth.resolveUser(c.req.raw);
      return {
        async onOpen(_evt, ws) {
          const user = await userPromise;
          if (!user) {
            ws.close(1008, "Unauthorized");
            return;
          }
          currentChatWs = ws;
          if (busy && chat) {
            const state = chat.getInProgressState("compact");
            if (state) {
              ws.send(JSON.stringify({
                type: "agent_status",
                busy: true,
                text: state.text,
                toolCalls: state.toolCalls,
                segmentText: state.segmentText,
                segmentToolCalls: state.segmentToolCalls,
              }));
            } else {
              ws.send(JSON.stringify({ type: "agent_status", busy: true }));
            }
          }
        },
        async onMessage(evt, ws) {
          const user = await userPromise;
          if (!user) {
            ws.close(1008, "Unauthorized");
            return;
          }
          currentChatWs = ws;

          if (!ctx) {
            ws.send(JSON.stringify({ type: "error", text: "No project open" }));
            return;
          }
          if (!chat) {
            ws.send(
              JSON.stringify({
                type: "error",
                text:
                  "AI agent not initialized. Set a valid API key in Settings.",
              }),
            );
            return;
          }

          let activeTurnStartedForMessage = false;
          try {
            const data = JSON.parse(String(evt.data)) as {
              type: string;
              sessionId?: string | null;
              content?: string;
              attachments?: Array<{ name: string; type: string; data: string }>;
              rerun?: boolean;
              changesetId?: string;
              documentRefs?: Array<{ id: string; versionHash?: string }>;
            };
            if (data.type === "cancel") {
              if (busy && chat) {
                chat.abort();
              }
              return;
            }
            if (data.type !== "user_message" || !data.content) {
              ws.send(
                JSON.stringify({
                  type: "error",
                  text: "Expected { type: 'user_message', content: string }",
                }),
              );
              return;
            }
            const activeChat = chat;
            const content = data.content;
            if (!activeChat) {
              ws.send(
                JSON.stringify({
                  type: "error",
                  text:
                    "AI agent not initialized. Set a valid API key in Settings.",
                }),
              );
              return;
            }
            if (busy) {
              ws.send(
                JSON.stringify({
                  type: "error",
                  text: "Agent is busy. Wait for message_complete.",
                }),
              );
              ctx!.kernel.log.log(
                "warn",
                "agent",
                "Message rejected: agent is busy",
              );
              return;
            }
            busy = true;
            beginActiveTurn();
            activeTurnStartedForMessage = true;
            if (data.sessionId) {
              const session = await ctx!.kernel.sessions.getSession(
                data.sessionId,
              );
              if (!session) {
                busy = false;
                finishActiveTurn();
                ws.send(
                  JSON.stringify({ type: "error", text: "Session not found" }),
                );
                return;
              }
              if (!canReadSession(user, session)) {
                busy = false;
                finishActiveTurn();
                ws.send(JSON.stringify({ type: "error", text: "Forbidden" }));
                return;
              }
              if (session.archived) {
                busy = false;
                finishActiveTurn();
                ws.send(
                  JSON.stringify({
                    type: "error",
                    text: "Archived sessions must be unarchived before sending",
                  }),
                );
                return;
              }
              if (activeChat.getCurrentSessionId() !== data.sessionId) {
                try {
                  await activeChat.resumeSession(data.sessionId, user);
                  sendToChat({
                    type: "system_message",
                    text:
                      "Agent context was realigned with the active visible session before sending.",
                  });
                } catch (err) {
                  busy = false;
                  finishActiveTurn();
                  const msg = err instanceof Error ? err.message : String(err);
                  ws.send(JSON.stringify({ type: "error", text: msg }));
                  ctx!.kernel.log.log("error", "agent", msg);
                  return;
                }
              }
            }
            if (!data.sessionId) {
              const activeSessionId = activeChat.getCurrentSessionId();
              if (activeSessionId) {
                const session = await ctx!.kernel.sessions.getSession(
                  activeSessionId,
                );
                if (
                  !session || session.archived ||
                  !canReadSession(user, session)
                ) {
                  if (session?.archived) {
                    await ctx!.kernel.sessions.endSession(activeSessionId);
                  }
                  activeChat.clearCurrentSession();
                  await activeChat.clearContext();
                }
              }
            }
            if (data.rerun) {
              await activeChat.clearContext();
            }
            telemetry.track("chat_message_sent", {
              message_has_attachments: (data.attachments?.length ?? 0) > 0,
              active_project: true,
              active_changeset: Boolean(data.changesetId),
              rerun: Boolean(data.rerun),
            });
            maybeSyncTelemetry();
            try {
              let turnHadChangeset = false;
              ctx!.kernel.changelog.withActor(
                user.id,
                () =>
                  activeChat.sendMessage(
                    content,
                    (event) => {
                      sendToChat(event);
                      if (event.type === "turn_usage" && event.usage) {
                        telemetry.track("agent_turn_completed", {
                          duration_ms: event.usage.durationMs,
                          tool_calls_count: event.usage.toolCallsCount,
                          input_tokens_bucket: bucketTokens(
                            contextOccupancyTokens(event.usage),
                          ),
                          output_tokens_bucket: bucketTokens(
                            event.usage.outputTokens,
                          ),
                          estimated_cost_usd_bucket: bucketCost(
                            event.usage.costUsd,
                          ),
                          model_family: modelFamily(event.usage.model),
                          completed_with_changeset: turnHadChangeset,
                        });
                        maybeSyncTelemetry();
                      }
                      if (event.type === "error" && event.text) {
                        ctx!.kernel.log.log("error", "agent", event.text);
                        telemetry.track("agent_turn_failed", {
                          failure_kind: "stream_error",
                          model_family: "unknown",
                        });
                        maybeSyncTelemetry();
                      }
                      if (
                        event.type === "changeset_created" && event.changeset
                      ) {
                        turnHadChangeset = true;
                        const changeset = event.changeset as {
                          status?: string;
                          changes?: unknown[];
                          plan?: unknown;
                        };
                        telemetry.track("changeset_created", {
                          changeset_kind: changeset.plan ? "plan" : "direct",
                          change_count: Array.isArray(changeset.changes)
                            ? changeset.changes.length
                            : 0,
                        });
                        maybeSyncTelemetry();
                      }
                      if (
                        event.type === "tool_use_end" && event.toolName &&
                        isMutationTool(event.toolName)
                      ) {
                        sendToChat({ type: "reload_preview" });
                      }
                    },
                    data.attachments,
                    addAttachmentSourcesToContent(content, data.attachments),
                    data.changesetId,
                    user,
                    data.documentRefs,
                  ),
              ).catch((err) => {
                const msg = err instanceof Error ? err.message : String(err);
                sendToChat({ type: "error", text: msg });
                ctx!.kernel.log.log("error", "agent", msg);
                telemetry.track("agent_turn_failed", {
                  failure_kind: "send_message_error",
                  model_family: "unknown",
                });
                maybeSyncTelemetry();
              }).finally(async () => {
                await flushPendingCompaction(activeChat, sendToChat);
                busy = false;
                sendToChat({ type: "agent_status", busy: false });
                finishActiveTurn();
              });
            } catch (err) {
              busy = false;
              finishActiveTurn();
              activeTurnStartedForMessage = false;
              const msg = err instanceof Error ? err.message : String(err);
              ws.send(JSON.stringify({ type: "error", text: msg }));
              ctx!.kernel.log.log("error", "agent", msg);
              telemetry.track("agent_turn_failed", {
                failure_kind: "send_message_exception",
                model_family: "unknown",
              });
              maybeSyncTelemetry();
            }
          } catch {
            if (activeTurnStartedForMessage) {
              busy = false;
              finishActiveTurn();
            }
            ws.send(JSON.stringify({ type: "error", text: "Invalid JSON" }));
          }
        },
      };
    }),
  );

  // Let upper layers contribute their routes (OpenTide §3.3). Mounted here —
  // after all core routes and their middleware (auth/CORS), before the static
  // catch-all — so contributed routes are auth-guarded and not shadowed.
  const coreRoutes: CoreRouteContext = {
    requireKernel,
    project: () => ({ path: ctx!.entry.path, name: ctx!.entry.name }),
    kernel: () => ctx!.kernel,
    rebuild: () => ctx!.rebuild(),
    serverToken: () => serverToken,
    onProjectClose: (listener) => {
      projectCloseListeners.push(listener);
    },
    track: (event, properties) => {
      telemetry.track(event, properties);
      maybeSyncTelemetry();
    },
  };
  for (const mount of opts.mountRoutes ?? []) mount(app, coreRoutes);

  if (opts.staticUiDir) {
    app.get("*", (c) => serveStaticUi(c, opts.staticUiDir!));
    app.on("HEAD", "*", (c) => serveStaticUi(c, opts.staticUiDir!));
  }

  const server = Deno.serve(
    { hostname: DEV_SERVER_HOST, port, onListen: () => {} },
    (req) => app.fetch(req),
  );
  advertiseProject();

  const setProject = {
    async open(path: string): Promise<ProjectEntry> {
      await closeCurrentProject();
      await openAndInitProject(path);
      return ctx!.entry;
    },
    current(): ProjectContext | null {
      return ctx;
    },
    // Unload the open project the way a switch does: chat, debugger, MCP
    // sessions and the other project-close listeners first. Shutdown needs
    // this: an MCP session left open holds its SSE response, and
    // server.shutdown() waits for every response to finish.
    close(): Promise<void> {
      return closeCurrentProject();
    },
  };

  return { server, chat, setProject };
}
