import { assertEquals } from "@std/assert";
import { testStoreComposition } from "./test-stores.ts";
import { rmSync } from "node:fs";
import { Database } from "../core/db.ts";
import { Kernel } from "../core/registries.ts";
import type { Attestation, ChangesetPlan } from "./changesets.ts";
import { backfillVerificationLedger } from "./verification-ledger.ts";
import { TEST_TMP_DIR } from "../core/test-home_test.ts";

async function withKernel(fn: (kernel: Kernel) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({
    dir: TEST_TMP_DIR,
    prefix: "tideide-ledger-",
  });
  const db = await Database.create({ driver: "pglite" });
  const kernel = new Kernel(db, { composition: testStoreComposition() });
  kernel.projectDir = dir;
  try {
    await fn(kernel);
  } finally {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function att(over: Partial<Attestation>): Attestation {
  return {
    id: "att",
    kind: "invariant",
    status: "passed",
    fingerprint: "fp",
    scope: "handler:x",
    summary: "s",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

function planWith(attestations: Attestation[]): ChangesetPlan {
  return {
    summary: "S",
    steps: [{ id: "s1", description: "d", status: "done" }],
    acceptanceCriteria: [{
      id: "claim_0",
      text: "The behavior holds.",
      source: "agent",
      priority: "must",
    }],
    verificationPlan: [{
      id: "check_0",
      claimIds: ["claim_0"],
      kind: "unit",
      description: "Run the test.",
    }],
    attestations,
  };
}

Deno.test("backfill seeds the ledger from embedded attestations, idempotently", async () => {
  await withKernel(async (kernel) => {
    // Simulate pre-ledger data: attestations embedded in the plan (create does
    // not dual-write), so the ledger starts empty.
    await kernel.changesets.create({
      title: "A",
      plan: planWith([
        att({ id: "att_1" }),
        att({ id: "att_2", kind: "typecheck", scope: "project" }),
      ]),
    });
    await kernel.changesets.create({
      title: "B",
      plan: planWith([
        att({ id: "att_3", kind: "adversarial", status: "failed", scope: "project", checkId: "claim_1" }),
      ]),
    });
    assertEquals((await kernel.changesets.listLedger()).length, 0);

    const seeded = await backfillVerificationLedger(kernel);
    assertEquals(seeded, 3);
    assertEquals((await kernel.changesets.listLedger()).length, 3);

    // Guarded no-op on re-run — no duplicates.
    assertEquals(await backfillVerificationLedger(kernel), 0);
    assertEquals((await kernel.changesets.listLedger()).length, 3);
  });
});

Deno.test("pruneLedger keeps the newest N; no-op when disabled or under the cap", async () => {
  await withKernel(async (kernel) => {
    for (let i = 0; i < 5; i++) {
      await kernel.changesets.recordLedgerEntry({
        id: `att_${i}`,
        kind: "test",
        status: "passed",
        fingerprint: "fp",
        scope: "project",
        summary: `run ${i}`,
        createdAt: `2026-01-0${i + 1}T00:00:00.000Z`,
        changesetId: "cs_1",
        changesetTitle: "T",
      });
    }
    assertEquals(await kernel.changesets.pruneLedger(0), 0); // retention disabled
    assertEquals((await kernel.changesets.listLedger()).length, 5);
    assertEquals(await kernel.changesets.pruneLedger(10), 0); // under the cap
    assertEquals(await kernel.changesets.pruneLedger(2), 3); // deletes the oldest 3
    assertEquals(
      (await kernel.changesets.listLedger()).map((e) => e.id),
      ["att_4", "att_3"],
    );
  });
});

Deno.test("backfill is a no-op once dual-write has populated the ledger", async () => {
  await withKernel(async (kernel) => {
    const cs = await kernel.changesets.create({ title: "A", plan: planWith([]) });
    await kernel.changesets.recordAttestation(cs.id, {
      kind: "invariant",
      status: "passed",
      fingerprint: "fp",
      scope: "handler:x",
      summary: "s",
    });
    assertEquals((await kernel.changesets.listLedger()).length, 1);

    // Ledger already populated → backfill skips and does not duplicate.
    assertEquals(await backfillVerificationLedger(kernel), 0);
    assertEquals((await kernel.changesets.listLedger()).length, 1);
  });
});
