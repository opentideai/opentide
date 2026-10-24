import { assertEquals } from "@std/assert";
import { rmSync } from "node:fs";
import { createDatabase } from "./db/factory.ts";
import { SessionManager } from "./sessions.ts";
import type {
  Session,
  SessionWithLastMessage,
  StoredMessage,
  TurnUsage,
} from "./types.ts";
import { TEST_TMP_DIR } from "./test-home_test.ts";

// Parity tests run the SAME sequence of operations against a file-backed and a
// DB-backed SessionManager and assert observable results match. Volatile fields
// (auto-generated ids and timestamps) differ between backends, so we compare a
// normalized, stable shape instead of raw records.

const SESSIONS_DDL = `CREATE TABLE IF NOT EXISTS _genie_sessions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  summary TEXT,
  focus TEXT,
  metadata TEXT,
  archived BOOLEAN NOT NULL DEFAULT false
)`;

const MESSAGES_DDL = `CREATE TABLE IF NOT EXISTS _genie_messages (
  id SERIAL PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES _genie_sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  tool_calls TEXT,
  pinned BOOLEAN NOT NULL DEFAULT false,
  project_pinned BOOLEAN NOT NULL DEFAULT false,
  turn_id TEXT,
  created_at TEXT NOT NULL
)`;

const TURN_USAGE_DDL = `CREATE TABLE IF NOT EXISTS _genie_turn_usage (
  turn_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES _genie_sessions(id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_input_tokens INTEGER NOT NULL DEFAULT 0,
  tool_calls_count INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0
)`;

const MODEL_USAGE_DDL = `CREATE TABLE IF NOT EXISTS _genie_model_usage (
  id TEXT PRIMARY KEY,
  session_id TEXT REFERENCES _genie_sessions(id) ON DELETE CASCADE,
  turn_id TEXT,
  audit_result_id TEXT,
  changeset_id TEXT,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  role TEXT NOT NULL,
  caller TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT NOT NULL,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_input_tokens INTEGER NOT NULL DEFAULT 0,
  tool_calls_count INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL,
  pricing_status TEXT NOT NULL,
  pricing_provider TEXT,
  pricing_model TEXT,
  pricing_verified_at TEXT,
  pricing_source TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
)`;

// Runs `fn` against both backends, returns both results for comparison.
async function onBoth<T>(
  fn: (mgr: SessionManager) => Promise<T>,
): Promise<{ file: T; db: T }> {
  const historyDir = await Deno.makeTempDir({
    dir: TEST_TMP_DIR,
    prefix: "tideide-parity-",
  });
  const conn = await createDatabase({ driver: "pglite" });
  await conn.drizzle.execute(SESSIONS_DDL);
  await conn.drizzle.execute(MESSAGES_DDL);
  await conn.drizzle.execute(TURN_USAGE_DDL);
  await conn.drizzle.execute(MODEL_USAGE_DDL);
  try {
    const file = await fn(new SessionManager(historyDir));
    const db = await fn(new SessionManager(conn.drizzle));
    return { file, db };
  } finally {
    rmSync(historyDir, { recursive: true, force: true });
    await conn.close();
  }
}

// --- Normalizers: strip ids/timestamps, keep structure + content ---

function normSession(s: Session | null) {
  if (!s) return null;
  return {
    name: s.name,
    ended: s.endedAt !== null,
    summary: s.summary,
    focus: s.focus,
    metadata: s.metadata,
    archived: s.archived,
  };
}

function normSessionList(list: SessionWithLastMessage[]) {
  return list.map((s) => ({
    ...normSession(s),
    hasLastMessage: s.lastMessageAt !== null,
  }));
}

function normMessage(m: StoredMessage | null) {
  if (!m) return null;
  return {
    role: m.role,
    content: m.content,
    toolCalls: m.toolCalls,
    pinned: m.pinned,
    projectPinned: m.projectPinned === true,
    turnId: m.turnId,
  };
}

function normMessages(ms: StoredMessage[]) {
  return ms.map(normMessage);
}

function normTurn(t: TurnUsage | null) {
  if (!t) return null;
  const { sessionId: _sessionId, ...rest } = t;
  return rest;
}

// Compare a snapshot produced identically on both backends.
function assertParity<T>(label: string, both: { file: T; db: T }) {
  assertEquals(both.db, both.file, label);
}

// --- createSession + empty-session reuse/dedup ---

Deno.test("parity: createSession defaults", async () => {
  const both = await onBoth(async (mgr) => {
    const s = await mgr.createSession();
    return normSession(s);
  });
  assertParity("createSession default shape", both);
});

Deno.test("parity: createSession reuses empty session, no dup", async () => {
  const both = await onBoth(async (mgr) => {
    const a = await mgr.createSession();
    const b = await mgr.createSession();
    const reused = a.id === b.id;
    const list = await mgr.listSessions();
    return { reused, count: list.length };
  });
  assertParity("empty session reuse/dedup", both);
});

Deno.test("parity: createSession with name does not reuse", async () => {
  const both = await onBoth(async (mgr) => {
    await mgr.createSession();
    const named = await mgr.createSession("Named");
    const list = await mgr.listSessions();
    return { name: named.name, count: list.length };
  });
  assertParity("named session", both);
});

Deno.test("parity: empty session reuse is scoped to owner and visibility", async () => {
  const both = await onBoth(async (mgr) => {
    const ownerA = await mgr.createSession(undefined, {
      ownerUserId: "account_a",
      visibility: "private",
    });
    const ownerB = await mgr.createSession(undefined, {
      ownerUserId: "account_b",
      visibility: "private",
    });
    const projectA = await mgr.createSession(undefined, {
      ownerUserId: "account_a",
      visibility: "project",
    });
    const ownerAReused = await mgr.createSession(undefined, {
      ownerUserId: "account_a",
      visibility: "private",
    });
    const list = await mgr.listSessions();
    return {
      ownerAReused: ownerAReused.id === ownerA.id,
      ownerBSeparate: ownerB.id !== ownerA.id,
      projectASeparate: projectA.id !== ownerA.id,
      count: list.length,
    };
  });
  assertParity("owner-scoped empty session reuse", both);
  assertEquals(both.file, {
    ownerAReused: true,
    ownerBSeparate: true,
    projectASeparate: true,
    count: 3,
  });
});

Deno.test("parity: listSessions sorts by last message before reopen time", async () => {
  const both = await onBoth(async (mgr) => {
    const older = await mgr.createSession("Older update");
    await mgr.addMessage({
      sessionId: older.id,
      role: "user",
      content: "older",
    });
    await new Promise((resolve) => setTimeout(resolve, 5));

    const newer = await mgr.createSession("Newer update");
    await mgr.addMessage({
      sessionId: newer.id,
      role: "user",
      content: "newer",
    });
    await new Promise((resolve) => setTimeout(resolve, 5));

    await mgr.reopenSession(older.id);
    return (await mgr.listSessions()).map((s) => s.name);
  });
  assertParity("list order by activity", both);
  assertEquals(both.file, ["Newer update", "Older update"]);
});

// --- addMessage + getMessages (order, toolCalls) ---

Deno.test("parity: addMessage + getMessages order and toolCalls", async () => {
  const both = await onBoth(async (mgr) => {
    const s = await mgr.createSession("Chat");
    await mgr.addMessage({ sessionId: s.id, role: "user", content: "first" });
    await mgr.addMessage({
      sessionId: s.id,
      role: "assistant",
      content: "second",
      toolCalls: [{ name: "edit", input: { file: "a.ts" } }],
      turnId: "t1",
    });
    await mgr.addMessage({ sessionId: s.id, role: "user", content: "third" });
    return normMessages(await mgr.getMessages(s.id));
  });
  assertParity("messages order/toolCalls", both);
});

Deno.test("parity: getMessages limit/offset/pinnedOnly", async () => {
  const both = await onBoth(async (mgr) => {
    const s = await mgr.createSession();
    await mgr.addMessage({ sessionId: s.id, role: "user", content: "a" });
    const m2 = await mgr.addMessage({
      sessionId: s.id,
      role: "user",
      content: "b",
    });
    await mgr.addMessage({ sessionId: s.id, role: "user", content: "c" });
    await mgr.pinMessage(m2.id);
    return {
      page: normMessages(await mgr.getMessages(s.id, { limit: 2 })),
      page2: normMessages(await mgr.getMessages(s.id, { limit: 2, offset: 2 })),
      pinned: normMessages(await mgr.getMessages(s.id, { pinnedOnly: true })),
    };
  });
  assertParity("getMessages paging/pinned", both);
});

// --- getMessage ---

Deno.test("parity: getMessage by id and missing", async () => {
  const both = await onBoth(async (mgr) => {
    const s = await mgr.createSession();
    const m = await mgr.addMessage({
      sessionId: s.id,
      role: "user",
      content: "hi",
    });
    const found = normMessage(await mgr.getMessage(m.id));
    const missing = await mgr.getMessage(-12345);
    return { found, missing };
  });
  assertParity("getMessage", both);
});

// --- pin/unpin + getPinnedMessages ---

Deno.test("parity: pin/unpin + getPinnedMessages", async () => {
  const both = await onBoth(async (mgr) => {
    const s = await mgr.createSession();
    await mgr.addMessage({ sessionId: s.id, role: "user", content: "a" });
    const m2 = await mgr.addMessage({
      sessionId: s.id,
      role: "user",
      content: "b",
    });
    await mgr.addMessage({ sessionId: s.id, role: "user", content: "c" });
    await mgr.pinMessage(m2.id);
    const pinned = normMessages(await mgr.getPinnedMessages(s.id));
    await mgr.unpinMessage(m2.id);
    const afterUnpin = normMessages(await mgr.getPinnedMessages(s.id));
    return { pinned, afterUnpin };
  });
  assertParity("pin/unpin", both);
});

Deno.test("parity: project pin/unpin + getProjectPinnedMessages", async () => {
  const both = await onBoth(async (mgr) => {
    const s1 = await mgr.createSession("A");
    const s2 = await mgr.createSession("B");
    const a = await mgr.addMessage({
      sessionId: s1.id,
      role: "user",
      content: "project spec",
    });
    const b = await mgr.addMessage({
      sessionId: s2.id,
      role: "assistant",
      content: "project decision",
    });
    await mgr.pinMessage(a.id, "project");
    await mgr.pinMessage(b.id, "project");
    await mgr.unpinMessage(a.id, "project");
    return normMessages(await mgr.getProjectPinnedMessages());
  });
  assertParity("project pin/unpin", both);
});

// --- searchMessages ---

Deno.test("parity: searchMessages content + sessionId + limit", async () => {
  const both = await onBoth(async (mgr) => {
    const s1 = await mgr.createSession("S1");
    const s2 = await mgr.createSession("S2");
    await mgr.addMessage({
      sessionId: s1.id,
      role: "user",
      content: "hello world",
    });
    await mgr.addMessage({
      sessionId: s1.id,
      role: "user",
      content: "goodbye world",
    });
    await mgr.addMessage({
      sessionId: s2.id,
      role: "user",
      content: "hello world",
    });
    const all = normMessages(await mgr.searchMessages("world"));
    const scoped = normMessages(
      await mgr.searchMessages("world", { sessionId: s1.id }),
    );
    const limited = (await mgr.searchMessages("world", { limit: 1 })).length;
    return { allCount: all.length, scoped, limited };
  });
  assertParity("searchMessages", both);
});

// --- getContextInfo ---

Deno.test("parity: getContextInfo stats", async () => {
  const both = await onBoth(async (mgr) => {
    const s = await mgr.createSession();
    await mgr.addMessage({ sessionId: s.id, role: "user", content: "hello" });
    await mgr.addMessage({
      sessionId: s.id,
      role: "assistant",
      content: "hi there",
    });
    const m3 = await mgr.addMessage({
      sessionId: s.id,
      role: "user",
      content: "important",
    });
    await mgr.pinMessage(m3.id);
    await mgr.updateFocus(s.id, "testing");
    const info = await mgr.getContextInfo(s.id);
    return {
      messageCount: info.messageCount,
      estimatedTokens: info.estimatedTokens,
      pinnedCount: info.pinnedCount,
      focus: info.focus,
      usage: info.usage,
    };
  });
  assertParity("getContextInfo", both);
});

// --- recordTurnUsage + getTurnUsage + getSessionUsage ---

Deno.test("parity: usage record/get/aggregate", async () => {
  const both = await onBoth(async (mgr) => {
    const s = await mgr.createSession();
    const base = {
      sessionId: s.id,
      model: "claude-3",
      startedAt: "2024-01-01T00:00:01Z",
      endedAt: "2024-01-01T00:00:02Z",
      durationMs: 100,
      inputTokens: 10,
      outputTokens: 5,
      cacheCreationInputTokens: 1,
      cacheReadInputTokens: 2,
      toolCallsCount: 1,
      costUsd: 0.01,
    };
    await mgr.recordTurnUsage({ ...base, turnId: "t1" });
    await mgr.recordTurnUsage({
      ...base,
      turnId: "t2",
      startedAt: "2024-01-01T00:00:03Z",
      inputTokens: 20,
      costUsd: 0.02,
    });
    // upsert on existing turnId
    await mgr.recordTurnUsage({ ...base, turnId: "t1", inputTokens: 99 });

    return {
      t1: normTurn(await mgr.getTurnUsage("t1")),
      missing: await mgr.getTurnUsage("nope"),
      session: await mgr.getSessionUsage(s.id),
      project: await mgr.getProjectUsage(),
      projectSinceSecondTurn: await mgr.getProjectUsage({
        since: "2024-01-01T00:00:03Z",
      }),
      ordered: (await mgr.getTurnUsagesForSession(s.id)).map((t) => t.turnId),
    };
  });
  assertParity("usage", both);
  assertEquals(both.file.projectSinceSecondTurn.turns, 1);
  assertEquals(both.file.projectSinceSecondTurn.totalInputTokens, 20);
  assertEquals(both.file.projectSinceSecondTurn.totalCostUsd, 0.02);
});

Deno.test("parity: model usage record/get/list", async () => {
  const both = await onBoth(async (mgr) => {
    const s = await mgr.createSession();
    const record = await mgr.recordModelUsage({
      id: "mu_parity",
      sessionId: s.id,
      turnId: "turn_parity",
      changesetId: "cs_parity",
      provider: "anthropic",
      model: "claude-sonnet-5",
      role: "agent",
      caller: "chat_turn",
      startedAt: "2026-09-01T00:00:00.000Z",
      endedAt: "2026-09-01T00:00:01.000Z",
      usage: {
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
      },
    });
    return {
      record: {
        ...record,
        sessionId: "SESSION",
      },
      fetched: {
        ...(await mgr.getModelUsage("mu_parity"))!,
        sessionId: "SESSION",
      },
      turnCount: (await mgr.getModelUsagesForTurn("turn_parity")).length,
      changesetCount: (await mgr.getModelUsagesForChangeset("cs_parity"))
        .length,
    };
  });
  assertParity("model usage", both);
  assertEquals(both.file.record.costUsd, 12);
  assertEquals(both.file.record.pricingStatus, "priced");
  assertEquals(both.file.turnCount, 1);
  assertEquals(both.file.changesetCount, 1);
});

Deno.test("parity: usage summaries prefer priced/unpriced model ledger", async () => {
  const both = await onBoth(async (mgr) => {
    const s = await mgr.createSession();
    await mgr.recordModelUsage({
      id: "mu_summary_priced",
      sessionId: s.id,
      turnId: "turn_summary_priced",
      provider: "anthropic",
      model: "claude-sonnet-5",
      role: "agent",
      caller: "chat_turn",
      startedAt: "2026-09-01T00:00:00.000Z",
      endedAt: "2026-09-01T00:00:01.000Z",
      usage: {
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
      },
    });
    await mgr.recordModelUsage({
      id: "mu_summary_unpriced",
      sessionId: s.id,
      provider: "openai",
      model: "gpt-unpriced-for-test",
      role: "utility",
      caller: "session_name",
      startedAt: "2026-09-01T00:00:02.000Z",
      endedAt: "2026-09-01T00:00:03.000Z",
      usage: {
        inputTokens: 100,
        outputTokens: 25,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
      },
    });
    return await mgr.getSessionUsage(s.id);
  });
  assertParity("model usage summary", both);
  assertEquals(both.file.turns, 1);
  assertEquals(both.file.totalCostUsd, 12);
  assertEquals(both.file.unpricedCalls, 1);
  assertEquals(both.file.unpricedInputTokens, 100);
  assertEquals(both.file.unpricedOutputTokens, 25);
});

Deno.test("parity: usage summaries include unreplaced legacy turns", async () => {
  const both = await onBoth(async (mgr) => {
    const s = await mgr.createSession();
    await mgr.recordTurnUsage({
      turnId: "legacy_only",
      sessionId: s.id,
      model: "claude-sonnet-5",
      startedAt: "2026-09-01T00:00:00.000Z",
      endedAt: "2026-09-01T00:00:01.000Z",
      durationMs: 100,
      inputTokens: 10,
      outputTokens: 20,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      toolCallsCount: 1,
      costUsd: 0.01,
    });
    await mgr.recordTurnUsage({
      turnId: "replaced",
      sessionId: s.id,
      model: "claude-sonnet-5",
      startedAt: "2026-09-01T00:00:02.000Z",
      endedAt: "2026-09-01T00:00:03.000Z",
      durationMs: 200,
      inputTokens: 1000,
      outputTokens: 2000,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      toolCallsCount: 9,
      costUsd: 99,
    });
    await mgr.recordModelUsage({
      id: "mu_replaced",
      sessionId: s.id,
      turnId: "replaced",
      provider: "anthropic",
      model: "claude-sonnet-5",
      role: "agent",
      caller: "chat_turn",
      startedAt: "2026-09-01T00:00:02.000Z",
      endedAt: "2026-09-01T00:00:03.000Z",
      usage: {
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
      },
    });
    await mgr.recordModelUsage({
      id: "mu_utility",
      sessionId: s.id,
      provider: "openai",
      model: "gpt-unpriced-for-test",
      role: "utility",
      caller: "session_summary",
      startedAt: "2026-09-01T00:00:04.000Z",
      endedAt: "2026-09-01T00:00:05.000Z",
      usage: {
        inputTokens: 30,
        outputTokens: 40,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
      },
    });
    return await mgr.getSessionUsage(s.id);
  });
  assertParity("mixed legacy/model usage summary", both);
  assertEquals(both.file.turns, 2);
  assertEquals(both.file.totalInputTokens, 1_000_040);
  assertEquals(both.file.totalOutputTokens, 1_000_060);
  assertEquals(both.file.totalCostUsd, 12.01);
  assertEquals(both.file.unpricedCalls, 1);
});

// --- rename / updateSummary / updateFocus ---

Deno.test("parity: rename/updateSummary/updateFocus", async () => {
  const both = await onBoth(async (mgr) => {
    const s = await mgr.createSession("Old");
    await mgr.renameSession(s.id, "New");
    await mgr.updateSummary(s.id, "a summary");
    await mgr.updateFocus(s.id, "auth");
    const afterSet = normSession(await mgr.getSession(s.id));
    await mgr.updateFocus(s.id, null);
    const afterClear = normSession(await mgr.getSession(s.id));
    return { afterSet, afterClear };
  });
  assertParity("rename/summary/focus", both);
});

// --- deleteSession ---

Deno.test("parity: deleteSession removes session", async () => {
  const both = await onBoth(async (mgr) => {
    const s = await mgr.createSession("Doomed");
    await mgr.addMessage({ sessionId: s.id, role: "user", content: "bye" });
    await mgr.deleteSession(s.id);
    return {
      session: await mgr.getSession(s.id),
      list: normSessionList(await mgr.listSessions()),
    };
  });
  assertParity("deleteSession", both);
});

// --- archiveSession + listSessions ---

Deno.test("parity: archiveSession hides from listSessions and unarchive restores", async () => {
  const both = await onBoth(async (mgr) => {
    const a = await mgr.createSession("A");
    await new Promise((resolve) => setTimeout(resolve, 5));
    const b = await mgr.createSession("B");
    await mgr.addMessage({ sessionId: b.id, role: "user", content: "msg" });
    await mgr.archiveSession(a.id);
    const archivedList = normSessionList(await mgr.listSessions());
    const archivedFetched = normSession(await mgr.getSession(a.id));
    await mgr.unarchiveSession(a.id);
    return {
      archivedList,
      archivedFetched,
      unarchivedList: normSessionList(await mgr.listSessions()),
      unarchivedFetched: normSession(await mgr.getSession(a.id)),
    };
  });
  assertParity("archive/unarchive list", both);
});

// --- end/reopen ---

Deno.test("parity: end and reopen session", async () => {
  const both = await onBoth(async (mgr) => {
    const s = await mgr.createSession("Lifecycle");
    await mgr.endSession(s.id);
    const ended = normSession(await mgr.getSession(s.id));
    await mgr.reopenSession(s.id);
    const reopened = normSession(await mgr.getSession(s.id));
    return { ended, reopened };
  });
  assertParity("end/reopen", both);
});
