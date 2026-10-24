import { assertEquals } from "@std/assert";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { SessionManager } from "./sessions.ts";
import {
  ChangesetManager,
  type ChangesetPlan,
} from "../verification/changesets.ts";
import { Changelog } from "./changelog.ts";
import { TEST_TMP_DIR } from "./test-home_test.ts";

const PLAN: ChangesetPlan = {
  summary: "Do work",
  steps: [{ id: "s1", description: "Step", status: "pending" }],
  acceptanceCriteria: [{
    id: "claim_tests",
    text: "The merged changeset is preserved.",
    source: "agent",
    priority: "must",
  }],
  verificationPlan: [{
    id: "check_tests",
    claimIds: ["claim_tests"],
    kind: "manual",
    description: "Inspect merged changesets.",
  }],
};

function copyTree(from: string, to: string): void {
  if (!existsSync(from)) return;
  cpSync(from, to, { recursive: true });
}

function mergeTree(from: string, to: string): void {
  if (!existsSync(from)) return;
  cpSync(from, to, { recursive: true, force: false, errorOnExist: false });
}

async function withHistoryCopies(
  fn: (
    base: string,
    devA: string,
    devB: string,
    merged: string,
  ) => Promise<void>,
): Promise<void> {
  const root = await Deno.makeTempDir({
    dir: TEST_TMP_DIR,
    prefix: "tideide-history-merge-",
  });
  const base = join(root, "base");
  const devA = join(root, "dev-a");
  const devB = join(root, "dev-b");
  const merged = join(root, "merged");
  mkdirSync(base, { recursive: true });
  try {
    copyTree(base, devA);
    copyTree(base, devB);
    await fn(base, devA, devB, merged);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

Deno.test("file history merges independent sessions and changesets", async () => {
  await withHistoryCopies(async (_base, devA, devB, merged) => {
    const sessionsA = new SessionManager(devA);
    const sessionA = await sessionsA.createSession("Developer A");
    const messageA = await sessionsA.addMessage({
      sessionId: sessionA.id,
      role: "user",
      content: "from A",
      turnId: "turn_a",
    });
    const changesetA = await new ChangesetManager(devA).create({
      sessionId: sessionA.id,
      title: "A changeset",
      plan: PLAN,
      planMessageIds: [messageA.id],
    });

    const sessionsB = new SessionManager(devB);
    const sessionB = await sessionsB.createSession("Developer B");
    const messageB = await sessionsB.addMessage({
      sessionId: sessionB.id,
      role: "user",
      content: "from B",
      turnId: "turn_b",
    });
    const changesetB = await new ChangesetManager(devB).create({
      sessionId: sessionB.id,
      title: "B changeset",
      plan: PLAN,
      planMessageIds: [messageB.id],
    });

    assertEquals(messageA.id === messageB.id, false);
    assertEquals(/^cs_[0-9a-z]+_[0-9a-f-]{36}$/.test(changesetA.id), true);
    assertEquals(/^cs_[0-9a-z]+_[0-9a-f-]{36}$/.test(changesetB.id), true);
    mergeTree(devA, merged);
    mergeTree(devB, merged);

    const mergedSessions = new SessionManager(merged);
    const sessions = await mergedSessions.listSessions(10);
    assertEquals(sessions.map((s) => s.name).sort(), [
      "Developer A",
      "Developer B",
    ]);
    assertEquals(
      (await mergedSessions.getMessages(sessionA.id))[0]?.content,
      "from A",
    );
    assertEquals(
      (await mergedSessions.getMessages(sessionB.id))[0]?.content,
      "from B",
    );

    const mergedChangesets = await new ChangesetManager(merged).list();
    assertEquals(mergedChangesets.map((cs) => cs.title).sort(), [
      "A changeset",
      "B changeset",
    ]);
    assertEquals(
      mergedChangesets.some((cs) => cs.id === changesetA.id),
      true,
    );
    assertEquals(
      mergedChangesets.some((cs) => cs.id === changesetB.id),
      true,
    );
  });
});

Deno.test("file history merges independent changelog record files", async () => {
  await withHistoryCopies(async (_base, devA, devB, merged) => {
    const logA = new Changelog(devA);
    const changeA = await logA.record({
      category: "handler",
      key: "fromA",
      action: "create",
      beforeSnapshot: null,
      afterSnapshot: { source: "function fromA() {}" },
      context: { turnId: "turn_a" },
    });

    const logB = new Changelog(devB);
    const changeB = await logB.record({
      category: "handler",
      key: "fromB",
      action: "create",
      beforeSnapshot: null,
      afterSnapshot: { source: "function fromB() {}" },
      context: { turnId: "turn_b" },
    });

    assertEquals(changeA.id === changeB.id, false);
    mergeTree(devA, merged);
    mergeTree(devB, merged);

    const recordsDir = join(merged, "changelog", "records");
    assertEquals(existsSync(recordsDir), true);

    const mergedLog = new Changelog(merged);
    assertEquals(await mergedLog.count(), 2);
    assertEquals(
      (await mergedLog.list({ limit: 10 })).map((r) => r.key).sort(),
      [
        "fromA",
        "fromB",
      ],
    );
  });
});
