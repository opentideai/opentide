import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  ilike,
  inArray,
  lt,
  lte,
  or,
  sql,
} from "drizzle-orm";
import { existsSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { genieChangelogTable, genieMetaTable } from "./db/schema/index.ts";
import type { DrizzleDb } from "./db/factory.ts";
import {
  ensureDir,
  readJsonFile,
  readJsonLines,
  writeJsonIfChanged,
} from "./history-store.ts";
import { createMergeableNumericId, createTimestampedId } from "./ids.ts";
import { localUser } from "./auth.ts";
import { sanitizeWorkItemText } from "./work-items.ts";

// The changelog wire vocabulary — ChangeCategory/Action/Context, ChangeRecord and
// the per-turn TurnGroup — now lives in the L0 shared/ package (open). Imported
// for internal use and re-exported so existing core callers import them from
// ./changelog.ts unchanged.
import type {
  ChangeAction,
  ChangeCategory,
  ChangeContext,
  ChangeRecord,
  TurnGroup,
} from "../shared/changelog.ts";
export type {
  ChangeAction,
  ChangeCategory,
  ChangeContext,
  ChangeRecord,
  TurnGroup,
} from "../shared/changelog.ts";

interface FileChangeRecord extends ChangeRecord {
  uid: string;
}

type Row = typeof genieChangelogTable.$inferSelect;

export interface RecordEntry {
  category: ChangeCategory;
  key: string;
  action: ChangeAction;
  beforeSnapshot: unknown;
  afterSnapshot: unknown;
  context: ChangeContext | null;
  undoable?: boolean;
  rationale?: string | null;
  implementation?: string | null;
  workMessageId?: number | null;
  actorUserId?: string | null;
}

export interface WorkblockMetadata {
  rationale?: string | null;
  implementation?: string | null;
  workMessageId?: number | null;
}

export interface ListOptions {
  category?: string;
  key?: string;
  turnId?: string;
  limit?: number;
  offset?: number;
}

export type RecentRecord = {
  id: number;
  category: string;
  key: string;
  action: string;
  createdAt: string;
  undoable: boolean;
  turnId: string | null;
};

const CURSOR_META_KEY = "changelog_cursor";

// --- Shared pure helpers used by both storage backends ---

function rowToRecord(row: Row): ChangeRecord {
  return {
    id: row.id,
    category: row.category as ChangeCategory,
    key: row.key,
    action: row.action as ChangeAction,
    beforeSnapshot: row.beforeSnapshot,
    afterSnapshot: row.afterSnapshot,
    context: row.context as ChangeContext | null,
    createdAt: row.createdAt,
    undoable: row.undoable,
    turnId: row.turnId,
    changesetId: row.changesetId,
    rationale: row.rationale,
    implementation: row.implementation,
    workMessageId: row.workMessageId,
    actorUserId: row.actorUserId ?? null,
  };
}

function asChangeRecord(record: FileChangeRecord): ChangeRecord {
  const { uid: _uid, ...change } = record;
  return {
    ...change,
    rationale: change.rationale ?? null,
    implementation: change.implementation ?? null,
    workMessageId: change.workMessageId ?? null,
    actorUserId: change.actorUserId ?? null,
  };
}

function normalizeMetadataValue(
  value: string | null | undefined,
): string | null {
  if (typeof value !== "string") return null;
  const cleaned = sanitizeWorkItemText(value);
  return cleaned ? cleaned : null;
}

function toRecentRecord(
  r: Pick<
    ChangeRecord,
    "id" | "category" | "key" | "action" | "createdAt" | "undoable" | "turnId"
  >,
): RecentRecord {
  return {
    id: r.id,
    category: r.category,
    key: r.key,
    action: r.action,
    createdAt: r.createdAt,
    undoable: r.undoable,
    turnId: r.turnId,
  };
}

// Generic turn-grouping shared by both backends. Records must already be sorted
// newest-first (descending id). Groups records by turnId, emits solo groups for
// records without one, then sorts groups newest-first by createdAt.
function groupTurns(
  records: ChangeRecord[],
  limit: number,
): TurnGroup[] {
  const turnMap = new Map<string, ChangeRecord[]>();
  const soloEntries: ChangeRecord[] = [];

  for (const row of records) {
    if (row.turnId) {
      const existing = turnMap.get(row.turnId);
      if (existing) existing.push(row);
      else turnMap.set(row.turnId, [row]);
    } else {
      soloEntries.push(row);
    }
  }

  const groups: TurnGroup[] = [];
  for (const [turnId, turnRows] of turnMap) {
    turnRows.sort((a, b) => b.id - a.id);
    const ctxRow = turnRows.find((r) => r.context) ?? turnRows[0]!;
    const ctx = ctxRow.context;
    const earliest = turnRows[turnRows.length - 1]!;
    groups.push({
      turnId,
      userMessage: ctx?.userMessage ?? null,
      turnIndex: ctx?.turnIndex ?? null,
      createdAt: earliest.createdAt,
      changes: turnRows,
      changesetId: turnRows.find((r) => r.changesetId)?.changesetId ?? null,
    });
  }

  for (const row of soloEntries) {
    const ctx = row.context;
    groups.push({
      turnId: `solo_${row.id}`,
      userMessage: ctx?.userMessage ?? null,
      turnIndex: ctx?.turnIndex ?? null,
      createdAt: row.createdAt,
      changes: [row],
      changesetId: row.changesetId,
    });
  }

  groups.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return groups.slice(0, limit);
}

// --- Storage interface ---

interface ChangelogStore {
  record(entry: RecordEntry): Promise<ChangeRecord>;
  updateWorkblockMetadata(
    id: number,
    metadata: WorkblockMetadata,
  ): Promise<ChangeRecord | null>;
  get(id: number): Promise<ChangeRecord | null>;
  list(opts?: ListOptions): Promise<ChangeRecord[]>;
  search(query: string, limit?: number): Promise<ChangeRecord[]>;
  getCursor(): Promise<number | null>;
  // Puts the cursor back after an apply failed; null = before every record.
  restoreCursor(id: number | null): Promise<void>;
  undoEntry(): Promise<ChangeRecord | null>;
  redoEntry(): Promise<ChangeRecord | null>;
  undoTurnEntries(): Promise<ChangeRecord[] | null>;
  redoTurnEntries(): Promise<ChangeRecord[] | null>;
  goTo(
    targetId: number,
  ): Promise<{ undo: ChangeRecord[]; redo: ChangeRecord[] } | null>;
  listByChangeset(changesetId: string): Promise<ChangeRecord[]>;
  listTurns(
    limit?: number,
    opts?: { includeSnapshots?: boolean },
  ): Promise<TurnGroup[]>;
  getMeta(key: string): Promise<string | null>;
  setMeta(key: string, value: string): Promise<void>;
  deleteMeta(key: string): Promise<void>;
  entityHistory(
    category: string,
    key: string,
    limit?: number,
  ): Promise<ChangeRecord[]>;
  count(): Promise<number>;
  recent(limit: number): Promise<RecentRecord[]>;
  deleteByChangesetIds(changesetIds: string[]): Promise<void>;
}

// --- File-backed storage ---

class FileChangelogStore implements ChangelogStore {
  private readonly ready = Promise.resolve();
  private historyDir: string;
  // Cached max record id for the file-backed path, so record() doesn't
  // re-scan every record file on every append. Lazily seeded from disk.
  private fileMaxRecordId: number | null = null;

  constructor(historyDir: string) {
    this.historyDir = historyDir;
    ensureDir(this.historyDir);
  }

  private changelogPath(): string {
    return join(this.historyDir, "changelog.jsonl");
  }

  private recordsDir(): string {
    return join(this.historyDir, "changelog", "records");
  }

  // Staging dir used to build a complete replacement record set before
  // atomically swapping it into place (see writeFileRecords).
  private recordsTmpDir(): string {
    return this.recordsDir() + ".tmp";
  }

  private recordFile(dir: string, uid: string): string {
    return join(dir, `${encodeURIComponent(uid)}.json`);
  }

  private recordPath(uid: string): string {
    return this.recordFile(this.recordsDir(), uid);
  }

  private cursorPath(): string {
    return join(this.historyDir, "cursor.json");
  }

  private metaPath(): string {
    return join(this.historyDir, "meta.json");
  }

  private readFileRecords(): FileChangeRecord[] {
    // Crash recovery: if a previous swap was interrupted after the old dir was
    // removed but before the staged dir was renamed into place, promote the
    // staged dir so no records are lost.
    if (!existsSync(this.recordsDir()) && existsSync(this.recordsTmpDir())) {
      renameSync(this.recordsTmpDir(), this.recordsDir());
    }

    const byUid = new Map<string, FileChangeRecord>();
    const add = (record: FileChangeRecord) => byUid.set(record.uid, record);

    if (existsSync(this.recordsDir())) {
      for (const file of readdirSync(this.recordsDir())) {
        if (!file.endsWith(".json")) continue;
        const record = readJsonFile<FileChangeRecord>(
          join(this.recordsDir(), file),
        );
        if (record) add(record);
      }
    }

    for (
      const legacy of readJsonLines<FileChangeRecord>(this.changelogPath())
    ) {
      add(legacy);
    }

    return [...byUid.values()];
  }

  private writeFileRecords(records: FileChangeRecord[]): void {
    // Build the full replacement set in a staging dir first so the existing
    // records are never deleted until the new set is completely written. A
    // crash mid-write can no longer wipe the changelog (the old dir survives
    // until the final rename, and readFileRecords recovers a stranded staging
    // dir if the swap itself is interrupted).
    const tmpDir = this.recordsTmpDir();
    rmSync(tmpDir, { recursive: true, force: true });
    ensureDir(tmpDir);
    for (const record of records) {
      writeJsonIfChanged(this.recordFile(tmpDir, record.uid), record);
    }

    // Atomic swap: drop the old dir, then move the staged dir into place.
    rmSync(this.recordsDir(), { recursive: true, force: true });
    renameSync(tmpDir, this.recordsDir());

    // Legacy single-file changelog is fully superseded by the records dir.
    rmSync(this.changelogPath(), { force: true });
  }

  // Monotonic record id without re-scanning every record file per append.
  // Seeds the max once from disk, then advances in memory. createMergeableNumericId
  // is time-based, so a deleted-record gap never needs to be reused.
  private nextMergeableId(): number {
    if (this.fileMaxRecordId === null) {
      this.fileMaxRecordId = this.readFileRecords()
        .reduce((max, r) => Math.max(max, r.id), 0);
    }
    const id = createMergeableNumericId([this.fileMaxRecordId]);
    this.fileMaxRecordId = id;
    return id;
  }

  private readMetaFile(): Record<string, string> {
    return readJsonFile<Record<string, string>>(this.metaPath()) ?? {};
  }

  private writeMetaFile(meta: Record<string, string>): void {
    writeJsonIfChanged(this.metaPath(), meta);
  }

  async record(entry: RecordEntry): Promise<ChangeRecord> {
    const now = new Date().toISOString();
    const undoable = entry.undoable ?? true;
    const turnId = entry.context?.turnId ?? null;
    const changesetId = entry.context?.changesetId ?? null;

    const id = this.nextMergeableId();
    const record: FileChangeRecord = {
      uid: createTimestampedId("chg"),
      id,
      category: entry.category,
      key: entry.key,
      action: entry.action,
      beforeSnapshot: entry.beforeSnapshot,
      afterSnapshot: entry.afterSnapshot,
      context: entry.context,
      createdAt: now,
      undoable,
      turnId,
      changesetId,
      rationale: normalizeMetadataValue(entry.rationale),
      implementation: normalizeMetadataValue(entry.implementation),
      workMessageId: entry.workMessageId ?? null,
      actorUserId: entry.actorUserId ?? localUser().id,
    };
    ensureDir(this.recordsDir());
    writeJsonIfChanged(this.recordPath(record.uid), record);
    this.setCursorSync(id);
    return asChangeRecord(record);
  }

  async updateWorkblockMetadata(
    id: number,
    metadata: WorkblockMetadata,
  ): Promise<ChangeRecord | null> {
    await this.ready;
    const records = this.readFileRecords();
    const idx = records.findIndex((r) => r.id === id);
    if (idx < 0) return null;
    const current = records[idx]!;
    records[idx] = {
      ...current,
      rationale: metadata.rationale !== undefined
        ? normalizeMetadataValue(metadata.rationale)
        : current.rationale ?? null,
      implementation: metadata.implementation !== undefined
        ? normalizeMetadataValue(metadata.implementation)
        : current.implementation ?? null,
      workMessageId: metadata.workMessageId !== undefined
        ? metadata.workMessageId
        : current.workMessageId ?? null,
    };
    this.writeFileRecords(records);
    return asChangeRecord(records[idx]!);
  }

  async get(id: number): Promise<ChangeRecord | null> {
    await this.ready;
    const record = this.readFileRecords().find((r) => r.id === id);
    return record ? asChangeRecord(record) : null;
  }

  async list(opts?: ListOptions): Promise<ChangeRecord[]> {
    await this.ready;
    let records = this.readFileRecords();
    if (opts?.category) {
      records = records.filter((r) => r.category === opts.category);
    }
    if (opts?.key) records = records.filter((r) => r.key === opts.key);
    if (opts?.turnId) {
      records = records.filter((r) => r.turnId === opts.turnId);
    }
    records = records.toSorted((a, b) => b.id - a.id);
    if (opts?.offset) records = records.slice(opts.offset);
    if (opts?.limit) records = records.slice(0, opts.limit);
    return records.map(asChangeRecord);
  }

  async search(query: string, limit = 20): Promise<ChangeRecord[]> {
    await this.ready;
    const q = query.toLowerCase();
    return this.readFileRecords()
      .filter((r) =>
        r.key.toLowerCase().includes(q) ||
        JSON.stringify(r.context ?? {}).toLowerCase().includes(q)
      )
      .toSorted((a, b) => b.id - a.id)
      .slice(0, limit)
      .map(asChangeRecord);
  }

  private readCursorSync(): number | null {
    return readJsonFile<{ id: number }>(this.cursorPath())?.id ?? null;
  }

  getCursor(): Promise<number | null> {
    return Promise.resolve(this.readCursorSync());
  }

  restoreCursor(id: number | null): Promise<void> {
    if (id === null) this.clearCursorSync();
    else this.setCursorSync(id);
    return Promise.resolve();
  }

  private setCursorSync(id: number): void {
    writeJsonIfChanged(this.cursorPath(), { id });
  }

  private clearCursorSync(): void {
    rmSync(this.cursorPath(), { force: true });
  }

  async undoEntry(): Promise<ChangeRecord | null> {
    const cursor = this.readCursorSync();
    if (cursor === null) return null;
    const records = this.readFileRecords();
    const current = records
      .filter((r) => r.id <= cursor && r.undoable)
      .toSorted((a, b) => b.id - a.id)[0];
    if (!current) return null;
    const prev = records
      .filter((r) => r.id < current.id && r.undoable)
      .toSorted((a, b) => b.id - a.id)[0];
    if (prev) this.setCursorSync(prev.id);
    else this.clearCursorSync();
    return asChangeRecord(current);
  }

  async redoEntry(): Promise<ChangeRecord | null> {
    await this.ready;
    const cursor = this.readCursorSync();
    const minId = cursor ?? 0;
    const next = this.readFileRecords()
      .filter((r) => r.id > minId && r.undoable)
      .toSorted((a, b) => a.id - b.id)[0];
    if (!next) return null;
    this.setCursorSync(next.id);
    return asChangeRecord(next);
  }

  async undoTurnEntries(): Promise<ChangeRecord[] | null> {
    await this.ready;
    const cursor = this.readCursorSync();
    if (cursor === null) return null;

    const records = this.readFileRecords();
    const current = records
      .filter((r) => r.id <= cursor)
      .toSorted((a, b) => b.id - a.id)[0];
    if (!current) return null;

    let entries: FileChangeRecord[];
    if (current.turnId) {
      entries = records
        .filter((r) =>
          r.turnId === current.turnId && r.id <= cursor && r.undoable
        )
        .toSorted((a, b) => b.id - a.id);
    } else {
      entries = current.undoable ? [current] : [];
    }
    if (entries.length === 0) return null;

    const firstId = entries[entries.length - 1]!.id;
    const prev = records
      .filter((r) => r.id < firstId)
      .toSorted((a, b) => b.id - a.id)[0];
    if (prev) this.setCursorSync(prev.id);
    else this.clearCursorSync();
    return entries.map(asChangeRecord);
  }

  async redoTurnEntries(): Promise<ChangeRecord[] | null> {
    await this.ready;
    const cursor = this.readCursorSync();
    const minId = cursor ?? 0;

    const records = this.readFileRecords();
    const next = records
      .filter((r) => r.id > minId && r.undoable)
      .toSorted((a, b) => a.id - b.id)[0];
    if (!next) return null;

    let entries: FileChangeRecord[];
    if (next.turnId) {
      entries = records
        .filter((r) => r.turnId === next.turnId && r.id > minId && r.undoable)
        .toSorted((a, b) => a.id - b.id);
    } else {
      entries = [next];
    }
    if (entries.length === 0) return null;
    this.setCursorSync(entries[entries.length - 1]!.id);
    return entries.map(asChangeRecord);
  }

  async goTo(
    targetId: number,
  ): Promise<{ undo: ChangeRecord[]; redo: ChangeRecord[] } | null> {
    await this.ready;
    const cursor = this.readCursorSync();
    const currentId = cursor ?? 0;

    if (targetId === currentId) return { undo: [], redo: [] };

    const records = this.readFileRecords();
    if (targetId > 0 && !records.some((r) => r.id === targetId)) return null;
    if (targetId < currentId) {
      const undo = records
        .filter((r) => r.id > targetId && r.id <= currentId && r.undoable)
        .toSorted((a, b) => b.id - a.id)
        .map(asChangeRecord);
      if (targetId > 0) this.setCursorSync(targetId);
      else this.clearCursorSync();
      return { undo, redo: [] };
    }
    const redo = records
      .filter((r) => r.id > currentId && r.id <= targetId && r.undoable)
      .toSorted((a, b) => a.id - b.id)
      .map(asChangeRecord);
    this.setCursorSync(targetId);
    return { undo: [], redo };
  }

  async listByChangeset(changesetId: string): Promise<ChangeRecord[]> {
    await this.ready;
    return this.readFileRecords()
      .filter((r) => r.changesetId === changesetId)
      .toSorted((a, b) => a.id - b.id)
      .map(asChangeRecord);
  }

  async listTurns(
    limit = 20,
    opts?: { includeSnapshots?: boolean },
  ): Promise<TurnGroup[]> {
    await this.ready;
    const includeSnapshots = opts?.includeSnapshots === true;
    const records = this.readFileRecords()
      .filter((r) => !(r.category === "config" && r.key.startsWith("_genie_")))
      .toSorted((a, b) => b.id - a.id)
      .slice(0, limit * 20)
      .map((r): ChangeRecord => ({
        ...asChangeRecord(r),
        beforeSnapshot: includeSnapshots ? r.beforeSnapshot : null,
        afterSnapshot: includeSnapshots ? r.afterSnapshot : null,
      }));

    return groupTurns(records, limit);
  }

  async getMeta(key: string): Promise<string | null> {
    await this.ready;
    return this.readMetaFile()[key] ?? null;
  }

  async setMeta(key: string, value: string): Promise<void> {
    await this.ready;
    this.writeMetaFile({ ...this.readMetaFile(), [key]: value });
  }

  async deleteMeta(key: string): Promise<void> {
    await this.ready;
    const meta = this.readMetaFile();
    delete meta[key];
    this.writeMetaFile(meta);
  }

  async entityHistory(
    category: string,
    key: string,
    limit = 50,
  ): Promise<ChangeRecord[]> {
    await this.ready;
    return this.readFileRecords()
      .filter((r) => r.category === category && r.key === key && r.undoable)
      .toSorted((a, b) => b.id - a.id)
      .slice(0, limit)
      .map(asChangeRecord);
  }

  async count(): Promise<number> {
    await this.ready;
    return this.readFileRecords().length;
  }

  async recent(limit: number): Promise<RecentRecord[]> {
    await this.ready;
    return this.readFileRecords()
      .toSorted((a, b) => b.id - a.id)
      .slice(0, limit)
      .map(toRecentRecord);
  }

  async deleteByChangesetIds(changesetIds: string[]): Promise<void> {
    await this.ready;
    if (changesetIds.length === 0) return;
    const set = new Set(changesetIds);
    this.writeFileRecords(
      this.readFileRecords().filter((r) =>
        !r.changesetId || !set.has(r.changesetId)
      ),
    );
  }
}

// --- DB-backed storage ---

class DbChangelogStore implements ChangelogStore {
  private db: DrizzleDb;
  private ready: Promise<void> | null = null;

  constructor(db: DrizzleDb) {
    this.db = db;
  }

  private ensureReady(): Promise<void> {
    this.ready ??= this.ensureAuthColumns();
    return this.ready;
  }

  private async ensureAuthColumns(): Promise<void> {
    await this.db.execute(
      sql`ALTER TABLE "_genie_changelog" ADD COLUMN IF NOT EXISTS "actor_user_id" text`,
    );
  }

  async record(entry: RecordEntry): Promise<ChangeRecord> {
    await this.ensureReady();
    const now = new Date().toISOString();
    const undoable = entry.undoable ?? true;
    const turnId = entry.context?.turnId ?? null;
    const changesetId = entry.context?.changesetId ?? null;

    return await this.db.transaction(async (tx) => {
      const cursorRows = await tx
        .select()
        .from(genieMetaTable)
        .where(eq(genieMetaTable.key, CURSOR_META_KEY))
        .limit(1);
      const cursor = cursorRows[0] ? Number(cursorRows[0].value) : null;

      if (cursor !== null) {
        await tx.delete(genieChangelogTable).where(
          gt(genieChangelogTable.id, cursor),
        );
      }

      const rows = await tx
        .insert(genieChangelogTable)
        .values({
          category: entry.category,
          key: entry.key,
          action: entry.action,
          beforeSnapshot: entry.beforeSnapshot,
          afterSnapshot: entry.afterSnapshot,
          context: entry.context,
          createdAt: now,
          undoable,
          turnId,
          changesetId,
          rationale: entry.rationale ?? null,
          implementation: entry.implementation ?? null,
          workMessageId: entry.workMessageId ?? null,
          actorUserId: entry.actorUserId ?? localUser().id,
        })
        .returning();

      const id = rows[0]!.id;
      await tx
        .insert(genieMetaTable)
        .values({ key: CURSOR_META_KEY, value: String(id) })
        .onConflictDoUpdate({
          target: genieMetaTable.key,
          set: { value: String(id) },
        });

      // Return the in-memory record (not rowToRecord(rows[0])): the DB JSONB
      // round-trip would drop explicit `undefined` keys in `context`, diverging
      // from the file backend's record() return.
      return {
        id,
        category: entry.category,
        key: entry.key,
        action: entry.action,
        beforeSnapshot: entry.beforeSnapshot,
        afterSnapshot: entry.afterSnapshot,
        context: entry.context,
        createdAt: now,
        undoable,
        turnId,
        changesetId,
        rationale: normalizeMetadataValue(entry.rationale),
        implementation: normalizeMetadataValue(entry.implementation),
        workMessageId: entry.workMessageId ?? null,
        actorUserId: entry.actorUserId ?? localUser().id,
      };
    });
  }

  async updateWorkblockMetadata(
    id: number,
    metadata: WorkblockMetadata,
  ): Promise<ChangeRecord | null> {
    const rows = await this.db
      .update(genieChangelogTable)
      .set({
        ...(metadata.rationale !== undefined
          ? { rationale: normalizeMetadataValue(metadata.rationale) }
          : {}),
        ...(metadata.implementation !== undefined
          ? { implementation: normalizeMetadataValue(metadata.implementation) }
          : {}),
        ...(metadata.workMessageId !== undefined
          ? { workMessageId: metadata.workMessageId }
          : {}),
      })
      .where(eq(genieChangelogTable.id, id))
      .returning();
    return rows[0] ? rowToRecord(rows[0]) : null;
  }

  async get(id: number): Promise<ChangeRecord | null> {
    await this.ensureReady();
    const rows = await this.db
      .select()
      .from(genieChangelogTable)
      .where(eq(genieChangelogTable.id, id))
      .limit(1);
    return rows[0] ? rowToRecord(rows[0]) : null;
  }

  async list(opts?: ListOptions): Promise<ChangeRecord[]> {
    let query = this.db
      .select()
      .from(genieChangelogTable)
      .where(and(
        opts?.category
          ? eq(genieChangelogTable.category, opts.category)
          : undefined,
        opts?.key ? eq(genieChangelogTable.key, opts.key) : undefined,
        opts?.turnId ? eq(genieChangelogTable.turnId, opts.turnId) : undefined,
      ))
      .orderBy(desc(genieChangelogTable.id))
      .$dynamic();

    if (opts?.limit) query = query.limit(opts.limit);
    if (opts?.offset) query = query.offset(opts.offset);

    const rows = await query;
    return rows.map(rowToRecord);
  }

  async search(query: string, limit = 20): Promise<ChangeRecord[]> {
    const escaped = query.replace(/[%_\\]/g, (c) => `\\${c}`);
    const pattern = `%${escaped}%`;
    const rows = await this.db
      .select()
      .from(genieChangelogTable)
      .where(or(
        ilike(genieChangelogTable.key, pattern),
        sql`${genieChangelogTable.context}::text ILIKE ${pattern}`,
      ))
      .orderBy(desc(genieChangelogTable.id))
      .limit(limit);
    return rows.map(rowToRecord);
  }

  async getCursor(): Promise<number | null> {
    await this.ensureReady();
    const rows = await this.db
      .select()
      .from(genieMetaTable)
      .where(eq(genieMetaTable.key, CURSOR_META_KEY))
      .limit(1);
    return rows[0] ? Number(rows[0].value) : null;
  }

  private async setCursor(id: number): Promise<void> {
    await this.ensureReady();
    await this.setMeta(CURSOR_META_KEY, String(id));
  }

  private async clearCursor(): Promise<void> {
    await this.ensureReady();
    await this.deleteMeta(CURSOR_META_KEY);
  }

  async restoreCursor(id: number | null): Promise<void> {
    if (id === null) await this.clearCursor();
    else await this.setCursor(id);
  }

  async undoEntry(): Promise<ChangeRecord | null> {
    await this.ensureReady();
    return await this.db.transaction(async (tx) => {
      const cursorRows = await tx
        .select()
        .from(genieMetaTable)
        .where(eq(genieMetaTable.key, CURSOR_META_KEY))
        .limit(1);
      const cursor = cursorRows[0] ? Number(cursorRows[0].value) : null;
      if (cursor === null) return null;

      const rows = await tx
        .select()
        .from(genieChangelogTable)
        .where(
          and(
            lte(genieChangelogTable.id, cursor),
            eq(genieChangelogTable.undoable, true),
          ),
        )
        .orderBy(desc(genieChangelogTable.id))
        .limit(1);
      if (rows.length === 0) return null;
      const row = rows[0]!;

      const prevRows = await tx
        .select({ id: genieChangelogTable.id })
        .from(genieChangelogTable)
        .where(
          and(
            lt(genieChangelogTable.id, row.id),
            eq(genieChangelogTable.undoable, true),
          ),
        )
        .orderBy(desc(genieChangelogTable.id))
        .limit(1);

      if (prevRows[0]) {
        await tx.insert(genieMetaTable).values({
          key: CURSOR_META_KEY,
          value: String(prevRows[0].id),
        })
          .onConflictDoUpdate({
            target: genieMetaTable.key,
            set: { value: String(prevRows[0].id) },
          });
      } else {
        await tx.delete(genieMetaTable).where(
          eq(genieMetaTable.key, CURSOR_META_KEY),
        );
      }

      return rowToRecord(row);
    });
  }

  async redoEntry(): Promise<ChangeRecord | null> {
    await this.ensureReady();
    return await this.db.transaction(async (tx) => {
      const cursorRows = await tx
        .select()
        .from(genieMetaTable)
        .where(eq(genieMetaTable.key, CURSOR_META_KEY))
        .limit(1);
      const cursor = cursorRows[0] ? Number(cursorRows[0].value) : null;
      const minId = cursor ?? 0;

      const rows = await tx
        .select()
        .from(genieChangelogTable)
        .where(
          and(
            gt(genieChangelogTable.id, minId),
            eq(genieChangelogTable.undoable, true),
          ),
        )
        .orderBy(asc(genieChangelogTable.id))
        .limit(1);
      if (rows.length === 0) return null;

      const row = rows[0]!;
      await tx.insert(genieMetaTable).values({
        key: CURSOR_META_KEY,
        value: String(row.id),
      })
        .onConflictDoUpdate({
          target: genieMetaTable.key,
          set: { value: String(row.id) },
        });
      return rowToRecord(row);
    });
  }

  async undoTurnEntries(): Promise<ChangeRecord[] | null> {
    await this.ensureReady();
    const cursor = await this.getCursor();
    if (cursor === null) return null;

    const currentRows = await this.db
      .select()
      .from(genieChangelogTable)
      .where(lte(genieChangelogTable.id, cursor))
      .orderBy(desc(genieChangelogTable.id))
      .limit(1);
    if (currentRows.length === 0) return null;
    const current = currentRows[0]!;

    let entries: Row[];
    if (current.turnId) {
      entries = await this.db
        .select()
        .from(genieChangelogTable)
        .where(and(
          eq(genieChangelogTable.turnId, current.turnId),
          lte(genieChangelogTable.id, cursor),
          eq(genieChangelogTable.undoable, true),
        ))
        .orderBy(desc(genieChangelogTable.id));
    } else {
      entries = current.undoable ? [current] : [];
    }

    if (entries.length === 0) return null;

    const firstId = entries[entries.length - 1]!.id;
    const prevRows = await this.db
      .select({ id: genieChangelogTable.id })
      .from(genieChangelogTable)
      .where(lt(genieChangelogTable.id, firstId))
      .orderBy(desc(genieChangelogTable.id))
      .limit(1);

    if (prevRows[0]) {
      await this.setCursor(prevRows[0].id);
    } else {
      await this.clearCursor();
    }

    return entries.map(rowToRecord);
  }

  async redoTurnEntries(): Promise<ChangeRecord[] | null> {
    await this.ensureReady();
    const cursor = await this.getCursor();
    const minId = cursor ?? 0;

    const nextRows = await this.db
      .select()
      .from(genieChangelogTable)
      .where(
        and(
          gt(genieChangelogTable.id, minId),
          eq(genieChangelogTable.undoable, true),
        ),
      )
      .orderBy(asc(genieChangelogTable.id))
      .limit(1);
    if (nextRows.length === 0) return null;
    const next = nextRows[0]!;

    let entries: Row[];
    if (next.turnId) {
      entries = await this.db
        .select()
        .from(genieChangelogTable)
        .where(and(
          eq(genieChangelogTable.turnId, next.turnId),
          gt(genieChangelogTable.id, minId),
          eq(genieChangelogTable.undoable, true),
        ))
        .orderBy(asc(genieChangelogTable.id));
    } else {
      entries = [next];
    }

    if (entries.length === 0) return null;

    const lastId = entries[entries.length - 1]!.id;
    await this.setCursor(lastId);

    return entries.map(rowToRecord);
  }

  async goTo(
    targetId: number,
  ): Promise<{ undo: ChangeRecord[]; redo: ChangeRecord[] } | null> {
    const cursor = await this.getCursor();
    const currentId = cursor ?? 0;

    if (targetId === currentId) return { undo: [], redo: [] };

    if (targetId > 0) {
      const target = await this.get(targetId);
      if (!target) return null;
    }

    if (targetId < currentId) {
      const rows = await this.db
        .select()
        .from(genieChangelogTable)
        .where(and(
          gt(genieChangelogTable.id, targetId),
          lte(genieChangelogTable.id, currentId),
          eq(genieChangelogTable.undoable, true),
        ))
        .orderBy(desc(genieChangelogTable.id));

      if (targetId > 0) {
        await this.setCursor(targetId);
      } else {
        await this.clearCursor();
      }

      return { undo: rows.map(rowToRecord), redo: [] };
    } else {
      const rows = await this.db
        .select()
        .from(genieChangelogTable)
        .where(and(
          gt(genieChangelogTable.id, currentId),
          lte(genieChangelogTable.id, targetId),
          eq(genieChangelogTable.undoable, true),
        ))
        .orderBy(asc(genieChangelogTable.id));

      await this.setCursor(targetId);

      return { undo: [], redo: rows.map(rowToRecord) };
    }
  }

  async listByChangeset(changesetId: string): Promise<ChangeRecord[]> {
    await this.ensureReady();
    const rows = await this.db
      .select()
      .from(genieChangelogTable)
      .where(eq(genieChangelogTable.changesetId, changesetId))
      .orderBy(asc(genieChangelogTable.id));
    return rows.map(rowToRecord);
  }

  async listTurns(
    limit = 20,
    opts?: { includeSnapshots?: boolean },
  ): Promise<TurnGroup[]> {
    await this.ensureReady();
    const includeSnapshots = opts?.includeSnapshots === true;
    const rows = await this.db
      .select({
        id: genieChangelogTable.id,
        category: genieChangelogTable.category,
        key: genieChangelogTable.key,
        action: genieChangelogTable.action,
        ...(includeSnapshots
          ? {
            beforeSnapshot: genieChangelogTable.beforeSnapshot,
            afterSnapshot: genieChangelogTable.afterSnapshot,
          }
          : {}),
        context: genieChangelogTable.context,
        createdAt: genieChangelogTable.createdAt,
        undoable: genieChangelogTable.undoable,
        turnId: genieChangelogTable.turnId,
        changesetId: genieChangelogTable.changesetId,
        rationale: genieChangelogTable.rationale,
        implementation: genieChangelogTable.implementation,
        workMessageId: genieChangelogTable.workMessageId,
        actorUserId: genieChangelogTable.actorUserId,
      })
      .from(genieChangelogTable)
      .where(
        sql`NOT (${genieChangelogTable.category} = 'config' AND ${genieChangelogTable.key} LIKE '_genie_%')`,
      )
      .orderBy(desc(genieChangelogTable.id))
      .limit(limit * 20);

    type LightRow = typeof rows[number] & {
      beforeSnapshot?: unknown;
      afterSnapshot?: unknown;
    };

    const records = (rows as LightRow[]).map((r): ChangeRecord => ({
      id: r.id,
      category: r.category as ChangeCategory,
      key: r.key,
      action: r.action as ChangeAction,
      beforeSnapshot: includeSnapshots ? r.beforeSnapshot ?? null : null,
      afterSnapshot: includeSnapshots ? r.afterSnapshot ?? null : null,
      context: r.context as ChangeContext | null,
      createdAt: r.createdAt,
      undoable: r.undoable,
      turnId: r.turnId,
      changesetId: r.changesetId,
      rationale: r.rationale,
      implementation: r.implementation,
      workMessageId: r.workMessageId,
      actorUserId: r.actorUserId ?? null,
    }));

    return groupTurns(records, limit);
  }

  async getMeta(key: string): Promise<string | null> {
    await this.ensureReady();
    const rows = await this.db
      .select()
      .from(genieMetaTable)
      .where(eq(genieMetaTable.key, key))
      .limit(1);
    return rows[0]?.value ?? null;
  }

  async setMeta(key: string, value: string): Promise<void> {
    await this.ensureReady();
    await this.db
      .insert(genieMetaTable)
      .values({ key, value })
      .onConflictDoUpdate({ target: genieMetaTable.key, set: { value } });
  }

  async deleteMeta(key: string): Promise<void> {
    await this.ensureReady();
    await this.db.delete(genieMetaTable).where(eq(genieMetaTable.key, key));
  }

  async entityHistory(
    category: string,
    key: string,
    limit = 50,
  ): Promise<ChangeRecord[]> {
    await this.ensureReady();
    const rows = await this.db
      .select()
      .from(genieChangelogTable)
      .where(and(
        eq(genieChangelogTable.category, category),
        eq(genieChangelogTable.key, key),
        eq(genieChangelogTable.undoable, true),
      ))
      .orderBy(desc(genieChangelogTable.id))
      .limit(limit);
    return rows.map(rowToRecord);
  }

  async count(): Promise<number> {
    await this.ensureReady();
    const rows = await this.db.select({ c: count() }).from(genieChangelogTable);
    return rows[0]!.c;
  }

  async recent(limit: number): Promise<RecentRecord[]> {
    const rows = await this.db
      .select({
        id: genieChangelogTable.id,
        category: genieChangelogTable.category,
        key: genieChangelogTable.key,
        action: genieChangelogTable.action,
        createdAt: genieChangelogTable.createdAt,
        undoable: genieChangelogTable.undoable,
        turnId: genieChangelogTable.turnId,
      })
      .from(genieChangelogTable)
      .orderBy(desc(genieChangelogTable.id))
      .limit(limit);
    return rows;
  }

  async deleteByChangesetIds(changesetIds: string[]): Promise<void> {
    if (changesetIds.length === 0) return;
    await this.db.delete(genieChangelogTable).where(
      inArray(genieChangelogTable.changesetId, changesetIds),
    );
  }
}

// --- Facade ---

export type EntityUidResolver = (
  category: string,
  key: string,
) => string | undefined;

// A4 (Stream A): a per-record post-write hook. Fired by record() AFTER the store
// write, so the composition root (the Kernel) can compose a VerificationEpisode
// one level up with the full context record() itself lacks (entity source sizes,
// verification state). A void|Promise return keeps the async episode build awaited
// in order; the listener OWNS its errors (it must never throw) so the facade stays
// generic and a change is never lost to a failed emit. See docs/…-plan.md §4 A4.
export type ChangeListener = (record: ChangeRecord) => void | Promise<void>;

export class Changelog {
  private store: ChangelogStore;
  private actorContext = new AsyncLocalStorage<string | null>();
  // A2 (Stream A): resolves an entity's stable uid from a change's (category, key).
  // Injected by the Kernel (registries.ts) once the registries exist. Kept as an
  // optional seam so a bare Changelog (tests, tooling) still works with no resolver.
  private entityUidResolver: EntityUidResolver | null = null;
  // A4 (Stream A): the episode-emit hook (see ChangeListener). Optional — a bare
  // Changelog, or a DB-only kernel with no history dir, wires none and record()
  // simply skips it. Never mutates or blocks the recorded change.
  private changeListener: ChangeListener | null = null;

  constructor(storage: DrizzleDb | string) {
    this.store = typeof storage === "string"
      ? new FileChangelogStore(storage)
      : new DbChangelogStore(storage);
  }

  // A2: wire the registry-backed uid resolver. One call from the Kernel covers
  // every record() writer (dispatch, control-server, future) with no per-site edits.
  setEntityUidResolver(resolver: EntityUidResolver): void {
    this.entityUidResolver = resolver;
  }

  // A4: wire the episode-emit hook. One call from the Kernel covers every record()
  // writer with no per-site edits — the same central-injection pattern as
  // setEntityUidResolver.
  onChange(listener: ChangeListener): void {
    this.changeListener = listener;
  }

  // A2: stamp the entity's stable uid onto the change context, resolved from this
  // record's own (category, key). Never overwrites an explicit uid, and returns a
  // NEW context object rather than mutating the caller's (some callers share one).
  private contextWithEntityUid(entry: RecordEntry): ChangeContext | null {
    if (entry.context?.entityUid !== undefined) return entry.context;
    const uid = this.entityUidResolver?.(entry.category, entry.key);
    if (!uid) return entry.context;
    return { ...(entry.context ?? {}), entityUid: uid };
  }

  async record(entry: RecordEntry): Promise<ChangeRecord> {
    const record = await this.store.record({
      ...entry,
      context: this.contextWithEntityUid(entry),
      actorUserId: entry.actorUserId ?? this.actorContext.getStore() ??
        localUser().id,
    });
    // A4: emit the episode one level up, in order, after the store write. The
    // listener is self-guarding (never throws), so no try/catch is needed here and
    // a failed emit can never break or lose the recorded change.
    if (this.changeListener) await this.changeListener(record);
    return record;
  }

  setCurrentActorUserId(userId: string | null): void {
    this.actorContext.enterWith(userId);
  }

  async withActor<T>(userId: string, fn: () => Promise<T>): Promise<T> {
    return await this.actorContext.run(userId, fn);
  }

  updateWorkblockMetadata(
    id: number,
    metadata: WorkblockMetadata,
  ): Promise<ChangeRecord | null> {
    return this.store.updateWorkblockMetadata(id, metadata);
  }

  get(id: number): Promise<ChangeRecord | null> {
    return this.store.get(id);
  }

  list(opts?: ListOptions): Promise<ChangeRecord[]> {
    return this.store.list(opts);
  }

  search(query: string, limit = 20): Promise<ChangeRecord[]> {
    return this.store.search(query, limit);
  }

  getCursor(): Promise<number | null> {
    return this.store.getCursor();
  }

  restoreCursor(id: number | null): Promise<void> {
    return this.store.restoreCursor(id);
  }

  undoEntry(): Promise<ChangeRecord | null> {
    return this.store.undoEntry();
  }

  redoEntry(): Promise<ChangeRecord | null> {
    return this.store.redoEntry();
  }

  undoTurnEntries(): Promise<ChangeRecord[] | null> {
    return this.store.undoTurnEntries();
  }

  redoTurnEntries(): Promise<ChangeRecord[] | null> {
    return this.store.redoTurnEntries();
  }

  goTo(
    targetId: number,
  ): Promise<{ undo: ChangeRecord[]; redo: ChangeRecord[] } | null> {
    return this.store.goTo(targetId);
  }

  listByChangeset(changesetId: string): Promise<ChangeRecord[]> {
    return this.store.listByChangeset(changesetId);
  }

  listTurns(
    limit = 20,
    opts?: { includeSnapshots?: boolean },
  ): Promise<TurnGroup[]> {
    return this.store.listTurns(limit, opts);
  }

  getMeta(key: string): Promise<string | null> {
    return this.store.getMeta(key);
  }

  setMeta(key: string, value: string): Promise<void> {
    return this.store.setMeta(key, value);
  }

  deleteMeta(key: string): Promise<void> {
    return this.store.deleteMeta(key);
  }

  entityHistory(
    category: string,
    key: string,
    limit = 50,
  ): Promise<ChangeRecord[]> {
    return this.store.entityHistory(category, key, limit);
  }

  // A1 (Stream A): fold an entity's changelog history into a single authorship
  // verdict. "mixed" is NEVER stamped on a record — it is derived HERE, meaning
  // the entity has both an "ai" and a "human" record (in the current arch a
  // human can't edit inside a live agent turn, so a mixed entity is one edited
  // both by the agent and by hand across separate requests). Records with no
  // authorOrigin are "unknown" and never counted as "ai"; an entity whose whole
  // history lacks an origin is "unknown".
  //
  // Keyed by (category, key) for now. A2 will give entities a stable entityUid;
  // when it lands this becomes the same fold over history looked up by uid — the
  // only change is the lookup, the fold is deliberately independent of it.
  async entityAuthorship(
    category: string,
    key: string,
  ): Promise<"ai" | "human" | "mixed" | "unknown"> {
    const history = await this.list({ category, key });
    let sawAi = false;
    let sawHuman = false;
    for (const record of history) {
      const origin = record.context?.authorOrigin;
      if (origin === "ai") sawAi = true;
      else if (origin === "human") sawHuman = true;
    }
    if (sawAi && sawHuman) return "mixed";
    if (sawAi) return "ai";
    if (sawHuman) return "human";
    return "unknown";
  }

  // A2: the entityUid-keyed authorship fold — the "trivial swap" A1 anticipated.
  // Same ai/human/mixed/unknown semantics as entityAuthorship, but identifies the
  // entity by its stable uid (threaded into every record's context by A2) instead
  // of by (category, key), so it survives a future rename (A3). Filters in memory
  // since uid rides in the jsonb context, not an indexed column.
  async entityAuthorshipByUid(
    entityUid: string,
  ): Promise<"ai" | "human" | "mixed" | "unknown"> {
    const history = await this.list();
    let sawAi = false;
    let sawHuman = false;
    for (const record of history) {
      if (record.context?.entityUid !== entityUid) continue;
      const origin = record.context?.authorOrigin;
      if (origin === "ai") sawAi = true;
      else if (origin === "human") sawHuman = true;
    }
    if (sawAi && sawHuman) return "mixed";
    if (sawAi) return "ai";
    if (sawHuman) return "human";
    return "unknown";
  }

  count(): Promise<number> {
    return this.store.count();
  }

  recent(limit: number): Promise<RecentRecord[]> {
    return this.store.recent(limit);
  }

  deleteByChangesetIds(changesetIds: string[]): Promise<void> {
    return this.store.deleteByChangesetIds(changesetIds);
  }
}
