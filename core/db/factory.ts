import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import { migrate as migratePostgres } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import * as schema from "./schema/index.ts";

export type DbConfig =
  | { driver: "pglite"; dataDir?: string }
  | { driver: "postgres"; connectionString: string };

export type DrizzleDb =
  | ReturnType<typeof drizzlePglite<typeof schema>>
  | ReturnType<typeof drizzlePostgres<typeof schema>>;

export interface RawConnection {
  query(sql: string, params?: unknown[]): Promise<Record<string, unknown>[]>;
  execute(sql: string, params?: unknown[]): Promise<{ rowCount: number }>;
  exec(sql: string): Promise<void>;
}

export interface DatabaseConnection {
  drizzle: DrizzleDb;
  raw: RawConnection;
  migrate(migrationsFolder: string): Promise<void>;
  close(): Promise<void>;
  // Flush dirty shared buffers and the WAL out of this process and into the data
  // directory. Present only on the PGlite backend, where it is the ONLY thing that
  // gets writes onto the files at all: PGlite runs Postgres over emscripten's
  // NODEFS, whose stream_ops carries no fsync, so `_fd_sync` returns success
  // without syncing and `fsync = on` in postgresql.conf buys nothing. A process
  // killed between checkpoints leaves a directory that fails to open with
  // PgliteCorruptError — which is why callers checkpoint on a cadence rather than
  // trusting the one in close(). An external Postgres checkpoints itself, and
  // would refuse the command to a non-superuser, so it does not implement this.
  checkpoint?(): Promise<void>;
  // A CONSISTENT snapshot of the whole database, taken while it stays open.
  // Present only on the PGlite backend — an external Postgres has its own backup
  // tooling and no data directory we own, so callers must handle its absence.
  //
  // This exists because copying a live PGlite data directory file-by-file does
  // NOT give a usable copy: Postgres is writing those files while cpSync reads
  // them, so the result is a torn snapshot that fails to open with
  // PgliteCorruptError. dumpDataDir is Postgres doing the work itself.
  snapshot?(): Promise<Blob>;
}

const PROJECT_MESSAGE_PINS_MIGRATION_AT = 1782172800000;
const AUTH_IDENTITY_PRIVACY_MIGRATION_AT = 1783900800000;
const SHELL_MESSAGE_KIND_MIGRATION_AT = 1783900800001;
const WORKBLOCK_METADATA_MIGRATION_AT = 1780110000000;

async function tableExists(
  raw: RawConnection,
  schemaName: string,
  tableName: string,
): Promise<boolean> {
  const rows = await raw.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2 LIMIT 1`,
    [schemaName, tableName],
  );
  return rows.length > 0;
}

async function columnExists(
  raw: RawConnection,
  tableName: string,
  columnName: string,
): Promise<boolean> {
  const rows = await raw.query(
    `SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2 LIMIT 1`,
    [tableName, columnName],
  );
  return rows.length > 0;
}

function migrationHash(migrationsFolder: string, tag: string): string {
  const sql = readFileSync(join(migrationsFolder, `${tag}.sql`), "utf-8");
  return createHash("sha256").update(sql).digest("hex");
}

async function migrationRecorded(
  raw: RawConnection,
  createdAt: number,
): Promise<boolean> {
  const rows = await raw.query(
    `SELECT 1 FROM drizzle.__drizzle_migrations WHERE created_at = $1 LIMIT 1`,
    [createdAt],
  );
  return rows.length > 0;
}

async function markMigrationRecorded(
  raw: RawConnection,
  migrationsFolder: string,
  tag: string,
  createdAt: number,
): Promise<void> {
  if (await migrationRecorded(raw, createdAt)) return;
  const hash = migrationHash(migrationsFolder, tag);
  await raw.exec(
    `INSERT INTO drizzle.__drizzle_migrations ("hash", "created_at") VALUES ('${hash}', ${createdAt})`,
  );
}

async function repairProjectMessagePinsMigration(
  raw: RawConnection,
  migrationsFolder: string,
): Promise<void> {
  if (!(await tableExists(raw, "drizzle", "__drizzle_migrations"))) return;

  const migrationRows = await raw.query(
    `SELECT created_at FROM drizzle.__drizzle_migrations ORDER BY created_at DESC LIMIT 1`,
  );
  const lastCreatedAt = Number(migrationRows[0]?.created_at);

  const sessionsTableExists = await tableExists(
    raw,
    "public",
    "_genie_sessions",
  );
  const messagesTableExists = await tableExists(
    raw,
    "public",
    "_genie_messages",
  );

  if (!messagesTableExists && sessionsTableExists) {
    if (lastCreatedAt < WORKBLOCK_METADATA_MIGRATION_AT) return;

    await raw.exec(`DROP TYPE IF EXISTS "_genie_messages" CASCADE`);
    await raw.exec(`DROP SEQUENCE IF EXISTS "_genie_messages_id_seq" CASCADE`);
    const kindColumn = lastCreatedAt >= SHELL_MESSAGE_KIND_MIGRATION_AT
      ? `      "kind" text DEFAULT 'chat' NOT NULL,\n`
      : "";
    await raw.exec(`CREATE TABLE "_genie_messages" (
      "id" serial PRIMARY KEY NOT NULL,
      "session_id" text NOT NULL REFERENCES "public"."_genie_sessions"("id") ON DELETE cascade ON UPDATE no action,
      "role" text NOT NULL,
${kindColumn}      "content" text NOT NULL,
      "tool_calls" text,
      "pinned" boolean DEFAULT false NOT NULL,
      "project_pinned" boolean DEFAULT false NOT NULL,
      "turn_id" text,
      "created_at" text NOT NULL
    )`);
    if (lastCreatedAt >= AUTH_IDENTITY_PRIVACY_MIGRATION_AT) {
      await raw.exec(
        `ALTER TABLE "_genie_messages" ADD COLUMN "author_user_id" text`,
      );
    }
    await raw.exec(
      `CREATE INDEX IF NOT EXISTS "messages_content_search_idx" ON "_genie_messages" USING gin (to_tsvector('english', "content"))`,
    );
    await raw.exec(
      `CREATE INDEX IF NOT EXISTS "messages_session_id_idx" ON "_genie_messages" USING btree ("session_id")`,
    );

    if (lastCreatedAt >= SHELL_MESSAGE_KIND_MIGRATION_AT) {
      // The recreated table already carries the kind column, so record the
      // shell-message-kind migration to keep the ledger consistent with the
      // schema we just reproduced (the drizzle migrator would otherwise skip
      // it as older than the frontier once a later migration exists).
      await markMigrationRecorded(
        raw,
        migrationsFolder,
        "0010_shell_message_kind",
        SHELL_MESSAGE_KIND_MIGRATION_AT,
      );
    }
    await markMigrationRecorded(
      raw,
      migrationsFolder,
      "0008_project_message_pins",
      PROJECT_MESSAGE_PINS_MIGRATION_AT,
    );
    return;
  } else if (!messagesTableExists) {
    return;
  }

  const hasProjectPinnedColumn = await columnExists(
    raw,
    "_genie_messages",
    "project_pinned",
  );
  if (lastCreatedAt >= PROJECT_MESSAGE_PINS_MIGRATION_AT) {
    if (!hasProjectPinnedColumn) {
      await raw.exec(
        `ALTER TABLE "_genie_messages" ADD COLUMN "project_pinned" boolean DEFAULT false NOT NULL`,
      );
    }
    await markMigrationRecorded(
      raw,
      migrationsFolder,
      "0008_project_message_pins",
      PROJECT_MESSAGE_PINS_MIGRATION_AT,
    );
    return;
  }

  if (lastCreatedAt !== WORKBLOCK_METADATA_MIGRATION_AT) return;
  if (!hasProjectPinnedColumn) return;

  await markMigrationRecorded(
    raw,
    migrationsFolder,
    "0008_project_message_pins",
    PROJECT_MESSAGE_PINS_MIGRATION_AT,
  );
}

function cleanStalePgliteLock(dataDir: string): void {
  const pidFile = join(dataDir, "postmaster.pid");
  if (existsSync(pidFile)) {
    unlinkSync(pidFile);
  }
}

function cleanRecoverableFiles(dataDir: string): void {
  for (const name of ["postmaster.pid", "postmaster.opts"]) {
    const f = join(dataDir, name);
    if (existsSync(f)) unlinkSync(f);
  }
  for (const dir of ["pg_stat_tmp", "pg_subtrans", "pg_serial"]) {
    const d = join(dataDir, dir);
    if (existsSync(d)) rmSync(d, { recursive: true, force: true });
  }
}

export async function attemptRepairDatabase(
  dataDir: string,
): Promise<{ repaired: boolean; strategy?: string }> {
  cleanRecoverableFiles(dataDir);
  try {
    const client = new PGlite(dataDir);
    await client.waitReady;
    await client.close();
    return { repaired: true, strategy: "lock-cleanup" };
  } catch { /* continue */ }

  const walDir = join(dataDir, "pg_wal");
  if (existsSync(walDir)) {
    for (const entry of readdirSync(walDir)) {
      try {
        rmSync(join(walDir, entry), { recursive: true, force: true });
      } catch { /* skip */ }
    }
  }
  cleanRecoverableFiles(dataDir);
  try {
    const client = new PGlite(dataDir);
    await client.waitReady;
    await client.close();
    return { repaired: true, strategy: "wal-reset" };
  } catch { /* continue */ }

  return { repaired: false };
}

function resetPgliteDataDir(dataDir: string): void {
  if (!existsSync(dataDir)) return;
  for (const entry of readdirSync(dataDir, { withFileTypes: true })) {
    rmSync(join(dataDir, entry.name), { recursive: true, force: true });
  }
}

export class PgliteCorruptError extends Error {
  readonly code = "DB_CORRUPT" as const;
  constructor(cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`Database is corrupt: ${detail}`);
    this.name = "PgliteCorruptError";
  }
}

function errorChainMessages(err: unknown): string {
  const messages: string[] = [];
  let current: unknown = err;
  while (current && typeof current === "object") {
    if (current instanceof Error) messages.push(current.message);
    current = (current as { cause?: unknown }).cause;
  }
  if (messages.length === 0) messages.push(String(err));
  return messages.join("\n");
}

function isPgliteCatalogCorruption(err: unknown): boolean {
  const message = errorChainMessages(err);
  return message.includes("cache lookup failed") ||
    message.includes("pg_attribute catalog is missing") ||
    message.includes(`relation "_genie_messages" does not exist`);
}

async function openPgliteClient(dataDir?: string): Promise<PGlite> {
  if (dataDir) cleanStalePgliteLock(dataDir);
  try {
    const client = new PGlite(dataDir);
    await client.waitReady;
    return client;
  } catch (firstErr) {
    // Retry once — transient WASM issues sometimes resolve on second attempt
    if (dataDir) {
      cleanStalePgliteLock(dataDir);
      try {
        const client = new PGlite(dataDir);
        await client.waitReady;
        return client;
      } catch { /* fall through to corruption check */ }
    }
    if (dataDir && existsSync(join(dataDir, "PG_VERSION"))) {
      throw new PgliteCorruptError(firstErr);
    }
    throw firstErr;
  }
}

export async function resetAndCreateDatabase(
  config: DbConfig & { driver: "pglite" },
): Promise<DatabaseConnection> {
  if (config.dataDir) resetPgliteDataDir(config.dataDir);
  return createDatabase(config);
}

export async function createDatabase(
  config: DbConfig,
): Promise<DatabaseConnection> {
  if (config.driver === "pglite") {
    const client = await openPgliteClient(config.dataDir);
    const db = drizzlePglite({ client, schema });
    const raw: RawConnection = {
      async query(sql: string, params: unknown[] = []) {
        const result = await client.query(sql, params);
        return result.rows as Record<string, unknown>[];
      },
      async execute(sql: string, params: unknown[] = []) {
        const result = await client.query(sql, params);
        return { rowCount: result.affectedRows ?? 0 };
      },
      async exec(sql: string) {
        await client.exec(sql);
      },
    };
    return {
      drizzle: db,
      raw,
      snapshot: () => client.dumpDataDir(),
      async migrate(migrationsFolder: string) {
        try {
          await repairProjectMessagePinsMigration(raw, migrationsFolder);
          await migratePglite(db, { migrationsFolder });
        } catch (err) {
          if (isPgliteCatalogCorruption(err)) {
            throw new PgliteCorruptError(err);
          }
          throw err;
        }
      },
      async checkpoint() {
        await client.exec("CHECKPOINT");
      },
      async close() {
        try {
          await client.exec("CHECKPOINT");
        } catch { /* best-effort WAL flush */ }
        await client.close();
      },
    };
  }

  const client = postgres(config.connectionString);
  const db = drizzlePostgres({ client, schema });
  const raw: RawConnection = {
    async query(sql: string, params: unknown[] = []) {
      const result = await client.unsafe(
        sql,
        params as postgres.SerializableParameter[],
      );
      return result as unknown as Record<string, unknown>[];
    },
    async execute(sql: string, params: unknown[] = []) {
      const result = await client.unsafe(
        sql,
        params as postgres.SerializableParameter[],
      );
      return { rowCount: result.count ?? 0 };
    },
    async exec(sql: string) {
      await client.unsafe(sql);
    },
  };
  return {
    drizzle: db,
    raw,
    async migrate(migrationsFolder: string) {
      await repairProjectMessagePinsMigration(raw, migrationsFolder);
      await migratePostgres(db, { migrationsFolder });
    },
    async close() {
      await client.end();
    },
  };
}
