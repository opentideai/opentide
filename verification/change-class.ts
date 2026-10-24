// @layer verification — the proportional-verification policy: how much governance
// ceremony a changeset must pay, and what it may touch in exchange. Sibling of
// save-risk.ts, and here for the same reason: the governance DECISION — "is this
// change small enough to trust with a reduced gate, and does the active policy grant
// that?" — lives in verification and nowhere else. core/tools/change-tiers.ts holds
// only the surface PROPERTIES this module reasons over.
//
// The central invariant: ceremony drops because CAPABILITY drops. A light-tier
// changeset is narrowed at dispatch to the light surface for its whole lifetime, so
// the reduced gate is not an act of trust in the model's declaration — it is a
// consequence of what the kernel will let the changeset do.
import {
  LIGHT_TIER_MAX_ENTITIES,
  LIGHT_TIER_MAX_STEPS,
} from "../core/config.ts";
import { createTimestampedId } from "../core/ids.ts";
import {
  changeRecordTier,
  changeScope,
  maxTier,
} from "../core/tools/change-tiers.ts";
import type { ChangeRecord } from "../core/changelog.ts";
import type {
  ChangeClass,
  ChangesetPlan,
  ProportionalVerification,
  VerificationTier,
} from "../core/types.ts";

// Reasons recorded verbatim on a waived readiness finding or a skipped gate step, so
// "this did not run" is always accompanied by "and here is why". Named constants
// rather than inline strings, mirroring route-smoke-plan.ts's SKIP_* set.
export const SKIP_LIGHT_TIER =
  "Skipped: this changeset is in the light verification lane, whose blast radius " +
  "the kernel bounded at dispatch.";
export const SKIP_NO_MUST_CLAIMS =
  "Skipped: the light lane records a `should` criterion, so there is no must-claim " +
  "to adversarially review.";

// What a tier grants. One table — every relaxation in the system reads from here, so
// there is no scattered `if (tier === "light")` to drift.
export interface TierPolicy {
  tier: VerificationTier;
  // May the kernel approve without a human round-trip?
  allowsAutoApprove: boolean;
  // May the kernel author the acceptance criterion and planned check itself?
  synthesizesPlan: boolean;
  // Does the completion gate run the adversarial refutation pass?
  runsAdversarialRefutation: boolean;
  // Max plan steps before the tier no longer applies.
  maxSteps: number;
  // Max distinct entities the changeset may touch before it escalates.
  maxEntities: number;
  // Readiness codes this tier waives (moved to `skipped`, not silently dropped).
  waivedReadinessCodes: ReadonlySet<string>;
  skipReason: string;
}

export const TIER_POLICIES = {
  light: {
    tier: "light",
    allowsAutoApprove: true,
    synthesizesPlan: true,
    runsAdversarialRefutation: false,
    maxSteps: LIGHT_TIER_MAX_STEPS,
    maxEntities: LIGHT_TIER_MAX_ENTITIES,
    // Only the model-dependent signals are waived. Everything else the gate checks
    // is deterministic and free, so waiving it would buy nothing and cost the audit
    // trail its meaning.
    //
    // UNCOVERED_INDEPENDENT_CRITERION joins the must-claim signal for the same
    // reason it is skipped at the gate: the light lane's single criterion is the
    // KERNEL's, so there is no agent framing for an independent reviewer to
    // second-guess. Listing it also stops a pre-existing changeset's stale
    // proposals from blocking a light completion after the setting is enabled.
    waivedReadinessCodes: new Set([
      "MUST_CLAIM_UNREVIEWED",
      "UNCOVERED_INDEPENDENT_CRITERION",
      "PRIORITY_DOWNGRADED",
    ]),
    skipReason: SKIP_LIGHT_TIER,
  },
  standard: {
    tier: "standard",
    allowsAutoApprove: false,
    synthesizesPlan: false,
    runsAdversarialRefutation: true,
    maxSteps: Number.POSITIVE_INFINITY,
    maxEntities: Number.POSITIVE_INFINITY,
    waivedReadinessCodes: new Set<string>(),
    skipReason: "",
  },
} as const satisfies Record<VerificationTier, TierPolicy>;

export function tierPolicy(tier: VerificationTier): TierPolicy {
  return TIER_POLICIES[tier];
}

// The tier a set of recorded changes actually demands: the heaviest change wins, and
// touching more than the light budget of distinct entities escalates regardless of
// how light each individual change was. This is the kernel's evidence-side verdict —
// what the changeset DID, as opposed to what it declared.
export function classifyChangeRecords(
  records: readonly ChangeRecord[],
): VerificationTier {
  const scopes = new Set(records.map(changeScope));
  if (scopes.size > LIGHT_TIER_MAX_ENTITIES) return "standard";
  return records.reduce<VerificationTier>(
    (tier, record) => maxTier(tier, changeRecordTier(record)),
    "light",
  );
}

// The records that pushed a changeset above the light budget, for the escalation
// message. Entity-count overflow has no single offending record, so it reports none
// and the caller falls back to the count.
function offendingScopes(records: readonly ChangeRecord[]): string[] {
  return [
    ...new Set(
      records.filter((r) => changeRecordTier(r) === "standard").map(
        changeScope,
      ),
    ),
  ];
}

// --- Declaration time -------------------------------------------------------

// Why a `light` declaration cannot be honored as written. Returned as an issue so the
// caller REJECTS the plan rather than silently downgrading it: a silent downgrade
// would leave the user reading a plan that says one thing while the kernel does
// another, which is precisely the failure this whole layer exists to prevent.
function lightDeclarationIssue(plan: ChangesetPlan): string | null {
  if ((plan.formalSpecs?.length ?? 0) > 0) {
    return "A changeset carrying formal specs cannot use the light verification " +
      "lane — formal specs target handlers and functions and are verified by the " +
      "full gate. Declare `standard`, or drop the formal specs.";
  }
  const authoredMust = (plan.acceptanceCriteria ?? []).some(
    (claim) => claim.priority === "must",
  );
  if (authoredMust) {
    return "A changeset with a `must` acceptance criterion cannot use the light " +
      "verification lane — a must-claim is a request for adversarial review. " +
      "Declare `standard`, or lower the criterion to `should`.";
  }
  if (plan.steps.length > LIGHT_TIER_MAX_STEPS) {
    return `The light verification lane allows at most ${LIGHT_TIER_MAX_STEPS} ` +
      `step(s); this plan has ${plan.steps.length}. Declare \`standard\`, or split ` +
      "the work.";
  }
  return null;
}

// The single acceptance criterion the kernel authors for a light-lane changeset. It
// is `should`, not `must` — which is what mechanically keeps the adversarial pass out
// of the completion gate (that filter already keys on `must`), and is also the honest
// priority: nobody asked for a proof, they asked for a small change.
function synthesizedPlan(plan: ChangesetPlan): ChangesetPlan {
  const claimId = createTimestampedId("clm");
  return {
    ...plan,
    acceptanceCriteria: [
      {
        id: claimId,
        text:
          `The changes described as "${plan.summary}" are applied and the app ` +
          "still builds and serves its routes.",
        source: "inferred",
        priority: "should",
      },
    ],
    verificationPlan: [
      {
        id: createTimestampedId("chk"),
        claimIds: [claimId],
        // The kernel's record of exactly which entities changed. For a small change
        // this IS the proof that matters — a manufactured unit test would be
        // ceremony, and the manifest is grounded where the test would be asserted.
        kind: "manifest",
        description:
          "Kernel-minted manifest of every entity this changeset changed, taken " +
          "from the changelog at the completion gate.",
      },
    ],
  };
}

// Adjudicate a declaration into a ChangeClass and, for the light lane, author the
// ceremony the agent no longer has to. Pure: the caller persists whatever comes back.
//
// `mode` is the kernel setting. Under "never" every changeset is standard regardless
// of what was declared; under "always" the declaration is ignored and every changeset
// starts light (the dispatch gate + completion re-adjudication remain the guard);
// under "auto" the declaration is honored if coherent.
export function resolveChangeClass(
  declared: VerificationTier | undefined,
  plan: ChangesetPlan,
  mode: ProportionalVerification,
): { changeClass: ChangeClass; plan: ChangesetPlan; issue: string | null } {
  const standard = (reason: string) => ({
    changeClass: {
      declared: declared ?? "standard",
      effective: "standard" as const,
      escalated: declared === "light",
      reason,
    },
    plan,
    issue: null,
  });

  if (mode === "never") {
    return standard("Proportional verification is off; the full gate applies.");
  }
  const wantsLight = mode === "always" || declared === "light";
  if (!wantsLight) {
    return standard("Declared as standard-tier work; the full gate applies.");
  }

  const issue = lightDeclarationIssue(plan);
  if (issue) {
    // Under "always" the agent did not choose the lane, so an incoherent plan is not
    // its mistake to fix — fall back to standard silently. Under "auto" it declared
    // light explicitly, so surface the contradiction and let it re-plan.
    if (mode === "always") {
      return standard(`Not eligible for the light lane: ${issue}`);
    }
    return { ...standard(issue), issue };
  }

  return {
    changeClass: {
      declared: "light",
      effective: "light",
      escalated: false,
      reason: mode === "always"
        ? "Light lane applied to every changeset (proportionalVerification: always)."
        : "Declared light-tier work: small blast radius, reduced ceremony. The " +
          "kernel bounds what this changeset may touch for its lifetime.",
    },
    plan: synthesizedPlan(plan),
    issue: null,
  };
}

// --- Completion time --------------------------------------------------------

// Re-adjudicate a declared class against what the changeset actually changed. This is
// the backstop behind the dispatch gate: the gate refuses out-of-budget verbs one at
// a time, and this catches anything that reached the changelog anyway (a delegated
// verb, a manual edit, a pre-existing changeset from before the gate).
export function verifyChangeClass(
  current: ChangeClass | undefined,
  records: readonly ChangeRecord[],
): ChangeClass {
  const declared = current?.declared ?? "standard";
  if (declared === "standard") {
    return current ?? {
      declared: "standard",
      effective: "standard",
      escalated: false,
      reason: "Standard-tier work; the full gate applies.",
    };
  }

  const actual = classifyChangeRecords(records);
  if (actual === "light") {
    return {
      ...current,
      declared,
      effective: "light",
      escalated: false,
      reason: current?.reason ??
        "Light-tier work, confirmed against the changelog.",
    };
  }

  const offenders = offendingScopes(records);
  const scopeCount = new Set(records.map(changeScope)).size;
  const detail = offenders.length > 0
    ? `it changed ${offenders.join(", ")}`
    : `it changed ${scopeCount} entities (the light lane allows ` +
      `${LIGHT_TIER_MAX_ENTITIES})`;
  return {
    ...current,
    declared,
    effective: "standard",
    escalated: true,
    reason:
      `Declared light, but ${detail}. The full verification gate applies.`,
  };
}
