import { assertEquals, assertRejects } from "@std/assert";
import { rmSync } from "node:fs";
import { createDatabase } from "./db/factory.ts";
import { ChangesetActiveError } from "./types.ts";
import {
  type Changeset,
  ChangesetManager,
  type ChangesetPlan,
} from "../verification/changesets.ts";

// Parity tests run the SAME sequence of operations against a file-backed and a
// DB-backed ChangesetManager and assert observable results match. Volatile
// fields (auto-generated ids and timestamps) differ between backends, so we
// compare a normalized, stable shape instead of raw records.

const TABLE_DDL = `CREATE TABLE IF NOT EXISTS _genie_changesets (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'planning',
  plan JSONB,
  plan_message_ids JSONB,
  approval_message_id INTEGER,
  work_message_ids JSONB,
  tool_calls JSONB,
  reasoning JSONB,
  token_usage JSONB,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  creator_user_id TEXT
)`;

const LEDGER_TABLE_DDL =
  `CREATE TABLE IF NOT EXISTS _genie_verification_ledger (
  id TEXT PRIMARY KEY,
  changeset_id TEXT NOT NULL,
  changeset_title TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  scope TEXT NOT NULL,
  check_id TEXT,
  summary TEXT NOT NULL,
  tool_call_id TEXT,
  turn_id TEXT,
  principal_id TEXT,
  created_at TEXT NOT NULL
)`;

function plan(): ChangesetPlan {
  return {
    summary: "Test plan",
    steps: [
      { id: "s1", description: "Step 1", status: "pending" },
      { id: "s2", description: "Step 2", status: "pending" },
    ],
    acceptanceCriteria: [{
      id: "claim_tests",
      text: "The feature behavior is implemented.",
      source: "agent",
      priority: "must",
    }],
    verificationPlan: [{
      id: "check_tests",
      claimIds: ["claim_tests"],
      kind: "unit",
      description: "Run the targeted changeset test.",
    }],
  };
}

function amendment() {
  return {
    summaryAddendum: "Add one more requirement.",
    steps: ["Implement the extra requirement"],
    acceptanceCriteria: [{
      id: "claim_extra",
      text: "The extra requirement is implemented.",
      source: "user" as const,
      priority: "must" as const,
    }],
    verificationPlan: [{
      id: "check_extra",
      claimIds: ["claim_extra"],
      kind: "unit" as const,
      description: "Run a unit test for the extra requirement.",
    }],
  };
}

function recordPassingVerification(
  mgr: ChangesetManager,
  changesetId: string,
) {
  return mgr.recordVerificationRun(changesetId, {
    id: "vr_tests",
    status: "passed",
    summary: "Verification passed.",
    evidence: [{
      id: "ev_tests",
      kind: "test_result",
      summary: "Tests passed.",
      status: "passed",
      createdAt: "2026-01-01T00:00:00.000Z",
    }],
    claimResults: [{
      claimId: "claim_tests",
      status: "passed",
      evidenceIds: ["ev_tests"],
    }],
    residualRisks: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:00.000Z",
  });
}

// Runs `fn` against both backends, returns both results for comparison.
async function onBoth<T>(
  fn: (mgr: ChangesetManager) => Promise<T>,
): Promise<{ file: T; db: T }> {
  const historyDir = await Deno.makeTempDir({
    dir: "/private/tmp",
    prefix: "tideide-cs-parity-",
  });
  const conn = await createDatabase({ driver: "pglite" });
  await conn.drizzle.execute(TABLE_DDL);
  await conn.drizzle.execute(LEDGER_TABLE_DDL);
  try {
    const file = await fn(new ChangesetManager(historyDir));
    const db = await fn(new ChangesetManager(conn.drizzle));
    return { file, db };
  } finally {
    rmSync(historyDir, { recursive: true, force: true });
    await conn.close();
  }
}

// --- Normalizers: strip volatile ids/timestamps, keep structure + content ---

function normCs(cs: Changeset | null) {
  if (!cs) return null;
  return {
    sessionId: cs.sessionId,
    title: cs.title,
    description: cs.description,
    status: cs.status,
    plan: cs.plan,
    planMessageIds: cs.planMessageIds,
    approvalMessageId: cs.approvalMessageId,
    workMessageIds: cs.workMessageIds,
    toolCalls: cs.toolCalls,
    reasoning: cs.reasoning,
    tokenUsage: cs.tokenUsage,
    completed: cs.completedAt !== null,
  };
}

function normList(list: Changeset[]) {
  return list.map(normCs);
}

function assertParity<T>(label: string, both: { file: T; db: T }) {
  assertEquals(both.db, both.file, label);
}

// --- create + get ---

Deno.test("parity: create + get", async () => {
  const both = await onBoth(async (mgr) => {
    const cs = await mgr.create({
      title: "Auth",
      description: "Add auth",
      sessionId: "s1",
      plan: plan(),
      planMessageIds: [1, 2],
    });
    return {
      created: normCs(cs),
      fetched: normCs(await mgr.get(cs.id)),
      missing: await mgr.get("nope"),
    };
  });
  assertParity("create/get", both);
});

// --- list: ordering + filters ---

// NOTE: create() sweeps the session's prior active changeset and refuses while
// another session holds one, so each changeset is closed before the next
// session creates. Only the latest stays active.
Deno.test("parity: list ordering and filters", async () => {
  const realNow = Date.now;
  Date.now = () => 1_700_000_000_000;
  try {
    const both = await onBoth(async (mgr) => {
      const a = await mgr.create({ title: "A", plan: plan(), sessionId: "s1" });
      await mgr.abandon(a.id);
      const b = await mgr.create({ title: "B", plan: plan(), sessionId: "s2" });
      await mgr.abandon(b.id);
      const c = await mgr.create({
        title: "C",
        plan: plan(),
        sessionId: "s1",
      });
      await mgr.approve(c.id);
      await mgr.startWork(c.id);
      return {
        all: normList(await mgr.list()),
        bySession: normList(await mgr.list({ sessionId: "s1" })),
        byStatus: normList(await mgr.list({ status: "in_progress" })),
        latest: normCs((await mgr.list({ limit: 1 }))[0] ?? null),
      };
    });
    assertParity("list", both);
    assertEquals(both.file.latest?.title, "C");
    assertEquals(both.db.latest?.title, "C");
  } finally {
    Date.now = realNow;
  }
});

// --- updatePlan ---

Deno.test("parity: updatePlan", async () => {
  const both = await onBoth(async (mgr) => {
    const cs = await mgr.create({ title: "T", plan: plan() });
    const newPlan: ChangesetPlan = {
      summary: "Updated",
      steps: [{ id: "x", description: "X", status: "pending" }],
      acceptanceCriteria: plan().acceptanceCriteria,
      verificationPlan: plan().verificationPlan,
    };
    return normCs(await mgr.updatePlan(cs.id, newPlan));
  });
  assertParity("updatePlan", both);
});

// --- amendPlan ---

Deno.test("parity: amendPlan appends scope and resets to planning", async () => {
  const both = await onBoth(async (mgr) => {
    const cs = await mgr.create({
      title: "T",
      plan: plan(),
      planMessageIds: [10],
    });
    await mgr.approve(cs.id, 11);
    await mgr.startWork(cs.id);
    await mgr.updateStep(cs.id, "s1", "done");
    const updated = await mgr.amendPlan(cs.id, {
      summaryAddendum: "Also support the follow-up behavior.",
      steps: ["Add the follow-up behavior"],
      acceptanceCriteria: [{
        id: "claim_followup",
        text: "The follow-up behavior is implemented.",
        source: "user",
        priority: "must",
      }],
      verificationPlan: [{
        id: "check_followup",
        claimIds: ["claim_followup"],
        kind: "unit",
        description: "Run a unit test for the follow-up behavior.",
      }],
      formalSpecs: [{
        id: "spec_followup",
        claimIds: ["claim_followup"],
        technique: "union-alias",
        scope: "function:followup",
        statement: "The follow-up states are represented by a named union.",
        enforcement: "hard",
      }],
    });
    return normCs(updated);
  });
  assertParity("amendPlan", both);
  assertEquals(both.file?.status, "planning");
  assertEquals(both.file?.approvalMessageId, null);
  assertEquals(both.file?.planMessageIds, [10]);
  assertEquals(both.file?.plan.steps[0]?.status, "done");
  assertEquals(both.file?.plan.steps[2]?.status, "pending");
  assertEquals(
    both.file?.plan.acceptanceCriteria?.at(-1)?.id,
    "claim_followup",
  );
  assertEquals(both.file?.plan.verificationPlan?.at(-1)?.id, "check_followup");
  assertEquals(both.file?.plan.formalSpecs?.at(-1)?.id, "spec_followup");
});

Deno.test("parity: amendPlan rejects non in-progress statuses", async () => {
  const historyDir = await Deno.makeTempDir({
    dir: "/private/tmp",
    prefix: "tideide-cs-amend-guard-",
  });
  const conn = await createDatabase({ driver: "pglite" });
  await conn.drizzle.execute(TABLE_DDL);
  try {
    for (
      const mgr of [
        new ChangesetManager(historyDir),
        new ChangesetManager(conn.drizzle),
      ]
    ) {
      const planning = await mgr.create({ title: "Planning", plan: plan() });
      await assertRejects(
        () => mgr.amendPlan(planning.id, amendment()),
        Error,
        `Cannot amend plan in status "planning"`,
      );

      const approved = await mgr.create({ title: "Approved", plan: plan() });
      await mgr.approve(approved.id);
      await assertRejects(
        () => mgr.amendPlan(approved.id, amendment()),
        Error,
        `Cannot amend plan in status "approved"`,
      );

      const completed = await mgr.create({ title: "Completed", plan: plan() });
      await mgr.approve(completed.id);
      await mgr.startWork(completed.id);
      await mgr.updateStep(completed.id, "s1", "done");
      await mgr.updateStep(completed.id, "s2", "done");
      await recordPassingVerification(mgr, completed.id);
      await mgr.complete(completed.id);
      await assertRejects(
        () => mgr.amendPlan(completed.id, amendment()),
        Error,
        `Cannot amend plan in status "completed"`,
      );
    }
  } finally {
    rmSync(historyDir, { recursive: true, force: true });
    await conn.close();
  }
});

// --- approve ---

Deno.test("parity: approve", async () => {
  const both = await onBoth(async (mgr) => {
    const cs = await mgr.create({ title: "T", plan: plan() });
    return normCs(await mgr.approve(cs.id, 42));
  });
  assertParity("approve", both);
});

// --- startWork ---

Deno.test("parity: startWork", async () => {
  const both = await onBoth(async (mgr) => {
    const cs = await mgr.create({ title: "T", plan: plan() });
    await mgr.approve(cs.id);
    return normCs(await mgr.startWork(cs.id));
  });
  assertParity("startWork", both);
});

// --- updateStep ---

Deno.test("parity: updateStep", async () => {
  const both = await onBoth(async (mgr) => {
    const cs = await mgr.create({ title: "T", plan: plan() });
    await mgr.approve(cs.id);
    await mgr.startWork(cs.id);
    await mgr.updateStep(cs.id, "s1", "done");
    return normCs(await mgr.updateStep(cs.id, "s2", "in_progress"));
  });
  assertParity("updateStep", both);
});

// --- addWorkMessageId (incl. dedup + on completed) ---

Deno.test("parity: addWorkMessageId", async () => {
  const both = await onBoth(async (mgr) => {
    const cs = await mgr.create({ title: "T", plan: plan() });
    await mgr.approve(cs.id);
    await mgr.addWorkMessageId(cs.id, 10);
    await mgr.addWorkMessageId(cs.id, 20);
    const dup = await mgr.addWorkMessageId(cs.id, 10);
    await mgr.startWork(cs.id);
    await mgr.updateStep(cs.id, "s1", "done");
    await mgr.updateStep(cs.id, "s2", "done");
    await recordPassingVerification(mgr, cs.id);
    await mgr.complete(cs.id);
    const onCompleted = await mgr.addWorkMessageId(cs.id, 30);
    return { dup: normCs(dup), onCompleted: normCs(onCompleted) };
  });
  assertParity("addWorkMessageId", both);
});

// --- addPlanMessageId (incl. dedup) ---

Deno.test("parity: addPlanMessageId", async () => {
  const both = await onBoth(async (mgr) => {
    const cs = await mgr.create({ title: "T", plan: plan() });
    await mgr.addPlanMessageId(cs.id, 5);
    const same = await mgr.addPlanMessageId(cs.id, 5);
    const next = await mgr.addPlanMessageId(cs.id, 6);
    return { same: normCs(same), next: normCs(next) };
  });
  assertParity("addPlanMessageId", both);
});

// --- setApprovalMessageId ---

Deno.test("parity: setApprovalMessageId", async () => {
  const both = await onBoth(async (mgr) => {
    const cs = await mgr.create({ title: "T", plan: plan() });
    await mgr.approve(cs.id);
    await mgr.startWork(cs.id);
    return normCs(await mgr.setApprovalMessageId(cs.id, 123));
  });
  assertParity("setApprovalMessageId", both);
});

// --- complete ---

Deno.test("parity: complete", async () => {
  const both = await onBoth(async (mgr) => {
    const cs = await mgr.create({ title: "T", plan: plan() });
    await mgr.approve(cs.id);
    await mgr.startWork(cs.id);
    await mgr.updateStep(cs.id, "s1", "skipped");
    await mgr.updateStep(cs.id, "s2", "done");
    await recordPassingVerification(mgr, cs.id);
    return normCs(await mgr.complete(cs.id));
  });
  assertParity("complete", both);
});

// --- abandon ---

Deno.test("parity: abandon", async () => {
  const both = await onBoth(async (mgr) => {
    const cs = await mgr.create({ title: "T", plan: plan() });
    return normCs(await mgr.abandon(cs.id));
  });
  assertParity("abandon", both);
});

// --- reject (incl. idempotent re-reject) ---

Deno.test("parity: reject", async () => {
  const both = await onBoth(async (mgr) => {
    const cs = await mgr.create({ title: "T", plan: plan() });
    const rejected = await mgr.reject(cs.id);
    const again = await mgr.reject(cs.id);
    return { rejected: normCs(rejected), again: normCs(again) };
  });
  assertParity("reject", both);
});

// --- getActive (with/without sessionId) ---

// create() sweeps the session's prior active changesets; s1 closes B before s2
// creates. The last changeset here belongs to s2.
Deno.test("parity: getActive with and without sessionId", async () => {
  const both = await onBoth(async (mgr) => {
    await mgr.create({ title: "A", plan: plan(), sessionId: "s1" });
    const b = await mgr.create({ title: "B", plan: plan(), sessionId: "s1" });
    await mgr.abandon(b.id);
    const c = await mgr.create({ title: "C", plan: plan(), sessionId: "s2" });
    return {
      // s1's changesets were swept to terminal by later creates.
      forS1: await mgr.getActive("s1"),
      any: normCs(await mgr.getActive()),
      forS2: normCs(await mgr.getActive("s2")),
      latestIsC: (await mgr.getActive())?.id === c.id,
    };
  });
  assertParity("getActive", both);
});

// --- patch (full + partial) ---

Deno.test("parity: patch", async () => {
  const both = await onBoth(async (mgr) => {
    const cs = await mgr.create({
      title: "Old",
      description: "old desc",
      plan: plan(),
    });
    const full = await mgr.patch(cs.id, {
      title: "New",
      description: "new desc",
    });
    const partial = await mgr.patch(cs.id, { title: "Newer" });
    const missing = await mgr.patch("nope", { title: "x" });
    return {
      full: normCs(full),
      partial: normCs(partial),
      missing,
    };
  });
  assertParity("patch", both);
});

// --- aggregate (usage found + not found) ---

Deno.test("parity: aggregate token usage", async () => {
  const both = await onBoth(async (mgr) => {
    const usageSource = {
      getTurnUsage: (turnId: string) =>
        Promise.resolve(
          turnId === "turn_1"
            ? {
              inputTokens: 100,
              cacheCreationInputTokens: 20,
              cacheReadInputTokens: 300,
              outputTokens: 50,
              costUsd: 0.5,
              durationMs: 1000,
            }
            : null,
        ),
    };
    const withUsage = await mgr.create({ title: "WithUsage", plan: plan() });
    const aggregated = await mgr.aggregate(
      withUsage.id,
      usageSource,
      { listByChangeset: () => Promise.resolve([{ turnId: "turn_1" }]) },
    );
    const noUsage = await mgr.create({ title: "NoUsage", plan: plan() });
    const empty = await mgr.aggregate(
      noUsage.id,
      usageSource,
      { listByChangeset: () => Promise.resolve([{ turnId: "missing" }]) },
    );
    return { aggregated: normCs(aggregated), empty: normCs(empty) };
  });
  assertParity("aggregate", both);
  assertEquals(both.file.aggregated?.tokenUsage?.cacheCreationInputTokens, 20);
  assertEquals(both.file.aggregated?.tokenUsage?.cacheReadInputTokens, 300);
});

Deno.test("parity: aggregate token usage includes turnless changeset model rows", async () => {
  const both = await onBoth(async (mgr) => {
    const usageSource = {
      getTurnUsage: () => Promise.resolve(null),
      getModelUsagesForTurn: () => Promise.resolve([]),
      getModelUsagesForChangeset: (changesetId: string) =>
        Promise.resolve([
          {
            id: `mu_${changesetId}`,
            sessionId: null,
            turnId: null,
            auditResultId: null,
            changesetId,
            provider: "anthropic" as const,
            model: "claude-haiku-4-5-20251001",
            role: "verification" as const,
            caller: "refute_claims",
            startedAt: "2025-01-01T00:00:00Z",
            endedAt: "2025-01-01T00:00:01Z",
            durationMs: 1000,
            inputTokens: 123,
            outputTokens: 45,
            cacheCreationInputTokens: 12,
            cacheReadInputTokens: 34,
            toolCallsCount: 0,
            costUsd: 0.006,
            pricingStatus: "priced" as const,
            pricingProvider: "anthropic" as const,
            pricingModel: "claude-haiku-4-5-20251001",
            pricingVerifiedAt: null,
            pricingSource: null,
            metadata: {},
          },
        ]),
    };
    const cs = await mgr.create({ title: "WithRefute", plan: plan() });
    const aggregated = await mgr.aggregate(
      cs.id,
      usageSource,
      { listByChangeset: () => Promise.resolve([]) },
    );
    return normCs(aggregated);
  });
  assertParity("aggregate turnless changeset usage", both);
  assertEquals(both.file?.tokenUsage?.cacheCreationInputTokens, 12);
  assertEquals(both.file?.tokenUsage?.cacheReadInputTokens, 34);
});

// --- deleteBySession ---

Deno.test("parity: deleteBySession", async () => {
  const both = await onBoth(async (mgr) => {
    const keep = await mgr.create({
      title: "Keep",
      plan: plan(),
      sessionId: "other",
    });
    await mgr.abandon(keep.id);
    await mgr.create({ title: "Drop1", plan: plan(), sessionId: "s1" });
    await mgr.create({ title: "Drop2", plan: plan(), sessionId: "s1" });
    const removed = (await mgr.deleteBySession("s1")).length;
    return { removed, remaining: normList(await mgr.list()) };
  });
  assertParity("deleteBySession", both);
});

// --- one writer per project ---

Deno.test("parity: create refuses while another session holds a changeset", async () => {
  const both = await onBoth(async (mgr) => {
    const held = await mgr.create({
      title: "A",
      plan: plan(),
      sessionId: "s1",
    });
    const refusals: (string | null)[] = [];
    for (const sessionId of ["s2", undefined]) {
      try {
        await mgr.create({ title: "B", plan: plan(), sessionId });
        refusals.push(null);
      } catch (err) {
        refusals.push(
          err instanceof ChangesetActiveError ? err.holder.id : String(err),
        );
      }
    }
    return {
      refusedBy: refusals.map((id) => id === held.id),
      held: (await mgr.get(held.id))?.status,
      count: (await mgr.list()).length,
    };
  });
  assertParity("one writer", both);
  assertEquals(both.file.refusedBy, [true, true]);
  assertEquals(both.file.held, "planning");
  assertEquals(both.file.count, 1);
});

Deno.test("parity: concurrent creates from two sessions let one through", async () => {
  const both = await onBoth(async (mgr) => {
    const results = await Promise.allSettled([
      mgr.create({ title: "A", plan: plan(), sessionId: "s1" }),
      mgr.create({ title: "B", plan: plan(), sessionId: "s2" }),
    ]);
    return results.map((r) => r.status);
  });
  assertParity("concurrent creates", both);
  assertEquals(both.file, ["fulfilled", "rejected"]);
});

Deno.test("parity: the sweep only touches the caller's session", async () => {
  const both = await onBoth(async (mgr) => {
    const a = await mgr.create({ title: "A", plan: plan(), sessionId: "s1" });
    const other = await mgr.completeStaleChangesets("s2");
    const afterOther = (await mgr.get(a.id))?.status;
    const own = await mgr.completeStaleChangesets("s1");
    return {
      other: other.length,
      afterOther,
      own: own.map((cs) => cs.status),
    };
  });
  assertParity("scoped sweep", both);
  assertEquals(both.file.other, 0);
  assertEquals(both.file.afterOther, "planning");
  assertEquals(both.file.own, ["abandoned"]);
});

// --- completeStaleChangesets ---

// Only one changeset is active at a time (create sweeps the rest). Exercise the
// sweep on a verified in_progress changeset: it should complete and mark steps
// done.
Deno.test("parity: completeStaleChangesets sweeps in-progress to completed", async () => {
  const both = await onBoth(async (mgr) => {
    const working = await mgr.create({ title: "Working", plan: plan() });
    await mgr.approve(working.id);
    await mgr.startWork(working.id);
    await mgr.updateStep(working.id, "s1", "done");
    await mgr.updateStep(working.id, "s2", "done");
    await recordPassingVerification(mgr, working.id);
    const resolved = await mgr.completeStaleChangesets(null);
    return {
      resolvedStatuses: resolved.map((r) => r.status).toSorted(),
      working: (await mgr.get(working.id))?.status,
      workingSteps: (await mgr.get(working.id))?.plan.steps.map((s) =>
        s.status
      ),
    };
  });
  assertParity("completeStaleChangesets in_progress", both);
});

Deno.test("parity: completeStaleChangesets leaves uncovered verification in progress", async () => {
  const both = await onBoth(async (mgr) => {
    const working = await mgr.create({ title: "Working", plan: plan() });
    await mgr.approve(working.id);
    await mgr.startWork(working.id);
    await mgr.updateStep(working.id, "s1", "done");
    await mgr.updateStep(working.id, "s2", "done");
    await mgr.recordVerificationRun(working.id, {
      id: "vr_wrong_claim",
      status: "passed",
      summary: "Verification did not cover the planned claim.",
      evidence: [{
        id: "ev_wrong_claim",
        kind: "test_result",
        summary: "A check passed.",
        status: "passed",
        createdAt: "2026-01-01T00:00:00.000Z",
      }],
      claimResults: [{
        claimId: "claim_unplanned",
        status: "passed",
        evidenceIds: ["ev_wrong_claim"],
      }],
      residualRisks: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:00:00.000Z",
    });
    const resolved = await mgr.completeStaleChangesets(null);
    return {
      resolvedStatuses: resolved.map((r) => r.status).toSorted(),
      working: (await mgr.get(working.id))?.status,
    };
  });
  assertParity("completeStaleChangesets uncovered verification", both);
  assertEquals(both.file.resolvedStatuses, []);
  assertEquals(both.file.working, "in_progress");
  assertEquals(both.db.resolvedStatuses, []);
  assertEquals(both.db.working, "in_progress");
});

Deno.test("parity: completeStaleChangesets leaves unverified in-progress active", async () => {
  const both = await onBoth(async (mgr) => {
    const working = await mgr.create({ title: "Working", plan: plan() });
    await mgr.approve(working.id);
    await mgr.startWork(working.id);
    await mgr.updateStep(working.id, "s1", "done");
    const resolved = await mgr.completeStaleChangesets(null);
    return {
      resolvedStatuses: resolved.map((r) => r.status).toSorted(),
      working: (await mgr.get(working.id))?.status,
      workingSteps: (await mgr.get(working.id))?.plan.steps.map((s) =>
        s.status
      ),
    };
  });
  assertParity("completeStaleChangesets unverified in_progress", both);
});

// A planning changeset swept by completeStaleChangesets becomes abandoned.
Deno.test("parity: completeStaleChangesets sweeps planning to abandoned", async () => {
  const both = await onBoth(async (mgr) => {
    const planning = await mgr.create({ title: "Planning", plan: plan() });
    const resolved = await mgr.completeStaleChangesets(null);
    return {
      resolvedStatuses: resolved.map((r) => r.status).toSorted(),
      planning: (await mgr.get(planning.id))?.status,
    };
  });
  assertParity("completeStaleChangesets planning", both);
});

// --- lifecycle transition guards: both backends throw on invalid moves ---

Deno.test("parity: complete from planning throws (both backends)", async () => {
  const historyDir = await Deno.makeTempDir({
    dir: "/private/tmp",
    prefix: "tideide-cs-guard-",
  });
  const conn = await createDatabase({ driver: "pglite" });
  await conn.drizzle.execute(TABLE_DDL);
  try {
    for (
      const mgr of [
        new ChangesetManager(historyDir),
        new ChangesetManager(conn.drizzle),
      ]
    ) {
      const cs = await mgr.create({ title: "T", plan: plan() });
      await assertRejects(
        () => mgr.complete(cs.id),
        Error,
        "Invalid transition",
      );
    }
  } finally {
    rmSync(historyDir, { recursive: true, force: true });
    await conn.close();
  }
});

Deno.test("parity: complete from approved throws (both backends)", async () => {
  const historyDir = await Deno.makeTempDir({
    dir: "/private/tmp",
    prefix: "tideide-cs-guard-",
  });
  const conn = await createDatabase({ driver: "pglite" });
  await conn.drizzle.execute(TABLE_DDL);
  try {
    for (
      const mgr of [
        new ChangesetManager(historyDir),
        new ChangesetManager(conn.drizzle),
      ]
    ) {
      const cs = await mgr.create({ title: "T", plan: plan() });
      await mgr.approve(cs.id);
      await assertRejects(
        () => mgr.complete(cs.id),
        Error,
        "Invalid transition",
      );
    }
  } finally {
    rmSync(historyDir, { recursive: true, force: true });
    await conn.close();
  }
});

Deno.test("parity: complete without verification throws (both backends)", async () => {
  const historyDir = await Deno.makeTempDir({
    dir: "/private/tmp",
    prefix: "tideide-cs-guard-",
  });
  const conn = await createDatabase({ driver: "pglite" });
  await conn.drizzle.execute(TABLE_DDL);
  try {
    for (
      const mgr of [
        new ChangesetManager(historyDir),
        new ChangesetManager(conn.drizzle),
      ]
    ) {
      const cs = await mgr.create({ title: "T", plan: plan() });
      await mgr.approve(cs.id);
      await mgr.startWork(cs.id);
      await assertRejects(
        () => mgr.complete(cs.id),
        Error,
        "cannot be completed without a verification run",
      );
    }
  } finally {
    rmSync(historyDir, { recursive: true, force: true });
    await conn.close();
  }
});

Deno.test("parity: approve after abandon throws (both backends)", async () => {
  const historyDir = await Deno.makeTempDir({
    dir: "/private/tmp",
    prefix: "tideide-cs-guard-",
  });
  const conn = await createDatabase({ driver: "pglite" });
  await conn.drizzle.execute(TABLE_DDL);
  try {
    for (
      const mgr of [
        new ChangesetManager(historyDir),
        new ChangesetManager(conn.drizzle),
      ]
    ) {
      const cs = await mgr.create({ title: "T", plan: plan() });
      await mgr.abandon(cs.id);
      await assertRejects(
        () => mgr.approve(cs.id),
        Error,
        "Invalid transition",
      );
    }
  } finally {
    rmSync(historyDir, { recursive: true, force: true });
    await conn.close();
  }
});

Deno.test("parity: updatePlan after approve throws (both backends)", async () => {
  const historyDir = await Deno.makeTempDir({
    dir: "/private/tmp",
    prefix: "tideide-cs-guard-",
  });
  const conn = await createDatabase({ driver: "pglite" });
  await conn.drizzle.execute(TABLE_DDL);
  try {
    for (
      const mgr of [
        new ChangesetManager(historyDir),
        new ChangesetManager(conn.drizzle),
      ]
    ) {
      const cs = await mgr.create({ title: "T", plan: plan() });
      await mgr.approve(cs.id);
      await assertRejects(
        () => mgr.updatePlan(cs.id, plan()),
        Error,
        `Cannot update plan in status "approved"`,
      );
    }
  } finally {
    rmSync(historyDir, { recursive: true, force: true });
    await conn.close();
  }
});

Deno.test("parity: updateStep when not in_progress throws (both backends)", async () => {
  const historyDir = await Deno.makeTempDir({
    dir: "/private/tmp",
    prefix: "tideide-cs-guard-",
  });
  const conn = await createDatabase({ driver: "pglite" });
  await conn.drizzle.execute(TABLE_DDL);
  try {
    for (
      const mgr of [
        new ChangesetManager(historyDir),
        new ChangesetManager(conn.drizzle),
      ]
    ) {
      const cs = await mgr.create({ title: "T", plan: plan() });
      await assertRejects(
        () => mgr.updateStep(cs.id, "s1", "done"),
        Error,
        "Cannot update steps",
      );
    }
  } finally {
    rmSync(historyDir, { recursive: true, force: true });
    await conn.close();
  }
});

Deno.test("parity: recordAttestation appends to the ledger", async () => {
  const both = await onBoth(async (mgr) => {
    const cs = await mgr.create({ title: "Attest", plan: plan() });
    const updated = await mgr.recordAttestation(cs.id, {
      id: "att_1",
      kind: "invariant",
      status: "passed",
      fingerprint: "fp-1",
      scope: "handler:x",
      checkId: "spec_x",
      summary: "guard present",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    return { updated: normCs(updated), fetched: normCs(await mgr.get(cs.id)) };
  });
  assertParity("recordAttestation", both);
  assertEquals(both.file.updated?.plan.attestations?.length, 1);
  assertEquals(both.db.updated?.plan.attestations?.length, 1);
});

Deno.test("parity: recordAttestation dual-writes the ledger", async () => {
  const both = await onBoth(async (mgr) => {
    const cs = await mgr.create({ title: "Attest", plan: plan() });
    await mgr.recordAttestation(cs.id, {
      id: "att_dual",
      kind: "invariant",
      status: "passed",
      fingerprint: "fp-1",
      scope: "handler:x",
      checkId: "spec_x",
      summary: "guard present",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    // Strip the auto-generated changesetId — it differs across backends.
    return (await mgr.listLedger()).map(({ changesetId: _id, ...rest }) =>
      rest
    );
  });
  assertParity("ledger dual-write", both);
  assertEquals(both.db.length, 1);
  assertEquals(both.db[0]!.id, "att_dual");
  assertEquals(both.db[0]!.changesetTitle, "Attest");
});

Deno.test("parity: recordLedgerEntry + listLedger filters and ordering", async () => {
  const entry = (over: Record<string, unknown>) => ({
    id: "x",
    kind: "invariant" as const,
    status: "passed" as const,
    fingerprint: "fp",
    scope: "handler:x",
    summary: "s",
    createdAt: "2026-01-01T00:00:00.000Z",
    changesetId: "cs_1",
    changesetTitle: "L",
    ...over,
  });
  const both = await onBoth(async (mgr) => {
    await mgr.recordLedgerEntry(entry({
      id: "att_a",
      scope: "handler:x",
      kind: "invariant",
      checkId: "spec_x",
      createdAt: "2026-01-01T00:00:00.000Z",
    }));
    await mgr.recordLedgerEntry(entry({
      id: "att_b",
      scope: "project",
      kind: "adversarial",
      status: "failed",
      checkId: "claim_x",
      createdAt: "2026-01-02T00:00:00.000Z",
    }));
    await mgr.recordLedgerEntry(entry({
      id: "att_c",
      scope: "project",
      kind: "typecheck",
      createdAt: "2026-01-03T00:00:00.000Z",
    }));
    // Re-seen id is an idempotent no-op (attestations are immutable).
    await mgr.recordLedgerEntry(entry({
      id: "att_a",
      scope: "handler:x",
      kind: "invariant",
      checkId: "spec_x",
      createdAt: "2026-01-01T00:00:00.000Z",
    }));
    return {
      all: await mgr.listLedger(),
      byScope: await mgr.listLedger({ scope: "project" }),
      byKind: await mgr.listLedger({ kind: "invariant" }),
      since: await mgr.listLedger({ since: "2026-01-02T00:00:00.000Z" }),
      limited: await mgr.listLedger({ limit: 1 }),
      offset: await mgr.listLedger({ offset: 1 }),
    };
  });
  assertParity("ledger query", both);
  // Newest-first, upsert-deduped.
  assertEquals(both.db.all.map((e) => e.id), ["att_c", "att_b", "att_a"]);
  assertEquals(both.db.byScope.map((e) => e.id), ["att_c", "att_b"]);
  assertEquals(both.db.byKind.map((e) => e.id), ["att_a"]);
  assertEquals(both.db.since.map((e) => e.id), ["att_c", "att_b"]);
  assertEquals(both.db.limited.map((e) => e.id), ["att_c"]);
  assertEquals(both.db.offset.map((e) => e.id), ["att_b", "att_a"]);
});

Deno.test("parity: pruneLedger keeps the newest N", async () => {
  const entry = (id: string, createdAt: string) => ({
    id,
    kind: "invariant" as const,
    status: "passed" as const,
    fingerprint: "fp",
    scope: "handler:x",
    summary: "s",
    createdAt,
    changesetId: "cs_1",
    changesetTitle: "L",
  });
  const both = await onBoth(async (mgr) => {
    await mgr.recordLedgerEntry(entry("a", "2026-01-01T00:00:00.000Z"));
    await mgr.recordLedgerEntry(entry("b", "2026-01-02T00:00:00.000Z"));
    await mgr.recordLedgerEntry(entry("c", "2026-01-03T00:00:00.000Z"));
    await mgr.recordLedgerEntry(entry("d", "2026-01-04T00:00:00.000Z"));
    const deleted = await mgr.pruneLedger(2);
    const remaining = (await mgr.listLedger()).map((e) => e.id);
    const noop = await mgr.pruneLedger(5); // keep >= size
    const disabled = await mgr.pruneLedger(0); // retention off
    return { deleted, remaining, noop, disabled };
  });
  assertParity("pruneLedger", both);
  assertEquals(both.db.deleted, 2);
  assertEquals(both.db.remaining, ["d", "c"]); // newest kept
  assertEquals(both.db.noop, 0);
  assertEquals(both.db.disabled, 0);
});

Deno.test("parity: not-found operations throw (both backends)", async () => {
  const historyDir = await Deno.makeTempDir({
    dir: "/private/tmp",
    prefix: "tideide-cs-guard-",
  });
  const conn = await createDatabase({ driver: "pglite" });
  await conn.drizzle.execute(TABLE_DDL);
  try {
    for (
      const mgr of [
        new ChangesetManager(historyDir),
        new ChangesetManager(conn.drizzle),
      ]
    ) {
      await assertRejects(() => mgr.approve("nope"), Error, "not found");
      await assertRejects(() => mgr.complete("nope"), Error, "not found");
      await assertRejects(
        () => mgr.updatePlan("nope", plan()),
        Error,
        "not found",
      );
    }
  } finally {
    rmSync(historyDir, { recursive: true, force: true });
    await conn.close();
  }
});
