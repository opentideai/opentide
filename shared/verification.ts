// @layer shared — L0, the OpenTide *open* wire contract for the verification /
// changeset surface: the deterministic "shows its work" mechanism. Type-only;
// imports NOTHING (self-contained; nothing sits below L0). Consumed by the Deno
// backend (re-exported from core/types.ts, which changesets.ts re-exports in
// turn) and the IDE (`$shared` alias). This is OPEN per D9 — the verification
// mechanism is the adoption wedge; only the model-backed *intelligence* that
// produces good verdicts (agent/) stays closed. See docs/open-core-strategy.md.

export type ChangesetStatus =
  | "planning"
  | "approved"
  | "in_progress"
  | "completed"
  | "abandoned"
  | "rejected";

export interface ChangesetStep {
  id: string;
  description: string;
  status: "pending" | "in_progress" | "done" | "skipped";
}

export type VerificationClaimSource = "user" | "agent" | "inferred";
export type VerificationClaimPriority = "must" | "should" | "nice";
export type VerificationCheckKind =
  | "unit"
  | "integration"
  | "e2e"
  | "screenshot"
  | "typecheck"
  | "coverage"
  | "audit"
  | "adversarial"
  | "manual"
  | "invariant"
  // The kernel's record of exactly which entities a changeset changed. Grounded
  // and deterministic (built from the changelog, not asserted by the agent), and
  // the honest planned check for the light lane: for a small change the proof
  // that matters is the diff, not a manufactured test.
  | "manifest";
export type VerificationStatus = "passed" | "failed" | "partial" | "manual";

// --- Formal specs (Tier-1 autoformalization) ---
// A FormalSpec turns an acceptance criterion into a type-level invariant the
// compiler can enforce. Each technique corresponds to one of the paper's four
// TypeScript targets; verification is discharged by `checkExportTypes`
// (deno check) plus a static marker check, and recorded as "invariant" evidence.
export type FormalSpecTechnique =
  | "exhaustive-switch" // assertNever in the default case of a union switch
  | "satisfies-guard" // M satisfies Record<K, V> for total key coverage
  | "discriminated-union" // switch over a string discriminant with assertNever default
  | "union-alias" // named union of string literals to prevent drift
  | "numeric-range" // clamp/bounds guard so out-of-range numbers can't flow through
  | "exhaustive-record" // satisfies Record<NamedUnion, V> — total coverage over a named key union
  | "branded-type"; // nominal brand + constructor so a raw value can't stand in
export type FormalSpecEnforcement = "hard" | "soft";

export interface FormalSpec {
  id: string;
  claimIds: string[];
  technique: FormalSpecTechnique;
  scope: string; // target entity, e.g. "handler:processOrder"
  discriminant?: string; // for discriminated-union, e.g. "action.type"
  statement: string; // human-readable invariant
  enforcement: FormalSpecEnforcement; // hard blocks completion; soft warns
}

export interface VerificationClaim {
  id: string;
  text: string;
  source: VerificationClaimSource;
  priority: VerificationClaimPriority;
}

// --- Independent criteria ---
// What a reviewer that never saw the agent's plan says the change had to do.
// The adversarial refuter attacks the claims the agent wrote; nothing else asks
// whether those were the right claims, which is the gap this fills. Proposals
// are KERNEL-ONLY on the plan (like attestations): they are written by the gate
// from a model call, never copied from agent-supplied plan input, because a
// proposal the agent could author would be worth exactly nothing.
export interface ProposedCriterion {
  id: string;
  text: string;
  priority: VerificationClaimPriority;
  // Why the reviewer thinks this had to hold — shown beside the finding so a
  // human can dismiss a bad proposal without re-reading the diff.
  rationale: string;
  // The acceptance-criterion id judged to already cover this proposal, when one
  // does. Absent means uncovered, which is what raises the readiness finding.
  coveredBy?: string;
}

export interface VerificationCheck {
  id: string;
  claimIds: string[];
  kind: VerificationCheckKind;
  description: string;
}

export interface VerificationEvidence {
  id: string;
  kind: VerificationCheckKind | "test_result" | "note";
  summary: string;
  status: VerificationStatus;
  checkId?: string; // id of the planned check or formal spec this evidence discharges
  attestationId?: string; // id of the kernel-minted Attestation backing this evidence
  artifactPath?: string;
  data?: unknown;
  createdAt: string;
}

// --- Attestations (provenance + freshness) ---
// An Attestation is proof MINTED BY THE KERNEL when a grounded verifier
// (tests, export type check, formal-spec check, coverage, audit) actually runs.
// It is never populated from agent-supplied tool input — that is what makes it
// tamper-proof. Each records the source `fingerprint` it was produced against,
// so a later code edit makes it "stale" and it stops counting toward hard gates.
export type AttestationKind =
  | "typecheck"
  | "test"
  | "invariant"
  | "coverage"
  | "audit"
  | "adversarial" // survived (or was refuted by) an adversarial refutation pass
  // An independently-prompted reviewer read the request and the diff and said
  // what the change had to do. Status is "passed" when every proposal it made is
  // already covered by an acceptance criterion, "partial" when some are not. It
  // is never "failed": an uncovered proposal is a gap to adjudicate, not a
  // verdict that the work is wrong.
  | "criteria"
  | "change_manifest" // the exact set of entities a changeset changed, per the changelog
  // --- Production-build kinds (Slice 5.4) ---
  // Minted by the production-build endpoint from a passing build's gate outcomes.
  // Unlike the kinds above they carry the "production" scope, are point-in-time
  // build history (no freshness resolver), and are recorded only on an ok build.
  | "production_export" // manifest + determinism + type check + app smoke all passed
  | "route_smoke" // exported app booted and served routes over real HTTP
  | "target_parity" // cross-target route parity verified
  | "binary_smoke" // compiled binary booted and served routes over real HTTP
  | "artifact_hash" // release-candidate tarball produced and hashed
  // --- Lock-refresh kind (Slice 7.4) ---
  // Minted by the lock-refresh producer, one per REFRESHED target. Also
  // "production"-scoped and point-in-time (no freshness resolver). The refresh
  // proves each produced lock offline-valid before committing it, so this attests
  // a genuine grounded-verifier result — its `fingerprint` is the SHA-256 of the
  // committed lock bytes (deno.lock / package-lock.json), not the source snapshot.
  | "lock_refresh"; // committed dependency lock (re)generated and validated offline-valid

export interface Attestation {
  id: string;
  kind: AttestationKind;
  status: VerificationStatus; // computed by the verifier, not the agent
  fingerprint: string; // hash of the exact source this attestation asserts
  scope: string; // "project", "handler:<name>", or "function:<name>"
  checkId?: string; // for invariant kind: the FormalSpec id it discharges
  summary: string;
  toolCallId?: string; // provenance: the tool call that produced it
  turnId?: string;
  principalId?: string; // the MCP client whose call minted it (ChangeContext)
  createdAt: string;
}

// Attestation as supplied to recordAttestation — id/createdAt are assigned by
// the store if omitted.
export type AttestationInput =
  & Omit<Attestation, "id" | "createdAt">
  & { id?: string; createdAt?: string };

// --- Verification ledger (Phase 5A) ---
// A denormalized attestation row: the attestation plus the changeset it was
// minted in. The authoritative copy stays in `plan.attestations`; the ledger
// mirrors it into a queryable index with no 100-changeset aggregation cap.
export interface LedgerEntry extends Attestation {
  changesetId: string;
  changesetTitle: string;
}

// Filters for the ledger. `since` is an inclusive ISO lower bound on createdAt.
// Omitting `limit` returns the full (uncapped) history — that is the point of
// the table.
export interface LedgerQuery {
  scope?: string;
  kind?: AttestationKind;
  since?: string;
  limit?: number;
  offset?: number;
}

export interface VerificationClaimResult {
  claimId: string;
  status: VerificationStatus;
  evidenceIds: string[];
  note?: string;
}

export interface VerificationRun {
  id: string;
  status: VerificationStatus;
  summary: string;
  evidence: VerificationEvidence[];
  claimResults: VerificationClaimResult[];
  residualRisks: string[];
  createdAt: string;
  completedAt: string;
}

// --- Proportional verification (change class) ---
// How much governance ceremony a changeset must pay. `standard` is the full gate
// (today's only behavior). `light` is the reduced lane for small, low-blast-radius
// work: the kernel synthesizes the acceptance criterion and planned check, skips
// the adversarial pass, and (when enabled) approves without a human round-trip —
// in exchange for NARROWING what the changeset may touch. Ceremony drops because
// capability drops, not because the agent is trusted more.
//
// A named union rather than a boolean so an upward tier stays additive.
export type VerificationTier = "light" | "standard";

// The tier as declared by the agent and as adjudicated by the kernel. `declared`
// is agent-supplied input; `effective` is computed from the changeset's actual
// ChangeRecords and is NEVER read from tool input — the same provenance rule that
// protects `attestations`. When work exceeds the declared tier's budget the kernel
// escalates: `effective` rises, `escalated` is set, and `reason` says why.
export interface ChangeClass {
  declared: VerificationTier;
  effective: VerificationTier;
  escalated: boolean;
  reason: string;
  // Set by the loop when the light lane skipped the human approval round-trip.
  // Distinct from `approvalMessageId`, which stays null — a kernel auto-approval
  // is never recorded as a human one.
  autoApproved?: boolean;
}

export interface ChangesetPlan {
  summary: string;
  steps: ChangesetStep[];
  acceptanceCriteria?: VerificationClaim[];
  verificationPlan?: VerificationCheck[];
  formalSpecs?: FormalSpec[];
  verificationRuns?: VerificationRun[];
  // Kernel-only, append-only. Written exclusively by recordAttestation; never
  // copied from agent-supplied plan input (see buildPlan in tools/dispatch.ts).
  attestations?: Attestation[];
  // Kernel-only, same provenance rule as `attestations`: written by the completion
  // gate from an independently-prompted model call, never copied from agent plan
  // input. Replaced wholesale on each gate run rather than appended — the proposals
  // are a judgement about the CURRENT diff, so a superseded set is noise, and the
  // `criteria` attestation carries the history.
  independentCriteria?: ProposedCriterion[];
  // Kernel-adjudicated (see ChangeClass). Absent ⇒ `standard` ⇒ today's behavior,
  // which is what keeps in-flight changesets unaffected.
  changeClass?: ChangeClass;
}

export interface ChangesetPlanAmendment {
  summaryAddendum: string;
  steps: string[];
  acceptanceCriteria?: VerificationClaim[];
  verificationPlan?: VerificationCheck[];
  formalSpecs?: FormalSpec[];
}

export interface Changeset {
  id: string;
  sessionId: string | null;
  title: string;
  description: string | null;
  status: ChangesetStatus;
  plan: ChangesetPlan;
  planMessageIds: number[];
  approvalMessageId: number | null;
  workMessageIds: number[];
  toolCalls: unknown[] | null;
  reasoning: unknown[] | null;
  tokenUsage: {
    // Uncached input tokens only; cache write/read are separate billable buckets.
    inputTokens: number;
    cacheCreationInputTokens?: number;
    cacheReadInputTokens?: number;
    outputTokens: number;
    costUsd: number | null;
    pricingStatus?: "priced" | "unpriced" | "estimated_legacy";
    unpricedCalls?: number;
    unpricedInputTokens?: number;
    unpricedOutputTokens?: number;
    durationMs: number;
  } | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  creatorUserId?: string | null;
}

// Readiness enforcement policy (Phase 5B). `advisory` (default) keeps the four
// evidence/adversarial signals as non-blocking warnings — today's behavior.
// `graduated` promotes the deterministic, offline-satisfiable evidence codes to
// hard errors; `strict` also promotes the model-dependent adversarial codes.
export type ReadinessEnforcement = "advisory" | "graduated" | "strict";

// Proportional-verification mode — how the light lane (see VerificationTier) is
// chosen. `auto` (default) trusts the agent's per-task declaration and lets the
// kernel escalate it when the work exceeds the light budget. `always` skips the
// declaration entirely: every changeset starts light and the same escalation
// backstop is the only guard. `never` disables the lane — every changeset pays the
// full gate, which is the behavior that predates this setting.
export type ProportionalVerification = "auto" | "always" | "never";

// Changeset readiness verdict — the read-only preview of the completion gate:
// whether the changeset can complete, and if not, the blocking errors + advisory
// warnings (each with a remediation `action`) plus a numeric rollup of every check.
export interface ChangesetReadinessIssue {
  code: string;
  message: string;
  action: string;
  // "skipped" is a first-class NON-failure: the check did not run and that is the
  // policy working as intended, with `message` carrying the reason. Mirrors the
  // production-build gate tri-state (verification/production-build.ts).
  severity: "error" | "warning" | "skipped";
}

export interface ChangesetReadiness {
  passed: boolean;
  changesetId: string;
  status: ChangesetStatus;
  summary: string;
  errors: ChangesetReadinessIssue[];
  warnings: ChangesetReadinessIssue[];
  // Checks the active change class waived, each with its reason. Always present
  // (empty under `standard`) so a consumer cannot silently ignore a waiver.
  skipped: ChangesetReadinessIssue[];
  // The adjudicated class this verdict was computed under. Absent on a readiness
  // check for a changeset that predates proportional verification.
  changeClass?: ChangeClass;
  checks: {
    acceptanceCriteria: number;
    verificationPlan: number;
    verificationRuns: number;
    incompleteSteps: number;
    latestVerificationStatus: VerificationStatus | null;
    evidence: number;
    claimResults: number;
    formalSpecs: number;
    formalSpecsVerified: number;
    attestations: number;
    staleAttestations: number;
    claimsRefuted: number;
    mustClaimsReviewed: number;
    projectConsistencyErrors: number;
    projectConsistencyWarnings: number;
  };
}

// --- Continuous verification overview (Phase 4) ---
// The shape GET /api/verification/overview serves: a per-entity coverage rollup,
// a per-claim adversarial-review state, the project-wide snapshot, and the flat
// ledger. Freshness is computed on read (source re-fingerprinted vs the minted
// fingerprint), so editing code flips an entity fresh→stale on the next refresh.

export type EntityType = "handler" | "function";
// An entity is `verified` with a fresh passing invariant, `stale` when a passing
// invariant exists but drifted, `none` when none exists.
export type EntityStatus = "verified" | "stale" | "none";
// A claim `survived` a fresh adversarial pass, was `refuted` by one, or is
// `unreviewed` (no adversarial verdict, or a stale one against changed code).
export type ClaimState = "survived" | "refuted" | "unreviewed";

// A ledger entry (attestation + its changeset) enriched with the freshness flag
// computed on read.
export interface OverviewAttestation extends LedgerEntry {
  fresh: boolean;
}

export interface EntityVerification {
  scope: string;
  name: string;
  type: EntityType;
  module?: string;
  fingerprint: string | null;
  invariants: OverviewAttestation[];
  status: EntityStatus;
}

export interface ClaimVerification {
  claimId: string;
  text: string;
  priority: VerificationClaimPriority;
  changesetId: string;
  changesetTitle: string;
  adversarial?: OverviewAttestation;
  state: ClaimState;
}

export interface ProjectVerification {
  fingerprint: string;
  attestations: OverviewAttestation[]; // latest per project-scoped kind
}

export interface VerificationTotals {
  attestations: number;
  fresh: number;
  stale: number;
  refutedClaims: number;
  entitiesVerified: number;
  entitiesStale: number;
  entitiesUnverified: number;
}

export interface VerificationOverview {
  project: ProjectVerification;
  entities: EntityVerification[];
  claims: ClaimVerification[];
  ledger: OverviewAttestation[];
  totals: VerificationTotals;
  truncated: boolean;
  // Stamped by the route (the builder is pure); present on the wire, absent from
  // the pure builder's output — hence optional.
  generatedAt?: string;
}
