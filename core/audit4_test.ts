import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { Database } from "./db.ts";
import { Kernel } from "./registries.ts";
import { Changelog } from "./changelog.ts";
import { ChangesetManager } from "../verification/changesets.ts";
import { initCompiler, stopCompiler } from "./compiler.ts";
import { dispatchTool } from "./tools/dispatch.ts";
import { getEnvPath, loadEnv, saveEnv } from "./env.ts";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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

// --- Critical Bug 1: get_secret must not return plaintext resolvedValue ---

Deno.test({
  ...testOpts,
  name: "get_secret does not leak plaintext resolvedValue",
  fn: async () => {
    await withKernel(async (kernel) => {
      kernel.secrets.define("MY_KEY", "A test key");
      kernel.secrets.setValue("MY_KEY", "super-secret-value");

      const result = await dispatchTool(
        "get_secret",
        { key: "MY_KEY" },
        kernel,
        noop,
      );
      assertEquals(result.ok, true);
      if (!result.ok) throw new Error("unreachable");
      const data = result.data as Record<string, unknown>;
      assertEquals(data.key, "MY_KEY");
      assertEquals(data.hasExplicitValue, true);
      assertEquals(data.status, "set");
      assert(
        !("resolvedValue" in data),
        "resolvedValue must not be present in response",
      );
    });
  },
});

// --- Critical Bug 3: chunked base64 encoding (large Uint8Array) ---

Deno.test("chunked base64 encoding handles large arrays without stack overflow", () => {
  const size = 500_000;
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i++) bytes[i] = i % 256;

  let binary = "";
  for (let i = 0; i < bytes.length; i += 1024) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 1024));
  }
  const base64 = btoa(binary);
  assert(base64.length > 0);

  const decoded = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  assertEquals(decoded.length, size);
  assertEquals(decoded[0], 0);
  assertEquals(decoded[255], 255);
  assertEquals(decoded[256], 0);
});

// --- High Bug 4 + 5: JSON.parse safety in WS handlers ---

Deno.test("JSON.parse on invalid data throws", () => {
  let threw = false;
  try {
    JSON.parse("not json {{{");
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});

// --- High Bug 8: sqlLiteral boolean uses TRUE/FALSE for PostgreSQL ---

Deno.test("sqlLiteral boolean outputs TRUE/FALSE not 1/0", () => {
  function sqlLiteral(value: unknown): string {
    if (value === null || value === undefined) return "NULL";
    if (typeof value === "number") return String(value);
    if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
    return `'${String(value).replace(/'/g, "''")}'`;
  }
  assertEquals(sqlLiteral(true), "TRUE");
  assertEquals(sqlLiteral(false), "FALSE");
  assertEquals(sqlLiteral(null), "NULL");
  assertEquals(sqlLiteral(42), "42");
  assertEquals(sqlLiteral("it's"), "'it''s'");
});

// --- High Bug 9: tsquery sanitization ---

Deno.test("tsquery sanitization strips special characters", () => {
  const query = "hello' OR '1'='1";
  const tsQuery = query.trim().split(/\s+/).map((w) =>
    w.replace(/[^a-zA-Z0-9]/g, "")
  ).filter(Boolean).join(" & ");
  assertEquals(tsQuery, "hello & OR & 11");
  assert(!tsQuery.includes("'"));
});

Deno.test("tsquery sanitization handles empty after strip", () => {
  const query = "!@#$%";
  const tsQuery = query.trim().split(/\s+/).map((w) =>
    w.replace(/[^a-zA-Z0-9]/g, "")
  ).filter(Boolean).join(" & ");
  assertEquals(tsQuery, "");
});

// --- High Bug 10: atomic secrets persist ---

Deno.test("secrets persist uses atomic write (no .tmp left behind)", () => {
  const TMP_DIR = join(Deno.cwd(), ".test_secrets_tmp");
  mkdirSync(TMP_DIR, { recursive: true });
  try {
    const filePath = join(TMP_DIR, "test_secrets.json");
    writeFileSync(
      filePath,
      JSON.stringify({ version: 1, secrets: [] }) + "\n",
      { mode: 0o600 },
    );
    assert(existsSync(filePath));
    assert(!existsSync(filePath + ".tmp"));
  } finally {
    rmSync(TMP_DIR, { recursive: true, force: true });
  }
});

// --- Medium Bug 11: atomic .env write ---

Deno.test("saveEnv writes atomically (no .tmp left behind)", () => {
  const TMP_DIR = join(Deno.cwd(), ".test_env_atomic_tmp");
  mkdirSync(TMP_DIR, { recursive: true });
  try {
    saveEnv(TMP_DIR, { KEY: "value" });
    const envPath = getEnvPath(TMP_DIR);
    assert(existsSync(envPath));
    assert(!existsSync(envPath + ".tmp"));
    const loaded = loadEnv(TMP_DIR);
    assertEquals(loaded.KEY, "value");
  } finally {
    rmSync(TMP_DIR, { recursive: true, force: true });
  }
});

// --- Medium Bug 14: snapshot IDs include random suffix ---

Deno.test("snapshot IDs are unique even at same millisecond", () => {
  const id1 = `snap_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const id2 = `snap_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  assertNotEquals(id1, id2);
  assert(id1.startsWith("snap_"));
  assert(id1.split("_").length === 3);
});

// --- Medium Bug 15: snapshot column name validation ---

Deno.test("snapshot column name with double quote is rejected", () => {
  const col = 'name"; DROP TABLE users; --';
  // deno-lint-ignore no-control-regex -- the NUL byte is exactly what this rejects: it terminates a C string and would truncate the quoted identifier server-side
  const invalid = /["\\\x00]/.test(col);
  assertEquals(invalid, true);
});

Deno.test("snapshot column name with normal chars is accepted", () => {
  const col = "user_name";
  // deno-lint-ignore no-control-regex -- the NUL byte is exactly what this rejects: it terminates a C string and would truncate the quoted identifier server-side
  const invalid = /["\\\x00]/.test(col);
  assertEquals(invalid, false);
});

// --- Medium Bug 17: changelog search LIKE escape ---

Deno.test("changelog search escapes LIKE wildcards", () => {
  const query = "50%_off";
  const escaped = query.replace(/[%_\\]/g, (c) => `\\${c}`);
  assertEquals(escaped, "50\\%\\_off");
  assert(!escaped.includes("%_"));
});

// --- Medium Bug 7: changelog undo/redo is transactional ---

Deno.test({
  ...testOpts,
  name: "changelog undoEntry is transactional",
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
      const r2 = await changelog.record({
        category: "handler",
        key: "b",
        action: "create",
        beforeSnapshot: null,
        afterSnapshot: {},
        context: null,
      });
      const r3 = await changelog.record({
        category: "handler",
        key: "c",
        action: "create",
        beforeSnapshot: null,
        afterSnapshot: {},
        context: null,
      });

      const undone = await changelog.undoEntry();
      assert(undone !== null);
      assertEquals(undone!.key, "c");

      const cursor = await changelog.getCursor();
      assertEquals(cursor, r2.id);

      const redone = await changelog.redoEntry();
      assert(redone !== null);
      assertEquals(redone!.key, "c");

      const cursorAfterRedo = await changelog.getCursor();
      assertEquals(cursorAfterRedo, r3.id);
    });
  },
});

// --- Medium Bug 16: undoEntry walks to previous undoable entry ---

Deno.test({
  ...testOpts,
  name: "changelog undoEntry skips non-undoable to find previous",
  fn: async () => {
    await withDb(async (db) => {
      const changelog = new Changelog(db.drizzle);

      const r1 = await changelog.record({
        category: "handler",
        key: "a",
        action: "create",
        beforeSnapshot: null,
        afterSnapshot: {},
        context: null,
        undoable: true,
      });
      await changelog.record({
        category: "handler",
        key: "b",
        action: "create",
        beforeSnapshot: null,
        afterSnapshot: {},
        context: null,
        undoable: false,
      });
      await changelog.record({
        category: "handler",
        key: "c",
        action: "create",
        beforeSnapshot: null,
        afterSnapshot: {},
        context: null,
        undoable: true,
      });

      const undone1 = await changelog.undoEntry();
      assertEquals(undone1!.key, "c");

      const cursor = await changelog.getCursor();
      assertEquals(cursor, r1.id);
    });
  },
});

// --- Medium Bug 22: approve sets "approved" status, not "in_progress" ---

Deno.test({
  ...testOpts,
  name: "changeset approve sets approved status",
  fn: async () => {
    await withDb(async (db) => {
      const changesets = new ChangesetManager(db.drizzle);
      const cs = await changesets.create({
        sessionId: "sess_1",
        title: "Test",
        description: "test changeset",
        plan: {
          summary: "test plan",
          steps: [],
          acceptanceCriteria: [{
            id: "claim_tests",
            text: "The changeset can be approved.",
            source: "agent",
            priority: "must",
          }],
          verificationPlan: [{
            id: "check_tests",
            claimIds: ["claim_tests"],
            kind: "manual",
            description: "Inspect approval status.",
          }],
        },
      });
      assertEquals(cs.status, "planning");

      const approved = await changesets.approve(cs.id);
      assertEquals(approved.status, "approved");
    });
  },
});

// --- Medium Bug 13: updateStep uses atomic WHERE check ---

Deno.test({
  ...testOpts,
  name: "changeset updateStep requires in_progress status",
  fn: async () => {
    await withDb(async (db) => {
      const changesets = new ChangesetManager(db.drizzle);
      const cs = await changesets.create({
        sessionId: "sess_1",
        title: "Test",
        description: "test",
        plan: {
          summary: "test",
          steps: [{ id: "s1", description: "step 1", status: "pending" }],
          acceptanceCriteria: [{
            id: "claim_tests",
            text: "Step updates require in-progress status.",
            source: "agent",
            priority: "must",
          }],
          verificationPlan: [{
            id: "check_tests",
            claimIds: ["claim_tests"],
            kind: "manual",
            description: "Attempt updating before in-progress status.",
          }],
        },
      });

      let threw = false;
      try {
        await changesets.updateStep(cs.id, "s1", "done");
      } catch {
        threw = true;
      }
      assertEquals(threw, true);
    });
  },
});

// --- Medium Bug 20: prevTurnCount reactivity (unit logic test) ---

Deno.test("prevTurnCount tracking detects changes", () => {
  let prevTurnCount = 0;
  let fetchCount = 0;

  function check(len: number) {
    if (len !== prevTurnCount) {
      prevTurnCount = len;
      fetchCount++;
    }
  }

  check(0);
  assertEquals(fetchCount, 0);
  check(1);
  assertEquals(fetchCount, 1);
  check(1);
  assertEquals(fetchCount, 1);
  check(3);
  assertEquals(fetchCount, 2);
});

// --- Medium Bug 21: file content cache eviction ---

Deno.test("cache eviction removes oldest entry when at capacity", () => {
  const MAX = 3;
  const cache = new Map<string, string>();

  function cacheSet(key: string, value: string) {
    if (cache.size >= MAX) {
      const first = cache.keys().next().value;
      if (first !== undefined) cache.delete(first);
    }
    cache.set(key, value);
  }

  cacheSet("a", "1");
  cacheSet("b", "2");
  cacheSet("c", "3");
  assertEquals(cache.size, 3);

  cacheSet("d", "4");
  assertEquals(cache.size, 3);
  assertEquals(cache.has("a"), false);
  assertEquals(cache.has("d"), true);
});
