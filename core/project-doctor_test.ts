import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "./db.ts";
import { diagnoseDynamicSchemaRestore } from "./dynamic-schema-restore-diagnostics.ts";
import { doctorProject } from "./project-doctor.ts";
import { acquireProjectLock } from "./project-lock.ts";
import { getProjectPaths } from "./project-manager.ts";
import { TEST_TMP_DIR } from "./test-home_test.ts";

function writeJson(path: string, value: unknown): void {
  mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

function writeText(path: string, value: string): void {
  mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true });
  writeFileSync(path, value);
}

function writeSchemaFile(projectDir: string, tableName = "items"): void {
  const paths = getProjectPaths(projectDir);
  writeJson(join(paths.schemaDir, `${tableName}.json`), {
    tableName,
    columns: [{
      name: "id",
      type: "INTEGER",
      nullable: false,
      defaultValue: null,
      primaryKey: true,
    }],
    sql: `CREATE TABLE ${tableName} (id SERIAL PRIMARY KEY)`,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
}

function dynamicRestoreWarning(
  report: Awaited<ReturnType<typeof doctorProject>>,
) {
  return report.warnings.find((issue) =>
    issue.code === "DYNAMIC_SCHEMA_LOCAL_DATA_MISSING"
  );
}

async function withProject(
  fn: (projectDir: string) => Promise<void> | void,
): Promise<void> {
  const projectDir = await Deno.makeTempDir({
    dir: TEST_TMP_DIR,
    prefix: "tideide-doctor-",
  });
  try {
    writeJson(join(projectDir, "opentide.json"), {
      name: "Doctor",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    await fn(projectDir);
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
}

Deno.test("doctorProject reports healthy project state and history", async () => {
  await withProject(async (projectDir) => {
    const paths = getProjectPaths(projectDir);
    writeJson(join(paths.stateDir, "routes.json"), []);
    writeJson(join(paths.schemaDir, "items.json"), {
      tableName: "items",
      columns: [{
        name: "id",
        type: "INTEGER",
        nullable: false,
        defaultValue: null,
        primaryKey: true,
      }],
      sql: "CREATE TABLE items (id SERIAL PRIMARY KEY)",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    writeJson(join(paths.schemaDir, "migrations", "items.json"), [{
      id: 1,
      tableName: "items",
      version: 1,
      sql: "CREATE TABLE items (id SERIAL PRIMARY KEY)",
      reverseSql: 'DROP TABLE IF EXISTS "items"',
      reversible: true,
      columnsBefore: [],
      columnsAfter: [],
      appliedAt: "2026-01-01T00:00:00.000Z",
      rolledBackAt: null,
      turnId: null,
    }]);
    writeJson(join(projectDir, "fixtures", "seed", "manifest.json"), {
      version: 1,
      tables: [{ tableName: "items", rowCount: 0, columns: ["id"] }],
    });
    const db = await Database.create({
      driver: "pglite",
      dataDir: paths.dataDir,
      schemaDir: paths.schemaDir,
    });
    await db.close();

    writeJson(join(paths.historyDir, "sessions", "s1.json"), {
      id: "s1",
      name: "Session",
      startedAt: "2026-01-01T00:00:00.000Z",
      endedAt: null,
      summary: null,
      focus: null,
      metadata: null,
      archived: false,
    });
    writeText(
      join(paths.historyDir, "messages", "s1.jsonl"),
      JSON.stringify({
        id: 1001,
        sessionId: "s1",
        role: "user",
        content: "hello",
        toolCalls: null,
        pinned: false,
        turnId: "turn1",
        createdAt: "2026-01-01T00:00:00.000Z",
      }) + "\n",
    );
    writeJson(join(paths.historyDir, "changesets", "cs1.json"), {
      id: "cs1",
      sessionId: "s1",
      title: "Plan",
      description: null,
      status: "planning",
      plan: { summary: "Plan", steps: [] },
      planMessageIds: [1001],
      approvalMessageId: null,
      workMessageIds: [],
      toolCalls: null,
      reasoning: null,
      tokenUsage: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      completedAt: null,
    });
    writeJson(join(paths.historyDir, "changelog", "records", "chg1.json"), {
      uid: "chg1",
      id: 2001,
      category: "handler",
      key: "hello",
      action: "create",
      beforeSnapshot: null,
      afterSnapshot: {},
      context: { sessionId: "s1", changesetId: "cs1" },
      createdAt: "2026-01-01T00:00:00.000Z",
      undoable: true,
      turnId: "turn1",
      changesetId: "cs1",
    });

    const report = await doctorProject(projectDir);
    assertEquals(report.ok, true);
    assertEquals(report.errors.length, 0);
    assertEquals(report.warnings.length, 0);
    assertEquals(report.counts.schemas, 1);
    assertEquals(report.counts.messages, 1);
    assertEquals(report.counts.changelogRecords, 1);
  });
});

Deno.test("doctorProject reports broken project state and references", async () => {
  await withProject(async (projectDir) => {
    const paths = getProjectPaths(projectDir);
    writeText(join(paths.stateDir, "routes.json"), "{broken");
    writeJson(join(paths.schemaDir, "items.json"), {
      tableName: "items",
      columns: [],
      sql: "CREATE TABLE items (id SERIAL PRIMARY KEY)",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    writeJson(join(paths.schemaDir, "migrations", "items.json"), [{
      id: 1,
      tableName: "other",
      version: 1,
      sql: "CREATE TABLE other (id SERIAL PRIMARY KEY)",
      reverseSql: null,
      reversible: false,
      columnsBefore: [],
      columnsAfter: [],
      appliedAt: "2026-01-01T00:00:00.000Z",
      rolledBackAt: null,
      turnId: null,
    }, {
      id: 2,
      tableName: "items",
      version: 1,
      sql: "ALTER TABLE items ADD COLUMN name TEXT",
      reverseSql: null,
      reversible: false,
      columnsBefore: [],
      columnsAfter: [],
      appliedAt: "2026-01-01T00:00:01.000Z",
      rolledBackAt: null,
      turnId: null,
    }]);

    writeJson(join(paths.historyDir, "sessions", "a.json"), { id: "s1" });
    writeJson(join(paths.historyDir, "sessions", "b.json"), { id: "s1" });
    writeText(
      join(paths.historyDir, "messages", "a.jsonl"),
      [
        JSON.stringify({
          id: 1,
          sessionId: "missing",
          role: "user",
          content: "x",
        }),
        JSON.stringify({ id: 1, sessionId: "s1", role: "user", content: "y" }),
        "{broken",
      ].join("\n") + "\n",
    );
    writeJson(join(paths.historyDir, "changesets", "cs.json"), {
      id: "cs1",
      sessionId: "missing",
      title: "Broken",
      plan: { summary: "Broken", steps: [] },
      planMessageIds: [999],
      workMessageIds: [],
      approvalMessageId: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      completedAt: null,
      status: "planning",
    });
    writeJson(join(paths.historyDir, "changelog", "records", "a.json"), {
      uid: "a",
      id: 2,
      category: "",
      key: "",
      action: "create",
      beforeSnapshot: null,
      afterSnapshot: null,
      context: { sessionId: "missing", changesetId: "missing" },
      createdAt: "2026-01-01T00:00:00.000Z",
      undoable: true,
      turnId: null,
      changesetId: "missing",
    });
    writeJson(join(paths.historyDir, "changelog", "records", "b.json"), {
      uid: "b",
      id: 2,
      category: "handler",
      key: "x",
      action: "create",
      beforeSnapshot: null,
      afterSnapshot: null,
      context: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      undoable: true,
      turnId: null,
      changesetId: null,
    });

    const report = await doctorProject(projectDir);
    const codes = new Set(report.errors.map((issue) => issue.code));
    assertEquals(report.ok, false);
    assertEquals(codes.has("INVALID_JSON"), true);
    assertEquals(codes.has("SCHEMA_MIGRATION_MISMATCH"), true);
    assertEquals(codes.has("DUPLICATE_SCHEMA_MIGRATION"), true);
    assertEquals(codes.has("DUPLICATE_SESSION"), true);
    assertEquals(codes.has("DUPLICATE_MESSAGE"), true);
    assertEquals(codes.has("MESSAGE_SESSION_MISSING"), true);
    assertEquals(codes.has("CHANGESET_SESSION_MISSING"), true);
    assertEquals(codes.has("CHANGESET_MESSAGE_MISSING"), true);
    assertEquals(codes.has("DUPLICATE_CHANGELOG"), true);
    assertEquals(codes.has("CHANGELOG_SESSION_MISSING"), true);
    assertEquals(codes.has("CHANGELOG_CHANGESET_MISSING"), true);
    assertEquals(codes.has("INVALID_CHANGELOG"), true);
  });
});

Deno.test("doctorProject accepts missing schema when latest active migration drops table", async () => {
  await withProject(async (projectDir) => {
    const paths = getProjectPaths(projectDir);
    writeJson(join(paths.schemaDir, "migrations", "archived_items.json"), [{
      id: 1,
      tableName: "archived_items",
      version: 1,
      sql: "CREATE TABLE archived_items (id SERIAL PRIMARY KEY)",
      reverseSql: 'DROP TABLE IF EXISTS "archived_items"',
      reversible: true,
      columnsBefore: [],
      columnsAfter: [],
      appliedAt: "2026-01-01T00:00:00.000Z",
      rolledBackAt: null,
      turnId: null,
    }, {
      id: 2,
      tableName: "archived_items",
      version: 2,
      sql: 'DROP TABLE "archived_items"',
      reverseSql: "CREATE TABLE archived_items (id SERIAL PRIMARY KEY)",
      reversible: true,
      columnsBefore: [],
      columnsAfter: [],
      appliedAt: "2026-01-01T00:00:01.000Z",
      rolledBackAt: null,
      turnId: null,
    }]);

    const report = await doctorProject(projectDir);
    assertEquals(report.errors.map((issue) => issue.code), []);
    assertEquals(report.counts.schemaMigrations, 2);
  });
});

Deno.test("doctorProject only suppresses orphans for the dropped migration table", async () => {
  await withProject(async (projectDir) => {
    const paths = getProjectPaths(projectDir);
    writeJson(join(paths.schemaDir, "migrations", "archived_items.json"), [{
      id: 1,
      tableName: "archived_items",
      version: 1,
      sql: "CREATE TABLE archived_items (id SERIAL PRIMARY KEY)",
      reverseSql: 'DROP TABLE IF EXISTS "archived_items"',
      reversible: true,
      columnsBefore: [],
      columnsAfter: [],
      appliedAt: "2026-01-01T00:00:00.000Z",
      rolledBackAt: null,
      turnId: null,
    }, {
      id: 2,
      tableName: "archived_items",
      version: 2,
      sql: 'DROP TABLE "archived_items"',
      reverseSql: "CREATE TABLE archived_items (id SERIAL PRIMARY KEY)",
      reversible: true,
      columnsBefore: [],
      columnsAfter: [],
      appliedAt: "2026-01-01T00:00:01.000Z",
      rolledBackAt: null,
      turnId: null,
    }, {
      id: 3,
      tableName: "active_items",
      version: 1,
      sql: "CREATE TABLE active_items (id SERIAL PRIMARY KEY)",
      reverseSql: 'DROP TABLE IF EXISTS "active_items"',
      reversible: true,
      columnsBefore: [],
      columnsAfter: [],
      appliedAt: "2026-01-01T00:00:02.000Z",
      rolledBackAt: null,
      turnId: null,
    }]);

    const report = await doctorProject(projectDir);
    assertEquals(
      report.errors.some((issue) =>
        issue.code === "SCHEMA_MIGRATION_ORPHAN" &&
        issue.message.includes('"active_items"')
      ),
      true,
    );
  });
});

Deno.test("doctorProject reports missing schema when latest active migration is not a drop", async () => {
  await withProject(async (projectDir) => {
    const paths = getProjectPaths(projectDir);
    writeJson(join(paths.schemaDir, "migrations", "active_items.json"), [{
      id: 1,
      tableName: "active_items",
      version: 1,
      sql: "CREATE TABLE active_items (id SERIAL PRIMARY KEY)",
      reverseSql: 'DROP TABLE IF EXISTS "active_items"',
      reversible: true,
      columnsBefore: [],
      columnsAfter: [],
      appliedAt: "2026-01-01T00:00:00.000Z",
      rolledBackAt: null,
      turnId: null,
    }, {
      id: 2,
      tableName: "active_items",
      version: 2,
      sql: "ALTER TABLE active_items ADD COLUMN name TEXT",
      reverseSql: null,
      reversible: false,
      columnsBefore: [],
      columnsAfter: [],
      appliedAt: "2026-01-01T00:00:01.000Z",
      rolledBackAt: null,
      turnId: null,
    }]);

    const report = await doctorProject(projectDir);
    assertEquals(
      report.errors.some((issue) => issue.code === "SCHEMA_MIGRATION_ORPHAN"),
      true,
    );
  });
});

Deno.test("doctorProject reports missing schema when drop migration is rolled back", async () => {
  await withProject(async (projectDir) => {
    const paths = getProjectPaths(projectDir);
    writeJson(join(paths.schemaDir, "migrations", "rolled_back_drop.json"), [{
      id: 1,
      tableName: "rolled_back_drop",
      version: 1,
      sql: "CREATE TABLE rolled_back_drop (id SERIAL PRIMARY KEY)",
      reverseSql: 'DROP TABLE IF EXISTS "rolled_back_drop"',
      reversible: true,
      columnsBefore: [],
      columnsAfter: [],
      appliedAt: "2026-01-01T00:00:00.000Z",
      rolledBackAt: null,
      turnId: null,
    }, {
      id: 2,
      tableName: "rolled_back_drop",
      version: 2,
      sql: 'DROP TABLE "rolled_back_drop"',
      reverseSql: "CREATE TABLE rolled_back_drop (id SERIAL PRIMARY KEY)",
      reversible: true,
      columnsBefore: [],
      columnsAfter: [],
      appliedAt: "2026-01-01T00:00:01.000Z",
      rolledBackAt: "2026-01-01T00:00:02.000Z",
      turnId: null,
    }]);

    const report = await doctorProject(projectDir);
    assertEquals(
      report.errors.some((issue) => issue.code === "SCHEMA_MIGRATION_ORPHAN"),
      true,
    );
  });
});

Deno.test("doctorProject warns when schema files exist but data directory is missing", async () => {
  await withProject(async (projectDir) => {
    writeSchemaFile(projectDir);

    const report = await doctorProject(projectDir);
    const warning = dynamicRestoreWarning(report);

    assertEquals(report.ok, true);
    assertEquals(Boolean(warning), true);
    assertStringIncludes(warning!.message, "no local data directory");
    assertStringIncludes(warning!.message, "Tide will recreate empty tables");
  });
});

Deno.test({
  sanitizeResources: false,
  sanitizeOps: false,
  name:
    "doctorProject warns when schema files exist but fresh DB lacks dynamic tables",
  fn: async () => {
    await withProject(async (projectDir) => {
      writeSchemaFile(projectDir);
      const paths = getProjectPaths(projectDir);
      const db = await Database.create({
        driver: "pglite",
        dataDir: paths.dataDir,
      });
      await db.close();

      const report = await doctorProject(projectDir);
      const warning = dynamicRestoreWarning(report);

      assertEquals(report.ok, true);
      assertEquals(Boolean(warning), true);
      assertStringIncludes(warning!.message, "local data is incomplete");
      assertStringIncludes(
        warning!.message,
        "Tide will recreate missing empty tables",
      );
    });
  },
});

// A second Postgres on a directory another process has open runs recovery
// underneath it; after that, main's snapshots no longer restore and every task
// fork crashed. So a held project is asked through its open database, never
// reopened.
Deno.test({
  sanitizeResources: false,
  sanitizeOps: false,
  name: "the restore check never reopens a database another process holds",
  fn: async () => {
    await withProject(async (projectDir) => {
      writeSchemaFile(projectDir);
      const paths = getProjectPaths(projectDir);
      const db = await Database.create({
        driver: "pglite",
        dataDir: paths.dataDir,
      });
      const lock = acquireProjectLock(projectDir);
      try {
        await db.execute("CREATE TABLE items (id SERIAL PRIMARY KEY)");
        assert(lock.ok);

        const asked = await diagnoseDynamicSchemaRestore(projectDir, db);
        assertEquals(asked.physicalTables, ["items"]);
        assertEquals(asked.missingTables, []);

        const held = await diagnoseDynamicSchemaRestore(projectDir);
        assertEquals(held.physicalTables, null);
        assertEquals(held.dbOpenError, undefined);
        assertEquals(held.missingTables, []);
      } finally {
        if (lock.ok) lock.data.release();
        await db.close();
      }
    });
  },
});

Deno.test("doctorProject suppresses restore warning when fixtures are present", async () => {
  await withProject(async (projectDir) => {
    writeSchemaFile(projectDir);
    writeJson(join(projectDir, "fixtures", "seed", "manifest.json"), {
      version: 1,
      tables: [{ tableName: "items", rowCount: 1, columns: ["id"] }],
    });

    const report = await doctorProject(projectDir);

    assertEquals(report.ok, true);
    assertEquals(dynamicRestoreWarning(report), undefined);
  });
});

Deno.test("doctorProject emits no restore warning when there are no schema files", async () => {
  await withProject(async (projectDir) => {
    const report = await doctorProject(projectDir);

    assertEquals(report.ok, true);
    assertEquals(dynamicRestoreWarning(report), undefined);
  });
});
