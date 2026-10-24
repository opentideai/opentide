import { assertEquals, assertExists, assertStringIncludes } from "@std/assert";
import { Database, isSingleStatement } from "./db.ts";

async function withDb(fn: (db: Database) => Promise<void>): Promise<void> {
  const db = await Database.create({ driver: "pglite" });
  try {
    await fn(db);
  } finally {
    await db.close();
  }
}

Deno.test("defineSchema creates a table and records metadata", async () => {
  await withDb(async (db) => {
    const result = await db.defineSchema(
      "todos",
      `CREATE TABLE todos (id SERIAL PRIMARY KEY, title TEXT NOT NULL, done INTEGER DEFAULT 0)`,
    );
    assertEquals(result.ok, true);
    if (!result.ok) throw new Error("unreachable");

    assertEquals(result.data.tableName, "todos");
    assertEquals(result.data.columns.length, 3);
    assertEquals(result.data.columns[0]?.name, "id");
    assertEquals(result.data.columns[0]?.primaryKey, true);
    assertEquals(result.data.columns[1]?.name, "title");
    assertEquals(result.data.columns[1]?.nullable, false);
    assertEquals(result.data.columns[2]?.name, "done");

    await db.execute("INSERT INTO todos (title) VALUES ($1)", ["buy milk"]);
    const rows = await db.query("SELECT * FROM todos");
    assertEquals(rows.length, 1);
    assertEquals(rows[0]?.title, "buy milk");
  });
});

Deno.test("defineSchema rejects reserved names", async () => {
  await withDb(async (db) => {
    const result = await db.defineSchema(
      "_genie_test",
      "CREATE TABLE _genie_test (id INTEGER)",
    );
    assertEquals(result.ok, false);
    if (result.ok) throw new Error("unreachable");
    assertEquals(result.error.code, "RESERVED_NAME");
  });
});

Deno.test("defineSchema rejects duplicate table", async () => {
  await withDb(async (db) => {
    await db.defineSchema(
      "todos",
      "CREATE TABLE todos (id SERIAL PRIMARY KEY)",
    );
    const result = await db.defineSchema(
      "todos",
      "CREATE TABLE todos (id SERIAL PRIMARY KEY)",
    );
    assertEquals(result.ok, false);
    if (result.ok) throw new Error("unreachable");
    assertEquals(result.error.code, "TABLE_EXISTS");
  });
});

Deno.test("alterSchema adds a column and preserves data", async () => {
  await withDb(async (db) => {
    await db.defineSchema(
      "todos",
      "CREATE TABLE todos (id SERIAL PRIMARY KEY, title TEXT NOT NULL)",
    );
    await db.execute("INSERT INTO todos (title) VALUES ($1)", ["buy milk"]);
    await db.execute("INSERT INTO todos (title) VALUES ($1)", ["walk dog"]);

    const result = await db.alterSchema(
      "todos",
      "CREATE TABLE todos (id SERIAL PRIMARY KEY, title TEXT NOT NULL, done INTEGER DEFAULT 0, due_date TEXT)",
    );
    assertEquals(result.ok, true);
    if (!result.ok) throw new Error("unreachable");

    assertEquals(result.data.columns.length, 4);

    const rows = await db.query("SELECT * FROM todos ORDER BY id");
    assertEquals(rows.length, 2);
    assertEquals(rows[0]?.title, "buy milk");
    assertEquals(rows[0]?.done, 0);
    assertEquals(rows[0]?.due_date, null);
  });
});

Deno.test("alterSchema CREATE INDEX keeps the base CREATE TABLE in .sql", async () => {
  await withDb(async (db) => {
    const createSql =
      "CREATE TABLE versions (id SERIAL PRIMARY KEY, document_id INTEGER NOT NULL)";
    await db.defineSchema("versions", createSql);

    const indexSql =
      "CREATE INDEX idx_versions_document ON versions(document_id)";
    const result = await db.alterSchema("versions", indexSql);
    assertEquals(result.ok, true);
    if (!result.ok) throw new Error("unreachable");

    // The stored DDL must recreate the table AND the index — adding an index
    // must not overwrite the CREATE TABLE (regression: the changelog diff
    // rendered the whole table as deleted and the index as its replacement).
    assertStringIncludes(result.data.sql, createSql);
    assertStringIncludes(result.data.sql, indexSql);
    // beforeSnapshot/afterSnapshot for the changelog diff: previous cumulative
    // vs new cumulative, so the index shows up as an addition, not a rewrite.
    assertEquals(result.data.previousSql, createSql);

    const schema = await db.getSchema("versions");
    assertEquals(schema.ok, true);
    if (!schema.ok) throw new Error("unreachable");
    assertStringIncludes(schema.data.sql, createSql);
    assertStringIncludes(schema.data.sql, indexSql);
  });
});

Deno.test("alterSchema removes a column and preserves remaining data", async () => {
  await withDb(async (db) => {
    await db.defineSchema(
      "items",
      "CREATE TABLE items (id SERIAL PRIMARY KEY, name TEXT, description TEXT, price REAL)",
    );
    await db.execute(
      "INSERT INTO items (name, description, price) VALUES ($1, $2, $3)",
      ["widget", "a thing", 9.99],
    );

    const result = await db.alterSchema(
      "items",
      "CREATE TABLE items (id SERIAL PRIMARY KEY, name TEXT, price REAL)",
    );
    assertEquals(result.ok, true);

    const rows = await db.query("SELECT * FROM items");
    assertEquals(rows.length, 1);
    assertEquals(rows[0]?.name, "widget");
    assertEquals(rows[0]?.price, 9.99);
    assertEquals(rows[0]?.description, undefined);
  });
});

Deno.test("dropSchema removes table and metadata", async () => {
  await withDb(async (db) => {
    await db.defineSchema(
      "todos",
      "CREATE TABLE todos (id SERIAL PRIMARY KEY)",
    );
    assertEquals((await db.listSchemas()).length, 1);

    const result = await db.dropSchema("todos");
    assertEquals(result.ok, true);
    assertEquals((await db.listSchemas()).length, 0);

    const qResult = await db.query(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = 'todos'",
    );
    assertEquals(qResult.length, 0);
  });
});

Deno.test("listSchemas and getSchema return correct data", async () => {
  await withDb(async (db) => {
    await db.defineSchema(
      "todos",
      "CREATE TABLE todos (id SERIAL PRIMARY KEY, title TEXT)",
    );
    await db.defineSchema(
      "categories",
      "CREATE TABLE categories (id SERIAL PRIMARY KEY, name TEXT NOT NULL)",
    );

    const schemas = await db.listSchemas();
    assertEquals(schemas.length, 2);
    assertEquals(schemas[0]?.tableName, "categories");
    assertEquals(schemas[1]?.tableName, "todos");

    const result = await db.getSchema("todos");
    assertEquals(result.ok, true);
    if (!result.ok) throw new Error("unreachable");
    assertEquals(result.data.columns.length, 2);
    assertExists(result.data.createdAt);
  });
});

Deno.test("query and execute work correctly", async () => {
  await withDb(async (db) => {
    await db.defineSchema(
      "kv",
      "CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT)",
    );

    const ins = await db.execute(
      "INSERT INTO kv (key, value) VALUES ($1, $2)",
      ["greeting", "hello"],
    );
    assertEquals(ins.changes, 1);

    const rows = await db.query("SELECT value FROM kv WHERE key = $1", [
      "greeting",
    ]);
    assertEquals(rows.length, 1);
    assertEquals(rows[0]?.value, "hello");

    const upd = await db.execute("UPDATE kv SET value = $1 WHERE key = $2", [
      "world",
      "greeting",
    ]);
    assertEquals(upd.changes, 1);

    const del = await db.execute("DELETE FROM kv WHERE key = $1", ["greeting"]);
    assertEquals(del.changes, 1);

    assertEquals((await db.query("SELECT * FROM kv")).length, 0);
  });
});

Deno.test("defineSchema rejects non-CREATE TABLE SQL", async () => {
  await withDb(async (db) => {
    const result = await db.defineSchema("bad", "NOT VALID SQL");
    assertEquals(result.ok, false);
    if (result.ok) throw new Error("unreachable");
    assertEquals(result.error.code, "INVALID_SQL");
  });
});

Deno.test("defineSchema returns SQL_ERROR on malformed CREATE TABLE", async () => {
  await withDb(async (db) => {
    const result = await db.defineSchema(
      "bad",
      "CREATE TABLE bad (id BOGUSTYPE PRIMARYKEY,,,)",
    );
    assertEquals(result.ok, false);
    if (result.ok) throw new Error("unreachable");
    assertEquals(result.error.code, "SQL_ERROR");
  });
});

Deno.test("defineSchema rejects invalid table names", async () => {
  await withDb(async (db) => {
    const result = await db.defineSchema(
      "bad-name",
      'CREATE TABLE "bad-name" (id INTEGER)',
    );
    assertEquals(result.ok, false);
    if (result.ok) throw new Error("unreachable");
    assertEquals(result.error.code, "INVALID_NAME");
  });
});

Deno.test("alterSchema on nonexistent table returns TABLE_NOT_FOUND", async () => {
  await withDb(async (db) => {
    const result = await db.alterSchema(
      "nope",
      "CREATE TABLE nope (id INTEGER)",
    );
    assertEquals(result.ok, false);
    if (result.ok) throw new Error("unreachable");
    assertEquals(result.error.code, "TABLE_NOT_FOUND");
  });
});

Deno.test("alterSchema rejects invalid/injection table names", async () => {
  await withDb(async (db) => {
    const result = await db.alterSchema(
      'evil"; DROP TABLE _genie_sessions; --',
      "ALTER TABLE evil ADD COLUMN x INTEGER",
    );
    assertEquals(result.ok, false);
    if (result.ok) throw new Error("unreachable");
    assertEquals(result.error.code, "INVALID_NAME");
  });
});

Deno.test("alterSchema rejects reserved (_genie_) table names", async () => {
  await withDb(async (db) => {
    const result = await db.alterSchema(
      "_genie_sessions",
      "ALTER TABLE _genie_sessions ADD COLUMN x INTEGER",
    );
    assertEquals(result.ok, false);
    if (result.ok) throw new Error("unreachable");
    assertEquals(result.error.code, "RESERVED_NAME");
  });
});

Deno.test("dropSchema rejects invalid/injection table names", async () => {
  await withDb(async (db) => {
    const result = await db.dropSchema('evil"; DROP TABLE _genie_sessions; --');
    assertEquals(result.ok, false);
    if (result.ok) throw new Error("unreachable");
    assertEquals(result.error.code, "INVALID_NAME");
  });
});

// --- Regression tests ---

Deno.test("regression: rebuildTable does not corrupt column names containing table name", async () => {
  await withDb(async (db) => {
    const create = await db.defineSchema(
      "proj",
      "CREATE TABLE proj (id SERIAL PRIMARY KEY, proj_name TEXT NOT NULL, proj_owner TEXT)",
    );
    assertEquals(create.ok, true);

    await db.execute(
      "INSERT INTO proj (proj_name, proj_owner) VALUES ($1, $2)",
      ["alpha", "alice"],
    );

    const alter = await db.alterSchema(
      "proj",
      "CREATE TABLE proj (id SERIAL PRIMARY KEY, proj_name TEXT NOT NULL, proj_owner TEXT, proj_status TEXT)",
    );
    assertEquals(alter.ok, true);
    if (!alter.ok) throw new Error("unreachable");

    assertEquals(alter.data.columns.some((c) => c.name === "proj_name"), true);
    assertEquals(alter.data.columns.some((c) => c.name === "proj_owner"), true);
    assertEquals(
      alter.data.columns.some((c) => c.name === "proj_status"),
      true,
    );

    const rows = await db.query("SELECT * FROM proj");
    assertEquals(rows.length, 1);
    assertEquals(rows[0]?.proj_name, "alpha");
    assertEquals(rows[0]?.proj_owner, "alice");
  });
});

Deno.test("regression: alterSchema returns correct columns even when beforeCommit runs", async () => {
  await withDb(async (db) => {
    await db.defineSchema(
      "notes",
      "CREATE TABLE notes (id SERIAL PRIMARY KEY, body TEXT)",
    );
    await db.execute("INSERT INTO notes (body) VALUES ($1)", ["hello"]);

    const result = await db.alterSchema(
      "notes",
      "CREATE TABLE notes (id SERIAL PRIMARY KEY, body TEXT, tag TEXT DEFAULT 'general')",
    );
    assertEquals(result.ok, true);
    if (!result.ok) throw new Error("unreachable");

    assertEquals(result.data.columns.length, 3);
    assertEquals(result.data.columns[2]?.name, "tag");

    const schema = await db.getSchema("notes");
    assertEquals(schema.ok, true);
    if (!schema.ok) throw new Error("unreachable");
    assertEquals(schema.data.columns.length, 3);
  });
});

Deno.test("regression: rebuildTable handles quoted table name in CREATE TABLE", async () => {
  await withDb(async (db) => {
    const create = await db.defineSchema(
      "things",
      'CREATE TABLE "things" (id SERIAL PRIMARY KEY, val TEXT)',
    );
    assertEquals(create.ok, true);

    await db.execute("INSERT INTO things (val) VALUES ($1)", ["test"]);

    const alter = await db.alterSchema(
      "things",
      'CREATE TABLE "things" (id SERIAL PRIMARY KEY, val TEXT, extra INTEGER)',
    );
    assertEquals(alter.ok, true);
    if (!alter.ok) throw new Error("unreachable");

    const rows = await db.query("SELECT * FROM things");
    assertEquals(rows.length, 1);
    assertEquals(rows[0]?.val, "test");
  });
});

Deno.test("migration undo/redo handles initial CREATE TABLE metadata", async () => {
  await withDb(async (db) => {
    const create = await db.defineSchema(
      "undo_create",
      "CREATE TABLE undo_create (id SERIAL PRIMARY KEY, name TEXT)",
    );
    assertEquals(create.ok, true);

    const undo = await db.undoMigration("undo_create");
    assertEquals(undo.ok, true);
    assertEquals((await db.getSchema("undo_create")).ok, false);
    assertEquals(db.schemas.get("undo_create"), undefined);

    const redo = await db.redoMigration("undo_create");
    assertEquals(redo.ok, true);
    const schema = await db.getSchema("undo_create");
    assertEquals(schema.ok, true);
    if (!schema.ok) throw new Error("unreachable");
    assertEquals(schema.data.columns.map((c) => c.name), ["id", "name"]);
    assertExists(db.schemas.get("undo_create"));
  });
});

Deno.test("migration undo/redo handles DROP TABLE metadata", async () => {
  await withDb(async (db) => {
    await db.defineSchema(
      "undo_drop",
      "CREATE TABLE undo_drop (id SERIAL PRIMARY KEY, name TEXT)",
    );
    const drop = await db.dropSchema("undo_drop");
    assertEquals(drop.ok, true);
    assertEquals((await db.getSchema("undo_drop")).ok, false);

    const undo = await db.undoMigration("undo_drop");
    assertEquals(undo.ok, true);
    const restored = await db.getSchema("undo_drop");
    assertEquals(restored.ok, true);
    if (!restored.ok) throw new Error("unreachable");
    assertEquals(restored.data.columns.map((c) => c.name), ["id", "name"]);
    assertExists(db.schemas.get("undo_drop"));

    const redo = await db.redoMigration("undo_drop");
    assertEquals(redo.ok, true);
    assertEquals((await db.getSchema("undo_drop")).ok, false);
    assertEquals(db.schemas.get("undo_drop"), undefined);
  });
});

Deno.test("migration undo of ALTER TABLE preserves schema sql metadata", async () => {
  await withDb(async (db) => {
    await db.defineSchema(
      "undo_alter",
      "CREATE TABLE undo_alter (id SERIAL PRIMARY KEY, name TEXT)",
    );
    const alter = await db.alterSchema(
      "undo_alter",
      "ALTER TABLE undo_alter ADD COLUMN status TEXT",
    );
    assertEquals(alter.ok, true);

    const undo = await db.undoMigration("undo_alter");
    assertEquals(undo.ok, true);

    const schema = await db.getSchema("undo_alter");
    assertEquals(schema.ok, true);
    if (!schema.ok) throw new Error("unreachable");
    assertEquals(schema.data.columns.map((c) => c.name), ["id", "name"]);
    assertEquals(schema.data.sql.includes("DROP COLUMN"), false);
    // Undoing the ALTER leaves the base CREATE TABLE as the recreatable DDL.
    assertEquals(
      schema.data.sql,
      "CREATE TABLE undo_alter (id SERIAL PRIMARY KEY, name TEXT)",
    );

    const redo = await db.redoMigration("undo_alter");
    assertEquals(redo.ok, true);
    const redone = await db.getSchema("undo_alter");
    assertEquals(redone.ok, true);
    if (!redone.ok) throw new Error("unreachable");
    assertEquals(redone.data.columns.map((c) => c.name), [
      "id",
      "name",
      "status",
    ]);
    // Redo restores the cumulative DDL: base CREATE TABLE + the re-applied ALTER,
    // not just the incremental statement (which would lose the CREATE TABLE).
    assertEquals(
      redone.data.sql,
      "CREATE TABLE undo_alter (id SERIAL PRIMARY KEY, name TEXT);\n\nALTER TABLE undo_alter ADD COLUMN status TEXT",
    );
  });
});

Deno.test("defineSchema rejects multiple statements", async () => {
  await withDb(async (db) => {
    const result = await db.defineSchema(
      "t",
      "CREATE TABLE t (id INTEGER); DROP TABLE other;",
    );
    assertEquals(result.ok, false);
    if (result.ok) throw new Error("unreachable");
    assertEquals(result.error.code, "MULTIPLE_STATEMENTS");
    assertStringIncludes(result.error.suggestion ?? "", "alter_schema");
    assertStringIncludes(result.error.suggestion ?? "", "name TEXT UNIQUE");
  });
});

Deno.test("defineSchema allows a semicolon inside a string default", async () => {
  await withDb(async (db) => {
    const result = await db.defineSchema(
      "t",
      "CREATE TABLE t (id INTEGER, note TEXT DEFAULT 'a;b')",
    );
    assertEquals(result.ok, true);
  });
});

Deno.test("alterSchema rejects multiple statements", async () => {
  await withDb(async (db) => {
    const name = "alter_multi";
    await db.defineSchema(
      name,
      `CREATE TABLE ${name} (id SERIAL PRIMARY KEY, title TEXT)`,
    );
    const result = await db.alterSchema(
      name,
      `ALTER TABLE ${name} ADD COLUMN a int; DROP TABLE other;`,
    );
    assertEquals(result.ok, false);
    if (result.ok) throw new Error("unreachable");
    assertEquals(result.error.code, "MULTIPLE_STATEMENTS");
  });
});

Deno.test("alterSchema rejects multiple statements on the CREATE-TABLE rebuild path", async () => {
  await withDb(async (db) => {
    const name = "alter_multi_create";
    await db.defineSchema(
      name,
      `CREATE TABLE ${name} (id SERIAL PRIMARY KEY, title TEXT)`,
    );
    const result = await db.alterSchema(
      name,
      `CREATE TABLE ${name} (id SERIAL PRIMARY KEY, title TEXT, done int); DROP TABLE other;`,
    );
    assertEquals(result.ok, false);
    if (result.ok) throw new Error("unreachable");
    assertEquals(result.error.code, "MULTIPLE_STATEMENTS");
  });
});

Deno.test("isSingleStatement", () => {
  assertEquals(isSingleStatement("CREATE TABLE t (id int)"), true);
  assertEquals(isSingleStatement("CREATE TABLE t (id int);"), true);
  assertEquals(isSingleStatement("INSERT INTO t VALUES ('a;b')"), true);
  assertEquals(
    isSingleStatement("CREATE TABLE t (id int) -- ; not a statement"),
    true,
  );
  assertEquals(
    isSingleStatement("CREATE TABLE t (id int); DROP TABLE u"),
    false,
  );
  assertEquals(isSingleStatement("a; b"), false);
});
