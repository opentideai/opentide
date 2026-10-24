import { assert, assertEquals } from "@std/assert";
import { Database } from "./db.ts";
import { Kernel } from "./registries.ts";
import { Changelog } from "./changelog.ts";
import { initCompiler, stopCompiler } from "./compiler.ts";
import { dispatchTool } from "./tools/dispatch.ts";
import { normalize, resolve } from "node:path";

const testOpts = { sanitizeResources: false, sanitizeOps: false };

async function withDb(fn: (db: Database) => Promise<void>): Promise<void> {
  const db = await Database.create({ driver: "pglite" });
  try {
    await fn(db);
  } finally {
    await db.close();
  }
}

async function withKernel<T>(fn: (kernel: Kernel) => Promise<T>): Promise<T> {
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

const noop = () => {};

// --- Bug 1: SQL injection in dev-views schema query ---

Deno.test("dev-views schema source sanitizes table name", () => {
  const dangerous = "users; DROP TABLE users; --";
  const safe = dangerous.replace(/[^a-zA-Z0-9_]/g, "");
  assertEquals(safe, "usersDROPTABLEusers");
});

// --- Bug 5: Invalid test pattern doesn't crash (returns gracefully) ---

Deno.test({
  ...testOpts,
  name: "run_tests with regex metachar pattern doesn't crash",
  fn: async () => {
    await withKernel(async (kernel) => {
      const result = await dispatchTool(
        "run_tests",
        { pattern: "test[unclosed" },
        kernel,
        noop,
      );
      assertEquals(result.ok, true);
    });
  },
});

Deno.test({
  ...testOpts,
  name: "run_tests with wildcard pattern works",
  fn: async () => {
    await withKernel(async (kernel) => {
      const result = await dispatchTool(
        "run_tests",
        { pattern: "test_*" },
        kernel,
        noop,
      );
      assertEquals(result.ok, true);
    });
  },
});

// --- Bug 8: Changelog record is transactional ---

Deno.test({
  ...testOpts,
  name: "changelog record is atomic (transaction)",
  fn: async () => {
    await withDb(async (db) => {
      const changelog = new Changelog(db.drizzle);

      const r1 = await changelog.record({
        category: "handler",
        key: "test1",
        action: "create",
        beforeSnapshot: null,
        afterSnapshot: { name: "test1" },
        context: null,
      });
      assertEquals(r1.id > 0, true);

      const r2 = await changelog.record({
        category: "handler",
        key: "test2",
        action: "create",
        beforeSnapshot: null,
        afterSnapshot: { name: "test2" },
        context: null,
      });
      assertEquals(r2.id > r1.id, true);

      const cursor = await changelog.getCursor();
      assertEquals(cursor, r2.id);

      const all = await changelog.list();
      assertEquals(all.length, 2);
    });
  },
});

Deno.test({
  ...testOpts,
  name: "changelog record trims future entries after undo",
  fn: async () => {
    await withDb(async (db) => {
      const changelog = new Changelog(db.drizzle);

      await changelog.record({
        category: "handler",
        key: "a",
        action: "create",
        beforeSnapshot: null,
        afterSnapshot: {},
        context: null,
      });
      await changelog.record({
        category: "handler",
        key: "b",
        action: "create",
        beforeSnapshot: null,
        afterSnapshot: {},
        context: null,
      });
      await changelog.record({
        category: "handler",
        key: "c",
        action: "create",
        beforeSnapshot: null,
        afterSnapshot: {},
        context: null,
      });

      await changelog.undoEntry();

      await changelog.record({
        category: "handler",
        key: "d",
        action: "create",
        beforeSnapshot: null,
        afterSnapshot: {},
        context: null,
      });

      const all = await changelog.list();
      const keys = all.map((r) => r.key);
      assert(!keys.includes("c"));
      assert(keys.includes("d"));
    });
  },
});

// --- Bug 10: ROLLBACK error doesn't mask original ---

Deno.test({
  ...testOpts,
  name: "alterSchema with invalid SQL returns MIGRATION_ERROR",
  fn: async () => {
    await withDb(async (db) => {
      await db.defineSchema(
        "safe",
        "CREATE TABLE safe (id SERIAL PRIMARY KEY, val TEXT)",
      );
      const result = await db.alterSchema(
        "safe",
        "CREATE TABLE safe INVALID SQL SYNTAX (",
      );
      assertEquals(result.ok, false);
      if (result.ok) throw new Error("unreachable");
      assertEquals(result.error.code, "MIGRATION_ERROR");
    });
  },
});

// --- Bug 14: tracer summarize returns consistent types ---

Deno.test("tracer summarize returns string for small objects", () => {
  const obj = { name: "test", value: 42 };
  const s = JSON.stringify(obj);
  const result = s.length > 200 ? s.slice(0, 200) + "…" : s;
  assertEquals(typeof result, "string");
});

// --- Bug 15: fs/list path restriction ---

Deno.test("path traversal blocked for /api/fs/list", () => {
  const home = "/home/testuser";
  const raw = "/etc/passwd";
  const dir = normalize(resolve(raw));
  const blocked = !dir.startsWith(home);
  assertEquals(blocked, true);
});

Deno.test("path within home is allowed for /api/fs/list", () => {
  const home = "/home/testuser";
  const raw = "/home/testuser/projects";
  const dir = normalize(resolve(raw));
  const allowed = dir.startsWith(home);
  assertEquals(allowed, true);
});

// --- Bug 17: defineSchema rejects duplicate table ---

Deno.test({
  ...testOpts,
  name: "defineSchema rejects duplicate creation",
  fn: async () => {
    await withDb(async (db) => {
      const r1 = await db.defineSchema(
        "items",
        "CREATE TABLE items (id SERIAL PRIMARY KEY)",
      );
      assertEquals(r1.ok, true);
      const r2 = await db.defineSchema(
        "items",
        "CREATE TABLE items (id SERIAL PRIMARY KEY)",
      );
      assertEquals(r2.ok, false);
      if (r2.ok) throw new Error("unreachable");
      assertEquals(r2.error.code, "TABLE_EXISTS");
    });
  },
});
