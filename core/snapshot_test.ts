import { assertEquals } from "@std/assert";
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

        assertEquals(kernel.functions.call("double", 5), 10);
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
      assertEquals(kernel.functions.call("answer"), 42);
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
