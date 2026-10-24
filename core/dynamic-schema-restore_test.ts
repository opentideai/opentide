import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Database, DynamicSchemaRestoreError, referencedTables } from "./db.ts";
import type { ColumnDef, MigrationEntry, SchemaEntry } from "./types.ts";
import { TEST_TMP_DIR } from "./test-home_test.ts";

const emptyColumns: ColumnDef[] = [];

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

function schemaEntry(tableName: string, sql: string): SchemaEntry {
  return {
    tableName,
    columns: emptyColumns,
    sql,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function migration(
  tableName: string,
  version: number,
  sql: string,
  appliedAt: string,
): MigrationEntry {
  return {
    id: version,
    tableName,
    version,
    sql,
    reverseSql: null,
    reversible: false,
    columnsBefore: emptyColumns,
    columnsAfter: emptyColumns,
    appliedAt,
    rolledBackAt: null,
    turnId: null,
  };
}

Deno.test("referencedTables extracts direct foreign-key references", () => {
  assertEquals(
    referencedTables(`
      CREATE TABLE agent_events (
        document_id INTEGER REFERENCES documents(id),
        public_document_id INTEGER REFERENCES public.documents(id),
        quoted_id INTEGER REFERENCES "versions"(id),
        public_quoted_id INTEGER REFERENCES "public"."versions"(id),
        ignored_id INTEGER REFERENCES _genie_documents(id),
        note TEXT DEFAULT 'REFERENCES ignored(id)'
      );
      -- REFERENCES comments(id)
      /* REFERENCES block_comments(id) */
    `),
    ["documents", "versions"],
  );
});

Deno.test("referencedTables normalizes PostgreSQL identifiers", () => {
  assertEquals(
    referencedTables(`
      CREATE TABLE refs (
        "references" INTEGER,
        unquoted_id INTEGER REFERENCES Documents(id),
        public_unquoted_id INTEGER REFERENCES public.Documents(id),
        quoted_id INTEGER REFERENCES "Documents"(id),
        public_quoted_id INTEGER REFERENCES "public"."Documents"(id),
        ignored_private_id INTEGER REFERENCES private.Documents(id),
        ignored_quoted_schema_id INTEGER REFERENCES "Public".Documents(id),
        ignored_internal_id INTEGER REFERENCES _GENIE_Documents(id)
      )
    `),
    ["documents", "Documents"],
  );
});

Deno.test("dynamic schema restore creates base tables before cross-table ALTER migrations", async () => {
  const projectDir = await Deno.makeTempDir({
    dir: TEST_TMP_DIR,
    prefix: "genie-dynamic-schema-restore-",
  });
  const dataDir = join(projectDir, "data");
  const schemaDir = join(projectDir, ".opentide", "state", "schemas");
  const migrationsDir = join(schemaDir, "migrations");
  mkdirSync(migrationsDir, { recursive: true });

  const documentsV1 =
    "CREATE TABLE documents (id SERIAL PRIMARY KEY, title TEXT NOT NULL)";
  const documentsV2 =
    "ALTER TABLE documents ADD COLUMN history_version_id INTEGER REFERENCES versions(id) ON DELETE SET NULL";
  const versionsV1 = `
    CREATE TABLE versions (
      id SERIAL PRIMARY KEY,
      document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      label TEXT NOT NULL
    )
  `;
  const agentEventsV1 = `
    CREATE TABLE agent_events (
      id SERIAL PRIMARY KEY,
      document_id INTEGER REFERENCES documents(id),
      version_id INTEGER REFERENCES versions(id),
      event_type TEXT NOT NULL
    )
  `;

  writeJson(
    join(schemaDir, "documents.json"),
    schemaEntry("documents", `${documentsV1};\n\n${documentsV2}`),
  );
  writeJson(
    join(schemaDir, "versions.json"),
    schemaEntry("versions", versionsV1),
  );
  writeJson(
    join(schemaDir, "agent_events.json"),
    schemaEntry("agent_events", agentEventsV1),
  );

  writeJson(join(migrationsDir, "documents.json"), [
    migration("documents", 1, documentsV1, "2026-01-01T00:00:00.000Z"),
    migration("documents", 2, documentsV2, "2026-01-01T00:00:03.000Z"),
  ]);
  writeJson(join(migrationsDir, "versions.json"), [
    migration("versions", 1, versionsV1, "2026-01-01T00:00:01.000Z"),
  ]);
  writeJson(join(migrationsDir, "agent_events.json"), [
    migration("agent_events", 1, agentEventsV1, "2026-01-01T00:00:02.000Z"),
  ]);

  let db: Database | undefined;
  try {
    db = await Database.create({ driver: "pglite", dataDir, schemaDir });
    const tables = await db.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN ('agent_events', 'documents', 'versions')
      ORDER BY table_name
    `);

    assertEquals(
      tables.map((row) => row.table_name),
      ["agent_events", "documents", "versions"],
    );
  } finally {
    await db?.close();
    rmSync(projectDir, { recursive: true, force: true });
  }
});

Deno.test("dynamic schema restore rolls back base creates when post-base migration fails with context", async () => {
  const projectDir = await Deno.makeTempDir({
    dir: TEST_TMP_DIR,
    prefix: "genie-dynamic-schema-restore-rollback-",
  });
  const dataDir = join(projectDir, "data");
  const schemaDir = join(projectDir, ".opentide", "state", "schemas");
  const migrationsDir = join(schemaDir, "migrations");
  mkdirSync(migrationsDir, { recursive: true });

  const alphaV1 = "CREATE TABLE alpha (id SERIAL PRIMARY KEY)";
  const betaV1 = "CREATE TABLE beta (id SERIAL PRIMARY KEY)";
  const betaV2 =
    "ALTER TABLE beta ADD COLUMN missing_id INTEGER REFERENCES missing_table(id)";

  writeJson(join(schemaDir, "alpha.json"), schemaEntry("alpha", alphaV1));
  writeJson(
    join(schemaDir, "beta.json"),
    schemaEntry("beta", `${betaV1};\n\n${betaV2}`),
  );
  writeJson(join(migrationsDir, "alpha.json"), [
    migration("alpha", 1, alphaV1, "2026-01-01T00:00:00.000Z"),
  ]);
  writeJson(join(migrationsDir, "beta.json"), [
    migration("beta", 1, betaV1, "2026-01-01T00:00:01.000Z"),
    migration("beta", 2, betaV2, "2026-01-01T00:00:02.000Z"),
  ]);

  let reopened: Database | undefined;
  try {
    const err = await assertRejects(
      () => Database.create({ driver: "pglite", dataDir, schemaDir }),
      DynamicSchemaRestoreError,
      "missing_table",
    );

    assertEquals(err.tableName, "beta");
    assertEquals(err.migrationVersion, 2);
    assertStringIncludes(err.sqlPreview, "REFERENCES missing_table");
    assertStringIncludes(err.originalDbMessage, "missing_table");
    assert(err.cause instanceof Error);

    reopened = await Database.create({ driver: "pglite", dataDir });
    const tables = await reopened.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN ('alpha', 'beta')
      ORDER BY table_name
    `);
    assertEquals(tables, []);
  } finally {
    await reopened?.close();
    rmSync(projectDir, { recursive: true, force: true });
  }
});

Deno.test("dynamic schema restore uses single CREATE TABLE fallback without migration file", async () => {
  const projectDir = await Deno.makeTempDir({
    dir: TEST_TMP_DIR,
    prefix: "genie-dynamic-schema-fallback-",
  });
  const dataDir = join(projectDir, "data");
  const schemaDir = join(projectDir, ".opentide", "state", "schemas");
  mkdirSync(schemaDir, { recursive: true });

  writeJson(
    join(schemaDir, "notes.json"),
    schemaEntry(
      "notes",
      "CREATE TABLE notes (id SERIAL PRIMARY KEY, title TEXT NOT NULL)",
    ),
  );

  let db: Database | undefined;
  try {
    db = await Database.create({ driver: "pglite", dataDir, schemaDir });
    await db.execute("INSERT INTO notes (title) VALUES ($1)", ["restored"]);
    const rows = await db.query("SELECT title FROM notes");

    assertEquals(rows, [{ title: "restored" }]);
  } finally {
    await db?.close();
    rmSync(projectDir, { recursive: true, force: true });
  }
});

Deno.test("dynamic schema restore rejects multi-statement fallback without migration file", async () => {
  const projectDir = await Deno.makeTempDir({
    dir: TEST_TMP_DIR,
    prefix: "genie-dynamic-schema-bad-fallback-",
  });
  const dataDir = join(projectDir, "data");
  const schemaDir = join(projectDir, ".opentide", "state", "schemas");
  mkdirSync(schemaDir, { recursive: true });

  writeJson(
    join(schemaDir, "notes.json"),
    schemaEntry(
      "notes",
      `
        CREATE TABLE notes (id SERIAL PRIMARY KEY, title TEXT NOT NULL);
        CREATE TABLE note_tags (
          id SERIAL PRIMARY KEY,
          note_id INTEGER REFERENCES notes(id)
        )
      `,
    ),
  );

  try {
    await assertRejects(
      () => Database.create({ driver: "pglite", dataDir, schemaDir }),
      Error,
      "schema SQL fallback must be a single CREATE TABLE statement",
    );
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

Deno.test("dynamic schema restore defers foreign keys for cyclic base table references", async () => {
  const projectDir = await Deno.makeTempDir({
    dir: TEST_TMP_DIR,
    prefix: "genie-dynamic-schema-cycle-",
  });
  const dataDir = join(projectDir, "data");
  const schemaDir = join(projectDir, ".opentide", "state", "schemas");
  const migrationsDir = join(schemaDir, "migrations");
  mkdirSync(migrationsDir, { recursive: true });

  const aSql = `
    CREATE TABLE a (
      id INTEGER PRIMARY KEY,
      b_id INTEGER REFERENCES b(id) ON DELETE CASCADE,
      code TEXT NOT NULL UNIQUE,
      CHECK (code <> '')
    )
  `;
  const bSql = `
    CREATE TABLE b (
      id INTEGER PRIMARY KEY,
      a_id INTEGER,
      CONSTRAINT b_a_fk FOREIGN KEY (a_id) REFERENCES a(id) ON DELETE SET NULL
    )
  `;

  writeJson(join(schemaDir, "a.json"), schemaEntry("a", aSql));
  writeJson(join(schemaDir, "b.json"), schemaEntry("b", bSql));
  writeJson(join(migrationsDir, "a.json"), [
    migration("a", 1, aSql, "2026-01-01T00:00:00.000Z"),
  ]);
  writeJson(join(migrationsDir, "b.json"), [
    migration("b", 1, bSql, "2026-01-01T00:00:01.000Z"),
  ]);

  let db: Database | undefined;
  try {
    db = await Database.create({ driver: "pglite", dataDir, schemaDir });
    const constraints = await db.query(`
      SELECT c.conname, rel.relname
      FROM pg_constraint c
      JOIN pg_class rel ON rel.oid = c.conrelid
      WHERE c.contype = 'f'
        AND rel.relname IN ('a', 'b')
      ORDER BY rel.relname, c.conname
    `);
    assertEquals(constraints, [
      { conname: "a_b_id_fkey", relname: "a" },
      { conname: "b_a_fk", relname: "b" },
    ]);

    await db.execute("INSERT INTO b (id, a_id) VALUES ($1, $2)", [1, null]);
    await db.execute("INSERT INTO a (id, b_id, code) VALUES ($1, $2, $3)", [
      1,
      1,
      "ok",
    ]);
    await db.execute("UPDATE b SET a_id = $1 WHERE id = $2", [1, 1]);

    await assertRejects(
      () =>
        db!.execute("INSERT INTO a (id, b_id, code) VALUES ($1, $2, $3)", [
          2,
          999,
          "bad-a",
        ]),
      Error,
      "violates foreign key constraint",
    );
    await assertRejects(
      () => db!.execute("INSERT INTO b (id, a_id) VALUES ($1, $2)", [2, 999]),
      Error,
      "violates foreign key constraint",
    );
  } finally {
    await db?.close();
    rmSync(projectDir, { recursive: true, force: true });
  }
});

Deno.test("dynamic schema restore defers cyclic base foreign keys with quoted identifiers", async () => {
  const projectDir = await Deno.makeTempDir({
    dir: TEST_TMP_DIR,
    prefix: "genie-dynamic-schema-quoted-cycle-",
  });
  const dataDir = join(projectDir, "data");
  const schemaDir = join(projectDir, ".opentide", "state", "schemas");
  const migrationsDir = join(schemaDir, "migrations");
  mkdirSync(migrationsDir, { recursive: true });

  const alphaSql = `
    CREATE TABLE "alpha" (
      id INTEGER PRIMARY KEY,
      "Beta ID" INTEGER REFERENCES "beta"(id) ON UPDATE CASCADE,
      label TEXT DEFAULT 'alpha'
    )
  `;
  const betaSql = `
    CREATE TABLE "beta" (
      id INTEGER PRIMARY KEY,
      "Alpha ID" INTEGER,
      CONSTRAINT "Beta Alpha FK" FOREIGN KEY ("Alpha ID") REFERENCES "alpha"(id)
    )
  `;

  writeJson(join(schemaDir, "alpha.json"), schemaEntry("alpha", alphaSql));
  writeJson(join(schemaDir, "beta.json"), schemaEntry("beta", betaSql));
  writeJson(join(migrationsDir, "alpha.json"), [
    migration("alpha", 1, alphaSql, "2026-01-01T00:00:00.000Z"),
  ]);
  writeJson(join(migrationsDir, "beta.json"), [
    migration("beta", 1, betaSql, "2026-01-01T00:00:01.000Z"),
  ]);

  let db: Database | undefined;
  try {
    db = await Database.create({ driver: "pglite", dataDir, schemaDir });
    const constraints = await db.query(`
      SELECT c.conname, rel.relname
      FROM pg_constraint c
      JOIN pg_class rel ON rel.oid = c.conrelid
      WHERE c.contype = 'f'
        AND rel.relname IN ('alpha', 'beta')
      ORDER BY rel.relname, c.conname
    `);
    assertEquals(constraints, [
      { conname: "alpha_Beta ID_fkey", relname: "alpha" },
      { conname: "Beta Alpha FK", relname: "beta" },
    ]);

    await db.execute(`INSERT INTO beta (id, "Alpha ID") VALUES ($1, $2)`, [
      1,
      null,
    ]);
    await db.execute(
      `INSERT INTO alpha (id, "Beta ID", label) VALUES ($1, $2, $3)`,
      [1, 1, "ok"],
    );
    await db.execute(`UPDATE beta SET "Alpha ID" = $1 WHERE id = $2`, [1, 1]);

    await assertRejects(
      () =>
        db!.execute(
          `INSERT INTO alpha (id, "Beta ID", label) VALUES ($1, $2, $3)`,
          [2, 999, "bad-alpha"],
        ),
      Error,
      "violates foreign key constraint",
    );
  } finally {
    await db?.close();
    rmSync(projectDir, { recursive: true, force: true });
  }
});

Deno.test("dynamic schema restore preserves implicit FK names for later migrations", async () => {
  const projectDir = await Deno.makeTempDir({
    dir: TEST_TMP_DIR,
    prefix: "genie-dynamic-schema-cycle-drop-fk-",
  });
  const dataDir = join(projectDir, "data");
  const schemaDir = join(projectDir, ".opentide", "state", "schemas");
  const migrationsDir = join(schemaDir, "migrations");
  mkdirSync(migrationsDir, { recursive: true });

  const aV1 =
    "CREATE TABLE a (id INTEGER PRIMARY KEY, b_id INTEGER REFERENCES b(id))";
  const aV2 = "ALTER TABLE a DROP CONSTRAINT a_b_id_fkey";
  const bV1 =
    "CREATE TABLE b (id INTEGER PRIMARY KEY, a_id INTEGER REFERENCES a(id))";

  writeJson(join(schemaDir, "a.json"), schemaEntry("a", `${aV1};\n\n${aV2}`));
  writeJson(join(schemaDir, "b.json"), schemaEntry("b", bV1));
  writeJson(join(migrationsDir, "a.json"), [
    migration("a", 1, aV1, "2026-01-01T00:00:00.000Z"),
    migration("a", 2, aV2, "2026-01-01T00:00:02.000Z"),
  ]);
  writeJson(join(migrationsDir, "b.json"), [
    migration("b", 1, bV1, "2026-01-01T00:00:01.000Z"),
  ]);

  let db: Database | undefined;
  try {
    db = await Database.create({ driver: "pglite", dataDir, schemaDir });
    const constraints = await db.query(`
      SELECT c.conname, rel.relname
      FROM pg_constraint c
      JOIN pg_class rel ON rel.oid = c.conrelid
      WHERE c.contype = 'f'
        AND rel.relname IN ('a', 'b')
      ORDER BY rel.relname, c.conname
    `);
    assertEquals(constraints, [
      { conname: "b_a_id_fkey", relname: "b" },
    ]);
  } finally {
    await db?.close();
    rmSync(projectDir, { recursive: true, force: true });
  }
});

Deno.test("dynamic schema restore does not collide unnamed FKs with retained constraints", async () => {
  const projectDir = await Deno.makeTempDir({
    dir: TEST_TMP_DIR,
    prefix: "genie-dynamic-schema-cycle-name-collision-",
  });
  const dataDir = join(projectDir, "data");
  const schemaDir = join(projectDir, ".opentide", "state", "schemas");
  const migrationsDir = join(schemaDir, "migrations");
  mkdirSync(migrationsDir, { recursive: true });

  const aSql = `
    CREATE TABLE a (
      id INTEGER PRIMARY KEY,
      b_id INTEGER REFERENCES b(id),
      CONSTRAINT a_1_fk CHECK (b_id IS NULL OR b_id > 0)
    )
  `;
  const bSql =
    "CREATE TABLE b (id INTEGER PRIMARY KEY, a_id INTEGER REFERENCES a(id))";

  writeJson(join(schemaDir, "a.json"), schemaEntry("a", aSql));
  writeJson(join(schemaDir, "b.json"), schemaEntry("b", bSql));
  writeJson(join(migrationsDir, "a.json"), [
    migration("a", 1, aSql, "2026-01-01T00:00:00.000Z"),
  ]);
  writeJson(join(migrationsDir, "b.json"), [
    migration("b", 1, bSql, "2026-01-01T00:00:01.000Z"),
  ]);

  let db: Database | undefined;
  try {
    db = await Database.create({ driver: "pglite", dataDir, schemaDir });
    const constraints = await db.query(`
      SELECT c.conname, c.contype, rel.relname
      FROM pg_constraint c
      JOIN pg_class rel ON rel.oid = c.conrelid
      WHERE rel.relname IN ('a', 'b')
        AND c.conname IN ('a_1_fk', 'a_b_id_fkey')
      ORDER BY c.conname
    `);
    assertEquals(constraints, [
      { conname: "a_1_fk", contype: "c", relname: "a" },
      { conname: "a_b_id_fkey", contype: "f", relname: "a" },
    ]);
  } finally {
    await db?.close();
    rmSync(projectDir, { recursive: true, force: true });
  }
});

Deno.test("dynamic schema restore rejects unsupported cyclic foreign-key syntax clearly", async () => {
  const projectDir = await Deno.makeTempDir({
    dir: TEST_TMP_DIR,
    prefix: "genie-dynamic-schema-unsupported-cycle-",
  });
  const dataDir = join(projectDir, "data");
  const schemaDir = join(projectDir, ".opentide", "state", "schemas");
  const migrationsDir = join(schemaDir, "migrations");
  mkdirSync(migrationsDir, { recursive: true });

  const aSql =
    "CREATE TABLE a (id INTEGER PRIMARY KEY, b_id INTEGER REFERENCES b(id) DEFERRABLE)";
  const bSql =
    "CREATE TABLE b (id INTEGER PRIMARY KEY, a_id INTEGER REFERENCES a(id))";

  writeJson(join(schemaDir, "a.json"), schemaEntry("a", aSql));
  writeJson(join(schemaDir, "b.json"), schemaEntry("b", bSql));
  writeJson(join(migrationsDir, "a.json"), [
    migration("a", 1, aSql, "2026-01-01T00:00:00.000Z"),
  ]);
  writeJson(join(migrationsDir, "b.json"), [
    migration("b", 1, bSql, "2026-01-01T00:00:01.000Z"),
  ]);

  try {
    await assertRejects(
      () => Database.create({ driver: "pglite", dataDir, schemaDir }),
      Error,
      `Cannot defer foreign keys for "a": unsupported trailing tokens in column-level foreign-key definition.`,
    );
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});
