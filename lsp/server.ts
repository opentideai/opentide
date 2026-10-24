// @layer lsp — the transport-agnostic JSON-RPC dispatch core of the LSP server.
// It knows nothing about stdio/HTTP framing (transport.ts owns that); it takes a
// decoded message and returns the response to send back (or null for a
// notification). This is the seam Stage 1 extends: the read methods
// (completion/hover/definition/…) become new `case` arms delegating to
// kernel.runtime.get*, so keep the dispatch structure drop-in.
//
// It is an ADAPTER, not a language service (docs/lsp-support-plan.md §4): every
// request translates to a kernel/runtime call or to document-store bookkeeping.
// Zero new intelligence logic lives here.
import type { EntityChangeEvent, Kernel } from "../core/registries.ts";
import type { Changeset, Result } from "../core/types.ts";
import type { SaveRiskVerdict } from "../core/composition.ts";
import {
  getKernelSettings,
  LSP_CHANGESET_APPROVAL_HINT,
  LSP_CREATE_ENTITY_COMMAND,
  LSP_CREATE_ENTITY_USER_MESSAGE,
  LSP_CREATE_WRITE_DISABLED_MESSAGE,
  LSP_DIAGNOSTIC_SOURCE_QC,
  LSP_DIAGNOSTICS_DEBOUNCE_MS,
  LSP_DID_CREATE_FILES_MESSAGE,
  LSP_MANUAL_EDIT_USER_MESSAGE,
  LSP_READ_ONLY_SAVE_MESSAGE,
  LSP_RENAME_DISABLED_MESSAGE,
  LSP_RENAME_TOOL,
  LSP_RENAME_USER_MESSAGE,
  LSP_SERVER_NAME,
  LSP_SERVER_VERSION,
  LSP_WRITE_FEATURES_ENABLED,
  QC_DIAGNOSTIC_DEFAULT_COLUMN,
  QC_DIAGNOSTIC_DEFAULT_LINE,
  TOOL_ERROR_POSSIBLE_DUPLICATE,
  TOOL_ERROR_QC_FAILED,
  TOOL_ERROR_RENAME_REJECTED,
  TOOL_ERROR_STALE_WRITE,
} from "../core/config.ts";
import { createTimestampedId } from "../core/ids.ts";
import {
  getMergedDiagnostics,
  type MergedDiagnostic,
} from "../core/diagnostics.ts";
import { dispatchTool, type ToolResult } from "../core/tools/dispatch.ts";
import {
  type ChangesetStatusParams,
  type CompletionParams,
  type CreateEntityResult,
  type DefinitionParams,
  type DidChangeTextDocumentParams,
  type DidCloseTextDocumentParams,
  type DidCreateFilesParams,
  type DidOpenTextDocumentParams,
  type DidSaveTextDocumentParams,
  type DocumentChangedParams,
  type DocumentHighlightParams,
  ErrorCodes,
  type ExecuteCommandParams,
  type HoverParams,
  type IncomingMessage,
  type InitializeResult,
  isRequest,
  JSONRPC_VERSION,
  LspMethods,
  MessageType,
  type NotificationMessage,
  type PublishDiagnosticsParams,
  type ReferenceParams,
  type RenameParams,
  type RequestMessage,
  type ResponseError,
  type ResponseMessage,
  type ServerCapabilities,
  type ShowMessageParams,
  type TextEdit,
  type WorkspaceEdit,
} from "./protocol.ts";
import { DocumentStore, type OpenDocument } from "./documents.ts";
import { applyTextEdits, identifierAt } from "./edits.ts";
import { lspToServicePosition } from "./positions.ts";
import {
  toCompletionItems,
  toDefinitionLocations,
  toDiagnostics,
  toDocumentHighlights,
  toHover,
  toReferenceLocations,
  toWorkspaceEdit,
} from "./translate.ts";
import { entityUri, type GenieDocumentRef, parseGenieUri } from "./uri.ts";
import { buildServerCapabilities } from "./surface.ts";

// The sink the server pushes server→client notifications through (Stage 1:
// publishDiagnostics). The transport (transport.ts) binds this to the framed
// stdio writer; tests bind a capture. A no-op default means an unwired server
// silently drops pushes rather than throwing.
export type NotificationSender = (notification: NotificationMessage) => void;

// The structured result of committing a save (docs/lsp-support-plan.md Stage 4).
// One method (commitSave) returns this, so the risk branch — persist vs hold —
// lives in exactly one place: reportSaveOutcome dispatches on `kind`. Stage 5
// threads an expectedRevision into the same commitSave call and adds a
// STALE_WRITE arm here (alongside the persisted result's QC_FAILED /
// POSSIBLE_DUPLICATE) without reshaping the branch.
type SaveOutcome =
  // Went through the tool layer (Stage 3 direct persist). `advisory` is set when the
  // risk policy allowed a risky edit under an advisory enforcement policy — the save
  // applied, but the editor is warned.
  | { kind: "persisted"; result: ToolResult; advisory?: string }
  // Held as a pending changeset: the registry was NOT mutated. Resolution runs
  // through the changeset store's approve(id).
  | { kind: "gated"; changeset: Changeset; reason: string };

// The atomic-apply plan the LSP rename path (Stage 7) derives from a WorkspaceEdit:
// the per-entity NEW sources to persist. `edits` upsert entities that keep their
// registry key (references rewritten); `rename` (at most one) is the entity-name
// special case — the definition's own symbol was renamed, so a new key is created and
// the old one retired. Fed straight to the apply_rename tool, which persists it as one
// atomic, reversible turn.
interface RenamePlan {
  edits: Array<{ entityType: string; name: string; source: string }>;
  rename?: { entityType: string; from: string; to: string; source: string };
}

// The define_* upsert that persists each editable entity type (Stage 3 scope:
// the QC-eligible handler/function, the same set core/diagnostics.ts merges QC for).
// An entity type absent here is not persistable over LSP — a save on it falls to
// the scope guard, not the tool layer. Values mirror core/tools/dispatch.ts and the
// control server's Code-panel PUT (control-server.ts).
const DEFINE_TOOL_BY_ENTITY_TYPE: Record<string, string> = {
  handler: "define_handler",
  function: "define_function",
};

// The narrowed, validated argument object for the opentide.createEntity command (Stage
// 6). It IS the metadata form (plan §3 "Metadata gap"): `type` + `name` + `source`
// are required; `schema`/`module`/`purpose` are the handler metadata a bare file
// can't carry; `route` requests an atomic handler+route bind; `duplicateJustification`
// overrides a POSSIBLE_DUPLICATE_ENTITY rejection. `schema` is passed through untyped
// to define_handler (which validates it as a RouteSchema) so this layer holds no
// schema-shape knowledge. parseCreateEntityArgs builds this from the wire arguments.
interface CreateEntityArgs {
  type: string;
  name: string;
  source: string;
  module?: string;
  purpose?: string;
  schema?: unknown;
  route?: { method: string; path: string };
  duplicateJustification?: string;
}

// True for a plain (non-array) object — the shape the createEntity argument and its
// nested `route` must have. Used to validate the wire arguments before narrowing,
// so a malformed command answers InvalidParams rather than throwing (CLAUDE.md: no
// `any`; validate at the boundary).
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface LspServerOptions {
  kernel: Kernel;
  // Whether to advertise/accept write features. Defaults to the config flag; the
  // parameter exists so a read-only composition root can force it off without a
  // global flip, and so tests can exercise both advertisements.
  writeFeaturesEnabled?: boolean;
  // Rebuild hook threaded from the composition root (projectCtx.rebuild): the
  // define_* upsert calls it after registering so the app server picks up the edit.
  // Defaults to a no-op so read-only constructors and tests need not supply it.
  rebuild?: () => void;
  // Server→client push sink (publishDiagnostics). The transport rebinds this via
  // bindOutput(); passing it here lets a test capture pushes without a transport.
  send?: NotificationSender;
  // Diagnostics debounce override; defaults to the config constant. Tests shrink it
  // so the push fires promptly.
  diagnosticsDebounceMs?: number;
}

// The lifecycle phase of the connection. LSP requires `initialize` first and
// `shutdown` before `exit`; the server enforces that ordering.
type Phase = "uninitialized" | "initialized" | "shuttingDown" | "exited";

export class LspServer {
  private readonly kernel: Kernel;
  private readonly documents = new DocumentStore();
  private readonly writeFeaturesEnabled: boolean;
  private readonly rebuild: () => void;
  private readonly diagnosticsDebounceMs: number;
  // Per-URI pending diagnostics debounce timers; the latest edit's timer supersedes
  // the previous one (clearTimeout on reschedule) and all are cancelled on exit.
  private readonly diagnosticsTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private send: NotificationSender;
  private phase: Phase = "uninitialized";
  // Unsubscribe from the kernel's entity-change stream (Stage 5). Subscribed in the
  // constructor so an out-of-band agent write to an open entity reaches
  // handleEntityChange; released on shutdown/exit so a torn-down server stops pushing.
  private readonly unsubscribeEntityChange: () => void;

  constructor(options: LspServerOptions) {
    this.kernel = options.kernel;
    this.writeFeaturesEnabled = options.writeFeaturesEnabled ??
      LSP_WRITE_FEATURES_ENABLED;
    this.rebuild = options.rebuild ?? (() => {});
    this.diagnosticsDebounceMs = options.diagnosticsDebounceMs ??
      LSP_DIAGNOSTICS_DEBOUNCE_MS;
    this.send = options.send ?? (() => {});
    // Learn of out-of-band writes (agent via MCP/chat) so an open document can be
    // refreshed (Stage 5). A downward dependency: the server subscribes to core; the
    // write path emits. Always on — the diagnostics refresh is useful even read-only.
    this.unsubscribeEntityChange = this.kernel.onEntityChange((event) =>
      this.handleEntityChange(event)
    );
  }

  // Bind the outbound notification sink to a transport writer. The transport calls
  // this once before the read loop starts, so every server→client push (Stage 1
  // publishDiagnostics) reaches the wire. Overrides any constructor-provided sink.
  bindOutput(send: NotificationSender): void {
    this.send = send;
  }

  // The transport calls this once per decoded message. Requests return a
  // ResponseMessage; notifications return null (nothing goes back on the wire).
  // Never throws — any failure is turned into a JSON-RPC error response (for
  // requests) or logged and swallowed (for notifications).
  async dispatch(message: IncomingMessage): Promise<ResponseMessage | null> {
    try {
      switch (message.method) {
        case LspMethods.Initialize:
          return this.handleInitialize(message as RequestMessage);
        case LspMethods.Initialized:
          this.phase = "initialized";
          return null;
        case LspMethods.Shutdown:
          this.cancelAllDiagnostics();
          this.unsubscribeEntityChange();
          return this.handleShutdown(message);
        case LspMethods.Exit:
          this.cancelAllDiagnostics();
          this.unsubscribeEntityChange();
          this.phase = "exited";
          return null;
        case LspMethods.DidOpen:
          this.handleDidOpen(message.params as DidOpenTextDocumentParams);
          return null;
        case LspMethods.DidChange:
          this.handleDidChange(message.params as DidChangeTextDocumentParams);
          return null;
        case LspMethods.DidClose:
          this.handleDidClose(message.params as DidCloseTextDocumentParams);
          return null;
        case LspMethods.DidSave:
          await this.handleDidSave(message.params as DidSaveTextDocumentParams);
          return null;
        case LspMethods.ExecuteCommand:
          // A REQUEST (returns a result), unlike didSave: creation is the Stage 6
          // supported path for a NEW entity (docs/lsp-support-plan.md §11.3).
          return await this.handleExecuteCommand(message as RequestMessage);
        case LspMethods.DidCreateFiles:
          // A notification (the Stage 6 trigger): point new opentide:// files at the
          // create command; define nothing.
          this.handleDidCreateFiles(message.params as DidCreateFilesParams);
          return null;
        case LspMethods.Completion:
          return this.handleCompletion(message as RequestMessage);
        case LspMethods.Hover:
          return this.handleHover(message as RequestMessage);
        case LspMethods.Definition:
          return this.handleDefinition(message as RequestMessage);
        case LspMethods.References:
          return this.handleReferences(message as RequestMessage);
        case LspMethods.DocumentHighlight:
          return this.handleDocumentHighlight(message as RequestMessage);
        case LspMethods.Rename:
          // A REQUEST (returns a WorkspaceEdit), the Stage 7 write path: cross-entity
          // rename applied atomically through the tool layer.
          return await this.handleRename(message as RequestMessage);
        default:
          return this.handleUnknown(message);
      }
    } catch (error) {
      // A handler bug must never crash the transport loop. Requests get an
      // InternalError response; notifications are logged and dropped.
      const detail = error instanceof Error ? error.message : String(error);
      this.log("error", `dispatch failed for ${message.method}: ${detail}`);
      if (isRequest(message)) {
        return this.errorResponse(message.id, {
          code: ErrorCodes.InternalError,
          message: detail,
        });
      }
      return null;
    }
  }

  // True once the client has sent `exit`; the transport loop stops reading.
  hasExited(): boolean {
    return this.phase === "exited";
  }

  // --- Lifecycle ---

  private handleInitialize(message: RequestMessage): ResponseMessage {
    this.phase = "initialized";
    const result: InitializeResult = {
      capabilities: this.capabilities(),
      serverInfo: { name: LSP_SERVER_NAME, version: LSP_SERVER_VERSION },
    };
    return this.okResponse(message.id, result);
  }

  private handleShutdown(message: IncomingMessage): ResponseMessage | null {
    this.phase = "shuttingDown";
    // `shutdown` is a request in the spec; answer with a null result. (Defensive:
    // if a client sent it without an id, there's nothing to answer.)
    if (isRequest(message)) return this.okResponse(message.id, null);
    return null;
  }

  // Capabilities advertised in the initialize result. The construction itself lives
  // in the pure buildServerCapabilities (lsp/surface.ts) — the SINGLE source of the
  // advertised surface, shared with the pin test so the opentideSurface fingerprint can
  // never drift from what the server actually declares (Stage 8). The WHOLE server is
  // gated on the runtime's languageIntelligence capability (docs/lsp-support-plan.md
  // Stage 0): a runtime that can't offer intelligence advertises nothing, so a client
  // sends no feature requests; write providers ride behind the write flag.
  private capabilities(): ServerCapabilities {
    const languageIntelligence =
      this.kernel.runtime.capabilities.languageIntelligence;
    if (!languageIntelligence) {
      this.log(
        "warn",
        `runtime "${this.kernel.runtimeId}" has no languageIntelligence; ` +
          "advertising an empty capability set",
      );
    }
    return buildServerCapabilities({
      languageIntelligence,
      writeFeaturesEnabled: this.writeFeaturesEnabled,
      readinessEnforcement: getKernelSettings().readinessEnforcement,
    });
  }

  // --- Document sync (the only stateful work Stage 0 does) ---

  private handleDidOpen(params: DidOpenTextDocumentParams): void {
    const { uri, version, text } = params.textDocument;
    const result = this.documents.open(uri, version, text);
    if (!result.ok) {
      this.log("warn", `didOpen rejected: ${result.error.message}`);
      return;
    }
    // Seed the optimistic-concurrency base (Stage 5): the buffer is opened against the
    // entity's current revision, so didSave can send it as expectedRevision.
    this.syncRevisionIfClean(uri, result.data.ref, text);
    this.log("debug", `opened ${uri} (v${version})`);
    this.scheduleDiagnostics(uri);
  }

  private handleDidChange(params: DidChangeTextDocumentParams): void {
    const { uri, version } = params.textDocument;
    // Full sync ⇒ the last change event holds the complete new text. An empty
    // contentChanges array is a no-op (nothing to apply).
    const last = params.contentChanges.at(-1);
    if (!last) return;
    const result = this.documents.change(uri, version, last.text);
    if (!result.ok) {
      this.log("warn", `didChange rejected: ${result.error.message}`);
      return;
    }
    // If this change made the buffer match the live entity again (a rich client
    // applying a opentide/documentChanged refresh), re-seed the synced revision; an
    // in-progress edit that diverges leaves it stale so a stale save is still caught.
    this.syncRevisionIfClean(uri, result.data.ref, last.text);
    this.log("debug", `changed ${uri} (v${version})`);
    this.scheduleDiagnostics(uri);
  }

  private handleDidClose(params: DidCloseTextDocumentParams): void {
    const { uri } = params.textDocument;
    this.cancelDiagnostics(uri);
    this.documents.close(uri);
    this.log("debug", `closed ${uri}`);
  }

  // --- Stage 1: read-only language features ---
  // Each handler is pure translation (docs/lsp-support-plan.md §4): resolve the URI
  // to entity coordinates + the open buffer, convert the LSP position to service
  // coords (positions.ts), delegate to kernel.runtime.get*, translate the result
  // back to LSP shapes (translate.ts). No intelligence logic lives here. On a
  // runtime that lacks a get* method or on an internal failure, they answer with
  // the empty result — parity with the REST projection (core/control-server.ts),
  // which swallows errors so a transient failure never breaks the editor.

  private async handleCompletion(
    message: RequestMessage,
  ): Promise<ResponseMessage> {
    const notReady = this.ensureInitialized(message.id);
    if (notReady) return notReady;
    const params = message.params as CompletionParams;
    const target = this.resolveTarget(message.id, params.textDocument.uri);
    if ("error" in target) return target.error;
    const { line, column } = lspToServicePosition(params.position);
    try {
      const items = await this.kernel.runtime.getCompletions?.(
        target.ref.entityType,
        target.ref.entityName,
        line,
        column,
        this.kernel,
        target.content,
      ) ?? [];
      return this.okResponse(message.id, toCompletionItems(items));
    } catch (error) {
      this.logFeatureFailure("completion", error);
      return this.okResponse(message.id, []);
    }
  }

  private async handleHover(message: RequestMessage): Promise<ResponseMessage> {
    const notReady = this.ensureInitialized(message.id);
    if (notReady) return notReady;
    const params = message.params as HoverParams;
    const target = this.resolveTarget(message.id, params.textDocument.uri);
    if ("error" in target) return target.error;
    const { line, column } = lspToServicePosition(params.position);
    try {
      const result = await this.kernel.runtime.getHoverInfo?.(
        target.ref.entityType,
        target.ref.entityName,
        line,
        column,
        this.kernel,
        target.content,
      ) ?? null;
      return this.okResponse(message.id, result ? toHover(result) : null);
    } catch (error) {
      this.logFeatureFailure("hover", error);
      return this.okResponse(message.id, null);
    }
  }

  private async handleDefinition(
    message: RequestMessage,
  ): Promise<ResponseMessage> {
    const notReady = this.ensureInitialized(message.id);
    if (notReady) return notReady;
    const params = message.params as DefinitionParams;
    const target = this.resolveTarget(message.id, params.textDocument.uri);
    if ("error" in target) return target.error;
    const { line, column } = lspToServicePosition(params.position);
    try {
      const definitions = await this.kernel.runtime.getDefinition?.(
        target.ref.entityType,
        target.ref.entityName,
        line,
        column,
        this.kernel,
        target.content,
      ) ?? [];
      return this.okResponse(
        message.id,
        toDefinitionLocations(definitions, target.ref.runtimeId),
      );
    } catch (error) {
      this.logFeatureFailure("definition", error);
      return this.okResponse(message.id, []);
    }
  }

  private async handleReferences(
    message: RequestMessage,
  ): Promise<ResponseMessage> {
    const notReady = this.ensureInitialized(message.id);
    if (notReady) return notReady;
    const params = message.params as ReferenceParams;
    const target = this.resolveTarget(message.id, params.textDocument.uri);
    if ("error" in target) return target.error;
    const { line, column } = lspToServicePosition(params.position);
    try {
      const references = await this.kernel.runtime.getReferences?.(
        target.ref.entityType,
        target.ref.entityName,
        line,
        column,
        this.kernel,
        target.content,
      ) ?? [];
      return this.okResponse(
        message.id,
        toReferenceLocations(references, target.ref.runtimeId),
      );
    } catch (error) {
      this.logFeatureFailure("references", error);
      return this.okResponse(message.id, []);
    }
  }

  private async handleDocumentHighlight(
    message: RequestMessage,
  ): Promise<ResponseMessage> {
    const notReady = this.ensureInitialized(message.id);
    if (notReady) return notReady;
    const params = message.params as DocumentHighlightParams;
    const target = this.resolveTarget(message.id, params.textDocument.uri);
    if ("error" in target) return target.error;
    const { line, column } = lspToServicePosition(params.position);
    try {
      const highlights = await this.kernel.runtime.getDocumentHighlights?.(
        target.ref.entityType,
        target.ref.entityName,
        line,
        column,
        this.kernel,
        target.content,
      ) ?? [];
      return this.okResponse(message.id, toDocumentHighlights(highlights));
    } catch (error) {
      this.logFeatureFailure("documentHighlight", error);
      return this.okResponse(message.id, []);
    }
  }

  // Resolve a request's URI to the entity coordinates + open-buffer content the
  // service consumes. Prefers the open document (its live buffer is the override
  // content); falls back to parsing the URI alone (content undefined ⇒ the service
  // reads the registered entity source) so a feature request for an unopened but
  // valid URI still works. A malformed URI yields an InvalidParams error response.
  private resolveTarget(
    id: RequestMessage["id"],
    uri: string,
  ): { ref: OpenDocument["ref"]; content?: string } | {
    error: ResponseMessage;
  } {
    const open = this.documents.get(uri);
    if (open) return { ref: open.ref, content: open.content };
    const parsed = parseGenieUri(uri);
    if (!parsed.ok) {
      return {
        error: this.errorResponse(id, {
          code: ErrorCodes.InvalidParams,
          message: parsed.error.message,
        }),
      };
    }
    return { ref: parsed.data };
  }

  private ensureInitialized(
    id: RequestMessage["id"],
  ): ResponseMessage | null {
    if (this.phase !== "uninitialized") return null;
    return this.errorResponse(id, {
      code: ErrorCodes.ServerNotInitialized,
      message: "received a feature request before initialize",
    });
  }

  private logFeatureFailure(feature: string, error: unknown): void {
    const detail = error instanceof Error ? error.message : String(error);
    this.log("debug", `${feature} failed, returning empty result: ${detail}`);
  }

  // --- Stage 1: push diagnostics (the one server→client notification) ---

  // Debounce a diagnostics run for a URI: a burst of edits collapses to one publish
  // (LSP_DIAGNOSTICS_DEBOUNCE_MS after the last one). The newest edit's timer
  // supersedes the previous one; the run itself re-checks staleness before sending.
  private scheduleDiagnostics(uri: string): void {
    this.cancelDiagnostics(uri);
    const timer = setTimeout(() => {
      this.diagnosticsTimers.delete(uri);
      void this.publishDiagnostics(uri);
    }, this.diagnosticsDebounceMs);
    this.diagnosticsTimers.set(uri, timer);
  }

  private cancelDiagnostics(uri: string): void {
    const existing = this.diagnosticsTimers.get(uri);
    if (existing !== undefined) {
      clearTimeout(existing);
      this.diagnosticsTimers.delete(uri);
    }
  }

  // Cancel every pending diagnostics timer — on shutdown/exit — so no publish fires
  // after the transport writer is torn down.
  private cancelAllDiagnostics(): void {
    for (const timer of this.diagnosticsTimers.values()) clearTimeout(timer);
    this.diagnosticsTimers.clear();
  }

  // Compute diagnostics and publish them, unless the buffer was superseded while the
  // (async) computation ran. This is the STALE GUARD (plan §9): capture the version
  // the run started against, and after the await drop the result if a newer
  // didChange has landed — that change scheduled its own publish, so nothing is
  // lost. Never publishes for a version other than the one it computed against.
  private async publishDiagnostics(uri: string): Promise<void> {
    const doc = this.documents.get(uri);
    if (!doc) return; // closed before the timer fired
    const computedVersion = doc.version;
    let entries: MergedDiagnostic[];
    try {
      entries = await this.computeDiagnostics(doc);
    } catch (error) {
      this.logFeatureFailure("diagnostics", error);
      return;
    }
    const current = this.documents.get(uri);
    if (!current || current.version !== computedVersion) {
      this.log(
        "debug",
        `dropping stale diagnostics for ${uri} (computed v${computedVersion})`,
      );
      return;
    }
    this.sendDiagnostics(uri, entries, computedVersion);
  }

  // Send a publishDiagnostics push for a URI. The one place the notification is
  // framed, shared by the debounced didOpen/didChange path (above) and the Stage 3
  // save path (below), so both stamp the same shape. `version` is omitted for a
  // save (didSave carries no version) and echoed for a change.
  private sendDiagnostics(
    uri: string,
    entries: MergedDiagnostic[],
    version?: number,
  ): void {
    const params: PublishDiagnosticsParams = {
      uri,
      ...(version !== undefined ? { version } : {}),
      diagnostics: toDiagnostics(entries),
    };
    this.send({
      jsonrpc: JSONRPC_VERSION,
      method: LspMethods.PublishDiagnostics,
      params,
    });
  }

  // The single diagnostics seam (docs/lsp-support-plan.md Stage 2): the merged
  // source (TS ⊕ QC ⊕ verification, core/diagnostics.ts) — the same code path the
  // REST route uses, so a QC-only violation squiggles in an external editor and the
  // Genie IDE alike. The debounce / stale-guard / publish plumbing above is
  // source-agnostic, which is why swapping this one call was all Stage 2 needed here.
  private computeDiagnostics(doc: OpenDocument): Promise<MergedDiagnostic[]> {
    return getMergedDiagnostics(
      this.kernel,
      doc.ref.entityType,
      doc.ref.entityName,
      doc.content,
    );
  }

  // --- Stage 3: write path A — edit existing entities (diagnostics-as-rejection) ---
  // didSave persists the buffer through the SAME tool layer an agent writes through
  // (docs/lsp-support-plan.md §4: the LSP server is an adapter, not a second
  // persistence path). The flow is deliberately linear so Stage 4 can splice a
  // pre-persist risk gate in at one seam: resolve URI → scope guard → persistEdit →
  // translate the ToolResult into editor feedback. The persist call and the
  // rejection translation are kept apart (persistEdit vs reportPersistResult) so
  // Stage 4 wraps persistEdit without touching how rejections surface.

  private async handleDidSave(
    params: DidSaveTextDocumentParams,
  ): Promise<void> {
    const { uri } = params.textDocument;
    // Flag off ⇒ we advertised no save capability; a save here is a client ignoring
    // capabilities. Tell it truthfully (plan §3 "never lie about governance") and
    // persist nothing — a read-only server must never reach the tool layer.
    if (!this.writeFeaturesEnabled) {
      this.log("warn", `didSave ignored for ${uri}: write features are off`);
      this.showMessage(MessageType.Warning, LSP_READ_ONLY_SAVE_MESSAGE);
      return;
    }
    const parsed = parseGenieUri(uri);
    if (!parsed.ok) {
      this.log("warn", `didSave rejected: ${parsed.error.message}`);
      this.showMessage(MessageType.Error, parsed.error.message);
      return;
    }
    const ref = parsed.data;

    // Scope guard 1 — persistable type. Stage 3 is restricted to the QC-eligible
    // handler/function (the same set core/diagnostics.ts merges QC for); a test or
    // other entity type has no didSave upsert path here.
    const tool = DEFINE_TOOL_BY_ENTITY_TYPE[ref.entityType];
    if (!tool) {
      this.log(
        "debug",
        `didSave for unsupported type "${ref.entityType}" (${uri})`,
      );
      this.showMessage(
        MessageType.Info,
        `Saving ${ref.entityType} entities over LSP isn't supported yet.`,
      );
      return;
    }
    // Scope guard 2 — edit-only. Creating an entity from a new file is Stage 6
    // (under-specified without metadata, plan §3); an unregistered URI must not
    // reach define_* as a silent create.
    if (!this.isEntityRegistered(ref)) {
      this.log(
        "debug",
        `didSave for unregistered entity (${uri}); create flow`,
      );
      this.showMessage(
        MessageType.Info,
        `${ref.entityType} "${ref.entityName}" doesn't exist yet — use the create ` +
          `flow (the "${LSP_CREATE_ENTITY_COMMAND}" command) to make a new entity ` +
          "(editing over LSP is edit-only).",
      );
      return;
    }

    // The saved bytes: the client-sent text when we advertised includeText, else the
    // live open buffer. A save with neither is a protocol oddity — nothing to persist.
    const source = params.text ?? this.documents.get(uri)?.content;
    if (source === undefined) {
      this.log("warn", `didSave for ${uri} carried no buffer content`);
      this.showMessage(
        MessageType.Error,
        `No buffer to save for ${uri} — open the document first.`,
      );
      return;
    }

    // Stage 5 optimistic concurrency: the revision this buffer was seeded/synced
    // against, sent as expectedRevision so a write that lands after a concurrent edit
    // is rejected (STALE_WRITE) rather than clobbering. Undefined when the doc isn't
    // open (a save carrying params.text without didOpen) ⇒ last-writer-wins.
    const expectedRevision = this.documents.get(uri)?.syncedRevision;

    // Stage 4 risk gate: commitSave consults the injected risk policy and either
    // persists through the tool layer (low risk / no seam ⇒ pure Stage 3) or holds
    // the edit as a pending changeset. reportSaveOutcome translates either result.
    const outcome = await this.commitSave(tool, ref, source, expectedRevision);
    await this.reportSaveOutcome(outcome, uri, ref, source);
  }

  // The single, named persist call site (docs/lsp-support-plan.md Stage 3, §11.1):
  // a DIRECT tool-level write — the define_* upsert runs the duplicate check, compile,
  // QC gate, registry write, and changelog record, but `manualEdit: true` skips the
  // session-changeset requirement (dispatch.ts). No changeset row is created; that
  // is Stage 4. This method is the exact seam Stage 4 wraps with a pre-persist risk
  // gate — it stays a plain "persist these bytes → ToolResult", with zero rejection
  // translation, so that wrapping is a one-line change.
  private persistEdit(
    tool: string,
    ref: GenieDocumentRef,
    source: string,
    expectedRevision?: number,
  ): Promise<ToolResult> {
    return dispatchTool(
      tool,
      {
        name: ref.entityName,
        source,
        // Stage 5: thread the buffer's synced revision so define_* refuses a stale
        // write. Absent ⇒ the tool's last-writer-wins path (unchanged for other callers).
        ...(expectedRevision !== undefined ? { expectedRevision } : {}),
      },
      this.kernel,
      this.rebuild,
      { manualEdit: true, userMessage: LSP_MANUAL_EDIT_USER_MESSAGE },
    );
  }

  // --- Stage 4: write path B — risk-adaptive save (the differentiator) ---
  // "Your ⌘S knows how risky the edit is." The one method the didSave path funnels
  // through: consult the injected risk policy, then either persist through the Stage
  // 3 tool layer or hold the edit as a pending changeset — the registry is mutated
  // only on the persist arm. Returning a structured SaveOutcome (rather than
  // branching inline) is what lets Stage 5 add a STALE_WRITE arm through the same
  // call without reshaping this decision.
  private async commitSave(
    tool: string,
    ref: GenieDocumentRef,
    source: string,
    expectedRevision?: number,
  ): Promise<SaveOutcome> {
    const verdict = await this.assessSaveRisk(ref, source);
    if (verdict.decision === "gate" && verdict.changeset) {
      // High risk under an enforcing policy: do NOT reach persistEdit. Persist the
      // proposed edit as a gated changeset (status "planning") the verification layer
      // built; approval runs through kernel.changesets.approve(id) (plan §7 Stage 4).
      const changeset = await this.kernel.changesets.create(verdict.changeset);
      return { kind: "gated", changeset, reason: verdict.reason ?? "" };
    }
    // Low risk (or no seam ⇒ every save low-risk): the exact Stage 3 persist, now
    // carrying the Stage 5 expectedRevision so a concurrent write is rejected. An
    // advisory reason rides along so a risky-but-allowed edit still warns.
    const result = await this.persistEdit(tool, ref, source, expectedRevision);
    return { kind: "persisted", result, advisory: verdict.reason };
  }

  // Consult the injected saveRiskPolicy for this edit. A null seam ⇒ every save is
  // low-risk (pure Stage 3), so the read-only/core compositions and Stage 0–3 tests
  // are unaffected. A policy failure FAILS OPEN to a transparent persist — matching
  // the read-feature handlers' swallow-and-degrade posture (a broken governance
  // policy must not trap every edit; the changelog still records the write).
  private async assessSaveRisk(
    ref: GenieDocumentRef,
    source: string,
  ): Promise<SaveRiskVerdict> {
    const policy = this.kernel.composition.saveRiskPolicy;
    if (!policy) return { decision: "allow" };
    try {
      return await policy(this.kernel, ref.entityType, ref.entityName, source);
    } catch (error) {
      this.logFeatureFailure("save risk policy", error);
      return { decision: "allow" };
    }
  }

  // Translate a SaveOutcome into editor feedback. The persisted arm delegates to the
  // unchanged Stage 3 reporter (diagnostics-as-rejection), then adds the advisory
  // warning when a risky edit was allowed under an advisory policy. The gated arm
  // reports "pending approval" and mutates nothing.
  private async reportSaveOutcome(
    outcome: SaveOutcome,
    uri: string,
    ref: GenieDocumentRef,
    source: string,
  ): Promise<void> {
    if (outcome.kind === "persisted") {
      await this.reportPersistResult(outcome.result, uri, ref, source);
      if (outcome.advisory) {
        this.showMessage(MessageType.Warning, outcome.advisory);
      }
      return;
    }
    this.reportGatedSave(outcome.changeset, outcome.reason, ref);
  }

  // Report a gated save: a vanilla window/showMessage toast (every client) AND the
  // one opentide/changesetStatus custom notification Stage 4 adds (plan §11.4) — rich
  // clients wire an approve affordance off the structured payload; plain clients
  // degrade to the toast and lose nothing structural. No diagnostics, no registry
  // mutation: the edit is held, awaiting review.
  private reportGatedSave(
    changeset: Changeset,
    reason: string,
    ref: GenieDocumentRef,
  ): void {
    this.showMessage(
      MessageType.Warning,
      `Save held for approval: editing ${ref.entityType} "${ref.entityName}" ` +
        `opened changeset ${changeset.id} (awaiting review).`,
    );
    const params: ChangesetStatusParams = {
      changesetId: changeset.id,
      status: changeset.status,
      title: changeset.title,
      reason,
      approvalHint: LSP_CHANGESET_APPROVAL_HINT,
    };
    this.send({
      jsonrpc: JSONRPC_VERSION,
      method: LspMethods.ChangesetStatus,
      params,
    });
  }

  // Turn the ToolResult into editor feedback (plan §7 Stage 3, the "elegant part").
  // Success and QC_FAILED both re-derive diagnostics on the saved buffer via the
  // Stage 2 merge (deterministic on the same source) and publish them — the QC gate
  // becomes the linter (save → squiggles → fix → save). A duplicate rejection has no
  // line anchor, so it surfaces as one gutter diagnostic. Everything else is a plain
  // error toast. The version is the open doc's current version, or undefined.
  private async reportPersistResult(
    result: ToolResult,
    uri: string,
    ref: GenieDocumentRef,
    source: string,
  ): Promise<void> {
    const version = this.documents.get(uri)?.version;
    if (result.ok) {
      await this.republishMerged(uri, ref, source, version);
      // The write bumped the entity's revision; advance the buffer's synced base so
      // the next save carries the fresh expectedRevision (Stage 5). Authoritative:
      // the server knows it just persisted this buffer's content.
      const revision = this.entityRevision(ref);
      if (revision !== undefined) {
        this.documents.setSyncedRevision(uri, revision);
      }
      this.showMessage(
        MessageType.Info,
        `Saved ${ref.entityType} "${ref.entityName}".`,
      );
      return;
    }
    const error = result.error;
    if (error?.code === TOOL_ERROR_STALE_WRITE) {
      // Stage 5: a concurrent write landed between open/sync and this save. Do NOT
      // re-derive squiggles — the buffer isn't the problem. Warn the human and push
      // the authoritative content + revision so a rich client can replace its buffer
      // (LSP has no server buffer-replace); a plain client is caught here again on the
      // next save. syncedRevision is left stale on purpose until the client re-syncs.
      this.log(
        "info",
        `didSave for ${uri} rejected as stale: ${error.message}`,
      );
      this.showMessage(MessageType.Warning, error.message);
      const current = this.entitySourceAndRevision(ref);
      if (current) {
        this.pushDocumentChanged(uri, current.revision, current.source);
      }
      return;
    }
    if (error?.code === TOOL_ERROR_QC_FAILED) {
      await this.republishMerged(uri, ref, source, version);
      this.showMessage(
        MessageType.Warning,
        `Save rejected: quality checks failed for ${ref.entityType} ` +
          `"${ref.entityName}". See the diagnostics.`,
      );
      return;
    }
    if (error?.code === TOOL_ERROR_POSSIBLE_DUPLICATE) {
      // Whole-entity concern, no line anchor: one gutter diagnostic (line 1 / col 1),
      // mirroring qcIssuesToDiagnostics's no-line case (core/diagnostics.ts).
      const gutter: MergedDiagnostic = {
        line: QC_DIAGNOSTIC_DEFAULT_LINE,
        column: QC_DIAGNOSTIC_DEFAULT_COLUMN,
        message: error.message,
        severity: "error",
        source: LSP_DIAGNOSTIC_SOURCE_QC,
      };
      this.sendDiagnostics(uri, [gutter], version);
      this.showMessage(MessageType.Warning, error.message);
      return;
    }
    // Compile failure or any other tool error: no reliable line anchor to squiggle,
    // so a plain toast carrying the tool's message.
    const message = error?.message ?? "Save failed.";
    this.log("warn", `didSave persist failed for ${uri}: ${message}`);
    this.showMessage(MessageType.Error, `Save failed: ${message}`);
  }

  // Recompute the merged (TS ⊕ QC ⊕ verification) diagnostics on the saved buffer and
  // publish them — the authoritative post-save squiggles. On success this reflects
  // the persisted entity's remaining diagnostics (often none); on QC_FAILED it
  // republishes the line-anchored violations the flattened tool message dropped.
  private async republishMerged(
    uri: string,
    ref: GenieDocumentRef,
    source: string,
    version?: number,
  ): Promise<void> {
    let entries: MergedDiagnostic[];
    try {
      entries = await getMergedDiagnostics(
        this.kernel,
        ref.entityType,
        ref.entityName,
        source,
      );
    } catch (error) {
      this.logFeatureFailure("save diagnostics", error);
      return;
    }
    this.sendDiagnostics(uri, entries, version);
  }

  // --- Stage 6: creation & the metadata gap ---
  // A NEW entity can't be born from a bare didSave: a file carries no route schema,
  // module, or purpose (docs/lsp-support-plan.md §3). Creation is therefore a distinct
  // command (§11.3, the supported v1 path) — the client collects the metadata form and
  // invokes workspace/executeCommand opentide.createEntity with the full args. didSave
  // stays edit-only. Design choices made here (plan §7 open questions):
  //   1. ONE command, route OPTIONAL and atomic-ish: a handler+route create binds the
  //      route in the same call (register_route after define_handler). Partial-create
  //      semantics: if the handler persists but the route bind fails, the handler is
  //      NOT rolled back (the tool layer has no cross-call transaction) — the combined
  //      outcome is reported (route.bound=false + a warning toast) so it's never silent.
  //   2. DIRECT full-args persist, NOT the Stage-4 commitSave: a brand-new entity has
  //      no prior formal spec, so the risk gate would allow anyway, and commitSave only
  //      threads {name, source}. We reuse ONLY reportPersistResult for the editor
  //      feedback, keeping that funnel the single translation point (Stage 7 rename
  //      sits alongside it unchanged).
  //   3. Duplicate handling is MINIMAL for v1: a POSSIBLE_DUPLICATE_ENTITY rejection
  //      surfaces through reportPersistResult's existing gutter-diagnostic path, and a
  //      re-invocation with duplicateJustification overrides it. The richer
  //      textDocument/codeAction "reuse vs create-anyway" flow is a documented 6b
  //      stretch, not built here.

  private async handleExecuteCommand(
    message: RequestMessage,
  ): Promise<ResponseMessage> {
    const notReady = this.ensureInitialized(message.id);
    if (notReady) return notReady;
    const params = message.params as ExecuteCommandParams | undefined;
    if (params?.command !== LSP_CREATE_ENTITY_COMMAND) {
      return this.errorResponse(message.id, {
        code: ErrorCodes.MethodNotFound,
        message: `unknown command: ${params?.command ?? "(none)"}`,
      });
    }
    // Creation is a write: a read-only server advertised no command, so a call here is
    // a client ignoring capabilities. Refuse truthfully (plan §3), persist nothing.
    if (!this.writeFeaturesEnabled) {
      this.log("warn", "opentide.createEntity ignored: write features are off");
      this.showMessage(MessageType.Warning, LSP_CREATE_WRITE_DISABLED_MESSAGE);
      return this.errorResponse(message.id, {
        code: ErrorCodes.RequestFailed,
        message: LSP_CREATE_WRITE_DISABLED_MESSAGE,
      });
    }
    const parsed = this.parseCreateEntityArgs(params.arguments);
    if (!parsed.ok) {
      return this.errorResponse(message.id, {
        code: ErrorCodes.InvalidParams,
        message: parsed.error.message,
      });
    }
    const args = parsed.data;
    const tool = DEFINE_TOOL_BY_ENTITY_TYPE[args.type];
    if (!tool) {
      return this.errorResponse(message.id, {
        code: ErrorCodes.InvalidParams,
        message: `Creating "${args.type}" entities over LSP isn't supported ` +
          "(handler and function only).",
      });
    }
    const result = await this.createEntity(tool, args);
    return this.okResponse(message.id, result);
  }

  // Persist the new entity, translate the outcome to editor feedback through the SAME
  // funnel didSave uses (reportPersistResult), and — for a handler+route create — bind
  // the route. Returns the structured wire result the command answers with; the
  // squiggles/toasts are pushed as a side effect so a plain client still sees the
  // outcome.
  private async createEntity(
    tool: string,
    args: CreateEntityArgs,
  ): Promise<CreateEntityResult> {
    const ref: GenieDocumentRef = {
      runtimeId: this.kernel.runtimeId,
      entityType: args.type,
      entityName: args.name,
    };
    const uri = entityUri(ref);
    const result = await this.persistCreate(tool, args);
    // Reuse the didSave reporter: success → "Saved" toast + fresh diagnostics; a
    // QC_FAILED / POSSIBLE_DUPLICATE rejection → the same squiggles/gutter path. The
    // doc need not be open (version undefined; setSyncedRevision no-ops).
    await this.reportPersistResult(result, uri, ref, args.source);
    const base: CreateEntityResult = {
      created: result.ok,
      entityType: args.type,
      entityName: args.name,
      uri,
      ...(result.ok ? {} : {
        code: result.error?.code,
        message: result.error?.message,
      }),
    };
    // No route requested, or the entity itself didn't persist ⇒ nothing to bind.
    if (!result.ok || !args.route) return base;
    return {
      ...base,
      route: await this.bindCreatedRoute(args.name, args.route),
    };
  }

  // The direct full-metadata create persist (contrast persistEdit, which threads only
  // {name, source}). Passes the whole metadata form to define_*, with manualEdit so it
  // skips the session-changeset requirement (the same escape hatch persistEdit uses).
  // No expectedRevision — a brand-new entity has no prior revision to guard against.
  private persistCreate(
    tool: string,
    args: CreateEntityArgs,
  ): Promise<ToolResult> {
    return dispatchTool(
      tool,
      {
        name: args.name,
        source: args.source,
        ...(args.schema !== undefined ? { schema: args.schema } : {}),
        ...(args.module !== undefined ? { module: args.module } : {}),
        ...(args.purpose !== undefined ? { purpose: args.purpose } : {}),
        ...(args.duplicateJustification !== undefined
          ? { duplicateJustification: args.duplicateJustification }
          : {}),
      },
      this.kernel,
      this.rebuild,
      { manualEdit: true, userMessage: LSP_CREATE_ENTITY_USER_MESSAGE },
    );
  }

  // Bind the route for a freshly-created handler (the atomic second half). Reports the
  // combined outcome via a toast — an Info on success, a Warning on a partial create
  // (handler made, route not bound) — and returns the wire descriptor. Never rolls the
  // handler back: the tool layer has no cross-call transaction, so the honest surface
  // is "handler exists, route doesn't, here's why."
  private async bindCreatedRoute(
    handlerName: string,
    route: { method: string; path: string },
  ): Promise<{ method: string; path: string; bound: boolean }> {
    const result = await dispatchTool(
      "register_route",
      { handlerName, method: route.method, path: route.path },
      this.kernel,
      this.rebuild,
      { manualEdit: true, userMessage: LSP_CREATE_ENTITY_USER_MESSAGE },
    );
    if (result.ok) {
      this.showMessage(
        MessageType.Info,
        `Route ${route.method} ${route.path} → ${handlerName} registered.`,
      );
    } else {
      this.showMessage(
        MessageType.Warning,
        `Handler "${handlerName}" was created, but binding route ${route.method} ` +
          `${route.path} failed: ${
            result.error?.message ?? "unknown error"
          }. ` +
          "Bind it separately.",
      );
    }
    return { ...route, bound: result.ok };
  }

  // Narrow and validate the wire arguments into a CreateEntityArgs. The command takes a
  // single structured object at arguments[0] (the metadata form). Fallible → Result<T>
  // (CLAUDE.md: no `any`; validate at the boundary), so a malformed call answers
  // InvalidParams rather than throwing. `schema` is accepted as-is (define_handler
  // validates the RouteSchema shape); everything else is type-checked here.
  private parseCreateEntityArgs(
    args: unknown[] | undefined,
  ): Result<CreateEntityArgs> {
    const raw = args?.[0];
    if (!isRecord(raw)) {
      return this.invalidArgs(
        "opentide.createEntity requires a single structured argument object " +
          "{ type, name, source, ... }.",
      );
    }
    const { type, name, source, module, purpose, duplicateJustification } = raw;
    if (typeof type !== "string" || type.length === 0) {
      return this.invalidArgs(
        "createEntity: 'type' must be a non-empty string.",
      );
    }
    if (typeof name !== "string" || name.length === 0) {
      return this.invalidArgs(
        "createEntity: 'name' must be a non-empty string.",
      );
    }
    if (typeof source !== "string") {
      return this.invalidArgs("createEntity: 'source' must be a string.");
    }
    if (module !== undefined && typeof module !== "string") {
      return this.invalidArgs("createEntity: 'module' must be a string.");
    }
    if (purpose !== undefined && typeof purpose !== "string") {
      return this.invalidArgs("createEntity: 'purpose' must be a string.");
    }
    if (
      duplicateJustification !== undefined &&
      typeof duplicateJustification !== "string"
    ) {
      return this.invalidArgs(
        "createEntity: 'duplicateJustification' must be a string.",
      );
    }
    const route = this.parseRouteArg(raw.route);
    if (!route.ok) return route;
    return {
      ok: true,
      data: {
        type,
        name,
        source,
        ...(module !== undefined ? { module } : {}),
        ...(purpose !== undefined ? { purpose } : {}),
        ...(raw.schema !== undefined ? { schema: raw.schema } : {}),
        ...(route.data ? { route: route.data } : {}),
        ...(duplicateJustification !== undefined
          ? { duplicateJustification }
          : {}),
      },
    };
  }

  // Validate the optional `route` sub-argument to { method, path } strings. Absent ⇒ a
  // handler-only create (data undefined). A present-but-malformed route is a hard
  // InvalidParams — the client asked for a bind it can't get.
  private parseRouteArg(
    route: unknown,
  ): Result<{ method: string; path: string } | undefined> {
    if (route === undefined) return { ok: true, data: undefined };
    if (
      !isRecord(route) ||
      typeof route.method !== "string" || route.method.length === 0 ||
      typeof route.path !== "string" || route.path.length === 0
    ) {
      return this.invalidArgs(
        "createEntity: 'route' must be { method, path } with non-empty strings.",
      );
    }
    return { ok: true, data: { method: route.method, path: route.path } };
  }

  private invalidArgs(
    message: string,
  ): { ok: false; error: { code: string; message: string } } {
    return { ok: false, error: { code: "INVALID_CREATE_ARGS", message } };
  }

  // Stage 6 trigger (a nicety, not the exit criterion): a client reported new files. We
  // never auto-create — a bare file is under-specified (no metadata, plan §3) — so we
  // filter for opentide:// URIs and point the user at the create command, defining
  // nothing. Non-genie files (or a write-off server) are ignored.
  private handleDidCreateFiles(params: DidCreateFilesParams): void {
    if (!this.writeFeaturesEnabled) return;
    const genieFiles = params.files.filter((f) => parseGenieUri(f.uri).ok);
    if (genieFiles.length === 0) return;
    this.log(
      "debug",
      `didCreateFiles for ${genieFiles.length} genie doc(s); pointing to the ` +
        "create command",
    );
    this.showMessage(MessageType.Info, LSP_DID_CREATE_FILES_MESSAGE);
  }

  // Is the entity backing this URI already registered? The edit-only scope guard —
  // only handler/function are in scope for Stage 3, matching DEFINE_TOOL_BY_ENTITY_TYPE.
  private isEntityRegistered(ref: GenieDocumentRef): boolean {
    return this.entitySourceAndRevision(ref) !== undefined;
  }

  // --- Stage 7: rename & atomic WorkspaceEdit ---
  // The one case where the entity↔file impedance HELPS us (docs/lsp-support-plan.md
  // Stage 7): a rename that spans N entities collapses into ONE atomic, governed,
  // reversible operation a filesystem save can never offer. The flow: getRenameLocations
  // (already cross-entity) → one WorkspaceEdit → derive the per-entity new sources → the
  // apply_rename tool persists them all-or-nothing under one turnId → return the
  // WorkspaceEdit so the client reconciles its buffers. The server applies (not the
  // client) so the whole rename is one governed transaction and one changelog turn; the
  // returned WorkspaceEdit + the Stage-5 entity-change listener keep open buffers in sync.

  private async handleRename(
    message: RequestMessage,
  ): Promise<ResponseMessage> {
    const notReady = this.ensureInitialized(message.id);
    if (notReady) return notReady;
    // Rename is a write: a read-only server advertised no renameProvider, so a request
    // here is a client ignoring capabilities. Refuse truthfully (plan §3), change nothing.
    if (!this.writeFeaturesEnabled) {
      this.log("warn", "rename ignored: write features are off");
      this.showMessage(MessageType.Warning, LSP_RENAME_DISABLED_MESSAGE);
      return this.errorResponse(message.id, {
        code: ErrorCodes.RequestFailed,
        message: LSP_RENAME_DISABLED_MESSAGE,
      });
    }
    const params = message.params as RenameParams;
    const target = this.resolveTarget(message.id, params.textDocument.uri);
    if ("error" in target) return target.error;
    const newName = params.newName;

    // The source the position indexes into (open buffer, else the registry source):
    // used only to recover the OLD identifier, which discriminates a symbol rename from
    // an entity-name rename.
    const targetSource = target.content ??
      this.entitySourceAndRevision(target.ref)?.source ?? "";
    const oldName = identifierAt(targetSource, params.position);
    if (newName === oldName) {
      // A no-op rename: nothing to persist. (Most clients block this; guard anyway.)
      return this.okResponse(message.id, null);
    }

    const { line, column } = lspToServicePosition(params.position);
    let locations;
    try {
      locations = await this.kernel.runtime.getRenameLocations?.(
        target.ref.entityType,
        target.ref.entityName,
        line,
        column,
        this.kernel,
        target.content,
      ) ?? [];
    } catch (error) {
      this.logFeatureFailure("rename", error);
      return this.okResponse(message.id, null);
    }
    if (locations.length === 0) {
      this.showMessage(MessageType.Info, "Nothing to rename at this position.");
      return this.okResponse(message.id, null);
    }

    const workspaceEdit = toWorkspaceEdit(
      locations,
      newName,
      target.ref.runtimeId,
    );
    const plan = this.buildRenamePlan(workspaceEdit, oldName, newName);
    if ("error" in plan) {
      this.log("warn", `rename rejected: ${plan.error}`);
      this.showMessage(MessageType.Warning, plan.error);
      return this.okResponse(message.id, null);
    }

    const result = await this.applyRename(plan.data);
    this.reportRenameOutcome(result, plan.data, newName);
    // Return the WorkspaceEdit only on success — the client applies the SAME edits the
    // server just persisted, so buffers and registry converge; on rejection nothing was
    // changed, so return null and let the toast/diagnostics explain.
    return this.okResponse(message.id, result.ok ? workspaceEdit : null);
  }

  // Turn the WorkspaceEdit into the atomic-apply plan: for each affected opentide:// doc,
  // apply its TextEdits to the CURRENT registry source → the new source. Detect the
  // entity-name special case: if the renamed symbol (`oldName`) is itself a registered
  // handler/function whose OWN file is edited, that file becomes the `rename` (new key +
  // retire old), and the others stay `edits`. A doc whose entity isn't persistable over
  // LSP (not a handler/function — e.g. a test referencing the symbol) rejects the WHOLE
  // rename: apply_rename can't persist it atomically, and a partial rename would leave a
  // dangling reference (plan §3 "never lie about governance").
  private buildRenamePlan(
    workspaceEdit: WorkspaceEdit,
    oldName: string,
    newName: string,
  ): { data: RenamePlan } | { error: string } {
    const runtimeId = this.kernel.runtimeId;
    const renamedType = this.kernel.handlers.get(oldName)
      ? "handler"
      : this.kernel.functions.getEntry(oldName)
      ? "function"
      : undefined;
    const renamedUri = renamedType
      ? entityUri({ runtimeId, entityType: renamedType, entityName: oldName })
      : undefined;

    const edits: RenamePlan["edits"] = [];
    let rename: RenamePlan["rename"];
    for (const [uri, textEdits] of Object.entries(workspaceEdit.changes)) {
      const parsed = parseGenieUri(uri);
      if (!parsed.ok) {
        return { error: `Rename produced an invalid URI: ${uri}.` };
      }
      const ref = parsed.data;
      const current = this.entitySourceAndRevision(ref);
      if (!current) {
        return {
          error:
            `Rename can't be applied over LSP: it touches ${ref.entityType} ` +
            `"${ref.entityName}", which isn't a persistable entity (only handlers and ` +
            "functions). Nothing was changed.",
        };
      }
      const newSource = applyTextEdits(current.source, textEdits as TextEdit[]);
      if (renamedType && renamedUri && uri === renamedUri) {
        rename = {
          entityType: renamedType,
          from: oldName,
          to: newName,
          source: newSource,
        };
      } else {
        edits.push({
          entityType: ref.entityType,
          name: ref.entityName,
          source: newSource,
        });
      }
    }
    return { data: { edits, ...(rename ? { rename } : {}) } };
  }

  // Persist the plan through the atomic apply_rename tool: one turnId groups every
  // changelog entry, so the whole rename is a single reversible turn. manualEdit skips
  // the session-changeset requirement (the same escape hatch didSave/create use).
  private applyRename(plan: RenamePlan): Promise<ToolResult> {
    return dispatchTool(
      LSP_RENAME_TOOL,
      {
        turnId: createTimestampedId("rename"),
        edits: plan.edits,
        ...(plan.rename ? { rename: plan.rename } : {}),
        userMessage: LSP_RENAME_USER_MESSAGE,
      },
      this.kernel,
      this.rebuild,
      { manualEdit: true, userMessage: LSP_RENAME_USER_MESSAGE },
    );
  }

  // Report the rename outcome. Success is a toast — the affected OPEN docs are already
  // refreshed by the Stage-5 entity-change listener (apply_rename fires notifyEntityChange
  // per entity), and the client applies the returned WorkspaceEdit to its buffers. A
  // whole-rename rejection (RENAME_REJECTED) enumerates the failing entities in its
  // message; anything else is a plain error toast. No registry mutation on rejection.
  private reportRenameOutcome(
    result: ToolResult,
    plan: RenamePlan,
    newName: string,
  ): void {
    if (result.ok) {
      const count = plan.edits.length + (plan.rename ? 1 : 0);
      const what = plan.rename
        ? `${plan.rename.entityType} "${plan.rename.from}" → "${plan.rename.to}"`
        : `symbol → "${newName}"`;
      this.showMessage(
        MessageType.Info,
        `Renamed ${what} across ${count} entit${count === 1 ? "y" : "ies"} ` +
          "(one reversible change).",
      );
      return;
    }
    if (result.error?.code === TOOL_ERROR_RENAME_REJECTED) {
      this.log("info", `rename rejected whole: ${result.error.message}`);
      this.showMessage(MessageType.Warning, result.error.message);
      return;
    }
    const message = result.error?.message ?? "Rename failed.";
    this.log("warn", `rename failed: ${message}`);
    this.showMessage(MessageType.Error, `Rename failed: ${message}`);
  }

  // --- Stage 5: optimistic concurrency & out-of-band refresh ---

  // The current registry source + revision for an editable entity, or undefined if it
  // isn't registered (or isn't a persistable type). The single read point the
  // concurrency machinery uses: seed the synced base, detect a self vs out-of-band
  // write, and build a opentide/documentChanged refresh.
  private entitySourceAndRevision(
    ref: GenieDocumentRef,
  ): { source: string; revision: number } | undefined {
    switch (ref.entityType) {
      case "handler": {
        const entry = this.kernel.handlers.get(ref.entityName);
        return entry
          ? { source: entry.source, revision: entry.revision }
          : undefined;
      }
      case "function": {
        const entry = this.kernel.functions.getEntry(ref.entityName);
        return entry
          ? { source: entry.source, revision: entry.revision }
          : undefined;
      }
      default:
        return undefined;
    }
  }

  private entityRevision(ref: GenieDocumentRef): number | undefined {
    return this.entitySourceAndRevision(ref)?.revision;
  }

  // Re-seed a buffer's synced revision to the entity's current revision WHEN the
  // buffer content matches the live registry source — i.e. the buffer is based on the
  // live entity (a fresh open, or a client that just applied a opentide/documentChanged
  // refresh). A diverging buffer (in-progress edit, or a plain client that ignored a
  // refresh) is left untouched so a save from a stale buffer is still caught.
  private syncRevisionIfClean(
    uri: string,
    ref: GenieDocumentRef,
    content: string,
  ): void {
    const current = this.entitySourceAndRevision(ref);
    if (current && current.source === content) {
      this.documents.setSyncedRevision(uri, current.revision);
    }
  }

  // Push the one Stage 5 custom notification: the authoritative content + revision for
  // an open doc the server can't buffer-replace over LSP. Rich clients replace and
  // re-sync; plain clients ignore it (and are caught by STALE_WRITE on their next save).
  private pushDocumentChanged(
    uri: string,
    revision: number,
    content: string,
  ): void {
    const params: DocumentChangedParams = { uri, revision, content };
    this.send({
      jsonrpc: JSONRPC_VERSION,
      method: LspMethods.DocumentChanged,
      params,
    });
  }

  // React to an accepted define_* write anywhere (the read side of Stage 5). For each
  // open doc backing the changed entity: if the buffer already reflects the new
  // registry source (the editor's own save, or a coincidental match) just advance its
  // synced revision; otherwise an out-of-band writer diverged the entity, so push a
  // refresh and republish diagnostics against the new content, leaving the synced
  // revision stale so an un-reloaded save is still rejected. Never throws (kernel
  // isolates listener failures); an in-flight publish uses no version (not client-tied).
  private handleEntityChange(event: EntityChangeEvent): void {
    if (this.phase === "exited") return;
    for (const doc of this.documents.list()) {
      if (
        doc.ref.entityType !== event.entityType ||
        doc.ref.entityName !== event.entityName
      ) {
        continue;
      }
      const current = this.entitySourceAndRevision(doc.ref);
      if (!current) continue;
      if (current.source === doc.content) {
        this.documents.setSyncedRevision(doc.uri, current.revision);
        continue;
      }
      this.pushDocumentChanged(doc.uri, current.revision, current.source);
      void this.republishMerged(doc.uri, doc.ref, current.source);
    }
  }

  // Push a window/showMessage toast — the vanilla-LSP status surface for a save
  // outcome (plan §11.4). Degrades gracefully: a client that ignores it loses only
  // the toast, never the diagnostics.
  private showMessage(type: number, message: string): void {
    const params: ShowMessageParams = { type, message };
    this.send({
      jsonrpc: JSONRPC_VERSION,
      method: LspMethods.ShowMessage,
      params,
    });
  }

  // --- Unknown / not-yet-implemented methods ---

  private handleUnknown(message: IncomingMessage): ResponseMessage | null {
    // Notifications for unknown methods are ignored per JSON-RPC. Unknown requests
    // get MethodNotFound so Stage-1 clients probing for features degrade cleanly;
    // requests arriving before initialize get ServerNotInitialized.
    if (!isRequest(message)) return null;
    if (this.phase === "uninitialized") {
      return this.errorResponse(message.id, {
        code: ErrorCodes.ServerNotInitialized,
        message: `received "${message.method}" before initialize`,
      });
    }
    return this.errorResponse(message.id, {
      code: ErrorCodes.MethodNotFound,
      message: `method not implemented: ${message.method}`,
    });
  }

  // --- Response builders ---

  private okResponse(
    id: RequestMessage["id"],
    result: unknown,
  ): ResponseMessage {
    return { jsonrpc: JSONRPC_VERSION, id, result };
  }

  private errorResponse(
    id: RequestMessage["id"],
    error: ResponseError,
  ): ResponseMessage {
    return { jsonrpc: JSONRPC_VERSION, id, error };
  }

  // Structured logging through the kernel's ring buffer, sourced "lsp"
  // (docs/lsp-support-plan.md §9). Safe on stdio: kernel.log never writes to
  // stdout, so it can't corrupt the JSON-RPC channel.
  private log(
    level: "debug" | "info" | "warn" | "error",
    message: string,
  ): void {
    this.kernel.log.log(level, "lsp", message);
  }
}
