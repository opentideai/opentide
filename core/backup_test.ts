// A backup is a directory of gzipped NDJSON, written and restored a page at a
// time. These pin that what goes in comes back out, row for row, through every
// path that reads one: restore, download, an old single-file backup, an upload.
import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  truncateSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "./db.ts";
import { Kernel } from "./registries.ts";
import { coreOnlyComposition } from "./composition.ts";
import { serializeKernelState } from "./persistence.ts";
import {
  type BackupData,
  type BackupMetadata,
  backupsToKeep,
  deleteBackup,
  importJsonBackup,
  listBackups,
  openBackup,
  type OpenedBackup,
  pruneBackups,
  readBackupMetadata,
  restoreDbTables,
  saveBackup,
  writeBackup,
  writeBackupIfChanged,
} from "./backup.ts";

const testOpts = { sanitizeResources: false, sanitizeOps: false };

async function withDb(
  fn: (kernel: Kernel, db: Database, dir: string) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "opentide-backup-"));
  const db = await Database.create({ driver: "pglite" });
  const kernel = new Kernel(db, { composition: coreOnlyComposition() });
  try {
    await fn(kernel, db, dir);
  } finally {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

async function seed(db: Database): Promise<void> {
  // Enough rows of ~2KB that the adaptive pages cover several round trips. The
  // body carries newlines and quotes: one row must still be one line.
  await db.defineSchema(
    "docs",
    "CREATE TABLE docs (id SERIAL PRIMARY KEY, body TEXT, meta JSONB)",
  );
  await db.execute(
    `INSERT INTO docs (body, meta)
     SELECT repeat(md5(g::text), 64) || E'\\n"line two"\\r\\n',
            jsonb_build_object('n', g, 'metadata', '{x}')
     FROM generate_series(1, 3000) g`,
  );
  // No primary key: paged on ctid.
  await db.defineSchema("loose", "CREATE TABLE loose (label TEXT, n INT)");
  await db.execute(
    `INSERT INTO loose SELECT 'l' || g, g FROM generate_series(1, 40) g`,
  );
  // Composite key, the text half compared as text, not as a number.
  await db.defineSchema(
    "pairs",
    "CREATE TABLE pairs (a TEXT, b INT, v TEXT, PRIMARY KEY (a, b))",
  );
  await db.execute(
    `INSERT INTO pairs SELECT (g % 7)::text || 'k', g, 'v' || g FROM generate_series(1, 500) g`,
  );
  await db.defineSchema("empty", "CREATE TABLE empty (id SERIAL PRIMARY KEY)");
  // What a real project's backup failed to restore on: a generated column, an
  // identity key, and JSON whose value is a bare string.
  await db.defineSchema(
    "gen",
    `CREATE TABLE gen (
       id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
       body TEXT,
       tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple', body)) STORED,
       prefs JSONB,
       raw JSON)`,
  );
  await db.execute(
    `INSERT INTO gen (body, prefs, raw) VALUES
       ('hello world', '"just a string"', '[1,2]'),
       ('two', '{"a":[1,"x"]}', '"s"'),
       ('three', '[]', '3')`,
  );
}

const TABLES = ["docs", "loose", "pairs", "empty", "gen"];
const ROWS = 3000 + 40 + 500 + 3;

const sorted = (rows: unknown[]) => rows.map((r) => JSON.stringify(r)).sort();

async function tableRows(db: Database, table: string) {
  return sorted(
    JSON.parse(JSON.stringify(await db.query(`SELECT * FROM "${table}"`))),
  );
}

async function backupRows(backup: OpenedBackup, table: string) {
  const out: unknown[] = [];
  for await (const batch of backup.batches(table)) out.push(...batch);
  return sorted(out);
}

async function legacyOf(kernel: Kernel, db: Database): Promise<BackupData> {
  const tables = [];
  for (const schema of await db.listSchemas()) {
    tables.push({
      tableName: schema.tableName,
      sql: schema.sql,
      rows: await db.query(`SELECT * FROM "${schema.tableName}"`),
    });
  }
  return {
    metadata: {
      id: "backup_legacy",
      createdAt: "2026-11-14T16:11:00.000Z",
      trigger: "periodic",
      tableCount: tables.length,
      rowCount: tables.reduce((n, t) => n + t.rows.length, 0),
      branchSnapshotCount: 0,
      includesProjectState: true,
    },
    kernelState: serializeKernelState(kernel),
    tables,
  };
}

Deno.test({
  ...testOpts,
  name: "writeBackup holds every row once, and restores into an empty database",
  fn: async () => {
    await withDb(async (kernel, db, dir) => {
      await seed(db);
      const meta = await writeBackup(kernel, db, "periodic", dir, 10);
      assertEquals(meta.tableCount, TABLES.length);
      assertEquals(meta.rowCount, ROWS);
      assertEquals(listBackups(dir), [meta]);
      assertEquals(readdirSync(dir), [meta.id], "nothing left but the backup");

      const backup = await openBackup(dir, meta.id);
      assert(backup);
      assertEquals(backup.metadata, meta);
      assertEquals(await backup.verify(), []);
      assertEquals(
        backup.tables.map((t) => t.tableName).sort(),
        [...TABLES].sort(),
      );
      for (const table of TABLES) {
        assertEquals(
          await backupRows(backup, table),
          await tableRows(db, table),
          table,
        );
      }

      const fresh = await Database.create({ driver: "pglite" });
      try {
        const result = await restoreDbTables(backup, fresh);
        assertEquals(result, {
          restored: TABLES.length,
          restoredRows: ROWS,
          errors: [],
        });
        for (const table of TABLES) {
          assertEquals(
            await tableRows(fresh, table),
            await tableRows(db, table),
            table,
          );
        }
        // The sequences carry on from the restored rows rather than from 1.
        await fresh.execute(`INSERT INTO docs (body) VALUES ('after')`);
        await fresh.execute(`INSERT INTO gen (body) VALUES ('after')`);
        await fresh.execute(`INSERT INTO empty DEFAULT VALUES`);
      } finally {
        await fresh.close();
      }
    });
  },
});

Deno.test({
  ...testOpts,
  name: "restore does not replay data migrations from a table's history",
  fn: async () => {
    await withDb(async (kernel, db, dir) => {
      // The child's history deletes rows by a column the parent only gains in
      // its own later ALTER. Tables are altered one after another, not in the
      // order the statements first ran, so replaying the DELETE fails — and a
      // failed statement used to cost the table every one of its rows. The rows
      // in a backup are already past every data migration anyway.
      await saveBackup(
        {
          metadata: meta("backup_dml", "2026-01-01T00:00:00.000Z"),
          kernelState: serializeKernelState(kernel),
          tables: [{
            tableName: "a_child",
            sql: "CREATE TABLE a_child (id INT PRIMARY KEY, pid INT);\n\n" +
              "DELETE FROM a_child c USING z_parent p WHERE p.id = c.pid AND p.flag = false",
            rows: [{ id: 1, pid: 1 }, { id: 2, pid: 2 }],
          }, {
            tableName: "z_parent",
            sql: "CREATE TABLE z_parent (id INT PRIMARY KEY);\n\n" +
              "ALTER TABLE z_parent ADD COLUMN flag BOOLEAN NOT NULL DEFAULT true",
            rows: [{ id: 1, flag: true }, { id: 2, flag: false }],
          }],
        },
        dir,
        10,
      );
      const backup = await openBackup(dir, "backup_dml");
      assert(backup);
      const result = await restoreDbTables(backup, db);
      assertEquals(result, { restored: 2, restoredRows: 4, errors: [] });
      assertEquals(
        await db.query(`SELECT id FROM a_child ORDER BY id`),
        [{ id: 1 }, { id: 2 }],
      );
    });
  },
});

Deno.test({
  ...testOpts,
  name: "an old single-file backup lists, then converts when it is opened",
  fn: async () => {
    await withDb(async (kernel, db, dir) => {
      await seed(db);
      const legacy = await legacyOf(kernel, db);
      writeFileSync(join(dir, "backup_legacy.json"), JSON.stringify(legacy));

      assertEquals(listBackups(dir).map((b) => b.id), ["backup_legacy"]);
      const backup = await openBackup(dir, "backup_legacy");
      assert(backup, "the old file converts");
      assertEquals(readdirSync(dir), ["backup_legacy"], "the file is replaced");
      assertEquals(backup.metadata.rowCount, ROWS);
      assertEquals(backup.metadata.createdAt, legacy.metadata.createdAt);
      assertEquals(backup.kernelState, legacy.kernelState);
      assertEquals(await backup.verify(), []);
      for (const table of TABLES) {
        assertEquals(
          await backupRows(backup, table),
          await tableRows(db, table),
          table,
        );
      }
      assertEquals(listBackups(dir).length, 1);
    });
  },
});

Deno.test({
  ...testOpts,
  name: "a torn old backup does not open, and leaves nothing behind",
  fn: async () => {
    await withDb(async (kernel, db, dir) => {
      await seed(db);
      const text = JSON.stringify(await legacyOf(kernel, db));
      const path = join(dir, "backup_legacy.json");
      writeFileSync(path, text.slice(0, Math.floor(text.length * 0.6)));
      assertEquals(await openBackup(dir, "backup_legacy"), null);
      assertEquals(readdirSync(dir), ["backup_legacy.json"]);
    });
  },
});

Deno.test({
  ...testOpts,
  name: "verify finds a table file that was cut short",
  fn: async () => {
    await withDb(async (kernel, db, dir) => {
      await seed(db);
      const meta = await writeBackup(kernel, db, "periodic", dir, 10);
      const docs = join(dir, meta.id, "tables", "0.ndjson.gz");
      truncateSync(docs, Math.floor(statSync(docs).size / 2));
      const backup = await openBackup(dir, meta.id);
      assert(backup, "the manifest is intact");
      const errors = await backup.verify();
      assertEquals(errors.length, 1);
      assert(errors[0]!.startsWith("docs: "), errors[0]);
    });
  },
});

Deno.test({
  ...testOpts,
  name: "a download re-imports as the same backup, pretty-printed or not",
  fn: async () => {
    await withDb(async (kernel, db, dir) => {
      await seed(db);
      const meta = await writeBackup(kernel, db, "manual", dir, 10);
      const backup = await openBackup(dir, meta.id);
      assert(backup);
      let json = "";
      for await (const piece of backup.asJson()) json += piece;

      for (const text of [json, JSON.stringify(JSON.parse(json), null, 2)]) {
        const elsewhere = mkdtempSync(join(tmpdir(), "opentide-backup-in-"));
        try {
          const chunks = async function* () {
            // Small, uneven chunks: values split across them.
            for (let i = 0; i < text.length; i += 4093) {
              yield text.slice(i, i + 4093);
            }
          };
          const imported = await importJsonBackup(chunks(), elsewhere, {
            requireProjectState: true,
          });
          assertEquals(imported, meta);
          const again = await openBackup(elsewhere, meta.id);
          assert(again);
          for (const table of TABLES) {
            assertEquals(
              await backupRows(again, table),
              await tableRows(db, table),
              table,
            );
          }
        } finally {
          rmSync(elsewhere, { recursive: true, force: true });
        }
      }
    });
  },
});

Deno.test({
  ...testOpts,
  name: "an upload that is not a backup is refused and leaves nothing",
  fn: async () => {
    const dir = mkdtempSync(join(tmpdir(), "opentide-backup-bad-"));
    try {
      for (
        const text of [
          `{"metadata":{"id":"backup_x"},"tables":[]}`, // no project state
          `{"kernelState":{},"tables":[]}`, // no id
          `{"metadata":{"id":"../../x"},"kernelState":{},"tables":[]}`,
          `{"metadata":{"id":"backup_x"},"kernelState":{},"tables":[{"rows":[]}]}`,
          `[1,2,3]`,
        ]
      ) {
        await assertRejects(() =>
          importJsonBackup(
            (async function* () {
              yield text;
            })(),
            dir,
            { requireProjectState: true },
          )
        );
      }
      assertEquals(readdirSync(dir), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
});

function meta(id: string, createdAt: string): BackupMetadata {
  return { id, createdAt, trigger: "periodic", tableCount: 0, rowCount: 0 };
}

const at = (ms: number) => new Date(ms).toISOString();
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

Deno.test("retention keeps the 2 newest, one a day for a week, one a week for 4 more", () => {
  // Wednesday 18 November 2026: a busy morning, a backup a minute, then two a
  // day (20:00 and 08:00) for fifty days before it.
  const morning = Array.from(
    { length: 9 },
    (_, i) => meta(`m${i}`, at(Date.UTC(2026, 10, 18, 10, 59 - i))),
  );
  const earlier = Array.from({ length: 50 }, (_, i) => i + 1).flatMap((d) => [
    meta(`d${d}a`, at(Date.UTC(2026, 10, 18 - d, 20))),
    meta(`d${d}b`, at(Date.UTC(2026, 10, 18 - d, 8))),
  ]);
  // The morning keeps two. Then the newest of 17 to 12 November. Then, from 11
  // November back to 15 October, the newest of each Monday-to-Sunday week: 11
  // and 8 November, 1 November, 25 and 18 October.
  const policy = [
    "m0",
    "m1",
    "d1a",
    "d2a",
    "d3a",
    "d4a",
    "d5a",
    "d6a",
    "d7a",
    "d10a",
    "d17a",
    "d24a",
    "d31a",
  ];
  assertEquals(
    backupsToKeep([...morning, ...earlier], 13).map((b) => b.id),
    policy,
  );
  assertEquals(
    backupsToKeep([...morning, ...earlier], 50).map((b) => b.id),
    policy,
    "nothing older, however much room",
  );
  assertEquals(
    backupsToKeep([...morning, ...earlier], 5).map((b) => b.id),
    policy.slice(0, 5),
  );
  // Nothing tops the list up from the morning when the days run out.
  assertEquals(
    backupsToKeep([...morning, earlier[0]!], 13).map((b) => b.id),
    ["m0", "m1", "d1a"],
  );
  assertEquals(backupsToKeep(morning, 0), []);
});

Deno.test("retention still spans a month after two months of pruning", () => {
  // A backup every working hour for sixty days, pruned after each one. Buckets
  // measured from the newest backup instead of the calendar re-elect their
  // newest member every day, and the weekly copies never get old.
  let kept: BackupMetadata[] = [];
  const start = Date.UTC(2026, 8, 1);
  for (let day = 0; day < 60; day++) {
    for (let hour = 9; hour < 18; hour++) {
      const t = start + day * DAY + hour * HOUR;
      kept = backupsToKeep([meta(`b${t}`, at(t)), ...kept], 13);
    }
  }
  const newest = Date.parse(kept[0]!.createdAt);
  const oldest = Date.parse(kept.at(-1)!.createdAt);
  assert(kept.length <= 13);
  assert(
    newest - oldest >= 28 * DAY,
    `the oldest kept is ${(newest - oldest) / DAY} days old`,
  );
  const days = kept.slice(2).map((b) => b.createdAt.slice(0, 10));
  assertEquals(new Set(days).size, days.length, "one a day at most");
});

Deno.test({
  ...testOpts,
  name: "an unchanged project is not backed up again, a changed one is",
  fn: async () => {
    await withDb(async (kernel, db, dir) => {
      await seed(db);
      // Not one of the project's tables: OpenTide's own live beside them and
      // change on every chat turn, and a backup leaves them out.
      await db.execute(`CREATE TABLE scratch (n INT)`);
      const first = await writeBackupIfChanged(kernel, db, "periodic", dir, 20);
      assert(first?.fingerprint, "the first backup is written");
      const again = () => writeBackupIfChanged(kernel, db, "periodic", dir, 20);
      assertEquals(await again(), null);
      await db.query(`SELECT count(*) FROM docs`);
      await db.checkpoint();
      assertEquals(await again(), null, "reads and checkpoints change nothing");
      await db.execute(`INSERT INTO scratch VALUES (1)`);
      assertEquals(
        await again(),
        null,
        "a table outside the backup changes nothing",
      );

      const changes = [
        `INSERT INTO loose VALUES ('new', 41)`,
        `UPDATE pairs SET v = 'changed' WHERE b = 3`,
        `DELETE FROM docs WHERE id = 10`,
        `TRUNCATE empty`,
      ];
      for (const sql of changes) {
        await db.execute(sql);
        assert(await again(), `${sql} is a change`);
        assertEquals(await again(), null, `and only once: ${sql}`);
      }
      // Rewrites nothing: no row, count or file node moves.
      await db.execute(`ALTER TABLE loose ADD COLUMN extra TEXT`);
      assert(await again(), "a new column is a change");

      // Asked for explicitly, a backup is written changed or not.
      assert(await writeBackup(kernel, db, "manual", dir, 20));
    });
  },
});

Deno.test({
  ...testOpts,
  name: "pruning removes old backups of both formats and stale temporaries",
  fn: async () => {
    await withDb(async (kernel, db, dir) => {
      await seed(db);
      const legacy = await legacyOf(kernel, db);
      // Older than any backup the policy keeps.
      legacy.metadata.createdAt = "2020-01-01T00:00:00.000Z";
      writeFileSync(join(dir, "backup_legacy.json"), JSON.stringify(legacy));
      const ids = [];
      for (let i = 0; i < 3; i++) {
        ids.push((await writeBackup(kernel, db, "periodic", dir, 10)).id);
      }
      mkdirSync(join(dir, "backup_stale.tmp"));
      const day = 25 * 60 * 60;
      const old = Date.now() / 1000 - day;
      utimesSync(join(dir, "backup_stale.tmp"), old, old);
      mkdirSync(join(dir, "backup_writing.tmp"));

      pruneBackups(dir, 13);
      // Three from the same minute: the two newest stay.
      const newest = ids.slice(1).reverse();
      assertEquals(listBackups(dir).map((b) => b.id), newest);
      assertEquals(
        readdirSync(dir).sort(),
        [...newest, "backup_writing.tmp"].sort(),
        "the old file and the stale temporary are gone, the live one is not",
      );
    });
  },
});

Deno.test({
  ...testOpts,
  name: "nothing outside the backups directory can be named",
  fn: async () => {
    const root = mkdtempSync(join(tmpdir(), "opentide-backup-root-"));
    try {
      const dir = join(root, "backups");
      mkdirSync(join(root, "victim"), { recursive: true });
      writeFileSync(join(root, "victim.json"), "{}");
      assertEquals(deleteBackup(dir, "../victim"), false);
      assertEquals(await openBackup(dir, "../victim"), null);
      assert(existsSync(join(root, "victim")));
      assert(existsSync(join(root, "victim.json")));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
});

Deno.test({
  ...testOpts,
  name: "saveBackup writes a fixture as a directory that restores",
  fn: async () => {
    await withDb(async (kernel, _db, dir) => {
      const saved = await saveBackup(
        {
          metadata: meta("backup_fixture", "2026-01-01T00:00:00.000Z"),
          kernelState: serializeKernelState(kernel),
          tables: [{
            tableName: "w",
            sql: "CREATE TABLE w (id INT PRIMARY KEY, name TEXT)",
            rows: [{ id: 1, name: "one" }, { id: 2, name: "two\nlines" }],
          }],
        },
        dir,
        10,
      );
      assertEquals(saved.rowCount, 2);
      assertEquals(saved.tableCount, 1);
      const manifest = JSON.parse(
        readFileSync(join(dir, "backup_fixture", "manifest.json"), "utf-8"),
      );
      assertEquals(manifest.tables[0].rowCount, 2);
      const backup = await openBackup(dir, "backup_fixture");
      assert(backup);
      assertEquals(
        await backupRows(backup, "w"),
        sorted([
          { id: 1, name: "one" },
          { id: 2, name: "two\nlines" },
        ]),
      );
    });
  },
});

Deno.test({
  ...testOpts,
  name: "readBackupMetadata reads a large file's metadata from its ends",
  fn: () => {
    const dir = mkdtempSync(join(tmpdir(), "opentide-backup-meta-"));
    try {
      const metadata = {
        id: "backup_big",
        createdAt: "2026-11-18T00:00:00.000Z",
        trigger: "periodic" as const,
        tableCount: 1,
        rowCount: 1,
        branchSnapshotCount: 0,
        includesProjectState: true,
      };
      // Past the whole-file fallback, and with a nested "metadata" key in a row
      // that must not be mistaken for the real one.
      const filler = "x".repeat(9 * 1024 * 1024);
      const path = join(dir, "backup_big.json");
      writeFileSync(
        path,
        `{"kernelState":{},"tables":[{"tableName":"t","sql":"","rows":[` +
          `{"metadata":{"id":"nope"},"body":"${filler}"}]}],` +
          `"metadata":${JSON.stringify(metadata)}}`,
      );
      assertEquals(readBackupMetadata(path), metadata);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
});
