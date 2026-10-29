// The chat loop's tools and history over MCP (docs/tide-client-plan.md, slice
// 4). Everything here is a public MCP call any client can make: the connection
// picks its session with open_session, tool calls carry their turn in `_meta`,
// and history goes through the history verbs. No back doors.
//
// One connection serves one chat loop. The loop moves between sessions; the
// connection follows it with open_session before any call that acts on "this
// session".
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ChangeContext, ChangeRecord } from "../core/changelog.ts";
import {
  MCP_CHANGE_LIST_LIMIT,
  MCP_CLIENT_CALL_TIMEOUT_MS,
  MCP_SUGGESTION_PREFIX,
  MCP_TURN_META_KEY,
} from "../core/config.ts";
import {
  ATTACHMENT_DOCUMENT_SOURCE,
  type DocumentRecord,
  type DocumentRef,
  type DocumentVersion,
} from "../core/documents.ts";
import { KernelLog } from "../core/registries.ts";
import type { PinnedMessageInfo } from "../core/project-context.ts";
import {
  summarizeSessionWith,
  type SummarySource,
} from "../core/session-summary.ts";
import { modelUsageFromInput } from "../core/sessions.ts";
import type {
  ExportTypeCheckToolData,
  TestRunSummary,
  ToolResult,
} from "../core/tools/dispatch.ts";
import type {
  AggregatedUsage,
  Changeset,
  ChangesetReadiness,
  ModelUsageRecord,
  RecordModelUsageInput,
  Result,
  Session,
  SessionWithLastMessage,
  StoredMessage,
} from "../core/types.ts";
import { decodeBase64, encodeBase64 } from "../core/util.ts";
import type {
  ChangelogClient,
  ChangesetClient,
  ChatBackend,
  DocumentClient,
  GateClient,
  HistoryClient,
  ProjectClient,
  PromptFacts,
  ToolTransport,
} from "./chat-backend.ts";

// The one MCP request the clients make. The SDK's Client satisfies it.
export interface McpCaller {
  callTool(
    params: {
      name: string;
      arguments: Record<string, unknown>;
      _meta?: Record<string, unknown>;
    },
    resultSchema?: undefined,
    options?: { timeout?: number },
  ): Promise<unknown>;
}

interface McpContentBlock {
  type: string;
  text?: string;
  data?: string;
}

interface McpCallResult {
  content?: McpContentBlock[];
  isError?: boolean;
}

// Tools whose result is a changeset, and the chat event the in-process
// dispatch tags it with. Over MCP the tag is gone, so it is rebuilt here.
const CHANGESET_EVENTS: Readonly<Record<string, string>> = {
  create_changeset: "changeset_created",
  update_changeset_plan: "changeset_updated",
  amend_changeset_plan: "changeset_updated",
  update_changeset_step: "changeset_updated",
  record_verification_run: "changeset_updated",
  submit_review: "changeset_updated",
  adopt_changeset: "changeset_updated",
  abandon_changeset: "changeset_updated",
  complete_changeset: "changeset_completed",
};

const ERROR_PATTERN = /^Error \[([A-Z0-9_]+)\]: ([\s\S]*)$/;

const ZERO_USAGE: AggregatedUsage = {
  turns: 0,
  totalDurationMs: 0,
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalCacheCreationInputTokens: 0,
  totalCacheReadInputTokens: 0,
  totalToolCalls: 0,
  totalCostUsd: 0,
  unpricedCalls: 0,
  unpricedInputTokens: 0,
  unpricedOutputTokens: 0,
};

// The changes a call made ride in a trailing text block of their own
// (mcp-projection.ts withChanges).
function isChangesBlock(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const keys = Object.keys(value);
  return keys.includes("changes") &&
    keys.every((key) => key === "changes" || key === "changesets");
}

function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

function errorResult(text: string): ToolResult {
  const match = ERROR_PATTERN.exec(text);
  if (!match) {
    return { ok: false, error: { code: "MCP_ERROR", message: text } };
  }
  const body = match[2]!;
  const at = body.lastIndexOf(`\n${MCP_SUGGESTION_PREFIX}`);
  return {
    ok: false,
    error: {
      code: match[1]!,
      message: at === -1 ? body : body.slice(0, at),
      ...(at === -1
        ? {}
        : { suggestion: body.slice(at + 1 + MCP_SUGGESTION_PREFIX.length) }),
    },
  };
}

function firstData(texts: readonly string[]): unknown {
  for (const text of texts) {
    const parsed = parseJson(text);
    if (parsed.ok && !isChangesBlock(parsed.value)) return parsed.value;
  }
  return undefined;
}

// An MCP tool result back into the ToolResult dispatch would have returned.
export function toToolResult(raw: unknown): ToolResult {
  const result = raw as McpCallResult;
  const blocks = result.content ?? [];
  const texts = blocks.flatMap((b) => b.type === "text" ? [b.text ?? ""] : []);
  if (result.isError) {
    // The error text first, then the refusal's data, if it has any.
    const [text = "", ...rest] = texts;
    const error = errorResult(text);
    const data = firstData(rest);
    return data === undefined ? error : { ...error, data };
  }
  // The data is the first JSON block: notes (auto-advance) come before it and
  // the changes block after.
  const data = firstData(texts);
  const images = blocks.flatMap((b) =>
    b.type === "image" && b.data ? [{ png: decodeBase64(b.data) }] : []
  );
  return {
    ok: true,
    data,
    ...(images.length > 0 ? { _images: images } : {}),
  };
}

function changesetIdOf(
  args: Record<string, unknown>,
  data: unknown,
): string | null {
  const record = (data ?? {}) as Record<string, unknown>;
  for (
    const candidate of [record.changesetId, record.id, args.changeset_id]
  ) {
    if (typeof candidate === "string" && candidate) return candidate;
  }
  return null;
}

async function call(
  caller: McpCaller,
  name: string,
  args: Record<string, unknown>,
  meta?: Record<string, unknown>,
): Promise<ToolResult> {
  const raw = await caller.callTool(
    { name, arguments: args, ...(meta ? { _meta: meta } : {}) },
    undefined,
    { timeout: MCP_CLIENT_CALL_TIMEOUT_MS },
  );
  return toToolResult(raw);
}

// Unwraps a history verb's data, or throws: the in-process history methods
// throw on failure, so the loop already handles that.
async function required<T>(
  caller: McpCaller,
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  const result = await call(caller, name, args);
  if (!result.ok) {
    throw new Error(
      `${name}: ${result.error?.code ?? "MCP_ERROR"} ${
        result.error?.message ?? ""
      }`.trim(),
    );
  }
  return result.data as T;
}

// The connection's session, kept in step with the loop's.
export class McpSessionBinding {
  private bound: string | null = null;
  private pending: Promise<void> = Promise.resolve();

  constructor(private readonly caller: McpCaller) {}

  get current(): string | null {
    return this.bound;
  }

  // Records a binding open_session already made.
  boundTo(sessionId: string): void {
    this.bound = sessionId;
  }

  // Moves the connection to `sessionId` unless it is already there. Serialized,
  // so two calls for different sessions can't interleave their binds.
  ensure(sessionId: string | null | undefined): Promise<void> {
    if (!sessionId) return this.pending;
    this.pending = this.pending.then(async () => {
      if (this.bound === sessionId) return;
      const data = await required<{ session: Session }>(
        this.caller,
        "open_session",
        { session_id: sessionId },
      );
      this.bound = data.session.id;
    });
    return this.pending;
  }
}

function turnMeta(
  context?: ChangeContext,
): Record<string, unknown> | undefined {
  if (!context?.turnId) return undefined;
  return {
    [MCP_TURN_META_KEY]: {
      turn_id: context.turnId,
      ...(context.turnIndex !== undefined
        ? { turn_index: context.turnIndex }
        : {}),
      ...(context.toolCallId ? { tool_call_id: context.toolCallId } : {}),
      ...(context.userMessage ? { user_message: context.userMessage } : {}),
    },
  };
}

// Calls project tools over MCP. A changeset verb's result gets back the
// `_changesetEvent` and `_changeset` the loop routes on; the changeset comes
// from get_changeset, as the in-process result carried it.
export function mcpToolTransport(
  caller: McpCaller,
  binding: McpSessionBinding,
): ToolTransport {
  return {
    callTool: async (name, args, context) => {
      await binding.ensure(context?.sessionId);
      const result = await call(caller, name, args, turnMeta(context));
      const event = CHANGESET_EVENTS[name];
      if (!result.ok || !event) return result;
      const id = changesetIdOf(args, result.data);
      const changeset = id ? await changesetById(caller, id) : null;
      return changeset
        ? { ...result, _changesetEvent: event, _changeset: changeset }
        : result;
    },
  };
}

function storedMessage(
  id: number,
  msg: Parameters<HistoryClient["addMessage"]>[0],
): StoredMessage {
  return {
    id,
    sessionId: msg.sessionId,
    role: msg.role,
    kind: msg.kind ?? "chat",
    content: msg.content,
    toolCalls: msg.toolCalls ? JSON.stringify(msg.toolCalls) : null,
    pinned: false,
    turnId: msg.turnId ?? null,
    createdAt: new Date().toISOString(),
    authorUserId: msg.authorUserId ?? null,
  };
}

// The keys to send so the server's merge leaves exactly `next`: every key of
// `next`, and null for each key `current` has that `next` dropped.
function metadataPatch(
  current: string | null,
  next: string | null,
): Record<string, unknown> {
  const parse = (raw: string | null): Record<string, unknown> => {
    const parsed = raw ? parseJson(raw) : { ok: false as const };
    return parsed.ok && typeof parsed.value === "object" &&
        parsed.value !== null
      ? parsed.value as Record<string, unknown>
      : {};
  };
  const before = parse(current);
  const after = parse(next);
  const patch: Record<string, unknown> = { ...after };
  for (const key of Object.keys(before)) {
    if (!(key in after)) patch[key] = null;
  }
  return patch;
}

function ownerArg(
  opts: Parameters<HistoryClient["createSession"]>[1],
): Record<string, unknown> | undefined {
  const profile = opts?.userProfile;
  if (profile) {
    return {
      id: opts?.ownerUserId ?? profile.id,
      display_name: profile.displayName,
      account_id: profile.accountId,
      ...(profile.avatarUrl ? { avatar_url: profile.avatarUrl } : {}),
    };
  }
  return opts?.ownerUserId ? { id: opts.ownerUserId } : undefined;
}

function usageArgs(input: RecordModelUsageInput): Record<string, unknown> {
  const iso = (d: Date | string) => typeof d === "string" ? d : d.toISOString();
  return {
    ...(input.id ? { id: input.id } : {}),
    model: input.model,
    provider: input.provider,
    role: input.role,
    caller: input.caller,
    ...(input.turnId ? { turn_id: input.turnId } : {}),
    ...(input.changesetId ? { changeset_id: input.changesetId } : {}),
    started_at: iso(input.startedAt),
    ended_at: iso(input.endedAt),
    input_tokens: input.usage.inputTokens,
    output_tokens: input.usage.outputTokens,
    cache_write_tokens: input.usage.cacheCreationInputTokens,
    cache_read_tokens: input.usage.cacheReadInputTokens,
    ...(input.usage.cacheTtl ? { cache_ttl: input.usage.cacheTtl } : {}),
    ...(input.toolCallsCount !== undefined
      ? { tool_calls: input.toolCallsCount }
      : {}),
    ...(input.metadata ? { metadata: input.metadata } : {}),
  };
}

// Session history over MCP.
export function mcpHistoryClient(
  caller: McpCaller,
  binding: McpSessionBinding,
): HistoryClient {
  const getSession = async (id: string): Promise<Session | null> => {
    const result = await call(caller, "get_session_context", {
      session_id: id,
      messageLimit: 1,
    });
    if (!result.ok) {
      if (result.error?.code === "SESSION_NOT_FOUND") return null;
      throw new Error(`get_session_context: ${result.error?.message}`);
    }
    return (result.data as { session: Session }).session;
  };

  const getMessages: HistoryClient["getMessages"] = async (id, opts) => {
    const data = await required<{ messages: StoredMessage[] }>(
      caller,
      "get_session_context",
      { session_id: id, messageLimit: 0 },
    );
    let messages = data.messages;
    if (opts?.pinnedOnly) messages = messages.filter((m) => m.pinned);
    if (opts?.offset) messages = messages.slice(opts.offset);
    if (opts?.limit) messages = messages.slice(0, opts.limit);
    return messages;
  };

  const manage = (args: Record<string, unknown>) =>
    required<unknown>(caller, "manage_sessions", args);

  const updateSummaryMetadata: HistoryClient["updateSummaryMetadata"] = async (
    id,
    summary,
    metadata,
  ) => {
    const current = await getSession(id);
    await binding.ensure(id);
    await required(caller, "set_session_summary", {
      ...(summary ? { summary } : {}),
      metadata: metadataPatch(current?.metadata ?? null, metadata),
    });
  };

  const recordModelUsage = async (
    input: RecordModelUsageInput,
  ): Promise<ModelUsageRecord> => {
    await binding.ensure(input.sessionId);
    const data = await required<{ usageId: string }>(
      caller,
      "record_usage",
      usageArgs(input),
    );
    return modelUsageFromInput({ ...input, id: data.usageId });
  };

  // Summaries are the agent's to write (decision 4): it reads the session over
  // MCP, summarizes with its own model, and stores the result. Usage isn't
  // readable over MCP, so the summary goes without it.
  const loadSource = async (
    sessionId: string,
    throughMessageId?: number,
  ): Promise<SummarySource | null> => {
    const session = await getSession(sessionId);
    if (!session) return null;
    const all = await getMessages(sessionId);
    const messages = throughMessageId
      ? all.filter((m) => m.id <= throughMessageId)
      : all;
    const listed = await required<{ changesets: Changeset[] }>(
      caller,
      "list_changesets",
      { limit: 50 },
    );
    const changesets = listed.changesets.filter((cs) =>
      cs.sessionId === sessionId
    );
    const changesByChangeset = new Map<string, ChangeRecord[]>();
    for (const cs of changesets) {
      const context = await required<{ changes: ChangeRecord[] }>(
        caller,
        "get_changeset_context",
        { changeset_id: cs.id },
      );
      changesByChangeset.set(cs.id, context.changes);
    }
    return {
      session,
      messages,
      changesets,
      changesByChangeset,
      usage: ZERO_USAGE,
    };
  };

  return {
    createSession: async (name, opts) => {
      const owner = ownerArg(opts);
      const data = await required<{ session: Session }>(
        caller,
        "open_session",
        {
          ...(name ? { name } : {}),
          // SessionManager's default; open_session's is project.
          visibility: opts?.visibility ?? "private",
          ...(owner ? { owner } : {}),
        },
      );
      binding.boundTo(data.session.id);
      return data.session;
    },
    getSession,
    listSessions: async (limit, offset, opts) => {
      const data = await manage({
        action: "list",
        ...(limit !== undefined ? { limit } : {}),
        ...(offset !== undefined ? { offset } : {}),
        ...(opts?.includeArchived ? { include_archived: true } : {}),
      }) as { sessions: Array<Omit<SessionWithLastMessage, "metadata">> };
      // The list is compact: no metadata. The loop reads names, owners and
      // visibility from it, and getSession for the rest.
      return data.sessions.map((s) => ({ ...s, metadata: null }));
    },
    renameSession: async (id, name) => {
      await manage({ action: "rename", session_id: id, name });
    },
    endSession: async (id) => {
      await manage({ action: "end", session_id: id });
    },
    reopenSession: async (id) => {
      const data = await required<{ session: Session }>(
        caller,
        "open_session",
        { session_id: id },
      );
      binding.boundTo(data.session.id);
    },
    getMessages,
    addMessage: async (msg) => {
      await binding.ensure(msg.sessionId);
      const data = await required<{ messageIds: number[] }>(
        caller,
        "append_session_messages",
        {
          messages: [{
            role: msg.role,
            content: msg.content,
            ...(msg.turnId ? { turn_id: msg.turnId } : {}),
            ...(msg.toolCalls ? { tool_calls: msg.toolCalls } : {}),
            ...(msg.authorUserId ? { author_user_id: msg.authorUserId } : {}),
          }],
        },
      );
      return storedMessage(data.messageIds[0]!, msg);
    },
    pinnedMessages: async (scope, sessionId) => {
      if (scope === "session") {
        if (!sessionId) return [];
        await binding.ensure(sessionId);
      }
      const data = await required<{ pins: PinnedMessageInfo[] }>(
        caller,
        scope === "session"
          ? "list_current_session_pins"
          : "list_current_project_pins",
        {},
      );
      return data.pins;
    },
    updateSummaryMetadata,
    recordModelUsage,
    // The ledger rows record_usage writes carry the turn, and a turn's ledger
    // rows supersede its turn_usage row everywhere usage is read, so there is
    // nothing more to send.
    recordTurnUsage: async () => {},
    summarize: (opts) =>
      summarizeSessionWith({
        loadSource,
        recordUsage: recordModelUsage,
        updateSummaryMetadata: (id, summary, metadata) =>
          updateSummaryMetadata(id, summary, metadata),
      }, opts),
  };
}

// An MCP client for serve's /mcp, authenticated with the server token as any
// HTTP client is.
export async function connectMcp(
  url: URL,
  token: string,
  clientName: string,
): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: clientName, version: "0.0.0" });
  await client.connect(transport);
  return client;
}

// A tool's result as a Result, for clients whose in-process twin returns one.
async function result<T>(
  caller: McpCaller,
  name: string,
  args: Record<string, unknown>,
): Promise<Result<T>> {
  const out = await call(caller, name, args);
  if (out.ok) return { ok: true, data: out.data as T };
  return {
    ok: false,
    error: out.error ?? { code: "MCP_ERROR", message: `${name} failed` },
  };
}

// A changeset as stored, or null when there is none.
async function changesetById(
  caller: McpCaller,
  id: string,
): Promise<Changeset | null> {
  const out = await call(caller, "get_changeset", { changeset_id: id });
  if (!out.ok) {
    if (out.error?.code === "CHANGESET_NOT_FOUND") return null;
    throw new Error(`get_changeset: ${out.error?.message ?? "failed"}`);
  }
  return (out.data as { changeset: Changeset | null }).changeset;
}

// Links a stored message and returns what it touched. A link that didn't take
// comes back as a warning; the in-process anchors throw, so this does too.
async function linkMessage(
  caller: McpCaller,
  args: Record<string, unknown>,
): Promise<{ changes: ChangeRecord[]; changesets: Changeset[] }> {
  const data = await required<{
    changes: ChangeRecord[];
    changesets: Changeset[];
    warnings?: string[];
  }>(caller, "link_session_message", args);
  if (data.warnings?.length) throw new Error(data.warnings.join("; "));
  return data;
}

async function linkToChangeset(
  caller: McpCaller,
  messageId: number,
  link: "plan_for" | "approves" | "work_for",
  changesetId: string,
): Promise<Changeset> {
  const { changesets } = await linkMessage(caller, {
    message_id: messageId,
    [link]: changesetId,
  });
  const changeset = changesets.find((c) => c.id === changesetId);
  if (!changeset) throw new Error(`Changeset "${changesetId}" not found`);
  return changeset;
}

// Changesets over MCP. Each mutation is a public verb; the full changeset comes
// back through get_changeset, as the in-process store returned it.
export function mcpChangesetClient(
  caller: McpCaller,
  binding: McpSessionBinding,
): ChangesetClient {
  const get = async (id: string) => {
    const changeset = await changesetById(caller, id);
    if (!changeset) throw new Error(`Changeset "${id}" not found`);
    return changeset;
  };
  return {
    get: (id) => changesetById(caller, id),
    getActive: async (sessionId) => {
      await binding.ensure(sessionId);
      const data = await required<{ changeset: Changeset | null }>(
        caller,
        "get_changeset",
        {},
      );
      return data.changeset;
    },
    approve: (id, options) =>
      required<Changeset>(caller, "approve_changeset", {
        changeset_id: id,
        ...(options?.lightLane ? { light_lane: true } : {}),
      }),
    updateStep: async (id, stepId, status) => {
      await required(caller, "update_changeset_step", {
        changeset_id: id,
        step_id: stepId,
        status,
      });
      return await get(id);
    },
    setApprovalMessageId: (id, messageId) =>
      linkToChangeset(caller, messageId, "approves", id),
    addWorkMessageId: (id, messageId) =>
      linkToChangeset(caller, messageId, "work_for", id),
    addPlanMessageId: (id, messageId) =>
      linkToChangeset(caller, messageId, "plan_for", id),
    // complete_changeset rolls the turn usage up and commits, as the
    // in-process complete and aggregate do between them.
    complete: async (id) => {
      await required(caller, "complete_changeset", { changeset_id: id });
      return await get(id);
    },
    aggregate: get,
    readiness: (changeset) =>
      required<ChangesetReadiness>(caller, "check_changeset_readiness", {
        changeset_id: changeset.id,
      }),
  };
}

// Change records over MCP: read by turn with search_changes, annotated through
// the message that describes them.
export function mcpChangelogClient(caller: McpCaller): ChangelogClient {
  return {
    list: async (opts = {}) => {
      const data = await required<{ changes: ChangeRecord[] }>(
        caller,
        "search_changes",
        {
          ...(opts.category ? { category: opts.category } : {}),
          ...(opts.key ? { key: opts.key } : {}),
          ...(opts.turnId ? { turnId: opts.turnId } : {}),
          limit: opts.limit ?? MCP_CHANGE_LIST_LIMIT,
        },
      );
      return data.changes;
    },
    updateWorkblockMetadata: async (id, metadata) => {
      if (metadata.workMessageId == null) {
        throw new Error(
          "Over MCP a change record is annotated through its work message.",
        );
      }
      const { changes } = await linkMessage(caller, {
        message_id: metadata.workMessageId,
        changes: [{
          id,
          ...(metadata.rationale != null
            ? { rationale: metadata.rationale }
            : {}),
          ...(metadata.implementation != null
            ? { implementation: metadata.implementation }
            : {}),
        }],
      });
      return changes.find((c) => c.id === id) ?? null;
    },
  };
}

interface ReadDocument {
  document: DocumentRecord;
  version: DocumentVersion;
  content?: string;
  contentBase64?: string;
}

// Documents over MCP: bytes travel as base64, and a message cites a document
// through document_write's ref.
export function mcpDocumentClient(caller: McpCaller): DocumentClient {
  const read = (id: string, versionHash: string | undefined, base64: boolean) =>
    result<ReadDocument>(caller, "document_query", {
      action: "read",
      id,
      includeContent: true,
      ...(versionHash ? { versionHash } : {}),
      ...(base64 ? { encoding: "base64" } : {}),
    });
  return {
    create: (input) =>
      result<DocumentRecord>(caller, "document_write", {
        action: "create",
        name: input.name,
        kind: input.kind,
        ...(typeof input.content === "string"
          ? { content: input.content }
          : { content_base64: encodeBase64(input.content) }),
        scope: input.scope,
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        ...(input.note ? { note: input.note } : {}),
        ...(typeof input.metadata?.description === "string"
          ? { description: input.metadata.description }
          : {}),
        ...(input.createdBy === "user" &&
            input.metadata?.source === ATTACHMENT_DOCUMENT_SOURCE
          ? { attachment: true }
          : {}),
      }),
    listPinned: async (sessionId) => {
      const data = await required<{ ids: string[] }>(
        caller,
        "document_query",
        { action: "pinned", sessionId },
      );
      return data.ids;
    },
    readContent: async (id, versionHash) => {
      const out = await read(id, versionHash, false);
      if (!out.ok) return out;
      const { document, version, content } = out.data;
      return { ok: true, data: { document, version, content: content ?? "" } };
    },
    readContentBytes: async (id, versionHash) => {
      const out = await read(id, versionHash, true);
      if (!out.ok) return out;
      const { document, version, contentBase64 } = out.data;
      return {
        ok: true,
        data: { document, version, bytes: decodeBase64(contentBase64 ?? "") },
      };
    },
    recordRef: (input) => {
      if (
        input.refType !== "message" ||
        (input.role !== "mention" && input.role !== "attachment")
      ) {
        return Promise.resolve({
          ok: false,
          error: {
            code: "INVALID_INPUT",
            message:
              "Over MCP a client records only a message's mentions and attachments.",
          },
        });
      }
      return result<DocumentRef>(caller, "document_write", {
        action: "ref",
        id: input.documentId,
        message_id: Number(input.refId),
        role: input.role,
        ...(input.versionHash ? { versionHash: input.versionHash } : {}),
      });
    },
  };
}

// The per-step gates over MCP. Each is the public tool, so each mints its
// attestation, as it does for any client.
export function mcpGateClient(
  caller: McpCaller,
  binding: McpSessionBinding,
): GateClient {
  const gate = async (
    name: string,
    args: Record<string, unknown>,
    context?: ChangeContext,
  ) => {
    await binding.ensure(context?.sessionId);
    return await call(caller, name, args, turnMeta(context));
  };
  const data = async <T>(
    name: string,
    args: Record<string, unknown>,
    context?: ChangeContext,
  ) => {
    const result = await gate(name, args, context);
    if (!result.ok) {
      throw new Error(`${name}: ${result.error?.message ?? "failed"}`);
    }
    return result.data as T;
  };
  return {
    checkExportTypes: async (context) =>
      await gate("check_export_types", {}, context) as ToolResult & {
        data?: ExportTypeCheckToolData;
      },
    runTests: async (context) =>
      await gate("run_tests", {}, context) as ToolResult & {
        data?: TestRunSummary;
      },
    coverage: async (context) => ({
      untested:
        (await data<{ untested?: string[] }>("test_coverage", {}, context))
          .untested ?? [],
    }),
    loadApp: async (path, context) => ({
      pageErrors: (await data<{ pageErrors?: string[] }>(
        "test_app",
        { path },
        context,
      )).pageErrors ?? [],
    }),
  };
}

interface ProjectStatusFacts {
  projectRules?: string | null;
  skills?: Array<{ name: string; prompt: string }>;
}

// Project facts over MCP. The cache trace is the agent's own; it goes where
// the agent says.
export function mcpProjectClient(
  caller: McpCaller,
  historyDir: string | null,
): ProjectClient {
  return {
    historyDir: () => historyDir,
    promptFacts: async () => {
      const status = await required<ProjectStatusFacts>(
        caller,
        "project_status",
        {},
      );
      const secrets = await required<PromptFacts["secrets"]>(
        caller,
        "list_secrets",
        {},
      );
      return {
        ...(status.projectRules
          ? { customInstructions: status.projectRules }
          : {}),
        skills: status.skills ?? [],
        secrets: secrets.map(({ key, description, status }) => ({
          key,
          ...(description ? { description } : {}),
          status,
        })),
      };
    },
    commit: async (message, changesetId) => {
      const data = await required<{ committed: boolean }>(
        caller,
        "git_commit",
        { message, changeset_id: changesetId },
      );
      return data.committed;
    },
  };
}

export interface McpChatBackendOptions {
  // Where the agent keeps its cache-composition trace; null for none.
  historyDir?: string | null;
  log?: KernelLog;
}

// The whole chat backend over one MCP connection: everything the loop reaches
// outside itself, through public tools.
export function mcpChatBackend(
  caller: McpCaller,
  options: McpChatBackendOptions = {},
): ChatBackend {
  const binding = new McpSessionBinding(caller);
  return {
    tools: mcpToolTransport(caller, binding),
    history: mcpHistoryClient(caller, binding),
    changesets: mcpChangesetClient(caller, binding),
    changelog: mcpChangelogClient(caller),
    documents: mcpDocumentClient(caller),
    gates: mcpGateClient(caller, binding),
    project: mcpProjectClient(caller, options.historyDir ?? null),
    log: options.log ?? new KernelLog(),
  };
}
