// @layer verification — the risk-adaptive save policy the LSP write path consults
// (docs/lsp-support-plan.md Stage 4). It is the concrete implementation injected
// into the composition's `saveRiskPolicy` seam (core/composition.ts): core and lsp
// declare only the contract, so neither imports this module. The governance
// decision — "is this edit risky, and does the active enforcement policy gate a
// risky edit?" — lives here, in verification, and nowhere else (plan §8).
import { getKernelSettings } from "../core/config.ts";
import { createTimestampedId } from "../core/ids.ts";
import type { Kernel } from "../core/registries.ts";
import type {
  SaveGateChangesetSpec,
  SaveRiskVerdict,
} from "../core/composition.ts";
import type {
  ChangesetPlan,
  FormalSpec,
  ReadinessEnforcement,
} from "../core/types.ts";

// A formal spec targets an entity by a "handler:processOrder"-style scope
// (shared/verification.ts). The risk signal for a save is: this entity is covered
// by a HARD-enforced formal spec — a deterministic invariant the verification
// layer would block a governed change on. `soft` specs only warn, so they are not
// treated as gating risk here.
function scopeOf(entityType: string, entityName: string): string {
  return `${entityType}:${entityName}`;
}

// Every hard-enforced formal spec across known changesets that covers this entity.
// Formal specs live inside changeset plans (plan.formalSpecs); an edit to an entity
// under one is the "high risk" the plan (§7 Stage 4) calls out — there is no
// generic risk scorer, the risk is spec-driven.
async function coveringHardSpecs(
  kernel: Kernel,
  entityType: string,
  entityName: string,
): Promise<FormalSpec[]> {
  const scope = scopeOf(entityType, entityName);
  const changesets = await kernel.changesets.list();
  return changesets.flatMap((cs) => cs.plan.formalSpecs ?? [])
    .filter((spec) => spec.scope === scope && spec.enforcement === "hard");
}

// Whether the active enforcement policy gates a risky (hard-spec-covered) edit.
// Mirrors the readiness-code promotion ladder (changesets.ts promotedReadinessCodes):
// advisory never blocks; graduated and strict both harden the deterministic
// invariant a hard formal spec represents into a gate.
function enforcementGates(policy: ReadinessEnforcement): boolean {
  return policy !== "advisory";
}

// A minimal but VALID changeset plan (validateChangesetPlan requires at least one
// acceptance criterion and one planned verification check) that carries the
// proposed edit's target and the invariants it must not break. On approval a later
// stage applies the held edit; Stage 4 only needs the plan to persist and resolve.
function gatePlan(
  entityType: string,
  entityName: string,
  specs: FormalSpec[],
): ChangesetPlan {
  const claimId = createTimestampedId("clm");
  return {
    summary:
      `Risk-adaptive save: edit to ${entityType} "${entityName}" is held for ` +
      `review because it is under a hard-enforced formal spec.`,
    steps: [
      {
        id: createTimestampedId("stp"),
        description:
          `Apply the reviewed edit to ${entityType} "${entityName}".`,
        status: "pending",
      },
    ],
    acceptanceCriteria: [
      {
        id: claimId,
        text:
          `The edit to ${entityType} "${entityName}" preserves its enforced ` +
          `invariants (${specs.map((s) => s.statement).join("; ")}).`,
        source: "inferred",
        priority: "must",
      },
    ],
    verificationPlan: [
      {
        id: createTimestampedId("chk"),
        claimIds: [claimId],
        kind: "invariant",
        description:
          `Re-check the hard-enforced invariant(s) covering ${entityType} ` +
          `"${entityName}" against the proposed edit.`,
      },
    ],
    formalSpecs: specs,
  };
}

// Build the changeset spec the LSP server persists when a save is gated. Named as
// its own step so gatePlan stays pure and the verdict assembly reads as data.
function gateChangeset(
  entityType: string,
  entityName: string,
  specs: FormalSpec[],
): SaveGateChangesetSpec {
  return {
    title: `Gated edit: ${entityType} "${entityName}"`,
    description:
      `An LSP save to ${entityType} "${entityName}" was held for approval ` +
      `because the entity is under a hard-enforced formal spec.`,
    plan: gatePlan(entityType, entityName, specs),
  };
}

// The default risk-adaptive save policy (composition seam `saveRiskPolicy`). It
// folds the entity's formal-spec risk together with the active readinessEnforcement
// policy into a single verdict the LSP server acts on without re-deriving any
// governance logic:
//   - no covering hard spec         → allow (transparent Stage 3 save)
//   - covered, advisory enforcement → allow, but with an advisory warning
//   - covered, graduated/strict     → gate (hold as a pending changeset)
// The `source` argument is currently unused (the risk is spec-scoped, not content
// derived); it is part of the seam signature so a future policy can inspect the
// proposed bytes — e.g. detect that the edit removes the invariant's guard.
export async function defaultSaveRiskPolicy(
  kernel: Kernel,
  entityType: string,
  entityName: string,
  _source: string,
): Promise<SaveRiskVerdict> {
  const specs = await coveringHardSpecs(kernel, entityType, entityName);
  if (specs.length === 0) return { decision: "allow" };

  const policy = getKernelSettings().readinessEnforcement;
  const invariantList = specs.map((s) => s.statement).join("; ");
  if (!enforcementGates(policy)) {
    return {
      decision: "allow",
      reason:
        `Heads up: ${entityType} "${entityName}" is under a hard-enforced ` +
        `formal spec (${invariantList}). Enforcement is "advisory", so the save ` +
        `was applied without review.`,
    };
  }
  return {
    decision: "gate",
    reason:
      `${entityType} "${entityName}" is under a hard-enforced formal spec ` +
      `(${invariantList}). Enforcement is "${policy}", so the save is held for ` +
      `approval rather than applied.`,
    changeset: gateChangeset(entityType, entityName, specs),
  };
}
