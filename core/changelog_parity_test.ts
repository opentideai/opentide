import { assertEquals } from "@std/assert";
import { rmSync } from "node:fs";
import { createDatabase } from "./db/factory.ts";
import {
  Changelog,
  type ChangeRecord,
  type RecentRecord,
  type TurnGroup,
} from "./changelog.ts";
import { TEST_TMP_DIR } from "./test-home_test.ts";

// DDL copied from kernel/db/changelog_test.ts so the DB-backed Changelog has the
// same schema the production DB migrations create.
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

// Runs the same scenario against a file-backed and a DB-backed Changelog,
// returning whatever the scenario collected from each so the caller can assert
// the two are equivalent.
async function withBoth<T>(
  scenario: (log: Changelog) => Promise<T>,
): Promise<{ file: T; db: T }> {
  const historyDir = await Deno.makeTempDir({
    dir: TEST_TMP_DIR,
    prefix: "tideide-changelog-parity-",
  });
  const conn = await createDatabase({ driver: "pglite" });
  await conn.drizzle.execute(CHANGELOG_DDL);
  await conn.drizzle.execute(META_DDL);
  try {
    const file = await scenario(new Changelog(historyDir));
    const db = await scenario(new Changelog(conn.drizzle));
    return { file, db };
  } finally {
    rmSync(historyDir, { recursive: true, force: true });
    await conn.close();
  }
}

// IDs and timestamps differ between backends (file uses time-based mergeable
// ids, DB uses a serial sequence; createdAt is wall-clock). Strip them so we
// compare only structure/content/ordering. Within a single backend run, ids are
// monotonic, so ordering is preserved by the array order itself.
type NormalizedRecord = Omit<ChangeRecord, "id" | "createdAt">;

function normRecord(r: ChangeRecord): NormalizedRecord {
  const { id: _id, createdAt: _createdAt, ...rest } = r;
  return rest;
}

function normRecords(rs: ChangeRecord[]): NormalizedRecord[] {
  return rs.map(normRecord);
}

type NormalizedRecent = Omit<RecentRecord, "id" | "createdAt">;

function normRecent(rs: RecentRecord[]): NormalizedRecent[] {
  return rs.map(({ id: _id, createdAt: _createdAt, ...rest }) => rest);
}

type NormalizedTurn = Omit<TurnGroup, "createdAt" | "changes"> & {
  changes: NormalizedRecord[];
};

function normTurns(turns: TurnGroup[]): NormalizedTurn[] {
  return turns
    .map(({ createdAt: _createdAt, changes, turnId, ...rest }) => ({
      ...rest,
      // Solo turn ids embed the record id (e.g. solo_<id>), which is volatile,
      // so collapse them to a stable marker while keeping real turn ids intact.
      turnId: turnId.startsWith("solo_") ? "solo" : turnId,
      changes: normRecords(changes),
    }))
    // Inter-group ordering is by representative createdAt, which can tie within
    // a single sub-millisecond test run and resolve differently between the two
    // backends (distinct wall-clock strings). Sort by a stable content key so we
    // compare the set of groups and their intra-turn change ordering, not the
    // ambiguous createdAt tie-break between groups.
    .toSorted((a, b) =>
      JSON.stringify(a.changes).localeCompare(JSON.stringify(b.changes))
    );
}

function normNullableRecords(
  rs: ChangeRecord[] | null,
): NormalizedRecord[] | null {
  return rs === null ? null : normRecords(rs);
}

async function recordHandler(
  log: Changelog,
  key: string,
  opts?: { turnId?: string; changesetId?: string; undoable?: boolean },
) {
  return await log.record({
    category: "handler",
    key,
    action: "create",
    beforeSnapshot: null,
    afterSnapshot: { source: `function ${key}() {}` },
    context: opts?.turnId || opts?.changesetId
      ? {
        turnId: opts?.turnId,
        changesetId: opts?.changesetId,
        userMessage: `make ${key}`,
      }
      : null,
    undoable: opts?.undoable,
  });
}

Deno.test("parity: record + get", async () => {
  const { file, db } = await withBoth(async (log) => {
    const created = await recordHandler(log, "hello", { turnId: "t1" });
    const fetched = await log.get(created.id);
    return {
      created: normRecord(created),
      fetched: fetched ? normRecord(fetched) : null,
      cursorMatchesCreated: (await log.getCursor()) === created.id,
    };
  });
  assertEquals(file, db);
});

Deno.test("parity: list ordering and filters", async () => {
  const { file, db } = await withBoth(async (log) => {
    await recordHandler(log, "a", { turnId: "t1" });
    await recordHandler(log, "b", { turnId: "t1" });
    await recordHandler(log, "c", { turnId: "t2" });
    await log.record({
      category: "route",
      key: "r1",
      action: "create",
      beforeSnapshot: null,
      afterSnapshot: null,
      context: null,
    });
    return {
      all: normRecords(await log.list({ limit: 10 })),
      byCategory: normRecords(await log.list({ category: "handler" })),
      byKey: normRecords(await log.list({ key: "b" })),
      byTurn: normRecords(await log.list({ turnId: "t1" })),
      paged: normRecords(await log.list({ limit: 2, offset: 1 })),
    };
  });
  assertEquals(file, db);
});

Deno.test("parity: updateWorkblockMetadata", async () => {
  const leaked =
    'Extracts the real script tag.</implementation><parameter name="verification">{"claimIds":["claim_no_regression"]}';
  const { file, db } = await withBoth(async (log) => {
    const created = await recordHandler(log, "hello", { turnId: "t1" });
    const set = await log.updateWorkblockMetadata(created.id, {
      rationale: "  why  ",
      implementation: leaked,
      workMessageId: 42,
    });
    const partial = await log.updateWorkblockMetadata(created.id, {
      rationale: "   ",
    });
    const missing = await log.updateWorkblockMetadata(-999, {
      rationale: "nope",
    });
    return {
      set: set ? normRecord(set) : null,
      partial: partial ? normRecord(partial) : null,
      missing,
    };
  });
  assertEquals(file, db);
  assertEquals(file.set?.implementation, "Extracts the real script tag.");
  assertEquals(file.partial?.implementation, "Extracts the real script tag.");
});

Deno.test("parity: record sanitizes workblock metadata", async () => {
  const { file, db } = await withBoth(async (log) => {
    return normRecord(
      await log.record({
        category: "handler",
        key: "sanitize",
        action: "create",
        beforeSnapshot: null,
        afterSnapshot: { source: "function sanitize() {}" },
        context: null,
        rationale: 'Keep history readable.</rationale><parameter name="x">bad',
        implementation: "<implementation>Used the handler registry.",
      }),
    );
  });
  assertEquals(file, db);
  assertEquals(file.rationale, "Keep history readable.");
  assertEquals(file.implementation, "Used the handler registry.");
});

Deno.test("parity: search", async () => {
  const { file, db } = await withBoth(async (log) => {
    await recordHandler(log, "createUser");
    await recordHandler(log, "deleteUser");
    await recordHandler(log, "listOrders", { turnId: "userTurn" });
    return {
      byKey: normRecords(await log.search("User")),
      caseInsensitive: normRecords(await log.search("user")),
      byContext: normRecords(await log.search("userTurn")),
      none: normRecords(await log.search("zzz-nope")),
      limited: normRecords(await log.search("User", 1)),
    };
  });
  assertEquals(file, db);
});

Deno.test("parity: getCursor", async () => {
  const { file, db } = await withBoth(async (log) => {
    const empty = await log.getCursor();
    const created = await recordHandler(log, "a");
    return {
      empty,
      afterRecordMatches: (await log.getCursor()) === created.id,
    };
  });
  assertEquals(file, db);
});

Deno.test("parity: undoEntry / redoEntry", async () => {
  const { file, db } = await withBoth(async (log) => {
    await recordHandler(log, "first");
    await recordHandler(log, "second");
    const undone = await log.undoEntry();
    const afterUndoNull = (await log.getCursor()) === null;
    const redone = await log.redoEntry();
    const undoAll1 = await log.undoEntry();
    const undoAll2 = await log.undoEntry();
    const cursorCleared = (await log.getCursor()) === null;
    const redoNothingLeft = await log.undoEntry();
    return {
      undone: undone ? normRecord(undone) : null,
      afterUndoNull,
      redone: redone ? normRecord(redone) : null,
      undoAll1: undoAll1 ? normRecord(undoAll1) : null,
      undoAll2: undoAll2 ? normRecord(undoAll2) : null,
      cursorCleared,
      redoNothingLeft,
    };
  });
  assertEquals(file, db);
});

Deno.test("parity: undoEntry / redoEntry skip non-undoable", async () => {
  const { file, db } = await withBoth(async (log) => {
    await recordHandler(log, "undoable");
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
    return { undone: undone ? normRecord(undone) : null };
  });
  assertEquals(file, db);
});

Deno.test("parity: undoTurnEntries / redoTurnEntries", async () => {
  const { file, db } = await withBoth(async (log) => {
    await recordHandler(log, "before");
    await recordHandler(log, "h1", { turnId: "turn1" });
    await recordHandler(log, "h2", { turnId: "turn1" });

    const undone = normNullableRecords(await log.undoTurnEntries());
    const redone = normNullableRecords(await log.redoTurnEntries());
    // Undo the solo "before" (no turnId) too.
    await log.undoTurnEntries(); // undoes turn1 again
    const soloUndo = normNullableRecords(await log.undoTurnEntries());
    return { undone, redone, soloUndo };
  });
  assertEquals(file, db);
});

Deno.test("parity: goTo backward and forward", async () => {
  const { file, db } = await withBoth(async (log) => {
    const e1 = await recordHandler(log, "a");
    await recordHandler(log, "b");
    const e3 = await recordHandler(log, "c");

    const back = await log.goTo(e1.id);
    const forward = await log.goTo(e3.id);
    const noop = await log.goTo(e3.id);
    const toZero = await log.goTo(0);
    const missing = await log.goTo(-999);
    return {
      back: back
        ? { undo: normRecords(back.undo), redo: normRecords(back.redo) }
        : null,
      forward: forward
        ? { undo: normRecords(forward.undo), redo: normRecords(forward.redo) }
        : null,
      noop: noop
        ? { undo: normRecords(noop.undo), redo: normRecords(noop.redo) }
        : null,
      toZero: toZero
        ? { undo: normRecords(toZero.undo), redo: normRecords(toZero.redo) }
        : null,
      cursorAfterToZero: await log.getCursor(),
      missing,
    };
  });
  assertEquals(file, db);
});

Deno.test("parity: listByChangeset", async () => {
  const { file, db } = await withBoth(async (log) => {
    await recordHandler(log, "h1", { changesetId: "cs1" });
    await recordHandler(log, "h2", { changesetId: "cs1" });
    await recordHandler(log, "h3", { changesetId: "cs2" });
    return {
      cs1: normRecords(await log.listByChangeset("cs1")),
      cs2: normRecords(await log.listByChangeset("cs2")),
      missing: normRecords(await log.listByChangeset("nope")),
    };
  });
  assertEquals(file, db);
});

Deno.test("parity: listTurns grouping and snapshots", async () => {
  const { file, db } = await withBoth(async (log) => {
    await recordHandler(log, "h1", { turnId: "turn1" });
    await recordHandler(log, "h2", { turnId: "turn1" });
    await recordHandler(log, "h3", { turnId: "turn2" });
    await recordHandler(log, "solo");
    // _genie_ config entries must be filtered out of listTurns.
    await log.record({
      category: "config",
      key: "_genie_internal",
      action: "update",
      beforeSnapshot: null,
      afterSnapshot: null,
      context: null,
    });
    return {
      light: normTurns(await log.listTurns(10)),
      full: normTurns(await log.listTurns(10, { includeSnapshots: true })),
    };
  });
  assertEquals(file, db);
});

Deno.test("parity: getMeta / setMeta / deleteMeta", async () => {
  const { file, db } = await withBoth(async (log) => {
    const before = await log.getMeta("foo");
    await log.setMeta("foo", "bar");
    const set = await log.getMeta("foo");
    await log.setMeta("foo", "baz");
    const updated = await log.getMeta("foo");
    await log.deleteMeta("foo");
    const after = await log.getMeta("foo");
    return { before, set, updated, after };
  });
  assertEquals(file, db);
});

Deno.test("parity: entityHistory", async () => {
  const { file, db } = await withBoth(async (log) => {
    await recordHandler(log, "hello");
    await recordHandler(log, "hello");
    await recordHandler(log, "other");
    await log.record({
      category: "handler",
      key: "hello",
      action: "delete",
      beforeSnapshot: null,
      afterSnapshot: null,
      context: null,
      undoable: false,
    });
    return {
      hello: normRecords(await log.entityHistory("handler", "hello")),
      limited: normRecords(await log.entityHistory("handler", "hello", 1)),
      missing: normRecords(await log.entityHistory("handler", "nope")),
    };
  });
  assertEquals(file, db);
});

// A1 (Stream A): authorOrigin persists and round-trips on both backends, and
// entityAuthorship folds an entity's history into ai/human/mixed/unknown.
Deno.test("parity: authorOrigin round-trip + entityAuthorship fold", async () => {
  const originRecord = (
    log: Changelog,
    key: string,
    authorOrigin: "ai" | "human",
  ) =>
    log.record({
      category: "handler",
      key,
      action: "create",
      beforeSnapshot: null,
      afterSnapshot: { source: `function ${key}() {}` },
      context: { authorOrigin },
    });

  const { file, db } = await withBoth(async (log) => {
    // One entity edited by the agent and then by hand → derived "mixed".
    await originRecord(log, "mixedEntity", "ai");
    await originRecord(log, "mixedEntity", "human");
    // Single-origin entities.
    await originRecord(log, "aiEntity", "ai");
    await originRecord(log, "humanEntity", "human");
    // No origin stamped → "unknown", never silently "ai".
    await log.record({
      category: "handler",
      key: "unknownEntity",
      action: "create",
      beforeSnapshot: null,
      afterSnapshot: { source: "function unknownEntity() {}" },
      context: null,
    });

    const [aiRecord] = await log.list({ category: "handler", key: "aiEntity" });
    return {
      persistedOrigin: aiRecord?.context?.authorOrigin ?? null,
      mixed: await log.entityAuthorship("handler", "mixedEntity"),
      ai: await log.entityAuthorship("handler", "aiEntity"),
      human: await log.entityAuthorship("handler", "humanEntity"),
      unknown: await log.entityAuthorship("handler", "unknownEntity"),
      missing: await log.entityAuthorship("handler", "noSuchEntity"),
    };
  });

  assertEquals(file, db);
  assertEquals(file.persistedOrigin, "ai");
  assertEquals(file.mixed, "mixed");
  assertEquals(file.ai, "ai");
  assertEquals(file.human, "human");
  assertEquals(file.unknown, "unknown");
  assertEquals(file.missing, "unknown");
});

Deno.test("parity: count", async () => {
  const { file, db } = await withBoth(async (log) => {
    const empty = await log.count();
    await recordHandler(log, "a");
    await recordHandler(log, "b");
    return { empty, after: await log.count() };
  });
  assertEquals(file, db);
});

Deno.test("parity: recent", async () => {
  const { file, db } = await withBoth(async (log) => {
    await recordHandler(log, "a", { turnId: "t1" });
    await recordHandler(log, "b");
    return {
      all: normRecent(await log.recent(5)),
      limited: normRecent(await log.recent(1)),
    };
  });
  assertEquals(file, db);
});

Deno.test("parity: deleteByChangesetIds", async () => {
  const { file, db } = await withBoth(async (log) => {
    await recordHandler(log, "h1", { changesetId: "cs1" });
    await recordHandler(log, "h2", { changesetId: "cs1" });
    await recordHandler(log, "h3", { changesetId: "cs2" });
    await recordHandler(log, "solo");

    await log.deleteByChangesetIds([]); // no-op
    const afterNoop = await log.count();
    await log.deleteByChangesetIds(["cs1"]);
    return {
      afterNoop,
      remaining: normRecords(await log.list({ limit: 10 })),
      cs1: normRecords(await log.listByChangeset("cs1")),
      count: await log.count(),
    };
  });
  assertEquals(file, db);
});
