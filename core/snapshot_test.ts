import { assert, assertEquals } from "@std/assert";
import { testComposition } from "../cli/test-composition.ts";
import { dispatchTool } from "./tools/dispatch.ts";
import { Kernel } from "./registries.ts";
import { Database } from "./db.ts";
import {
  compileFunction,
  compileHandler,
  initCompiler,
  stopCompiler,
} from "./compiler.ts";
import { createAppServer } from "./app-server.ts";

const TEST_PORT = 4002;

async function withCompiler<T>(fn: (kernel: Kernel) => Promise<T>): Promise<T> {
  await initCompiler();
  const db = await Database.create({ driver: "pglite" });
  const kernel = new Kernel(db);
  try {
    return await fn(kernel);
  } finally {
    await db.close();
    stopCompiler();
  }
}

const testOpts = { sanitizeResources: false, sanitizeOps: false };

Deno.test({
  ...testOpts,
  name: "Snapshot save and restore recovers full state",
  fn: async () => {
    await withCompiler(async (kernel) => {
      const appServer = createAppServer(kernel, TEST_PORT);
      const rebuild = () => appServer.rebuild();
      const deps = await kernel.compileDeps();

      try {
        await kernel.db.defineSchema(
          "items",
          "CREATE TABLE items (id SERIAL PRIMARY KEY, name TEXT NOT NULL)",
        );
        await kernel.db.execute("INSERT INTO items (name) VALUES ($1)", [
          "apple",
        ]);
        await kernel.db.execute("INSERT INTO items (name) VALUES ($1)", [
          "banana",
        ]);

        const listItemsSrc = `async function listItems(c: any) {
        const rows = await db.query("SELECT * FROM items ORDER BY id");
        return c.json({ items: rows });
      }`;
        const hResult = await compileHandler("listItems", listItemsSrc, deps);
        assertEquals(hResult.ok, true);
        if (!hResult.ok) throw new Error("unreachable");
        kernel.handlers.register("listItems", listItemsSrc, hResult.data);

        const fResult = await compileFunction(
          "double",
          `function double(n: number) { return n * 2; }`,
          deps,
        );
        assertEquals(fResult.ok, true);
        if (!fResult.ok) throw new Error("unreachable");
        kernel.functions.register(
          "double",
          `function double(n: number) { return n * 2; }`,
          fResult.data,
        );

        kernel.routes.register("GET", "/api/items", "listItems");
        kernel.configs.set("appName", "TestApp");
        rebuild();

        const res1 = await fetch(`http://localhost:${TEST_PORT}/api/items`);
        const data1 = await res1.json();
        assertEquals(data1.items.length, 2);
        assertEquals(data1.items[0].name, "apple");

        const meta = await kernel.snapshots.save(kernel, "before changes");
        assertEquals(meta.routeCount, 1);
        assertEquals(meta.handlerCount, 1);
        assertEquals(meta.functionCount, 1);
        assertEquals(meta.schemaCount, 1);
        assertEquals(meta.configKeyCount, 1);

        await kernel.db.execute("DELETE FROM items");
        await kernel.db.execute("INSERT INTO items (name) VALUES ($1)", [
          "cherry",
        ]);
        kernel.configs.set("appName", "ModifiedApp");
        kernel.configs.set("extra", 42);
        kernel.routes.unregister("GET", "/api/items");
        rebuild();

        const rows = await kernel.db.query("SELECT * FROM items");
        assertEquals(rows.length, 1);
        assertEquals(kernel.configs.get("appName"), "ModifiedApp");
        assertEquals(kernel.configs.get("extra"), 42);

        const res2 = await fetch(`http://localhost:${TEST_PORT}/api/items`);
        assertEquals(res2.status, 404);
        await res2.body?.cancel();

        const restoreResult = await kernel.snapshots.restore(
          meta.id,
          kernel,
          rebuild,
        );
        assertEquals(restoreResult.ok, true);

        const restoredRows = await kernel.db.query(
          "SELECT * FROM items ORDER BY id",
        );
        assertEquals(restoredRows.length, 2);
        assertEquals((restoredRows[0] as { name: string }).name, "apple");
        assertEquals((restoredRows[1] as { name: string }).name, "banana");

        assertEquals(kernel.configs.get("appName"), "TestApp");
        assertEquals(kernel.configs.get("extra"), undefined);

        assertEquals(kernel.routes.list().length, 1);
        assertEquals(kernel.handlers.list().length, 1);
        assertEquals(kernel.functions.list().length, 1);

        const res3 = await fetch(`http://localhost:${TEST_PORT}/api/items`);
        assertEquals(res3.status, 200);
        const data3 = await res3.json();
        assertEquals(data3.items.length, 2);

        assertEquals(await kernel.functions.call("double", 5), 10);
      } finally {
        await appServer.shutdown();
      }
    });
  },
});

Deno.test({
  ...testOpts,
  name: "Restore nonexistent snapshot returns error",
  fn: async () => {
    await withCompiler(async (kernel) => {
      const rebuild = () => {};
      const result = await kernel.snapshots.restore(
        "snap_nonexistent",
        kernel,
        rebuild,
      );
      assertEquals(result.ok, false);
      if (result.ok) throw new Error("unreachable");
      assertEquals(result.error.includes("not found"), true);
    });
  },
});

Deno.test({
  ...testOpts,
  name: "Snapshot restore preserves source runtime metadata",
  fn: async () => {
    await withCompiler(async (kernel) => {
      const deps = await kernel.compileDeps();
      const source = `function answer() { return 42; }`;
      const compiled = await compileFunction("answer", source, deps);
      assertEquals(compiled.ok, true);
      if (!compiled.ok) throw new Error("unreachable");
      kernel.functions.register(
        "answer",
        source,
        compiled.data,
        undefined,
        undefined,
        kernel.runtimeId,
        kernel.runtime.defaultLanguage,
      );

      const meta = await kernel.snapshots.save(kernel, "runtime metadata");
      kernel.functions.remove("answer");

      const restored = await kernel.snapshots.restore(
        meta.id,
        kernel,
        () => {},
      );
      assertEquals(restored.ok, true);
      const entry = kernel.functions.getEntry("answer");
      assertEquals(entry?.runtimeId, "typescript");
      assertEquals(entry?.language, "typescript");
      assertEquals(await kernel.functions.call("answer"), 42);
    });
  },
});

Deno.test({
  ...testOpts,
  name: "Snapshot rotation keeps max 20",
  fn: async () => {
    await withCompiler(async (kernel) => {
      for (let i = 0; i < 25; i++) {
        await kernel.snapshots.save(kernel, `snap ${i}`);
      }
      const list = kernel.snapshots.list();
      assertEquals(list.length, 20);
      assertEquals(list[0]!.description, "snap 5");
      assertEquals(list[19]!.description, "snap 24");
    });
  },
});

// --- Scoped auto-snapshots: alter_schema on a small table in a database with a
// large unrelated one. The large table's rows must never be read: on a 5GB
// project, reading them is what put the whole database in the heap and killed
// the server before the alter ran.

async function withTwoTables<T>(
  fn: (kernel: Kernel, sql: string[]) => Promise<T>,
): Promise<T> {
  await initCompiler();
  const db = await Database.create({ driver: "pglite" });
  const kernel = new Kernel(db, { composition: testComposition() });
  try {
    await db.defineSchema(
      "big",
      "CREATE TABLE big (id SERIAL PRIMARY KEY, body TEXT NOT NULL)",
    );
    await db.defineSchema(
      "small",
      "CREATE TABLE small (id SERIAL PRIMARY KEY, score REAL)",
    );
    await db.execute(
      `INSERT INTO big (body) SELECT repeat(md5(g::text), 32) FROM generate_series(1, 2000) g`,
    );
    await db.execute(
      `INSERT INTO small (score) SELECT g * 0.5 FROM generate_series(1, 50) g`,
    );
    // Every statement that reaches the database from here on.
    const sql: string[] = [];
    const query = db.query.bind(db);
    db.query = (s: string, p?: unknown[]) => {
      sql.push(s);
      return query(s, p);
    };
    return await fn(kernel, sql);
  } finally {
    await db.close();
    stopCompiler();
  }
}

const readsTable = (sql: string[], table: string) =>
  sql.filter((s) => new RegExp(`\\bFROM\\s+"?${table}"?(\\s|$)`, "i").test(s));

Deno.test({
  ...testOpts,
  name: "alter_schema on a small table never reads a large unrelated table",
  fn: async () => {
    await withTwoTables(async (kernel, sql) => {
      const altered = await dispatchTool(
        "alter_schema",
        {
          tableName: "small",
          sql: "ALTER TABLE small ALTER COLUMN score TYPE DOUBLE PRECISION",
        },
        kernel,
        () => {},
        { manualEdit: true },
      );
      assert(altered.ok, JSON.stringify(altered.error));
      assertEquals(readsTable(sql, "big"), []);

      const [meta] = kernel.snapshots.list();
      assertEquals(meta?.description, "auto: before alter_schema");
      assertEquals(meta?.rowsOmitted, [
        { tableName: "big", reason: "definition-only" },
      ]);
    });
  },
});

Deno.test({
  ...testOpts,
  name: "drop_schema snapshots only the dropped table's rows",
  fn: async () => {
    await withTwoTables(async (kernel, sql) => {
      const dropped = await dispatchTool(
        "drop_schema",
        { tableName: "small" },
        kernel,
        () => {},
        { manualEdit: true },
      );
      assert(dropped.ok, JSON.stringify(dropped.error));
      assertEquals(readsTable(sql, "big"), []);

      // Undo by restore: small comes back with its rows, big is not rebuilt.
      await kernel.db.execute("INSERT INTO big (body) VALUES ('after')");
      const [meta] = kernel.snapshots.list();
      const restored = await dispatchTool(
        "restore_snapshot",
        { id: meta!.id },
        kernel,
        () => {},
        { manualEdit: true },
      );
      assert(restored.ok, JSON.stringify(restored.error));
      assertEquals(readsTable(sql, "big"), []);
      const [small] = await kernel.db.query(
        "SELECT count(*)::int AS n FROM small",
      );
      assertEquals(small?.n, 50);
      const [big] = await kernel.db.query("SELECT count(*)::int AS n FROM big");
      assertEquals(big?.n, 2001);
    });
  },
});

Deno.test({
  ...testOpts,
  name:
    "restoring the alter's auto-snapshot rolls back that table and leaves the rest alone",
  fn: async () => {
    await withTwoTables(async (kernel) => {
      const altered = await dispatchTool(
        "alter_schema",
        { tableName: "small", sql: "ALTER TABLE small ADD COLUMN raw REAL" },
        kernel,
        () => {},
        { manualEdit: true },
      );
      assert(altered.ok, JSON.stringify(altered.error));
      await kernel.db.execute("UPDATE small SET raw = 1, score = 0");
      await kernel.db.execute("INSERT INTO big (body) VALUES ('after')");

      const [meta] = kernel.snapshots.list();
      const restored = await kernel.snapshots.restore(
        meta!.id,
        kernel,
        () => {},
      );
      assert(restored.ok);
      const cols = await kernel.db.query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_name = 'small' ORDER BY ordinal_position`,
      );
      assertEquals(cols.map((c) => c.column_name), ["id", "score"]);
      const [row] = await kernel.db.query(
        "SELECT score FROM small WHERE id = 2",
      );
      assertEquals(row?.score, 1);
      // The row written after the snapshot is still there: big was not rebuilt.
      const [big] = await kernel.db.query("SELECT count(*)::int AS n FROM big");
      assertEquals(big?.n, 2001);
    });
  },
});

Deno.test({
  ...testOpts,
  name:
    "a table over the row budget is snapshotted definition-only and restore leaves it be",
  fn: async () => {
    await withTwoTables(async (kernel, sql) => {
      const warn = console.warn;
      const warned: string[] = [];
      console.warn = (m: string) => warned.push(m);
      let meta;
      try {
        meta = await kernel.snapshots.save(kernel, "budgeted", {
          rowBytesLimit: 10_000,
        });
      } finally {
        console.warn = warn;
      }
      assertEquals(meta.rowsOmitted, [
        { tableName: "big", reason: "too-large" },
      ]);
      assert(warned.some((w) => w.includes('"big"')), "a warning names it");
      assertEquals(
        readsTable(sql, "big").filter((s) => s.includes("SELECT *")),
        [],
      );

      await kernel.db.execute("DELETE FROM big WHERE id > 10");
      await kernel.db.execute("DELETE FROM small WHERE id > 10");
      const restored = await kernel.snapshots.restore(
        meta.id,
        kernel,
        () => {},
      );
      assert(restored.ok);
      const [small] = await kernel.db.query(
        "SELECT count(*)::int AS n FROM small",
      );
      assertEquals(small?.n, 50, "small's rows came back");
      const [big] = await kernel.db.query("SELECT count(*)::int AS n FROM big");
      assertEquals(big?.n, 10, "big was left as it stood");
    });
  },
});

Deno.test({
  ...testOpts,
  name: "retained snapshots are capped by the bytes of rows they hold",
  fn: async () => {
    await withTwoTables(async (kernel) => {
      const first = await kernel.snapshots.save(kernel, "one");
      assert((first.rowBytes ?? 0) > 0);
      const limit = Math.floor(first.rowBytes! * 2.5);
      for (const d of ["two", "three", "four"]) {
        await kernel.snapshots.save(kernel, d, { retainedBytesLimit: limit });
      }
      assertEquals(
        kernel.snapshots.list().map((s) => s.description),
        ["three", "four"],
      );
      // Definition-only snapshots cost nothing and are kept up to maxSnapshots.
      for (let i = 0; i < 5; i++) {
        await kernel.snapshots.save(kernel, `code ${i}`, {
          rows: false,
          retainedBytesLimit: limit,
        });
      }
      assertEquals(kernel.snapshots.list().length, 7);
    });
  },
});
