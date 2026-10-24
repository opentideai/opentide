import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Database } from "./db.ts";
import {
  deleteDataFixture,
  exportDataFixture,
  importDataFixture,
  resetDataTables,
} from "./data-fixtures.ts";

async function withProjectDb(
  fn: (db: Database, projectDir: string) => Promise<void>,
): Promise<void> {
  const projectDir = await Deno.makeTempDir({
    dir: "/private/tmp",
    prefix: "tideide-fixtures-",
  });
  const db = await Database.create({
    driver: "pglite",
    dataDir: join(projectDir, "data"),
    schemaDir: join(projectDir, ".opentide", "state", "schemas"),
  });
  try {
    await fn(db, projectDir);
  } finally {
    await db.close();
    rmSync(projectDir, { recursive: true, force: true });
  }
}

Deno.test("exportDataFixture writes mergeable table JSON files", async () => {
  await withProjectDb(async (db, projectDir) => {
    await db.defineSchema(
      "items",
      "CREATE TABLE items (id SERIAL PRIMARY KEY, name TEXT NOT NULL, quantity INTEGER NOT NULL)",
    );
    await db.execute(
      "INSERT INTO items (name, quantity) VALUES ($1, $2), ($3, $4)",
      ["banana", 2, "apple", 1],
    );

    const result = await exportDataFixture(db, projectDir);

    assertEquals(result.files, ["manifest.json", "items.json"]);
    assertEquals(result.manifest.tables[0]?.tableName, "items");
    assertEquals(result.manifest.tables[0]?.rowCount, 2);
    const tablePath = join(projectDir, "fixtures", "default", "items.json");
    assertEquals(existsSync(tablePath), true);
    const tableJson = readFileSync(tablePath, "utf-8");
    assertStringIncludes(tableJson, `"tableName": "items"`);
    assertStringIncludes(tableJson, `"name": "banana"`);
  });
});

Deno.test("importDataFixture restores rows after local data reset", async () => {
  await withProjectDb(async (db, projectDir) => {
    await db.defineSchema(
      "items",
      "CREATE TABLE items (id SERIAL PRIMARY KEY, name TEXT NOT NULL)",
    );
    await db.execute("INSERT INTO items (name) VALUES ($1), ($2)", [
      "one",
      "two",
    ]);
    await exportDataFixture(db, projectDir, { name: "seed" });

    await resetDataTables(db);
    assertEquals(
      Number((await db.query("SELECT COUNT(*) AS count FROM items"))[0]!.count),
      0,
    );

    const imported = await importDataFixture(db, projectDir, { name: "seed" });

    assertEquals(imported.imported, 2);
    const rows = await db.query("SELECT name FROM items ORDER BY id");
    assertEquals(rows.map((row) => row.name), ["one", "two"]);
  });
});

Deno.test("importDataFixture append mode preserves existing rows", async () => {
  await withProjectDb(async (db, projectDir) => {
    await db.defineSchema(
      "items",
      "CREATE TABLE items (name TEXT NOT NULL)",
    );
    await db.execute("INSERT INTO items (name) VALUES ($1)", ["fixture"]);
    await exportDataFixture(db, projectDir);
    await db.execute("INSERT INTO items (name) VALUES ($1)", ["existing"]);

    await importDataFixture(db, projectDir, { mode: "append" });

    const rows = await db.query("SELECT name FROM items ORDER BY name");
    assertEquals(rows.map((row) => row.name), [
      "existing",
      "fixture",
      "fixture",
    ]);
  });
});

Deno.test("deleteDataFixture removes a saved fixture directory", async () => {
  await withProjectDb(async (db, projectDir) => {
    await db.defineSchema(
      "items",
      "CREATE TABLE items (name TEXT NOT NULL)",
    );
    await db.execute("INSERT INTO items (name) VALUES ($1)", ["fixture"]);
    await exportDataFixture(db, projectDir, { name: "seed" });

    const fixturePath = join(projectDir, "fixtures", "seed");
    assertEquals(existsSync(fixturePath), true);

    const deleted = deleteDataFixture(projectDir, "seed");

    assertEquals(deleted.deleted, true);
    assertEquals(deleted.name, "seed");
    assertEquals(existsSync(fixturePath), false);
  });
});

Deno.test("deleteDataFixture validates names before removal", () => {
  const projectDir = "/";

  assertThrows(
    () => deleteDataFixture(projectDir, "../seed"),
    Error,
    "Fixture name must contain only",
  );
  assertThrows(
    () => deleteDataFixture(projectDir, ""),
    Error,
    "Fixture name must contain only",
  );
});

Deno.test("schema state plus fixture rows rebuild local data", async () => {
  const projectDir = await Deno.makeTempDir({
    dir: "/private/tmp",
    prefix: "tideide-fixtures-rebuild-",
  });
  const schemaDir = join(projectDir, ".opentide", "state", "schemas");
  let db = await Database.create({
    driver: "pglite",
    dataDir: join(projectDir, "data"),
    schemaDir,
  });
  try {
    await db.defineSchema(
      "items",
      "CREATE TABLE items (id SERIAL PRIMARY KEY, name TEXT NOT NULL)",
    );
    await db.execute("INSERT INTO items (name) VALUES ($1)", ["seeded"]);
    await exportDataFixture(db, projectDir);
  } finally {
    await db.close();
  }

  rmSync(join(projectDir, "data"), { recursive: true, force: true });
  db = await Database.create({
    driver: "pglite",
    dataDir: join(projectDir, "data"),
    schemaDir,
  });
  try {
    assertEquals(
      Number((await db.query("SELECT COUNT(*) AS count FROM items"))[0]!.count),
      0,
    );
    await importDataFixture(db, projectDir);
    const rows = await db.query("SELECT name FROM items");
    assertEquals(rows[0]?.name, "seeded");
  } finally {
    await db.close();
    rmSync(projectDir, { recursive: true, force: true });
  }
});
