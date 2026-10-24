// @layer verification — attestation ledger.
// One-time backfill for the verification ledger (Phase 5A).
//
// Attestations minted before the ledger table existed live only in each
// changeset's `plan.attestations`. This seeds the derived index from that
// authoritative record so history predating the table is queryable. It runs on
// kernel init and is a no-op once the ledger is non-empty (dual-write in
// recordAttestation keeps it current thereafter). Idempotent regardless — the
// ledger upserts by attestation id — so a re-run never double-counts.

import type { Kernel } from "../core/registries.ts";
import { getKernelSettings } from "../core/config.ts";
import { errorMessage } from "../core/util.ts";

// One-time scan: enumerate every changeset (the changeset list caps at 100 by
// default; a max-safe limit lifts that just for the backfill sweep).
const BACKFILL_SCAN_LIMIT = Number.MAX_SAFE_INTEGER;

// Returns the number of attestations seeded (0 when already backfilled).
//
// Guarded on the ledger being empty rather than a count comparison, so it never
// fights retention pruning (which intentionally leaves the ledger smaller than
// the embedded history). Tradeoff: if the process crashes mid-initial-backfill,
// the partial ledger won't auto-resume — the derived index is then incomplete
// for pre-table history until manually rebuilt (delete the ledger, reboot).
export async function backfillVerificationLedger(kernel: Kernel): Promise<number> {
  const existing = await kernel.changesets.listLedger({ limit: 1 });
  if (existing.length > 0) return 0;

  const changesets = await kernel.changesets.list({ limit: BACKFILL_SCAN_LIMIT });
  let seeded = 0;
  for (const cs of changesets) {
    for (const att of cs.plan.attestations ?? []) {
      await kernel.changesets.recordLedgerEntry({
        ...att,
        changesetId: cs.id,
        changesetTitle: cs.title,
      });
      seeded++;
    }
  }
  return seeded;
}

// Project-load lifecycle hook (carried by the composition root's
// composition's initHooks, cli/assembly.ts): seed the ledger from embedded attestations, then
// apply the retention policy. Both steps are best-effort — a derived index must
// never block project load.
export async function initVerificationLedger(kernel: Kernel): Promise<void> {
  await bestEffort(
    "backfill",
    () => backfillVerificationLedger(kernel),
    (n) => `backfilled (${n} attestations)`,
  );

  const retention = getKernelSettings().verificationLedgerRetention;
  if (retention > 0) {
    await bestEffort(
      "prune",
      () => kernel.changesets.pruneLedger(retention),
      (n) => `pruned (${n} old entries)`,
    );
  }
}

// Run a best-effort ledger step: log a described count when it did work, and
// swallow+warn on failure so a derived index never blocks project load.
async function bestEffort(
  action: string,
  run: () => Promise<number>,
  describe: (count: number) => string,
): Promise<void> {
  try {
    const count = await run();
    if (count > 0) console.log(`  Verification ledger ${describe(count)}`);
  } catch (err) {
    console.warn(`  Verification ledger ${action} skipped: ${errorMessage(err)}`);
  }
}
