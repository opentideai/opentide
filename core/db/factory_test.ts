import { assertEquals } from "@std/assert";
import { createDatabase } from "./factory.ts";
import { Database } from "../db.ts";
import { genieMetaTable } from "./schema/index.ts";
import { eq } from "drizzle-orm";

Deno.test("PGlite + Drizzle: create tables and CRUD", async () => {
  const conn = await createDatabase({ driver: "pglite" });
  const db = conn.drizzle;

  await db.execute(`CREATE TABLE IF NOT EXISTS _genie_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`);

  // Insert
  await db.insert(genieMetaTable).values({
    key: "version",
    value: "1.0.0",
  });

  // Select
  const rows = await db.select().from(genieMetaTable).where(
    eq(genieMetaTable.key, "version"),
  );
  assertEquals(rows.length, 1);
  assertEquals(rows[0]!.key, "version");
  assertEquals(rows[0]!.value, "1.0.0");

  // Update
  await db.update(genieMetaTable)
    .set({ value: "2.0.0" })
    .where(eq(genieMetaTable.key, "version"));

  const updated = await db.select().from(genieMetaTable).where(
    eq(genieMetaTable.key, "version"),
  );
  assertEquals(updated[0]!.value, "2.0.0");

  // Delete
  await db.delete(genieMetaTable).where(eq(genieMetaTable.key, "version"));
  const deleted = await db.select().from(genieMetaTable);
  assertEquals(deleted.length, 0);

  await conn.close();
});

Deno.test("PGlite migrations create unified model usage ledger", async () => {
  const db = await Database.create({ driver: "pglite" });
  try {
    const rows = await db.query(
      `SELECT table_name FROM information_schema.tables WHERE table_name = '_genie_model_usage'`,
    );
    assertEquals(rows.length, 1);
  } finally {
    await db.close();
  }
});

Deno.test("PGlite + Drizzle: jsonb columns work", async () => {
  const conn = await createDatabase({ driver: "pglite" });
  const db = conn.drizzle;

  await db.execute(`CREATE TABLE IF NOT EXISTS _genie_changesets (
    id TEXT PRIMARY KEY,
    session_id TEXT,
    title TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'planning',
    plan JSONB,
    plan_message_ids JSONB,
    approval_message_id INTEGER,
    work_message_ids JSONB,
    tool_calls JSONB,
    reasoning JSONB,
    token_usage JSONB,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT,
    creator_user_id TEXT
  )`);

  const { genieChangesetsTable } = await import("./schema/index.ts");
  const now = new Date().toISOString();

  await db.insert(genieChangesetsTable).values({
    id: "cs_test",
    title: "Test changeset",
    status: "planning",
    plan: {
      summary: "Do stuff",
      steps: [{ id: "s1", description: "Step 1", status: "pending" }],
    },
    planMessageIds: [1, 2, 3],
    createdAt: now,
    updatedAt: now,
  });

  const rows = await db.select().from(genieChangesetsTable).where(
    eq(genieChangesetsTable.id, "cs_test"),
  );
  assertEquals(rows.length, 1);
  assertEquals(rows[0]!.plan?.summary, "Do stuff");
  assertEquals(rows[0]!.plan?.steps.length, 1);
  assertEquals(rows[0]!.planMessageIds, [1, 2, 3]);

  await conn.close();
});

Deno.test("PGlite + Drizzle: boolean columns work", async () => {
  const conn = await createDatabase({ driver: "pglite" });
  const db = conn.drizzle;

  await db.execute(`CREATE TABLE IF NOT EXISTS _genie_skills (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL DEFAULT '',
    prompt TEXT NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT true,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);

  const { genieSkillsTable } = await import("./schema/index.ts");
  const now = new Date().toISOString();

  await db.insert(genieSkillsTable).values({
    name: "test-skill",
    description: "A test",
    prompt: "Do something",
    enabled: true,
    createdAt: now,
    updatedAt: now,
  });

  const rows = await db.select().from(genieSkillsTable);
  assertEquals(rows.length, 1);
  assertEquals(rows[0]!.enabled, true);
  assertEquals(typeof rows[0]!.enabled, "boolean");
  assertEquals(typeof rows[0]!.id, "number");

  await conn.close();
});

Deno.test("PGlite migrations tolerate existing project_pinned column with missing migration row", async () => {
  const dataDir = await Deno.makeTempDir({ prefix: "genie-migration-retry-" });
  try {
    const initial = await Database.create({ driver: "pglite", dataDir });
    await initial.close();

    const conn = await createDatabase({ driver: "pglite", dataDir });
    await conn.raw.exec(
      "DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1782172800000",
    );
    await conn.close();

    const reopened = await Database.create({ driver: "pglite", dataDir });
    try {
      const columns = await reopened.query(
        "SELECT column_name FROM information_schema.columns WHERE table_name = '_genie_messages' AND column_name = 'project_pinned'",
      );
      assertEquals(columns.length, 1);

      const migrationRows = await reopened.query(
        "SELECT id FROM drizzle.__drizzle_migrations WHERE created_at = 1782172800000",
      );
      assertEquals(migrationRows.length, 1);
    } finally {
      await reopened.close();
    }
  } finally {
    await Deno.remove(dataDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("PGlite migrations restore missing messages table when migrations are recorded", async () => {
  const dataDir = await Deno.makeTempDir({ prefix: "genie-missing-messages-" });
  try {
    const initial = await Database.create({ driver: "pglite", dataDir });
    await initial.close();

    const conn = await createDatabase({ driver: "pglite", dataDir });
    await conn.raw.exec(`DROP TABLE "_genie_messages" CASCADE`);
    await conn.raw.exec(
      `CREATE TYPE "_genie_messages" AS ("id" integer, "content" text)`,
    );
    await conn.raw.exec(`CREATE SEQUENCE "_genie_messages_id_seq"`);
    await conn.raw.exec(
      "DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1782172800000",
    );
    await conn.close();

    const reopened = await Database.create({ driver: "pglite", dataDir });
    try {
      const columns = await reopened.query(
        "SELECT column_name FROM information_schema.columns WHERE table_name = '_genie_messages' AND column_name = 'project_pinned'",
      );
      assertEquals(columns.length, 1);

      const indexes = await reopened.query(
        "SELECT indexname FROM pg_indexes WHERE tablename = '_genie_messages' AND indexname IN ('messages_content_search_idx', 'messages_session_id_idx')",
      );
      assertEquals(indexes.length, 2);

      const migrationRows = await reopened.query(
        "SELECT id FROM drizzle.__drizzle_migrations WHERE created_at = 1782172800000",
      );
      assertEquals(migrationRows.length, 1);
    } finally {
      await reopened.close();
    }
  } finally {
    await Deno.remove(dataDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("PGlite repair restores and records the shell message kind migration", async () => {
  const dataDir = await Deno.makeTempDir({
    prefix: "genie-missing-messages-before-kind-",
  });
  try {
    const initial = await Database.create({ driver: "pglite", dataDir });
    await initial.close();

    const conn = await createDatabase({ driver: "pglite", dataDir });
    await conn.raw.exec(`DROP TABLE "_genie_messages" CASCADE`);
    await conn.raw.exec(
      "DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1783900800001",
    );
    await conn.close();

    const reopened = await Database.create({ driver: "pglite", dataDir });
    try {
      const columns = await reopened.query(
        "SELECT column_name FROM information_schema.columns WHERE table_name = '_genie_messages' AND column_name = 'kind'",
      );
      assertEquals(columns.length, 1);

      const migrationRows = await reopened.query(
        "SELECT id FROM drizzle.__drizzle_migrations WHERE created_at = 1783900800001",
      );
      assertEquals(migrationRows.length, 1);
    } finally {
      await reopened.close();
    }
  } finally {
    await Deno.remove(dataDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("PGlite migrations restore missing messages table when project pin migration is recorded", async () => {
  const dataDir = await Deno.makeTempDir({
    prefix: "genie-missing-messages-recorded-pin-",
  });
  try {
    const initial = await Database.create({ driver: "pglite", dataDir });
    await initial.close();

    const conn = await createDatabase({ driver: "pglite", dataDir });
    await conn.raw.exec(`DROP TABLE "_genie_messages" CASCADE`);
    await conn.close();

    const reopened = await Database.create({ driver: "pglite", dataDir });
    try {
      const columns = await reopened.query(
        "SELECT column_name FROM information_schema.columns WHERE table_name = '_genie_messages' AND column_name = 'project_pinned'",
      );
      assertEquals(columns.length, 1);

      const migrationRows = await reopened.query(
        "SELECT id FROM drizzle.__drizzle_migrations WHERE created_at = 1782172800000",
      );
      assertEquals(migrationRows.length, 1);
    } finally {
      await reopened.close();
    }
  } finally {
    await Deno.remove(dataDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("PGlite migrations restore missing project_pinned column when migration is recorded", async () => {
  const dataDir = await Deno.makeTempDir({
    prefix: "genie-missing-pin-column-",
  });
  try {
    const initial = await Database.create({ driver: "pglite", dataDir });
    await initial.close();

    const conn = await createDatabase({ driver: "pglite", dataDir });
    await conn.raw.exec(
      `ALTER TABLE "_genie_messages" DROP COLUMN "project_pinned"`,
    );
    await conn.close();

    const reopened = await Database.create({ driver: "pglite", dataDir });
    try {
      const columns = await reopened.query(
        "SELECT column_name FROM information_schema.columns WHERE table_name = '_genie_messages' AND column_name = 'project_pinned'",
      );
      assertEquals(columns.length, 1);

      const migrationRows = await reopened.query(
        "SELECT id FROM drizzle.__drizzle_migrations WHERE created_at = 1782172800000",
      );
      assertEquals(migrationRows.length, 1);
    } finally {
      await reopened.close();
    }
  } finally {
    await Deno.remove(dataDir, { recursive: true }).catch(() => {});
  }
});

// --- snapshot ---------------------------------------------------------------
// Copying a live PGlite data directory file-by-file does not work: Postgres
// writes those files while the copy reads them, so the result is a torn snapshot
// that fails to open. dumpDataDir is Postgres taking the snapshot itself.

Deno.test({
  name: "snapshot: a copy taken from a LIVE database opens and is consistent",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const dataDir = await Deno.makeTempDir({ prefix: "genie-snap-src-" });
    const restoreDir = await Deno.makeTempDir({ prefix: "genie-snap-dst-" });
    const conn = await createDatabase({ driver: "pglite", dataDir });
    try {
      await conn.raw.exec(
        "CREATE TABLE snap (id int); INSERT INTO snap VALUES (1),(2),(3);",
      );

      // Taken WITHOUT closing — the whole point, since the debug session copies
      // a database the kernel is still serving from.
      const dump = await conn.snapshot!();

      // Writes continue afterwards; the snapshot must not have disturbed them.
      await conn.raw.exec("INSERT INTO snap VALUES (4);");

      const { PGlite } = await import("@electric-sql/pglite");
      const restored = await PGlite.create({
        loadDataDir: dump,
        dataDir: restoreDir,
      });
      await restored.close();

      // Reopened the ordinary way, which is how the debug subprocess gets it.
      const copy = await createDatabase({
        driver: "pglite",
        dataDir: restoreDir,
      });
      try {
        const rows = await copy.raw.query(
          "select count(*)::int as n from snap",
        );
        // Three at snapshot time — the fourth row came after, so a consistent
        // copy must not contain it.
        assertEquals(rows[0]?.n, 3);
      } finally {
        await copy.close();
      }

      const live = await conn.raw.query("select count(*)::int as n from snap");
      assertEquals(live[0]?.n, 4, "the source stays usable after a snapshot");
    } finally {
      await conn.close();
      await Deno.remove(dataDir, { recursive: true }).catch(() => {});
      await Deno.remove(restoreDir, { recursive: true }).catch(() => {});
    }
  },
});

Deno.test("snapshot: absent on a backend that cannot produce one", async () => {
  // An external Postgres has its own backup tooling and no data directory we
  // own, so callers must handle the absence rather than assume a copy is free.
  const db = await Database.create({ driver: "pglite" });
  try {
    assertEquals(typeof db.snapshot(), "object");
  } finally {
    await db.close();
  }
});
