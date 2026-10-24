// @layer lsp — the wire vocabulary of the Language Server Protocol, isolated to
// one module so no method name, error code, or enum value is ever inlined as a
// magic string elsewhere in the layer (CLAUDE.md: no magic strings). These are
// pure constants + type shapes; all behavior lives in server.ts / documents.ts.
//
// We deliberately hand-declare the minimal LSP subset Stage 0 needs rather than
// pull in `vscode-languageserver-protocol` — the adapter translates a handful of
// shapes and a new npm dependency would earn its keep only once the write path
// (Stages 3+) needs the richer types. Keep this a strict subset of the real spec.
import type { ReadinessEnforcement } from "../core/types.ts";

// --- JSON-RPC 2.0 base protocol (LSP rides on this) ---

export const JSONRPC_VERSION = "2.0";

// A request expects a response (has an `id`); a notification does not (no `id`).
// One incoming-message shape covers both — `id` present ⇒ request.
export interface RequestMessage {
  jsonrpc: typeof JSONRPC_VERSION;
  id: number | string;
  method: string;
  params?: unknown;
}

export interface NotificationMessage {
  jsonrpc: typeof JSONRPC_VERSION;
  method: string;
  params?: unknown;
}

export type IncomingMessage = RequestMessage | NotificationMessage;

export interface ResponseError {
  code: number;
  message: string;
  data?: unknown;
}

export interface ResponseMessage {
  jsonrpc: typeof JSONRPC_VERSION;
  id: number | string | null;
  result?: unknown;
  error?: ResponseError;
}

// True when a decoded message carries an `id` — i.e. it is a request that MUST be
// answered with a ResponseMessage (a notification must not be).
export function isRequest(message: IncomingMessage): message is RequestMessage {
  return "id" in message && (message as RequestMessage).id !== undefined;
}

// JSON-RPC + LSP error codes (LSP reserves a band starting at -32899). Only the
// ones Stage 0 can actually emit are declared.
export const ErrorCodes = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  // LSP-specific: a request arrived before `initialize` completed.
  ServerNotInitialized: -32002,
  // LSP-specific: the request was valid but the server declines to fulfill it
  // (e.g. a write request while the write feature flag is off).
  RequestFailed: -32803,
} as const;

// --- LSP method names ---

export const LspMethods = {
  Initialize: "initialize",
  Initialized: "initialized",
  Shutdown: "shutdown",
  Exit: "exit",
  DidOpen: "textDocument/didOpen",
  DidChange: "textDocument/didChange",
  DidClose: "textDocument/didClose",
  // Stage 3 write path (docs/lsp-support-plan.md Stage 3): the editor's ⌘S. A
  // notification (no response); the server persists the buffer through the
  // define_* upsert and surfaces the outcome via publishDiagnostics + showMessage.
  DidSave: "textDocument/didSave",
  // Stage 1 read-only language features (docs/lsp-support-plan.md §6). Each is a
  // request the server answers by delegating to a kernel.runtime.get* method.
  Completion: "textDocument/completion",
  Hover: "textDocument/hover",
  Definition: "textDocument/definition",
  References: "textDocument/references",
  DocumentHighlight: "textDocument/documentHighlight",
  // The one server→client PUSH (a notification, not a request): the server
  // publishes diagnostics for an open document on didOpen/didChange.
  PublishDiagnostics: "textDocument/publishDiagnostics",
  // Server→client status toast (Stage 3): the vanilla-LSP surface for a save
  // outcome that isn't a squiggle ("saved", "rejected", "read-only"). Chosen over
  // a opentide/* custom notification so plain clients still show it (plan §11.4).
  ShowMessage: "window/showMessage",
  // The ONE custom (opentide/*) notification Stage 4 introduces (plan §11.4): a
  // structured "your save is held as a pending changeset" push, carrying the
  // changeset id + state + how to approve — the one thing vanilla window/showMessage
  // can't express. Rich clients wire an approve affordance off it; plain clients
  // ignore it and fall back to the parallel showMessage, losing nothing structural.
  ChangesetStatus: "opentide/changesetStatus",
  // The SECOND custom (opentide/*) notification, added in Stage 5 (plan §11.4): a
  // server-initiated document refresh. LSP has no way for a server to replace an
  // open editor buffer, so when an entity changes underneath the editor — an
  // out-of-band agent write, or a rejected STALE_WRITE save — the server pushes the
  // authoritative content + new revision here. Rich clients replace the buffer and
  // re-sync; plain clients ignore it and are caught by STALE_WRITE on their next save.
  DocumentChanged: "opentide/documentChanged",
  // Stage 6 creation (docs/lsp-support-plan.md Stage 6, §11.3): the supported path
  // for making a NEW entity. A bare file carries no entity metadata (route schema,
  // module, purpose — plan §3 "Metadata gap"), so creation is a client→server REQUEST
  // (returns a result, unlike didSave) carrying the full metadata form. The server's
  // command handler calls the define_* upsert (+ optional register_route) with those
  // args. didSave stays edit-only; this is how a new entity is born over LSP.
  ExecuteCommand: "workspace/executeCommand",
  // Stage 6 trigger (a nicety, not the exit criterion): a client tells the server it
  // created a opentide:// file. The server does NOT silently under-specified-create — it
  // points the user at the ExecuteCommand flow (a showMessage) and defines nothing.
  DidCreateFiles: "workspace/didCreateFiles",
  // Stage 7 write path (docs/lsp-support-plan.md Stage 7): rename a symbol across every
  // entity that references it. A REQUEST (returns a WorkspaceEdit, like completion — not
  // a notification like didSave). The server runs getRenameLocations, builds one
  // WorkspaceEdit spanning all affected opentide:// docs, applies it ATOMICALLY through the
  // governed tool layer (all-or-nothing, one reversible turn), and returns the
  // WorkspaceEdit so the client reconciles its open buffers. Advertised (renameProvider)
  // only behind the write flag — rename is a write.
  Rename: "textDocument/rename",
} as const;

// Severity of a window/showMessage toast (numeric on the wire, per the LSP spec).
// Stage 3 uses Info for a clean save, Warning for a governance rejection, Error
// for a malformed/unsupported request.
export const MessageType = {
  Error: 1,
  Warning: 2,
  Info: 3,
  Log: 4,
} as const;

// window/showMessage payload: a type + the human-readable text the editor toasts.
export interface ShowMessageParams {
  type: number;
  message: string;
}

// opentide/changesetStatus payload (Stage 4): the structured "this save is gated"
// push. `changesetId` + `status` name the pending _genie_changeset; `reason`
// explains why it was held; `approvalHint` describes how to resolve it (Stage 4
// approval runs through the changeset store's approve(id) — there is no LSP
// approve request yet, so the hint is descriptive, not a callable endpoint).
export interface ChangesetStatusParams {
  changesetId: string;
  status: string;
  title: string;
  reason: string;
  approvalHint: string;
}

// workspace/executeCommand payload (Stage 6): `command` names the server command
// (only opentide.createEntity exists); `arguments` carries the client's positional
// args. The createEntity command takes a single structured object at arguments[0]
// (see CreateEntityArgs in server.ts) — the metadata form a VS Code extension
// collects, or an agent/plain client passes directly. Unlike didSave this is a
// request, so the server answers with a CreateEntityResult.
export interface ExecuteCommandParams {
  command: string;
  arguments?: unknown[];
}

// The wire result of a opentide.createEntity command (Stage 6). `created` is whether the
// entity persisted through the tool layer; on a governance rejection it is false and
// `code`/`message` carry the tool's reason (QC_FAILED, POSSIBLE_DUPLICATE_ENTITY, …) —
// the editor-facing squiggles/toasts are ALSO pushed via the reportPersistResult
// funnel, so a plain client that ignores this result still sees the outcome. `route`
// is present only when a handler+route create was requested; `bound` reports whether
// register_route succeeded (a create can partially succeed: handler made, route not).
export interface CreateEntityResult {
  created: boolean;
  entityType: string;
  entityName: string;
  uri: string;
  code?: string;
  message?: string;
  route?: { method: string; path: string; bound: boolean };
}

// workspace/didCreateFiles payload (Stage 6 trigger): the files a client just created.
// The server filters for opentide:// URIs and points them at the create command; it
// creates nothing (a bare file has no metadata to define an entity from — plan §3).
export interface FileCreate {
  uri: string;
}

export interface DidCreateFilesParams {
  files: FileCreate[];
}

// The registration options for the workspace.fileOperations.didCreate capability
// (Stage 6): the filters that tell the client which created files to notify us about.
// We register the opentide:// scheme so only virtual entity files trigger didCreateFiles.
export interface FileOperationPattern {
  glob: string;
}

export interface FileOperationFilter {
  scheme?: string;
  pattern: FileOperationPattern;
}

export interface FileOperationRegistrationOptions {
  filters: FileOperationFilter[];
}

// opentide/documentChanged payload (Stage 5): the server-initiated refresh. `revision`
// is the entity's new monotonic revision; `content` is the authoritative registry
// source the client should replace its buffer with (the client can't otherwise
// re-read a virtual opentide:// entity). A rich client, on receiving this, replaces the
// buffer and re-opens/changes to re-seed the synced revision.
export interface DocumentChangedParams {
  uri: string;
  revision: number;
  content: string;
}

// --- Text document sync ---

// How the server wants document changes delivered. Stage 0 advertises `Full`:
// each didChange carries the whole buffer, which maps 1:1 onto the language
// service's full-content `sync` override (no range-patch bookkeeping). Switching
// to `Incremental` is a later optimization, not a Stage-0 concern.
export const TextDocumentSyncKind = {
  None: 0,
  Full: 1,
  Incremental: 2,
} as const;

// --- Position & range (0-based, per the LSP spec) ---
// The service speaks 1-based line/column; positions.ts is the ONLY place that
// bridges the two. These shapes are the 0-based LSP side.

export interface Position {
  line: number;
  character: number;
}

export interface Range {
  start: Position;
  end: Position;
}

// --- didOpen / didChange / didClose params ---

export interface TextDocumentIdentifier {
  uri: string;
}

export interface VersionedTextDocumentIdentifier
  extends TextDocumentIdentifier {
  version: number;
}

export interface TextDocumentItem {
  uri: string;
  languageId: string;
  version: number;
  text: string;
}

export interface DidOpenTextDocumentParams {
  textDocument: TextDocumentItem;
}

// With Full sync there is exactly one change event and it carries the whole new
// text (no `range`). We model only that shape.
export interface TextDocumentContentChangeEvent {
  text: string;
}

export interface DidChangeTextDocumentParams {
  textDocument: VersionedTextDocumentIdentifier;
  contentChanges: TextDocumentContentChangeEvent[];
}

export interface DidCloseTextDocumentParams {
  textDocument: TextDocumentIdentifier;
}

// didSave (Stage 3): carries the saved document and, when the server advertised
// `save.includeText`, the full saved text. Absent `text` ⇒ the server uses its
// own open buffer as the source of truth.
export interface DidSaveTextDocumentParams {
  textDocument: TextDocumentIdentifier;
  text?: string;
}

// --- initialize result ---

// The richer textDocumentSync form the server advertises once write features are
// on (Stage 3): a bare TextDocumentSyncKind number can't express save support, so
// a write-capable server sends this object with `save.includeText` to ask the
// client to send the buffer on didSave. Read-only servers keep sending the number.
export interface SaveOptions {
  includeText?: boolean;
}

export interface TextDocumentSyncOptions {
  openClose?: boolean;
  change?: number;
  save?: boolean | SaveOptions;
}

export interface ServerCapabilities {
  // A TextDocumentSyncKind number (read-only) OR a TextDocumentSyncOptions object
  // (write-capable: the object form carries the `save` advertisement). Omitted when
  // the server has no language intelligence to offer. Read-only stages advertise
  // the bare Full number; Stage 3 widens to the object behind the write flag.
  textDocumentSync?: number | TextDocumentSyncOptions;
  // Stage 1 read-only providers. A boolean advertises the plain capability; the
  // completion provider is an object so `resolveProvider` can be stated (we resolve
  // eagerly — detail/documentation are already computed by the service — so it is
  // false). Advertised only when the runtime offers language intelligence.
  completionProvider?: { resolveProvider?: boolean };
  hoverProvider?: boolean;
  definitionProvider?: boolean;
  referencesProvider?: boolean;
  documentHighlightProvider?: boolean;
  // Stage 7 rename: a boolean advertising textDocument/rename. Rename is a write, so
  // this is advertised ONLY when write features are on (same gate as save.includeText /
  // executeCommandProvider) — a read-only server offers no rename affordance. A richer
  // `{ prepareProvider: true }` form (textDocument/prepareRename) is a documented
  // stretch, not built. (docs/lsp-support-plan.md Stage 7.)
  renameProvider?: boolean;
  // Stage 6 creation: the commands the server accepts over workspace/executeCommand
  // (only opentide.createEntity). Advertised ONLY when write features are on — creation
  // is a write — so a read-only server offers no command and a client shows no create
  // affordance. (docs/lsp-support-plan.md Stage 6.)
  executeCommandProvider?: { commands: string[] };
  // Stage 6 trigger: register interest in file-create operations so a client emits
  // workspace/didCreateFiles for new opentide:// files (the server then points them at
  // the create command). Also write-gated. Optional polish — the command works
  // standalone. (docs/lsp-support-plan.md Stage 6.)
  workspace?: {
    fileOperations?: {
      didCreate?: FileOperationRegistrationOptions;
    };
  };
  // Custom (opentide/*) capability, not part of standard LSP: the active
  // readiness-enforcement policy the risk-adaptive save path honors (Stage 4).
  // Exposed so a client can explain to the user why a save was gated or allowed
  // (advisory never blocks, strict always gates a risky write, graduated sits
  // between). Plain clients ignore it. (docs/lsp-support-plan.md Stage 4.)
  //
  // This is a runtime POLICY value, not a structural datum — it is deliberately
  // EXCLUDED from the opentideSurface fingerprint (a config change must not move the
  // pinned surface hash), mirroring how MCP excludes advisory metadata.
  opentideReadinessEnforcement?: ReadinessEnforcement;
  // Custom (opentide/*) capability, not part of standard LSP: the version + structural
  // fingerprint of the ADVERTISED capability surface — the LSP analog of MCP's
  // tools/list `opentide/surface` _meta (Stage 8, docs/lsp-connect.md). A client
  // reads `version` to know which contract it is talking to and can cache
  // `fingerprint` to detect that the structural surface changed. Attached last by
  // buildServerCapabilities (lsp/surface.ts) — the fingerprint covers every OTHER
  // capability field plus the opentide/* custom notifications, never itself or the
  // policy-value opentideReadinessEnforcement. Plain clients ignore it.
  opentideSurface?: GenieSurfaceMeta;
}

// The opentideSurface capability payload (Stage 8): the advertised-surface contract
// version + a deterministic structural hash of the capabilities/methods declared.
// `version` is LSP_SURFACE_VERSION (the handle a client pins); `fingerprint` moves
// iff the structural surface changes (a pinned test freezes it). Mirrors MCP's
// McpSurfaceMeta minus toolCount (LSP has no tool list).
export interface GenieSurfaceMeta {
  version: string;
  fingerprint: string;
}

export interface ServerInfo {
  name: string;
  version: string;
}

export interface InitializeResult {
  capabilities: ServerCapabilities;
  serverInfo: ServerInfo;
}

// --- Stage 1: read-feature request params ---
// All five read features are position requests: a document + a 0-based cursor
// position. The server resolves the URI to entity coordinates and converts the
// position to service (1-based) coords through positions.ts before delegating.

export interface TextDocumentPositionParams {
  textDocument: TextDocumentIdentifier;
  position: Position;
}

export type CompletionParams = TextDocumentPositionParams;
export type HoverParams = TextDocumentPositionParams;
export type DefinitionParams = TextDocumentPositionParams;
export type DocumentHighlightParams = TextDocumentPositionParams;

// `references` additionally carries whether the declaration itself is included;
// the service always includes it, so the flag is accepted but not acted on.
export interface ReferenceParams extends TextDocumentPositionParams {
  context: { includeDeclaration: boolean };
}

// Stage 7 rename: a position request plus the new identifier the symbol under the
// cursor should become. The server resolves the URI + position to the target entity,
// runs getRenameLocations (already cross-entity), and rewrites every occurrence to
// `newName`. (docs/lsp-support-plan.md Stage 7.)
export interface RenameParams extends TextDocumentPositionParams {
  newName: string;
}

// --- Stage 1: result shapes ---

// A location in a document — an entity's `opentide://` URI plus a 0-based range. The
// target of go-to-definition and each find-references hit.
export interface Location {
  uri: string;
  range: Range;
}

// Stage 7 rename result shapes. A TextEdit replaces the text in a 0-based range with
// `newText`; a WorkspaceEdit groups the edits per document URI. The rename response is
// one WorkspaceEdit spanning every affected opentide:// doc — the client applies it to its
// open buffers, while the server has ALREADY applied the same edits atomically through
// the governed tool layer (so buffers and registry converge to identical text).
export interface TextEdit {
  range: Range;
  newText: string;
}

export interface WorkspaceEdit {
  changes: { [uri: string]: TextEdit[] };
}

// Markup for hover/completion documentation. We emit either plaintext or markdown;
// the language service already returns human-readable strings, so hover uses
// markdown to render the type signature as a fenced block.
export const MarkupKind = {
  PlainText: "plaintext",
  Markdown: "markdown",
} as const;

export interface MarkupContent {
  kind: typeof MarkupKind[keyof typeof MarkupKind];
  value: string;
}

// LSP completion item kinds (a numeric enum on the wire). The service speaks a
// string kind; translate.ts maps one to the other.
export const CompletionItemKind = {
  Text: 1,
  Method: 2,
  Function: 3,
  Constructor: 4,
  Field: 5,
  Variable: 6,
  Class: 7,
  Interface: 8,
  Module: 9,
  Property: 10,
  Unit: 11,
  Value: 12,
  Enum: 13,
  Keyword: 14,
  Snippet: 15,
  Color: 16,
  File: 17,
  Reference: 18,
  Folder: 19,
  EnumMember: 20,
  Constant: 21,
  Struct: 22,
  Event: 23,
  Operator: 24,
  TypeParameter: 25,
} as const;

export interface CompletionItem {
  label: string;
  kind?: number;
  detail?: string;
  documentation?: string;
  sortText?: string;
}

export interface Hover {
  contents: MarkupContent;
  range?: Range;
}

// LSP diagnostic severities (numeric on the wire); the service speaks a string
// severity translated in translate.ts.
export const DiagnosticSeverity = {
  Error: 1,
  Warning: 2,
  Information: 3,
  Hint: 4,
} as const;

export interface Diagnostic {
  range: Range;
  severity?: number;
  code?: number | string;
  source?: string;
  message: string;
}

// LSP document-highlight kinds (numeric); the service speaks "text"|"read"|"write".
export const DocumentHighlightKind = {
  Text: 1,
  Read: 2,
  Write: 3,
} as const;

export interface DocumentHighlight {
  range: Range;
  kind?: number;
}

// The payload of the one server→client push. `version` echoes the document version
// the diagnostics were computed against, so a client can drop a superseded publish
// (the server already guards this, but the field keeps plain clients honest).
export interface PublishDiagnosticsParams {
  uri: string;
  version?: number;
  diagnostics: Diagnostic[];
}
