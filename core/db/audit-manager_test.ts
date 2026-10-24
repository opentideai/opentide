import { assertEquals, assertExists } from "@std/assert";
import { eq } from "drizzle-orm";
import { createDatabase } from "./factory.ts";
import { AuditManager } from "../../verification/audit-manager.ts";
import {
  genieModelUsageTable,
  genieSessionsTable,
  genieTurnUsageTable,
} from "./schema/index.ts";
import type { AuditResult } from "../types.ts";
import { SessionManager } from "../sessions.ts";

const SESSIONS_DDL = `CREATE TABLE IF NOT EXISTS _genie_sessions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  summary TEXT,
  focus TEXT,
  metadata TEXT,
  archived BOOLEAN NOT NULL DEFAULT false,
  owner_user_id TEXT NOT NULL DEFAULT 'local_legacy',
  visibility TEXT NOT NULL DEFAULT 'private'
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

const AUDIT_RESULTS_DDL = `CREATE TABLE IF NOT EXISTS _genie_audit_results (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  issues JSONB NOT NULL DEFAULT '[]',
  summary TEXT NOT NULL,
  score INTEGER,
  metadata JSONB NOT NULL DEFAULT '{}',
  error TEXT,
  duration_ms INTEGER,
  model TEXT,
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  cache_creation_input_tokens INTEGER DEFAULT 0,
  cache_read_input_tokens INTEGER DEFAULT 0,
  cost_usd REAL DEFAULT 0
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

function makeResult(overrides: Partial<AuditResult> = {}): AuditResult {
  return {
    id: crypto.randomUUID(),
    category: "security",
    status: "complete",
    startedAt: "2025-01-01T00:00:00Z",
    completedAt: "2025-01-01T00:00:05Z",
    issues: [
      { severity: "high", rule: "xss", message: "XSS vulnerability" },
      { severity: "medium", rule: "csrf", message: "Missing CSRF token" },
    ],
    summary: "1 high, 1 medium",
    score: 85,
    metadata: {
      model: "claude-haiku-4-5-20251001",
      inputTokens: 1000,
      outputTokens: 500,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      durationMs: 5000,
      costUsd: 0.0028,
    },
    ...overrides,
  };
}

async function withAuditManager(
  fn: (
    mgr: AuditManager,
    drizzle: ReturnType<typeof createDatabase> extends Promise<infer T> ? T
      : never,
  ) => Promise<void>,
): Promise<void> {
  const conn = await createDatabase({ driver: "pglite" });
  await conn.drizzle.execute(SESSIONS_DDL);
  await conn.drizzle.execute(MESSAGES_DDL);
  await conn.drizzle.execute(TURN_USAGE_DDL);
  await conn.drizzle.execute(MODEL_USAGE_DDL);
  await conn.drizzle.execute(AUDIT_RESULTS_DDL);
  const mgr = new AuditManager(conn.drizzle);
  try {
    await fn(mgr, conn);
  } finally {
    await conn.close();
  }
}

async function seedAuditModelUsage(
  conn: Awaited<ReturnType<typeof createDatabase>>,
  auditResultId: string,
  caller = "audit",
): Promise<void> {
  await conn.drizzle.insert(genieModelUsageTable).values({
    id: `mu_${auditResultId}_${caller}`,
    sessionId: null,
    turnId: `audit-${auditResultId}`,
    auditResultId,
    provider: "anthropic",
    model: "claude-haiku-4-5-20251001",
    role: "verification",
    caller,
    startedAt: "2025-01-01T00:00:00Z",
    endedAt: "2025-01-01T00:00:05Z",
    durationMs: 5000,
    inputTokens: 1000,
    outputTokens: 500,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    toolCallsCount: 0,
    costUsd: 0.0028,
    pricingStatus: "priced",
    pricingProvider: "anthropic",
    pricingModel: "claude-haiku-4-5-20251001",
    metadata: {},
  });
}

Deno.test("store and retrieve audit result", async () => {
  await withAuditManager(async (mgr) => {
    const result = makeResult();
    await mgr.store(result);

    const fetched = mgr.get(result.id);
    assertExists(fetched);
    assertEquals(fetched.id, result.id);
    assertEquals(fetched.category, "security");
    assertEquals(fetched.score, 85);
    assertEquals(fetched.issues.length, 2);
  });
});

Deno.test("store persists to DB and survives loadFromDb", async () => {
  await withAuditManager(async (mgr, conn) => {
    const result = makeResult();
    await mgr.store(result);

    const mgr2 = new AuditManager(conn.drizzle);
    assertEquals(mgr2.list().length, 0);

    await mgr2.loadFromDb();
    assertEquals(mgr2.list().length, 1);
    assertEquals(mgr2.get(result.id)?.score, 85);
    assertEquals(mgr2.get(result.id)?.issues.length, 2);
  });
});

Deno.test("store records cost in _genie_turn_usage", async () => {
  await withAuditManager(async (mgr, conn) => {
    const result = makeResult();
    await mgr.store(result);

    const rows = await conn.drizzle
      .select()
      .from(genieTurnUsageTable)
      .where(eq(genieTurnUsageTable.turnId, `audit-${result.id}`));
    assertEquals(rows.length, 1);
    assertEquals(rows[0]!.sessionId, "__audit__");
    assertEquals(rows[0]!.model, "claude-haiku-4-5-20251001");
    assertEquals(rows[0]!.inputTokens, 1000);
    assertEquals(rows[0]!.outputTokens, 500);
  });
});

Deno.test("store infers unpriced status when metadata cost lacks status", async () => {
  await withAuditManager(async (mgr, conn) => {
    const result = makeResult({
      metadata: {
        model: "gpt-5",
        inputTokens: 1000,
        outputTokens: 500,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        durationMs: 5000,
        costUsd: 0.02205,
      },
    });
    await mgr.store(result);

    const fetched = mgr.get(result.id);
    assertExists(fetched);
    assertEquals(fetched.metadata.pricingStatus, "unpriced");
    assertEquals(fetched.metadata.costUsd, 0);

    const usageRows = await conn.drizzle
      .select()
      .from(genieTurnUsageTable)
      .where(eq(genieTurnUsageTable.turnId, `audit-${result.id}`));
    assertEquals(usageRows[0]?.costUsd, 0);

    const mgr2 = new AuditManager(conn.drizzle);
    await mgr2.loadFromDb();
    assertEquals(mgr2.get(result.id)?.metadata.pricingStatus, "unpriced");
    assertEquals(mgr2.get(result.id)?.metadata.costUsd, 0);
  });
});

Deno.test("store computes pricing status and cost when metadata cost is absent", async () => {
  await withAuditManager(async (mgr, conn) => {
    const result = makeResult({
      metadata: {
        model: "claude-haiku-4-5-20251001",
        inputTokens: 1000,
        outputTokens: 500,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        durationMs: 5000,
      },
    });
    await mgr.store(result);

    const fetched = mgr.get(result.id);
    assertExists(fetched);
    assertEquals(fetched.metadata.pricingStatus, "priced");
    assertEquals(Number(fetched.metadata.costUsd) > 0, true);

    const usageRows = await conn.drizzle
      .select()
      .from(genieTurnUsageTable)
      .where(eq(genieTurnUsageTable.turnId, `audit-${result.id}`));
    assertEquals(Number(usageRows[0]?.costUsd) > 0, true);
  });
});

Deno.test("store does not infer pricing from metadata cost alone", async () => {
  await withAuditManager(async (mgr) => {
    const result = makeResult({ metadata: { costUsd: 1.23 } });
    await mgr.store(result);

    const fetched = mgr.get(result.id);
    assertExists(fetched);
    assertEquals(fetched.metadata.pricingStatus, undefined);
    assertEquals(fetched.metadata.costUsd, 1.23);
  });
});

Deno.test("store creates __audit__ session as archived", async () => {
  await withAuditManager(async (mgr, conn) => {
    await mgr.store(makeResult());

    const rows = await conn.drizzle
      .select()
      .from(genieSessionsTable)
      .where(eq(genieSessionsTable.id, "__audit__"));
    assertEquals(rows.length, 1);
    assertEquals(rows[0]!.archived, true);
    assertEquals(rows[0]!.name, "Audit Runs");
  });
});

Deno.test("latest returns most recent per category", async () => {
  await withAuditManager(async (mgr) => {
    const r1 = makeResult({ startedAt: "2025-01-01T00:00:00Z" });
    const r2 = makeResult({ startedAt: "2025-01-02T00:00:00Z" });
    await mgr.store(r1);
    await mgr.store(r2);

    assertEquals(mgr.latest("security")?.id, r2.id);
  });
});

Deno.test("listByCategory filters correctly", async () => {
  await withAuditManager(async (mgr) => {
    await mgr.store(makeResult({ category: "security" }));
    await mgr.store(makeResult({ category: "performance" }));
    await mgr.store(makeResult({ category: "security" }));

    assertEquals(mgr.listByCategory("security").length, 2);
    assertEquals(mgr.listByCategory("performance").length, 1);
    assertEquals(mgr.listByCategory("seo").length, 0);
  });
});

Deno.test("removeIssue splices issue and persists to DB", async () => {
  await withAuditManager(async (mgr, conn) => {
    const result = makeResult();
    await mgr.store(result);

    const ok = await mgr.removeIssue(result.id, 0);
    assertEquals(ok, true);
    assertEquals(mgr.get(result.id)?.issues.length, 1);
    assertEquals(mgr.get(result.id)?.issues[0]?.rule, "csrf");

    const mgr2 = new AuditManager(conn.drizzle);
    await mgr2.loadFromDb();
    assertEquals(mgr2.get(result.id)?.issues.length, 1);
  });
});

Deno.test("removeIssue recomputes score", async () => {
  await withAuditManager(async (mgr) => {
    const result = makeResult();
    await mgr.store(result);

    await mgr.removeIssue(result.id, 0);
    assertEquals(mgr.get(result.id)?.score, 95);
  });
});

Deno.test("removeIssue returns false for invalid index", async () => {
  await withAuditManager(async (mgr) => {
    const result = makeResult();
    await mgr.store(result);

    assertEquals(await mgr.removeIssue(result.id, -1), false);
    assertEquals(await mgr.removeIssue(result.id, 99), false);
    assertEquals(await mgr.removeIssue("nonexistent", 0), false);
  });
});

Deno.test("clearIssues empties issues and sets score to 100", async () => {
  await withAuditManager(async (mgr, conn) => {
    const result = makeResult();
    await mgr.store(result);

    const ok = await mgr.clearIssues(result.id);
    assertEquals(ok, true);
    assertEquals(mgr.get(result.id)?.issues.length, 0);
    assertEquals(mgr.get(result.id)?.score, 100);
    assertEquals(mgr.get(result.id)?.summary, "No issues found");

    const mgr2 = new AuditManager(conn.drizzle);
    await mgr2.loadFromDb();
    assertEquals(mgr2.get(result.id)?.issues.length, 0);
    assertEquals(mgr2.get(result.id)?.score, 100);
  });
});

Deno.test("clearCategory deletes results and usage rows", async () => {
  await withAuditManager(async (mgr, conn) => {
    const r1 = makeResult({ category: "security" });
    const r2 = makeResult({ category: "security" });
    const r3 = makeResult({ category: "performance" });
    await mgr.store(r1);
    await mgr.store(r2);
    await mgr.store(r3);
    await seedAuditModelUsage(conn, r1.id);
    await seedAuditModelUsage(conn, r2.id);
    await seedAuditModelUsage(conn, r3.id);

    await mgr.clearCategory("security");

    assertEquals(mgr.listByCategory("security").length, 0);
    assertEquals(mgr.listByCategory("performance").length, 1);
    assertEquals(mgr.latest("security"), undefined);

    const usageRows = await conn.drizzle
      .select()
      .from(genieTurnUsageTable)
      .where(eq(genieTurnUsageTable.sessionId, "__audit__"));
    assertEquals(usageRows.length, 1);
    assertEquals(usageRows[0]!.turnId, `audit-${r3.id}`);
    const modelUsageRows = await conn.drizzle
      .select()
      .from(genieModelUsageTable);
    assertEquals(modelUsageRows.length, 1);
    assertEquals(modelUsageRows[0]!.auditResultId, r3.id);
  });
});

Deno.test("clear deletes all results and usage rows", async () => {
  await withAuditManager(async (mgr, conn) => {
    const r1 = makeResult({ category: "security" });
    const r2 = makeResult({ category: "performance" });
    await mgr.store(r1);
    await mgr.store(r2);
    await seedAuditModelUsage(conn, r1.id);
    await seedAuditModelUsage(conn, r2.id);

    await mgr.clear();

    assertEquals(mgr.list().length, 0);

    const usageRows = await conn.drizzle
      .select()
      .from(genieTurnUsageTable)
      .where(eq(genieTurnUsageTable.sessionId, "__audit__"));
    assertEquals(usageRows.length, 0);
    const modelUsageRows = await conn.drizzle
      .select()
      .from(genieModelUsageTable);
    assertEquals(modelUsageRows.length, 0);
  });
});

Deno.test("pruneCategory deletes pruned audit model-usage rows", async () => {
  await withAuditManager(async (mgr, conn) => {
    const results = Array.from({ length: 6 }, (_, i) =>
      makeResult({
        id: `audit_prune_${i}`,
        category: "security",
        startedAt: `2025-01-0${i + 1}T00:00:00Z`,
        completedAt: `2025-01-0${i + 1}T00:00:05Z`,
      }));
    for (const result of results) {
      await seedAuditModelUsage(conn, result.id);
      await mgr.store(result);
    }

    assertEquals(mgr.listByCategory("security").length, 5);
    const modelUsageRows = await conn.drizzle
      .select()
      .from(genieModelUsageTable);
    assertEquals(modelUsageRows.length, 5);
    assertEquals(
      modelUsageRows.some((row) => row.auditResultId === results[0]!.id),
      false,
    );
  });
});

Deno.test("error status results do not create usage rows", async () => {
  await withAuditManager(async (mgr, conn) => {
    const result = makeResult({
      status: "error",
      score: null,
      issues: [],
      metadata: {},
      error: "Audit timed out",
    });
    await mgr.store(result);

    const usageRows = await conn.drizzle
      .select()
      .from(genieTurnUsageTable);
    assertEquals(usageRows.length, 0);
  });
});

Deno.test("audit costs appear in project-wide usage aggregation", async () => {
  await withAuditManager(async (mgr, conn) => {
    const result = makeResult();
    await mgr.store(result);

    const [row] = await conn.drizzle
      .select({
        totalCost: genieTurnUsageTable.costUsd,
        totalInput: genieTurnUsageTable.inputTokens,
      })
      .from(genieTurnUsageTable);

    assertExists(row);
    assertEquals(row.totalInput, 1000);
    assertEquals(row.totalCost! > 0, true);
  });
});

Deno.test("audit model usage de-dupes legacy audit turn usage in project aggregation", async () => {
  await withAuditManager(async (mgr, conn) => {
    const result = makeResult();
    await seedAuditModelUsage(conn, result.id);
    await mgr.store(result);

    const sessions = new SessionManager(conn.drizzle);
    const usage = await sessions.getProjectUsage();

    assertEquals(usage.turns, 1);
    assertEquals(usage.totalInputTokens, 1000);
    assertEquals(usage.totalOutputTokens, 500);
    assertEquals(usage.totalCostUsd, 0.0028);
  });
});
