// @layer verification — continuous verification surface.
// Continuous verification surface (Phase 4).
//
// Verification evidence is minted into each changeset's `plan.attestations`
// (kernel-minted, append-only) and mirrored into the verification ledger
// (Phase 5A). This module reads the ledger — the full, uncapped history — into
// a single always-on view: a per-entity status rollup (is each handler/function
// covered by a FRESH passing invariant?), a per-claim adversarial-review state,
// the project-wide typecheck/test/coverage/audit snapshot, and a flat ledger of
// every verdict.
//
// "Continuous" freshness is computed on every read: the current source of each
// scope is re-fingerprinted and compared to the fingerprint each attestation
// was minted against, so editing code flips an entity fresh→stale on the next
// refresh with no background job. The builder is pure (no Date/Math.random);
// the caller stamps `generatedAt`.

import type { Kernel } from "../core/registries.ts";
import type {
  Attestation,
  AttestationKind,
  Changeset,
  LedgerEntry,
} from "./changesets.ts";
import {
  fingerprintProject,
  fingerprintScope,
  PROJECT_SCOPE,
} from "../core/fingerprint.ts";

// Project-scoped attestation kinds, shown as a single latest-per-kind snapshot.
export const PROJECT_ATTESTATION_KINDS: readonly AttestationKind[] = [
  "typecheck",
  "test",
  "coverage",
  "audit",
  // Project-scoped and project-fingerprinted like the four above: the criteria
  // review reads the whole changed surface, not one entity. "partial" here means
  // the independent reviewer proposed something the plan does not cover.
  "criteria",
] as const;

// The overview wire shapes' canonical home is the L0 shared/ package (open per
// D9). Imported here for internal use by buildVerificationOverview and re-exported
// so existing importers (verification-routes.ts) are unchanged. The IDE reads the
// same shared types over `$shared`, so the /api/verification/overview contract has
// a single source of truth.
import type {
  ClaimState,
  ClaimVerification,
  EntityStatus,
  EntityType,
  EntityVerification,
  OverviewAttestation,
  ProjectVerification,
  VerificationOverview,
  VerificationTotals,
} from "../shared/verification.ts";
export type {
  ClaimState,
  ClaimVerification,
  EntityStatus,
  EntityType,
  EntityVerification,
  OverviewAttestation,
  ProjectVerification,
  VerificationOverview,
  VerificationTotals,
};

// Resolves the current fingerprint for any attestation scope, memoized so each
// entity's source is hashed at most once per build. Mirrors the equality that
// checkChangesetReadiness's isFreshAttestation uses.
function makeFreshnessResolver(
  kernel: Kernel,
  projectFingerprint: string,
): (scope: string) => string | null {
  const cache = new Map<string, string | null>();
  return (scope) => {
    if (scope === PROJECT_SCOPE) return projectFingerprint;
    const cached = cache.get(scope);
    if (cached !== undefined) return cached;
    const fp = fingerprintScope(kernel, scope);
    cache.set(scope, fp);
    return fp;
  };
}

// Newest-first by mint time; ISO timestamps sort lexicographically.
function byCreatedAtDesc(a: Attestation, b: Attestation): number {
  return b.createdAt.localeCompare(a.createdAt);
}

// Tags each ledger entry with freshness (re-fingerprint its scope vs the
// fingerprint it was minted against), newest first.
function toOverviewLedger(
  entries: LedgerEntry[],
  currentFingerprint: (scope: string) => string | null,
): OverviewAttestation[] {
  return entries
    .map((att) => {
      const current = currentFingerprint(att.scope);
      return { ...att, fresh: current !== null && current === att.fingerprint };
    })
    .sort(byCreatedAtDesc);
}

// Claims are enumerated from recent changesets, so this bounds only the claims
// section (not the uncapped attestation ledger).
const CLAIM_CHANGESET_LIMIT = 100;

// Claims live in changeset plans, not the ledger. Load the recent changesets —
// so active work with no attestations yet still surfaces its claims — plus any
// older changesets the ledger references (attested history beyond the recent
// window). This makes claim coverage a superset of the pre-ledger behavior;
// only the attestation sections are truly uncapped. Newest first.
async function loadClaimChangesets(
  kernel: Kernel,
  ledger: OverviewAttestation[],
): Promise<Changeset[]> {
  const recent = await kernel.changesets.list({ limit: CLAIM_CHANGESET_LIMIT });
  const seen = new Set(recent.map((cs) => cs.id));
  const extraIds = [...new Set(ledger.map((a) => a.changesetId))]
    .filter((id) => !seen.has(id));
  const extra = (await Promise.all(
    extraIds.map((id) => kernel.changesets.get(id)),
  )).filter((cs): cs is Changeset => cs !== null);
  return [...recent, ...extra].sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt)
  );
}

// Per-entity rollup for a single handler/function: its invariant attestations
// (newest first) and the derived status.
function rollupEntity(
  scope: string,
  name: string,
  type: EntityType,
  module: string | undefined,
  fingerprint: string | null,
  ledger: OverviewAttestation[],
): EntityVerification {
  const invariants = ledger
    .filter((a) => a.kind === "invariant" && a.scope === scope)
    .sort(byCreatedAtDesc);
  const passing = invariants.filter((a) => a.status === "passed");
  const status: EntityStatus = passing.some((a) => a.fresh)
    ? "verified"
    : passing.length > 0
    ? "stale"
    : "none";
  return { scope, name, type, module, fingerprint, invariants, status };
}

function buildEntities(
  kernel: Kernel,
  ledger: OverviewAttestation[],
  currentFingerprint: (scope: string) => string | null,
): EntityVerification[] {
  const entities: EntityVerification[] = [];
  for (const h of kernel.handlers.list()) {
    const scope = `handler:${h.name}`;
    entities.push(
      rollupEntity(
        scope,
        h.name,
        "handler",
        h.module,
        currentFingerprint(scope),
        ledger,
      ),
    );
  }
  for (const f of kernel.functions.list()) {
    const scope = `function:${f.name}`;
    entities.push(
      rollupEntity(
        scope,
        f.name,
        "function",
        f.module,
        currentFingerprint(scope),
        ledger,
      ),
    );
  }
  return entities;
}

// Classifies a claim by its latest adversarial verdict within the same
// changeset (attestations are scoped to the changeset they were minted in).
function claimState(adversarial: OverviewAttestation | undefined): ClaimState {
  if (!adversarial || !adversarial.fresh) return "unreviewed";
  return adversarial.status === "failed" ? "refuted" : "survived";
}

function buildClaims(
  changesets: Changeset[],
  ledger: OverviewAttestation[],
): ClaimVerification[] {
  // Latest adversarial verdict per (changeset, claim); the ledger is newest
  // first so the first match wins.
  const latestByKey = new Map<string, OverviewAttestation>();
  for (const att of ledger) {
    if (att.kind !== "adversarial" || !att.checkId) continue;
    const key = `${att.changesetId}::${att.checkId}`;
    if (!latestByKey.has(key)) latestByKey.set(key, att);
  }
  const claims: ClaimVerification[] = [];
  for (const cs of changesets) {
    const claimById = new Map(
      (cs.plan.acceptanceCriteria ?? []).map((claim) => [claim.id, claim]),
    );
    for (const claim of claimById.values()) {
      const adversarial = latestByKey.get(`${cs.id}::${claim.id}`);
      claims.push({
        claimId: claim.id,
        text: claim.text,
        priority: claim.priority,
        changesetId: cs.id,
        changesetTitle: cs.title,
        adversarial,
        state: claimState(adversarial),
      });
    }
  }
  return claims;
}

// Latest attestation per project-scoped kind (typecheck/test/coverage/audit).
function buildProjectSnapshot(
  projectFingerprint: string,
  ledger: OverviewAttestation[],
): ProjectVerification {
  const latestByKind = new Map<AttestationKind, OverviewAttestation>();
  for (const att of ledger) {
    if (att.scope !== PROJECT_SCOPE) continue;
    if (!PROJECT_ATTESTATION_KINDS.includes(att.kind)) continue;
    if (!latestByKind.has(att.kind)) latestByKind.set(att.kind, att); // newest first
  }
  const attestations = PROJECT_ATTESTATION_KINDS
    .map((kind) => latestByKind.get(kind))
    .filter((a): a is OverviewAttestation => a !== undefined);
  return { fingerprint: projectFingerprint, attestations };
}

function computeTotals(
  ledger: OverviewAttestation[],
  entities: EntityVerification[],
  claims: ClaimVerification[],
): VerificationTotals {
  return {
    attestations: ledger.length,
    fresh: ledger.filter((a) => a.fresh).length,
    stale: ledger.filter((a) => !a.fresh).length,
    refutedClaims: claims.filter((c) => c.state === "refuted").length,
    entitiesVerified: entities.filter((e) => e.status === "verified").length,
    entitiesStale: entities.filter((e) => e.status === "stale").length,
    entitiesUnverified: entities.filter((e) => e.status === "none").length,
  };
}

// Reads the verification ledger into the continuous verification overview.
// Freshness is recomputed on every read; no aggregation cap (the whole ledger
// is queried). `generatedAt` is stamped by the caller.
export async function buildVerificationOverview(
  kernel: Kernel,
): Promise<VerificationOverview> {
  const entries = await kernel.changesets.listLedger();
  const projectFingerprint = fingerprintProject(kernel);
  const currentFingerprint = makeFreshnessResolver(kernel, projectFingerprint);

  const ledger = toOverviewLedger(entries, currentFingerprint);
  const entities = buildEntities(kernel, ledger, currentFingerprint);
  const changesets = await loadClaimChangesets(kernel, ledger);
  const claims = buildClaims(changesets, ledger);
  const project = buildProjectSnapshot(projectFingerprint, ledger);
  const totals = computeTotals(ledger, entities, claims);

  // The ledger is unbounded now; retained for API/UI compatibility.
  return { project, entities, claims, ledger, totals, truncated: false };
}
