import { assertEquals } from "@std/assert";
import { createDatabase } from "./factory.ts";
import { Changelog } from "../changelog.ts";

const CHANGELOG_DDL = `CREATE TABLE IF NOT EXISTS _genie_changelog (
  id SERIAL PRIMARY KEY,
  category TEXT NOT NULL,
  key TEXT NOT NULL,
  action TEXT NOT NULL,
  before_snapshot JSONB,
  after_snapshot JSONB,
  context JSONB,
  created_at TEXT NOT NULL,
  undoable BOOLEAN NOT NULL DEFAULT true,
  turn_id TEXT,
  changeset_id TEXT,
  rationale TEXT,
  implementation TEXT,
  work_message_id INTEGER,
  actor_user_id TEXT
)`;

const META_DDL = `CREATE TABLE IF NOT EXISTS _genie_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
)`;

async function withLog(fn: (log: Changelog) => Promise<void>): Promise<void> {
  const conn = await createDatabase({ driver: "pglite" });
  await conn.drizzle.execute(CHANGELOG_DDL);
  await conn.drizzle.execute(META_DDL);
  const log = new Changelog(conn.drizzle);
  try {
    await fn(log);
  } finally {
    await conn.close();
  }
}

async function recordHandler(log: Changelog, key: string, turnId?: string) {
  return log.record({
    category: "handler",
    key,
    action: "create",
    beforeSnapshot: null,
    afterSnapshot: { source: `function ${key}() {}` },
    context: turnId ? { turnId } : null,
  });
}

Deno.test("record creates an entry and sets cursor", async () => {
  await withLog(async (log) => {
    const entry = await recordHandler(log, "hello");
    assertEquals(entry.category, "handler");
    assertEquals(entry.key, "hello");
    assertEquals(entry.undoable, true);
    assertEquals(entry.afterSnapshot, { source: "function hello() {}" });
    assertEquals(await log.getCursor(), entry.id);
  });
});

Deno.test("record with context stores json", async () => {
  await withLog(async (log) => {
    const entry = await log.record({
      category: "route",
      key: "GET /api",
      action: "create",
      beforeSnapshot: null,
      afterSnapshot: { method: "GET", path: "/api" },
      context: { turnId: "t1", userMessage: "add route" },
    });
    assertEquals(entry.context?.turnId, "t1");
    assertEquals(entry.context?.userMessage, "add route");
  });
});

Deno.test("workblock metadata updates and round-trips", async () => {
  await withLog(async (log) => {
    const entry = await recordHandler(log, "hello", "turn1");
    const updated = await log.updateWorkblockMetadata(entry.id, {
      rationale: "Explain why.",
      implementation: "Explain how.",
      workMessageId: 42,
    });

    assertEquals(updated?.rationale, "Explain why.");
    assertEquals(updated?.implementation, "Explain how.");
    assertEquals(updated?.workMessageId, 42);

    const fetched = await log.get(entry.id);
    assertEquals(fetched?.rationale, "Explain why.");
    assertEquals(fetched?.implementation, "Explain how.");
    assertEquals(fetched?.workMessageId, 42);
  });
});

Deno.test("get retrieves by id", async () => {
  await withLog(async (log) => {
    const entry = await recordHandler(log, "test");
    const fetched = await log.get(entry.id);
    assertEquals(fetched?.key, "test");
  });
});

Deno.test("get returns null for missing id", async () => {
  await withLog(async (log) => {
    assertEquals(await log.get(999), null);
  });
});

Deno.test("list returns entries in reverse order", async () => {
  await withLog(async (log) => {
    await recordHandler(log, "a");
    await recordHandler(log, "b");
    await recordHandler(log, "c");
    const list = await log.list({ limit: 10 });
    assertEquals(list.length, 3);
    assertEquals(list[0]!.key, "c");
    assertEquals(list[2]!.key, "a");
  });
});

Deno.test("list filters by category", async () => {
  await withLog(async (log) => {
    await recordHandler(log, "h1");
    await log.record({
      category: "route",
      key: "r1",
      action: "create",
      beforeSnapshot: null,
      afterSnapshot: null,
      context: null,
    });
    const handlers = await log.list({ category: "handler" });
    assertEquals(handlers.length, 1);
    assertEquals(handlers[0]!.key, "h1");
  });
});

Deno.test("count returns total entries", async () => {
  await withLog(async (log) => {
    assertEquals(await log.count(), 0);
    await recordHandler(log, "a");
    await recordHandler(log, "b");
    assertEquals(await log.count(), 2);
  });
});

Deno.test("undo/redo single entry", async () => {
  await withLog(async (log) => {
    const e1 = await recordHandler(log, "first");
    const e2 = await recordHandler(log, "second");

    const undone = await log.undoEntry();
    assertEquals(undone?.key, "second");
    assertEquals(await log.getCursor(), e1.id);

    const redone = await log.redoEntry();
    assertEquals(redone?.key, "second");
    assertEquals(await log.getCursor(), e2.id);
  });
});

Deno.test("undo past beginning clears cursor", async () => {
  await withLog(async (log) => {
    await recordHandler(log, "only");
    await log.undoEntry();
    assertEquals(await log.getCursor(), null);
  });
});

Deno.test("redo from null cursor returns first entry", async () => {
  await withLog(async (log) => {
    const e = await recordHandler(log, "first");
    await log.undoEntry();
    const redone = await log.redoEntry();
    assertEquals(redone?.id, e.id);
  });
});

Deno.test("redo returns null when at end", async () => {
  await withLog(async (log) => {
    await recordHandler(log, "only");
    assertEquals(await log.redoEntry(), null);
  });
});

Deno.test("undo returns null when cursor is null", async () => {
  await withLog(async (log) => {
    assertEquals(await log.undoEntry(), null);
  });
});

Deno.test("record after undo truncates future", async () => {
  await withLog(async (log) => {
    await recordHandler(log, "a");
    await recordHandler(log, "b");
    await recordHandler(log, "c");

    await log.undoEntry(); // undo c, cursor at b
    await log.undoEntry(); // undo b, cursor at a

    await recordHandler(log, "d");
    assertEquals(await log.count(), 2); // a and d, b and c deleted
    const list = await log.list({ limit: 10 });
    assertEquals(list[0]!.key, "d");
    assertEquals(list[1]!.key, "a");
  });
});

Deno.test("undoTurnEntries undoes all entries in a turn", async () => {
  await withLog(async (log) => {
    await recordHandler(log, "before");
    await recordHandler(log, "h1", "turn1");
    await recordHandler(log, "h2", "turn1");

    const entries = await log.undoTurnEntries();
    assertEquals(entries?.length, 2);
    assertEquals(entries?.[0]?.key, "h2");
    assertEquals(entries?.[1]?.key, "h1");
  });
});

Deno.test("redoTurnEntries redoes all entries in a turn", async () => {
  await withLog(async (log) => {
    await recordHandler(log, "h1", "turn1");
    await recordHandler(log, "h2", "turn1");

    await log.undoTurnEntries();
    const entries = await log.redoTurnEntries();
    assertEquals(entries?.length, 2);
    assertEquals(entries?.[0]?.key, "h1");
    assertEquals(entries?.[1]?.key, "h2");
  });
});

Deno.test("goTo navigates backward", async () => {
  await withLog(async (log) => {
    const e1 = await recordHandler(log, "a");
    await recordHandler(log, "b");
    await recordHandler(log, "c");

    const result = await log.goTo(e1.id);
    assertEquals(result?.undo.length, 2);
    assertEquals(result?.undo[0]?.key, "c");
    assertEquals(result?.undo[1]?.key, "b");
    assertEquals(result?.redo.length, 0);
    assertEquals(await log.getCursor(), e1.id);
  });
});

Deno.test("goTo navigates forward", async () => {
  await withLog(async (log) => {
    const e1 = await recordHandler(log, "a");
    const _e2 = await recordHandler(log, "b");
    const e3 = await recordHandler(log, "c");

    await log.goTo(e1.id);
    const result = await log.goTo(e3.id);
    assertEquals(result?.redo.length, 2);
    assertEquals(result?.redo[0]?.key, "b");
    assertEquals(result?.redo[1]?.key, "c");
    assertEquals(result?.undo.length, 0);
  });
});

Deno.test("goTo returns null for missing target", async () => {
  await withLog(async (log) => {
    await recordHandler(log, "a");
    assertEquals(await log.goTo(999), null);
  });
});

Deno.test("meta get/set/delete", async () => {
  await withLog(async (log) => {
    assertEquals(await log.getMeta("foo"), null);
    await log.setMeta("foo", "bar");
    assertEquals(await log.getMeta("foo"), "bar");
    await log.setMeta("foo", "baz");
    assertEquals(await log.getMeta("foo"), "baz");
    await log.deleteMeta("foo");
    assertEquals(await log.getMeta("foo"), null);
  });
});

Deno.test("entityHistory returns filtered history", async () => {
  await withLog(async (log) => {
    await recordHandler(log, "hello");
    await recordHandler(log, "hello");
    await recordHandler(log, "other");
    const history = await log.entityHistory("handler", "hello");
    assertEquals(history.length, 2);
  });
});

Deno.test("recent returns lightweight entries", async () => {
  await withLog(async (log) => {
    await recordHandler(log, "a");
    await recordHandler(log, "b");
    const recent = await log.recent(5);
    assertEquals(recent.length, 2);
    assertEquals(recent[0]!.key, "b");
    assertEquals(typeof recent[0]!.undoable, "boolean");
  });
});

Deno.test("listByChangeset returns changes for a changeset", async () => {
  await withLog(async (log) => {
    await log.record({
      category: "handler",
      key: "h1",
      action: "create",
      beforeSnapshot: null,
      afterSnapshot: null,
      context: { changesetId: "cs1" },
    });
    await log.record({
      category: "handler",
      key: "h2",
      action: "create",
      beforeSnapshot: null,
      afterSnapshot: null,
      context: { changesetId: "cs1" },
    });
    await log.record({
      category: "handler",
      key: "h3",
      action: "create",
      beforeSnapshot: null,
      afterSnapshot: null,
      context: { changesetId: "cs2" },
    });
    const changes = await log.listByChangeset("cs1");
    assertEquals(changes.length, 2);
    assertEquals(changes[0]!.key, "h1");
  });
});

Deno.test("search finds by key", async () => {
  await withLog(async (log) => {
    await recordHandler(log, "createUser");
    await recordHandler(log, "deleteUser");
    await recordHandler(log, "listOrders");
    const results = await log.search("User");
    assertEquals(results.length, 2);
  });
});

Deno.test("listTurns groups by turnId", async () => {
  await withLog(async (log) => {
    await recordHandler(log, "h1", "turn1");
    await recordHandler(log, "h2", "turn1");
    await recordHandler(log, "h3", "turn2");
    const turns = await log.listTurns(10);
    assertEquals(turns.length, 2);
    const t1 = turns.find((t) => t.turnId === "turn1");
    assertEquals(t1?.changes.length, 2);
  });
});

Deno.test("listTurns only includes snapshots when requested", async () => {
  await withLog(async (log) => {
    await recordHandler(log, "h1", "turn1");

    const lightTurns = await log.listTurns(10);
    assertEquals(lightTurns[0]?.changes[0]?.afterSnapshot, null);

    const fullTurns = await log.listTurns(10, { includeSnapshots: true });
    assertEquals(fullTurns[0]?.changes[0]?.afterSnapshot, {
      source: "function h1() {}",
    });
  });
});

Deno.test("non-undoable entries are skipped in undo/redo", async () => {
  await withLog(async (log) => {
    const _e1 = await recordHandler(log, "undoable");
    await log.record({
      category: "config",
      key: "counter",
      action: "update",
      beforeSnapshot: 0,
      afterSnapshot: 1,
      context: null,
      undoable: false,
    });

    const undone = await log.undoEntry();
    assertEquals(undone?.key, "undoable");
  });
});
