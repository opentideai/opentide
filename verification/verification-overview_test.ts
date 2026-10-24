import { assert, assertEquals } from "@std/assert";
import { testStoreComposition } from "./test-stores.ts";
import { rmSync } from "node:fs";
import { Database } from "../core/db.ts";
import { Kernel } from "../core/registries.ts";
import type { ChangesetPlan } from "./changesets.ts";
import {
  fingerprintProject,
  hashSource,
  PROJECT_SCOPE,
} from "../core/fingerprint.ts";
import { buildVerificationOverview } from "./verification-overview.ts";

const HANDLER_SOURCE_A =
  "export const marker = 'v1'; export default () => new Response();";
const HANDLER_SOURCE_B =
  "export const marker = 'v2-edited'; export default () => new Response();";

async function withKernel(
  fn: (kernel: Kernel) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({
    dir: "/private/tmp",
    prefix: "tideide-overview-",
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

function planWithClaimAndSpec(): ChangesetPlan {
  return {
    summary: "Verify the target handler",
    steps: [{ id: "s1", description: "implement", status: "done" }],
    acceptanceCriteria: [{
      id: "claim_0",
      text: "Dividing the total by quantity never throws.",
      source: "agent",
      priority: "must",
    }],
    verificationPlan: [{
      id: "check_0",
      claimIds: ["claim_0"],
      kind: "invariant",
      description: "exhaustive switch guard",
    }],
    formalSpecs: [{
      id: "spec_0",
      claimIds: ["claim_0"],
      technique: "exhaustive-switch",
      scope: "handler:target",
      statement: "All cases handled",
      enforcement: "hard",
    }],
  };
}

Deno.test("buildVerificationOverview: a fresh passing invariant marks the entity verified", async () => {
  await withKernel(async (kernel) => {
    kernel.handlers.register("target", HANDLER_SOURCE_A, () => new Response());
    const cs = await kernel.changesets.create({
      title: "T",
      plan: planWithClaimAndSpec(),
    });
    await kernel.changesets.recordAttestation(cs.id, {
      kind: "invariant",
      status: "passed",
      fingerprint: hashSource(HANDLER_SOURCE_A),
      scope: "handler:target",
      checkId: "spec_0",
      summary: "invariant holds",
    });

    const overview = await buildVerificationOverview(kernel);
    const entity = overview.entities.find((e) => e.scope === "handler:target");
    assert(entity, "handler entity should be present");
    assertEquals(entity.type, "handler");
    assertEquals(entity.status, "verified");
    assertEquals(entity.invariants.length, 1);
    assert(entity.invariants[0]!.fresh);
    assertEquals(overview.totals.entitiesVerified, 1);
    assertEquals(overview.ledger.length, 1);
  });
});

Deno.test("buildVerificationOverview: editing the entity flips it to stale", async () => {
  await withKernel(async (kernel) => {
    kernel.handlers.register("target", HANDLER_SOURCE_A, () => new Response());
    const cs = await kernel.changesets.create({
      title: "T",
      plan: planWithClaimAndSpec(),
    });
    await kernel.changesets.recordAttestation(cs.id, {
      kind: "invariant",
      status: "passed",
      fingerprint: hashSource(HANDLER_SOURCE_A),
      scope: "handler:target",
      checkId: "spec_0",
      summary: "invariant holds",
    });

    // Edit the handler — the attestation's fingerprint no longer matches.
    kernel.handlers.register("target", HANDLER_SOURCE_B, () => new Response());

    const overview = await buildVerificationOverview(kernel);
    const entity = overview.entities.find((e) => e.scope === "handler:target");
    assert(entity);
    assertEquals(entity.status, "stale");
    assert(!entity.invariants[0]!.fresh);
    assertEquals(overview.totals.entitiesStale, 1);
    assertEquals(overview.totals.entitiesVerified, 0);
  });
});

Deno.test("buildVerificationOverview: a failed adversarial verdict refutes the claim", async () => {
  await withKernel(async (kernel) => {
    kernel.handlers.register("target", HANDLER_SOURCE_A, () => new Response());
    const cs = await kernel.changesets.create({
      title: "T",
      plan: planWithClaimAndSpec(),
    });
    await kernel.changesets.recordAttestation(cs.id, {
      kind: "adversarial",
      status: "failed",
      fingerprint: fingerprintProject(kernel),
      scope: PROJECT_SCOPE,
      checkId: "claim_0",
      summary: "Refuted: quantity=0 → division by zero",
    });

    const overview = await buildVerificationOverview(kernel);
    const claim = overview.claims.find((cl) => cl.claimId === "claim_0");
    assert(claim);
    assertEquals(claim.state, "refuted");
    assertEquals(claim.adversarial?.status, "failed");
    assertEquals(overview.totals.refutedClaims, 1);
  });
});

// `changesets.create` rejects duplicate claim ids (validateChangesetPlan), so this
// scenario can no longer be built through the public API — but rows persisted before
// that rule landed still load through here, and buildClaims' keyed Map is the only
// thing stopping such a row from rendering the same claim twice. Write the duplicate
// plan straight into the row to stand in for that legacy data.
Deno.test("buildVerificationOverview: duplicate claim ids surface once", async () => {
  await withKernel(async (kernel) => {
    kernel.handlers.register("target", HANDLER_SOURCE_A, () => new Response());
    const basePlan = planWithClaimAndSpec();
    const cs = await kernel.changesets.create({
      title: "T",
      plan: basePlan,
    });
    const legacyPlan: ChangesetPlan = {
      ...basePlan,
      acceptanceCriteria: [
        {
          id: "claim_0",
          text: "The original claim text.",
          source: "agent",
          priority: "must",
        },
        {
          id: "claim_0",
          text: "The amended claim text.",
          source: "agent",
          priority: "must",
        },
      ],
    };
    await kernel.db.execute(
      `UPDATE "_genie_changesets" SET plan = $1 WHERE id = $2`,
      [JSON.stringify(legacyPlan), cs.id],
    );
    await kernel.changesets.recordAttestation(cs.id, {
      kind: "adversarial",
      status: "failed",
      fingerprint: fingerprintProject(kernel),
      scope: PROJECT_SCOPE,
      checkId: "claim_0",
      summary: "Refuted: duplicate claim id",
    });

    const overview = await buildVerificationOverview(kernel);
    const claims = overview.claims.filter((cl) =>
      cl.changesetId === cs.id && cl.claimId === "claim_0"
    );
    assertEquals(claims.length, 1);
    assertEquals(claims[0]!.text, "The amended claim text.");
    assertEquals(claims[0]!.state, "refuted");
    assertEquals(overview.totals.refutedClaims, 1);
  });
});

Deno.test("buildVerificationOverview: project-scoped attestations surface in the snapshot", async () => {
  await withKernel(async (kernel) => {
    kernel.handlers.register("target", HANDLER_SOURCE_A, () => new Response());
    const cs = await kernel.changesets.create({
      title: "T",
      plan: planWithClaimAndSpec(),
    });
    await kernel.changesets.recordAttestation(cs.id, {
      kind: "typecheck",
      status: "passed",
      fingerprint: fingerprintProject(kernel),
      scope: PROJECT_SCOPE,
      summary: "deno check passed",
    });

    const overview = await buildVerificationOverview(kernel);
    const typecheck = overview.project.attestations.find((a) =>
      a.kind === "typecheck"
    );
    assert(typecheck, "project typecheck attestation should surface");
    assert(typecheck.fresh);
    assertEquals(overview.project.fingerprint, fingerprintProject(kernel));
  });
});

Deno.test("buildVerificationOverview: surfaces attestations beyond the old 100-changeset cap", async () => {
  await withKernel(async (kernel) => {
    kernel.handlers.register("target", HANDLER_SOURCE_A, () => new Response());
    // 105 changesets each carrying a project attestation — over the retired cap.
    for (let i = 0; i < 105; i++) {
      const cs = await kernel.changesets.create({
        title: `T${i}`,
        plan: planWithClaimAndSpec(),
      });
      await kernel.changesets.recordAttestation(cs.id, {
        kind: "test",
        status: "passed",
        fingerprint: fingerprintProject(kernel),
        scope: PROJECT_SCOPE,
        summary: `run ${i}`,
      });
    }

    const overview = await buildVerificationOverview(kernel);
    assertEquals(overview.ledger.length, 105);
    assertEquals(overview.totals.attestations, 105);
    assertEquals(overview.truncated, false);
  });
});

Deno.test("buildVerificationOverview: surfaces claims from changesets with no attestations yet", async () => {
  await withKernel(async (kernel) => {
    kernel.handlers.register("target", HANDLER_SOURCE_A, () => new Response());
    // A changeset with a must-claim but no verification run / attestations —
    // its claim must still surface (as unreviewed), not vanish with the ledger.
    await kernel.changesets.create({
      title: "T",
      plan: planWithClaimAndSpec(),
    });

    const overview = await buildVerificationOverview(kernel);
    const claim = overview.claims.find((c) => c.claimId === "claim_0");
    assert(claim, "an unattested changeset's claim should still surface");
    assertEquals(claim.state, "unreviewed");
  });
});

Deno.test("buildVerificationOverview: an entity with no invariant is unverified", async () => {
  await withKernel(async (kernel) => {
    kernel.functions.register("helper", "export default () => 1;", () => 1);
    const overview = await buildVerificationOverview(kernel);
    const entity = overview.entities.find((e) => e.scope === "function:helper");
    assert(entity);
    assertEquals(entity.type, "function");
    assertEquals(entity.status, "none");
    assertEquals(overview.totals.entitiesUnverified, 1);
  });
});
