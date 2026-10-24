import { assertEquals, assertRejects } from "@std/assert";
import { createDatabase } from "./factory.ts";
import {
  ChangesetManager,
  type ChangesetPlan,
} from "../../verification/changesets.ts";

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

const PLAN: ChangesetPlan = {
  summary: "Test plan",
  steps: [{ id: "s1", description: "Step 1", status: "pending" }],
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

async function withCs(
  fn: (mgr: ChangesetManager) => Promise<void>,
): Promise<void> {
  const conn = await createDatabase({ driver: "pglite" });
  await conn.drizzle.execute(TABLE_DDL);
  const mgr = new ChangesetManager(conn.drizzle);
  try {
    await fn(mgr);
  } finally {
    await conn.close();
  }
}

Deno.test("create returns a changeset with json plan", async () => {
  await withCs(async (mgr) => {
    const cs = await mgr.create({ title: "Test", plan: PLAN });
    assertEquals(cs.title, "Test");
    assertEquals(cs.status, "planning");
    assertEquals(cs.plan.summary, "Test plan");
    assertEquals(cs.plan.steps.length, 1);
    assertEquals(cs.planMessageIds, []);
    assertEquals(cs.workMessageIds, []);
  });
});

Deno.test("get retrieves by id", async () => {
  await withCs(async (mgr) => {
    const cs = await mgr.create({ title: "Test", plan: PLAN });
    const fetched = await mgr.get(cs.id);
    assertEquals(fetched?.id, cs.id);
    assertEquals(fetched?.plan.summary, "Test plan");
  });
});

Deno.test("get returns null for missing id", async () => {
  await withCs(async (mgr) => {
    assertEquals(await mgr.get("nope"), null);
  });
});

Deno.test("list filters by sessionId", async () => {
  await withCs(async (mgr) => {
    const a = await mgr.create({ title: "A", plan: PLAN, sessionId: "s1" });
    await mgr.abandon(a.id);
    const b = await mgr.create({ title: "B", plan: PLAN, sessionId: "s2" });
    await mgr.abandon(b.id);
    await mgr.create({ title: "C", plan: PLAN, sessionId: "s1" });
    const list = await mgr.list({ sessionId: "s1" });
    assertEquals(list.length, 2);
  });
});

Deno.test("list filters by status", async () => {
  await withCs(async (mgr) => {
    const cs = await mgr.create({ title: "A", plan: PLAN });
    await mgr.approve(cs.id);
    await mgr.startWork(cs.id);
    await mgr.updateStep(cs.id, "s1", "done");
    await recordPassingVerification(mgr, cs.id);
    await mgr.complete(cs.id);

    const b = await mgr.create({ title: "B", plan: PLAN });
    await mgr.approve(b.id);
    await mgr.startWork(b.id);

    const inProgress = await mgr.list({ status: "in_progress" });
    assertEquals(inProgress.length, 1);
    assertEquals(inProgress[0]!.id, b.id);

    const completed = await mgr.list({ status: "completed" });
    assertEquals(completed.length, 1);
    assertEquals(completed[0]!.id, cs.id);
  });
});

Deno.test("approve transitions to approved", async () => {
  await withCs(async (mgr) => {
    const cs = await mgr.create({ title: "Test", plan: PLAN });
    const approved = await mgr.approve(cs.id, 42);
    assertEquals(approved.status, "approved");
    assertEquals(approved.approvalMessageId, 42);
  });
});

Deno.test("startWork transitions from approved to in_progress", async () => {
  await withCs(async (mgr) => {
    const cs = await mgr.create({ title: "Test", plan: PLAN });
    await mgr.approve(cs.id);
    const started = await mgr.startWork(cs.id);
    assertEquals(started.status, "in_progress");
  });
});

Deno.test("complete transitions from in_progress", async () => {
  await withCs(async (mgr) => {
    const cs = await mgr.create({ title: "Test", plan: PLAN });
    await mgr.approve(cs.id);
    await mgr.startWork(cs.id);
    await mgr.updateStep(cs.id, "s1", "done");
    await recordPassingVerification(mgr, cs.id);
    const completed = await mgr.complete(cs.id);
    assertEquals(completed.status, "completed");
    assertEquals(completed.completedAt !== null, true);
  });
});

Deno.test("abandon works from planning", async () => {
  await withCs(async (mgr) => {
    const cs = await mgr.create({ title: "Test", plan: PLAN });
    const abandoned = await mgr.abandon(cs.id);
    assertEquals(abandoned.status, "abandoned");
  });
});

Deno.test("reject works from planning", async () => {
  await withCs(async (mgr) => {
    const cs = await mgr.create({ title: "Test", plan: PLAN });
    const rejected = await mgr.reject(cs.id);
    assertEquals(rejected.status, "rejected");
  });
});

Deno.test("addPlanMessageId anchors plan messages", async () => {
  await withCs(async (mgr) => {
    const cs = await mgr.create({ title: "Test", plan: PLAN });
    const updated = await mgr.addPlanMessageId(cs.id, 123);
    const same = await mgr.addPlanMessageId(cs.id, 123);
    assertEquals(updated.planMessageIds, [123]);
    assertEquals(same.planMessageIds, [123]);
  });
});

Deno.test("invalid transition throws", async () => {
  await withCs(async (mgr) => {
    const cs = await mgr.create({ title: "Test", plan: PLAN });
    await assertRejects(() => mgr.complete(cs.id), Error, "Invalid transition");
  });
});

Deno.test("complete rejects without verification run", async () => {
  await withCs(async (mgr) => {
    const cs = await mgr.create({ title: "Test", plan: PLAN });
    await mgr.approve(cs.id);
    await mgr.startWork(cs.id);

    await assertRejects(
      () => mgr.complete(cs.id),
      Error,
      "cannot be completed without a verification run",
    );
  });
});

Deno.test("updatePlan modifies plan json", async () => {
  await withCs(async (mgr) => {
    const cs = await mgr.create({ title: "Test", plan: PLAN });
    const newPlan: ChangesetPlan = {
      summary: "Updated",
      steps: [],
      acceptanceCriteria: PLAN.acceptanceCriteria,
      verificationPlan: PLAN.verificationPlan,
    };
    const updated = await mgr.updatePlan(cs.id, newPlan);
    assertEquals(updated.plan.summary, "Updated");
    assertEquals(updated.plan.steps.length, 0);
  });
});

Deno.test("updateStep modifies step status", async () => {
  await withCs(async (mgr) => {
    const cs = await mgr.create({ title: "Test", plan: PLAN });
    await mgr.approve(cs.id);
    await mgr.startWork(cs.id);
    const updated = await mgr.updateStep(cs.id, "s1", "done");
    assertEquals(updated.plan.steps[0]!.status, "done");
  });
});

Deno.test("addWorkMessageId appends to array", async () => {
  await withCs(async (mgr) => {
    const cs = await mgr.create({ title: "Test", plan: PLAN });
    await mgr.approve(cs.id);
    await mgr.addWorkMessageId(cs.id, 10);
    await mgr.addWorkMessageId(cs.id, 20);
    const fetched = await mgr.get(cs.id);
    assertEquals(fetched?.workMessageIds, [10, 20]);
  });
});

Deno.test("addWorkMessageId can anchor completed changesets", async () => {
  await withCs(async (mgr) => {
    const cs = await mgr.create({ title: "Test", plan: PLAN });
    await mgr.approve(cs.id);
    await mgr.startWork(cs.id);
    await mgr.updateStep(cs.id, "s1", "done");
    await recordPassingVerification(mgr, cs.id);
    await mgr.complete(cs.id);

    const updated = await mgr.addWorkMessageId(cs.id, 30);
    const same = await mgr.addWorkMessageId(cs.id, 30);

    assertEquals(updated.status, "completed");
    assertEquals(updated.workMessageIds, [30]);
    assertEquals(same.workMessageIds, [30]);
  });
});

Deno.test("setApprovalMessageId stores approval message", async () => {
  await withCs(async (mgr) => {
    const cs = await mgr.create({ title: "Test", plan: PLAN });
    await mgr.approve(cs.id);
    await mgr.startWork(cs.id);
    const updated = await mgr.setApprovalMessageId(cs.id, 123);
    assertEquals(updated.approvalMessageId, 123);
  });
});

Deno.test("getActive returns most recent active changeset", async () => {
  await withCs(async (mgr) => {
    await mgr.create({ title: "A", plan: PLAN, sessionId: "s1" });
    const b = await mgr.create({ title: "B", plan: PLAN, sessionId: "s1" });
    const active = await mgr.getActive("s1");
    assertEquals(active?.id, b.id);
  });
});

Deno.test("getActive returns null when none active", async () => {
  await withCs(async (mgr) => {
    const cs = await mgr.create({ title: "A", plan: PLAN });
    await mgr.abandon(cs.id);
    assertEquals(await mgr.getActive(), null);
  });
});

Deno.test("patch updates title and description", async () => {
  await withCs(async (mgr) => {
    const cs = await mgr.create({
      title: "Old",
      plan: PLAN,
      description: "old desc",
    });
    const patched = await mgr.patch(cs.id, {
      title: "New",
      description: "new desc",
    });
    assertEquals(patched?.title, "New");
    assertEquals(patched?.description, "new desc");
  });
});

Deno.test("patch preserves fields not provided", async () => {
  await withCs(async (mgr) => {
    const cs = await mgr.create({
      title: "Keep",
      plan: PLAN,
      description: "keep",
    });
    const patched = await mgr.patch(cs.id, { title: "Changed" });
    assertEquals(patched?.title, "Changed");
    assertEquals(patched?.description, "keep");
  });
});
