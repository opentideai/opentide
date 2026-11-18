// Database backups.
//
// A backup is a directory, `<backupsDir>/<id>/`:
//
//   manifest.json                {"metadata":{...},"kernelState":{...},"tables":[...]}
//   tables/<n>.ndjson.gz         one row per line, gzipped, one file per table
//   branch-snapshots.ndjson.gz   one branch snapshot per line, when there are any
//
// Written into `<id>.tmp/` and renamed into place once complete, so a directory
// with a manifest is a whole backup and anything else is debris. Writing and
// restoring both go a page of rows at a time: nothing here holds a table, let alone
// the database, in the heap. On a 5GB project the old single-JSON-file format could
// not be restored at all — the file was past what one string can hold.
//
// Backups from before this format are one `<id>.json` file. They still list, and
// openBackup converts one into a directory the first time it is opened, reading it as
// a stream so a file too big to parse whole still converts.
import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { Kernel } from "./registries.ts";
import { type Database, referencedTables } from "./db.ts";
import type { SnapshotData } from "./snapshots.ts";
import { type PersistedState, serializeKernelState } from "./persistence.ts";
import { createTimestampedShortId } from "./ids.ts";

export interface BackupMetadata {
  id: string;
  createdAt: string;
  trigger: "shutdown" | "periodic" | "manual";
  tableCount: number;
  rowCount: number;
  branchSnapshotCount?: number;
  includesProjectState?: boolean;
  // What the project looked like when the backup started (backupFingerprint). A
  // later periodic or shutdown backup that would come out the same is not written.
  // Absent on backups from before 0.1.15, which never match.
  fingerprint?: string;
}

export interface BackupTableDef {
  tableName: string;
  sql: string;
  module?: string;
}

interface BackupTable extends BackupTableDef {
  rows: Record<string, unknown>[];
}

// A whole backup as one object: the old file format, and what an uploaded backup
// or a test fixture still looks like. Only ever for small databases.
export interface BackupData {
  metadata: BackupMetadata;
  kernelState: PersistedState;
  tables: BackupTable[];
  branchSnapshots?: SnapshotData[];
}

interface ManifestTable extends BackupTableDef {
  rowCount: number;
  file: string;
}

interface BackupManifest {
  metadata: BackupMetadata;
  kernelState?: PersistedState;
  tables: ManifestTable[];
  branchSnapshotsFile?: string;
}

const MANIFEST = "manifest.json";
const BRANCH_SNAPSHOTS_FILE = "branch-snapshots.ndjson.gz";

// Ids come in from URLs and become paths, and deleteBackup removes a directory
// tree: nothing that could climb out of the backups directory gets near it.
export function isValidBackupId(id: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/.test(id);
}

// --- Writing ---

interface GzipFile {
  write(text: string): Promise<void>;
  close(): Promise<void>;
  abort(): Promise<void>;
}

async function gzipFile(path: string): Promise<GzipFile> {
  const file = await Deno.open(path, { write: true, createNew: true });
  const gzip = new CompressionStream("gzip");
  const piped = gzip.readable.pipeTo(file.writable);
  const writer = gzip.writable.getWriter();
  const encoder = new TextEncoder();
  return {
    async write(text) {
      await writer.ready;
      await writer.write(encoder.encode(text));
    },
    async close() {
      await writer.close();
      await piped;
    },
    async abort() {
      await writer.abort().catch(() => {});
      await piped.catch(() => {});
    },
  };
}

interface TableHandle {
  // Lines of row JSON, each ending in "\n".
  write(lines: string, count: number): Promise<void>;
  close(): Promise<void>;
  define(def: BackupTableDef): void;
}

// Builds one backup directory under a temporary name. Tables go in one at a time;
// finish() writes the manifest last and renames the directory into place.
class BackupDirWriter {
  private readonly tables: Array<
    { def?: BackupTableDef; rowCount: number; file: string }
  > = [];
  private open: GzipFile | null = null;

  private constructor(
    private readonly backupsDir: string,
    private readonly tmpDir: string,
  ) {}

  static create(backupsDir: string): BackupDirWriter {
    const tmpDir = join(
      backupsDir,
      `${createTimestampedShortId("backup")}.tmp`,
    );
    mkdirSync(join(tmpDir, "tables"), { recursive: true });
    return new BackupDirWriter(backupsDir, tmpDir);
  }

  async openTable(def?: BackupTableDef): Promise<TableHandle> {
    const entry = {
      def,
      rowCount: 0,
      file: `tables/${this.tables.length}.ndjson.gz`,
    };
    this.tables.push(entry);
    const gz = await gzipFile(join(this.tmpDir, entry.file));
    this.open = gz;
    return {
      write: async (lines, count) => {
        await gz.write(lines);
        entry.rowCount += count;
      },
      close: async () => {
        await gz.close();
        this.open = null;
      },
      define: (d) => {
        entry.def = d;
      },
    };
  }

  async finish(opts: {
    id: string;
    createdAt: string;
    trigger: BackupMetadata["trigger"];
    kernelState?: PersistedState;
    branchSnapshots: SnapshotData[];
    fingerprint?: string;
  }): Promise<BackupMetadata> {
    if (!isValidBackupId(opts.id)) {
      throw new Error(`Invalid backup id: ${JSON.stringify(opts.id)}`);
    }
    const tables: ManifestTable[] = this.tables.map((t, i) => {
      if (!t.def) throw new Error(`Backup table ${i} has no name or schema`);
      return {
        tableName: t.def.tableName,
        sql: t.def.sql,
        ...(t.def.module ? { module: t.def.module } : {}),
        rowCount: t.rowCount,
        file: t.file,
      };
    });
    if (opts.branchSnapshots.length > 0) {
      const gz = await gzipFile(join(this.tmpDir, BRANCH_SNAPSHOTS_FILE));
      for (const snap of opts.branchSnapshots) {
        await gz.write(JSON.stringify(snap) + "\n");
      }
      await gz.close();
    }
    const metadata: BackupMetadata = {
      id: opts.id,
      createdAt: opts.createdAt,
      trigger: opts.trigger,
      tableCount: tables.length,
      rowCount: tables.reduce((n, t) => n + t.rowCount, 0),
      branchSnapshotCount: opts.branchSnapshots.length,
      includesProjectState: opts.kernelState !== undefined,
      ...(opts.fingerprint ? { fingerprint: opts.fingerprint } : {}),
    };
    // Metadata first: listing reads it from the head of the file.
    const manifest: BackupManifest = {
      metadata,
      ...(opts.kernelState ? { kernelState: opts.kernelState } : {}),
      tables,
      ...(opts.branchSnapshots.length > 0
        ? { branchSnapshotsFile: BRANCH_SNAPSHOTS_FILE }
        : {}),
    };
    writeFileSync(join(this.tmpDir, MANIFEST), JSON.stringify(manifest));
    const finalDir = join(this.backupsDir, opts.id);
    // Same id twice (an upload of a backup that is already here, an old file being
    // converted): the new copy replaces the old one rather than listing beside it.
    rmSync(finalDir, { recursive: true, force: true });
    renameSync(this.tmpDir, finalDir);
    rmSync(join(this.backupsDir, `${opts.id}.json`), { force: true });
    return metadata;
  }

  async abort(): Promise<void> {
    await this.open?.abort();
    rmSync(this.tmpDir, { recursive: true, force: true });
  }
}

// Back the project up to disk, a page of rows at a time, so the heap holds one
// page and never the database.
export async function writeBackup(
  kernel: Kernel,
  db: Database,
  trigger: BackupMetadata["trigger"],
  backupsDir: string,
  maxBackups: number,
): Promise<BackupMetadata> {
  return (await backUp(kernel, db, trigger, backupsDir, maxBackups, false))!;
}

// writeBackup, unless the newest backup already holds what this one would: null
// then, and nothing is written. The periodic and shutdown backups go through here.
// A project left open and idle used to back itself up on every restart and every
// interval, and each copy pushed an older, different one out.
export function writeBackupIfChanged(
  kernel: Kernel,
  db: Database,
  trigger: BackupMetadata["trigger"],
  backupsDir: string,
  maxBackups: number,
): Promise<BackupMetadata | null> {
  return backUp(kernel, db, trigger, backupsDir, maxBackups, true);
}

async function backUp(
  kernel: Kernel,
  db: Database,
  trigger: BackupMetadata["trigger"],
  backupsDir: string,
  maxBackups: number,
  onlyIfChanged: boolean,
): Promise<BackupMetadata | null> {
  mkdirSync(backupsDir, { recursive: true });
  const previous = listBackups(backupsDir)[0]?.fingerprint;
  // Taken before the rows are read: a write that lands mid-backup makes the next
  // fingerprint differ, so it costs a backup, never a missed change.
  const fingerprint = await backupFingerprint(kernel, db, previous);
  if (onlyIfChanged && sameContents(fingerprint, previous)) return null;
  const id = createTimestampedShortId("backup");
  const createdAt = new Date().toISOString();
  // The project state as it was when the backup started, like the rows.
  const kernelState = serializeKernelState(kernel);
  const writer = BackupDirWriter.create(backupsDir);
  try {
    for (const schema of await db.listSchemas()) {
      const table = await writer.openTable({
        tableName: schema.tableName,
        sql: schema.sql,
        ...(schema.module ? { module: schema.module } : {}),
      });
      for await (const page of readTablePages(db, schema.tableName)) {
        await table.write(page.lines, page.count);
      }
      await table.close();
    }
    const metadata = await writer.finish({
      id,
      createdAt,
      trigger,
      kernelState,
      branchSnapshots: branchSnapshotsOf(kernel),
      fingerprint,
    });
    pruneBackups(backupsDir, maxBackups);
    return metadata;
  } catch (err) {
    await writer.abort();
    throw err;
  }
}

// A short string that changes when anything a backup holds changes: the user
// tables' rows and definitions, the project state, the branch snapshots. Three
// parts, dot-separated:
//
// - The next transaction id, when no transaction is in flight. Postgres hands an id
//   only to a transaction that writes, and checkpoints, reads and restarts take
//   none, so an unchanged id means nothing at all was written.
// - A hash of the project state and the branch snapshot ids.
// - A hash over each user table's definition, columns, row count, newest xmin and
//   file node. An insert or update brings a newer xmin, a delete a lower count, a
//   TRUNCATE or a rewriting ALTER a new file node, an ALTER that rewrites nothing
//   (ADD COLUMN) a new column list. This is a scan of every table — about half a
//   second a gigabyte — and it is skipped when the id says nothing was written.
//
// The id alone would not do: OpenTide's own tables (chat messages, the changelog)
// live in the same database and change on every turn, and a backup leaves them out.
// Postgres's own write counters would be cheaper than the scan, but PGlite never
// flushes them; they read zero.
export async function backupFingerprint(
  kernel: Kernel,
  db: Database,
  previous?: string,
): Promise<string> {
  const [snap] = await db.query(
    `SELECT pg_snapshot_xmin(s)::text AS lo, pg_snapshot_xmax(s)::text AS hi
       FROM pg_current_snapshot() AS s`,
  );
  // A transaction still in flight may commit rows after the scan below; with one,
  // the id is left blank so the next fingerprint scans again.
  const xid = snap && snap.lo === snap.hi ? String(snap.hi) : "";
  const state = shortHash(
    JSON.stringify(serializeKernelState(kernel)) +
      JSON.stringify(kernel.branches.list().map((b) => b.snapshotId)),
  );
  const [prevXid, prevState, prevTables] = previous?.split(".") ?? [];
  if (xid && xid === prevXid && state === prevState && prevTables) {
    return previous!;
  }
  const tables = createHash("sha256");
  for (const schema of await db.listSchemas()) {
    const name = `"${schema.tableName.replaceAll('"', '""')}"`;
    const rel = `'${name.replaceAll("'", "''")}'::regclass`;
    const [row] = await db.query(
      `SELECT count(*)::text AS n, max(xmin::text::bigint)::text AS x,
              pg_relation_filenode(${rel})::text AS f,
              (SELECT string_agg(attname || ' ' ||
                                 format_type(atttypid, atttypmod),
                                 ', ' ORDER BY attnum)
                 FROM pg_attribute
                WHERE attrelid = ${rel} AND attnum > 0
                  AND NOT attisdropped) AS c
         FROM ${name}`,
    );
    tables.update(
      JSON.stringify([
        schema.tableName,
        schema.sql,
        row?.c,
        row?.n,
        row?.x,
        row?.f,
      ]) + "\n",
    );
  }
  return `${xid}.${state}.${tables.digest("hex").slice(0, 16)}`;
}

// Whether two fingerprints describe the same contents. The transaction id is only
// a shortcut past the scan; OpenTide's own writes move it with nothing backed up
// changing.
function sameContents(a: string, b: string | undefined): boolean {
  return b !== undefined &&
    a.slice(a.indexOf(".")) === b.slice(b.indexOf("."));
}

function shortHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

// Save a backup held whole in memory: an upload, a test fixture.
export async function saveBackup(
  backup: BackupData,
  backupsDir: string,
  maxBackups: number,
): Promise<BackupMetadata> {
  mkdirSync(backupsDir, { recursive: true });
  const writer = BackupDirWriter.create(backupsDir);
  try {
    for (const t of backup.tables) {
      const table = await writer.openTable({
        tableName: t.tableName,
        sql: t.sql,
        ...(t.module ? { module: t.module } : {}),
      });
      for (let i = 0; i < t.rows.length; i += 1000) {
        const page = t.rows.slice(i, i + 1000);
        await table.write(
          page.map((r) => JSON.stringify(r) + "\n").join(""),
          page.length,
        );
      }
      await table.close();
    }
    const metadata = await writer.finish({
      id: backup.metadata.id,
      createdAt: backup.metadata.createdAt,
      trigger: backup.metadata.trigger,
      kernelState: backup.kernelState,
      branchSnapshots: backup.branchSnapshots ?? [],
      fingerprint: backup.metadata.fingerprint,
    });
    pruneBackups(backupsDir, maxBackups);
    return metadata;
  } catch (err) {
    await writer.abort();
    throw err;
  }
}

function branchSnapshotsOf(kernel: Kernel): SnapshotData[] {
  const out: SnapshotData[] = [];
  const seen = new Set<string>();
  for (const branch of kernel.branches.list()) {
    if (seen.has(branch.snapshotId)) continue;
    seen.add(branch.snapshotId);
    const snap = kernel.snapshots.getBranchSnapshot(branch.snapshotId);
    if (snap) out.push(snap);
  }
  return out;
}

const PAGE_TARGET_BYTES = 4 * 1024 * 1024;
const PAGE_MAX_ROWS = 1000;
const KEY_ALIAS = "__opentide_backup_key_";

// A table's rows as lines of JSON, in pages. Keyset-paged on the primary key (ctid
// when there is none), so each row is read once even if rows are written
// meanwhile, and no page costs a scan of the ones before it. The page size adapts
// to the rows: starts small, aims for PAGE_TARGET_BYTES of JSON per page.
async function* readTablePages(
  db: Database,
  tableName: string,
): AsyncGenerator<{ lines: string; count: number }> {
  const table = `"${tableName}"`;
  const pk = await db.query(
    `SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type
     FROM pg_index i
     JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
     WHERE i.indrelid = to_regclass($1) AND i.indisprimary
     ORDER BY array_position(i.indkey::int2[], a.attnum)`,
    [table],
  ) as Array<{ name: string; type: string }>;
  const keys = pk.length > 0
    ? pk.map((k) => ({ expr: `"${k.name}"`, type: k.type }))
    : [{ expr: "ctid", type: "tid" }];
  const order = keys.map((k) => k.expr).join(", ");
  const selectKeys = keys
    .map((k, i) => `${k.expr}::text AS "${KEY_ALIAS}${i}"`)
    .join(", ");
  const after = keys.map((k, i) => `$${i + 1}::${k.type}`).join(", ");

  let last: unknown[] | null = null;
  let limit = 16;
  while (true) {
    const where = last ? `WHERE (${order}) > (${after})` : "";
    const rows = await db.query(
      `SELECT *, ${selectKeys} FROM ${table} ${where} ORDER BY ${order} LIMIT ${limit}`,
      last ?? [],
    );
    if (rows.length === 0) return;
    const tail = rows[rows.length - 1]!;
    last = keys.map((_, i) => tail[`${KEY_ALIAS}${i}`]);
    for (const row of rows) {
      for (let i = 0; i < keys.length; i++) delete row[`${KEY_ALIAS}${i}`];
    }
    // JSON.stringify never emits a raw newline, so one row is one line.
    const lines = rows.map((r) => JSON.stringify(r) + "\n").join("");
    yield { lines, count: rows.length };
    if (rows.length < limit) return;
    const perRow = Math.max(1, lines.length / rows.length);
    limit = Math.max(
      1,
      Math.min(PAGE_MAX_ROWS, Math.floor(PAGE_TARGET_BYTES / perRow)),
    );
  }
}

// --- Reading ---

export interface OpenedBackup {
  metadata: BackupMetadata;
  kernelState?: PersistedState;
  tables: Array<BackupTableDef & { rowCount: number }>;
  // A table's rows, a batch at a time.
  batches(tableName: string): AsyncGenerator<Record<string, unknown>[]>;
  branchSnapshots(): Promise<SnapshotData[]>;
  // Read every table file through, without restoring anything: a truncated or
  // corrupt file, or one with a different row count than the manifest, is an
  // error here rather than halfway through a restore.
  verify(): Promise<string[]>;
  // The backup as the old single-object JSON, a piece at a time, for download.
  asJson(): AsyncGenerator<string>;
}

const RESTORE_BATCH_ROWS = 100;
const RESTORE_BATCH_BYTES = 4 * 1024 * 1024;

async function* gzipLines(path: string): AsyncGenerator<string> {
  const file = await Deno.open(path, { read: true });
  const text = file.readable
    .pipeThrough(new DecompressionStream("gzip"))
    .pipeThrough(new TextDecoderStream());
  let rest = "";
  for await (const chunk of text) {
    const parts = (rest + chunk).split("\n");
    rest = parts.pop()!;
    for (const line of parts) if (line) yield line;
  }
  // Every line is written with its newline, so anything left over is a row cut off.
  if (rest) throw new Error(`${path} ends partway through a row`);
}

// Open a backup to restore or download it. An old single-file backup is converted
// to a directory first. Null when there is no such backup or it cannot be read.
export async function openBackup(
  backupsDir: string,
  id: string,
): Promise<OpenedBackup | null> {
  if (!isValidBackupId(id)) return null;
  const dir = join(backupsDir, id);
  const manifestPath = join(dir, MANIFEST);
  if (!existsSync(manifestPath)) {
    const legacy = join(backupsDir, `${id}.json`);
    if (!existsSync(legacy)) return null;
    try {
      const metadata = await importJsonBackup(fileText(legacy), backupsDir);
      if (metadata.id !== id) {
        // The file's name and the id inside it disagree; the converted copy went
        // under the id inside.
        return openBackup(backupsDir, metadata.id);
      }
    } catch (err) {
      console.warn(
        `  Backup ${id} could not be read: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return null;
    }
  }
  let manifest: BackupManifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
  } catch {
    return null;
  }
  const byName = new Map(manifest.tables.map((t) => [t.tableName, t]));
  const lines = (tableName: string): AsyncGenerator<string> => {
    const table = byName.get(tableName);
    if (!table) throw new Error(`Backup ${id} has no table "${tableName}"`);
    return gzipLines(join(dir, table.file));
  };
  const opened: OpenedBackup = {
    metadata: manifest.metadata,
    ...(manifest.kernelState ? { kernelState: manifest.kernelState } : {}),
    tables: manifest.tables.map(({ file: _file, ...def }) => def),
    async *batches(tableName) {
      let batch: Record<string, unknown>[] = [];
      let bytes = 0;
      for await (const line of lines(tableName)) {
        batch.push(JSON.parse(line));
        bytes += line.length;
        if (
          batch.length >= RESTORE_BATCH_ROWS || bytes >= RESTORE_BATCH_BYTES
        ) {
          yield batch;
          batch = [];
          bytes = 0;
        }
      }
      if (batch.length > 0) yield batch;
    },
    async branchSnapshots() {
      if (!manifest.branchSnapshotsFile) return [];
      const out: SnapshotData[] = [];
      for await (
        const line of gzipLines(join(dir, manifest.branchSnapshotsFile))
      ) {
        out.push(JSON.parse(line));
      }
      return out;
    },
    async verify() {
      const errors: string[] = [];
      for (const table of manifest.tables) {
        let count = 0;
        try {
          for await (const _ of lines(table.tableName)) count++;
        } catch (err) {
          errors.push(
            `${table.tableName}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
          continue;
        }
        if (count !== table.rowCount) {
          errors.push(
            `${table.tableName}: ${count} rows on disk, the manifest says ${table.rowCount}`,
          );
        }
      }
      try {
        await opened.branchSnapshots();
      } catch (err) {
        errors.push(
          `branch snapshots: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      return errors;
    },
    async *asJson() {
      yield `{"metadata":${JSON.stringify(manifest.metadata)}`;
      if (manifest.kernelState) {
        yield `,"kernelState":${JSON.stringify(manifest.kernelState)}`;
      }
      yield `,"tables":[`;
      for (const [i, table] of manifest.tables.entries()) {
        const head = {
          tableName: table.tableName,
          sql: table.sql,
          ...(table.module ? { module: table.module } : {}),
        };
        yield `${i > 0 ? "," : ""}${
          JSON.stringify(head).slice(0, -1)
        },"rows":[`;
        let first = true;
        let page: string[] = [];
        for await (const line of lines(table.tableName)) {
          page.push(line);
          if (page.length >= PAGE_MAX_ROWS) {
            yield (first ? "" : ",") + page.join(",");
            first = false;
            page = [];
          }
        }
        if (page.length > 0) yield (first ? "" : ",") + page.join(",");
        yield `]}`;
      }
      yield `]`;
      const snaps = await opened.branchSnapshots();
      if (snaps.length > 0) {
        yield `,"branchSnapshots":${JSON.stringify(snaps)}`;
      }
      yield `}`;
    },
  };
  return opened;
}

async function* fileText(path: string): AsyncGenerator<string> {
  const file = await Deno.open(path, { read: true });
  yield* file.readable.pipeThrough(new TextDecoderStream());
}

// --- The old single-object format, read as a stream ---

// Just enough of a JSON reader to walk a backup object without holding it: keys
// and small values are parsed, each row is cut out as text and written straight
// through. Text arrives in chunks; only the unread tail of the current chunk, plus
// the value being cut, is ever held.
class JsonReader {
  private buf = "";
  private pos = 0;
  private ended = false;

  constructor(private readonly chunks: AsyncIterator<string>) {}

  private async fill(): Promise<boolean> {
    if (this.ended) return false;
    const next = await this.chunks.next();
    if (next.done) {
      this.ended = true;
      return false;
    }
    this.buf = this.buf.slice(this.pos) + next.value;
    this.pos = 0;
    return true;
  }

  // The next character that is not whitespace, not consumed.
  async peek(): Promise<string> {
    while (true) {
      while (this.pos < this.buf.length) {
        const c = this.buf.charCodeAt(this.pos);
        if (c === 32 || c === 10 || c === 13 || c === 9) this.pos++;
        else return this.buf[this.pos]!;
      }
      if (!(await this.fill())) throw new Error("the backup ends early");
    }
  }

  async expect(ch: string): Promise<void> {
    const got = await this.peek();
    if (got !== ch) {
      throw new Error(
        `the backup is not valid JSON: expected ${ch}, got ${got}`,
      );
    }
    this.pos++;
  }

  async maybe(ch: string): Promise<boolean> {
    if ((await this.peek()) !== ch) return false;
    this.pos++;
    return true;
  }

  // The text of the next whole value.
  async raw(): Promise<string> {
    const first = await this.peek();
    const scalar = first !== "{" && first !== "[" && first !== '"';
    const parts: string[] = [];
    let start = this.pos;
    let depth = 0;
    let inString = false;
    let escaped = false;
    while (true) {
      const buf = this.buf;
      for (let i = this.pos; i < buf.length; i++) {
        const c = buf.charCodeAt(i);
        let end = -1;
        if (scalar) {
          if (
            c === 44 || c === 125 || c === 93 || c === 32 || c === 10 ||
            c === 13 || c === 9
          ) end = i;
        } else if (inString) {
          if (escaped) escaped = false;
          else if (c === 92) escaped = true;
          else if (c === 34) {
            inString = false;
            if (depth === 0) end = i + 1;
          }
        } else if (c === 34) inString = true;
        else if (c === 123 || c === 91) depth++;
        else if ((c === 125 || c === 93) && --depth === 0) end = i + 1;
        if (end !== -1) {
          parts.push(buf.slice(start, end));
          this.pos = end;
          return parts.join("");
        }
      }
      parts.push(buf.slice(start));
      this.pos = buf.length;
      if (!(await this.fill())) {
        if (scalar) return parts.join("");
        throw new Error("the backup ends early");
      }
      start = 0;
    }
  }

  async parse<T>(): Promise<T> {
    return JSON.parse(await this.raw()) as T;
  }
}

const IMPORT_FLUSH_BYTES = 1024 * 1024;

// Turn a backup in the old single-object JSON format — an old backup file, an
// upload — into a backup directory, reading it as a stream. Any key order, any
// whitespace. Throws, leaving nothing behind, on anything that is not a whole
// backup.
export async function importJsonBackup(
  text: AsyncIterable<string>,
  backupsDir: string,
  { requireProjectState = false } = {},
): Promise<BackupMetadata> {
  mkdirSync(backupsDir, { recursive: true });
  const json = new JsonReader(text[Symbol.asyncIterator]());
  const writer = BackupDirWriter.create(backupsDir);
  try {
    let metadata: Partial<BackupMetadata> | undefined;
    let kernelState: PersistedState | undefined;
    let branchSnapshots: SnapshotData[] = [];
    let sawTables = false;
    await json.expect("{");
    if (!(await json.maybe("}"))) {
      do {
        const key = await json.parse<string>();
        await json.expect(":");
        if (key === "tables") {
          sawTables = true;
          await importTables(json, writer);
        } else if (key === "metadata") metadata = await json.parse();
        else if (key === "kernelState") kernelState = await json.parse();
        else if (key === "branchSnapshots") {
          branchSnapshots = await json.parse();
        } else await json.raw();
      } while (await json.maybe(","));
      await json.expect("}");
    }
    if (!metadata?.id || !sawTables) {
      throw new Error("not a backup: no metadata id or no tables");
    }
    if (requireProjectState && !kernelState) {
      throw new Error("not a backup: no project state");
    }
    return await writer.finish({
      id: metadata.id,
      createdAt: metadata.createdAt ?? new Date().toISOString(),
      trigger: metadata.trigger ?? "manual",
      ...(kernelState ? { kernelState } : {}),
      branchSnapshots: Array.isArray(branchSnapshots) ? branchSnapshots : [],
      // A download carries its own: it still describes the rows that came with it.
      ...(typeof metadata.fingerprint === "string" &&
          metadata.fingerprint.length <= 128
        ? { fingerprint: metadata.fingerprint }
        : {}),
    });
  } catch (err) {
    await writer.abort();
    throw err;
  }
}

async function importTables(
  json: JsonReader,
  writer: BackupDirWriter,
): Promise<void> {
  await json.expect("[");
  if (await json.maybe("]")) return;
  do {
    const def: Partial<BackupTableDef> = {};
    let table: TableHandle | null = null;
    await json.expect("{");
    if (!(await json.maybe("}"))) {
      do {
        const key = await json.parse<string>();
        await json.expect(":");
        if (key !== "rows") {
          (def as Record<string, unknown>)[key] = await json.parse();
          continue;
        }
        // "rows" can come before "module", so the table is named once its object
        // closes, below.
        table = await writer.openTable();
        await json.expect("[");
        if (!(await json.maybe("]"))) {
          let lines = "";
          let count = 0;
          do {
            let row = await json.raw();
            // A pretty-printed upload: one row has to be one line.
            if (row.includes("\n") || row.includes("\r")) {
              row = JSON.stringify(JSON.parse(row));
            }
            lines += row + "\n";
            count++;
            if (lines.length >= IMPORT_FLUSH_BYTES) {
              await table.write(lines, count);
              lines = "";
              count = 0;
            }
          } while (await json.maybe(","));
          if (count > 0) await table.write(lines, count);
          await json.expect("]");
        }
        await table.close();
      } while (await json.maybe(","));
      await json.expect("}");
    }
    if (typeof def.tableName !== "string" || typeof def.sql !== "string") {
      throw new Error("not a backup: a table has no tableName or sql");
    }
    if (!table) {
      table = await writer.openTable();
      await table.close();
    }
    table.define({
      tableName: def.tableName,
      sql: def.sql,
      ...(typeof def.module === "string" ? { module: def.module } : {}),
    });
  } while (await json.maybe(","));
  await json.expect("]");
}

// --- Listing and retention ---

export function listBackups(backupsDir: string): BackupMetadata[] {
  if (!existsSync(backupsDir)) return [];
  const byId = new Map<string, BackupMetadata>();
  for (const name of readdirSync(backupsDir)) {
    if (name.endsWith(".tmp")) continue;
    const manifest = join(backupsDir, name, MANIFEST);
    const path = name.endsWith(".json")
      ? join(backupsDir, name)
      : existsSync(manifest)
      ? manifest
      : null;
    if (!path) continue;
    try {
      const metadata = readBackupMetadata(path);
      // A directory wins over an old file with the same id; the file is what a
      // conversion was interrupted before deleting.
      if (metadata && (!byId.has(metadata.id) || path === manifest)) {
        byId.set(metadata.id, metadata);
      }
    } catch { /* skip unreadable */ }
  }
  return [...byId.values()].sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt)
  );
}

const METADATA_PROBE_BYTES = 64 * 1024;
// A file this small is cheap to parse whole, which is the only way to fill in
// the fields an old backup's metadata never had.
const FULL_PARSE_MAX_BYTES = 8 * 1024 * 1024;

// A backup's metadata without parsing the backup. The metadata is a flat object at
// one end of the file: first in a manifest and in the old format, last in what
// one pre-release build wrote.
export function readBackupMetadata(path: string): BackupMetadata | null {
  const fd = openSync(path, "r");
  let head: string;
  let tail: string;
  let size: number;
  try {
    size = fstatSync(fd).size;
    const read = (at: number, length: number) => {
      const buf = new Uint8Array(length);
      const n = readSync(fd, buf, 0, length, at);
      return new TextDecoder().decode(buf.subarray(0, n));
    };
    head = read(0, Math.min(size, METADATA_PROBE_BYTES));
    const tailFrom = Math.max(0, size - METADATA_PROBE_BYTES);
    tail = tailFrom === 0 ? head : read(tailFrom, size - tailFrom);
  } finally {
    closeSync(fd);
  }

  const atHead = head.startsWith(`{"metadata":{`)
    ? flatObjectAt(head, `{"metadata":`.length)
    : null;
  const marker = tail.lastIndexOf(`"metadata":{`);
  const atTail = !atHead && marker !== -1
    ? flatObjectAt(tail, marker + `"metadata":`.length)
    : null;
  const found = atHead ?? atTail;
  const metadata = found ? JSON.parse(found) as BackupMetadata : null;
  const complete = metadata?.branchSnapshotCount !== undefined &&
    metadata.includesProjectState !== undefined;

  if ((!metadata || !complete) && size <= FULL_PARSE_MAX_BYTES) {
    const data = JSON.parse(readFileSync(path, "utf-8")) as BackupData;
    if (!data.metadata?.id) return null;
    return {
      ...data.metadata,
      branchSnapshotCount: data.metadata.branchSnapshotCount ??
        data.branchSnapshots?.length ?? 0,
      includesProjectState: data.metadata.includesProjectState ??
        Boolean(data.kernelState),
    };
  }
  if (!metadata?.id) return null;
  return {
    ...metadata,
    branchSnapshotCount: metadata.branchSnapshotCount ?? 0,
    includesProjectState: metadata.includesProjectState ??
      head.includes(`"kernelState":`),
  };
}

// The `{...}` that starts at `from`, or null when it doesn't close inside the
// text. Strings are skipped so a brace in a value can't end it early.
function flatObjectAt(text: string, from: number): string | null {
  if (text[from] !== "{") return null;
  let depth = 0;
  let inString = false;
  for (let i = from; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return text.slice(from, i + 1);
  }
  return null;
}

export function deleteBackup(backupsDir: string, id: string): boolean {
  if (!isValidBackupId(id)) return false;
  const dir = join(backupsDir, id);
  const file = join(backupsDir, `${id}.json`);
  if (!existsSync(dir) && !existsSync(file)) return false;
  try {
    rmSync(dir, { recursive: true, force: true });
    rmSync(file, { force: true });
    return true;
  } catch {
    return false;
  }
}

// However many backups are kept, the newest few always are.
const RECENT_BACKUPS = 2;
// Then one a day for this many days, then one a week across this many weeks of days
// before those. Counted back from the newest backup's day, not from today: a project
// left alone for two months keeps the month of history it had.
const DAILY_BACKUP_DAYS = 7;
const WEEKLY_BACKUP_WEEKS = 4;
const DAY_MS = 24 * 60 * 60 * 1000;
// A temporary directory this old is not a backup still being written.
const STALE_TMP_MS = 24 * 60 * 60 * 1000;

// Which backups to keep, newest first: the RECENT_BACKUPS newest; the newest of each
// UTC day in the DAILY_BACKUP_DAYS days ending on the newest backup's; the newest of
// each Monday-to-Sunday week in the WEEKLY_BACKUP_WEEKS * 7 days before those. At
// most 2 + 6 + 5 = 13, and never more than maxBackups. Nothing tops the list up: the
// old policy filled spare slots with the newest, so one busy morning took every slot
// and pushed out the days before it.
//
// Buckets are calendar days and weeks. Buckets measured back from the newest backup
// would slide every day, re-elect their newest member, and nothing would ever grow
// old enough to be the weekly copy.
export function backupsToKeep(
  newestFirst: BackupMetadata[],
  maxBackups: number,
): BackupMetadata[] {
  if (maxBackups <= 0 || newestFirst.length === 0) return [];
  const dayOf = (b: BackupMetadata) =>
    Math.floor(Date.parse(b.createdAt) / DAY_MS);
  const newestDay = dayOf(newestFirst[0]!);
  const keep: BackupMetadata[] = [];
  const buckets = new Set<string>();
  newestFirst.forEach((b, i) => {
    const day = dayOf(b);
    const back = newestDay - day;
    // Day 0 of the epoch was a Thursday; + 3 starts the weeks on Mondays.
    const bucket = back < DAILY_BACKUP_DAYS
      ? `day ${day}`
      : back < DAILY_BACKUP_DAYS + 7 * WEEKLY_BACKUP_WEEKS
      ? `week ${Math.floor((day + 3) / 7)}`
      : null;
    if (i < RECENT_BACKUPS || (bucket && !buckets.has(bucket))) keep.push(b);
    if (bucket) buckets.add(bucket);
  });
  return keep.slice(0, maxBackups);
}

export function pruneBackups(backupsDir: string, maxBackups: number): void {
  if (!existsSync(backupsDir)) return;
  const all = listBackups(backupsDir);
  const keep = new Set(backupsToKeep(all, maxBackups).map((b) => b.id));
  for (const old of all) {
    if (!keep.has(old.id)) deleteBackup(backupsDir, old.id);
  }
  // Left behind by a process that died mid-write.
  for (const name of readdirSync(backupsDir)) {
    if (!name.endsWith(".tmp")) continue;
    const path = join(backupsDir, name);
    try {
      if (Date.now() - statSync(path).mtimeMs > STALE_TMP_MS) {
        rmSync(path, { recursive: true, force: true });
      }
    } catch { /* gone already */ }
  }
}

// --- Restoring ---

export async function restoreBranchSnapshots(
  backup: OpenedBackup,
  kernel: Kernel,
  { restoreBranchList = false } = {},
): Promise<number> {
  const snapshots = await backup.branchSnapshots();
  for (const snap of snapshots) {
    kernel.snapshots.setBranchSnapshot(snap.metadata.id, snap);
  }
  if (restoreBranchList && backup.kernelState?.branches?.length) {
    kernel.branches.restore(backup.kernelState.branches);
  }
  return snapshots.length;
}

// Postgres takes at most this many parameters in one statement.
const MAX_PARAMS = 65535;

interface RestoreTablePlan {
  table: BackupTableDef;
  createSql: string;
  alterSqls: string[];
}

interface SkippedTransientColumn {
  tableName: string;
  columnName: string;
}

function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  let i = 0;

  while (i < sql.length) {
    const ch = sql[i]!;
    const next = sql[i + 1];

    if (ch === "'") {
      current += ch;
      i++;
      while (i < sql.length) {
        current += sql[i]!;
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            current += sql[i + 1]!;
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      continue;
    }

    if (ch === '"') {
      current += ch;
      i++;
      while (i < sql.length) {
        current += sql[i]!;
        if (sql[i] === '"') {
          if (sql[i + 1] === '"') {
            current += sql[i + 1]!;
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      continue;
    }

    if (ch === "-" && next === "-") {
      current += ch + next;
      i += 2;
      while (i < sql.length) {
        current += sql[i]!;
        if (sql[i] === "\n") {
          i++;
          break;
        }
        i++;
      }
      continue;
    }

    if (ch === "/" && next === "*") {
      current += ch + next;
      i += 2;
      while (i < sql.length) {
        current += sql[i]!;
        if (sql[i] === "*" && sql[i + 1] === "/") {
          current += sql[i + 1]!;
          i += 2;
          break;
        }
        i++;
      }
      continue;
    }

    if (ch === ";") {
      const statement = current.trim();
      if (statement) statements.push(statement);
      current = "";
      i++;
      continue;
    }

    current += ch;
    i++;
  }

  const tail = current.trim();
  if (tail) statements.push(tail);
  return statements;
}

function isCreateTableSql(sql: string): boolean {
  return /^\s*CREATE\s+TABLE\b/i.test(sql);
}

function restoreErrorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.split("\nStatement:")[0]!;
}

function escapedRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function unquoteSqlIdentifier(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replaceAll('""', '"');
  }
  return trimmed.toLowerCase();
}

function dropColumnsInStatement(tableName: string, sql: string): string[] {
  const match = sql.match(
    new RegExp(
      `^\\s*ALTER\\s+TABLE\\s+"?${escapedRegExp(tableName)}"?\\s+(.+)$`,
      "is",
    ),
  );
  if (!match) return [];
  return [
    ...match[1]!.matchAll(
      /\bDROP\s+COLUMN\s+(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))/gi,
    ),
  ]
    .map((m) => m[1] ?? m[2]!)
    .map(unquoteSqlIdentifier);
}

function singleAddColumn(sql: string): string | null {
  const match = sql.match(
    /^\s*ALTER\s+TABLE\s+(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_]*)\s+ADD\s+COLUMN\s+(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))\b/is,
  );
  if (!match) return null;
  return unquoteSqlIdentifier(match[1] ?? match[2]!);
}

function referencesMissingBackupTable(
  sql: string,
  knownTables: Set<string>,
): boolean {
  return referencedTables(sql).some((tableName) => !knownTables.has(tableName));
}

function withoutSkippedDropColumn(
  sql: string,
  skipped: SkippedTransientColumn[],
): string | null {
  let next = sql;
  for (const { columnName } of skipped) {
    const ident = escapedRegExp(columnName);
    next = next.replace(
      new RegExp(`\\s*,?\\s*DROP\\s+COLUMN\\s+"?${ident}"?`, "i"),
      "",
    );
  }
  if (!/\bDROP\s+COLUMN\b/i.test(next)) return null;
  return next;
}

function pruneTransientDroppedColumns(
  tableName: string,
  alterSqls: string[],
  knownTables: Set<string>,
): string[] {
  const dropped = new Set(
    alterSqls.flatMap((sql) => dropColumnsInStatement(tableName, sql)),
  );
  const skipped: SkippedTransientColumn[] = [];
  const pruned: string[] = [];

  for (const sql of alterSqls) {
    const addedColumn = singleAddColumn(sql);
    if (
      addedColumn && dropped.has(addedColumn) &&
      referencesMissingBackupTable(sql, knownTables)
    ) {
      skipped.push({ tableName, columnName: addedColumn });
      continue;
    }

    if (
      dropColumnsInStatement(tableName, sql).length > 0 && skipped.length > 0
    ) {
      const rewritten = withoutSkippedDropColumn(
        sql,
        skipped.filter((entry) => entry.tableName === tableName),
      );
      if (rewritten) pruned.push(rewritten);
      continue;
    }

    pruned.push(sql);
  }

  return pruned;
}

function orderRestoreCreates(plans: RestoreTablePlan[]): RestoreTablePlan[] {
  const byTable = new Map(plans.map((plan) => [plan.table.tableName, plan]));
  const tableNames = plans.map((plan) => plan.table.tableName).sort();
  const dependents = new Map<string, Set<string>>();
  const indegree = new Map<string, number>();

  for (const tableName of tableNames) {
    dependents.set(tableName, new Set());
    indegree.set(tableName, 0);
  }

  for (const plan of plans) {
    const tableName = plan.table.tableName;
    for (
      const dep of referencedTables(plan.createSql)
        .filter((ref) => ref !== tableName && byTable.has(ref))
    ) {
      dependents.get(dep)!.add(tableName);
      indegree.set(tableName, (indegree.get(tableName) ?? 0) + 1);
    }
  }

  const ready = tableNames.filter((tableName) => indegree.get(tableName) === 0);
  const ordered: RestoreTablePlan[] = [];

  while (ready.length > 0) {
    ready.sort();
    const tableName = ready.shift()!;
    ordered.push(byTable.get(tableName)!);
    for (const dependent of [...dependents.get(tableName)!].sort()) {
      indegree.set(dependent, indegree.get(dependent)! - 1);
      if (indegree.get(dependent) === 0) ready.push(dependent);
    }
  }

  if (ordered.length !== plans.length) {
    const restoredNames = new Set(ordered.map((plan) => plan.table.tableName));
    const cycle = tableNames.filter((tableName) =>
      !restoredNames.has(tableName)
    );
    throw new Error(
      `Cannot restore backup schemas: base CREATE TABLE dependency cycle among ${
        cycle.join(", ")
      }`,
    );
  }

  return ordered;
}

function orderRestoreRows(plans: RestoreTablePlan[]): RestoreTablePlan[] {
  const byTable = new Map(plans.map((plan) => [plan.table.tableName, plan]));
  const tableNames = plans.map((plan) => plan.table.tableName).sort();
  const dependents = new Map<string, Set<string>>();
  const indegree = new Map<string, number>();

  for (const tableName of tableNames) {
    dependents.set(tableName, new Set());
    indegree.set(tableName, 0);
  }

  for (const plan of plans) {
    const tableName = plan.table.tableName;
    const sql = [plan.createSql, ...plan.alterSqls].join("\n");
    for (
      const dep of referencedTables(sql)
        .filter((ref) => ref !== tableName && byTable.has(ref))
    ) {
      dependents.get(dep)!.add(tableName);
      indegree.set(tableName, (indegree.get(tableName) ?? 0) + 1);
    }
  }

  const ready = tableNames.filter((tableName) => indegree.get(tableName) === 0);
  const ordered: RestoreTablePlan[] = [];

  while (ready.length > 0) {
    ready.sort();
    const tableName = ready.shift()!;
    ordered.push(byTable.get(tableName)!);
    for (const dependent of [...dependents.get(tableName)!].sort()) {
      indegree.set(dependent, indegree.get(dependent)! - 1);
      if (indegree.get(dependent) === 0) ready.push(dependent);
    }
  }

  return ordered.length === plans.length ? ordered : plans;
}

function isDataStatement(sql: string): boolean {
  return /^\s*(?:DELETE|UPDATE|INSERT|MERGE|TRUNCATE|WITH)\b/i.test(sql);
}

// What restoring rows into a table needs to know about its columns.
async function restoreTargetColumns(db: Database, tableName: string): Promise<{
  generated: Set<string>;
  json: Set<string>;
  sequenced: string[];
  identityAlways: boolean;
}> {
  const columns = await db.query(
    `SELECT a.attname AS name,
            format_type(a.atttypid, a.atttypmod) AS type,
            a.attgenerated::text AS generated,
            a.attidentity::text AS identity,
            pg_get_serial_sequence($1, a.attname) IS NOT NULL AS sequenced
     FROM pg_attribute a
     WHERE a.attrelid = to_regclass($1) AND a.attnum > 0 AND NOT a.attisdropped`,
    [`"${tableName}"`],
  ) as Array<{
    name: string;
    type: string;
    generated: string;
    identity: string;
    sequenced: boolean;
  }>;
  return {
    generated: new Set(
      columns.filter((c) => c.generated !== "").map((c) => c.name),
    ),
    json: new Set(
      columns.filter((c) => c.type === "json" || c.type === "jsonb").map((c) =>
        c.name
      ),
    ),
    sequenced: columns.filter((c) => c.sequenced).map((c) => c.name),
    identityAlways: columns.some((c) => c.identity === "a"),
  };
}

export async function restoreDbTables(
  backup: OpenedBackup,
  db: Database,
): Promise<{ restored: number; restoredRows: number; errors: string[] }> {
  const errors: string[] = [];
  let restored = 0;
  let restoredRows = 0;
  const plans: RestoreTablePlan[] = [];
  const knownTables = new Set(backup.tables.map((table) => table.tableName));

  for (const table of backup.tables) {
    const statements = splitSqlStatements(table.sql);
    const [createSql, ...alterSqls] = statements;
    if (!createSql || !isCreateTableSql(createSql)) {
      errors.push(`${table.tableName}: SQL must be a CREATE TABLE statement`);
      continue;
    }
    plans.push({
      table,
      createSql,
      alterSqls: pruneTransientDroppedColumns(
        table.tableName,
        alterSqls,
        knownTables,
      ),
    });
  }

  const created = new Set<string>();
  const failed = new Set<string>();

  try {
    for (const plan of orderRestoreCreates(plans)) {
      try {
        const defined = await db.defineSchema(
          plan.table.tableName,
          plan.createSql,
          plan.table.module,
        );
        if (!defined.ok) {
          throw new Error(defined.error.message);
        }
        created.add(plan.table.tableName);
      } catch (err) {
        failed.add(plan.table.tableName);
        errors.push(
          `${plan.table.tableName}: ${restoreErrorMessage(err)}`,
        );
      }
    }
  } catch (err) {
    errors.push(restoreErrorMessage(err));
  }

  for (const plan of plans) {
    if (
      !created.has(plan.table.tableName) || failed.has(plan.table.tableName)
    ) {
      continue;
    }
    for (const sql of plan.alterSqls) {
      // A data migration in a table's history. The backup's rows are already
      // past it, and replaying it here runs it out of order: tables are altered
      // one after another, so it can name a column another table only gains in
      // its own later ALTER.
      if (isDataStatement(sql)) continue;
      try {
        const altered = await db.alterSchema(
          plan.table.tableName,
          sql,
          plan.table.module,
        );
        if (!altered.ok) {
          throw new Error(altered.error.message);
        }
      } catch (err) {
        failed.add(plan.table.tableName);
        errors.push(
          `${plan.table.tableName}: ${restoreErrorMessage(err)}`,
        );
        break;
      }
    }
  }

  for (const plan of orderRestoreRows(plans)) {
    const table = plan.table;
    if (!created.has(table.tableName) || failed.has(table.tableName)) continue;
    try {
      const target = await restoreTargetColumns(db, table.tableName);
      let columns: string[] | null = null;
      for await (const batch of backup.batches(table.tableName)) {
        if (!columns) {
          // A generated column is in every row (SELECT * reads it) and can't be
          // written; Postgres computes it again.
          columns = Object.keys(batch[0]!).filter((c) =>
            !target.generated.has(c)
          );
          for (const col of columns) {
            // deno-lint-ignore no-control-regex -- the NUL byte is exactly what this rejects: it terminates a C string and would truncate the quoted identifier server-side
            if (/["\\\x00]/.test(col)) {
              throw new Error(`Invalid column name: "${col}"`);
            }
          }
        }
        const cols = columns;
        if (cols.length === 0) continue;
        const perInsert = Math.max(1, Math.floor(MAX_PARAMS / cols.length));
        for (let i = 0; i < batch.length; i += perInsert) {
          const rows = batch.slice(i, i + perInsert);
          const valuesClauses: string[] = [];
          const params: unknown[] = [];
          for (let j = 0; j < rows.length; j++) {
            const row = rows[j]!;
            const offset = j * cols.length;
            valuesClauses.push(
              `(${cols.map((_, k) => `$${offset + k + 1}`).join(", ")})`,
            );
            for (const c of cols) {
              const value = row[c];
              // A JSON value goes in as its JSON text. Passed as it came out, a
              // bare string is not valid JSON and an array is sent as a
              // Postgres array.
              params.push(
                target.json.has(c) && value !== null && value !== undefined
                  ? JSON.stringify(value)
                  : value,
              );
            }
          }
          await db.execute(
            `INSERT INTO "${table.tableName}" (${
              cols.map((c) => `"${c}"`).join(", ")
            })${
              target.identityAlways ? " OVERRIDING SYSTEM VALUE" : ""
            } VALUES ${valuesClauses.join(", ")}`,
            params,
          );
        }
        restoredRows += batch.length;
      }
      // Rows went in with their own keys, so the sequences behind those keys
      // never moved: the next insert would start at 1 and collide.
      for (const column of target.sequenced) {
        await db.query(
          `SELECT setval(pg_get_serial_sequence($1, $2), COALESCE(MAX("${column}"), 1), MAX("${column}") IS NOT NULL) FROM "${table.tableName}"`,
          [`"${table.tableName}"`, column],
        );
      }
      restored++;
    } catch (err) {
      errors.push(`${table.tableName}: ${restoreErrorMessage(err)}`);
    }
  }

  return { restored, restoredRows, errors };
}
