import {
  and,
  asc,
  count,
  desc,
  eq,
  ilike,
  inArray,
  isNull,
  type SQL,
  sql,
} from "drizzle-orm";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  genieMessagesTable,
  genieModelUsageTable,
  genieSessionsTable,
  genieTurnUsageTable,
} from "./db/schema/index.ts";
import type { DrizzleDb } from "./db/factory.ts";
import type { KernelLog } from "./registries.ts";
import type {
  AggregatedUsage,
  ModelUsageProvider,
  ModelUsageRecord,
  RecordModelUsageInput,
  Session,
  SessionWithLastMessage,
  StoredMessage,
  TurnUsage,
} from "./types.ts";
import {
  getProviderKey,
  getUtilityModelForRequest,
  providerFor,
} from "./config.ts";
import { callUtilityModel } from "./utility-model.ts";
import type { CurrentUser } from "./auth.ts";
import { localUser } from "./auth.ts";
import {
  appendJsonLine,
  ensureDir,
  readJsonFile,
  readJsonLines,
  rewriteJsonLines,
  writeJsonIfChanged,
} from "./history-store.ts";
import { createMergeableNumericId, createTimestampedId } from "./ids.ts";
import { stripModelContextContent } from "./util.ts";
import { computeProviderModelCost } from "./usage.ts";

type SessionRow = typeof genieSessionsTable.$inferSelect;
type MessageRow = typeof genieMessagesTable.$inferSelect;
type TurnUsageRow = typeof genieTurnUsageTable.$inferSelect;
type ModelUsageRow = typeof genieModelUsageTable.$inferSelect;

export type SessionVisibility = "private" | "project";

export interface UserProfileSnapshot {
  id: string;
  accountId: string;
  displayName: string;
  avatarUrl: string | null;
  capturedAt: string;
}

function fallbackUserId(): string {
  return localUser().id;
}

function profileSnapshot(user: CurrentUser): UserProfileSnapshot {
  return {
    id: user.id,
    accountId: user.accountId,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
    capturedAt: new Date().toISOString(),
  };
}

function normalizeSession(session: Session): Session {
  return {
    ...session,
    ownerUserId: session.ownerUserId ?? fallbackUserId(),
    visibility: session.visibility ?? "private",
  };
}

function normalizeMessage(message: StoredMessage): StoredMessage {
  return {
    ...message,
    kind: message.kind ?? "chat",
    authorUserId: message.authorUserId ?? null,
  };
}

// --- Shared helpers used by both storage backends ---

function rowToSession(r: SessionRow): Session {
  return {
    id: r.id,
    name: r.name,
    startedAt: r.startedAt,
    endedAt: r.endedAt,
    summary: r.summary,
    focus: r.focus,
    metadata: r.metadata,
    archived: r.archived,
    ownerUserId: r.ownerUserId ?? fallbackUserId(),
    visibility: (r.visibility as SessionVisibility | null) ?? "private",
  };
}

function rowToMessage(r: MessageRow): StoredMessage {
  return {
    id: r.id,
    sessionId: r.sessionId,
    role: r.role as StoredMessage["role"],
    kind: (r.kind as StoredMessage["kind"] | null) ?? "chat",
    content: r.content,
    toolCalls: r.toolCalls,
    pinned: r.pinned,
    projectPinned: r.projectPinned,
    turnId: r.turnId,
    createdAt: r.createdAt,
    authorUserId: r.authorUserId ?? null,
  };
}

function rowToTurnUsage(r: TurnUsageRow): TurnUsage {
  return {
    turnId: r.turnId,
    sessionId: r.sessionId,
    model: r.model,
    startedAt: r.startedAt,
    endedAt: r.endedAt,
    durationMs: r.durationMs,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    cacheCreationInputTokens: r.cacheCreationInputTokens,
    cacheReadInputTokens: r.cacheReadInputTokens,
    toolCallsCount: r.toolCallsCount,
    costUsd: r.costUsd,
  };
}

function rowToModelUsage(r: ModelUsageRow): ModelUsageRecord {
  return {
    id: r.id,
    sessionId: r.sessionId,
    turnId: r.turnId,
    auditResultId: r.auditResultId,
    changesetId: r.changesetId,
    provider: r.provider as ModelUsageProvider,
    model: r.model,
    role: r.role as ModelUsageRecord["role"],
    caller: r.caller,
    startedAt: r.startedAt,
    endedAt: r.endedAt,
    durationMs: r.durationMs,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    cacheCreationInputTokens: r.cacheCreationInputTokens,
    cacheReadInputTokens: r.cacheReadInputTokens,
    toolCallsCount: r.toolCallsCount,
    costUsd: r.costUsd,
    pricingStatus: r.pricingStatus as ModelUsageRecord["pricingStatus"],
    pricingProvider: r.pricingProvider as ModelUsageProvider | null,
    pricingModel: r.pricingModel,
    pricingVerifiedAt: r.pricingVerifiedAt,
    pricingSource: r.pricingSource as ModelUsageRecord["pricingSource"],
    metadata: (r.metadata ?? {}) as Record<string, unknown>,
  };
}

function isoTimestamp(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function modelUsageFromInput(input: RecordModelUsageInput): ModelUsageRecord {
  const startedAt = isoTimestamp(input.startedAt);
  const endedAt = isoTimestamp(input.endedAt);
  const startedMs = new Date(startedAt).getTime();
  const endedMs = new Date(endedAt).getTime();
  const durationMs = input.durationMs ??
    (Number.isFinite(startedMs) && Number.isFinite(endedMs)
      ? Math.max(0, endedMs - startedMs)
      : 0);
  const cost = computeProviderModelCost({
    provider: input.provider,
    model: input.model,
    inputTokens: input.usage.inputTokens,
    outputTokens: input.usage.outputTokens,
    cacheCreationInputTokens: input.usage.cacheCreationInputTokens,
    cacheReadInputTokens: input.usage.cacheReadInputTokens,
    asOf: new Date(endedAt),
    // 1h cache writes bill at 2x input, not the table's 5m 1.25x.
    ...(input.usage.cacheTtl !== undefined
      ? { cacheTtl: input.usage.cacheTtl }
      : {}),
  });
  return {
    id: input.id ?? createTimestampedId("model_usage"),
    sessionId: input.sessionId ?? null,
    turnId: input.turnId ?? null,
    auditResultId: input.auditResultId ?? null,
    changesetId: input.changesetId ?? null,
    provider: input.provider,
    model: input.model,
    role: input.role,
    caller: input.caller,
    startedAt,
    endedAt,
    durationMs,
    inputTokens: input.usage.inputTokens,
    outputTokens: input.usage.outputTokens,
    cacheCreationInputTokens: input.usage.cacheCreationInputTokens,
    cacheReadInputTokens: input.usage.cacheReadInputTokens,
    toolCallsCount: input.toolCallsCount ?? 0,
    costUsd: cost.costUsd,
    pricingStatus: cost.pricingStatus,
    pricingProvider: cost.pricing?.provider ?? null,
    pricingModel: cost.pricing?.model ?? null,
    pricingVerifiedAt: cost.pricing?.verifiedAt ?? null,
    pricingSource: cost.pricing?.source ?? null,
    metadata: input.metadata ?? {},
  };
}

function sessionActivityAt(session: SessionWithLastMessage): string {
  return session.lastMessageAt ?? session.startedAt;
}

export interface ProjectUsageOptions {
  since?: string;
}

function includeUsageRow(
  row: { startedAt: string },
  opts: ProjectUsageOptions = {},
): boolean {
  return !opts.since || row.startedAt >= opts.since;
}

function aggregateCombinedUsageRows(
  modelRows: ModelUsageRecord[],
  turnRows: TurnUsage[],
  opts: ProjectUsageOptions = {},
): AggregatedUsage {
  const filteredModelRows = opts.since
    ? modelRows.filter((row) => includeUsageRow(row, opts))
    : modelRows;
  const ledgerTurnIds = new Set(
    filteredModelRows
      .map((row) => row.turnId)
      .filter((turnId): turnId is string => Boolean(turnId)),
  );
  const filtered =
    (opts.since
      ? turnRows.filter((row) => includeUsageRow(row, opts))
      : turnRows).filter((row) => !ledgerTurnIds.has(row.turnId));
  const unpriced = filtered.filter((row) => row.pricingStatus === "unpriced");
  const unpricedModelRows = filteredModelRows.filter((row) =>
    row.pricingStatus === "unpriced" || row.costUsd === null
  );
  const distinctTurnIds = new Set([
    ...ledgerTurnIds,
    ...filtered.map((row) => row.turnId),
  ]);
  return {
    turns: distinctTurnIds.size,
    totalDurationMs: filteredModelRows.reduce(
      (sum, row) => sum + row.durationMs,
      filtered.reduce((sum, row) => sum + row.durationMs, 0),
    ),
    totalInputTokens: filteredModelRows.reduce(
      (sum, row) => sum + row.inputTokens,
      filtered.reduce((sum, row) => sum + row.inputTokens, 0),
    ),
    totalOutputTokens: filteredModelRows.reduce(
      (sum, row) => sum + row.outputTokens,
      filtered.reduce((sum, row) => sum + row.outputTokens, 0),
    ),
    totalCacheCreationInputTokens: filtered.reduce(
      (sum, row) => sum + row.cacheCreationInputTokens,
      filteredModelRows.reduce(
        (sum, row) => sum + row.cacheCreationInputTokens,
        0,
      ),
    ),
    totalCacheReadInputTokens: filtered.reduce(
      (sum, row) => sum + row.cacheReadInputTokens,
      filteredModelRows.reduce(
        (sum, row) => sum + row.cacheReadInputTokens,
        0,
      ),
    ),
    totalToolCalls: filteredModelRows.reduce(
      (sum, row) => sum + row.toolCallsCount,
      filtered.reduce((sum, row) => sum + row.toolCallsCount, 0),
    ),
    totalCostUsd: filtered.reduce(
      (sum, row) =>
        row.pricingStatus === "unpriced" ||
          row.pricingStatus === "estimated_legacy"
          ? sum
          : sum + row.costUsd,
      filteredModelRows.reduce(
        (sum, row) =>
          row.pricingStatus === "priced" ? sum + (row.costUsd ?? 0) : sum,
        0,
      ),
    ),
    unpricedCalls: unpriced.length + unpricedModelRows.length,
    unpricedInputTokens: unpriced.reduce(
      (sum, row) => sum + row.inputTokens,
      unpricedModelRows.reduce((sum, row) => sum + row.inputTokens, 0),
    ),
    unpricedOutputTokens: unpriced.reduce(
      (sum, row) => sum + row.outputTokens,
      unpricedModelRows.reduce((sum, row) => sum + row.outputTokens, 0),
    ),
  };
}

function turnUsageFromModelUsageRows(
  rows: ModelUsageRecord[],
): TurnUsage | null {
  if (rows.length === 0) return null;
  const sorted = rows.toSorted((a, b) =>
    a.startedAt.localeCompare(b.startedAt)
  );
  const first = sorted[0]!;
  const last = sorted[sorted.length - 1]!;
  const pricingStatus =
    sorted.some((row) =>
        row.pricingStatus === "unpriced" || row.costUsd === null
      )
      ? "unpriced"
      : sorted.some((row) => row.pricingStatus === "estimated_legacy")
      ? "estimated_legacy"
      : "priced";
  return {
    turnId: first.turnId!,
    sessionId: first.sessionId ?? "",
    model: sorted.length === 1 ? first.model : "multiple models",
    provider: sorted.length === 1 ? first.provider : undefined,
    startedAt: first.startedAt,
    endedAt: last.endedAt,
    durationMs: sorted.reduce((sum, row) => sum + row.durationMs, 0),
    inputTokens: sorted.reduce((sum, row) => sum + row.inputTokens, 0),
    outputTokens: sorted.reduce((sum, row) => sum + row.outputTokens, 0),
    cacheCreationInputTokens: sorted.reduce(
      (sum, row) => sum + row.cacheCreationInputTokens,
      0,
    ),
    cacheReadInputTokens: sorted.reduce(
      (sum, row) => sum + row.cacheReadInputTokens,
      0,
    ),
    toolCallsCount: sorted.reduce((sum, row) => sum + row.toolCallsCount, 0),
    costUsd: sorted.reduce(
      (sum, row) =>
        row.pricingStatus === "priced" ? sum + (row.costUsd ?? 0) : sum,
      0,
    ),
    pricingStatus,
  };
}

// --- Storage interface ---

interface SessionStore {
  createSession(name?: string, opts?: SessionCreateOptions): Promise<Session>;
  endSession(id: string): Promise<void>;
  reopenSession(id: string): Promise<void>;
  getSession(id: string): Promise<Session | null>;
  listSessions(
    limit?: number,
    offset?: number,
    opts?: SessionListOptions,
  ): Promise<SessionWithLastMessage[]>;
  renameSession(id: string, name: string): Promise<void>;
  updateSummary(id: string, summary: string): Promise<void>;
  updateSummaryMetadata(
    id: string,
    summary: string | null,
    metadata: string | null,
  ): Promise<void>;
  updateFocus(id: string, focus: string | null): Promise<void>;
  updateVisibility(id: string, visibility: SessionVisibility): Promise<void>;
  deleteSession(id: string): Promise<void>;
  archiveSession(id: string): Promise<void>;
  unarchiveSession(id: string): Promise<void>;
  addMessage(msg: {
    sessionId: string;
    role: "user" | "assistant" | "system";
    kind?: "chat" | "shell";
    content: string;
    toolCalls?: Array<{ name: string; input: unknown; result?: unknown }>;
    turnId?: string;
    authorUserId?: string | null;
  }): Promise<StoredMessage>;
  getMessages(
    sessionId: string,
    opts?: { limit?: number; offset?: number; pinnedOnly?: boolean },
  ): Promise<StoredMessage[]>;
  getMessage(id: number): Promise<StoredMessage | null>;
  getUserMessageIdsByTurnIds(turnIds: string[]): Promise<Map<string, number>>;
  pinMessage(id: number, scope?: "session" | "project"): Promise<void>;
  unpinMessage(id: number, scope?: "session" | "project"): Promise<void>;
  deleteMessage(id: number): Promise<boolean>;
  getPinnedMessages(
    sessionId: string,
    scope?: "session" | "project",
  ): Promise<StoredMessage[]>;
  getProjectPinnedMessages(): Promise<StoredMessage[]>;
  searchMessages(
    query: string,
    opts?: { sessionId?: string; limit?: number },
  ): Promise<StoredMessage[]>;
  getContextInfo(sessionId: string): Promise<{
    messageCount: number;
    estimatedTokens: number;
    pinnedCount: number;
    focus: string | null;
    usage: AggregatedUsage;
  }>;
  recordTurnUsage(usage: TurnUsage): Promise<void>;
  getTurnUsage(turnId: string): Promise<TurnUsage | null>;
  getSessionUsage(sessionId: string): Promise<AggregatedUsage>;
  getProjectUsage(opts?: ProjectUsageOptions): Promise<AggregatedUsage>;
  getTurnUsagesForSession(sessionId: string): Promise<TurnUsage[]>;
  recordModelUsage(input: RecordModelUsageInput): Promise<ModelUsageRecord>;
  getModelUsage(id: string): Promise<ModelUsageRecord | null>;
  getModelUsagesForTurn(turnId: string): Promise<ModelUsageRecord[]>;
  getModelUsagesForChangeset(changesetId: string): Promise<ModelUsageRecord[]>;
}

interface SessionCreateOptions {
  ownerUserId?: string;
  visibility?: SessionVisibility;
  userProfile?: CurrentUser;
}

export interface SessionListOptions {
  includeArchived?: boolean;
}

// --- File-backed storage ---

class FileSessionStore implements SessionStore {
  private historyDir: string;
  // Cached max message id for the file-backed path, so addMessage doesn't
  // re-scan every message file on every append. Lazily seeded from disk.
  private fileMaxMessageId: number | null = null;

  constructor(historyDir: string) {
    this.historyDir = historyDir;
    ensureDir(this.sessionsDir());
    ensureDir(this.messagesDir());
    ensureDir(this.usageDir());
  }

  private sessionsDir(): string {
    return join(this.historyDir, "sessions");
  }

  private messagesDir(): string {
    return join(this.historyDir, "messages");
  }

  private usageDir(): string {
    return join(this.historyDir, "usage");
  }

  private sessionPath(id: string): string {
    return join(this.sessionsDir(), `${encodeURIComponent(id)}.json`);
  }

  private messagesPath(sessionId: string): string {
    return join(this.messagesDir(), `${encodeURIComponent(sessionId)}.jsonl`);
  }

  private usagePath(sessionId: string): string {
    return join(this.usageDir(), `${encodeURIComponent(sessionId)}.jsonl`);
  }

  private modelUsagePath(): string {
    return join(this.historyDir, "model-usage.jsonl");
  }

  private readSessionFile(id: string): Session | null {
    const session = readJsonFile<Session>(this.sessionPath(id));
    return session ? normalizeSession(session) : null;
  }

  private writeSessionFile(session: Session): void {
    writeJsonIfChanged(this.sessionPath(session.id), session);
  }

  private listSessionFiles(): Session[] {
    const dir = this.sessionsDir();
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((file) => file.endsWith(".json"))
      .map((file) => readJsonFile<Session>(join(dir, file)))
      .filter((session): session is Session => Boolean(session))
      .map(normalizeSession);
  }

  private readMessageFile(sessionId: string): StoredMessage[] {
    return readJsonLines<StoredMessage>(this.messagesPath(sessionId))
      .map(normalizeMessage);
  }

  private writeMessageFile(sessionId: string, messages: StoredMessage[]): void {
    rewriteJsonLines(this.messagesPath(sessionId), messages);
  }

  private listAllMessages(): StoredMessage[] {
    const dir = this.messagesDir();
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((file) => file.endsWith(".jsonl"))
      .flatMap((file) => readJsonLines<StoredMessage>(join(dir, file)))
      .map(normalizeMessage);
  }

  // Monotonic message id without re-scanning every message file per append.
  // Seeds the max once from disk, then advances in memory. createMergeableNumericId
  // is time-based, so a deleted-message gap never needs to be reused.
  private nextFileMessageId(): number {
    if (this.fileMaxMessageId === null) {
      this.fileMaxMessageId = this.listAllMessages()
        .reduce((max, m) => Math.max(max, m.id), 0);
    }
    const id = createMergeableNumericId([this.fileMaxMessageId]);
    this.fileMaxMessageId = id;
    return id;
  }

  private readUsageFile(sessionId: string): TurnUsage[] {
    return readJsonLines<TurnUsage>(this.usagePath(sessionId));
  }

  private listAllUsage(): TurnUsage[] {
    const dir = this.usageDir();
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((file) => file.endsWith(".jsonl"))
      .flatMap((file) => readJsonLines<TurnUsage>(join(dir, file)));
  }

  private readModelUsageFile(): ModelUsageRecord[] {
    return readJsonLines<ModelUsageRecord>(this.modelUsagePath());
  }

  private writeModelUsageFile(rows: ModelUsageRecord[]): void {
    rewriteJsonLines(
      this.modelUsagePath(),
      rows.toSorted((a, b) => a.startedAt.localeCompare(b.startedAt)),
    );
  }

  async createSession(
    name?: string,
    opts: SessionCreateOptions = {},
  ): Promise<Session> {
    const ownerUserId = opts.ownerUserId ?? opts.userProfile?.id ??
      fallbackUserId();
    const visibility = opts.visibility ?? "private";
    if (!name) {
      const existing = this.findEmptySession(ownerUserId, visibility);
      if (existing) return existing;
    }

    const now = new Date().toISOString();
    const session: Session = {
      id: createTimestampedId("session"),
      name: name ?? "New Session",
      startedAt: now,
      endedAt: null,
      summary: null,
      focus: null,
      metadata: null,
      archived: false,
      ownerUserId,
      visibility,
    };
    this.writeSessionFile(session);
    if (opts.userProfile) this.writeUserProfileSnapshot(opts.userProfile);
    return session;
  }

  private writeUserProfileSnapshot(user: CurrentUser): void {
    const path = join(
      this.historyDir,
      "users",
      `${encodeURIComponent(user.id)}.json`,
    );
    writeJsonIfChanged(path, profileSnapshot(user));
  }

  private findEmptySession(
    ownerUserId: string,
    visibility: SessionVisibility,
  ): Session | null {
    const sessions = this.listSessionFiles()
      .filter((s) =>
        s.name === "New Session" && !s.archived &&
        s.ownerUserId === ownerUserId &&
        s.visibility === visibility &&
        s.endedAt == null &&
        this.readMessageFile(s.id).length === 0
      )
      .toSorted((a, b) => b.startedAt.localeCompare(a.startedAt));
    for (const stale of sessions.slice(1)) {
      rmSync(this.sessionPath(stale.id), { force: true });
    }
    return sessions[0] ?? null;
  }

  async endSession(id: string): Promise<void> {
    const session = this.readSessionFile(id);
    if (session) {
      this.writeSessionFile({
        ...session,
        endedAt: new Date().toISOString(),
      });
    }
  }

  async reopenSession(id: string): Promise<void> {
    const session = this.readSessionFile(id);
    if (session) {
      this.writeSessionFile({
        ...session,
        endedAt: null,
        startedAt: new Date().toISOString(),
      });
    }
  }

  async getSession(id: string): Promise<Session | null> {
    return this.readSessionFile(id);
  }

  async listSessions(
    limit = 20,
    offset = 0,
    opts: SessionListOptions = {},
  ): Promise<SessionWithLastMessage[]> {
    return this.listSessionFiles()
      .filter((session) => opts.includeArchived || !session.archived)
      .map((session) => {
        const last = this.readMessageFile(session.id).at(-1);
        return { ...session, lastMessageAt: last?.createdAt ?? null };
      })
      .toSorted((a, b) =>
        sessionActivityAt(b).localeCompare(sessionActivityAt(a))
      )
      .slice(offset, offset + limit);
  }

  async renameSession(id: string, name: string): Promise<void> {
    const session = this.readSessionFile(id);
    if (session) this.writeSessionFile({ ...session, name });
  }

  async updateSummary(id: string, summary: string): Promise<void> {
    const session = this.readSessionFile(id);
    if (session) this.writeSessionFile({ ...session, summary });
  }

  async updateSummaryMetadata(
    id: string,
    summary: string | null,
    metadata: string | null,
  ): Promise<void> {
    const session = this.readSessionFile(id);
    if (session) this.writeSessionFile({ ...session, summary, metadata });
  }

  async updateFocus(id: string, focus: string | null): Promise<void> {
    const session = this.readSessionFile(id);
    if (session) this.writeSessionFile({ ...session, focus });
  }

  async updateVisibility(
    id: string,
    visibility: SessionVisibility,
  ): Promise<void> {
    const session = this.readSessionFile(id);
    if (session) this.writeSessionFile({ ...session, visibility });
  }

  async deleteSession(id: string): Promise<void> {
    rmSync(this.sessionPath(id), { force: true });
    rmSync(this.messagesPath(id), { force: true });
    rmSync(this.usagePath(id), { force: true });
    this.writeModelUsageFile(
      this.readModelUsageFile().filter((row) => row.sessionId !== id),
    );
  }

  async archiveSession(id: string): Promise<void> {
    const session = this.readSessionFile(id);
    if (session) this.writeSessionFile({ ...session, archived: true });
  }

  async unarchiveSession(id: string): Promise<void> {
    const session = this.readSessionFile(id);
    if (session) this.writeSessionFile({ ...session, archived: false });
  }

  async addMessage(msg: {
    sessionId: string;
    role: "user" | "assistant" | "system";
    kind?: "chat" | "shell";
    content: string;
    toolCalls?: Array<{ name: string; input: unknown; result?: unknown }>;
    turnId?: string;
    authorUserId?: string | null;
  }): Promise<StoredMessage> {
    const now = new Date().toISOString();
    const nextId = this.nextFileMessageId();
    const stored: StoredMessage = {
      id: nextId,
      sessionId: msg.sessionId,
      role: msg.role,
      kind: msg.kind ?? "chat",
      content: msg.content,
      toolCalls: msg.toolCalls ? JSON.stringify(msg.toolCalls) : null,
      pinned: false,
      projectPinned: false,
      turnId: msg.turnId ?? null,
      createdAt: now,
      authorUserId: msg.authorUserId ?? null,
    };
    appendJsonLine(this.messagesPath(msg.sessionId), stored);
    return stored;
  }

  async getMessages(
    sessionId: string,
    opts?: { limit?: number; offset?: number; pinnedOnly?: boolean },
  ): Promise<StoredMessage[]> {
    let messages = this.readMessageFile(sessionId);
    if (opts?.pinnedOnly) messages = messages.filter((m) => m.pinned);
    if (opts?.offset) messages = messages.slice(opts.offset);
    if (opts?.limit) messages = messages.slice(0, opts.limit);
    return messages;
  }

  async getMessage(id: number): Promise<StoredMessage | null> {
    return this.listAllMessages().find((m) => m.id === id) ?? null;
  }

  async getUserMessageIdsByTurnIds(
    turnIds: string[],
  ): Promise<Map<string, number>> {
    const wanted = new Set(turnIds);
    const result = new Map<string, number>();
    for (const msg of this.listAllMessages()) {
      if (msg.turnId && wanted.has(msg.turnId) && msg.role === "user") {
        result.set(msg.turnId, msg.id);
      }
    }
    return result;
  }

  async pinMessage(
    id: number,
    scope: "session" | "project" = "session",
  ): Promise<void> {
    for (const session of this.listSessionFiles()) {
      const messages = this.readMessageFile(session.id);
      const idx = messages.findIndex((m) => m.id === id);
      if (idx >= 0) {
        messages[idx] = scope === "project"
          ? { ...messages[idx]!, projectPinned: true }
          : { ...messages[idx]!, pinned: true };
        this.writeMessageFile(session.id, messages);
        return;
      }
    }
  }

  async unpinMessage(
    id: number,
    scope: "session" | "project" = "session",
  ): Promise<void> {
    for (const session of this.listSessionFiles()) {
      const messages = this.readMessageFile(session.id);
      const idx = messages.findIndex((m) => m.id === id);
      if (idx >= 0) {
        messages[idx] = scope === "project"
          ? { ...messages[idx]!, projectPinned: false }
          : { ...messages[idx]!, pinned: false };
        this.writeMessageFile(session.id, messages);
        return;
      }
    }
  }

  async deleteMessage(id: number): Promise<boolean> {
    for (const session of this.listSessionFiles()) {
      const messages = this.readMessageFile(session.id);
      const next = messages.filter((m) => m.id !== id);
      if (next.length !== messages.length) {
        this.writeMessageFile(session.id, next);
        return true;
      }
    }
    return false;
  }

  async getPinnedMessages(
    sessionId: string,
    scope: "session" | "project" = "session",
  ): Promise<StoredMessage[]> {
    return this.readMessageFile(sessionId).filter((m) =>
      scope === "project" ? m.projectPinned : m.pinned
    );
  }

  async getProjectPinnedMessages(): Promise<StoredMessage[]> {
    return this.listAllMessages()
      .filter((m) => m.projectPinned)
      .toSorted((a, b) => a.id - b.id);
  }

  async searchMessages(
    query: string,
    opts?: { sessionId?: string; limit?: number },
  ): Promise<StoredMessage[]> {
    const q = query.toLowerCase();
    return this.listAllMessages()
      .filter((m) =>
        (!opts?.sessionId || m.sessionId === opts.sessionId) &&
        m.content.toLowerCase().includes(q)
      )
      .toSorted((a, b) => b.id - a.id)
      .slice(0, opts?.limit ?? 20);
  }

  async getContextInfo(sessionId: string): Promise<{
    messageCount: number;
    estimatedTokens: number;
    pinnedCount: number;
    focus: string | null;
    usage: AggregatedUsage;
  }> {
    const messages = this.readMessageFile(sessionId);
    const session = await this.getSession(sessionId);
    const estimatedChars = messages.reduce(
      (sum, msg) => sum + stripModelContextContent(msg.content).length,
      0,
    );
    return {
      messageCount: messages.length,
      estimatedTokens: Math.ceil(estimatedChars / 4),
      pinnedCount: messages.filter((m) => m.pinned || m.projectPinned).length,
      focus: session?.focus ?? null,
      usage: await this.getSessionUsage(sessionId),
    };
  }

  async recordTurnUsage(usage: TurnUsage): Promise<void> {
    const rows = this.readUsageFile(usage.sessionId);
    const next = rows.filter((row) => row.turnId !== usage.turnId);
    next.push(usage);
    rewriteJsonLines(
      this.usagePath(usage.sessionId),
      next.toSorted((a, b) => a.startedAt.localeCompare(b.startedAt)),
    );
  }

  async getTurnUsage(turnId: string): Promise<TurnUsage | null> {
    const modelUsage = this.readModelUsageFile().filter((usage) =>
      usage.turnId === turnId
    );
    const ledgerUsage = turnUsageFromModelUsageRows(modelUsage);
    if (ledgerUsage) return ledgerUsage;
    return this.listAllUsage().find((usage) => usage.turnId === turnId) ??
      null;
  }

  async getSessionUsage(sessionId: string): Promise<AggregatedUsage> {
    const ledgerRows = this.readModelUsageFile().filter((row) =>
      row.sessionId === sessionId
    );
    return aggregateCombinedUsageRows(
      ledgerRows,
      this.readUsageFile(sessionId),
    );
  }

  async getProjectUsage(
    opts: ProjectUsageOptions = {},
  ): Promise<AggregatedUsage> {
    return aggregateCombinedUsageRows(
      this.readModelUsageFile(),
      this.listAllUsage(),
      opts,
    );
  }

  async getTurnUsagesForSession(sessionId: string): Promise<TurnUsage[]> {
    const byTurn = new Map<string, TurnUsage>();
    for (const usage of this.readUsageFile(sessionId)) {
      byTurn.set(usage.turnId, usage);
    }
    const ledgerByTurn = new Map<string, ModelUsageRecord[]>();
    for (const row of this.readModelUsageFile()) {
      if (row.sessionId !== sessionId || !row.turnId) continue;
      const rows = ledgerByTurn.get(row.turnId) ??
        ledgerByTurn.set(row.turnId, []).get(row.turnId)!;
      rows.push(row);
    }
    for (const [turnId, rows] of ledgerByTurn) {
      const usage = turnUsageFromModelUsageRows(rows);
      if (usage) byTurn.set(turnId, usage);
    }
    return [...byTurn.values()].toSorted((a, b) =>
      a.startedAt.localeCompare(b.startedAt)
    );
  }

  async recordModelUsage(
    input: RecordModelUsageInput,
  ): Promise<ModelUsageRecord> {
    const record = modelUsageFromInput(input);
    const rows = this.readModelUsageFile()
      .filter((row) => row.id !== record.id);
    rows.push(record);
    this.writeModelUsageFile(rows);
    return record;
  }

  async getModelUsage(id: string): Promise<ModelUsageRecord | null> {
    return this.readModelUsageFile().find((row) => row.id === id) ?? null;
  }

  async getModelUsagesForTurn(turnId: string): Promise<ModelUsageRecord[]> {
    return this.readModelUsageFile()
      .filter((row) => row.turnId === turnId)
      .toSorted((a, b) => a.startedAt.localeCompare(b.startedAt));
  }

  async getModelUsagesForChangeset(
    changesetId: string,
  ): Promise<ModelUsageRecord[]> {
    return this.readModelUsageFile()
      .filter((row) => row.changesetId === changesetId)
      .toSorted((a, b) => a.startedAt.localeCompare(b.startedAt));
  }
}

// --- DB-backed storage ---

class DbSessionStore implements SessionStore {
  private db: DrizzleDb;
  private ready: Promise<void> | null = null;

  constructor(db: DrizzleDb) {
    this.db = db;
  }

  private ensureReady(): Promise<void> {
    this.ready ??= this.ensureCompatibilitySchema();
    return this.ready;
  }

  private async ensureCompatibilitySchema(): Promise<void> {
    await this.ensureAuthColumns();
    await this.ensureModelUsageTable();
  }

  private async ensureAuthColumns(): Promise<void> {
    await this.db.execute(
      sql`ALTER TABLE "_genie_sessions" ADD COLUMN IF NOT EXISTS "owner_user_id" text DEFAULT 'local_legacy' NOT NULL`,
    );
    await this.db.execute(
      sql`ALTER TABLE "_genie_sessions" ADD COLUMN IF NOT EXISTS "visibility" text DEFAULT 'project' NOT NULL`,
    );
    await this.db.execute(
      sql`ALTER TABLE "_genie_sessions" ALTER COLUMN "visibility" SET DEFAULT 'private'`,
    );
    await this.db.execute(
      sql`UPDATE "_genie_sessions" SET "owner_user_id" = ${fallbackUserId()} WHERE "owner_user_id" = 'local_legacy'`,
    );
    await this.db.execute(
      sql`ALTER TABLE "_genie_messages" ADD COLUMN IF NOT EXISTS "author_user_id" text`,
    );
    await this.db.execute(
      sql`ALTER TABLE "_genie_messages" ADD COLUMN IF NOT EXISTS "kind" text DEFAULT 'chat' NOT NULL`,
    );
  }

  private async ensureModelUsageTable(): Promise<void> {
    await this.db.execute(sql`
      CREATE TABLE IF NOT EXISTS "_genie_model_usage" (
        "id" text PRIMARY KEY NOT NULL,
        "session_id" text REFERENCES "_genie_sessions"("id") ON DELETE cascade,
        "turn_id" text,
        "audit_result_id" text,
        "changeset_id" text,
        "provider" text NOT NULL,
        "model" text NOT NULL,
        "role" text NOT NULL,
        "caller" text NOT NULL,
        "started_at" text NOT NULL,
        "ended_at" text NOT NULL,
        "duration_ms" integer DEFAULT 0 NOT NULL,
        "input_tokens" integer DEFAULT 0 NOT NULL,
        "output_tokens" integer DEFAULT 0 NOT NULL,
        "cache_creation_input_tokens" integer DEFAULT 0 NOT NULL,
        "cache_read_input_tokens" integer DEFAULT 0 NOT NULL,
        "tool_calls_count" integer DEFAULT 0 NOT NULL,
        "cost_usd" real,
        "pricing_status" text NOT NULL,
        "pricing_provider" text,
        "pricing_model" text,
        "pricing_verified_at" text,
        "pricing_source" text,
        "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL
      )
    `);
    // Added after the table shipped (Slice 8): existing ledgers get the column
    // back-filled as NULL, which reads as "written before provenance was
    // recorded" rather than as a known source.
    await this.db.execute(
      sql`ALTER TABLE "_genie_model_usage" ADD COLUMN IF NOT EXISTS "pricing_source" text`,
    );
    await this.db.execute(sql`
      CREATE INDEX IF NOT EXISTS "model_usage_session_id_idx"
      ON "_genie_model_usage" ("session_id")
    `);
    await this.db.execute(sql`
      CREATE INDEX IF NOT EXISTS "model_usage_turn_id_idx"
      ON "_genie_model_usage" ("turn_id")
    `);
    await this.db.execute(sql`
      CREATE INDEX IF NOT EXISTS "model_usage_started_at_idx"
      ON "_genie_model_usage" ("started_at")
    `);
  }

  async createSession(
    name?: string,
    opts: SessionCreateOptions = {},
  ): Promise<Session> {
    await this.ensureReady();
    const ownerUserId = opts.ownerUserId ?? opts.userProfile?.id ??
      fallbackUserId();
    const visibility = opts.visibility ?? "private";
    if (!name) {
      const existing = await this.findEmptySession(ownerUserId, visibility);
      if (existing) return existing;
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const sessionName = name ?? "New Session";

    await this.db.insert(genieSessionsTable).values({
      id,
      name: sessionName,
      startedAt: now,
      ownerUserId,
      visibility,
    });

    return {
      id,
      name: sessionName,
      startedAt: now,
      endedAt: null,
      summary: null,
      focus: null,
      metadata: null,
      archived: false,
      ownerUserId,
      visibility,
    };
  }

  private async findEmptySession(
    ownerUserId: string,
    visibility: SessionVisibility,
  ): Promise<Session | null> {
    await this.ensureReady();
    const rows = await this.db
      .select({
        session: genieSessionsTable,
        messageCount: count(genieMessagesTable.id),
      })
      .from(genieSessionsTable)
      .leftJoin(
        genieMessagesTable,
        eq(genieSessionsTable.id, genieMessagesTable.sessionId),
      )
      .where(
        and(
          eq(genieSessionsTable.name, "New Session"),
          eq(genieSessionsTable.archived, false),
          eq(genieSessionsTable.ownerUserId, ownerUserId),
          eq(genieSessionsTable.visibility, visibility),
          isNull(genieSessionsTable.endedAt),
        ),
      )
      .groupBy(genieSessionsTable.id)
      .having(sql`count(${genieMessagesTable.id}) = 0`)
      .orderBy(desc(genieSessionsTable.startedAt));

    if (rows.length === 0) return null;

    // Delete duplicate empty sessions, keep only the most recent
    if (rows.length > 1) {
      const idsToDelete = rows.slice(1).map((r) => r.session.id);
      await this.db
        .delete(genieSessionsTable)
        .where(inArray(genieSessionsTable.id, idsToDelete));
    }

    return rowToSession(rows[0]!.session);
  }

  async endSession(id: string): Promise<void> {
    await this.ensureReady();
    await this.db
      .update(genieSessionsTable)
      .set({ endedAt: new Date().toISOString() })
      .where(eq(genieSessionsTable.id, id));
  }

  async reopenSession(id: string): Promise<void> {
    await this.ensureReady();
    await this.db
      .update(genieSessionsTable)
      .set({ endedAt: null, startedAt: new Date().toISOString() })
      .where(eq(genieSessionsTable.id, id));
  }

  async getSession(id: string): Promise<Session | null> {
    await this.ensureReady();
    const rows = await this.db
      .select()
      .from(genieSessionsTable)
      .where(eq(genieSessionsTable.id, id))
      .limit(1);
    return rows[0] ? rowToSession(rows[0]) : null;
  }

  async listSessions(
    limit = 20,
    offset = 0,
    opts: SessionListOptions = {},
  ): Promise<SessionWithLastMessage[]> {
    await this.ensureReady();
    const lastMsg = this.db
      .select({
        sessionId: genieMessagesTable.sessionId,
        lastMessageAt: sql<string>`max(${genieMessagesTable.createdAt})`.as(
          "last_message_at",
        ),
      })
      .from(genieMessagesTable)
      .groupBy(genieMessagesTable.sessionId)
      .as("last_msg");

    let query = this.db
      .select({
        session: genieSessionsTable,
        lastMessageAt: lastMsg.lastMessageAt,
      })
      .from(genieSessionsTable)
      .leftJoin(lastMsg, eq(genieSessionsTable.id, lastMsg.sessionId))
      .$dynamic();

    if (!opts.includeArchived) {
      query = query.where(eq(genieSessionsTable.archived, false));
    }

    const rows = await query
      .orderBy(
        desc(
          sql`coalesce(${lastMsg.lastMessageAt}, ${genieSessionsTable.startedAt})`,
        ),
      )
      .limit(limit)
      .offset(offset);
    return rows.map((r) => ({
      ...rowToSession(r.session),
      lastMessageAt: r.lastMessageAt,
    }));
  }

  async renameSession(id: string, name: string): Promise<void> {
    await this.ensureReady();
    await this.db
      .update(genieSessionsTable)
      .set({ name })
      .where(eq(genieSessionsTable.id, id));
  }

  async updateSummary(id: string, summary: string): Promise<void> {
    await this.ensureReady();
    await this.db
      .update(genieSessionsTable)
      .set({ summary })
      .where(eq(genieSessionsTable.id, id));
  }

  async updateSummaryMetadata(
    id: string,
    summary: string | null,
    metadata: string | null,
  ): Promise<void> {
    await this.ensureReady();
    await this.db
      .update(genieSessionsTable)
      .set({ summary, metadata })
      .where(eq(genieSessionsTable.id, id));
  }

  async updateFocus(id: string, focus: string | null): Promise<void> {
    await this.ensureReady();
    await this.db
      .update(genieSessionsTable)
      .set({ focus })
      .where(eq(genieSessionsTable.id, id));
  }

  async updateVisibility(
    id: string,
    visibility: SessionVisibility,
  ): Promise<void> {
    await this.ensureReady();
    await this.db
      .update(genieSessionsTable)
      .set({ visibility })
      .where(eq(genieSessionsTable.id, id));
  }

  async deleteSession(id: string): Promise<void> {
    await this.ensureReady();
    await this.db.delete(genieSessionsTable).where(
      eq(genieSessionsTable.id, id),
    );
  }

  async archiveSession(id: string): Promise<void> {
    await this.ensureReady();
    await this.db
      .update(genieSessionsTable)
      .set({ archived: true })
      .where(eq(genieSessionsTable.id, id));
  }

  async unarchiveSession(id: string): Promise<void> {
    await this.ensureReady();
    await this.db
      .update(genieSessionsTable)
      .set({ archived: false })
      .where(eq(genieSessionsTable.id, id));
  }

  async addMessage(msg: {
    sessionId: string;
    role: "user" | "assistant" | "system";
    kind?: "chat" | "shell";
    content: string;
    toolCalls?: Array<{ name: string; input: unknown; result?: unknown }>;
    turnId?: string;
    authorUserId?: string | null;
  }): Promise<StoredMessage> {
    await this.ensureReady();
    const now = new Date().toISOString();
    const toolCallsJson = msg.toolCalls ? JSON.stringify(msg.toolCalls) : null;

    const rows = await this.db
      .insert(genieMessagesTable)
      .values({
        sessionId: msg.sessionId,
        role: msg.role,
        kind: msg.kind ?? "chat",
        content: msg.content,
        toolCalls: toolCallsJson,
        pinned: false,
        projectPinned: false,
        turnId: msg.turnId ?? null,
        createdAt: now,
        authorUserId: msg.authorUserId ?? null,
      })
      .returning();

    return rowToMessage(rows[0]!);
  }

  async getMessages(
    sessionId: string,
    opts?: { limit?: number; offset?: number; pinnedOnly?: boolean },
  ): Promise<StoredMessage[]> {
    await this.ensureReady();
    let query = this.db
      .select()
      .from(genieMessagesTable)
      .where(and(
        eq(genieMessagesTable.sessionId, sessionId),
        opts?.pinnedOnly ? eq(genieMessagesTable.pinned, true) : undefined,
      ))
      .orderBy(asc(genieMessagesTable.id))
      .$dynamic();

    if (opts?.limit) query = query.limit(opts.limit);
    if (opts?.offset) query = query.offset(opts.offset);

    const rows = await query;
    return rows.map(rowToMessage);
  }

  async getMessage(id: number): Promise<StoredMessage | null> {
    await this.ensureReady();
    const rows = await this.db
      .select()
      .from(genieMessagesTable)
      .where(eq(genieMessagesTable.id, id))
      .limit(1);
    return rows[0] ? rowToMessage(rows[0]) : null;
  }

  async getUserMessageIdsByTurnIds(
    turnIds: string[],
  ): Promise<Map<string, number>> {
    await this.ensureReady();
    if (turnIds.length === 0) return new Map();
    const rows = await this.db
      .select({ id: genieMessagesTable.id, turnId: genieMessagesTable.turnId })
      .from(genieMessagesTable)
      .where(and(
        inArray(genieMessagesTable.turnId, turnIds),
        eq(genieMessagesTable.role, "user"),
      ));
    const result = new Map<string, number>();
    for (const r of rows) {
      if (r.turnId) result.set(r.turnId, r.id);
    }
    return result;
  }

  async pinMessage(
    id: number,
    scope: "session" | "project" = "session",
  ): Promise<void> {
    await this.ensureReady();
    await this.db
      .update(genieMessagesTable)
      .set(scope === "project" ? { projectPinned: true } : { pinned: true })
      .where(eq(genieMessagesTable.id, id));
  }

  async unpinMessage(
    id: number,
    scope: "session" | "project" = "session",
  ): Promise<void> {
    await this.ensureReady();
    await this.db
      .update(genieMessagesTable)
      .set(scope === "project" ? { projectPinned: false } : { pinned: false })
      .where(eq(genieMessagesTable.id, id));
  }

  async deleteMessage(id: number): Promise<boolean> {
    await this.ensureReady();
    const result = await this.db
      .delete(genieMessagesTable)
      .where(eq(genieMessagesTable.id, id));
    return ((result as { rowCount?: number }).rowCount ?? 0) > 0;
  }

  async getPinnedMessages(
    sessionId: string,
    scope: "session" | "project" = "session",
  ): Promise<StoredMessage[]> {
    await this.ensureReady();
    const rows = await this.db
      .select()
      .from(genieMessagesTable)
      .where(and(
        eq(genieMessagesTable.sessionId, sessionId),
        scope === "project"
          ? eq(genieMessagesTable.projectPinned, true)
          : eq(genieMessagesTable.pinned, true),
      ))
      .orderBy(asc(genieMessagesTable.id));
    return rows.map(rowToMessage);
  }

  async getProjectPinnedMessages(): Promise<StoredMessage[]> {
    await this.ensureReady();
    const rows = await this.db
      .select()
      .from(genieMessagesTable)
      .where(eq(genieMessagesTable.projectPinned, true))
      .orderBy(asc(genieMessagesTable.id));
    return rows.map(rowToMessage);
  }

  async searchMessages(
    query: string,
    opts?: { sessionId?: string; limit?: number },
  ): Promise<StoredMessage[]> {
    await this.ensureReady();
    const limit = opts?.limit ?? 20;

    try {
      const tsQuery = query.trim().split(/\s+/).map((w) =>
        w.replace(/[^a-zA-Z0-9]/g, "")
      ).filter(Boolean).join(" & ");
      if (!tsQuery) return [];
      const rows = await this.db
        .select()
        .from(genieMessagesTable)
        .where(and(
          sql`to_tsvector('english', ${genieMessagesTable.content}) @@ to_tsquery('english', ${tsQuery})`,
          opts?.sessionId
            ? eq(genieMessagesTable.sessionId, opts.sessionId)
            : undefined,
        ))
        .orderBy(
          sql`ts_rank(to_tsvector('english', ${genieMessagesTable.content}), to_tsquery('english', ${tsQuery})) DESC`,
          desc(genieMessagesTable.id),
        )
        .limit(limit);
      if (rows.length > 0) return rows.map(rowToMessage);
    } catch {
      // fall through to ILIKE
    }

    const pattern = `%${query}%`;
    const rows = await this.db
      .select()
      .from(genieMessagesTable)
      .where(and(
        ilike(genieMessagesTable.content, pattern),
        opts?.sessionId
          ? eq(genieMessagesTable.sessionId, opts.sessionId)
          : undefined,
      ))
      .orderBy(desc(genieMessagesTable.id))
      .limit(limit);
    return rows.map(rowToMessage);
  }

  async getContextInfo(sessionId: string): Promise<{
    messageCount: number;
    estimatedTokens: number;
    pinnedCount: number;
    focus: string | null;
    usage: AggregatedUsage;
  }> {
    await this.ensureReady();
    const [countRow, contentRows, pinnedRow, session, usage] = await Promise
      .all([
        this.db
          .select({ c: count() })
          .from(genieMessagesTable)
          .where(eq(genieMessagesTable.sessionId, sessionId)),
        this.db
          .select({ content: genieMessagesTable.content })
          .from(genieMessagesTable)
          .where(eq(genieMessagesTable.sessionId, sessionId)),
        this.db
          .select({ c: count() })
          .from(genieMessagesTable)
          .where(and(
            eq(genieMessagesTable.sessionId, sessionId),
            sql`(${genieMessagesTable.pinned} = true or ${genieMessagesTable.projectPinned} = true)`,
          )),
        this.getSession(sessionId),
        this.getSessionUsage(sessionId),
      ]);

    const estimatedChars = contentRows.reduce(
      (sum, row) => sum + stripModelContextContent(row.content).length,
      0,
    );

    return {
      messageCount: countRow[0]!.c,
      estimatedTokens: Math.ceil(estimatedChars / 4),
      pinnedCount: pinnedRow[0]!.c,
      focus: session?.focus ?? null,
      usage,
    };
  }

  async recordTurnUsage(usage: TurnUsage): Promise<void> {
    await this.ensureReady();
    await this.db
      .insert(genieTurnUsageTable)
      .values({
        turnId: usage.turnId,
        sessionId: usage.sessionId,
        model: usage.model,
        startedAt: usage.startedAt,
        endedAt: usage.endedAt,
        durationMs: usage.durationMs,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheCreationInputTokens: usage.cacheCreationInputTokens,
        cacheReadInputTokens: usage.cacheReadInputTokens,
        toolCallsCount: usage.toolCallsCount,
        costUsd: usage.costUsd,
      })
      .onConflictDoUpdate({
        target: genieTurnUsageTable.turnId,
        set: {
          model: usage.model,
          startedAt: usage.startedAt,
          endedAt: usage.endedAt,
          durationMs: usage.durationMs,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cacheCreationInputTokens: usage.cacheCreationInputTokens,
          cacheReadInputTokens: usage.cacheReadInputTokens,
          toolCallsCount: usage.toolCallsCount,
          costUsd: usage.costUsd,
        },
      });
  }

  async getTurnUsage(turnId: string): Promise<TurnUsage | null> {
    await this.ensureReady();
    const modelRows = await this.db
      .select()
      .from(genieModelUsageTable)
      .where(eq(genieModelUsageTable.turnId, turnId))
      .orderBy(asc(genieModelUsageTable.startedAt));
    const ledgerUsage = turnUsageFromModelUsageRows(
      modelRows.map(rowToModelUsage),
    );
    if (ledgerUsage) return ledgerUsage;
    const rows = await this.db
      .select()
      .from(genieTurnUsageTable)
      .where(eq(genieTurnUsageTable.turnId, turnId))
      .limit(1);
    return rows[0] ? rowToTurnUsage(rows[0]) : null;
  }

  getSessionUsage(sessionId: string): Promise<AggregatedUsage> {
    return this.aggregateUsageFromModelLedger(
      eq(genieModelUsageTable.sessionId, sessionId),
      eq(genieTurnUsageTable.sessionId, sessionId),
    );
  }

  getProjectUsage(opts: ProjectUsageOptions = {}): Promise<AggregatedUsage> {
    const modelFilters: SQL[] = [];
    const turnFilters: SQL[] = [];
    if (opts.since) {
      modelFilters.push(
        sql`${genieModelUsageTable.startedAt} >= ${opts.since}`,
      );
      turnFilters.push(sql`${genieTurnUsageTable.startedAt} >= ${opts.since}`);
    }
    return this.aggregateUsageFromModelLedger(
      modelFilters.length === 0 ? undefined : and(...modelFilters),
      turnFilters.length === 0 ? undefined : and(...turnFilters),
    );
  }

  private async aggregateUsageFromModelLedger(
    modelFilter?: SQL,
    turnFallbackFilter?: SQL,
  ): Promise<AggregatedUsage> {
    await this.ensureReady();
    const modelQuery = this.db.select().from(genieModelUsageTable);
    const turnQuery = this.db.select().from(genieTurnUsageTable);
    const [modelRows, turnRows] = await Promise.all([
      modelFilter ? modelQuery.where(modelFilter) : modelQuery,
      turnFallbackFilter ? turnQuery.where(turnFallbackFilter) : turnQuery,
    ]);
    return aggregateCombinedUsageRows(
      modelRows.map(rowToModelUsage),
      turnRows.map(rowToTurnUsage),
    );
  }

  async getTurnUsagesForSession(sessionId: string): Promise<TurnUsage[]> {
    await this.ensureReady();
    const turnRows = await this.db
      .select()
      .from(genieTurnUsageTable)
      .where(eq(genieTurnUsageTable.sessionId, sessionId))
      .orderBy(asc(genieTurnUsageTable.startedAt));
    const modelRows = await this.db
      .select()
      .from(genieModelUsageTable)
      .where(eq(genieModelUsageTable.sessionId, sessionId))
      .orderBy(asc(genieModelUsageTable.startedAt));
    const byTurn = new Map<string, TurnUsage>();
    for (const row of turnRows) {
      const usage = rowToTurnUsage(row);
      byTurn.set(usage.turnId, usage);
    }
    const ledgerByTurn = new Map<string, ModelUsageRecord[]>();
    for (const row of modelRows.map(rowToModelUsage)) {
      if (!row.turnId) continue;
      const rows = ledgerByTurn.get(row.turnId) ??
        ledgerByTurn.set(row.turnId, []).get(row.turnId)!;
      rows.push(row);
    }
    for (const [turnId, rows] of ledgerByTurn) {
      const usage = turnUsageFromModelUsageRows(rows);
      if (usage) byTurn.set(turnId, usage);
    }
    return [...byTurn.values()].toSorted((a, b) =>
      a.startedAt.localeCompare(b.startedAt)
    );
  }

  async recordModelUsage(
    input: RecordModelUsageInput,
  ): Promise<ModelUsageRecord> {
    await this.ensureReady();
    const record = modelUsageFromInput(input);
    const values = {
      id: record.id,
      sessionId: record.sessionId,
      turnId: record.turnId,
      auditResultId: record.auditResultId,
      changesetId: record.changesetId,
      provider: record.provider,
      model: record.model,
      role: record.role,
      caller: record.caller,
      startedAt: record.startedAt,
      endedAt: record.endedAt,
      durationMs: record.durationMs,
      inputTokens: record.inputTokens,
      outputTokens: record.outputTokens,
      cacheCreationInputTokens: record.cacheCreationInputTokens,
      cacheReadInputTokens: record.cacheReadInputTokens,
      toolCallsCount: record.toolCallsCount,
      costUsd: record.costUsd,
      pricingStatus: record.pricingStatus,
      pricingProvider: record.pricingProvider,
      pricingModel: record.pricingModel,
      pricingVerifiedAt: record.pricingVerifiedAt,
      pricingSource: record.pricingSource,
      metadata: record.metadata,
    };
    const rows = await this.db
      .insert(genieModelUsageTable)
      .values(values)
      .onConflictDoUpdate({
        target: genieModelUsageTable.id,
        set: values,
      })
      .returning();
    return rowToModelUsage(rows[0]!);
  }

  async getModelUsage(id: string): Promise<ModelUsageRecord | null> {
    await this.ensureReady();
    const rows = await this.db
      .select()
      .from(genieModelUsageTable)
      .where(eq(genieModelUsageTable.id, id))
      .limit(1);
    return rows[0] ? rowToModelUsage(rows[0]) : null;
  }

  async getModelUsagesForTurn(turnId: string): Promise<ModelUsageRecord[]> {
    await this.ensureReady();
    const rows = await this.db
      .select()
      .from(genieModelUsageTable)
      .where(eq(genieModelUsageTable.turnId, turnId))
      .orderBy(asc(genieModelUsageTable.startedAt));
    return rows.map(rowToModelUsage);
  }

  async getModelUsagesForChangeset(
    changesetId: string,
  ): Promise<ModelUsageRecord[]> {
    await this.ensureReady();
    const rows = await this.db
      .select()
      .from(genieModelUsageTable)
      .where(eq(genieModelUsageTable.changesetId, changesetId))
      .orderBy(asc(genieModelUsageTable.startedAt));
    return rows.map(rowToModelUsage);
  }
}

// --- Facade ---

export class SessionManager {
  private store: SessionStore;

  constructor(storage: DrizzleDb | string) {
    this.store = typeof storage === "string"
      ? new FileSessionStore(storage)
      : new DbSessionStore(storage);
  }

  createSession(name?: string, opts?: SessionCreateOptions): Promise<Session> {
    return this.store.createSession(name, opts);
  }

  endSession(id: string): Promise<void> {
    return this.store.endSession(id);
  }

  reopenSession(id: string): Promise<void> {
    return this.store.reopenSession(id);
  }

  getSession(id: string): Promise<Session | null> {
    return this.store.getSession(id);
  }

  listSessions(
    limit = 20,
    offset = 0,
    opts?: SessionListOptions,
  ): Promise<SessionWithLastMessage[]> {
    return this.store.listSessions(limit, offset, opts);
  }

  renameSession(id: string, name: string): Promise<void> {
    return this.store.renameSession(id, name);
  }

  updateSummary(id: string, summary: string): Promise<void> {
    return this.store.updateSummary(id, summary);
  }

  updateSummaryMetadata(
    id: string,
    summary: string | null,
    metadata: string | null,
  ): Promise<void> {
    return this.store.updateSummaryMetadata(id, summary, metadata);
  }

  updateFocus(id: string, focus: string | null): Promise<void> {
    return this.store.updateFocus(id, focus);
  }

  updateVisibility(id: string, visibility: SessionVisibility): Promise<void> {
    return this.store.updateVisibility(id, visibility);
  }

  deleteSession(id: string): Promise<void> {
    return this.store.deleteSession(id);
  }

  archiveSession(id: string): Promise<void> {
    return this.store.archiveSession(id);
  }

  unarchiveSession(id: string): Promise<void> {
    return this.store.unarchiveSession(id);
  }

  addMessage(msg: {
    sessionId: string;
    role: "user" | "assistant" | "system";
    kind?: "chat" | "shell";
    content: string;
    toolCalls?: Array<{ name: string; input: unknown; result?: unknown }>;
    turnId?: string;
    authorUserId?: string | null;
  }): Promise<StoredMessage> {
    return this.store.addMessage(msg);
  }

  getMessages(
    sessionId: string,
    opts?: { limit?: number; offset?: number; pinnedOnly?: boolean },
  ): Promise<StoredMessage[]> {
    return this.store.getMessages(sessionId, opts);
  }

  getMessage(id: number): Promise<StoredMessage | null> {
    return this.store.getMessage(id);
  }

  getUserMessageIdsByTurnIds(
    turnIds: string[],
  ): Promise<Map<string, number>> {
    return this.store.getUserMessageIdsByTurnIds(turnIds);
  }

  pinMessage(
    id: number,
    scope: "session" | "project" = "session",
  ): Promise<void> {
    return this.store.pinMessage(id, scope);
  }

  unpinMessage(
    id: number,
    scope: "session" | "project" = "session",
  ): Promise<void> {
    return this.store.unpinMessage(id, scope);
  }

  deleteMessage(id: number): Promise<boolean> {
    return this.store.deleteMessage(id);
  }

  getPinnedMessages(
    sessionId: string,
    scope: "session" | "project" = "session",
  ): Promise<StoredMessage[]> {
    return this.store.getPinnedMessages(sessionId, scope);
  }

  getProjectPinnedMessages(): Promise<StoredMessage[]> {
    return this.store.getProjectPinnedMessages();
  }

  searchMessages(
    query: string,
    opts?: { sessionId?: string; limit?: number },
  ): Promise<StoredMessage[]> {
    return this.store.searchMessages(query, opts);
  }

  getContextInfo(sessionId: string): Promise<{
    messageCount: number;
    estimatedTokens: number;
    pinnedCount: number;
    focus: string | null;
    usage: AggregatedUsage;
  }> {
    return this.store.getContextInfo(sessionId);
  }

  recordTurnUsage(usage: TurnUsage): Promise<void> {
    return this.store.recordTurnUsage(usage);
  }

  getTurnUsage(turnId: string): Promise<TurnUsage | null> {
    return this.store.getTurnUsage(turnId);
  }

  getSessionUsage(sessionId: string): Promise<AggregatedUsage> {
    return this.store.getSessionUsage(sessionId);
  }

  getProjectUsage(opts?: ProjectUsageOptions): Promise<AggregatedUsage> {
    return this.store.getProjectUsage(opts);
  }

  getTurnUsagesForSession(sessionId: string): Promise<TurnUsage[]> {
    return this.store.getTurnUsagesForSession(sessionId);
  }

  recordModelUsage(
    input: RecordModelUsageInput,
  ): Promise<ModelUsageRecord> {
    return this.store.recordModelUsage(input);
  }

  getModelUsage(id: string): Promise<ModelUsageRecord | null> {
    return this.store.getModelUsage(id);
  }

  getModelUsagesForTurn(turnId: string): Promise<ModelUsageRecord[]> {
    return this.store.getModelUsagesForTurn(turnId);
  }

  getModelUsagesForChangeset(
    changesetId: string,
  ): Promise<ModelUsageRecord[]> {
    return this.store.getModelUsagesForChangeset(changesetId);
  }

  static async generateName(
    firstUserMessage: string,
    log?: KernelLog,
    opts: {
      sessionId?: string | null;
      recordUsage?: (input: RecordModelUsageInput) => Promise<ModelUsageRecord>;
    } = {},
  ): Promise<string> {
    const cleaned = firstUserMessage
      .replace(/<attachments>[\s\S]*?<\/attachments>/g, "")
      .replace(/<referenced-entities>[\s\S]*?<\/referenced-entities>/g, "")
      .trim();

    if (!cleaned) return "Untitled Session";

    // D9: no configured utility model → use the deterministic name rather than call
    // a provider with no model.
    const model = getUtilityModelForRequest();
    if (!model) return SessionManager.fallbackName(cleaned);
    if (!getProviderKey(providerFor(model))) {
      return SessionManager.fallbackName(cleaned);
    }

    try {
      const fallback = SessionManager.fallbackName(cleaned);
      const title = await SessionManager.generateNameWithModel(
        model,
        cleaned,
        false,
        opts,
      );
      if (title && !SessionManager.isPrefixName(title, cleaned, fallback)) {
        return title;
      }
      const retryTitle = await SessionManager.generateNameWithModel(
        model,
        cleaned,
        true,
        opts,
      );
      if (
        retryTitle &&
        !SessionManager.isPrefixName(retryTitle, cleaned, fallback)
      ) {
        return retryTitle;
      }
      return fallback;
    } catch (err) {
      log?.log(
        "warn",
        "system",
        `session auto-name failed: ${(err as Error).message ?? String(err)}`,
      );
      return SessionManager.fallbackName(cleaned);
    }
  }

  private static async generateNameWithModel(
    model: string,
    cleaned: string,
    retry: boolean,
    opts: {
      sessionId?: string | null;
      recordUsage?: (input: RecordModelUsageInput) => Promise<ModelUsageRecord>;
    },
  ): Promise<string> {
    const instruction = retry
      ? "Generate a short, semantic conversation title (3-6 words). Do not copy the opening words of the request; name the underlying task or issue. Reply with ONLY the title text, no quotes, no punctuation at the end, no preamble."
      : "Generate a short title (3-6 words) summarizing the user request below. Reply with ONLY the title text, no quotes, no punctuation at the end, no preamble.";
    const { text } = await callUtilityModel({
      model,
      maxTokens: 30,
      user: `${instruction}\n\n<user_request>\n${cleaned}\n</user_request>`,
      accounting: {
        role: "utility",
        caller: "session_name",
        sessionId: opts.sessionId ?? null,
        recordUsage: opts.recordUsage,
        metadata: { retry },
      },
    });
    return text
      .trim()
      .replace(/^["']|["']$/g, "")
      .replace(/[.!?。]+$/g, "")
      .trim();
  }

  private static isPrefixName(
    title: string,
    cleaned: string,
    fallback: string,
  ): boolean {
    const normalizedTitle = SessionManager.normalizeNameWords(title);
    if (!normalizedTitle) return false;
    if (normalizedTitle === SessionManager.normalizeNameWords(fallback)) {
      return true;
    }
    const titleWords = normalizedTitle.split(" ");
    const requestPrefix = SessionManager.normalizeNameWords(cleaned)
      .split(" ")
      .slice(0, titleWords.length)
      .join(" ");
    return normalizedTitle === requestPrefix;
  }

  private static normalizeNameWords(value: string): string {
    return value
      .replace(/[^\w\s]/g, " ")
      .split(/\s+/)
      .filter(Boolean)
      .map((word) => word.toLowerCase())
      .join(" ");
  }

  static fallbackName(cleaned: string): string {
    const words = cleaned
      .replace(/[^\w\s]/g, "")
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 5);
    if (words.length === 0) return "Untitled Session";
    return words
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
      .join(" ");
  }
}
