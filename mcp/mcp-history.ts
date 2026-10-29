// @layer mcp — history writes: every client records its own session.
//
// History is project data (docs/tide-client-plan.md). The IDE chat writes it
// in-process; these verbs let any MCP client do the same for its connection's
// session: messages, a summary and metadata, and model usage. open_session picks
// which session that is; without it the server opens one on the first call.
// They act only on the connection's session, need no changeset, and are
// MCP-only because the integrated agent's loop writes history itself.
import { MCP_TURN_META_KEY, providerFor } from "../core/config.ts";
import type { Kernel } from "../core/registries.ts";
import type { ChangeContext, ChangeRecord } from "../core/changelog.ts";
import type { ToolResult } from "../core/tools/dispatch.ts";
import type { CustomToolDef } from "../core/tools/definitions.ts";
import type { CacheTtl } from "../core/usage.ts";
import type { Changeset, ModelUsageRole, Session } from "../core/types.ts";
import type { SessionVisibility } from "../core/sessions.ts";
import type { CurrentUser } from "../shared/auth.ts";

export const APPEND_SESSION_MESSAGES = "append_session_messages";
export const SET_SESSION_SUMMARY = "set_session_summary";
export const RECORD_USAGE = "record_usage";
export const OPEN_SESSION = "open_session";
export const LINK_SESSION_MESSAGE = "link_session_message";

// The MCP connection's session. open_session moves it; every later call on the
// connection acts in the session it names.
export interface SessionBinding {
  bind(sessionId: string): void;
}

// One call's worth of messages. A turn rarely has more than a handful.
export const MAX_APPENDED_MESSAGES = 50;

const MESSAGE_ROLES = ["user", "assistant", "system"] as const;
type MessageRole = typeof MESSAGE_ROLES[number];

const VISIBILITIES: readonly SessionVisibility[] = ["project", "private"];
const CACHE_TTLS: readonly CacheTtl[] = ["5m", "1h"];

const USAGE_ROLES: readonly ModelUsageRole[] = [
  "agent",
  "planning",
  "import",
  "utility",
  "verification",
  "pricing",
];

const str = (description: string) => ({ type: "string", description });
const num = (description: string) => ({ type: "number", description });

export const HISTORY_TOOLS: readonly CustomToolDef[] = [
  {
    type: "custom",
    name: OPEN_SESSION,
    description:
      "Choose the session this connection works in. Pass session_id to resume " +
      "one (an ended session reopens), or leave it out to start one. Later " +
      "calls on this connection, history writes and changes alike, belong to " +
      "it. Without this call the server starts a session on your first call. " +
      "Returns the session.",
    input_schema: {
      type: "object",
      properties: {
        session_id: str("Optional: a session to resume."),
        name: str(
          "Optional: a new session's name. Without one, an empty session of " +
            "yours is reused if there is one.",
        ),
        visibility: {
          type: "string",
          enum: [...VISIBILITIES],
          description:
            "A new session's visibility (default project). Private sessions " +
            "stay on this machine and are never committed.",
        },
        owner: {
          type: "object",
          description:
            "Optional: who the new session belongs to. OpenTide has no users; " +
            "this is a label clients with sign-in use.",
          properties: {
            id: str("Owner id."),
            display_name: str("Optional: a name to show."),
            account_id: str("Optional: the owner's account."),
            avatar_url: str("Optional: an avatar URL."),
          },
          required: ["id"],
        },
      },
      required: [],
    },
  },
  {
    type: "custom",
    name: APPEND_SESSION_MESSAGES,
    description:
      "Append messages to your session's history, which is project data every " +
      "later session can read. Link a message to the changes it describes " +
      "(change_ids from tool results), or anchor it to a changeset as its plan, " +
      "its approval, or a work note. Returns the stored message ids.",
    input_schema: {
      type: "object",
      properties: {
        messages: {
          type: "array",
          description: `Messages in order, at most ${MAX_APPENDED_MESSAGES}.`,
          items: {
            type: "object",
            properties: {
              role: {
                type: "string",
                enum: [...MESSAGE_ROLES],
                description: "Who said it.",
              },
              content: str("The message text."),
              turn_id: str("Optional: the turn this message belongs to."),
              tool_calls: {
                type: "array",
                items: { type: "object" },
                description:
                  "Optional: the tool calls this message made, each " +
                  "{name, input, result?}.",
              },
              author_user_id: str("Optional: who wrote a user message."),
              change_ids: {
                type: "array",
                items: { type: "number" },
                description:
                  "Optional: change record ids this message describes. Each " +
                  "record links back to the message, and so does its changeset.",
              },
              plan_for: str(
                "Optional: changeset id whose plan this message presents.",
              ),
              approves: str(
                "Optional: changeset id this message approves.",
              ),
            },
            required: ["role", "content"],
          },
        },
      },
      required: ["messages"],
    },
  },
  {
    type: "custom",
    name: LINK_SESSION_MESSAGE,
    description:
      "Link a message already in your session to what it is about: the " +
      "change records it describes (with the why and how of each), the " +
      "changeset whose plan it presents, approves or worked on. The same " +
      "links append_session_messages makes, for a message stored earlier. " +
      "Returns the updated change records and changesets.",
    input_schema: {
      type: "object",
      properties: {
        message_id: num("The stored message, from append_session_messages."),
        changes: {
          type: "array",
          description:
            "Optional: change records the message describes. Each links back " +
            "to the message, and so does its changeset.",
          items: {
            type: "object",
            properties: {
              id: num("Change record id."),
              rationale: str("Optional: why the change was made."),
              implementation: str("Optional: how it was made."),
            },
            required: ["id"],
          },
        },
        plan_for: str(
          "Optional: changeset id whose plan this message presents.",
        ),
        approves: str("Optional: changeset id this message approves."),
        work_for: str(
          "Optional: changeset id this message did work for, with no " +
            "change record to name.",
        ),
      },
      required: ["message_id"],
    },
  },
  {
    type: "custom",
    name: SET_SESSION_SUMMARY,
    description:
      "Set your session's summary: what was done and the decisions made, for " +
      "whoever picks the project up next. Replaces any earlier summary. " +
      "metadata is merged into the session's metadata; a null value removes " +
      "that key. Pass summary, metadata or both.",
    input_schema: {
      type: "object",
      properties: {
        summary: str("Optional: the summary, in plain prose."),
        metadata: {
          type: "object",
          description: "Optional: keys to merge into the session's metadata.",
        },
      },
      required: [],
    },
  },
  {
    type: "custom",
    name: RECORD_USAGE,
    description:
      "Record one model call's usage against your session. Calls sharing a " +
      "turn_id add up to that turn's usage, which the result returns. Stays " +
      "on this machine; it is not committed with the project.",
    input_schema: {
      type: "object",
      properties: {
        id: str(
          "Optional: a record id. Recording the same id again replaces it.",
        ),
        model: str("Model id."),
        provider: str("Optional: provider, when the model id doesn't say."),
        role: {
          type: "string",
          enum: [...USAGE_ROLES],
          description: "What the call was for (default agent).",
        },
        caller: str("Optional: the code path that made the call."),
        turn_id: str("Optional: the turn the usage belongs to."),
        changeset_id: str("Optional: the changeset the work was for."),
        started_at: str("ISO time the call started."),
        ended_at: str("ISO time the call ended."),
        input_tokens: num("Uncached input tokens."),
        output_tokens: num("Output tokens."),
        cache_write_tokens: num("Optional: cache write tokens."),
        cache_read_tokens: num("Optional: cache read tokens."),
        tool_calls: num("Optional: tool calls made."),
        cache_ttl: {
          type: "string",
          enum: [...CACHE_TTLS],
          description: "Optional: the TTL cache writes were made at (5m).",
        },
        metadata: {
          type: "object",
          description: "Optional: anything else worth keeping with the record.",
        },
      },
      required: [
        "model",
        "started_at",
        "ended_at",
        "input_tokens",
        "output_tokens",
      ],
    },
  },
];

export const HISTORY_TOOL_NAMES: ReadonlySet<string> = new Set(
  HISTORY_TOOLS.map((t) => t.name),
);

function invalid(message: string): ToolResult {
  return { ok: false, error: { code: "INVALID_INPUT", message } };
}

const NO_SESSION: ToolResult = {
  ok: false,
  error: { code: "NO_SESSION", message: "This call has no session." },
};

const SESSION_NOT_FOUND: ToolResult = {
  ok: false,
  error: { code: "SESSION_NOT_FOUND", message: "Session not found." },
};

const NO_CONNECTION: ToolResult = {
  ok: false,
  error: {
    code: "NO_CONNECTION",
    message: "open_session needs an MCP connection to bind.",
  },
};

interface AppendedMessage {
  role: MessageRole;
  content: string;
  turnId?: string;
  toolCalls?: Array<{ name: string; input: unknown; result?: unknown }>;
  authorUserId?: string;
  changes: ChangeNote[];
  planFor?: string;
  approves?: string;
}

// A change record a message describes, and optionally why and how.
interface ChangeNote {
  id: number;
  rationale?: string;
  implementation?: string;
}

// The links a message can carry, at append time or later.
interface MessageLinks {
  changes: ChangeNote[];
  planFor?: string;
  approves?: string;
  workFor?: string;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Undefined when absent, null when malformed.
function parseToolCalls(
  raw: unknown,
): AppendedMessage["toolCalls"] | undefined | null {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) return null;
  const calls: NonNullable<AppendedMessage["toolCalls"]> = [];
  for (const call of raw) {
    if (!isRecord(call) || typeof call.name !== "string") return null;
    calls.push({
      name: call.name,
      input: call.input,
      ...("result" in call ? { result: call.result } : {}),
    });
  }
  return calls;
}

function parseMessage(raw: unknown, index: number): AppendedMessage | string {
  if (typeof raw !== "object" || raw === null) {
    return `messages[${index}] must be an object`;
  }
  const m = raw as Record<string, unknown>;
  if (!MESSAGE_ROLES.includes(m.role as MessageRole)) {
    return `messages[${index}].role must be user, assistant or system`;
  }
  if (typeof m.content !== "string") {
    return `messages[${index}].content must be a string`;
  }
  const toolCalls = parseToolCalls(m.tool_calls);
  if (toolCalls === null) {
    return `messages[${index}].tool_calls must be objects with a name`;
  }
  const changeIds = m.change_ids ?? [];
  if (
    !Array.isArray(changeIds) ||
    !changeIds.every((id) => Number.isInteger(id))
  ) {
    return `messages[${index}].change_ids must be integers`;
  }
  return {
    role: m.role as MessageRole,
    content: m.content,
    turnId: optionalString(m.turn_id),
    ...(toolCalls ? { toolCalls } : {}),
    authorUserId: optionalString(m.author_user_id),
    changes: (changeIds as number[]).map((id) => ({ id })),
    planFor: optionalString(m.plan_for),
    approves: optionalString(m.approves),
  };
}

function parseMessages(input: unknown): AppendedMessage[] | string {
  if (!Array.isArray(input) || input.length === 0) {
    return "messages must be a non-empty array";
  }
  if (input.length > MAX_APPENDED_MESSAGES) {
    return `at most ${MAX_APPENDED_MESSAGES} messages per call`;
  }
  const parsed: AppendedMessage[] = [];
  for (const [i, raw] of input.entries()) {
    const message = parseMessage(raw, i);
    if (typeof message === "string") return message;
    parsed.push(message);
  }
  return parsed;
}

// Runs one anchor write. Anchors are best-effort, as in the IDE chat: the
// message is already stored, so a failed link becomes a warning rather than an
// error a client would retry into a duplicate.
async function anchor(
  warnings: string[],
  what: string,
  write: () => Promise<unknown>,
): Promise<void> {
  try {
    await write();
  } catch (err) {
    warnings.push(`${what}: ${err instanceof Error ? err.message : err}`);
  }
}

// What a message's links touched, for a client to show.
interface LinkOutcome {
  changes: ChangeRecord[];
  changesetIds: Set<string>;
  warnings: string[];
}

// Links a stored message to the change records it describes, and their
// changesets to it, as the IDE chat does for its work items.
async function linkChanges(
  kernel: Kernel,
  messageId: number,
  notes: ChangeNote[],
  outcome: LinkOutcome,
): Promise<void> {
  for (const note of notes) {
    await anchor(outcome.warnings, `change ${note.id}`, async () => {
      const change = await kernel.changelog.updateWorkblockMetadata(note.id, {
        ...(note.rationale !== undefined ? { rationale: note.rationale } : {}),
        ...(note.implementation !== undefined
          ? { implementation: note.implementation }
          : {}),
        workMessageId: messageId,
      });
      if (!change) throw new Error("not found");
      outcome.changes.push(change);
      if (change.changesetId) {
        await kernel.changesets.addWorkMessageId(change.changesetId, messageId);
        outcome.changesetIds.add(change.changesetId);
      }
    });
  }
}

async function anchorMessage(
  kernel: Kernel,
  messageId: number,
  links: MessageLinks,
  outcome: LinkOutcome,
): Promise<void> {
  await linkChanges(kernel, messageId, links.changes, outcome);
  const writes: Array<
    [string | undefined, string, (id: string) => Promise<unknown>]
  > = [
    [
      links.planFor,
      "plan_for",
      (id) => kernel.changesets.addPlanMessageId(id, messageId),
    ],
    [
      links.approves,
      "approves",
      (id) => kernel.changesets.setApprovalMessageId(id, messageId),
    ],
    [
      links.workFor,
      "work_for",
      (id) => kernel.changesets.addWorkMessageId(id, messageId),
    ],
  ];
  for (const [changesetId, what, write] of writes) {
    if (!changesetId) continue;
    await anchor(outcome.warnings, `${what} ${changesetId}`, async () => {
      await write(changesetId);
      outcome.changesetIds.add(changesetId);
    });
  }
}

function newOutcome(): LinkOutcome {
  return { changes: [], changesetIds: new Set(), warnings: [] };
}

// Undefined when absent, a message when malformed.
function parseChangeNotes(raw: unknown): ChangeNote[] | string {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return "changes must be an array";
  const notes: ChangeNote[] = [];
  for (const [i, item] of raw.entries()) {
    if (!isRecord(item) || !Number.isInteger(item.id)) {
      return `changes[${i}].id must be an integer`;
    }
    notes.push({
      id: item.id as number,
      ...(typeof item.rationale === "string"
        ? { rationale: item.rationale }
        : {}),
      ...(typeof item.implementation === "string"
        ? { implementation: item.implementation }
        : {}),
    });
  }
  return notes;
}

async function linkSessionMessage(
  kernel: Kernel,
  sessionId: string,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const messageId = input.message_id;
  if (!Number.isInteger(messageId)) {
    return invalid("message_id must be an integer");
  }
  const changes = parseChangeNotes(input.changes);
  if (typeof changes === "string") return invalid(changes);
  const message = await kernel.sessions.getMessage(messageId as number);
  if (!message || message.sessionId !== sessionId) {
    return {
      ok: false,
      error: {
        code: "MESSAGE_NOT_FOUND",
        message: `Message ${messageId} isn't in this session.`,
      },
    };
  }
  const outcome = newOutcome();
  await anchorMessage(kernel, message.id, {
    changes,
    planFor: optionalString(input.plan_for),
    approves: optionalString(input.approves),
    workFor: optionalString(input.work_for),
  }, outcome);
  const changesets: Changeset[] = [];
  for (const id of outcome.changesetIds) {
    const changeset = await kernel.changesets.get(id);
    if (changeset) changesets.push(changeset);
  }
  return {
    ok: true,
    data: {
      messageId: message.id,
      changes: outcome.changes,
      changesets,
      ...(outcome.warnings.length > 0 ? { warnings: outcome.warnings } : {}),
    },
  };
}

async function appendSessionMessages(
  kernel: Kernel,
  sessionId: string,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const messages = parseMessages(input.messages);
  if (typeof messages === "string") return invalid(messages);
  const messageIds: number[] = [];
  const outcome = newOutcome();
  for (const message of messages) {
    const stored = await kernel.sessions.addMessage({
      sessionId,
      role: message.role,
      content: message.content,
      ...(message.turnId ? { turnId: message.turnId } : {}),
      ...(message.toolCalls ? { toolCalls: message.toolCalls } : {}),
      ...(message.authorUserId ? { authorUserId: message.authorUserId } : {}),
    });
    messageIds.push(stored.id);
    await anchorMessage(kernel, stored.id, message, outcome);
  }
  return {
    ok: true,
    data: {
      sessionId,
      messageIds,
      ...(outcome.warnings.length > 0 ? { warnings: outcome.warnings } : {}),
    },
  };
}

async function setSessionSummary(
  kernel: Kernel,
  sessionId: string,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const summary = optionalString(input.summary);
  const patch = input.metadata;
  if (patch !== undefined && !isRecord(patch)) {
    return invalid("metadata must be an object");
  }
  if (!summary && !patch) return invalid("pass summary, metadata or both");
  const session = await kernel.sessions.getSession(sessionId);
  if (!session) return SESSION_NOT_FOUND;
  const metadata = patch
    ? mergeMetadata(session.metadata, patch)
    : session.metadata;
  await kernel.sessions.updateSummaryMetadata(
    sessionId,
    summary ?? session.summary,
    metadata,
  );
  return {
    ok: true,
    data: {
      sessionId,
      summary: summary ?? session.summary,
      metadata: metadata ? JSON.parse(metadata) : null,
    },
  };
}

// JSON merge patch (RFC 7386), one level deep: a null value removes the key.
function mergeMetadata(
  current: string | null,
  patch: Record<string, unknown>,
): string {
  const merged = parseMetadata(current);
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete merged[key];
    else merged[key] = value;
  }
  return JSON.stringify(merged);
}

function parseMetadata(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function tokenCount(value: unknown): number | null {
  if (value === undefined) return 0;
  return Number.isInteger(value) && (value as number) >= 0
    ? value as number
    : null;
}

function isoDate(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

async function recordUsage(
  kernel: Kernel,
  sessionId: string,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const model = optionalString(input.model);
  if (!model) return invalid("model is required");
  const startedAt = isoDate(input.started_at);
  const endedAt = isoDate(input.ended_at);
  if (!startedAt || !endedAt) {
    return invalid("started_at and ended_at must be ISO times");
  }
  const tokens = {
    inputTokens: tokenCount(input.input_tokens),
    outputTokens: tokenCount(input.output_tokens),
    cacheCreationInputTokens: tokenCount(input.cache_write_tokens),
    cacheReadInputTokens: tokenCount(input.cache_read_tokens),
  };
  if (Object.values(tokens).some((n) => n === null)) {
    return invalid("token counts must be non-negative integers");
  }
  const usage = tokens as Record<keyof typeof tokens, number>;
  const role = (input.role ?? "agent") as ModelUsageRole;
  if (!USAGE_ROLES.includes(role)) return invalid("unknown role");
  const cacheTtl = input.cache_ttl as CacheTtl | undefined;
  if (cacheTtl !== undefined && !CACHE_TTLS.includes(cacheTtl)) {
    return invalid("cache_ttl must be 5m or 1h");
  }
  if (input.metadata !== undefined && !isRecord(input.metadata)) {
    return invalid("metadata must be an object");
  }
  const turnId = optionalString(input.turn_id);
  const provider = optionalString(input.provider) ?? providerFor(model);
  const durationMs = endedAt.getTime() - startedAt.getTime();

  const record = await kernel.sessions.recordModelUsage({
    ...(optionalString(input.id) ? { id: optionalString(input.id) } : {}),
    sessionId,
    turnId: turnId ?? null,
    changesetId: optionalString(input.changeset_id) ?? null,
    provider,
    model,
    role,
    caller: optionalString(input.caller) ?? "mcp_client",
    startedAt,
    endedAt,
    durationMs,
    usage: cacheTtl ? { ...usage, cacheTtl } : usage,
    ...(Number.isInteger(input.tool_calls)
      ? { toolCallsCount: input.tool_calls as number }
      : {}),
    ...(isRecord(input.metadata) ? { metadata: input.metadata } : {}),
  });

  const turn = turnId ? await kernel.sessions.getTurnUsage(turnId) : null;
  return {
    ok: true,
    data: { sessionId, usageId: record.id, ...(turn ? { turn } : {}) },
  };
}

function parseOwner(raw: unknown): CurrentUser | undefined | string {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) return "owner must be an object";
  const id = optionalString(raw.id);
  if (!id) return "owner.id is required";
  return {
    id,
    accountId: optionalString(raw.account_id) ?? id,
    displayName: optionalString(raw.display_name) ?? id,
    email: null,
    avatarUrl: optionalString(raw.avatar_url) ?? null,
  };
}

async function resumeSession(
  kernel: Kernel,
  sessionId: string,
): Promise<Session | null> {
  const session = await kernel.sessions.getSession(sessionId);
  if (!session?.endedAt) return session;
  await kernel.sessions.reopenSession(sessionId);
  return await kernel.sessions.getSession(sessionId);
}

async function startSession(
  kernel: Kernel,
  input: Record<string, unknown>,
  owner: CurrentUser | undefined,
): Promise<Session> {
  const visibility = (input.visibility ?? "project") as SessionVisibility;
  return await kernel.sessions.createSession(optionalString(input.name), {
    visibility,
    ...(owner ? { ownerUserId: owner.id } : {}),
    // Only a named owner is worth a profile snapshot.
    ...(owner && isRecord(input.owner) && input.owner.display_name
      ? { userProfile: owner }
      : {}),
  });
}

async function openSession(
  kernel: Kernel,
  input: Record<string, unknown>,
  binding: SessionBinding | undefined,
): Promise<ToolResult> {
  if (!binding) return NO_CONNECTION;
  if (
    input.visibility !== undefined &&
    !VISIBILITIES.includes(input.visibility as SessionVisibility)
  ) {
    return invalid("visibility must be project or private");
  }
  const owner = parseOwner(input.owner);
  if (typeof owner === "string") return invalid(owner);
  const resumeId = optionalString(input.session_id);
  const session = resumeId
    ? await resumeSession(kernel, resumeId)
    : await startSession(kernel, input, owner);
  if (!session) return SESSION_NOT_FOUND;
  binding.bind(session.id);
  return { ok: true, data: { session } };
}

export async function dispatchHistoryTool(
  name: string,
  input: Record<string, unknown>,
  kernel: Kernel,
  context?: ChangeContext,
  binding?: SessionBinding,
): Promise<ToolResult> {
  if (name === OPEN_SESSION) return await openSession(kernel, input, binding);
  const sessionId = context?.sessionId;
  if (!sessionId) return NO_SESSION;
  switch (name) {
    case APPEND_SESSION_MESSAGES:
      return await appendSessionMessages(kernel, sessionId, input);
    case LINK_SESSION_MESSAGE:
      return await linkSessionMessage(kernel, sessionId, input);
    case SET_SESSION_SUMMARY:
      return await setSessionSummary(kernel, sessionId, input);
    case RECORD_USAGE:
      return await recordUsage(kernel, sessionId, input);
    default:
      return invalid(`unknown history tool ${name}`);
  }
}

// The turn a call belongs to, from its `_meta` (MCP_TURN_META_KEY). Malformed
// fields are dropped rather than refused: the call itself is fine without them.
export function turnContextFrom(
  meta: Record<string, unknown> | undefined,
): Pick<ChangeContext, "turnId" | "turnIndex" | "toolCallId" | "userMessage"> {
  const turn = meta?.[MCP_TURN_META_KEY];
  if (!isRecord(turn)) return {};
  const turnId = optionalString(turn.turn_id);
  if (!turnId) return {};
  const toolCallId = optionalString(turn.tool_call_id);
  const userMessage = optionalString(turn.user_message);
  return {
    turnId,
    ...(Number.isInteger(turn.turn_index)
      ? { turnIndex: turn.turn_index as number }
      : {}),
    ...(toolCallId ? { toolCallId } : {}),
    ...(userMessage ? { userMessage } : {}),
  };
}
