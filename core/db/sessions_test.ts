import { assertEquals, assertExists } from "@std/assert";
import { createDatabase, type DatabaseConnection } from "./factory.ts";
import { SessionManager } from "../sessions.ts";
import { setRecommendedModels } from "../config.ts";
import {
  setUtilityModelCallForTest,
  setUtilityModelUsageRecorderForTest,
} from "../utility-model.ts";

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
  kind TEXT NOT NULL DEFAULT 'chat',
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

async function withSessions(
  fn: (mgr: SessionManager, conn: DatabaseConnection) => Promise<void>,
): Promise<void> {
  const conn = await createDatabase({ driver: "pglite" });
  await conn.drizzle.execute(SESSIONS_DDL);
  await conn.drizzle.execute(MESSAGES_DDL);
  await conn.drizzle.execute(TURN_USAGE_DDL);
  await conn.drizzle.execute(MODEL_USAGE_DDL);
  const mgr = new SessionManager(conn.drizzle);
  try {
    await fn(mgr, conn);
  } finally {
    await conn.close();
  }
}

async function withTempHomeAndProviderEnv(
  opts: { anthropic?: string; openai?: string },
  fn: (home: string) => Promise<void>,
): Promise<void> {
  const home = await Deno.makeTempDir({ prefix: "genie-sessions-test-" });
  const oldHome = Deno.env.get("HOME");
  const oldAnthropic = Deno.env.get("ANTHROPIC_API_KEY");
  const oldOpenai = Deno.env.get("OPENAI_API_KEY");
  try {
    Deno.env.set("HOME", home);
    if (opts.anthropic === undefined) Deno.env.delete("ANTHROPIC_API_KEY");
    else Deno.env.set("ANTHROPIC_API_KEY", opts.anthropic);
    if (opts.openai === undefined) Deno.env.delete("OPENAI_API_KEY");
    else Deno.env.set("OPENAI_API_KEY", opts.openai);
    await fn(home);
  } finally {
    if (oldHome === undefined) Deno.env.delete("HOME");
    else Deno.env.set("HOME", oldHome);
    if (oldAnthropic === undefined) Deno.env.delete("ANTHROPIC_API_KEY");
    else Deno.env.set("ANTHROPIC_API_KEY", oldAnthropic);
    if (oldOpenai === undefined) Deno.env.delete("OPENAI_API_KEY");
    else Deno.env.set("OPENAI_API_KEY", oldOpenai);
    await Deno.remove(home, { recursive: true });
  }
}

async function seedModelCache(
  home: string,
  model: string,
  provider: "anthropic" | "openai",
): Promise<void> {
  const dir = `${home}/.config/opentide`;
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(
    `${dir}/models-cache.json`,
    JSON.stringify({
      cachedAt: new Date().toISOString(),
      models: [{ id: model, label: model, provider }],
    }),
  );
}

// --- Session lifecycle ---

Deno.test("createSession returns session with defaults", async () => {
  await withSessions(async (mgr) => {
    const s = await mgr.createSession();
    assertEquals(s.name, "New Session");
    assertEquals(s.archived, false);
    assertEquals(s.endedAt, null);
    assertEquals(s.summary, null);
    assertExists(s.id);
    assertExists(s.startedAt);
  });
});

Deno.test("legacy sessions get readable local ownership columns", async () => {
  const conn = await createDatabase({ driver: "pglite" });
  await conn.drizzle.execute(SESSIONS_DDL);
  await conn.drizzle.execute(MESSAGES_DDL);
  await conn.drizzle.execute(TURN_USAGE_DDL);
  await conn.drizzle.execute(MODEL_USAGE_DDL);
  try {
    await conn.drizzle.execute(
      "INSERT INTO _genie_sessions (id, name, started_at) VALUES ('old-local', 'Old Local', '2026-01-01T00:00:00.000Z')",
    );
    const mgr = new SessionManager(conn.drizzle);

    const fetched = await mgr.getSession("old-local");

    assertEquals(fetched?.ownerUserId, "acct_test_owner");
    assertEquals(fetched?.visibility, "project");
  } finally {
    await conn.close();
  }
});

Deno.test("createSession accepts a name", async () => {
  await withSessions(async (mgr) => {
    const s = await mgr.createSession("My Session");
    assertEquals(s.name, "My Session");
  });
});

Deno.test("getSession retrieves by id", async () => {
  await withSessions(async (mgr) => {
    const s = await mgr.createSession("Test");
    const fetched = await mgr.getSession(s.id);
    assertEquals(fetched?.name, "Test");
    assertEquals(fetched?.id, s.id);
  });
});

Deno.test("getSession returns null for missing id", async () => {
  await withSessions(async (mgr) => {
    assertEquals(await mgr.getSession("nonexistent"), null);
  });
});

Deno.test("endSession sets endedAt", async () => {
  await withSessions(async (mgr) => {
    const s = await mgr.createSession();
    await mgr.endSession(s.id);
    const fetched = await mgr.getSession(s.id);
    assertExists(fetched?.endedAt);
  });
});

Deno.test("reopenSession clears endedAt and updates startedAt", async () => {
  await withSessions(async (mgr) => {
    const s = await mgr.createSession();
    await mgr.endSession(s.id);
    await mgr.reopenSession(s.id);
    const fetched = await mgr.getSession(s.id);
    assertEquals(fetched?.endedAt, null);
  });
});

Deno.test("listSessions returns non-archived sessions", async () => {
  await withSessions(async (mgr) => {
    const s1 = await mgr.createSession("A");
    await mgr.createSession("B");
    await mgr.archiveSession(s1.id);
    const list = await mgr.listSessions();
    assertEquals(list.length, 1);
    assertEquals(list[0]!.name, "B");
  });
});

Deno.test("listSessions respects limit and offset", async () => {
  await withSessions(async (mgr) => {
    await mgr.createSession("A");
    await mgr.createSession("B");
    await mgr.createSession("C");
    const page = await mgr.listSessions(2, 0);
    assertEquals(page.length, 2);
    const page2 = await mgr.listSessions(2, 2);
    assertEquals(page2.length, 1);
  });
});

Deno.test("listSessions sorts by last message time before reopen time", async () => {
  await withSessions(async (mgr) => {
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

    const list = await mgr.listSessions();
    assertEquals(list.map((s) => s.name), ["Newer update", "Older update"]);
  });
});

Deno.test("renameSession updates the name", async () => {
  await withSessions(async (mgr) => {
    const s = await mgr.createSession("Old");
    await mgr.renameSession(s.id, "New");
    const fetched = await mgr.getSession(s.id);
    assertEquals(fetched?.name, "New");
  });
});

Deno.test("updateSummary sets summary", async () => {
  await withSessions(async (mgr) => {
    const s = await mgr.createSession();
    await mgr.updateSummary(s.id, "A summary");
    const fetched = await mgr.getSession(s.id);
    assertEquals(fetched?.summary, "A summary");
  });
});

Deno.test("updateSummaryMetadata sets summary and metadata", async () => {
  await withSessions(async (mgr) => {
    const s = await mgr.createSession();
    await mgr.updateSummaryMetadata(
      s.id,
      "A better summary",
      JSON.stringify({ summaryKind: "handoff" }),
    );
    const fetched = await mgr.getSession(s.id);
    assertEquals(fetched?.summary, "A better summary");
    assertEquals(fetched?.metadata, JSON.stringify({ summaryKind: "handoff" }));
  });
});

Deno.test("updateFocus sets and clears focus", async () => {
  await withSessions(async (mgr) => {
    const s = await mgr.createSession();
    await mgr.updateFocus(s.id, "building auth");
    assertEquals((await mgr.getSession(s.id))?.focus, "building auth");
    await mgr.updateFocus(s.id, null);
    assertEquals((await mgr.getSession(s.id))?.focus, null);
  });
});

Deno.test("deleteSession removes session and messages", async () => {
  await withSessions(async (mgr) => {
    const s = await mgr.createSession();
    await mgr.addMessage({ sessionId: s.id, role: "user", content: "hello" });
    await mgr.deleteSession(s.id);
    assertEquals(await mgr.getSession(s.id), null);
  });
});

Deno.test("archiveSession hides from listSessions", async () => {
  await withSessions(async (mgr) => {
    const s = await mgr.createSession("Archive me");
    await mgr.archiveSession(s.id);
    const list = await mgr.listSessions();
    assertEquals(list.length, 0);
    const fetched = await mgr.getSession(s.id);
    assertEquals(fetched?.archived, true);
  });
});

// --- Messages ---

Deno.test("addMessage returns stored message with id", async () => {
  await withSessions(async (mgr) => {
    const s = await mgr.createSession();
    const msg = await mgr.addMessage({
      sessionId: s.id,
      role: "user",
      content: "hello",
    });
    assertEquals(msg.role, "user");
    assertEquals(msg.content, "hello");
    assertEquals(msg.pinned, false);
    assertEquals(typeof msg.id, "number");
    assertExists(msg.createdAt);
  });
});

Deno.test("addMessage stores tool calls as json", async () => {
  await withSessions(async (mgr) => {
    const s = await mgr.createSession();
    const tools = [{ name: "test", input: { a: 1 } }];
    const msg = await mgr.addMessage({
      sessionId: s.id,
      role: "assistant",
      content: "ok",
      toolCalls: tools,
    });
    assertEquals(msg.toolCalls, JSON.stringify(tools));
  });
});

Deno.test("addMessage stores turnId", async () => {
  await withSessions(async (mgr) => {
    const s = await mgr.createSession();
    const msg = await mgr.addMessage({
      sessionId: s.id,
      role: "user",
      content: "hi",
      turnId: "t1",
    });
    assertEquals(msg.turnId, "t1");
  });
});

Deno.test("getMessages returns messages in order", async () => {
  await withSessions(async (mgr) => {
    const s = await mgr.createSession();
    await mgr.addMessage({ sessionId: s.id, role: "user", content: "first" });
    await mgr.addMessage({
      sessionId: s.id,
      role: "assistant",
      content: "second",
    });
    await mgr.addMessage({ sessionId: s.id, role: "user", content: "third" });
    const msgs = await mgr.getMessages(s.id);
    assertEquals(msgs.length, 3);
    assertEquals(msgs[0]!.content, "first");
    assertEquals(msgs[2]!.content, "third");
  });
});

Deno.test("getMessages respects limit and offset", async () => {
  await withSessions(async (mgr) => {
    const s = await mgr.createSession();
    await mgr.addMessage({ sessionId: s.id, role: "user", content: "a" });
    await mgr.addMessage({ sessionId: s.id, role: "user", content: "b" });
    await mgr.addMessage({ sessionId: s.id, role: "user", content: "c" });
    const page = await mgr.getMessages(s.id, { limit: 2 });
    assertEquals(page.length, 2);
    const page2 = await mgr.getMessages(s.id, { limit: 2, offset: 2 });
    assertEquals(page2.length, 1);
    assertEquals(page2[0]!.content, "c");
  });
});

Deno.test("getMessages pinnedOnly filters pinned messages", async () => {
  await withSessions(async (mgr) => {
    const s = await mgr.createSession();
    const _m1 = await mgr.addMessage({
      sessionId: s.id,
      role: "user",
      content: "normal",
    });
    const m2 = await mgr.addMessage({
      sessionId: s.id,
      role: "user",
      content: "important",
    });
    await mgr.pinMessage(m2.id);
    const pinned = await mgr.getMessages(s.id, { pinnedOnly: true });
    assertEquals(pinned.length, 1);
    assertEquals(pinned[0]!.content, "important");
  });
});

Deno.test("getMessage retrieves by id", async () => {
  await withSessions(async (mgr) => {
    const s = await mgr.createSession();
    const msg = await mgr.addMessage({
      sessionId: s.id,
      role: "user",
      content: "test",
    });
    const fetched = await mgr.getMessage(msg.id);
    assertEquals(fetched?.content, "test");
  });
});

Deno.test("getMessage returns null for missing id", async () => {
  await withSessions(async (mgr) => {
    assertEquals(await mgr.getMessage(999), null);
  });
});

// --- Pinning ---

Deno.test("pinMessage and unpinMessage toggle pin state", async () => {
  await withSessions(async (mgr) => {
    const s = await mgr.createSession();
    const msg = await mgr.addMessage({
      sessionId: s.id,
      role: "user",
      content: "pin me",
    });
    assertEquals(msg.pinned, false);

    await mgr.pinMessage(msg.id);
    assertEquals((await mgr.getMessage(msg.id))?.pinned, true);

    await mgr.unpinMessage(msg.id);
    assertEquals((await mgr.getMessage(msg.id))?.pinned, false);
  });
});

Deno.test("getPinnedMessages returns only pinned messages", async () => {
  await withSessions(async (mgr) => {
    const s = await mgr.createSession();
    await mgr.addMessage({ sessionId: s.id, role: "user", content: "a" });
    const m2 = await mgr.addMessage({
      sessionId: s.id,
      role: "user",
      content: "b",
    });
    await mgr.addMessage({ sessionId: s.id, role: "user", content: "c" });
    await mgr.pinMessage(m2.id);
    const pinned = await mgr.getPinnedMessages(s.id);
    assertEquals(pinned.length, 1);
    assertEquals(pinned[0]!.content, "b");
  });
});

// --- Search ---

Deno.test("searchMessages finds by content (ILIKE fallback)", async () => {
  await withSessions(async (mgr) => {
    const s = await mgr.createSession();
    await mgr.addMessage({
      sessionId: s.id,
      role: "user",
      content: "hello world",
    });
    await mgr.addMessage({
      sessionId: s.id,
      role: "user",
      content: "goodbye world",
    });
    await mgr.addMessage({
      sessionId: s.id,
      role: "user",
      content: "something else",
    });
    const results = await mgr.searchMessages("world");
    assertEquals(results.length, 2);
  });
});

Deno.test("searchMessages filters by sessionId", async () => {
  await withSessions(async (mgr) => {
    const s1 = await mgr.createSession("S1");
    const s2 = await mgr.createSession("S2");
    await mgr.addMessage({
      sessionId: s1.id,
      role: "user",
      content: "hello world",
    });
    await mgr.addMessage({
      sessionId: s2.id,
      role: "user",
      content: "hello world",
    });
    const results = await mgr.searchMessages("world", { sessionId: s1.id });
    assertEquals(results.length, 1);
  });
});

Deno.test("searchMessages respects limit", async () => {
  await withSessions(async (mgr) => {
    const s = await mgr.createSession();
    for (let i = 0; i < 5; i++) {
      await mgr.addMessage({
        sessionId: s.id,
        role: "user",
        content: `message ${i} about testing`,
      });
    }
    const results = await mgr.searchMessages("testing", { limit: 3 });
    assertEquals(results.length, 3);
  });
});

// --- Context info ---

Deno.test("getContextInfo returns message stats", async () => {
  await withSessions(async (mgr) => {
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
    assertEquals(info.messageCount, 3);
    assertEquals(info.pinnedCount, 1);
    assertEquals(info.focus, "testing");
    assertEquals(info.estimatedTokens > 0, true);
  });
});

// --- Usage tracking ---

Deno.test("recordTurnUsage and getTurnUsage roundtrip", async () => {
  await withSessions(async (mgr) => {
    const s = await mgr.createSession();
    const usage = {
      turnId: "t1",
      sessionId: s.id,
      model: "claude-3",
      startedAt: "2024-01-01T00:00:00Z",
      endedAt: "2024-01-01T00:00:01Z",
      durationMs: 1000,
      inputTokens: 100,
      outputTokens: 50,
      cacheCreationInputTokens: 10,
      cacheReadInputTokens: 5,
      toolCallsCount: 2,
      costUsd: 0.01,
    };
    await mgr.recordTurnUsage(usage);
    const fetched = await mgr.getTurnUsage("t1");
    assertEquals(fetched?.turnId, "t1");
    assertEquals(fetched?.model, "claude-3");
    assertEquals(fetched?.durationMs, 1000);
    assertEquals(fetched?.inputTokens, 100);
    assertEquals(fetched?.costUsd, 0.01);
  });
});

Deno.test("recordTurnUsage upserts on conflict", async () => {
  await withSessions(async (mgr) => {
    const s = await mgr.createSession();
    const base = {
      turnId: "t1",
      sessionId: s.id,
      model: "claude-3",
      startedAt: "2024-01-01T00:00:00Z",
      endedAt: "2024-01-01T00:00:01Z",
      durationMs: 1000,
      inputTokens: 100,
      outputTokens: 50,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      toolCallsCount: 0,
      costUsd: 0.01,
    };
    await mgr.recordTurnUsage(base);
    await mgr.recordTurnUsage({ ...base, inputTokens: 200, costUsd: 0.02 });
    const fetched = await mgr.getTurnUsage("t1");
    assertEquals(fetched?.inputTokens, 200);
    assertEquals(fetched?.costUsd, 0.02);
  });
});

Deno.test("getTurnUsage returns null for missing turnId", async () => {
  await withSessions(async (mgr) => {
    assertEquals(await mgr.getTurnUsage("nonexistent"), null);
  });
});

Deno.test("getSessionUsage aggregates turn usage", async () => {
  await withSessions(async (mgr) => {
    const s = await mgr.createSession();
    await mgr.recordTurnUsage({
      turnId: "t1",
      sessionId: s.id,
      model: "m",
      startedAt: "a",
      endedAt: "b",
      durationMs: 100,
      inputTokens: 10,
      outputTokens: 5,
      cacheCreationInputTokens: 1,
      cacheReadInputTokens: 2,
      toolCallsCount: 1,
      costUsd: 0.01,
    });
    await mgr.recordTurnUsage({
      turnId: "t2",
      sessionId: s.id,
      model: "m",
      startedAt: "c",
      endedAt: "d",
      durationMs: 200,
      inputTokens: 20,
      outputTokens: 10,
      cacheCreationInputTokens: 3,
      cacheReadInputTokens: 4,
      toolCallsCount: 2,
      costUsd: 0.02,
    });

    const usage = await mgr.getSessionUsage(s.id);
    assertEquals(usage.turns, 2);
    assertEquals(usage.totalDurationMs, 300);
    assertEquals(usage.totalInputTokens, 30);
    assertEquals(usage.totalOutputTokens, 15);
    assertEquals(usage.totalCacheCreationInputTokens, 4);
    assertEquals(usage.totalCacheReadInputTokens, 6);
    assertEquals(usage.totalToolCalls, 3);
    assertEquals(usage.totalCostUsd, 0.03);
  });
});

Deno.test("getSessionUsage returns zeros for no usage", async () => {
  await withSessions(async (mgr) => {
    const s = await mgr.createSession();
    const usage = await mgr.getSessionUsage(s.id);
    assertEquals(usage.turns, 0);
    assertEquals(usage.totalDurationMs, 0);
    assertEquals(usage.totalCostUsd, 0);
  });
});

Deno.test("getProjectUsage aggregates across sessions", async () => {
  await withSessions(async (mgr) => {
    const s1 = await mgr.createSession("S1");
    const s2 = await mgr.createSession("S2");
    await mgr.recordTurnUsage({
      turnId: "t1",
      sessionId: s1.id,
      model: "m",
      startedAt: "a",
      endedAt: "b",
      durationMs: 100,
      inputTokens: 10,
      outputTokens: 5,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      toolCallsCount: 1,
      costUsd: 0.01,
    });
    await mgr.recordTurnUsage({
      turnId: "t2",
      sessionId: s2.id,
      model: "m",
      startedAt: "c",
      endedAt: "d",
      durationMs: 200,
      inputTokens: 20,
      outputTokens: 10,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      toolCallsCount: 2,
      costUsd: 0.02,
    });

    const usage = await mgr.getProjectUsage();
    assertEquals(usage.turns, 2);
    assertEquals(usage.totalInputTokens, 30);
    assertEquals(usage.totalCostUsd, 0.03);
  });
});

Deno.test("getTurnUsagesForSession returns ordered list", async () => {
  await withSessions(async (mgr) => {
    const s = await mgr.createSession();
    await mgr.recordTurnUsage({
      turnId: "t2",
      sessionId: s.id,
      model: "m",
      startedAt: "2024-01-01T00:00:02Z",
      endedAt: "b",
      durationMs: 200,
      inputTokens: 20,
      outputTokens: 10,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      toolCallsCount: 0,
      costUsd: 0,
    });
    await mgr.recordTurnUsage({
      turnId: "t1",
      sessionId: s.id,
      model: "m",
      startedAt: "2024-01-01T00:00:01Z",
      endedAt: "b",
      durationMs: 100,
      inputTokens: 10,
      outputTokens: 5,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      toolCallsCount: 0,
      costUsd: 0,
    });

    const usages = await mgr.getTurnUsagesForSession(s.id);
    assertEquals(usages.length, 2);
    assertEquals(usages[0]!.turnId, "t1");
    assertEquals(usages[1]!.turnId, "t2");
  });
});

Deno.test("recordModelUsage writes priced provider-aware ledger row", async () => {
  await withSessions(async (mgr) => {
    const s = await mgr.createSession();
    const record = await mgr.recordModelUsage({
      id: "mu_priced",
      sessionId: s.id,
      turnId: "turn_priced",
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
      toolCallsCount: 2,
      metadata: { source: "test" },
    });

    assertEquals(record.id, "mu_priced");
    assertEquals(record.sessionId, s.id);
    assertEquals(record.turnId, "turn_priced");
    assertEquals(record.provider, "anthropic");
    assertEquals(record.model, "claude-sonnet-5");
    assertEquals(record.role, "agent");
    assertEquals(record.caller, "chat_turn");
    assertEquals(record.inputTokens, 1_000_000);
    assertEquals(record.outputTokens, 1_000_000);
    assertEquals(record.toolCallsCount, 2);
    assertEquals(record.pricingStatus, "priced");
    assertEquals(record.costUsd, 12);
    assertEquals(record.pricingProvider, "anthropic");
    assertEquals(record.pricingModel, "claude-sonnet-5");
    assertEquals(record.metadata, { source: "test" });

    assertEquals(await mgr.getModelUsage("mu_priced"), record);
    assertEquals((await mgr.getModelUsagesForTurn("turn_priced")).length, 1);
  });
});

Deno.test("recordModelUsage stores unpriced calls with nullable cost", async () => {
  await withSessions(async (mgr) => {
    const s = await mgr.createSession();
    const record = await mgr.recordModelUsage({
      id: "mu_unpriced",
      sessionId: s.id,
      provider: "openai",
      model: "gpt-unpriced-for-test",
      role: "utility",
      caller: "session_name",
      startedAt: "2026-09-01T00:00:00.000Z",
      endedAt: "2026-09-01T00:00:00.250Z",
      usage: {
        inputTokens: 100,
        outputTokens: 25,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
      },
    });

    assertEquals(record.costUsd, null);
    assertEquals(record.pricingStatus, "unpriced");
    assertEquals(record.pricingProvider, null);
    assertEquals(record.pricingModel, null);
  });
});

Deno.test("usage summaries separate priced and unpriced ledger rows", async () => {
  await withSessions(async (mgr) => {
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

    const usage = await mgr.getSessionUsage(s.id);
    assertEquals(usage.turns, 1);
    assertEquals(usage.totalInputTokens, 1_000_100);
    assertEquals(usage.totalOutputTokens, 1_000_025);
    assertEquals(usage.totalCostUsd, 12);
    assertEquals(usage.unpricedCalls, 1);
    assertEquals(usage.unpricedInputTokens, 100);
    assertEquals(usage.unpricedOutputTokens, 25);
  });
});

Deno.test("usage summaries merge legacy turns not replaced by ledger rows", async () => {
  await withSessions(async (mgr) => {
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

    const usage = await mgr.getSessionUsage(s.id);
    assertEquals(usage.turns, 2);
    assertEquals(usage.totalInputTokens, 1_000_040);
    assertEquals(usage.totalOutputTokens, 1_000_060);
    assertEquals(usage.totalToolCalls, 1);
    assertEquals(usage.totalCostUsd, 12.01);
    assertEquals(usage.unpricedCalls, 1);
    assertEquals(usage.unpricedInputTokens, 30);
    assertEquals(usage.unpricedOutputTokens, 40);
  });
});

// --- Static helpers ---

Deno.test("fallbackName extracts first 5 words and title-cases", () => {
  assertEquals(
    SessionManager.fallbackName("hello world foo bar baz extra"),
    "Hello World Foo Bar Baz",
  );
});

Deno.test("generateName returns Untitled Session for empty input", async () => {
  assertEquals(await SessionManager.generateName(""), "Untitled Session");
  assertEquals(await SessionManager.generateName("   "), "Untitled Session");
});

Deno.test("generateName uses the utility model with an OpenAI-only key", async () => {
  await withTempHomeAndProviderEnv(
    { openai: "sk-openai-test" },
    async (home) => {
      await seedModelCache(home, "gpt-5-mini", "openai");
      setRecommendedModels({ utility: "gpt-5-mini" });
      const seenModels: string[] = [];
      const restore = setUtilityModelCallForTest((req) => {
        seenModels.push(req.model);
        return Promise.resolve({
          text: "Syntax Highlighted Code Blocks",
          usage: {
            inputTokens: 1,
            outputTokens: 2,
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: 0,
          },
        });
      });
      try {
        assertEquals(
          await SessionManager.generateName(
            "it looks like code blocks have an input that maybe is the language",
          ),
          "Syntax Highlighted Code Blocks",
        );
        assertEquals(seenModels, ["gpt-5-mini"]);
      } finally {
        restore();
      }
    },
  );
});

Deno.test("generateName records session_name utility usage", async () => {
  await withTempHomeAndProviderEnv(
    { openai: "sk-openai-test" },
    async (home) => {
      await seedModelCache(home, "gpt-unpriced-for-test", "openai");
      await withSessions(async (mgr, conn) => {
        setRecommendedModels({ utility: "gpt-unpriced-for-test" });
        const restore = setUtilityModelCallForTest((req) =>
          Promise.resolve({
            text: "Utility Usage Ledger",
            provider: "openai",
            model: req.model,
            usage: {
              inputTokens: 12,
              outputTokens: 4,
              cacheCreationInputTokens: 0,
              cacheReadInputTokens: 0,
            },
          })
        );
        const restoreRecorder = setUtilityModelUsageRecorderForTest((input) =>
          mgr.recordModelUsage(input)
        );
        try {
          assertEquals(
            await SessionManager.generateName(
              "record utility title accounting",
            ),
            "Utility Usage Ledger",
          );
          const rows = await conn.raw.query(
            `SELECT caller, role, provider, model, input_tokens, output_tokens, pricing_status, cost_usd
           FROM _genie_model_usage WHERE caller = $1`,
            ["session_name"],
          );
          assertEquals(rows.length, 1);
          assertEquals(rows[0]!.role, "utility");
          assertEquals(rows[0]!.provider, "openai");
          assertEquals(rows[0]!.model, "gpt-unpriced-for-test");
          assertEquals(rows[0]!.input_tokens, 12);
          assertEquals(rows[0]!.output_tokens, 4);
          assertEquals(rows[0]!.pricing_status, "unpriced");
          assertEquals(rows[0]!.cost_usd, null);
        } finally {
          restore();
          restoreRecorder();
        }
      });
    },
  );
});

Deno.test("generateName retries when the model returns the request prefix", async () => {
  await withTempHomeAndProviderEnv({ anthropic: "sk-ant-test" }, async () => {
    setRecommendedModels({ utility: "claude-haiku-test" });
    const replies = [
      "It Looks Like Code Blocks",
      "Code Block Syntax Highlighting",
    ];
    const prompts: string[] = [];
    const restore = setUtilityModelCallForTest((req) => {
      prompts.push(req.user);
      return Promise.resolve({
        text: replies.shift() ?? "Unexpected Extra Call",
        usage: {
          inputTokens: 1,
          outputTokens: 2,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
        },
      });
    });
    try {
      assertEquals(
        await SessionManager.generateName(
          "it looks like code blocks have an input that maybe is the language",
        ),
        "Code Block Syntax Highlighting",
      );
      assertEquals(prompts.length, 2);
      assertEquals(prompts[1]!.includes("Do not copy the opening words"), true);
    } finally {
      restore();
    }
  });
});

Deno.test("generateName falls back without any provider key", async () => {
  await withTempHomeAndProviderEnv({}, async () => {
    setRecommendedModels({ utility: "gpt-5-mini" });
    let called = false;
    const restore = setUtilityModelCallForTest(() => {
      called = true;
      return Promise.reject(new Error("should not call utility model"));
    });
    try {
      assertEquals(
        await SessionManager.generateName("fix the session title generator"),
        "Fix The Session Title Generator",
      );
      assertEquals(called, false);
    } finally {
      restore();
    }
  });
});

Deno.test("generateName falls back when selected provider key is missing", async () => {
  await withTempHomeAndProviderEnv(
    { anthropic: "sk-ant-test" },
    async (home) => {
      await seedModelCache(home, "gpt-5-mini", "openai");
      setRecommendedModels({ utility: "gpt-5-mini" });
      let called = false;
      const restore = setUtilityModelCallForTest(() => {
        called = true;
        return Promise.reject(new Error("should not call utility model"));
      });
      try {
        assertEquals(
          await SessionManager.generateName("fix the session title generator"),
          "Fix The Session Title Generator",
        );
        assertEquals(called, false);
      } finally {
        restore();
      }
    },
  );
});

Deno.test("fallbackName strips punctuation", () => {
  assertEquals(SessionManager.fallbackName("what's up?"), "Whats Up");
});

// createSession() must prune duplicate empty sessions on the DB-backed path,
// reusing the most recent and deleting the rest.
Deno.test("createSession prunes duplicate empty sessions (db-backed)", async () => {
  const conn = await createDatabase({ driver: "pglite" });
  await conn.drizzle.execute(SESSIONS_DDL);
  await conn.drizzle.execute(
    "ALTER TABLE _genie_sessions ADD COLUMN owner_user_id TEXT DEFAULT 'local_legacy' NOT NULL",
  );
  await conn.drizzle.execute(
    "ALTER TABLE _genie_sessions ADD COLUMN visibility TEXT DEFAULT 'private' NOT NULL",
  );
  await conn.drizzle.execute(MESSAGES_DDL);
  await conn.drizzle.execute(TURN_USAGE_DDL);
  await conn.drizzle.execute(MODEL_USAGE_DDL);
  try {
    for (
      const [id, startedAt] of [
        ["dup-1", "2026-01-01T00:00:00.000Z"],
        ["dup-2", "2026-01-02T00:00:00.000Z"],
        ["dup-3", "2026-01-03T00:00:00.000Z"],
      ]
    ) {
      await conn.drizzle.execute(
        `INSERT INTO _genie_sessions (id, name, started_at, owner_user_id, visibility) VALUES ('${id}', 'New Session', '${startedAt}', 'account_prune', 'private')`,
      );
    }

    const mgr = new SessionManager(conn.drizzle);
    // No name => reuse most-recent empty session and prune the rest.
    const reused = await mgr.createSession(undefined, {
      ownerUserId: "account_prune",
      visibility: "private",
    });

    const remaining = await mgr.listSessions();
    assertEquals(remaining.length, 1);
    assertEquals(remaining[0]!.id, "dup-3");
    assertEquals(reused.id, "dup-3");
  } finally {
    await conn.close();
  }
});
