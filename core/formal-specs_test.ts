import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { testStoreComposition } from "../verification/test-stores.ts";
import { rmSync } from "node:fs";
import {
  type Attestation,
  type Changeset,
  ChangesetManager,
  type ChangesetPlan,
  checkChangesetReadiness,
  type FormalSpec,
  type VerificationRun,
} from "../verification/changesets.ts";
import { Database } from "./db.ts";
import { verifyFormalSpecMarker } from "./qc.ts";
import { Kernel } from "./registries.ts";
import { currentFingerprints, fingerprintScope } from "./fingerprint.ts";
import { runFormalSpecVerification } from "./tools/dispatch.ts";

const SCOPE = "handler:processOrder";

// A kernel-minted invariant attestation for the HARD_SPEC's target entity.
function invariantAttestation(
  fingerprint: string,
  status: "passed" | "failed" = "passed",
): Attestation {
  return {
    id: "att_status",
    kind: "invariant",
    status,
    fingerprint,
    scope: SCOPE,
    checkId: "spec_status",
    summary: "assertNever guard present.",
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

const HARD_SPEC: FormalSpec = {
  id: "spec_status",
  claimIds: ["claim_status"],
  technique: "exhaustive-switch",
  scope: "handler:processOrder",
  statement: "Every OrderStatus is handled.",
  enforcement: "hard",
};

function invariantRun(
  specId: string,
  status: "passed" | "failed",
): VerificationRun {
  return {
    id: "vr_1",
    status: "passed",
    summary: "Verification run.",
    evidence: [{
      id: "ev_inv",
      kind: "invariant",
      summary: "assertNever guard present.",
      status,
      checkId: specId,
      createdAt: "2026-01-01T00:00:00.000Z",
    }],
    claimResults: [{
      claimId: "claim_status",
      status: "passed",
      evidenceIds: ["ev_inv"],
    }],
    residualRisks: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:00.000Z",
  };
}

// A verification run whose only evidence is narrative (kind "manual"), so it
// satisfies "has a run" without triggering UNATTESTED_EVIDENCE.
function narrativeRun(): VerificationRun {
  return {
    id: "vr_n",
    status: "passed",
    summary: "Manual check.",
    evidence: [{
      id: "ev_n",
      kind: "manual",
      summary: "Reviewed by hand.",
      status: "passed",
      createdAt: "2026-01-01T00:00:00.000Z",
    }],
    claimResults: [{
      claimId: "claim_status",
      status: "passed",
      evidenceIds: ["ev_n"],
    }],
    residualRisks: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:00.000Z",
  };
}

function makeChangeset(plan: ChangesetPlan): Changeset {
  return {
    id: "cs_1",
    sessionId: null,
    title: "Test",
    description: null,
    status: "in_progress",
    plan,
    planMessageIds: [],
    approvalMessageId: null,
    workMessageIds: [],
    toolCalls: null,
    reasoning: null,
    tokenUsage: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    completedAt: null,
  };
}

function basePlan(
  specs: FormalSpec[],
  runs: VerificationRun[],
  attestations: Attestation[] = [],
): ChangesetPlan {
  return {
    summary: "Feature",
    steps: [{ id: "s1", description: "Step", status: "done" }],
    acceptanceCriteria: [{
      id: "claim_status",
      text: "Order status handling is exhaustive.",
      source: "agent",
      priority: "must",
    }],
    verificationPlan: [{
      id: "check_status",
      claimIds: ["claim_status"],
      kind: "invariant",
      description: "Exhaustive switch enforced by the compiler.",
    }],
    formalSpecs: specs,
    verificationRuns: runs,
    ...(attestations.length > 0 ? { attestations } : {}),
  };
}

Deno.test("readiness: hard spec without an attestation blocks completion", () => {
  const readiness = checkChangesetReadiness(
    makeChangeset(
      basePlan([HARD_SPEC], [invariantRun("spec_status", "failed")]),
    ),
  );
  assert(readiness.errors.some((e) => e.code === "UNVERIFIED_FORMAL_SPEC"));
  assertEquals(readiness.checks.formalSpecs, 1);
  assertEquals(readiness.checks.formalSpecsVerified, 0);
});

Deno.test("readiness: hard spec with a fresh passing attestation is verified", () => {
  const fp = "abc-123";
  const readiness = checkChangesetReadiness(
    makeChangeset(
      basePlan(
        [HARD_SPEC],
        [invariantRun("spec_status", "passed")],
        [invariantAttestation(fp)],
      ),
    ),
    { [SCOPE]: fp },
  );
  assert(!readiness.errors.some((e) => e.code === "UNVERIFIED_FORMAL_SPEC"));
  assertEquals(readiness.checks.formalSpecsVerified, 1);
});

Deno.test("readiness: hard spec with a STALE attestation blocks (drift detected)", () => {
  const readiness = checkChangesetReadiness(
    makeChangeset(
      basePlan(
        [HARD_SPEC],
        [invariantRun("spec_status", "passed")],
        [invariantAttestation("old-fingerprint")],
      ),
    ),
    { [SCOPE]: "new-fingerprint" }, // entity changed since attestation
  );
  const stale = readiness.errors.find((e) =>
    e.code === "UNVERIFIED_FORMAL_SPEC"
  );
  assert(stale, "stale hard spec should block");
  assert(stale.message.includes("stale"));
  assertEquals(readiness.checks.formalSpecsVerified, 0);
  assertEquals(readiness.checks.staleAttestations, 1);
});

Deno.test("readiness: existence-only backstop (no fingerprints) trusts a passing attestation", () => {
  const readiness = checkChangesetReadiness(
    makeChangeset(
      basePlan(
        [HARD_SPEC],
        [invariantRun("spec_status", "passed")],
        [invariantAttestation("any-fingerprint")],
      ),
    ),
    // no currentFingerprints — the store backstop path
  );
  assert(!readiness.errors.some((e) => e.code === "UNVERIFIED_FORMAL_SPEC"));
  assertEquals(readiness.checks.formalSpecsVerified, 1);
});

Deno.test("readiness: unmet soft spec warns but does not block", () => {
  const softSpec: FormalSpec = { ...HARD_SPEC, enforcement: "soft" };
  const readiness = checkChangesetReadiness(
    makeChangeset(
      basePlan([softSpec], [invariantRun("spec_status", "failed")]),
    ),
  );
  assert(!readiness.errors.some((e) => e.code === "UNVERIFIED_FORMAL_SPEC"));
  assert(readiness.warnings.some((w) => w.code === "SOFT_FORMAL_SPEC_UNMET"));
});

Deno.test("readiness: grounded evidence without an attestation warns (unattested)", () => {
  const run: VerificationRun = {
    id: "vr_typecheck",
    status: "passed",
    summary: "typecheck",
    evidence: [{
      id: "ev_tc",
      kind: "typecheck",
      summary: "Export type check passed.",
      status: "passed",
      createdAt: "2026-01-01T00:00:00.000Z",
    }],
    claimResults: [{
      claimId: "claim_status",
      status: "passed",
      evidenceIds: ["ev_tc"],
    }],
    residualRisks: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:00.000Z",
  };
  const readiness = checkChangesetReadiness(
    makeChangeset(basePlan([], [run])),
  );
  assert(readiness.warnings.some((w) => w.code === "UNATTESTED_EVIDENCE"));
});

Deno.test("readiness: a fresh refuted adversarial attestation blocks completion", () => {
  const att: Attestation = {
    id: "att_adv",
    kind: "adversarial",
    status: "failed",
    fingerprint: "fp1",
    scope: "project",
    checkId: "claim_status",
    summary: "Refuted: negative quantity underflows the total.",
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  const plan = basePlan([], [invariantRun("spec_status", "passed")], [att]);
  const readiness = checkChangesetReadiness(makeChangeset(plan), {
    project: "fp1",
  });
  assert(readiness.errors.some((e) => e.code === "CLAIM_REFUTED"));
  assert(!readiness.passed);
  assertEquals(readiness.checks.claimsRefuted, 1);

  // A stale refutation (fingerprint drifted) is ignored.
  const stale = checkChangesetReadiness(makeChangeset(plan), {
    project: "fp2",
  });
  assert(!stale.errors.some((w) => w.code === "CLAIM_REFUTED"));
  assertEquals(stale.checks.claimsRefuted, 0);
});

Deno.test("readiness: store-gate path (no fingerprints) does not resurrect a refuted verdict", () => {
  // The store completion gate (assertReadyToComplete / canAutoComplete) runs
  // checkChangesetReadiness WITHOUT a fingerprint map — it has no kernel access.
  // A historical `failed` adversarial attestation, superseded on current code,
  // must not resurrect as a hard block on that path; the fingerprint-aware
  // dispatch gate is authoritative. Regression for a permanently-stuck
  // complete_changeset ("not ready: N error(s)") caused by append-only,
  // already-stale refuted verdicts.
  const att: Attestation = {
    id: "att_adv",
    kind: "adversarial",
    status: "failed",
    fingerprint: "fp_old",
    scope: "project",
    checkId: "claim_status",
    summary: "Refuted at an earlier code state.",
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  const plan = basePlan([], [invariantRun("spec_status", "passed")], [att]);
  const r = checkChangesetReadiness(makeChangeset(plan)); // no fingerprints
  assert(!r.errors.some((e) => e.code === "CLAIM_REFUTED"));
  assertEquals(r.checks.claimsRefuted, 0);
});

Deno.test("readiness: only a claim's LATEST fresh adversarial verdict counts", () => {
  const adv = (
    id: string,
    status: "passed" | "failed",
    createdAt: string,
  ): Attestation => ({
    id,
    kind: "adversarial",
    status,
    fingerprint: "fp1",
    scope: "project",
    checkId: "claim_status",
    summary: `Adversarial verdict ${status}.`,
    createdAt,
  });
  const fp = { project: "fp1" };

  // Refuted, then re-reviewed and passed at the SAME fingerprint: the later
  // `passed` supersedes the earlier counterexample — the claim is not refuted.
  const resolved = checkChangesetReadiness(
    makeChangeset(basePlan([], [invariantRun("spec_status", "passed")], [
      adv("att_fail", "failed", "2026-01-01T00:00:00.000Z"),
      adv("att_pass", "passed", "2026-01-01T00:01:00.000Z"),
    ])),
    fp,
  );
  assert(!resolved.errors.some((e) => e.code === "CLAIM_REFUTED"));
  assertEquals(resolved.checks.claimsRefuted, 0);

  // Passed, then re-refuted at the same fingerprint: the latest verdict is
  // `failed`, so the claim blocks.
  const reRefuted = checkChangesetReadiness(
    makeChangeset(basePlan([], [invariantRun("spec_status", "passed")], [
      adv("att_pass", "passed", "2026-01-01T00:00:00.000Z"),
      adv("att_fail", "failed", "2026-01-01T00:01:00.000Z"),
    ])),
    fp,
  );
  assert(reRefuted.errors.some((e) => e.code === "CLAIM_REFUTED"));
  assertEquals(reRefuted.checks.claimsRefuted, 1);
});

Deno.test("readiness: an unreviewed must-claim warns (MUST_CLAIM_UNREVIEWED), clears when reviewed", () => {
  // basePlan's claim_status is a `must` criterion with no adversarial verdict.
  const bare = checkChangesetReadiness(
    makeChangeset(basePlan([], [invariantRun("spec_status", "passed")])),
    { project: "fp1" },
  );
  assert(bare.warnings.some((w) => w.code === "MUST_CLAIM_UNREVIEWED"));
  assertEquals(bare.checks.mustClaimsReviewed, 0);

  // A fresh adversarial attestation (any verdict) marks it reviewed.
  const att: Attestation = {
    id: "att_adv",
    kind: "adversarial",
    status: "passed",
    fingerprint: "fp1",
    scope: "project",
    checkId: "claim_status",
    summary: "Survived 2 refutation attempt(s).",
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  const reviewed = checkChangesetReadiness(
    makeChangeset(basePlan([], [invariantRun("spec_status", "passed")], [att])),
    { project: "fp1" },
  );
  assert(!reviewed.warnings.some((w) => w.code === "MUST_CLAIM_UNREVIEWED"));
  assertEquals(reviewed.checks.mustClaimsReviewed, 1);
});

Deno.test("readiness: failed or partial evidence blocks completion", () => {
  for (const status of ["failed", "partial"] as const) {
    const run = narrativeRun();
    run.evidence[0]!.status = status;
    const readiness = checkChangesetReadiness(
      makeChangeset(basePlan([], [run])),
    );
    assert(
      readiness.errors.some((e) =>
        e.code === "VERIFICATION_EVIDENCE_NOT_PASSING"
      ),
      status,
    );
    assert(!readiness.passed, status);
  }
});

Deno.test("readiness: failed or partial claim results block completion", () => {
  for (const status of ["failed", "partial"] as const) {
    const run = narrativeRun();
    run.claimResults[0]!.status = status;
    const readiness = checkChangesetReadiness(
      makeChangeset(basePlan([], [run])),
    );
    assert(
      readiness.errors.some((e) => e.code === "CLAIM_RESULTS_NOT_PASSING"),
      status,
    );
    assert(!readiness.passed, status);
  }
});

Deno.test("readiness: manual claim results require an explicit manual planned check", () => {
  const run = narrativeRun();
  run.claimResults[0]!.status = "manual";
  const unplanned = checkChangesetReadiness(makeChangeset(basePlan([], [run])));
  assert(
    unplanned.errors.some((e) => e.code === "UNPLANNED_MANUAL_VERIFICATION"),
  );
  assert(!unplanned.passed);

  const plan = basePlan([], [run]);
  plan.verificationPlan = [{
    id: "check_manual",
    claimIds: ["claim_status"],
    kind: "manual",
    description: "Human review of the acceptance criterion.",
  }];
  const planned = checkChangesetReadiness(makeChangeset(plan));
  assert(
    !planned.errors.some((e) => e.code === "UNPLANNED_MANUAL_VERIFICATION"),
  );
});

// --- Phase 5B: graduated readiness enforcement ---

Deno.test("enforcement: UNATTESTED_EVIDENCE is advisory, hardens at graduated + strict", () => {
  // invariantRun carries grounded invariant evidence with no attestationId.
  const cs = makeChangeset(
    basePlan([], [invariantRun("spec_status", "passed")]),
  );

  const advisory = checkChangesetReadiness(cs, undefined, "advisory");
  assert(advisory.warnings.some((w) => w.code === "UNATTESTED_EVIDENCE"));
  assert(advisory.passed, "advisory never blocks on evidence provenance");

  for (const mode of ["graduated", "strict"] as const) {
    const r = checkChangesetReadiness(cs, undefined, mode);
    assert(r.errors.some((e) => e.code === "UNATTESTED_EVIDENCE"), mode);
    assert(!r.warnings.some((w) => w.code === "UNATTESTED_EVIDENCE"), mode);
    assert(!r.passed, mode);
  }
});

Deno.test("readiness: malformed claim evidence references stay diagnosable", () => {
  const malformedRun: VerificationRun = {
    id: "vr_bad_refs",
    status: "passed",
    summary: "Verification run.",
    evidence: [{
      id: "ev_tests",
      kind: "unit",
      summary: "Unit tests passed.",
      status: "passed",
      checkId: "check_status",
      createdAt: "2026-01-01T00:00:00.000Z",
    }],
    claimResults: [{
      claimId: "claim_status",
      status: "passed",
      evidenceIds: ["check_status"],
    }],
    residualRisks: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:00.000Z",
  };
  const readiness = checkChangesetReadiness(
    makeChangeset(basePlan([], [malformedRun])),
  );
  const issue = readiness.errors.find((item) =>
    item.code === "MISSING_REFERENCED_EVIDENCE"
  );

  assert(issue);
  assertStringIncludes(issue.message, "claim evidence reference");
  assertStringIncludes(issue.action, "check_status");
});

Deno.test("enforcement: STALE_EVIDENCE is advisory, hardens at graduated + strict", () => {
  const staleAtt: Attestation = {
    id: "att_tc",
    kind: "typecheck",
    status: "passed",
    fingerprint: "old",
    scope: "project",
    summary: "typecheck passed",
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  const run: VerificationRun = {
    id: "vr_tc",
    status: "passed",
    summary: "Typecheck.",
    evidence: [{
      id: "ev_tc",
      kind: "typecheck",
      summary: "typecheck passed",
      status: "passed",
      attestationId: "att_tc",
      createdAt: "2026-01-01T00:00:00.000Z",
    }],
    claimResults: [{
      claimId: "claim_status",
      status: "passed",
      evidenceIds: ["ev_tc"],
    }],
    residualRisks: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:00.000Z",
  };
  const cs = makeChangeset(basePlan([], [run], [staleAtt]));
  const fps = { project: "new" }; // "old" !== "new" → the attestation is stale

  assert(
    checkChangesetReadiness(cs, fps, "advisory").warnings.some((w) =>
      w.code === "STALE_EVIDENCE"
    ),
  );
  const graduated = checkChangesetReadiness(cs, fps, "graduated");
  assert(graduated.errors.some((e) => e.code === "STALE_EVIDENCE"));
  assert(!graduated.passed);
  assert(
    checkChangesetReadiness(cs, fps, "strict").errors.some((e) =>
      e.code === "STALE_EVIDENCE"
    ),
  );
});

Deno.test("enforcement: CLAIM_REFUTED is a hard completion blocker in every mode", () => {
  const refuted: Attestation = {
    id: "att_adv",
    kind: "adversarial",
    status: "failed",
    fingerprint: "fp1",
    scope: "project",
    checkId: "claim_status",
    summary: "Refuted: quantity=0 divides by zero.",
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  const cs = makeChangeset(basePlan([], [narrativeRun()], [refuted]));
  const fps = { project: "fp1" }; // fresh verdict

  for (const mode of ["advisory", "graduated", "strict"] as const) {
    const readiness = checkChangesetReadiness(cs, fps, mode);
    assert(readiness.errors.some((e) => e.code === "CLAIM_REFUTED"), mode);
    assert(!readiness.passed, mode);
  }
});

Deno.test("enforcement: MUST_CLAIM_UNREVIEWED stays advisory at graduated, hardens only at strict", () => {
  const cs = makeChangeset(basePlan([], [narrativeRun()])); // must-claim, no adversarial
  const fps = { project: "fp1" };

  const advisory = checkChangesetReadiness(cs, fps, "advisory");
  assert(advisory.warnings.some((w) => w.code === "MUST_CLAIM_UNREVIEWED"));
  assert(advisory.passed);

  const graduated = checkChangesetReadiness(cs, fps, "graduated");
  assert(graduated.warnings.some((w) => w.code === "MUST_CLAIM_UNREVIEWED"));
  assert(!graduated.errors.some((e) => e.code === "MUST_CLAIM_UNREVIEWED"));
  assert(
    graduated.passed,
    "an unreviewed must-claim does not block under graduated",
  );

  const strict = checkChangesetReadiness(cs, fps, "strict");
  assert(strict.errors.some((e) => e.code === "MUST_CLAIM_UNREVIEWED"));
  assert(!strict.passed);
});

Deno.test("verifyFormalSpecMarker: exhaustive-switch detects assertNever", () => {
  const withGuard = `switch (status) {
    case "a": return 1;
    default: return assertNever(status);
  }`;
  assert(verifyFormalSpecMarker(HARD_SPEC, withGuard).met);

  const withoutGuard = `if (status === "a") return 1; return 0;`;
  const missing = verifyFormalSpecMarker(HARD_SPEC, withoutGuard);
  assert(!missing.met);
  assert(missing.detail.length > 0);
});

Deno.test("verifyFormalSpecMarker: assertNever inside a comment does not count", () => {
  const commented = `// default: return assertNever(status);\nreturn 0;`;
  assert(!verifyFormalSpecMarker(HARD_SPEC, commented).met);
});

Deno.test("verifyFormalSpecMarker: discriminated-union requires an exhaustiveness guard", () => {
  const spec: FormalSpec = {
    ...HARD_SPEC,
    technique: "discriminated-union",
    statement: "Every action.type branch is handled.",
  };
  const plainSwitch = `switch (action.type) {
    case "create": return create(action);
    case "delete": return remove(action);
  }`;
  assert(!verifyFormalSpecMarker(spec, plainSwitch).met);

  const guardedSwitch = `switch (action.type) {
    case "create": return create(action);
    case "delete": return remove(action);
    default: return assertNever(action);
  }`;
  assert(verifyFormalSpecMarker(spec, guardedSwitch).met);
});

Deno.test("verifyFormalSpecMarker: discriminated-union guard must be on the matching switch", () => {
  const spec: FormalSpec = {
    ...HARD_SPEC,
    technique: "discriminated-union",
    statement: "Every action.type branch is handled.",
  };
  const unrelatedGuard = `switch (status) {
    case "ready": return 1;
    default: return assertNever(status);
  }
  switch (action.type) {
    case "create": return create(action);
    case "delete": return remove(action);
  }`;
  assert(!verifyFormalSpecMarker(spec, unrelatedGuard).met);
});

Deno.test("verifyFormalSpecMarker: discriminated-union honors explicit discriminant", () => {
  const spec: FormalSpec = {
    ...HARD_SPEC,
    technique: "discriminated-union",
    statement: "Update ops dispatch exhaustively.",
    discriminant: "op.kind",
  };
  const unrelatedGuard = `switch (status) {
    case "ready": return 1;
    default: return assertNever(status);
  }`;
  assert(!verifyFormalSpecMarker(spec, unrelatedGuard).met);

  const guardedSwitch = `switch (op.kind) {
    case "rename": return rename(op);
    default: return assertNever(op);
  }`;
  assert(verifyFormalSpecMarker(spec, guardedSwitch).met);
});

Deno.test("verifyFormalSpecMarker: discriminated-union can extract explicit bare discriminant", () => {
  const spec: FormalSpec = {
    ...HARD_SPEC,
    technique: "discriminated-union",
    statement: "Use a switch over status for every branch.",
  };
  const guardedSwitch = `switch (status) {
    case "ready": return 1;
    default: return assertNever(status);
  }`;
  assert(verifyFormalSpecMarker(spec, guardedSwitch).met);
});

Deno.test("verifyFormalSpecMarker: discriminated-union does not infer articles from prose", () => {
  const spec: FormalSpec = {
    ...HARD_SPEC,
    technique: "discriminated-union",
    statement: "Update op dispatches on the discriminant the payload yields.",
  };
  const guardedSwitch = `switch (op.kind) {
    case "rename": return rename(op);
    default: return assertNever(op);
  }`;
  const passed = verifyFormalSpecMarker(spec, guardedSwitch);
  assert(passed.met);
  assert(!passed.detail.includes('"the"'));

  const missing = verifyFormalSpecMarker(spec, `return handle(op);`);
  assert(!missing.met);
  assert(!missing.detail.includes('"the"'));
});

Deno.test("verifyFormalSpecMarker: satisfies-guard detects satisfies Record", () => {
  const spec: FormalSpec = { ...HARD_SPEC, technique: "satisfies-guard" };
  const withGuard = `const map = { a: 1 } satisfies Record<Key, number>;`;
  assert(verifyFormalSpecMarker(spec, withGuard).met);
  assert(!verifyFormalSpecMarker(spec, `const map = { a: 1 };`).met);
});

Deno.test("verifyFormalSpecMarker: union-alias detects named literal union", () => {
  const spec: FormalSpec = { ...HARD_SPEC, technique: "union-alias" };
  const withUnion = `type Level = 'info' | 'warn' | 'error';`;
  assert(verifyFormalSpecMarker(spec, withUnion).met);
  assert(!verifyFormalSpecMarker(spec, `const level = 'info';`).met);
});

Deno.test("verifyFormalSpecMarker: numeric-range detects a clamp guard", () => {
  const spec: FormalSpec = { ...HARD_SPEC, technique: "numeric-range" };
  const clamped = `const pct = Math.min(100, Math.max(0, input));`;
  assert(verifyFormalSpecMarker(spec, clamped).met);
  const helper = `const pct = clamp(input, 0, 100);`;
  assert(verifyFormalSpecMarker(spec, helper).met);

  const missing = verifyFormalSpecMarker(spec, `const pct = input;`);
  assert(!missing.met);
  assert(missing.detail.length > 0);
});

Deno.test("verifyFormalSpecMarker: numeric-range guard inside a comment does not count", () => {
  const spec: FormalSpec = { ...HARD_SPEC, technique: "numeric-range" };
  const commented = `// clamp(input, 0, 100)\nconst pct = input;`;
  assert(!verifyFormalSpecMarker(spec, commented).met);
});

Deno.test("verifyFormalSpecMarker: exhaustive-record requires a named key union", () => {
  const spec: FormalSpec = { ...HARD_SPEC, technique: "exhaustive-record" };
  const named = `const labels = { a: 1 } satisfies Record<Status, number>;`;
  assert(verifyFormalSpecMarker(spec, named).met);

  // A `string`-keyed Record is not exhaustive (infinite key space).
  const stringKeyed =
    `const labels = { a: 1 } satisfies Record<string, number>;`;
  const missing = verifyFormalSpecMarker(spec, stringKeyed);
  assert(!missing.met);
  assert(missing.detail.length > 0);
});

Deno.test("verifyFormalSpecMarker: branded-type detects a nominal brand", () => {
  const spec: FormalSpec = { ...HARD_SPEC, technique: "branded-type" };
  const intersection = `type UserId = string & { readonly __brand: "UserId" };`;
  assert(verifyFormalSpecMarker(spec, intersection).met);
  const helper = `type UserId = Brand<string, "UserId">;`;
  assert(verifyFormalSpecMarker(spec, helper).met);

  const missing = verifyFormalSpecMarker(spec, `type UserId = string;`);
  assert(!missing.met);
  assert(missing.detail.length > 0);
});

Deno.test("verifyFormalSpecMarker: numeric-range rejects incidental unrelated min/max", () => {
  const spec: FormalSpec = { ...HARD_SPEC, technique: "numeric-range" };
  // Two unrelated picks — not a two-sided clamp of one value.
  const incidental = `const w = Math.max(a, b); const h = Math.min(c, d);`;
  assert(!verifyFormalSpecMarker(spec, incidental).met);
});

Deno.test("verifyFormalSpecMarker: branded-type rejects a plain brand field or runtime Brand call", () => {
  const spec: FormalSpec = { ...HARD_SPEC, technique: "branded-type" };
  // A plain data field literally named "brand" is not a nominal brand.
  assert(
    !verifyFormalSpecMarker(spec, `type Product = Base & { brand: string };`)
      .met,
  );
  // A runtime Brand<T>(x) call is not a type-level brand alias.
  assert(!verifyFormalSpecMarker(spec, `const b = Brand<Car>(input);`).met);
});

async function withManager(
  fn: (mgr: ChangesetManager) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({
    dir: "/private/tmp",
    prefix: "tideide-formal-",
  });
  try {
    await fn(new ChangesetManager(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function withProjectKernel(
  fn: (kernel: Kernel) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({
    dir: "/private/tmp",
    prefix: "tideide-formal-kernel-",
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

Deno.test("patchFormalSpec: relaxes hard to soft", async () => {
  await withManager(async (mgr) => {
    const cs = await mgr.create({
      title: "T",
      plan: basePlan([HARD_SPEC], []),
    });
    const updated = await mgr.patchFormalSpec(cs.id, "spec_status", {
      enforcement: "soft",
    });
    assertEquals(updated.plan.formalSpecs?.[0]?.enforcement, "soft");
  });
});

Deno.test("patchFormalSpec: removes a spec", async () => {
  await withManager(async (mgr) => {
    const cs = await mgr.create({
      title: "T",
      plan: basePlan([HARD_SPEC], []),
    });
    const updated = await mgr.patchFormalSpec(cs.id, "spec_status", {
      remove: true,
    });
    assertEquals(updated.plan.formalSpecs?.length ?? 0, 0);
  });
});

Deno.test("verify_formal_specs: discriminated-union fails until all variants are handled", async () => {
  await withProjectKernel(async (kernel) => {
    const spec: FormalSpec = {
      id: "spec_action_type",
      claimIds: ["claim_action_type"],
      technique: "discriminated-union",
      scope: "handler:processAction",
      statement: "Every action.type branch is handled.",
      enforcement: "hard",
    };
    const changeset = makeChangeset(basePlan([spec], []));
    const incompleteSource = `function processAction(c: any) {
  type Action =
    | { type: "create"; value: string }
    | { type: "delete"; id: string }
    | { type: "archive"; id: string };
  const action = c.req.valid("json") as Action;
  switch (action.type) {
    case "create": return c.json({ ok: true, value: action.value });
    case "delete": return c.json({ ok: true, id: action.id });
    default: return assertNever(action);
  }
}`;

    kernel.handlers.register(
      "processAction",
      incompleteSource,
      () => new Response(),
    );
    let result = await runFormalSpecVerification(kernel, changeset);
    assert(result.ok);
    let data = result.data as {
      typeCheckPassed: boolean;
      specs: Array<{ specId: string; status: string; detail: string }>;
      typeCheckOutput: string;
    };
    assertEquals(data.typeCheckPassed, false);
    assertEquals(data.specs[0]?.specId, "spec_action_type");
    assertEquals(data.specs[0]?.status, "failed");

    kernel.handlers.register(
      "processAction",
      incompleteSource.replace(
        `    case "delete": return c.json({ ok: true, id: action.id });`,
        `    case "delete": return c.json({ ok: true, id: action.id });
    case "archive": return c.json({ ok: true, id: action.id });`,
      ),
      () => new Response(),
    );
    result = await runFormalSpecVerification(kernel, changeset);
    assert(result.ok);
    data = result.data as {
      typeCheckPassed: boolean;
      specs: Array<{ specId: string; status: string; detail: string }>;
      typeCheckOutput: string;
    };
    assertEquals(data.typeCheckPassed, true);
    assertEquals(data.specs[0]?.status, "passed");
  });
});

const GUARDED_AGENT_HANDLER = `function processAgent(c: any) {
  type FsAgentState = "idle" | "running" | "blocked";
  const stateLabels = {
    idle: "Idle",
    running: "Running",
    blocked: "Blocked",
  } satisfies Record<FsAgentState, string>;

  type FsAgentEventKind = "created" | "updated" | "resolved";
  const eventLabels = {
    created: "Created",
    updated: "Updated",
    resolved: "Resolved",
  } satisfies Record<FsAgentEventKind, string>;

  type AgentUpdateOp =
    | { type: "reply"; id: string }
    | { type: "resolve"; id: string };
  const op = c.req.valid("json") as AgentUpdateOp;
  switch (op.type) {
    case "reply": return c.json({ label: stateLabels.running, event: eventLabels.updated });
    case "resolve": return c.json({ label: stateLabels.blocked, event: eventLabels.resolved });
    default: return assertNever(op);
  }
}`;

Deno.test("verify_formal_specs persists every attestation from one multi-spec run", async () => {
  await withProjectKernel(async (kernel) => {
    const specs: FormalSpec[] = [
      {
        id: "spec_agent_state",
        claimIds: ["claim_status"],
        technique: "exhaustive-record",
        scope: "handler:processAgent",
        statement: "Every agent state has a label.",
        enforcement: "hard",
      },
      {
        id: "spec_agent_event_kind",
        claimIds: ["claim_status"],
        technique: "exhaustive-record",
        scope: "handler:processAgent",
        statement: "Every agent event kind has a label.",
        enforcement: "hard",
      },
      {
        id: "spec_agent_update_op",
        claimIds: ["claim_status"],
        technique: "discriminated-union",
        scope: "handler:processAgent",
        discriminant: "op.type",
        statement: "Every agent update operation is handled.",
        enforcement: "hard",
      },
    ];
    kernel.handlers.register(
      "processAgent",
      GUARDED_AGENT_HANDLER,
      () => new Response(),
    );
    const cs = await kernel.changesets.create({
      title: "Agent formal specs",
      plan: basePlan(specs, []),
    });

    const result = await runFormalSpecVerification(kernel, cs, {
      changesetId: cs.id,
    });
    assert(result.ok);
    const data = result.data as {
      specs: Array<{ specId: string; status: string }>;
      evidence: Array<{ checkId?: string; attestationId?: string }>;
    };
    assertEquals(data.specs.map((s) => s.status), [
      "passed",
      "passed",
      "passed",
    ]);
    assertEquals(data.evidence.filter((e) => e.attestationId).length, 3);

    const verified = await kernel.changesets.get(cs.id);
    assert(verified);
    const atts = verified.plan.attestations ?? [];
    assertEquals(atts.map((a) => a.checkId).sort(), [
      "spec_agent_event_kind",
      "spec_agent_state",
      "spec_agent_update_op",
    ]);
    const readiness = checkChangesetReadiness(
      verified,
      currentFingerprints(kernel, verified),
    );
    assertEquals(readiness.checks.formalSpecsVerified, 3);
  });
});

const GUARDED_ORDER_HANDLER = `function processOrder(c: any) {
  type Status = "new" | "paid";
  const status = c.req.query("s") as Status;
  switch (status) {
    case "new": return c.json({ ok: true });
    case "paid": return c.json({ ok: true });
    default: return assertNever(status);
  }
}`;

Deno.test("verify_formal_specs mints a fresh attestation; editing the entity makes it stale", async () => {
  await withProjectKernel(async (kernel) => {
    kernel.handlers.register(
      "processOrder",
      GUARDED_ORDER_HANDLER,
      () => new Response(),
    );
    const cs = await kernel.changesets.create({
      title: "Order status",
      plan: basePlan([HARD_SPEC], []),
    });
    const context = { changesetId: cs.id };

    // Verify → mints a passing invariant attestation, returns its id on evidence.
    const result = await runFormalSpecVerification(kernel, cs, context);
    assert(result.ok);
    const evidence = (result.data as {
      evidence: Array<{ checkId?: string; attestationId?: string }>;
    }).evidence;
    assertEquals(evidence[0]?.checkId, "spec_status");
    assert(
      evidence[0]?.attestationId,
      "evidence carries a minted attestationId",
    );

    const verified = await kernel.changesets.get(cs.id);
    assert(verified);
    const atts = verified.plan.attestations ?? [];
    assertEquals(atts.length, 1);
    assertEquals(atts[0]?.kind, "invariant");
    assertEquals(atts[0]?.status, "passed");
    assertEquals(atts[0]?.checkId, "spec_status");

    // Fresh: readiness against current code passes the hard spec.
    let readiness = checkChangesetReadiness(
      verified,
      currentFingerprints(kernel, verified),
    );
    assertEquals(readiness.checks.formalSpecsVerified, 1);
    assert(!readiness.errors.some((e) => e.code === "UNVERIFIED_FORMAL_SPEC"));

    // Edit the entity — the old attestation's fingerprint no longer matches.
    kernel.handlers.register(
      "processOrder",
      GUARDED_ORDER_HANDLER.replace(
        `default: return assertNever(status);`,
        `// touched\n    default: return assertNever(status);`,
      ),
      () => new Response(),
    );
    assert(
      fingerprintScope(kernel, SCOPE) !== atts[0]?.fingerprint,
      "editing the handler changes its fingerprint",
    );
    readiness = checkChangesetReadiness(
      verified,
      currentFingerprints(kernel, verified),
    );
    assertEquals(readiness.checks.formalSpecsVerified, 0);
    assert(
      readiness.errors.some((e) =>
        e.code === "UNVERIFIED_FORMAL_SPEC" && e.message.includes("stale")
      ),
      "drift makes the hard spec stale and blocks completion",
    );

    // Re-verify against the new code → fresh again.
    await runFormalSpecVerification(kernel, verified, context);
    const reverified = await kernel.changesets.get(cs.id);
    assert(reverified);
    readiness = checkChangesetReadiness(
      reverified,
      currentFingerprints(kernel, reverified),
    );
    assertEquals(readiness.checks.formalSpecsVerified, 1);
  });
});
