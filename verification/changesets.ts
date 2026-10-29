// @layer verification — changeset governance, gates, ledger.
import {
  and,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  ne,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  genieChangesetsTable,
  genieVerificationLedgerTable,
} from "../core/db/schema/index.ts";
import type { DrizzleDb } from "../core/db/factory.ts";
import {
  ensureDir,
  readJsonFile,
  writeJsonIfChanged,
} from "../core/history-store.ts";
import { createTimestampedId } from "../core/ids.ts";
import { localUser } from "../core/auth.ts";

// The verification / changeset vocabulary is declared in ./types.ts (core) so
// lower layers can reference it without importing upward into this verification
// module (OpenTide §3.2). Imported here for internal use and re-exported for
// existing importers.
import { SKIP_LIGHT_TIER, tierPolicy } from "./change-class.ts";
import { ChangesetActiveError } from "../core/types.ts";
import type {
  Attestation,
  AttestationInput,
  AttestationKind,
  ChangeClass,
  Changeset,
  ChangesetChangelogSource,
  ChangesetPlan,
  ChangesetPlanAmendment,
  ChangesetReadiness,
  ChangesetReadinessIssue,
  ChangesetStatus,
  ChangesetStep,
  ChangesetStore,
  ChangesetUsageSource,
  FormalSpecPatch,
  LedgerEntry,
  LedgerQuery,
  ProposedCriterion,
  ReadinessEnforcement,
  VerificationEvidence,
  VerificationRun,
  VerificationStatus,
} from "../core/types.ts";
export type {
  Attestation,
  AttestationInput,
  AttestationKind,
  ChangeClass,
  Changeset,
  ChangesetPlan,
  ChangesetPlanAmendment,
  ChangesetReadiness,
  ChangesetReadinessIssue,
  ChangesetStatus,
  ChangesetStep,
  FormalSpec,
  FormalSpecEnforcement,
  FormalSpecTechnique,
  LedgerEntry,
  LedgerQuery,
  ProposedCriterion,
  ReadinessEnforcement,
  VerificationCheck,
  VerificationCheckKind,
  VerificationClaim,
  VerificationClaimPriority,
  VerificationClaimResult,
  VerificationClaimSource,
  VerificationEvidence,
  VerificationRun,
  VerificationStatus,
} from "../core/types.ts";

type Row = typeof genieChangesetsTable.$inferSelect;
type LedgerRow = typeof genieVerificationLedgerTable.$inferSelect;

const VALID_TRANSITIONS: Record<ChangesetStatus, ChangesetStatus[]> = {
  planning: ["approved", "in_progress", "abandoned", "rejected"],
  approved: ["in_progress", "abandoned"],
  in_progress: ["completed", "abandoned"],
  completed: [],
  abandoned: [],
  rejected: [],
};

// Statuses considered "active" (still in flight) — used by getActive and the
// stale-changeset sweep.
const ACTIVE_STATUSES: ChangesetStatus[] = [
  "planning",
  "approved",
  "in_progress",
];

// A changeset with no session (made before sessions were recorded, or by a
// caller without one) belongs to the null session.
function ownedBy(cs: Changeset, sessionId: string | null): boolean {
  return (cs.sessionId ?? null) === sessionId;
}

function sessionIs(sessionId: string | null) {
  return sessionId === null
    ? isNull(genieChangesetsTable.sessionId)
    : eq(genieChangesetsTable.sessionId, sessionId);
}

function sessionIsNot(sessionId: string | null) {
  return sessionId === null
    ? sql`${genieChangesetsTable.sessionId} IS NOT NULL`
    : or(
      isNull(genieChangesetsTable.sessionId),
      ne(genieChangesetsTable.sessionId, sessionId),
    );
}

// Statuses in which a work message id may still be attached to a changeset.
const WORK_MESSAGE_STATUSES: ChangesetStatus[] = [
  "approved",
  "in_progress",
  "completed",
];
// Statuses in which an approval message id may still be attached.
const APPROVAL_MESSAGE_STATUSES: ChangesetStatus[] = [
  "approved",
  "in_progress",
];

// --- Shared pure helpers used by both storage backends ---

function rowToChangeset(row: Row): Changeset {
  return {
    id: row.id,
    sessionId: row.sessionId,
    title: row.title,
    description: row.description,
    status: row.status as ChangesetStatus,
    plan: (row.plan as ChangesetPlan | null) ?? { summary: "", steps: [] },
    planMessageIds: (row.planMessageIds as number[] | null) ?? [],
    approvalMessageId: row.approvalMessageId,
    workMessageIds: (row.workMessageIds as number[] | null) ?? [],
    toolCalls: row.toolCalls as unknown[] | null,
    reasoning: row.reasoning as unknown[] | null,
    tokenUsage: row.tokenUsage as Changeset["tokenUsage"],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    completedAt: row.completedAt,
    creatorUserId: row.creatorUserId ?? null,
  };
}

// Nullable DB columns map back to the optional fields of Attestation. Absent
// optionals are omitted (not set to undefined) so DB rows match the File
// store's JSON shape, where undefined keys are dropped on serialization.
function rowToLedgerEntry(row: LedgerRow): LedgerEntry {
  return {
    id: row.id,
    kind: row.kind as AttestationKind,
    status: row.status as VerificationStatus,
    fingerprint: row.fingerprint,
    scope: row.scope,
    summary: row.summary,
    createdAt: row.createdAt,
    changesetId: row.changesetId,
    changesetTitle: row.changesetTitle,
    ...(row.checkId !== null ? { checkId: row.checkId } : {}),
    ...(row.toolCallId !== null ? { toolCallId: row.toolCallId } : {}),
    ...(row.turnId !== null ? { turnId: row.turnId } : {}),
    ...(row.principalId !== null ? { principalId: row.principalId } : {}),
    ...(row.producer === "client" ? { producer: "client" as const } : {}),
    ...(row.reviewer !== null ? { reviewer: row.reviewer } : {}),
  };
}

function normalizeChangeset(changeset: Changeset): Changeset {
  return {
    ...changeset,
    creatorUserId: changeset.creatorUserId ?? localUser().id,
  };
}

function validateTransition(from: ChangesetStatus, to: ChangesetStatus): void {
  const allowed = VALID_TRANSITIONS[from];
  if (!allowed?.includes(to)) {
    throw new Error(`Invalid transition: "${from}" → "${to}"`);
  }
}

// Marks any pending/in-progress steps as done. Mutates the passed plan in place
// (matching the long-standing behavior) and returns it for convenience.
function markStepsDone(plan: ChangesetPlan): ChangesetPlan {
  for (const step of plan.steps) {
    if (step.status === "pending" || step.status === "in_progress") {
      step.status = "done";
    }
  }
  return plan;
}

// Applies a user edit (relax/promote enforcement, or remove) to a formal spec.
// Pure — callers persist the returned plan.
function applyFormalSpecPatch(
  plan: ChangesetPlan,
  specId: string,
  patch: FormalSpecPatch,
): ChangesetPlan {
  const specs = plan.formalSpecs ?? [];
  if (!specs.some((s) => s.id === specId)) {
    throw new Error(`Formal spec "${specId}" not found`);
  }
  if (patch.remove) {
    return { ...plan, formalSpecs: specs.filter((s) => s.id !== specId) };
  }
  if (patch.enforcement) {
    return {
      ...plan,
      formalSpecs: specs.map((s) =>
        s.id === specId ? { ...s, enforcement: patch.enforcement! } : s
      ),
    };
  }
  return plan;
}

function appendSummary(base: string, addendum: string): string {
  const trimmedBase = base.trim();
  const trimmedAddendum = addendum.trim();
  if (!trimmedAddendum) return base;
  if (!trimmedBase) return trimmedAddendum;
  return `${trimmedBase}\n\nAmendment: ${trimmedAddendum}`;
}

function amendChangesetPlan(
  plan: ChangesetPlan,
  amendment: ChangesetPlanAmendment,
): ChangesetPlan {
  const hasAddendum = amendment.summaryAddendum.trim().length > 0;
  const hasPlanAdditions = amendment.steps.length > 0 ||
    (amendment.acceptanceCriteria?.length ?? 0) > 0 ||
    (amendment.verificationPlan?.length ?? 0) > 0 ||
    (amendment.formalSpecs?.length ?? 0) > 0;
  if (!hasAddendum || !hasPlanAdditions) {
    throw new Error(
      "Changeset amendments must include a summary addendum and at least one plan addition.",
    );
  }
  const stepIds = new Set(plan.steps.map((step) => step.id));
  let stepIndex = plan.steps.length;
  const appendedSteps = amendment.steps.map((description) => {
    let id = `step_${stepIndex++}`;
    while (stepIds.has(id)) id = `step_${stepIndex++}`;
    stepIds.add(id);
    return {
      id,
      description,
      status: "pending" as const,
    };
  });
  return {
    ...plan,
    summary: appendSummary(plan.summary, amendment.summaryAddendum),
    steps: [...plan.steps, ...appendedSteps],
    acceptanceCriteria: [
      ...(plan.acceptanceCriteria ?? []),
      ...(amendment.acceptanceCriteria ?? []),
    ],
    verificationPlan: [
      ...(plan.verificationPlan ?? []),
      ...(amendment.verificationPlan ?? []),
    ],
    formalSpecs: [
      ...(plan.formalSpecs ?? []),
      ...(amendment.formalSpecs ?? []),
    ],
  };
}

function validationIssue(
  code: string,
  message: string,
  action: string,
  severity: ChangesetReadinessIssue["severity"] = "error",
): ChangesetReadinessIssue {
  return { code, message, action, severity };
}

// Deterministic evidence codes clear by re-running a verifier locally, so they
// are safe to enforce first (no API key / model dependency).
const GRADUATED_PROMOTED_CODES = new Set<string>([
  "STALE_EVIDENCE",
  "UNATTESTED_EVIDENCE",
  // Both are pure comparisons against an attestation already in hand — no
  // verifier re-run, no model, no key — so they belong on the first rung beside
  // the other deterministic evidence codes.
  "EVIDENCE_ATTESTATION_MISMATCH",
  "EVIDENCE_CONTRADICTS_ATTESTATION",
]);
// Unreviewed must-claims need a model verdict to clear, so they only harden
// under strict (which can dead-end keyless/offline completion — a deliberate
// opt-in). Fresh CLAIM_REFUTED is always a hard blocker below.
const STRICT_PROMOTED_CODES = new Set<string>([
  ...GRADUATED_PROMOTED_CODES,
  "MUST_CLAIM_UNREVIEWED",
  // Also model-dependent, and softer than the rest: an uncovered proposal is one
  // reviewer's opinion that something was missed, not a demonstrated defect. It
  // hardens only under strict, where the operator has opted into a gate that can
  // dead-end without a key.
  "UNCOVERED_INDEPENDENT_CRITERION",
  "PRIORITY_DOWNGRADED",
]);

function promotedReadinessCodes(mode: ReadinessEnforcement): Set<string> {
  if (mode === "strict") return STRICT_PROMOTED_CODES;
  if (mode === "graduated") return GRADUATED_PROMOTED_CODES;
  return new Set();
}

// Who ran a review the client submitted, for a finding's message. Empty for
// the kernel's own.
function reviewedBy(att: Attestation): string {
  if (att.producer !== "client") return "";
  return att.reviewer ? ` (client, ${att.reviewer})` : " (client)";
}

// Evidence kinds that must be backed by a kernel-minted attestation to be
// trusted. Narrative kinds (manual, note, screenshot, adversarial) stay
// agent-authored and are surfaced as self-reported.
export const GROUNDED_EVIDENCE_KINDS = new Set<VerificationEvidence["kind"]>([
  "typecheck",
  "coverage",
  "audit",
  "invariant",
  "unit",
  "integration",
  "e2e",
  "test_result",
  // Kernel-built from the changelog, never agent-asserted — grounded by the same
  // standard as the verifiers above, and so subject to attestation/freshness checks.
  "manifest",
]);

// The attestation kind that legitimately backs each grounded evidence kind. The
// three test flavours all discharge to the one `test` attestation run_tests mints;
// everything else is 1:1. Without this, an evidence item can cite ANY attestation
// on the changeset — a passing coverage run would happily back a typecheck claim.
// Keyed on the evidence-kind union rather than `string`, so a typo here is a
// compile error instead of a silently skipped check. Partial because the
// narrative kinds (manual, note, screenshot, adversarial) are self-reported by
// design and have no attestation to agree with; changesets_test.ts pins that
// every GROUNDED kind does have an entry.
export const EVIDENCE_ATTESTATION_KINDS: Partial<
  Record<VerificationEvidence["kind"], AttestationKind>
> = {
  typecheck: "typecheck",
  coverage: "coverage",
  audit: "audit",
  invariant: "invariant",
  unit: "test",
  integration: "test",
  e2e: "test",
  test_result: "test",
  manifest: "change_manifest",
};

// How much a verification status asserts, so "is the evidence claiming more than
// its attestation found?" is a comparison rather than a pile of conditionals.
// `manual` sits at the bottom with `failed`: it asserts nothing a verifier proved,
// so it can never be the thing that licenses a stronger evidence status.
const STATUS_STRENGTH: Record<VerificationStatus, number> = {
  failed: 0,
  manual: 0,
  partial: 1,
  passed: 2,
};

// An attestation is fresh when its recorded fingerprint still matches the
// current source for its scope. When no fingerprint map is supplied (the store
// backstop path, which has no kernel access), freshness can't be evaluated so
// existence alone counts — the fingerprint-aware dispatch gate is authoritative.
function isFreshAttestation(
  att: Attestation,
  currentFingerprints?: Record<string, string>,
): boolean {
  if (!currentFingerprints) return true;
  const current = currentFingerprints[att.scope];
  return current !== undefined && current === att.fingerprint;
}

// The latest passing invariant attestation discharging a given formal spec.
function latestInvariant(
  attestations: Attestation[],
  specId: string,
): Attestation | undefined {
  return attestations
    .filter((a) =>
      a.kind === "invariant" && a.status === "passed" && a.checkId === specId
    )
    .at(-1);
}

export function validateChangesetPlan(plan: ChangesetPlan): string | null {
  if ((plan.acceptanceCriteria?.length ?? 0) === 0) {
    return "Changeset plans must include at least one acceptance criterion.";
  }
  if ((plan.verificationPlan?.length ?? 0) === 0) {
    return "Changeset plans must include at least one planned verification check.";
  }
  const duplicateClaimId = firstDuplicateId(plan.acceptanceCriteria ?? []);
  if (duplicateClaimId) {
    return `Changeset acceptance criteria must have unique ids; duplicate id "${duplicateClaimId}" found.`;
  }
  const duplicateCheckId = firstDuplicateId(plan.verificationPlan ?? []);
  if (duplicateCheckId) {
    return `Changeset verification plan checks must have unique ids; duplicate id "${duplicateCheckId}" found.`;
  }
  return null;
}

function firstDuplicateId(items: Array<{ id: string }>): string | null {
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.id)) return item.id;
    seen.add(item.id);
  }
  return null;
}

export function checkChangesetReadiness(
  changeset: Changeset,
  currentFingerprints?: Record<string, string>,
  enforcement: ReadinessEnforcement = "advisory",
): ChangesetReadiness {
  const errors: ChangesetReadinessIssue[] = [];
  const warnings: ChangesetReadinessIssue[] = [];
  // Findings the active change class waived, each carrying its reason. Kept as a
  // separate list (not filtered out of errors/warnings) so a waiver is visible as a
  // deliberate policy decision rather than a silent absence.
  const skipped: ChangesetReadinessIssue[] = [];
  // Under a stricter policy, these graduated codes become hard errors instead
  // of advisory warnings (see promotedReadinessCodes).
  const promoted = promotedReadinessCodes(enforcement);
  const pushGraduated = (code: string, message: string, action: string) => {
    if (promoted.has(code)) {
      errors.push(validationIssue(code, message, action, "error"));
    } else {
      warnings.push(validationIssue(code, message, action, "warning"));
    }
  };
  const plan = changeset.plan;
  const acceptanceCriteria = plan.acceptanceCriteria ?? [];
  const verificationPlan = plan.verificationPlan ?? [];
  const formalSpecs = plan.formalSpecs ?? [];
  const verificationRuns = plan.verificationRuns ?? [];
  const attestations = plan.attestations ?? [];
  const incompleteSteps = plan.steps.filter((step) =>
    step.status !== "done" && step.status !== "skipped"
  );
  const latestVerification = verificationRuns.at(-1) ?? null;
  const latestEvidence = latestVerification?.evidence ?? [];
  const latestClaimResults = latestVerification?.claimResults ?? [];
  const claimResultIds = new Set(
    latestClaimResults.map((item) => item.claimId),
  );
  const evidenceIds = new Set(latestEvidence.map((item) => item.id));

  if (changeset.status !== "in_progress") {
    errors.push(validationIssue(
      "CHANGESET_NOT_IN_PROGRESS",
      `Changeset is "${changeset.status}", not "in_progress".`,
      "Approve and start the changeset before completing it.",
    ));
  }

  if (acceptanceCriteria.length === 0) {
    errors.push(validationIssue(
      "MISSING_ACCEPTANCE_CRITERIA",
      "No acceptance criteria are recorded.",
      "Update the changeset plan with concrete acceptance criteria.",
    ));
  }

  if (verificationPlan.length === 0) {
    errors.push(validationIssue(
      "MISSING_VERIFICATION_PLAN",
      "No planned verification checks are recorded.",
      "Update the changeset plan with planned checks mapped to acceptance criteria.",
    ));
  }

  if (incompleteSteps.length > 0) {
    errors.push(validationIssue(
      "INCOMPLETE_STEPS",
      `${incompleteSteps.length} step(s) are still pending or in progress.`,
      "Finish, skip, or update each remaining changeset step before completion.",
    ));
  }

  if (verificationRuns.length === 0) {
    errors.push(validationIssue(
      "MISSING_VERIFICATION_RUN",
      "No verification run is recorded.",
      "Run the planned checks, then call record_verification_run with evidence and per-claim results.",
    ));
  } else if (latestVerification) {
    if (
      latestVerification.status === "failed" ||
      latestVerification.status === "partial"
    ) {
      errors.push(validationIssue(
        "VERIFICATION_NOT_PASSING",
        `Latest verification status is "${latestVerification.status}".`,
        "Fix the failing or partial verification items, rerun checks, and record a passing or explicitly manual verification run.",
      ));
    }

    if (latestEvidence.length === 0) {
      errors.push(validationIssue(
        "MISSING_VERIFICATION_EVIDENCE",
        "Latest verification run has no evidence.",
        "Record evidence from tests, type checks, coverage, screenshots, browser runs, audits, or manual checks.",
      ));
    }

    if (latestClaimResults.length === 0) {
      errors.push(validationIssue(
        "MISSING_CLAIM_RESULTS",
        "Latest verification run has no per-claim results.",
        "Record a claim result for each acceptance criterion.",
      ));
    }

    const missingClaimResults = acceptanceCriteria
      .filter((claim) => !claimResultIds.has(claim.id));
    if (missingClaimResults.length > 0) {
      errors.push(validationIssue(
        "UNCOVERED_ACCEPTANCE_CRITERIA",
        `${missingClaimResults.length} acceptance criterion/criteria have no latest verification result.`,
        `Add claimResults for: ${
          missingClaimResults.map((claim) => claim.id).join(", ")
        }.`,
      ));
    }

    const danglingEvidenceIds = latestClaimResults.flatMap((result) =>
      result.evidenceIds.filter((id) => !evidenceIds.has(id))
    );
    if (danglingEvidenceIds.length > 0) {
      errors.push(validationIssue(
        "MISSING_REFERENCED_EVIDENCE",
        `${danglingEvidenceIds.length} claim evidence reference(s) point to missing evidence.`,
        `Fix evidenceIds or add evidence records for: ${
          [...new Set(danglingEvidenceIds)].join(", ")
        }.`,
      ));
    }

    const nonPassingEvidence = latestEvidence.filter((item) =>
      item.status === "failed" || item.status === "partial"
    );
    if (nonPassingEvidence.length > 0) {
      errors.push(validationIssue(
        "VERIFICATION_EVIDENCE_NOT_PASSING",
        `${nonPassingEvidence.length} verification evidence item(s) are failed or partial.`,
        "Fix the failed checks, rerun them, and record passing evidence before completion.",
      ));
    }

    const nonPassingClaimResults = latestClaimResults.filter((result) =>
      result.status === "failed" || result.status === "partial"
    );
    if (nonPassingClaimResults.length > 0) {
      errors.push(validationIssue(
        "CLAIM_RESULTS_NOT_PASSING",
        `${nonPassingClaimResults.length} acceptance claim result(s) are failed or partial.`,
        "Fix the unmet acceptance criteria, rerun verification, and record passing claim results before completion.",
      ));
    }

    const manualClaimResults = latestClaimResults.filter((result) =>
      result.status === "manual"
    );
    if (manualClaimResults.length > 0) {
      const manualCheckClaimIds = new Set(
        verificationPlan
          .filter((check) => check.kind === "manual")
          .flatMap((check) => check.claimIds),
      );
      const unplannedManual = manualClaimResults.filter((result) =>
        !manualCheckClaimIds.has(result.claimId)
      );
      if (unplannedManual.length > 0) {
        errors.push(validationIssue(
          "UNPLANNED_MANUAL_VERIFICATION",
          `${unplannedManual.length} manual claim result(s) are not mapped to an explicitly planned manual check.`,
          "Use automated evidence for non-manual checks, or amend the plan with an explicit manual verification check before relying on manual verification.",
        ));
      }
    }

    if (latestVerification.status === "manual") {
      warnings.push(validationIssue(
        "MANUAL_VERIFICATION",
        "Latest verification is marked manual.",
        "Only complete if manual verification is intentional and residual risks are documented.",
        "warning",
      ));
    }
  }

  const plannedClaimIds = new Set(
    verificationPlan.flatMap((check) => check.claimIds),
  );
  const claimsMissingPlannedChecks = acceptanceCriteria
    .filter((claim) => !plannedClaimIds.has(claim.id));
  if (claimsMissingPlannedChecks.length > 0) {
    warnings.push(validationIssue(
      "CLAIMS_WITHOUT_PLANNED_CHECKS",
      `${claimsMissingPlannedChecks.length} acceptance criterion/criteria are not referenced by a planned check.`,
      `Map planned checks to: ${
        claimsMissingPlannedChecks.map((claim) => claim.id).join(", ")
      }.`,
      "warning",
    ));
  }

  // A hard formal spec is satisfied only by a FRESH passing invariant
  // attestation (kernel-minted, fingerprint still matching current code).
  const attestationById = new Map(attestations.map((a) => [a.id, a]));
  let formalSpecsVerified = 0;
  for (const spec of formalSpecs) {
    const att = latestInvariant(attestations, spec.id);
    const fresh = att !== undefined &&
      isFreshAttestation(att, currentFingerprints);
    if (fresh) {
      formalSpecsVerified++;
      continue;
    }
    const stale = att !== undefined; // a passing attestation exists but drifted
    if (spec.enforcement === "hard") {
      errors.push(validationIssue(
        "UNVERIFIED_FORMAL_SPEC",
        stale
          ? `Hard formal spec "${spec.id}" (${spec.technique} on ${spec.scope}) is stale: "${spec.scope}" changed since it was verified.`
          : `Hard formal spec "${spec.id}" (${spec.technique} on ${spec.scope}) is not verified: ${spec.statement}`,
        "Add the type-level guard to the target entity, run verify_formal_specs to mint a fresh invariant attestation, then reference it from record_verification_run.",
      ));
    } else {
      warnings.push(validationIssue(
        "SOFT_FORMAL_SPEC_UNMET",
        stale
          ? `Soft formal spec "${spec.id}" (${spec.technique} on ${spec.scope}) has a stale invariant attestation ("${spec.scope}" changed since verification).`
          : `Soft formal spec "${spec.id}" (${spec.technique} on ${spec.scope}) has no passing invariant attestation.`,
        "Optionally satisfy the guard and run verify_formal_specs, or leave it as an advisory suggestion.",
        "warning",
      ));
    }
  }

  // Grounded evidence in the latest run must trace to a kernel-minted, still-
  // fresh attestation. Phase 1 keeps these as warnings (graduated enforcement).
  for (const item of latestEvidence) {
    if (!GROUNDED_EVIDENCE_KINDS.has(item.kind)) continue;
    const att = item.attestationId
      ? attestationById.get(item.attestationId)
      : undefined;
    if (!att) {
      pushGraduated(
        "UNATTESTED_EVIDENCE",
        `${item.kind} evidence "${item.id}" is not backed by a kernel attestation.`,
        "Produce it via the matching verifier (run_tests, check_export_types, verify_formal_specs, test_coverage, or an audit review) and reference the returned attestationId.",
      );
    } else if (!isFreshAttestation(att, currentFingerprints)) {
      pushGraduated(
        "STALE_EVIDENCE",
        `${item.kind} evidence "${item.id}" is stale: code changed since attestation "${att.id}" was minted.`,
        "Re-run the verifier against current code and record the fresh attestation before completing.",
      );
    } else {
      // The attestation exists and is fresh. That proves a verifier ran against
      // this code — it does NOT yet prove the verifier was the right one, or that
      // it agreed with what the evidence says about it. Both of those are read
      // from agent-supplied input (normalizeEvidence copies `kind` and `status`
      // verbatim), so without these two checks a passing evidence row can cite a
      // FAILED attestation, or a coverage attestation can back a typecheck claim,
      // and the gate reads green. Deterministic and free, hence graduated.
      const expectedKind = EVIDENCE_ATTESTATION_KINDS[item.kind];
      if (expectedKind && att.kind !== expectedKind) {
        pushGraduated(
          "EVIDENCE_ATTESTATION_MISMATCH",
          `${item.kind} evidence "${item.id}" cites attestation "${att.id}", which is a ${att.kind} attestation (expected ${expectedKind}).`,
          `Reference the attestationId returned by the verifier that produces ${expectedKind} proof, not one from an unrelated check.`,
        );
      } else if (
        STATUS_STRENGTH[item.status] > STATUS_STRENGTH[att.status]
      ) {
        pushGraduated(
          "EVIDENCE_CONTRADICTS_ATTESTATION",
          `${item.kind} evidence "${item.id}" is recorded as "${item.status}", but its attestation "${att.id}" recorded "${att.status}".`,
          "The attestation is the kernel's record of what the verifier actually found. Fix the underlying failure, re-run the verifier, and record the fresh attestation — do not restate its result.",
        );
      }
    }
  }

  const staleAttestations = currentFingerprints
    ? attestations.filter((a) => !isFreshAttestation(a, currentFingerprints))
      .length
    : 0;

  // Adversarial: a claim is refuted when its LATEST fresh adversarial verdict is
  // `failed`. Only that verdict counts — a later `passed` review against the
  // same code supersedes an earlier counterexample — so we group by claim and
  // take the most recent fresh verdict rather than blocking on any historical
  // failure (attestations are append-only, so refuted-then-fixed claims keep
  // their old failing verdict forever). Freshness requires a fingerprint map;
  // without one (the store-gate backstop path, which has no kernel access)
  // freshness is unknowable, so a historical counterexample must NOT resurrect
  // as a hard block — the fingerprint-aware dispatch gate is authoritative.
  // (isFreshAttestation defaults to true on an undefined map — a safe fail-open
  // for formal specs, but backwards here — so the map is guarded explicitly.)
  const claimById = new Map(acceptanceCriteria.map((c) => [c.id, c]));
  const latestAdversarialVerdict = new Map<string, Attestation>();
  if (currentFingerprints) {
    for (const att of attestations) {
      if (att.kind !== "adversarial") continue;
      if (!isFreshAttestation(att, currentFingerprints)) continue;
      // Attestations are appended chronologically, so a later array position is
      // a newer verdict; keyless adversarial attestations key on their own id so
      // each stands alone (nothing can supersede them).
      latestAdversarialVerdict.set(att.checkId ?? att.id, att);
    }
  }
  let claimsRefuted = 0;
  for (const att of latestAdversarialVerdict.values()) {
    if (att.status !== "failed") continue;
    claimsRefuted++;
    const claim = att.checkId ? claimById.get(att.checkId) : undefined;
    errors.push(validationIssue(
      "CLAIM_REFUTED",
      `Adversarial review${reviewedBy(att)} found a counterexample for ${
        claim ? `"${claim.text}"` : `claim "${att.checkId}"`
      }: ${att.summary}`,
      'Review the counterexample, fix the code, tighten the claim, or dismiss it if invalid, then run a fresh refute review (refute_claims, or request_review with kind "refute").',
    ));
  }

  // Every `must` criterion should face adversarial review. A must-claim with no
  // fresh adversarial attestation (any verdict) raises an advisory
  // MUST_CLAIM_UNREVIEWED warning. It clears once a refute review against the
  // current code is submitted (core/reviews.ts).
  const freshAdversarialClaimIds = new Set(
    attestations
      .filter((a) =>
        a.kind === "adversarial" && a.checkId &&
        isFreshAttestation(a, currentFingerprints)
      )
      .map((a) => a.checkId!),
  );
  let mustClaimsReviewed = 0;
  for (const claim of acceptanceCriteria) {
    if (claim.priority !== "must") continue;
    if (freshAdversarialClaimIds.has(claim.id)) {
      mustClaimsReviewed++;
      continue;
    }
    pushGraduated(
      "MUST_CLAIM_UNREVIEWED",
      `Must-criterion "${claim.text}" has not faced adversarial review against current code.`,
      'Run a refute review on this criterion (refute_claims, or request_review with kind "refute").',
    );
  }

  // Independent criteria. What a reviewer that never saw this plan said the change
  // had to do, minus whatever the plan already covers (coverage is computed by the
  // agent layer at mint time and recorded on each proposal). Reported one finding
  // per gap so each can be dismissed on its own merits: these are proposals, not
  // proofs, and a human adjudicates them.
  //
  // Freshness-gated like every other proof here, and for the same reason: a
  // proposal is a judgement about a particular diff, so once the code moves it is
  // an opinion about something that no longer exists. The gate re-runs the review
  // on each completion and replaces the set wholesale, so in the normal path the
  // attestation is always fresh; this guard is what stops a keyless or
  // setting-disabled completion from reporting gaps found against older code.
  const independentCriteria = plan.independentCriteria ?? [];
  const criteriaReviewFresh = independentCriteria.length === 0 ||
    attestations.some((a) =>
      a.kind === "criteria" && isFreshAttestation(a, currentFingerprints)
    );
  const uncoveredCriteria = criteriaReviewFresh
    ? independentCriteria.filter((c) => !c.coveredBy)
    : [];
  for (const proposal of uncoveredCriteria) {
    pushGraduated(
      "UNCOVERED_INDEPENDENT_CRITERION",
      `Independent review proposed a criterion no acceptance criterion covers: "${proposal.text}"${
        proposal.rationale ? ` (${proposal.rationale})` : ""
      }`,
      "Confirm the behavior holds and add the criterion with amend_changeset_plan, or dismiss the proposal if the request never implied it.",
    );
  }

  // Priority downgrade. `priority` is the single most load-bearing agent-chosen
  // field in the gate: only `must` claims face adversarial review, so an agent
  // that rates everything `should` never faces one at all and still reads green.
  // Where the independent reviewer said `must` and the covering claim says
  // otherwise, that disagreement is worth surfacing — and it is the one place
  // comparing against the agent's claims is legitimate, because it happens here,
  // in plain code, after both sides are already recorded.
  if (criteriaReviewFresh) {
    const claimPriority = new Map(
      acceptanceCriteria.map((c) => [c.id, c.priority]),
    );
    for (const proposal of independentCriteria) {
      if (proposal.priority !== "must" || !proposal.coveredBy) continue;
      const covering = claimPriority.get(proposal.coveredBy);
      if (covering === undefined || covering === "must") continue;
      pushGraduated(
        "PRIORITY_DOWNGRADED",
        `Independent review rated "${proposal.text}" a \`must\`, but the covering acceptance criterion is \`${covering}\` — so it is not adversarially reviewed.`,
        "Promote the acceptance criterion to `must` with amend_changeset_plan and run a fresh refute review, or leave it if the lower priority is deliberate.",
      );
    }
  }

  // Proportional verification. Two passes, in this order:
  //
  // 1. ESCALATION is a hard error and is never waivable — a changeset that declared
  //    the light lane but exceeded it has already had its ceremony reduced on a
  //    premise that turned out false, so the full gate is the correct response.
  // 2. WAIVER runs LAST, after promotedReadinessCodes has already decided each
  //    finding's severity. This is a downward tier crossing an upward enforcement
  //    ladder, so the ordering is the whole contract: under `strict`, a promoted
  //    MUST_CLAIM_UNREVIEWED is demoted to `skipped` for a light changeset — because
  //    the light lane records a `should` criterion and there is genuinely no
  //    must-claim to review, not because strict was overridden.
  const changeClass = changeset.plan.changeClass;
  if (changeClass?.escalated) {
    errors.push(validationIssue(
      "CHANGE_CLASS_ESCALATED",
      changeClass.reason,
      "Re-run the verification this changeset now needs, or amend the plan with " +
        'change_class "standard" and the scope it actually took on.',
    ));
  }
  // The DOWNWARD counterpart to the promotion ladder: read from the one policy table
  // (change-class.ts) rather than restated here, so the two can never drift.
  const waived = changeClass?.effective === "light"
    ? tierPolicy("light").waivedReadinessCodes
    : null;
  if (waived) {
    for (const list of [errors, warnings]) {
      for (let i = list.length - 1; i >= 0; i--) {
        const issue = list[i]!;
        if (!waived.has(issue.code)) continue;
        list.splice(i, 1);
        skipped.push({
          ...issue,
          severity: "skipped",
          action: SKIP_LIGHT_TIER,
        });
      }
    }
  }

  const summary = errors.length === 0
    ? warnings.length === 0
      ? "Changeset is ready to complete."
      : `Changeset is ready to complete with ${warnings.length} warning(s).`
    : `Changeset is not ready: ${errors.length} error(s), ${warnings.length} warning(s).`;

  return {
    passed: errors.length === 0,
    changesetId: changeset.id,
    status: changeset.status,
    summary,
    errors,
    warnings,
    // Populated by the change-class waiver pass (Slice 5). Always an array so a
    // consumer reading `skipped` cannot mistake "no waivers" for "field absent".
    skipped,
    ...(changeset.plan.changeClass
      ? { changeClass: changeset.plan.changeClass }
      : {}),
    checks: {
      acceptanceCriteria: acceptanceCriteria.length,
      verificationPlan: verificationPlan.length,
      verificationRuns: verificationRuns.length,
      incompleteSteps: incompleteSteps.length,
      latestVerificationStatus: latestVerification?.status ?? null,
      evidence: latestEvidence.length,
      claimResults: latestClaimResults.length,
      formalSpecs: formalSpecs.length,
      formalSpecsVerified,
      attestations: attestations.length,
      staleAttestations,
      claimsRefuted,
      mustClaimsReviewed,
      projectConsistencyErrors: 0,
      projectConsistencyWarnings: 0,
    },
  };
}

function assertValidPlan(plan: ChangesetPlan): void {
  const issue = validateChangesetPlan(plan);
  if (issue) throw new Error(issue);
}

function assertReadyToComplete(cs: Changeset): void {
  assertValidPlan(cs.plan);
  const readiness = checkChangesetReadiness(cs);
  if (!readiness.passed) {
    throw new Error(readiness.summary);
  }
}

function canAutoComplete(cs: Changeset): boolean {
  return validateChangesetPlan(cs.plan) === null &&
    checkChangesetReadiness(cs).passed;
}

function nextCreatedAt(existing: Array<{ createdAt: string }>): string {
  const latest = existing.reduce((max, item) => {
    const time = Date.parse(item.createdAt);
    return Number.isFinite(time) ? Math.max(max, time) : max;
  }, 0);
  return new Date(Math.max(Date.now(), latest + 1)).toISOString();
}

// Computes the aggregated token usage for a changeset from its changelog turns.
async function computeTokenUsage(
  id: string,
  sessions: ChangesetUsageSource,
  changelog: ChangesetChangelogSource,
): Promise<Changeset["tokenUsage"]> {
  const changes = await changelog.listByChangeset(id);
  const turnIds = new Set<string>();
  for (const c of changes) {
    if (c.turnId) turnIds.add(c.turnId);
  }

  let totalInputTokens = 0;
  let totalCacheCreationInputTokens = 0;
  let totalCacheReadInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCostUsd = 0;
  let totalDurationMs = 0;
  let unpricedCalls = 0;
  let unpricedInputTokens = 0;
  let unpricedOutputTokens = 0;
  let sawEstimatedLegacy = false;
  let sawUsage = false;
  const countedModelUsageIds = new Set<string>();

  const addModelUsage = (row: {
    id?: string;
    inputTokens?: number;
    outputTokens?: number;
    costUsd?: number | null;
    pricingStatus?: string;
    durationMs?: number;
    cacheCreationInputTokens?: number;
    cacheReadInputTokens?: number;
  }) => {
    if (row.id) countedModelUsageIds.add(row.id);
    sawUsage = true;
    totalInputTokens += row.inputTokens ?? 0;
    totalCacheCreationInputTokens += row.cacheCreationInputTokens ?? 0;
    totalCacheReadInputTokens += row.cacheReadInputTokens ?? 0;
    totalOutputTokens += row.outputTokens ?? 0;
    if (row.pricingStatus === "priced") totalCostUsd += row.costUsd ?? 0;
    if (row.pricingStatus === "estimated_legacy") sawEstimatedLegacy = true;
    if (row.pricingStatus === "unpriced" || row.costUsd === null) {
      unpricedCalls += 1;
      unpricedInputTokens += row.inputTokens ?? 0;
      unpricedOutputTokens += row.outputTokens ?? 0;
    }
    totalDurationMs += row.durationMs ?? 0;
  };

  for (const turnId of turnIds) {
    const ledgerRows = await sessions.getModelUsagesForTurn?.(turnId) ?? [];
    if (ledgerRows.length > 0) {
      for (const row of ledgerRows) {
        addModelUsage(row);
      }
      continue;
    }
    const usage = await sessions.getTurnUsage(turnId);
    if (usage) {
      const unpriced = usage.pricingStatus === "unpriced" ||
        usage.costUsd === null;
      sawUsage = true;
      totalInputTokens += usage.inputTokens ?? 0;
      totalCacheCreationInputTokens += usage.cacheCreationInputTokens ?? 0;
      totalCacheReadInputTokens += usage.cacheReadInputTokens ?? 0;
      totalOutputTokens += usage.outputTokens ?? 0;
      if (usage.pricingStatus === "estimated_legacy") sawEstimatedLegacy = true;
      if (unpriced) {
        unpricedCalls += 1;
        unpricedInputTokens += usage.inputTokens ?? 0;
        unpricedOutputTokens += usage.outputTokens ?? 0;
      } else if (usage.pricingStatus !== "estimated_legacy") {
        totalCostUsd += usage.costUsd ?? 0;
      }
      totalDurationMs += usage.durationMs ?? 0;
    }
  }

  const changesetRows = await sessions.getModelUsagesForChangeset?.(id) ?? [];
  for (const row of changesetRows) {
    if (row.id && countedModelUsageIds.has(row.id)) continue;
    if (row.turnId && turnIds.has(row.turnId)) continue;
    addModelUsage(row);
  }

  return sawUsage
    ? {
      inputTokens: totalInputTokens,
      cacheCreationInputTokens: totalCacheCreationInputTokens,
      cacheReadInputTokens: totalCacheReadInputTokens,
      outputTokens: totalOutputTokens,
      costUsd: totalCostUsd,
      pricingStatus: unpricedCalls > 0
        ? "unpriced"
        : sawEstimatedLegacy
        ? "estimated_legacy"
        : "priced",
      unpricedCalls,
      unpricedInputTokens,
      unpricedOutputTokens,
      durationMs: totalDurationMs,
    }
    : null;
}

// The ChangesetStore contract lives in ./types.ts (core) so the Kernel can type
// `changesets` without importing this verification module (OpenTide §3.3).

// File-store location of the derived verification ledger (DB store uses the
// _genie_verification_ledger table).
const VERIFICATION_LEDGER_FILE = "verification-ledger.json";

function appendVerificationRun(
  cs: Changeset,
  run: Omit<VerificationRun, "id" | "createdAt" | "completedAt"> & {
    id?: string;
    createdAt?: string;
    completedAt?: string;
  },
): Changeset {
  const now = new Date().toISOString();
  const evidence = run.evidence.map((item) => ({
    ...item,
    id: item.id || createTimestampedId("ev"),
    createdAt: item.createdAt || now,
  }));
  const verificationRun: VerificationRun = {
    id: run.id ?? createTimestampedId("vr"),
    status: run.status,
    summary: run.summary,
    evidence,
    claimResults: run.claimResults,
    residualRisks: run.residualRisks,
    createdAt: run.createdAt ?? now,
    completedAt: run.completedAt ?? now,
  };
  return {
    ...cs,
    plan: {
      ...cs.plan,
      verificationRuns: [...(cs.plan.verificationRuns ?? []), verificationRun],
    },
    updatedAt: now,
  };
}

// Resolves the concrete attestation (assigning id/createdAt if omitted) so the
// same object can be appended to the plan AND mirrored into the ledger with a
// matching id — the shared identity is what makes dual-write idempotent.
function mintAttestation(att: AttestationInput): Attestation {
  return {
    ...att,
    id: att.id ?? createTimestampedId("att"),
    createdAt: att.createdAt ?? new Date().toISOString(),
  };
}

// Appends an already-minted attestation to the changeset's append-only ledger.
// Pure — callers persist the returned changeset.
function attachAttestation(cs: Changeset, attestation: Attestation): Changeset {
  return {
    ...cs,
    plan: {
      ...cs.plan,
      attestations: [...(cs.plan.attestations ?? []), attestation],
    },
    updatedAt: new Date().toISOString(),
  };
}

// Denormalizes a minted attestation into a ledger row for the derived index.
function toLedgerEntry(cs: Changeset, att: Attestation): LedgerEntry {
  return { ...att, changesetId: cs.id, changesetTitle: cs.title };
}

// Newest first, breaking ties by id so File and DB stores agree on order.
function byLedgerRecency(a: LedgerEntry, b: LedgerEntry): number {
  return b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id);
}

// Pure in-memory ledger query — the File store's counterpart to the DB store's
// SQL. Filters, sorts newest-first, then applies offset/limit.
function queryLedgerEntries(
  entries: LedgerEntry[],
  query?: LedgerQuery,
): LedgerEntry[] {
  let out = entries;
  if (query?.scope) out = out.filter((e) => e.scope === query.scope);
  if (query?.kind) out = out.filter((e) => e.kind === query.kind);
  if (query?.since) out = out.filter((e) => e.createdAt >= query.since!);
  out = out.toSorted(byLedgerRecency);
  const offset = query?.offset ?? 0;
  if (offset > 0) out = out.slice(offset);
  if (query?.limit !== undefined) out = out.slice(0, query.limit);
  return out;
}

function hasVerificationRun(cs: Changeset): boolean {
  return (cs.plan.verificationRuns?.length ?? 0) > 0;
}

function assertHasVerificationRun(cs: Changeset): void {
  if (!hasVerificationRun(cs)) {
    throw new Error(
      `Changeset "${cs.id}" cannot be completed without a verification run`,
    );
  }
}

// --- File-backed storage ---

class FileChangesetStore implements ChangesetStore {
  private readonly ready = Promise.resolve();
  private historyDir: string;

  constructor(historyDir: string) {
    this.historyDir = historyDir;
    ensureDir(this.changesetsDir());
  }

  private changesetsDir(): string {
    return join(this.historyDir, "changesets");
  }

  private changesetPath(id: string): string {
    return join(this.changesetsDir(), `${encodeURIComponent(id)}.json`);
  }

  private readFileChangeset(id: string): Changeset | null {
    return readJsonFile<Changeset>(this.changesetPath(id));
  }

  private writeFileChangeset(changeset: Changeset): void {
    writeJsonIfChanged(this.changesetPath(changeset.id), changeset);
  }

  private listFileChangesets(): Changeset[] {
    const dir = this.changesetsDir();
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((file) => file.endsWith(".json"))
      .map((file) => readJsonFile<Changeset>(join(dir, file)))
      .filter((changeset): changeset is Changeset => Boolean(changeset))
      .map(normalizeChangeset);
  }

  async create(opts: {
    sessionId?: string;
    title: string;
    description?: string;
    plan: ChangesetPlan;
    planMessageIds?: number[];
    creatorUserId?: string | null;
  }): Promise<Changeset> {
    assertValidPlan(opts.plan);
    const sessionId = opts.sessionId ?? null;
    await this.completeStaleChangesets(sessionId);
    const holder = await this.activeElsewhere(sessionId);
    if (holder) throw new ChangesetActiveError(holder);
    const now = nextCreatedAt(this.listFileChangesets());
    const changeset: Changeset = {
      id: createTimestampedId("cs"),
      sessionId: opts.sessionId ?? null,
      title: opts.title,
      description: opts.description ?? null,
      status: "planning",
      plan: opts.plan,
      planMessageIds: opts.planMessageIds ?? [],
      approvalMessageId: null,
      workMessageIds: [],
      toolCalls: null,
      reasoning: null,
      tokenUsage: null,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      creatorUserId: opts.creatorUserId ?? localUser().id,
    };
    this.writeFileChangeset(changeset);
    return changeset;
  }

  async get(id: string): Promise<Changeset | null> {
    await this.ready;
    return this.readFileChangeset(id);
  }

  async list(
    opts?: { sessionId?: string; status?: ChangesetStatus; limit?: number },
  ): Promise<Changeset[]> {
    await this.ready;
    return this.listFileChangesets()
      .filter((cs) => !opts?.sessionId || cs.sessionId === opts.sessionId)
      .filter((cs) => !opts?.status || cs.status === opts.status)
      .toSorted((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, opts?.limit ?? 100);
  }

  async updatePlan(id: string, plan: ChangesetPlan): Promise<Changeset> {
    await this.ready;
    assertValidPlan(plan);
    const cs = await this.get(id);
    if (!cs) throw new Error(`Changeset "${id}" not found`);
    if (cs.status !== "planning") {
      throw new Error(`Cannot update plan in status "${cs.status}"`);
    }

    const updated = { ...cs, plan, updatedAt: new Date().toISOString() };
    this.writeFileChangeset(updated);
    return updated;
  }

  async amendPlan(
    id: string,
    amendment: ChangesetPlanAmendment,
  ): Promise<Changeset> {
    await this.ready;
    const cs = await this.get(id);
    if (!cs) throw new Error(`Changeset "${id}" not found`);
    if (cs.status !== "in_progress") {
      throw new Error(`Cannot amend plan in status "${cs.status}"`);
    }

    const plan = amendChangesetPlan(cs.plan, amendment);
    assertValidPlan(plan);
    const updated: Changeset = {
      ...cs,
      status: "planning",
      plan,
      approvalMessageId: null,
      updatedAt: new Date().toISOString(),
    };
    this.writeFileChangeset(updated);
    return updated;
  }

  async approve(id: string, approvalMessageId?: number): Promise<Changeset> {
    await this.ready;
    const cs = await this.get(id);
    if (!cs) throw new Error(`Changeset "${id}" not found`);
    assertValidPlan(cs.plan);
    validateTransition(cs.status, "approved");

    const updated: Changeset = {
      ...cs,
      status: "approved",
      approvalMessageId: approvalMessageId ?? null,
      updatedAt: new Date().toISOString(),
    };
    this.writeFileChangeset(updated);
    return updated;
  }

  async startWork(id: string): Promise<Changeset> {
    await this.ready;
    const cs = await this.get(id);
    if (!cs) throw new Error(`Changeset "${id}" not found`);
    validateTransition(cs.status, "in_progress");

    const updated: Changeset = {
      ...cs,
      status: "in_progress",
      updatedAt: new Date().toISOString(),
    };
    this.writeFileChangeset(updated);
    return updated;
  }

  async updateStep(
    id: string,
    stepId: string,
    status: ChangesetStep["status"],
  ): Promise<Changeset> {
    await this.ready;
    const cs = await this.get(id);
    if (!cs) throw new Error(`Changeset "${id}" not found`);
    if (cs.status !== "in_progress") {
      throw new Error(`Cannot update steps in status "${cs.status}"`);
    }

    const step = cs.plan.steps.find((s) => s.id === stepId);
    if (!step) {
      throw new Error(`Step "${stepId}" not found in changeset "${id}"`);
    }

    step.status = status;
    const updated = {
      ...cs,
      plan: cs.plan,
      updatedAt: new Date().toISOString(),
    };
    this.writeFileChangeset(updated);
    return updated;
  }

  async addWorkMessageId(id: string, messageId: number): Promise<Changeset> {
    await this.ready;
    const cs = await this.get(id);
    if (!cs) throw new Error(`Changeset "${id}" not found`);
    if (cs.workMessageIds.includes(messageId)) return cs;

    if (!WORK_MESSAGE_STATUSES.includes(cs.status)) {
      throw new Error(`Changeset "${id}" status changed concurrently`);
    }
    const updated = {
      ...cs,
      workMessageIds: [...cs.workMessageIds, messageId],
      updatedAt: new Date().toISOString(),
    };
    this.writeFileChangeset(updated);
    return updated;
  }

  async addPlanMessageId(id: string, messageId: number): Promise<Changeset> {
    await this.ready;
    const cs = await this.get(id);
    if (!cs) throw new Error(`Changeset "${id}" not found`);
    if (cs.planMessageIds.includes(messageId)) return cs;

    const ids = [...cs.planMessageIds, messageId];
    const updated = {
      ...cs,
      planMessageIds: ids,
      updatedAt: new Date().toISOString(),
    };
    this.writeFileChangeset(updated);
    return updated;
  }

  async setApprovalMessageId(
    id: string,
    messageId: number,
  ): Promise<Changeset> {
    await this.ready;
    const cs = await this.get(id);
    if (!cs) throw new Error(`Changeset "${id}" not found`);

    if (!APPROVAL_MESSAGE_STATUSES.includes(cs.status)) {
      throw new Error(`Changeset "${id}" status changed concurrently`);
    }
    const updated = {
      ...cs,
      approvalMessageId: messageId,
      updatedAt: new Date().toISOString(),
    };
    this.writeFileChangeset(updated);
    return updated;
  }

  async complete(id: string): Promise<Changeset> {
    await this.ready;
    const cs = await this.get(id);
    if (!cs) throw new Error(`Changeset "${id}" not found`);
    validateTransition(cs.status, "completed");
    assertHasVerificationRun(cs);
    assertReadyToComplete(cs);

    markStepsDone(cs.plan);

    const now = new Date().toISOString();
    const updated: Changeset = {
      ...cs,
      status: "completed",
      plan: cs.plan,
      updatedAt: now,
      completedAt: now,
    };
    this.writeFileChangeset(updated);
    return updated;
  }

  async abandon(id: string): Promise<Changeset> {
    await this.ready;
    const cs = await this.get(id);
    if (!cs) throw new Error(`Changeset "${id}" not found`);
    validateTransition(cs.status, "abandoned");

    const now = new Date().toISOString();
    const updated: Changeset = {
      ...cs,
      status: "abandoned",
      updatedAt: now,
    };
    this.writeFileChangeset(updated);
    return updated;
  }

  async reject(id: string): Promise<Changeset> {
    await this.ready;
    const cs = await this.get(id);
    if (!cs) throw new Error(`Changeset "${id}" not found`);
    if (cs.status === "rejected") return cs;
    validateTransition(cs.status, "rejected");

    const now = new Date().toISOString();
    const updated: Changeset = {
      ...cs,
      status: "rejected",
      updatedAt: now,
    };
    this.writeFileChangeset(updated);
    return updated;
  }

  async completeStaleChangesets(
    sessionId: string | null,
  ): Promise<Changeset[]> {
    await this.ready;
    const stale = this.listFileChangesets().filter((cs) =>
      ACTIVE_STATUSES.includes(cs.status) && ownedBy(cs, sessionId)
    );
    const resolved: Changeset[] = [];
    const now = new Date().toISOString();
    for (const cs of stale) {
      if (cs.status === "in_progress" && canAutoComplete(cs)) {
        markStepsDone(cs.plan);
        const updated: Changeset = {
          ...cs,
          status: "completed",
          plan: cs.plan,
          updatedAt: now,
          completedAt: now,
        };
        this.writeFileChangeset(updated);
        resolved.push(updated);
      } else if (cs.status === "in_progress") {
        continue;
      } else {
        const updated: Changeset = {
          ...cs,
          status: "abandoned",
          updatedAt: now,
        };
        this.writeFileChangeset(updated);
        resolved.push(updated);
      }
    }
    return resolved;
  }

  async getActive(sessionId?: string): Promise<Changeset | null> {
    await this.ready;
    return this.listFileChangesets()
      .filter((cs) => ACTIVE_STATUSES.includes(cs.status))
      .filter((cs) => !sessionId || cs.sessionId === sessionId)
      .toSorted((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null;
  }

  private async activeElsewhere(
    sessionId: string | null,
  ): Promise<Changeset | null> {
    await this.ready;
    return this.listFileChangesets()
      .filter((cs) =>
        ACTIVE_STATUSES.includes(cs.status) && !ownedBy(cs, sessionId)
      )
      .toSorted((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null;
  }

  async patch(
    id: string,
    fields: { title?: string; description?: string },
  ): Promise<Changeset | null> {
    await this.ready;
    const cs = await this.get(id);
    if (!cs) return null;

    const updated = {
      ...cs,
      title: fields.title ?? cs.title,
      description: fields.description ?? cs.description,
      updatedAt: new Date().toISOString(),
    };
    this.writeFileChangeset(updated);
    return updated;
  }

  async reassignSession(
    id: string,
    sessionId: string,
  ): Promise<Changeset | null> {
    await this.ready;
    const cs = await this.get(id);
    if (!cs) return null;
    const updated = { ...cs, sessionId, updatedAt: new Date().toISOString() };
    this.writeFileChangeset(updated);
    return updated;
  }

  async aggregate(
    id: string,
    sessions: ChangesetUsageSource,
    changelog: ChangesetChangelogSource,
  ): Promise<Changeset> {
    await this.ready;
    const cs = await this.get(id);
    if (!cs) throw new Error(`Changeset "${id}" not found`);

    const tokenUsage = await computeTokenUsage(id, sessions, changelog);

    const updated = {
      ...cs,
      tokenUsage,
      updatedAt: new Date().toISOString(),
    };
    this.writeFileChangeset(updated);
    return updated;
  }

  async recordVerificationRun(
    id: string,
    run: Omit<VerificationRun, "id" | "createdAt" | "completedAt"> & {
      id?: string;
      createdAt?: string;
      completedAt?: string;
    },
  ): Promise<Changeset> {
    await this.ready;
    const cs = await this.get(id);
    if (!cs) throw new Error(`Changeset "${id}" not found`);
    const updated = appendVerificationRun(cs, run);
    this.writeFileChangeset(updated);
    return updated;
  }

  async recordAttestation(
    id: string,
    att: AttestationInput,
  ): Promise<Changeset> {
    await this.ready;
    const cs = await this.get(id);
    if (!cs) throw new Error(`Changeset "${id}" not found`);
    const attestation = mintAttestation(att);
    const updated = attachAttestation(cs, attestation);
    this.writeFileChangeset(updated);
    await this.recordLedgerEntry(toLedgerEntry(updated, attestation));
    return updated;
  }

  async recordChangeClass(
    id: string,
    changeClass: ChangeClass,
  ): Promise<Changeset> {
    await this.ready;
    const cs = await this.get(id);
    if (!cs) throw new Error(`Changeset "${id}" not found`);
    const updated = {
      ...cs,
      plan: { ...cs.plan, changeClass },
      updatedAt: new Date().toISOString(),
    };
    this.writeFileChangeset(updated);
    return updated;
  }

  async recordIndependentCriteria(
    id: string,
    criteria: ProposedCriterion[],
  ): Promise<Changeset> {
    await this.ready;
    const cs = await this.get(id);
    if (!cs) throw new Error(`Changeset "${id}" not found`);
    const updated = {
      ...cs,
      plan: { ...cs.plan, independentCriteria: criteria },
      updatedAt: new Date().toISOString(),
    };
    this.writeFileChangeset(updated);
    return updated;
  }

  private ledgerPath(): string {
    return join(this.historyDir, VERIFICATION_LEDGER_FILE);
  }

  private readLedger(): LedgerEntry[] {
    return readJsonFile<LedgerEntry[]>(this.ledgerPath()) ?? [];
  }

  // Upsert-by-id keeps dual-write and backfill idempotent (attestations are
  // immutable, so a re-seen id is a no-op replace).
  async recordLedgerEntry(entry: LedgerEntry): Promise<void> {
    const entries = this.readLedger();
    const idx = entries.findIndex((e) => e.id === entry.id);
    if (idx >= 0) entries[idx] = entry;
    else entries.push(entry);
    writeJsonIfChanged(this.ledgerPath(), entries);
  }

  async listLedger(query?: LedgerQuery): Promise<LedgerEntry[]> {
    return queryLedgerEntries(this.readLedger(), query);
  }

  async pruneLedger(keep: number): Promise<number> {
    if (keep <= 0) return 0;
    const entries = queryLedgerEntries(this.readLedger()); // newest first
    if (entries.length <= keep) return 0;
    writeJsonIfChanged(this.ledgerPath(), entries.slice(0, keep));
    return entries.length - keep;
  }

  async patchFormalSpec(
    id: string,
    specId: string,
    patch: FormalSpecPatch,
  ): Promise<Changeset> {
    await this.ready;
    const cs = await this.get(id);
    if (!cs) throw new Error(`Changeset "${id}" not found`);
    if (!ACTIVE_STATUSES.includes(cs.status)) {
      throw new Error(`Cannot edit formal specs in status "${cs.status}"`);
    }
    const plan = applyFormalSpecPatch(cs.plan, specId, patch);
    const updated = { ...cs, plan, updatedAt: new Date().toISOString() };
    this.writeFileChangeset(updated);
    return updated;
  }

  async deleteBySession(sessionId: string): Promise<string[]> {
    await this.ready;
    const ids = this.listFileChangesets()
      .filter((cs) => cs.sessionId === sessionId)
      .map((cs) => cs.id);
    for (const id of ids) {
      rmSync(this.changesetPath(id), { force: true });
    }
    return ids;
  }
}

// --- DB-backed storage ---

class DbChangesetStore implements ChangesetStore {
  private db: DrizzleDb;
  private ready: Promise<void> | null = null;

  constructor(db: DrizzleDb) {
    this.db = db;
  }

  private ensureReady(): Promise<void> {
    this.ready ??= this.ensureAuthColumns();
    return this.ready;
  }

  private async ensureAuthColumns(): Promise<void> {
    await this.db.execute(
      sql`ALTER TABLE "_genie_changesets" ADD COLUMN IF NOT EXISTS "creator_user_id" text`,
    );
  }

  async create(opts: {
    sessionId?: string;
    title: string;
    description?: string;
    plan: ChangesetPlan;
    planMessageIds?: number[];
    creatorUserId?: string | null;
  }): Promise<Changeset> {
    await this.ensureReady();
    assertValidPlan(opts.plan);
    const id = createTimestampedId("cs");

    const sessionId = opts.sessionId ?? null;
    await this.completeStaleChangesets(sessionId);
    const holder = await this.activeElsewhere(sessionId);
    if (holder) throw new ChangesetActiveError(holder);
    const existing = await this.db
      .select({ createdAt: genieChangesetsTable.createdAt })
      .from(genieChangesetsTable);
    const now = nextCreatedAt(existing);

    const rows = await this.db
      .insert(genieChangesetsTable)
      .values({
        id,
        sessionId: opts.sessionId ?? null,
        title: opts.title,
        description: opts.description ?? null,
        status: "planning",
        plan: opts.plan,
        planMessageIds: opts.planMessageIds ?? null,
        createdAt: now,
        updatedAt: now,
        creatorUserId: opts.creatorUserId ?? localUser().id,
      })
      .returning();
    return rowToChangeset(rows[0]!);
  }

  async get(id: string): Promise<Changeset | null> {
    await this.ensureReady();
    const rows = await this.db
      .select()
      .from(genieChangesetsTable)
      .where(eq(genieChangesetsTable.id, id))
      .limit(1);
    return rows[0] ? rowToChangeset(rows[0]) : null;
  }

  async list(
    opts?: { sessionId?: string; status?: ChangesetStatus; limit?: number },
  ): Promise<Changeset[]> {
    const rows = await this.db
      .select()
      .from(genieChangesetsTable)
      .where(and(
        opts?.sessionId
          ? eq(genieChangesetsTable.sessionId, opts.sessionId)
          : undefined,
        opts?.status ? eq(genieChangesetsTable.status, opts.status) : undefined,
      ))
      .orderBy(desc(genieChangesetsTable.createdAt))
      .limit(opts?.limit ?? 100);
    return rows.map(rowToChangeset);
  }

  async updatePlan(id: string, plan: ChangesetPlan): Promise<Changeset> {
    assertValidPlan(plan);
    const cs = await this.get(id);
    if (!cs) throw new Error(`Changeset "${id}" not found`);
    if (cs.status !== "planning") {
      throw new Error(`Cannot update plan in status "${cs.status}"`);
    }

    const rows = await this.db
      .update(genieChangesetsTable)
      .set({ plan, updatedAt: new Date().toISOString() })
      .where(eq(genieChangesetsTable.id, id))
      .returning();
    return rowToChangeset(rows[0]!);
  }

  async amendPlan(
    id: string,
    amendment: ChangesetPlanAmendment,
  ): Promise<Changeset> {
    const cs = await this.get(id);
    if (!cs) throw new Error(`Changeset "${id}" not found`);
    if (cs.status !== "in_progress") {
      throw new Error(`Cannot amend plan in status "${cs.status}"`);
    }

    const plan = amendChangesetPlan(cs.plan, amendment);
    assertValidPlan(plan);
    const rows = await this.db
      .update(genieChangesetsTable)
      .set({
        status: "planning",
        plan,
        approvalMessageId: null,
        updatedAt: new Date().toISOString(),
      })
      .where(
        and(
          eq(genieChangesetsTable.id, id),
          eq(genieChangesetsTable.status, "in_progress"),
        ),
      )
      .returning();
    if (rows.length === 0) {
      throw new Error(`Changeset "${id}" status changed concurrently`);
    }
    return rowToChangeset(rows[0]!);
  }

  async approve(id: string, approvalMessageId?: number): Promise<Changeset> {
    const cs = await this.get(id);
    if (!cs) throw new Error(`Changeset "${id}" not found`);
    assertValidPlan(cs.plan);
    validateTransition(cs.status, "approved");

    const rows = await this.db
      .update(genieChangesetsTable)
      .set({
        status: "approved",
        approvalMessageId: approvalMessageId ?? null,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(genieChangesetsTable.id, id))
      .returning();
    return rowToChangeset(rows[0]!);
  }

  async startWork(id: string): Promise<Changeset> {
    const cs = await this.get(id);
    if (!cs) throw new Error(`Changeset "${id}" not found`);
    validateTransition(cs.status, "in_progress");

    const rows = await this.db
      .update(genieChangesetsTable)
      .set({ status: "in_progress", updatedAt: new Date().toISOString() })
      .where(eq(genieChangesetsTable.id, id))
      .returning();
    return rowToChangeset(rows[0]!);
  }

  async updateStep(
    id: string,
    stepId: string,
    status: ChangesetStep["status"],
  ): Promise<Changeset> {
    const cs = await this.get(id);
    if (!cs) throw new Error(`Changeset "${id}" not found`);
    if (cs.status !== "in_progress") {
      throw new Error(`Cannot update steps in status "${cs.status}"`);
    }

    const step = cs.plan.steps.find((s) => s.id === stepId);
    if (!step) {
      throw new Error(`Step "${stepId}" not found in changeset "${id}"`);
    }

    step.status = status;
    const rows = await this.db
      .update(genieChangesetsTable)
      .set({ plan: cs.plan, updatedAt: new Date().toISOString() })
      .where(
        and(
          eq(genieChangesetsTable.id, id),
          eq(genieChangesetsTable.status, "in_progress"),
        ),
      )
      .returning();
    if (rows.length === 0) {
      throw new Error(`Changeset "${id}" status changed concurrently`);
    }
    return rowToChangeset(rows[0]!);
  }

  async addWorkMessageId(id: string, messageId: number): Promise<Changeset> {
    const cs = await this.get(id);
    if (!cs) throw new Error(`Changeset "${id}" not found`);
    if (cs.workMessageIds.includes(messageId)) return cs;

    const ids = [...cs.workMessageIds, messageId];
    const rows = await this.db
      .update(genieChangesetsTable)
      .set({ workMessageIds: ids, updatedAt: new Date().toISOString() })
      .where(
        and(
          eq(genieChangesetsTable.id, id),
          inArray(genieChangesetsTable.status, WORK_MESSAGE_STATUSES),
        ),
      )
      .returning();
    if (rows.length === 0) {
      throw new Error(`Changeset "${id}" status changed concurrently`);
    }
    return rowToChangeset(rows[0]!);
  }

  async addPlanMessageId(id: string, messageId: number): Promise<Changeset> {
    const cs = await this.get(id);
    if (!cs) throw new Error(`Changeset "${id}" not found`);
    if (cs.planMessageIds.includes(messageId)) return cs;

    const ids = [...cs.planMessageIds, messageId];
    const rows = await this.db
      .update(genieChangesetsTable)
      .set({ planMessageIds: ids, updatedAt: new Date().toISOString() })
      .where(eq(genieChangesetsTable.id, id))
      .returning();
    return rowToChangeset(rows[0]!);
  }

  async setApprovalMessageId(
    id: string,
    messageId: number,
  ): Promise<Changeset> {
    const cs = await this.get(id);
    if (!cs) throw new Error(`Changeset "${id}" not found`);

    const rows = await this.db
      .update(genieChangesetsTable)
      .set({
        approvalMessageId: messageId,
        updatedAt: new Date().toISOString(),
      })
      .where(
        and(
          eq(genieChangesetsTable.id, id),
          inArray(genieChangesetsTable.status, APPROVAL_MESSAGE_STATUSES),
        ),
      )
      .returning();
    if (rows.length === 0) {
      throw new Error(`Changeset "${id}" status changed concurrently`);
    }
    return rowToChangeset(rows[0]!);
  }

  async complete(id: string): Promise<Changeset> {
    const cs = await this.get(id);
    if (!cs) throw new Error(`Changeset "${id}" not found`);
    validateTransition(cs.status, "completed");
    assertHasVerificationRun(cs);
    assertReadyToComplete(cs);

    markStepsDone(cs.plan);

    const now = new Date().toISOString();
    const rows = await this.db
      .update(genieChangesetsTable)
      .set({
        status: "completed",
        plan: cs.plan,
        updatedAt: now,
        completedAt: now,
      })
      .where(eq(genieChangesetsTable.id, id))
      .returning();
    return rowToChangeset(rows[0]!);
  }

  async abandon(id: string): Promise<Changeset> {
    const cs = await this.get(id);
    if (!cs) throw new Error(`Changeset "${id}" not found`);
    validateTransition(cs.status, "abandoned");

    const now = new Date().toISOString();
    const rows = await this.db
      .update(genieChangesetsTable)
      .set({ status: "abandoned", updatedAt: now })
      .where(eq(genieChangesetsTable.id, id))
      .returning();
    return rowToChangeset(rows[0]!);
  }

  async reject(id: string): Promise<Changeset> {
    const cs = await this.get(id);
    if (!cs) throw new Error(`Changeset "${id}" not found`);
    if (cs.status === "rejected") return cs;
    validateTransition(cs.status, "rejected");

    const now = new Date().toISOString();
    const rows = await this.db
      .update(genieChangesetsTable)
      .set({ status: "rejected", updatedAt: now })
      .where(eq(genieChangesetsTable.id, id))
      .returning();
    return rowToChangeset(rows[0]!);
  }

  async completeStaleChangesets(
    sessionId: string | null,
  ): Promise<Changeset[]> {
    const stale = await this.db
      .select()
      .from(genieChangesetsTable)
      .where(and(
        inArray(genieChangesetsTable.status, ACTIVE_STATUSES),
        sessionIs(sessionId),
      ));

    const resolved: Changeset[] = [];
    const now = new Date().toISOString();
    for (const row of stale) {
      const cs = rowToChangeset(row);
      if (cs.status === "in_progress" && canAutoComplete(cs)) {
        markStepsDone(cs.plan);
        const rows = await this.db
          .update(genieChangesetsTable)
          .set({
            status: "completed",
            plan: cs.plan,
            updatedAt: now,
            completedAt: now,
          })
          .where(eq(genieChangesetsTable.id, cs.id))
          .returning();
        resolved.push(rowToChangeset(rows[0]!));
      } else if (cs.status === "in_progress") {
        continue;
      } else {
        const rows = await this.db
          .update(genieChangesetsTable)
          .set({ status: "abandoned", updatedAt: now })
          .where(eq(genieChangesetsTable.id, cs.id))
          .returning();
        resolved.push(rowToChangeset(rows[0]!));
      }
    }
    return resolved;
  }

  async getActive(sessionId?: string): Promise<Changeset | null> {
    const rows = await this.db
      .select()
      .from(genieChangesetsTable)
      .where(and(
        inArray(genieChangesetsTable.status, ACTIVE_STATUSES),
        sessionId ? eq(genieChangesetsTable.sessionId, sessionId) : undefined,
      ))
      .orderBy(desc(genieChangesetsTable.createdAt))
      .limit(1);
    return rows[0] ? rowToChangeset(rows[0]) : null;
  }

  private async activeElsewhere(
    sessionId: string | null,
  ): Promise<Changeset | null> {
    const rows = await this.db
      .select()
      .from(genieChangesetsTable)
      .where(and(
        inArray(genieChangesetsTable.status, ACTIVE_STATUSES),
        sessionIsNot(sessionId),
      ))
      .orderBy(desc(genieChangesetsTable.createdAt))
      .limit(1);
    return rows[0] ? rowToChangeset(rows[0]) : null;
  }

  async patch(
    id: string,
    fields: { title?: string; description?: string },
  ): Promise<Changeset | null> {
    const cs = await this.get(id);
    if (!cs) return null;

    const rows = await this.db
      .update(genieChangesetsTable)
      .set({
        title: fields.title ?? cs.title,
        description: fields.description ?? cs.description,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(genieChangesetsTable.id, id))
      .returning();
    return rowToChangeset(rows[0]!);
  }

  async reassignSession(
    id: string,
    sessionId: string,
  ): Promise<Changeset | null> {
    const rows = await this.db
      .update(genieChangesetsTable)
      .set({ sessionId, updatedAt: new Date().toISOString() })
      .where(eq(genieChangesetsTable.id, id))
      .returning();
    return rows[0] ? rowToChangeset(rows[0]) : null;
  }

  async aggregate(
    id: string,
    sessions: ChangesetUsageSource,
    changelog: ChangesetChangelogSource,
  ): Promise<Changeset> {
    const cs = await this.get(id);
    if (!cs) throw new Error(`Changeset "${id}" not found`);

    const tokenUsage = await computeTokenUsage(id, sessions, changelog);

    const rows = await this.db
      .update(genieChangesetsTable)
      .set({ tokenUsage, updatedAt: new Date().toISOString() })
      .where(eq(genieChangesetsTable.id, id))
      .returning();
    return rowToChangeset(rows[0]!);
  }

  async recordVerificationRun(
    id: string,
    run: Omit<VerificationRun, "id" | "createdAt" | "completedAt"> & {
      id?: string;
      createdAt?: string;
      completedAt?: string;
    },
  ): Promise<Changeset> {
    const cs = await this.get(id);
    if (!cs) throw new Error(`Changeset "${id}" not found`);
    const updated = appendVerificationRun(cs, run);
    const rows = await this.db
      .update(genieChangesetsTable)
      .set({ plan: updated.plan, updatedAt: updated.updatedAt })
      .where(eq(genieChangesetsTable.id, id))
      .returning();
    return rowToChangeset(rows[0]!);
  }

  async recordAttestation(
    id: string,
    att: AttestationInput,
  ): Promise<Changeset> {
    const cs = await this.get(id);
    if (!cs) throw new Error(`Changeset "${id}" not found`);
    const attestation = mintAttestation(att);
    const updated = attachAttestation(cs, attestation);
    const rows = await this.db
      .update(genieChangesetsTable)
      .set({ plan: updated.plan, updatedAt: updated.updatedAt })
      .where(eq(genieChangesetsTable.id, id))
      .returning();
    await this.recordLedgerEntry(toLedgerEntry(updated, attestation));
    return rowToChangeset(rows[0]!);
  }

  async recordChangeClass(
    id: string,
    changeClass: ChangeClass,
  ): Promise<Changeset> {
    const cs = await this.get(id);
    if (!cs) throw new Error(`Changeset "${id}" not found`);
    const plan: ChangesetPlan = { ...cs.plan, changeClass };
    const rows = await this.db
      .update(genieChangesetsTable)
      .set({ plan, updatedAt: new Date().toISOString() })
      .where(eq(genieChangesetsTable.id, id))
      .returning();
    return rowToChangeset(rows[0]!);
  }

  async recordIndependentCriteria(
    id: string,
    criteria: ProposedCriterion[],
  ): Promise<Changeset> {
    const cs = await this.get(id);
    if (!cs) throw new Error(`Changeset "${id}" not found`);
    const plan: ChangesetPlan = { ...cs.plan, independentCriteria: criteria };
    const rows = await this.db
      .update(genieChangesetsTable)
      .set({ plan, updatedAt: new Date().toISOString() })
      .where(eq(genieChangesetsTable.id, id))
      .returning();
    return rowToChangeset(rows[0]!);
  }

  // Immutable append-only rows keyed by the attestation id, so a re-seen id
  // (dual-write racing backfill, or a re-run backfill) is a safe no-op.
  async recordLedgerEntry(entry: LedgerEntry): Promise<void> {
    await this.ensureReady();
    await this.db
      .insert(genieVerificationLedgerTable)
      .values({
        id: entry.id,
        changesetId: entry.changesetId,
        changesetTitle: entry.changesetTitle,
        kind: entry.kind,
        status: entry.status,
        fingerprint: entry.fingerprint,
        scope: entry.scope,
        checkId: entry.checkId ?? null,
        summary: entry.summary,
        toolCallId: entry.toolCallId ?? null,
        turnId: entry.turnId ?? null,
        principalId: entry.principalId ?? null,
        producer: entry.producer ?? null,
        reviewer: entry.reviewer ?? null,
        createdAt: entry.createdAt,
      })
      .onConflictDoNothing();
  }

  async listLedger(query?: LedgerQuery): Promise<LedgerEntry[]> {
    await this.ensureReady();
    let q = this.db
      .select()
      .from(genieVerificationLedgerTable)
      .where(and(
        query?.scope
          ? eq(genieVerificationLedgerTable.scope, query.scope)
          : undefined,
        query?.kind
          ? eq(genieVerificationLedgerTable.kind, query.kind)
          : undefined,
        query?.since
          ? gte(genieVerificationLedgerTable.createdAt, query.since)
          : undefined,
      ))
      .orderBy(
        desc(genieVerificationLedgerTable.createdAt),
        desc(genieVerificationLedgerTable.id),
      )
      .$dynamic();
    if (query?.limit !== undefined) q = q.limit(query.limit);
    if (query?.offset) q = q.offset(query.offset);
    const rows = await q;
    return rows.map(rowToLedgerEntry);
  }

  async pruneLedger(keep: number): Promise<number> {
    await this.ensureReady();
    if (keep <= 0) return 0;
    const keepers = await this.db
      .select({ id: genieVerificationLedgerTable.id })
      .from(genieVerificationLedgerTable)
      .orderBy(
        desc(genieVerificationLedgerTable.createdAt),
        desc(genieVerificationLedgerTable.id),
      )
      .limit(keep);
    const keepIds = keepers.map((r) => r.id);
    if (keepIds.length === 0) return 0;
    const deleted = await this.db
      .delete(genieVerificationLedgerTable)
      .where(notInArray(genieVerificationLedgerTable.id, keepIds))
      .returning();
    return deleted.length;
  }

  async patchFormalSpec(
    id: string,
    specId: string,
    patch: FormalSpecPatch,
  ): Promise<Changeset> {
    const cs = await this.get(id);
    if (!cs) throw new Error(`Changeset "${id}" not found`);
    if (!ACTIVE_STATUSES.includes(cs.status)) {
      throw new Error(`Cannot edit formal specs in status "${cs.status}"`);
    }
    const plan = applyFormalSpecPatch(cs.plan, specId, patch);
    const now = new Date().toISOString();
    const rows = await this.db
      .update(genieChangesetsTable)
      .set({ plan, updatedAt: now })
      .where(
        and(
          eq(genieChangesetsTable.id, id),
          inArray(genieChangesetsTable.status, ACTIVE_STATUSES),
        ),
      )
      .returning();
    if (rows.length === 0) {
      throw new Error(`Changeset "${id}" status changed concurrently`);
    }
    return rowToChangeset(rows[0]!);
  }

  async deleteBySession(sessionId: string): Promise<string[]> {
    const rows = await this.db
      .select({ id: genieChangesetsTable.id })
      .from(genieChangesetsTable)
      .where(eq(genieChangesetsTable.sessionId, sessionId));
    const ids = rows.map((r) => r.id);
    if (ids.length > 0) {
      await this.db.delete(genieChangesetsTable).where(
        inArray(genieChangesetsTable.id, ids),
      );
    }
    return ids;
  }
}

// --- Facade ---

export class ChangesetManager implements ChangesetStore {
  private store: ChangesetStore;
  // Creates run one at a time, so two sessions can't both pass the
  // one-writer check before either has written its changeset.
  private creating: Promise<unknown> = Promise.resolve();

  constructor(storage: DrizzleDb | string) {
    this.store = typeof storage === "string"
      ? new FileChangesetStore(storage)
      : new DbChangesetStore(storage);
  }

  create(opts: {
    sessionId?: string;
    title: string;
    description?: string;
    plan: ChangesetPlan;
    planMessageIds?: number[];
    creatorUserId?: string | null;
  }): Promise<Changeset> {
    const created = this.creating.then(() =>
      this.store.create({
        ...opts,
        creatorUserId: opts.creatorUserId ?? localUser().id,
      })
    );
    this.creating = created.catch(() => {});
    return created;
  }

  get(id: string): Promise<Changeset | null> {
    return this.store.get(id);
  }

  list(
    opts?: { sessionId?: string; status?: ChangesetStatus; limit?: number },
  ): Promise<Changeset[]> {
    return this.store.list(opts);
  }

  updatePlan(id: string, plan: ChangesetPlan): Promise<Changeset> {
    return this.store.updatePlan(id, plan);
  }

  amendPlan(
    id: string,
    amendment: ChangesetPlanAmendment,
  ): Promise<Changeset> {
    return this.store.amendPlan(id, amendment);
  }

  approve(id: string, approvalMessageId?: number): Promise<Changeset> {
    return this.store.approve(id, approvalMessageId);
  }

  startWork(id: string): Promise<Changeset> {
    return this.store.startWork(id);
  }

  updateStep(
    id: string,
    stepId: string,
    status: ChangesetStep["status"],
  ): Promise<Changeset> {
    return this.store.updateStep(id, stepId, status);
  }

  addWorkMessageId(id: string, messageId: number): Promise<Changeset> {
    return this.store.addWorkMessageId(id, messageId);
  }

  addPlanMessageId(id: string, messageId: number): Promise<Changeset> {
    return this.store.addPlanMessageId(id, messageId);
  }

  setApprovalMessageId(id: string, messageId: number): Promise<Changeset> {
    return this.store.setApprovalMessageId(id, messageId);
  }

  complete(id: string): Promise<Changeset> {
    return this.store.complete(id);
  }

  abandon(id: string): Promise<Changeset> {
    return this.store.abandon(id);
  }

  reject(id: string): Promise<Changeset> {
    return this.store.reject(id);
  }

  completeStaleChangesets(sessionId: string | null): Promise<Changeset[]> {
    return this.store.completeStaleChangesets(sessionId);
  }

  getActive(sessionId?: string): Promise<Changeset | null> {
    return this.store.getActive(sessionId);
  }

  patch(
    id: string,
    fields: { title?: string; description?: string },
  ): Promise<Changeset | null> {
    return this.store.patch(id, fields);
  }

  reassignSession(id: string, sessionId: string): Promise<Changeset | null> {
    return this.store.reassignSession(id, sessionId);
  }

  aggregate(
    id: string,
    sessions: ChangesetUsageSource,
    changelog: ChangesetChangelogSource,
  ): Promise<Changeset> {
    return this.store.aggregate(id, sessions, changelog);
  }

  recordVerificationRun(
    id: string,
    run: Omit<VerificationRun, "id" | "createdAt" | "completedAt"> & {
      id?: string;
      createdAt?: string;
      completedAt?: string;
    },
  ): Promise<Changeset> {
    return this.store.recordVerificationRun(id, run);
  }

  recordAttestation(id: string, att: AttestationInput): Promise<Changeset> {
    return this.store.recordAttestation(id, att);
  }

  recordChangeClass(
    id: string,
    changeClass: ChangeClass,
  ): Promise<Changeset> {
    return this.store.recordChangeClass(id, changeClass);
  }

  recordIndependentCriteria(
    id: string,
    criteria: ProposedCriterion[],
  ): Promise<Changeset> {
    return this.store.recordIndependentCriteria(id, criteria);
  }

  recordLedgerEntry(entry: LedgerEntry): Promise<void> {
    return this.store.recordLedgerEntry(entry);
  }

  listLedger(query?: LedgerQuery): Promise<LedgerEntry[]> {
    return this.store.listLedger(query);
  }

  pruneLedger(keep: number): Promise<number> {
    return this.store.pruneLedger(keep);
  }

  patchFormalSpec(
    id: string,
    specId: string,
    patch: FormalSpecPatch,
  ): Promise<Changeset> {
    return this.store.patchFormalSpec(id, specId, patch);
  }

  deleteBySession(sessionId: string): Promise<string[]> {
    return this.store.deleteBySession(sessionId);
  }
}
