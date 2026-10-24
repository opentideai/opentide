// @layer verification — Milestone 7, Slice 7.2: the pure report → DTO projection
// for the committed-lock refresh (the mirror of production-build-report.ts's
// projectProductionBuildReport). It turns the producer's internal LockRefreshReport
// (verification/production-lock-refresh.ts) into the serializable LockRefreshResult
// the HTTP API (7.2) returns and the IDE renders.
//
// This is a PROJECTION, not a re-run: the report already holds every per-target
// outcome, so this regenerates no lock, re-hashes no byte, and touches no disk. It
// is pure, total, never-throws, and deterministic — the same report always yields a
// byte-identical DTO. The producer's RefreshTargetOutcome is already
// structurally the wire shape; the projection re-materialises it as fresh objects
// the DTO owns (an undefined `code` omitted, not serialized as `code: undefined`),
// exactly as toGateResult does for the build.
import type { LockRefreshReport } from "./production-lock-refresh.ts";
import type {
  LockRefreshResult,
  LockRefreshTargetResult,
} from "../shared/lock-refresh.ts";

// Copy one producer RefreshTargetOutcome to its wire LockRefreshTargetResult 1:1 —
// same target key, same tri-state status, same optional code, same detail. A fresh
// object (not the report's) so the DTO owns its data. The producer's RefreshTarget
// is TARGET_DENO_SOURCE | TARGET_NODE, whose literal values ARE RefreshTargetKey
// (pinned by a test), so no upward shared/ → verification/ import is needed.
function toTargetResult(
  outcome: LockRefreshReport["targets"][number],
): LockRefreshTargetResult {
  return {
    target: outcome.target,
    status: outcome.status,
    detail: outcome.detail,
    ...(outcome.code !== undefined ? { code: outcome.code } : {}),
  };
}

/**
 * Project the producer's LockRefreshReport onto the serializable LockRefreshResult
 * wire DTO. Pure, total, never-throws, deterministic: no I/O, no regeneration, no
 * clock — the same report always yields a byte-identical DTO.
 *
 * `ok` passes through verbatim (true iff no selected target failed); `targets` is a
 * faithful, order-preserving 1:1 mirror of the report's per-target outcomes.
 */
export function projectLockRefreshReport(
  report: LockRefreshReport,
): LockRefreshResult {
  return {
    ok: report.ok,
    targets: report.targets.map(toTargetResult),
  };
}
