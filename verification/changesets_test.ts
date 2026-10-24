// Direct tests for checkChangesetReadiness — the completion gate's own decision
// table. The gate is the function the whole "shows its work" claim rests on, and
// until now it was covered only indirectly (verification-overview_test.ts,
// verification-ledger_test.ts, save-risk_test.ts, core/tools/dispatch_test.ts).
// Indirect coverage exercises the behavior; it does not pin the table. This file
// pins the table: one case per finding code, plus the severity ladder and the
// light-lane waiver ordering that decides which severity each code lands at.
import { assert, assertEquals } from "@std/assert";
import {
  checkChangesetReadiness,
  EVIDENCE_ATTESTATION_KINDS,
  GROUNDED_EVIDENCE_KINDS,
} from "./changesets.ts";
import type {
  Attestation,
  Changeset,
  ChangesetPlan,
  ChangesetReadiness,
  ProposedCriterion,
  ReadinessEnforcement,
  VerificationClaim,
  VerificationEvidence,
  VerificationRun,
} from "../core/types.ts";

const FP = "project";
const FRESH = { [FP]: "aa-11111111" };
const HANDLER_SCOPE = "handler:processOrder";

// --- builders ---------------------------------------------------------------

function claim(
  id: string,
  priority: VerificationClaim["priority"] = "should",
): VerificationClaim {
  return { id, text: `Criterion ${id}`, source: "agent", priority };
}

function evidence(
  over: Partial<VerificationEvidence> & { id: string },
): VerificationEvidence {
  return {
    kind: "note",
    summary: `Evidence ${over.id}`,
    status: "passed",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

function att(over: Partial<Attestation> & { id: string }): Attestation {
  return {
    kind: "typecheck",
    status: "passed",
    fingerprint: FRESH[FP]!,
    scope: FP,
    summary: `Attestation ${over.id}`,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

function run(over: Partial<VerificationRun> = {}): VerificationRun {
  return {
    id: "run_1",
    status: "passed",
    summary: "All planned checks passed.",
    evidence: [evidence({ id: "evidence_0" })],
    claimResults: [
      { claimId: "clm_1", status: "passed", evidenceIds: ["evidence_0"] },
    ],
    residualRisks: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

// A plan that passes the gate cleanly. Every test starts here and breaks exactly
// one thing, so a finding in the result is unambiguously caused by that break.
function plan(over: Partial<ChangesetPlan> = {}): ChangesetPlan {
  return {
    summary: "Add an order-total endpoint.",
    steps: [{ id: "step_0", description: "Write the handler", status: "done" }],
    acceptanceCriteria: [claim("clm_1")],
    verificationPlan: [
      {
        id: "chk_1",
        claimIds: ["clm_1"],
        kind: "unit",
        description: "Unit test the handler",
      },
    ],
    verificationRuns: [run()],
    attestations: [],
    ...over,
  };
}

function changeset(over: Partial<Changeset> = {}): Changeset {
  return {
    id: "cs_1",
    sessionId: null,
    title: "Order total",
    description: null,
    status: "in_progress",
    plan: plan(),
    planMessageIds: [],
    approvalMessageId: null,
    workMessageIds: [],
    toolCalls: null,
    reasoning: null,
    tokenUsage: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    completedAt: null,
    ...over,
  };
}

function check(
  over: Partial<ChangesetPlan> = {},
  enforcement: ReadinessEnforcement = "advisory",
  fingerprints: Record<string, string> | undefined = FRESH,
): ChangesetReadiness {
  return checkChangesetReadiness(
    changeset({ plan: plan(over) }),
    fingerprints,
    enforcement,
  );
}

function codes(readiness: ChangesetReadiness): string[] {
  return readiness.errors.map((issue) => issue.code);
}
function warningCodes(readiness: ChangesetReadiness): string[] {
  return readiness.warnings.map((issue) => issue.code);
}
function skippedCodes(readiness: ChangesetReadiness): string[] {
  return readiness.skipped.map((issue) => issue.code);
}

// --- the happy path ---------------------------------------------------------

Deno.test("readiness: a complete changeset passes with no findings", () => {
  const readiness = check();
  assertEquals(codes(readiness), []);
  assertEquals(warningCodes(readiness), []);
  assert(readiness.passed);
  assertEquals(readiness.summary, "Changeset is ready to complete.");
});

Deno.test("readiness: warnings alone do not block completion", () => {
  // An unmapped claim raises CLAIMS_WITHOUT_PLANNED_CHECKS, a warning.
  const readiness = check({
    acceptanceCriteria: [claim("clm_1"), claim("clm_2")],
    verificationRuns: [
      run({
        claimResults: [
          { claimId: "clm_1", status: "passed", evidenceIds: ["evidence_0"] },
          { claimId: "clm_2", status: "passed", evidenceIds: ["evidence_0"] },
        ],
      }),
    ],
  });
  assert(readiness.passed);
  assert(warningCodes(readiness).includes("CLAIMS_WITHOUT_PLANNED_CHECKS"));
  assertEquals(readiness.summary, "Changeset is ready to complete with 1 warning(s).");
});

// --- always-blocking structural codes ---------------------------------------

Deno.test("readiness: CHANGESET_NOT_IN_PROGRESS for a non-in_progress status", () => {
  const readiness = checkChangesetReadiness(
    changeset({ status: "planning" }),
    FRESH,
  );
  assert(codes(readiness).includes("CHANGESET_NOT_IN_PROGRESS"));
  assert(!readiness.passed);
});

Deno.test("readiness: MISSING_ACCEPTANCE_CRITERIA when no claims are recorded", () => {
  assert(codes(check({ acceptanceCriteria: [] })).includes(
    "MISSING_ACCEPTANCE_CRITERIA",
  ));
});

Deno.test("readiness: MISSING_VERIFICATION_PLAN when no checks are planned", () => {
  assert(codes(check({ verificationPlan: [] })).includes(
    "MISSING_VERIFICATION_PLAN",
  ));
});

Deno.test("readiness: INCOMPLETE_STEPS for pending or in_progress steps", () => {
  const readiness = check({
    steps: [
      { id: "step_0", description: "Done", status: "done" },
      { id: "step_1", description: "Not done", status: "pending" },
    ],
  });
  assert(codes(readiness).includes("INCOMPLETE_STEPS"));
});

Deno.test("readiness: a skipped step counts as settled", () => {
  const readiness = check({
    steps: [
      { id: "step_0", description: "Done", status: "done" },
      { id: "step_1", description: "Not needed", status: "skipped" },
    ],
  });
  assert(!codes(readiness).includes("INCOMPLETE_STEPS"));
});

Deno.test("readiness: MISSING_VERIFICATION_RUN when nothing was recorded", () => {
  assert(codes(check({ verificationRuns: [] })).includes(
    "MISSING_VERIFICATION_RUN",
  ));
});

Deno.test("readiness: VERIFICATION_NOT_PASSING for a failed or partial run", () => {
  for (const status of ["failed", "partial"] as const) {
    const readiness = check({ verificationRuns: [run({ status })] });
    assert(
      codes(readiness).includes("VERIFICATION_NOT_PASSING"),
      `expected VERIFICATION_NOT_PASSING for run status "${status}"`,
    );
  }
});

Deno.test("readiness: MISSING_VERIFICATION_EVIDENCE for an empty evidence list", () => {
  const readiness = check({ verificationRuns: [run({ evidence: [] })] });
  assert(codes(readiness).includes("MISSING_VERIFICATION_EVIDENCE"));
});

Deno.test("readiness: MISSING_CLAIM_RESULTS for an empty claim-result list", () => {
  const readiness = check({ verificationRuns: [run({ claimResults: [] })] });
  assert(codes(readiness).includes("MISSING_CLAIM_RESULTS"));
});

Deno.test("readiness: UNCOVERED_ACCEPTANCE_CRITERIA when a claim has no result", () => {
  const readiness = check({
    acceptanceCriteria: [claim("clm_1"), claim("clm_2")],
    verificationPlan: [
      { id: "chk_1", claimIds: ["clm_1", "clm_2"], kind: "unit", description: "t" },
    ],
  });
  const uncovered = readiness.errors.find((i) =>
    i.code === "UNCOVERED_ACCEPTANCE_CRITERIA"
  );
  assert(uncovered);
  // The action names the specific claim, which is what makes the finding fixable.
  assert(uncovered.action.includes("clm_2"));
});

Deno.test("readiness: only the LATEST run is graded", () => {
  // An earlier failing run is superseded by a later passing one.
  const readiness = check({
    verificationRuns: [run({ id: "run_0", status: "failed" }), run()],
  });
  assert(!codes(readiness).includes("VERIFICATION_NOT_PASSING"));
  assert(readiness.passed);
  assertEquals(readiness.checks.verificationRuns, 2);
});

Deno.test("readiness: MISSING_REFERENCED_EVIDENCE for a dangling evidenceId", () => {
  const readiness = check({
    verificationRuns: [
      run({
        claimResults: [
          { claimId: "clm_1", status: "passed", evidenceIds: ["nope"] },
        ],
      }),
    ],
  });
  const dangling = readiness.errors.find((i) =>
    i.code === "MISSING_REFERENCED_EVIDENCE"
  );
  assert(dangling);
  assert(dangling.action.includes("nope"));
});

Deno.test("readiness: VERIFICATION_EVIDENCE_NOT_PASSING for failed evidence", () => {
  for (const status of ["failed", "partial"] as const) {
    const readiness = check({
      verificationRuns: [
        run({ evidence: [evidence({ id: "evidence_0", status })] }),
      ],
    });
    assert(
      codes(readiness).includes("VERIFICATION_EVIDENCE_NOT_PASSING"),
      `expected the finding for evidence status "${status}"`,
    );
  }
});

Deno.test("readiness: CLAIM_RESULTS_NOT_PASSING for a failed claim result", () => {
  const readiness = check({
    verificationRuns: [
      run({
        claimResults: [
          { claimId: "clm_1", status: "failed", evidenceIds: ["evidence_0"] },
        ],
      }),
    ],
  });
  assert(codes(readiness).includes("CLAIM_RESULTS_NOT_PASSING"));
});

Deno.test("readiness: UNPLANNED_MANUAL_VERIFICATION when manual was not planned", () => {
  const readiness = check({
    verificationRuns: [
      run({
        claimResults: [
          { claimId: "clm_1", status: "manual", evidenceIds: ["evidence_0"] },
        ],
      }),
    ],
  });
  assert(codes(readiness).includes("UNPLANNED_MANUAL_VERIFICATION"));
});

Deno.test("readiness: a manual claim result mapped to a planned manual check is allowed", () => {
  const readiness = check({
    verificationPlan: [
      { id: "chk_1", claimIds: ["clm_1"], kind: "manual", description: "Look at it" },
    ],
    verificationRuns: [
      run({
        claimResults: [
          { claimId: "clm_1", status: "manual", evidenceIds: ["evidence_0"] },
        ],
      }),
    ],
  });
  assert(!codes(readiness).includes("UNPLANNED_MANUAL_VERIFICATION"));
  assert(readiness.passed);
});

Deno.test("readiness: MANUAL_VERIFICATION is a warning, not a block", () => {
  const readiness = check({ verificationRuns: [run({ status: "manual" })] });
  assert(warningCodes(readiness).includes("MANUAL_VERIFICATION"));
  assert(readiness.passed);
});

// --- formal specs -----------------------------------------------------------

const SPEC = {
  id: "spec_1",
  claimIds: ["clm_1"],
  technique: "exhaustive-switch" as const,
  scope: HANDLER_SCOPE,
  statement: "Every order status is handled.",
};

Deno.test("readiness: UNVERIFIED_FORMAL_SPEC for a hard spec with no attestation", () => {
  const readiness = check({
    formalSpecs: [{ ...SPEC, enforcement: "hard" }],
  });
  assert(codes(readiness).includes("UNVERIFIED_FORMAL_SPEC"));
  assertEquals(readiness.checks.formalSpecs, 1);
  assertEquals(readiness.checks.formalSpecsVerified, 0);
});

Deno.test("readiness: SOFT_FORMAL_SPEC_UNMET is only a warning", () => {
  const readiness = check({
    formalSpecs: [{ ...SPEC, enforcement: "soft" }],
  });
  assert(warningCodes(readiness).includes("SOFT_FORMAL_SPEC_UNMET"));
  assert(readiness.passed);
});

Deno.test("readiness: a fresh passing invariant attestation discharges a hard spec", () => {
  const readiness = check(
    {
      formalSpecs: [{ ...SPEC, enforcement: "hard" }],
      attestations: [
        att({
          id: "att_1",
          kind: "invariant",
          checkId: "spec_1",
          scope: HANDLER_SCOPE,
          fingerprint: "bb-22222222",
        }),
      ],
    },
    "advisory",
    { ...FRESH, [HANDLER_SCOPE]: "bb-22222222" },
  );
  assert(!codes(readiness).includes("UNVERIFIED_FORMAL_SPEC"));
  assertEquals(readiness.checks.formalSpecsVerified, 1);
});

Deno.test("readiness: a STALE invariant attestation does not discharge a hard spec", () => {
  const readiness = check(
    {
      formalSpecs: [{ ...SPEC, enforcement: "hard" }],
      attestations: [
        att({
          id: "att_1",
          kind: "invariant",
          checkId: "spec_1",
          scope: HANDLER_SCOPE,
          fingerprint: "bb-22222222",
        }),
      ],
    },
    "advisory",
    { ...FRESH, [HANDLER_SCOPE]: "cc-33333333" }, // the entity moved
  );
  const issue = readiness.errors.find((i) => i.code === "UNVERIFIED_FORMAL_SPEC");
  assert(issue);
  // The message must distinguish "never verified" from "verified then drifted" —
  // they call for different fixes.
  assert(issue.message.includes("stale"));
});

Deno.test("readiness: a FAILED invariant attestation does not discharge a hard spec", () => {
  const readiness = check(
    {
      formalSpecs: [{ ...SPEC, enforcement: "hard" }],
      attestations: [
        att({
          id: "att_1",
          kind: "invariant",
          status: "failed",
          checkId: "spec_1",
          scope: HANDLER_SCOPE,
          fingerprint: "bb-22222222",
        }),
      ],
    },
    "advisory",
    { ...FRESH, [HANDLER_SCOPE]: "bb-22222222" },
  );
  assert(codes(readiness).includes("UNVERIFIED_FORMAL_SPEC"));
});

// --- grounded evidence: attestation presence and freshness ------------------

// A run whose single evidence item is grounded (so the attestation rules apply).
function groundedRun(over: Partial<VerificationEvidence> = {}): VerificationRun {
  return run({
    evidence: [evidence({ id: "evidence_0", kind: "typecheck", ...over })],
  });
}

Deno.test("readiness: UNATTESTED_EVIDENCE is advisory by default", () => {
  const readiness = check({ verificationRuns: [groundedRun()] });
  assert(warningCodes(readiness).includes("UNATTESTED_EVIDENCE"));
  assert(readiness.passed, "the shipped default must not block on this");
});

Deno.test("readiness: UNATTESTED_EVIDENCE is promoted under graduated and strict", () => {
  for (const mode of ["graduated", "strict"] as const) {
    const readiness = check({ verificationRuns: [groundedRun()] }, mode);
    assert(
      codes(readiness).includes("UNATTESTED_EVIDENCE"),
      `expected promotion under "${mode}"`,
    );
    assert(!readiness.passed);
  }
});

Deno.test("readiness: narrative evidence kinds need no attestation", () => {
  for (const kind of ["manual", "note", "screenshot", "adversarial"] as const) {
    const readiness = check(
      { verificationRuns: [groundedRun({ kind })] },
      "strict",
    );
    assert(
      !codes(readiness).includes("UNATTESTED_EVIDENCE"),
      `"${kind}" is self-reported by design and must not demand an attestation`,
    );
  }
});

Deno.test("readiness: STALE_EVIDENCE when the attestation's fingerprint drifted", () => {
  const readiness = check(
    {
      attestations: [att({ id: "att_1", fingerprint: "old-00000000" })],
      verificationRuns: [groundedRun({ attestationId: "att_1" })],
    },
    "graduated",
  );
  assert(codes(readiness).includes("STALE_EVIDENCE"));
});

Deno.test("readiness: a fresh attestation satisfies grounded evidence under strict", () => {
  const readiness = check(
    {
      attestations: [att({ id: "att_1" })],
      verificationRuns: [groundedRun({ attestationId: "att_1" })],
    },
    "strict",
  );
  assertEquals(codes(readiness), []);
  assert(readiness.passed);
});

// --- adversarial verdicts ---------------------------------------------------

function adversarial(
  id: string,
  claimId: string,
  status: Attestation["status"],
  fingerprint = FRESH[FP]!,
): Attestation {
  return att({ id, kind: "adversarial", checkId: claimId, status, fingerprint });
}

Deno.test("readiness: CLAIM_REFUTED blocks regardless of enforcement mode", () => {
  // The whitepaper claims this is strict-only. It is not — it is unconditional,
  // and this test is what keeps it that way.
  for (const mode of ["advisory", "graduated", "strict"] as const) {
    const readiness = check(
      {
        acceptanceCriteria: [claim("clm_1", "must")],
        attestations: [adversarial("att_1", "clm_1", "failed")],
      },
      mode,
    );
    assert(
      codes(readiness).includes("CLAIM_REFUTED"),
      `a fresh refutation must block under "${mode}"`,
    );
    assertEquals(readiness.checks.claimsRefuted, 1);
  }
});

Deno.test("readiness: a later passing verdict supersedes an earlier refutation", () => {
  const readiness = check({
    acceptanceCriteria: [claim("clm_1", "must")],
    attestations: [
      adversarial("att_1", "clm_1", "failed"),
      adversarial("att_2", "clm_1", "passed"),
    ],
  });
  assert(!codes(readiness).includes("CLAIM_REFUTED"));
  assertEquals(readiness.checks.claimsRefuted, 0);
  assertEquals(readiness.checks.mustClaimsReviewed, 1);
});

Deno.test("readiness: a STALE refutation does not block", () => {
  const readiness = check({
    acceptanceCriteria: [claim("clm_1", "must")],
    attestations: [adversarial("att_1", "clm_1", "failed", "old-00000000")],
  });
  assert(!codes(readiness).includes("CLAIM_REFUTED"));
});

Deno.test("readiness: without a fingerprint map a historical refutation cannot resurrect", () => {
  // The store-gate backstop path has no kernel access, so freshness is unknowable.
  // isFreshAttestation fails OPEN there, which is right for formal specs and
  // backwards here — so the refutation scan must be guarded on the map's presence.
  // Called directly: passing `undefined` through `check` would hit its default.
  const readiness = checkChangesetReadiness(
    changeset({
      plan: plan({
        acceptanceCriteria: [claim("clm_1", "must")],
        attestations: [adversarial("att_1", "clm_1", "failed")],
      }),
    }),
    undefined,
  );
  assert(!codes(readiness).includes("CLAIM_REFUTED"));
});

Deno.test("readiness: MUST_CLAIM_UNREVIEWED is advisory, promoted only under strict", () => {
  const mustOnly = { acceptanceCriteria: [claim("clm_1", "must")] };
  assert(warningCodes(check(mustOnly)).includes("MUST_CLAIM_UNREVIEWED"));
  assert(
    warningCodes(check(mustOnly, "graduated")).includes("MUST_CLAIM_UNREVIEWED"),
    "graduated promotes only the deterministic codes",
  );
  assert(codes(check(mustOnly, "strict")).includes("MUST_CLAIM_UNREVIEWED"));
});

Deno.test("readiness: a should-claim never demands adversarial review", () => {
  const readiness = check({ acceptanceCriteria: [claim("clm_1", "should")] }, "strict");
  assert(!warningCodes(readiness).includes("MUST_CLAIM_UNREVIEWED"));
  assert(!codes(readiness).includes("MUST_CLAIM_UNREVIEWED"));
});

// --- change class: escalation and the light-lane waiver ---------------------

Deno.test("readiness: CHANGE_CLASS_ESCALATED is a hard error", () => {
  const readiness = check({
    changeClass: {
      declared: "light",
      effective: "standard",
      escalated: true,
      reason: "Declared light, but it changed route:GET /x.",
    },
  });
  assert(codes(readiness).includes("CHANGE_CLASS_ESCALATED"));
  assert(!readiness.passed);
});

Deno.test("readiness: escalation is NOT waivable by the light lane", () => {
  // effective stays "standard" on escalation, so the waiver never applies — but
  // the ordering (escalation pushed before the waiver pass) is what guarantees it.
  const readiness = check({
    acceptanceCriteria: [claim("clm_1", "must")],
    changeClass: {
      declared: "light",
      effective: "standard",
      escalated: true,
      reason: "exceeded",
    },
  }, "strict");
  assert(codes(readiness).includes("CHANGE_CLASS_ESCALATED"));
  assertEquals(skippedCodes(readiness), []);
});

Deno.test("readiness: the light lane waives MUST_CLAIM_UNREVIEWED to skipped", () => {
  const readiness = check({
    acceptanceCriteria: [claim("clm_1", "must")],
    changeClass: {
      declared: "light",
      effective: "light",
      escalated: false,
      reason: "Light-tier work.",
    },
  });
  // Moved, not dropped: a waiver has to stay visible as a decision.
  assert(!warningCodes(readiness).includes("MUST_CLAIM_UNREVIEWED"));
  assert(skippedCodes(readiness).includes("MUST_CLAIM_UNREVIEWED"));
  const skipped = readiness.skipped[0]!;
  assertEquals(skipped.severity, "skipped");
  assert(skipped.action.length > 0, "a waiver must carry its reason");
});

Deno.test("readiness: the waiver runs AFTER promotion, so strict + light still skips", () => {
  // The whole contract of the ordering: a downward tier crossing an upward ladder.
  const readiness = check({
    acceptanceCriteria: [claim("clm_1", "must")],
    changeClass: {
      declared: "light",
      effective: "light",
      escalated: false,
      reason: "Light-tier work.",
    },
  }, "strict");
  assert(!codes(readiness).includes("MUST_CLAIM_UNREVIEWED"));
  assert(skippedCodes(readiness).includes("MUST_CLAIM_UNREVIEWED"));
  assert(readiness.passed);
});

Deno.test("readiness: the light lane does NOT waive deterministic evidence codes", () => {
  // Waiving them would buy nothing (they are free to satisfy) and would cost the
  // audit trail its meaning.
  const readiness = check({
    attestations: [],
    verificationRuns: [groundedRun()],
    changeClass: {
      declared: "light",
      effective: "light",
      escalated: false,
      reason: "Light-tier work.",
    },
  }, "graduated");
  assert(codes(readiness).includes("UNATTESTED_EVIDENCE"));
  assert(!skippedCodes(readiness).includes("UNATTESTED_EVIDENCE"));
});

Deno.test("readiness: changeClass is echoed onto the result when present", () => {
  const changeClass = {
    declared: "light" as const,
    effective: "light" as const,
    escalated: false,
    reason: "Light-tier work.",
  };
  assertEquals(check({ changeClass }).changeClass, changeClass);
  assertEquals(check().changeClass, undefined);
});

// --- the checks rollup ------------------------------------------------------

Deno.test("readiness: checks counts report what the gate actually looked at", () => {
  const readiness = check({
    attestations: [att({ id: "att_1" }), att({ id: "att_2", fingerprint: "old" })],
    verificationRuns: [groundedRun({ attestationId: "att_1" })],
  });
  assertEquals(readiness.checks.acceptanceCriteria, 1);
  assertEquals(readiness.checks.verificationPlan, 1);
  assertEquals(readiness.checks.verificationRuns, 1);
  assertEquals(readiness.checks.incompleteSteps, 0);
  assertEquals(readiness.checks.latestVerificationStatus, "passed");
  assertEquals(readiness.checks.evidence, 1);
  assertEquals(readiness.checks.claimResults, 1);
  assertEquals(readiness.checks.attestations, 2);
  assertEquals(readiness.checks.staleAttestations, 1);
});

Deno.test("readiness: skipped is always an array, never absent", () => {
  // A consumer reading `skipped` must not be able to mistake "no waivers" for
  // "field not present".
  assertEquals(check().skipped, []);
});

// --- evidence reconciled against its attestation ----------------------------
// A fresh attestation proves a verifier ran against this code. These two checks
// are what make it prove the RIGHT verifier ran and that the evidence row is not
// claiming more than the verifier found — both of which are agent-supplied.

Deno.test("readiness: EVIDENCE_CONTRADICTS_ATTESTATION when evidence outranks its attestation", () => {
  const readiness = check(
    {
      attestations: [att({ id: "att_1", status: "failed" })],
      verificationRuns: [groundedRun({ attestationId: "att_1" })], // status: passed
    },
    "graduated",
  );
  assert(codes(readiness).includes("EVIDENCE_CONTRADICTS_ATTESTATION"));
  assert(!readiness.passed);
});

Deno.test("readiness: a passing evidence row may not ride a partial attestation", () => {
  const readiness = check(
    {
      attestations: [att({ id: "att_1", kind: "coverage", status: "partial" })],
      verificationRuns: [
        run({
          evidence: [
            evidence({ id: "evidence_0", kind: "coverage", attestationId: "att_1" }),
          ],
        }),
      ],
    },
    "graduated",
  );
  assert(codes(readiness).includes("EVIDENCE_CONTRADICTS_ATTESTATION"));
});

Deno.test("readiness: evidence weaker than its attestation is fine", () => {
  // Under-claiming is honest. Only over-claiming is the problem.
  const readiness = check(
    {
      attestations: [att({ id: "att_1", kind: "coverage", status: "passed" })],
      verificationRuns: [
        run({
          status: "partial",
          evidence: [
            evidence({
              id: "evidence_0",
              kind: "coverage",
              status: "partial",
              attestationId: "att_1",
            }),
          ],
        }),
      ],
    },
    "graduated",
  );
  assert(!codes(readiness).includes("EVIDENCE_CONTRADICTS_ATTESTATION"));
});

Deno.test("readiness: a manual attestation cannot license passing evidence", () => {
  const readiness = check(
    {
      attestations: [att({ id: "att_1", status: "manual" })],
      verificationRuns: [groundedRun({ attestationId: "att_1" })],
    },
    "graduated",
  );
  assert(codes(readiness).includes("EVIDENCE_CONTRADICTS_ATTESTATION"));
});

Deno.test("readiness: EVIDENCE_ATTESTATION_MISMATCH when the kinds disagree", () => {
  const readiness = check(
    {
      // A passing coverage attestation, cited by a typecheck evidence row.
      attestations: [att({ id: "att_1", kind: "coverage" })],
      verificationRuns: [groundedRun({ attestationId: "att_1" })],
    },
    "graduated",
  );
  const issue = readiness.errors.find((i) =>
    i.code === "EVIDENCE_ATTESTATION_MISMATCH"
  );
  assert(issue);
  assert(issue.message.includes("coverage"));
  assert(issue.message.includes("typecheck"));
  // Status is not also reported: the citation is wrong, so comparing the two
  // statuses would be comparing against the wrong record.
  assert(!codes(readiness).includes("EVIDENCE_CONTRADICTS_ATTESTATION"));
});

Deno.test("readiness: unit, integration and e2e all discharge to a test attestation", () => {
  for (const kind of ["unit", "integration", "e2e", "test_result"] as const) {
    const readiness = check(
      {
        attestations: [att({ id: "att_1", kind: "test" })],
        verificationRuns: [groundedRun({ kind, attestationId: "att_1" })],
      },
      "graduated",
    );
    assertEquals(
      codes(readiness),
      [],
      `"${kind}" evidence must accept a test attestation`,
    );
  }
});

Deno.test("readiness: manifest evidence discharges to a change_manifest attestation", () => {
  const readiness = check(
    {
      attestations: [att({ id: "att_1", kind: "change_manifest" })],
      verificationRuns: [groundedRun({ kind: "manifest", attestationId: "att_1" })],
    },
    "graduated",
  );
  assertEquals(codes(readiness), []);
});

Deno.test("readiness: both new codes are advisory by default", () => {
  const readiness = check({
    attestations: [att({ id: "att_1", kind: "coverage", status: "failed" })],
    verificationRuns: [groundedRun({ attestationId: "att_1" })],
  });
  assert(warningCodes(readiness).includes("EVIDENCE_ATTESTATION_MISMATCH"));
  assert(readiness.passed, "the shipped default stays advisory");
});

Deno.test("readiness: a stale attestation reports staleness, not a status contradiction", () => {
  // Staleness is the more actionable finding and the checks are ordered so it
  // wins — re-running the verifier fixes both.
  const readiness = check(
    {
      attestations: [att({ id: "att_1", status: "failed", fingerprint: "old" })],
      verificationRuns: [groundedRun({ attestationId: "att_1" })],
    },
    "graduated",
  );
  assert(codes(readiness).includes("STALE_EVIDENCE"));
  assert(!codes(readiness).includes("EVIDENCE_CONTRADICTS_ATTESTATION"));
});

// --- independent criteria ---------------------------------------------------
// The refuter attacks the claims the agent wrote. These findings are the only
// thing that asks whether those were the right claims.

function proposal(
  id: string,
  text: string,
  over: Partial<ProposedCriterion> = {},
): ProposedCriterion {
  return { id, text, priority: "should", rationale: "Because.", ...over };
}

// A fresh `criteria` attestation, without which proposals are not reported.
function criteriaAttestation(id = "att_crit"): Attestation {
  return att({ id, kind: "criteria", status: "partial" });
}

Deno.test("readiness: UNCOVERED_INDEPENDENT_CRITERION for each uncovered proposal", () => {
  const readiness = check({
    attestations: [criteriaAttestation()],
    independentCriteria: [
      proposal("icr_1", "Deleting a customer removes their draft orders."),
      proposal("icr_2", "Submitting twice creates one order."),
    ],
  });
  assertEquals(
    warningCodes(readiness).filter((c) => c === "UNCOVERED_INDEPENDENT_CRITERION")
      .length,
    2,
    "one finding per gap, so each can be dismissed on its own merits",
  );
  assert(readiness.passed, "proposals report, they do not block");
});

Deno.test("readiness: a covered proposal raises nothing", () => {
  const readiness = check({
    attestations: [criteriaAttestation()],
    independentCriteria: [
      proposal("icr_1", "Covered already.", { coveredBy: "clm_1" }),
    ],
  });
  assertEquals(warningCodes(readiness), []);
  assert(readiness.passed);
});

Deno.test("readiness: the finding carries the proposal text and its rationale", () => {
  const readiness = check({
    attestations: [criteriaAttestation()],
    independentCriteria: [
      proposal("icr_1", "Refunds restore stock.", { rationale: "Money moved." }),
    ],
  });
  const issue = readiness.warnings.find((i) =>
    i.code === "UNCOVERED_INDEPENDENT_CRITERION"
  );
  assert(issue);
  assert(issue.message.includes("Refunds restore stock."));
  assert(issue.message.includes("Money moved."));
  // The action must offer dismissal, not only compliance — these are proposals.
  assert(/dismiss/i.test(issue.action));
});

Deno.test("readiness: the finding hardens only under strict", () => {
  const withGap = {
    attestations: [criteriaAttestation()],
    independentCriteria: [proposal("icr_1", "Something was missed.")],
  };
  assert(warningCodes(check(withGap)).includes("UNCOVERED_INDEPENDENT_CRITERION"));
  assert(
    warningCodes(check(withGap, "graduated")).includes(
      "UNCOVERED_INDEPENDENT_CRITERION",
    ),
    "graduated promotes only the deterministic codes; this one needs a model",
  );
  assert(codes(check(withGap, "strict")).includes("UNCOVERED_INDEPENDENT_CRITERION"));
});

Deno.test("readiness: STALE proposals are not reported", () => {
  // A proposal judges a particular diff. Once the code moves it is an opinion
  // about something that no longer exists.
  const readiness = check({
    attestations: [att({ id: "att_crit", kind: "criteria", fingerprint: "old" })],
    independentCriteria: [proposal("icr_1", "Something was missed.")],
  }, "strict");
  assertEquals(codes(readiness), []);
  assert(readiness.passed);
});

Deno.test("readiness: proposals with no criteria attestation at all are not reported", () => {
  const readiness = check({
    attestations: [],
    independentCriteria: [proposal("icr_1", "Something was missed.")],
  }, "strict");
  assertEquals(codes(readiness), []);
});

Deno.test("readiness: the light lane waives the finding to skipped", () => {
  // The lane's single criterion is the kernel's, so there is no agent framing
  // for an independent reviewer to second-guess.
  const readiness = check({
    attestations: [criteriaAttestation()],
    independentCriteria: [proposal("icr_1", "Something was missed.")],
    changeClass: {
      declared: "light",
      effective: "light",
      escalated: false,
      reason: "Light-tier work.",
    },
  }, "strict");
  assert(!codes(readiness).includes("UNCOVERED_INDEPENDENT_CRITERION"));
  assert(skippedCodes(readiness).includes("UNCOVERED_INDEPENDENT_CRITERION"));
  assert(readiness.passed);
});

Deno.test("readiness: an empty proposal set needs no attestation and reports nothing", () => {
  const readiness = check({ independentCriteria: [] }, "strict");
  assertEquals(codes(readiness), []);
});

// --- priority downgrade -----------------------------------------------------
// `priority` is the most load-bearing agent-chosen field in the gate: only
// `must` claims face adversarial review.

Deno.test("readiness: PRIORITY_DOWNGRADED when the reviewer said must and the claim says should", () => {
  const readiness = check({
    acceptanceCriteria: [claim("clm_1", "should")],
    attestations: [criteriaAttestation()],
    independentCriteria: [
      proposal("icr_1", "Payments are never double-charged.", {
        priority: "must",
        coveredBy: "clm_1",
      }),
    ],
  });
  const issue = readiness.warnings.find((i) => i.code === "PRIORITY_DOWNGRADED");
  assert(issue);
  assert(issue.message.includes("Payments are never double-charged."));
  // The message must name the consequence, not just the mismatch.
  assert(issue.message.includes("not adversarially reviewed"));
});

Deno.test("readiness: no finding when both sides agree the claim is a must", () => {
  const readiness = check({
    acceptanceCriteria: [claim("clm_1", "must")],
    attestations: [criteriaAttestation(), adversarial("att_a", "clm_1", "passed")],
    independentCriteria: [
      proposal("icr_1", "It holds.", { priority: "must", coveredBy: "clm_1" }),
    ],
  });
  assert(!warningCodes(readiness).includes("PRIORITY_DOWNGRADED"));
});

Deno.test("readiness: a should-rated proposal never raises the finding", () => {
  const readiness = check({
    acceptanceCriteria: [claim("clm_1", "nice")],
    attestations: [criteriaAttestation()],
    independentCriteria: [
      proposal("icr_1", "Minor nicety.", { priority: "should", coveredBy: "clm_1" }),
    ],
  });
  assert(!warningCodes(readiness).includes("PRIORITY_DOWNGRADED"));
});

Deno.test("readiness: an UNCOVERED must-proposal raises the gap, not the downgrade", () => {
  // With nothing covering it there is no priority to disagree with — the gap
  // finding already says everything there is to say.
  const readiness = check({
    attestations: [criteriaAttestation()],
    independentCriteria: [proposal("icr_1", "Missed entirely.", { priority: "must" })],
  });
  assert(warningCodes(readiness).includes("UNCOVERED_INDEPENDENT_CRITERION"));
  assert(!warningCodes(readiness).includes("PRIORITY_DOWNGRADED"));
});

Deno.test("readiness: PRIORITY_DOWNGRADED hardens only under strict, and the light lane waives it", () => {
  const downgraded = {
    acceptanceCriteria: [claim("clm_1", "should")],
    attestations: [criteriaAttestation()],
    independentCriteria: [
      proposal("icr_1", "It matters.", { priority: "must", coveredBy: "clm_1" }),
    ],
  };
  assert(warningCodes(check(downgraded, "graduated")).includes("PRIORITY_DOWNGRADED"));
  assert(codes(check(downgraded, "strict")).includes("PRIORITY_DOWNGRADED"));

  const light = check({
    ...downgraded,
    changeClass: {
      declared: "light" as const,
      effective: "light" as const,
      escalated: false,
      reason: "Light-tier work.",
    },
  }, "strict");
  assert(skippedCodes(light).includes("PRIORITY_DOWNGRADED"));
  assert(light.passed);
});

Deno.test("readiness: a STALE review raises neither criteria finding", () => {
  const readiness = check({
    acceptanceCriteria: [claim("clm_1", "should")],
    attestations: [att({ id: "att_crit", kind: "criteria", fingerprint: "old" })],
    independentCriteria: [
      proposal("icr_1", "It matters.", { priority: "must", coveredBy: "clm_1" }),
      proposal("icr_2", "So does this.", { priority: "must" }),
    ],
  }, "strict");
  assertEquals(codes(readiness), []);
});

// --- the evidence→attestation kind map --------------------------------------

Deno.test("every grounded evidence kind maps to an attestation kind", () => {
  // Totality, pinned: a grounded kind with no mapping would silently skip the
  // kind check and accept an attestation from any verifier at all. The compiler
  // checks the KEYS are real evidence kinds; only this checks none is missing.
  const unmapped = [...GROUNDED_EVIDENCE_KINDS].filter((kind) =>
    EVIDENCE_ATTESTATION_KINDS[kind] === undefined
  );
  assertEquals(unmapped, []);
});

Deno.test("narrative evidence kinds are deliberately absent from the map", () => {
  // They are self-reported by design (there is no verifier to disagree with), so
  // an entry here would be claiming a provenance they do not have.
  for (const kind of ["manual", "note", "screenshot", "adversarial"] as const) {
    assertEquals(EVIDENCE_ATTESTATION_KINDS[kind], undefined);
  }
});
