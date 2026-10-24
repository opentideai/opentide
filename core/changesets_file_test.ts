import { assert, assertEquals, assertRejects } from "@std/assert";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  ChangesetManager,
  type ChangesetPlan,
} from "../verification/changesets.ts";

const PLAN: ChangesetPlan = {
  summary: "Build the feature",
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

async function withFileChangesets(
  fn: (mgr: ChangesetManager, historyDir: string) => Promise<void>,
): Promise<void> {
  const historyDir = await Deno.makeTempDir({
    dir: "/private/tmp",
    prefix: "tideide-changesets-",
  });
  const mgr = new ChangesetManager(historyDir);
  try {
    await fn(mgr, historyDir);
  } finally {
    rmSync(historyDir, { recursive: true, force: true });
  }
}

function changesetPath(historyDir: string, id: string): string {
  return join(historyDir, "changesets", `${encodeURIComponent(id)}.json`);
}

Deno.test("file changesets persist across reload", async () => {
  await withFileChangesets(async (mgr, historyDir) => {
    const cs = await mgr.create({
      title: "Auth",
      description: "Add auth",
      sessionId: "session_1",
      plan: PLAN,
      planMessageIds: [1],
    });
    await mgr.approve(cs.id, 2);
    await mgr.startWork(cs.id);
    await mgr.updateStep(cs.id, "s1", "done");
    await mgr.addWorkMessageId(cs.id, 3);

    const reloaded = new ChangesetManager(historyDir);
    const fetched = await reloaded.get(cs.id);
    assertEquals(fetched?.status, "in_progress");
    assertEquals(fetched?.approvalMessageId, 2);
    assertEquals(fetched?.workMessageIds, [3]);
    assertEquals(fetched?.plan.steps[0]?.status, "done");

    const bySession = await reloaded.list({ sessionId: "session_1" });
    assertEquals(bySession.length, 1);
  });
});

Deno.test("file changesets can anchor completed changesets", async () => {
  await withFileChangesets(async (mgr) => {
    const cs = await mgr.create({
      title: "Auth",
      sessionId: "session_1",
      plan: PLAN,
    });
    await mgr.approve(cs.id, 2);
    await mgr.startWork(cs.id);
    await mgr.updateStep(cs.id, "s1", "done");
    await recordPassingVerification(mgr, cs.id);
    await mgr.complete(cs.id);

    const updated = await mgr.addWorkMessageId(cs.id, 4);
    const same = await mgr.addWorkMessageId(cs.id, 4);

    assertEquals(updated.status, "completed");
    assertEquals(updated.workMessageIds, [4]);
    assertEquals(same.workMessageIds, [4]);
  });
});

Deno.test("file changesets keep token usage unknown when aggregation finds no usage records", async () => {
  await withFileChangesets(async (mgr) => {
    const cs = await mgr.create({
      title: "Auth",
      sessionId: "session_1",
      plan: PLAN,
    });
    await mgr.approve(cs.id, 2);
    await mgr.startWork(cs.id);
    await mgr.updateStep(cs.id, "s1", "done");
    await recordPassingVerification(mgr, cs.id);
    await mgr.complete(cs.id);

    const updated = await mgr.aggregate(
      cs.id,
      { getTurnUsage: () => Promise.resolve(null) },
      { listByChangeset: () => Promise.resolve([{ turnId: "turn_1" }]) },
    );

    assertEquals(updated.tokenUsage, null);
  });
});

Deno.test("file changesets reject duplicate acceptance and verification ids", async () => {
  await withFileChangesets(async (mgr) => {
    await assertRejects(
      () =>
        mgr.create({
          title: "Duplicate claims",
          plan: {
            ...PLAN,
            acceptanceCriteria: [
              PLAN.acceptanceCriteria![0]!,
              { ...PLAN.acceptanceCriteria![0]!, text: "Duplicate" },
            ],
          },
        }),
      Error,
      'duplicate id "claim_tests"',
    );
    await assertRejects(
      () =>
        mgr.create({
          title: "Duplicate checks",
          plan: {
            ...PLAN,
            verificationPlan: [
              PLAN.verificationPlan![0]!,
              { ...PLAN.verificationPlan![0]!, description: "Duplicate" },
            ],
          },
        }),
      Error,
      'duplicate id "check_tests"',
    );
  });
});

Deno.test("file changesets update only the changed changeset file", async () => {
  await withFileChangesets(async (mgr, historyDir) => {
    const a = await mgr.create({ title: "A", plan: PLAN });
    const b = await mgr.create({ title: "B", plan: PLAN });

    const aPath = changesetPath(historyDir, a.id);
    const bPath = changesetPath(historyDir, b.id);
    const bBefore = readFileSync(bPath, "utf-8");
    const bMtime = statSync(bPath).mtime?.getTime();

    await mgr.patch(a.id, { title: "A changed" });

    assert(readFileSync(aPath, "utf-8").includes("A changed"));
    assertEquals(readFileSync(bPath, "utf-8"), bBefore);
    assertEquals(statSync(bPath).mtime?.getTime(), bMtime);
  });
});

Deno.test("file changesets enforce transitions", async () => {
  await withFileChangesets(async (mgr) => {
    const cs = await mgr.create({ title: "Invalid", plan: PLAN });
    await assertRejects(() => mgr.complete(cs.id), Error, "Invalid transition");
    await mgr.abandon(cs.id);
    assertEquals(await mgr.getActive(), null);
  });
});

Deno.test("file changesets reject completion without verification", async () => {
  await withFileChangesets(async (mgr) => {
    const cs = await mgr.create({ title: "Unverified", plan: PLAN });
    await mgr.approve(cs.id);
    await mgr.startWork(cs.id);

    await assertRejects(
      () => mgr.complete(cs.id),
      Error,
      "cannot be completed without a verification run",
    );
  });
});

Deno.test("file changesets delete by session", async () => {
  await withFileChangesets(async (mgr, historyDir) => {
    const keep = await mgr.create({
      title: "Keep",
      sessionId: "other",
      plan: PLAN,
    });
    await mgr.abandon(keep.id);
    const remove = await mgr.create({
      title: "Remove",
      sessionId: "session_1",
      plan: PLAN,
    });

    const ids = await mgr.deleteBySession("session_1");
    assertEquals(ids, [remove.id]);
    assertEquals(existsSync(changesetPath(historyDir, remove.id)), false);
    assertEquals(existsSync(changesetPath(historyDir, keep.id)), true);
  });
});
