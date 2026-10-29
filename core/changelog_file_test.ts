import { assertEquals } from "@std/assert";
import { existsSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Changelog } from "./changelog.ts";
import { TEST_TMP_DIR } from "./test-home_test.ts";

async function withFileLog(
  fn: (log: Changelog, historyDir: string) => Promise<void>,
): Promise<void> {
  const historyDir = await Deno.makeTempDir({
    dir: TEST_TMP_DIR,
    prefix: "tideide-changelog-",
  });
  const log = new Changelog(historyDir);
  try {
    await fn(log, historyDir);
  } finally {
    rmSync(historyDir, { recursive: true, force: true });
  }
}

async function recordHandler(log: Changelog, key: string, turnId?: string) {
  return await log.record({
    category: "handler",
    key,
    action: "create",
    beforeSnapshot: null,
    afterSnapshot: { source: `function ${key}() {}` },
    context: turnId ? { turnId, userMessage: `make ${key}` } : null,
  });
}

Deno.test("file changelog writes one record file per change and persists cursor", async () => {
  await withFileLog(async (log, historyDir) => {
    const first = await recordHandler(log, "first");
    const second = await recordHandler(log, "second");

    assertEquals(first.id === second.id, false);
    assertEquals(first.id > Date.now() * 1000 - 1_000_000, true);
    assertEquals(await log.getCursor(), second.id);
    assertEquals((await log.get(first.id))?.key, "first");

    const recordsDir = join(historyDir, "changelog", "records");
    assertEquals(existsSync(recordsDir), true);
    assertEquals(
      readdirSync(recordsDir).filter((f) => f.endsWith(".json")).length,
      2,
    );

    const reloaded = new Changelog(historyDir);
    assertEquals((await reloaded.list({ limit: 1 }))[0]!.key, "second");
    assertEquals(await reloaded.getCursor(), second.id);
  });
});

Deno.test("file changelog keeps concurrent actor attribution isolated", async () => {
  await withFileLog(async (log) => {
    const [first, second] = await Promise.all([
      log.withActor("account_a", async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return await recordHandler(log, "first");
      }),
      log.withActor(
        "account_b",
        async () => await recordHandler(log, "second"),
      ),
    ]);

    assertEquals(first.actorUserId, "account_a");
    assertEquals(second.actorUserId, "account_b");
  });
});

Deno.test("file changelog recovers records after an interrupted swap", async () => {
  await withFileLog(async (log, historyDir) => {
    await recordHandler(log, "first");
    await recordHandler(log, "second");
    // A rewrite (e.g. metadata update) goes through writeFileRecords.
    const entry = await recordHandler(log, "third");
    await log.updateWorkblockMetadata(entry.id, { rationale: "why" });

    // Simulate a crash that left the staged dir in place but removed the live
    // records dir before the final rename completed.
    const recordsDir = join(historyDir, "changelog", "records");
    renameSync(recordsDir, recordsDir + ".tmp");
    assertEquals(existsSync(recordsDir), false);

    const reloaded = new Changelog(historyDir);
    assertEquals(await reloaded.count(), 3);
    assertEquals(
      (await reloaded.list({ limit: 3 })).map((r) => r.key),
      ["third", "second", "first"],
    );
    // Recovery promoted the staged dir back into place.
    assertEquals(existsSync(recordsDir), true);
    assertEquals(existsSync(recordsDir + ".tmp"), false);
  });
});

Deno.test("file changelog persists workblock metadata", async () => {
  await withFileLog(async (log, historyDir) => {
    const entry = await recordHandler(log, "hello");
    await log.updateWorkblockMetadata(entry.id, {
      rationale: "Explain why.",
      implementation: "Explain how.",
      workMessageId: 7,
    });

    const reloaded = new Changelog(historyDir);
    const fetched = await reloaded.get(entry.id);
    assertEquals(fetched?.rationale, "Explain why.");
    assertEquals(fetched?.implementation, "Explain how.");
    assertEquals(fetched?.workMessageId, 7);
  });
});

Deno.test("file changelog keeps append-only history after undo", async () => {
  await withFileLog(async (log) => {
    await recordHandler(log, "a");
    await recordHandler(log, "b");
    await recordHandler(log, "c");
    await log.undoEntry();
    await log.undoEntry();

    await recordHandler(log, "d");

    const latest = (await log.list({ limit: 1 }))[0]!;
    assertEquals(await log.count(), 4);
    assertEquals((await log.list({ limit: 4 })).map((r) => r.key), [
      "d",
      "c",
      "b",
      "a",
    ]);
    assertEquals(await log.getCursor(), latest.id);
  });
});

Deno.test("file changelog supports undo and redo by turn", async () => {
  await withFileLog(async (log) => {
    const before = await recordHandler(log, "before");
    await recordHandler(log, "h1", "turn1");
    const h2 = await recordHandler(log, "h2", "turn1");

    const undone = await log.undoTurnEntries();
    assertEquals(undone?.map((r) => r.key), ["h2", "h1"]);
    assertEquals(await log.getCursor(), before.id);

    const redone = await log.redoTurnEntries();
    assertEquals(redone?.map((r) => r.key), ["h1", "h2"]);
    assertEquals(await log.getCursor(), h2.id);
  });
});

Deno.test("file changelog supports metadata and search helpers", async () => {
  await withFileLog(async (log) => {
    await recordHandler(log, "createUser");
    await recordHandler(log, "deleteUser");
    await recordHandler(log, "listOrders");
    await log.setMeta("editor_positions", "{}");

    assertEquals(await log.getMeta("editor_positions"), "{}");
    await log.deleteMeta("editor_positions");
    assertEquals(await log.getMeta("editor_positions"), null);

    assertEquals((await log.search("User")).length, 2);
    assertEquals((await log.entityHistory("handler", "createUser")).length, 1);
    assertEquals((await log.recent(2)).length, 2);
  });
});

Deno.test("file changelog groups turns and filters changesets", async () => {
  await withFileLog(async (log) => {
    await log.record({
      category: "handler",
      key: "h1",
      action: "create",
      beforeSnapshot: null,
      afterSnapshot: { source: "h1" },
      context: { turnId: "turn1", changesetId: "cs1" },
    });
    await log.record({
      category: "handler",
      key: "h2",
      action: "create",
      beforeSnapshot: null,
      afterSnapshot: { source: "h2" },
      context: { turnId: "turn1", changesetId: "cs1" },
    });
    await recordHandler(log, "h3", "turn2");

    const turns = await log.listTurns(10);
    assertEquals(turns.length, 2);
    assertEquals(turns.find((t) => t.turnId === "turn1")?.changes.length, 2);
    assertEquals((await log.listByChangeset("cs1")).length, 2);

    await log.deleteByChangesetIds(["cs1"]);
    assertEquals((await log.listByChangeset("cs1")).length, 0);
    assertEquals(await log.count(), 1);
  });
});

Deno.test("file changelog reads follow every write, this log's or another's", async () => {
  await withFileLog(async (log, historyDir) => {
    const first = await recordHandler(log, "first", "turn_1");
    assertEquals(await log.count(), 1);

    const other = new Changelog(historyDir);
    await recordHandler(other, "second", "turn_2");
    assertEquals(await log.count(), 2);

    await other.updateWorkblockMetadata(first.id, { rationale: "why" });
    assertEquals((await log.get(first.id))?.rationale, "why");
  });
});
