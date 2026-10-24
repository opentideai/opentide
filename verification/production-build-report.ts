// @layer verification — Milestone 5, Slice 5.1: the pure report → DTO projection
// (the Phase 10/11/12 seam). It turns the orchestrator's internal
// ProductionBuildReport (a flat, pipeline-ordered gate list plus a raw in-memory
// artifact) into the serializable, target-grouped ProductionBuildResult that the
// HTTP API (5.2), the Production Build UI (5.3), and the ledger attestations
// (5.4) will all consume.
//
// This is a PROJECTION, not a re-run: the report already holds everything, so
// this adds no gate execution, no hashing, no I/O. The per-file hashes and
// sourceFingerprint are already computed — they live in the emitted manifest.json
// inside report.artifact.files — so the artifact summary is a pure PARSE of that
// manifest, not a re-hash. The one hash it does NOT surface is the tarball digest
// (a SHA-256 over report.artifact.tarball); that is async and belongs to the
// endpoint slice (5.2) that already holds the bytes, so keeping it out preserves
// this projection's pure/sync/never-throws property.
//
// The whole function is pure, total, never-throws, and deterministic — the mirror
// of compareTargetParity / buildRouteSmokePlan in discipline: the same report
// always yields a byte-identical DTO.
import { fileBytes, MANIFEST_PATH } from "../core/export.ts";
import {
  GATE_APP_SMOKE,
  GATE_BINARY_SMOKE,
  GATE_DENO_SMOKE,
  GATE_DEPENDENCY_LOCK,
  GATE_DETERMINISM,
  GATE_MANIFEST,
  GATE_NODE_DEPENDENCY_LOCK,
  GATE_NODE_SMOKE,
  GATE_ROUTE_PARITY,
  GATE_TYPE_CHECK,
  type GateOutcome,
  type ProductionBuildReport,
  TARGET_BINARY,
  TARGET_DENO_SOURCE,
  TARGET_NODE,
} from "./production-build.ts";
import type {
  ProductionArtifactSummary,
  ProductionBuildResult,
  ProductionGateResult,
  ProductionGateStatus,
  ProductionTargetKey,
  ProductionTargetRollup,
} from "../shared/production-build.ts";

// The deterministic order the per-target rollups appear in the DTO. Fixed here so
// the same report always yields the same target ordering regardless of gate
// order. Uses the TARGET_* constants (no magic strings); their literal values
// ARE the ProductionTargetKey union (pinned by a test), so this single source of
// truth needs no shared/ → verification/ upward import.
const TARGET_ORDER: readonly ProductionTargetKey[] = [
  TARGET_DENO_SOURCE,
  TARGET_NODE,
  TARGET_BINARY,
];

const EMPTY_ROUTE_SMOKE = {
  status: "passed",
  routesProbed: 0,
  routesFailed: 0,
  skipped: 0,
  failures: [],
} as const;

// The core gates that validate the canonical Deno source release every target
// shares — they all roll into the deno-source target. Keyed by the GATE_*
// constants (no magic strings).
const DENO_SOURCE_GATES: ReadonlySet<string> = new Set([
  GATE_MANIFEST,
  GATE_DETERMINISM,
  GATE_TYPE_CHECK,
  GATE_DEPENDENCY_LOCK,
  GATE_APP_SMOKE,
  GATE_DENO_SMOKE,
]);

// Classify which target (or the cross-cutting parity verdict) a gate belongs to.
// Returns a ProductionTargetKey for a target-scoped gate, "parity" for the
// cross-target route_parity gate (surfaced separately, not in a rollup), or null
// for anything unrecognized (defensive — a future gate must be classified here
// explicitly rather than silently landing in a target). Uses the GATE_*/TARGET_*
// constants throughout.
function gateTargetKey(gate: string): ProductionTargetKey | "parity" | null {
  if (DENO_SOURCE_GATES.has(gate)) return TARGET_DENO_SOURCE;
  if (gate === GATE_NODE_DEPENDENCY_LOCK || gate === GATE_NODE_SMOKE) {
    return TARGET_NODE;
  }
  if (gate === GATE_BINARY_SMOKE) return TARGET_BINARY;
  if (gate === GATE_ROUTE_PARITY) return "parity";
  return null;
}

// A target rollup's status from its gates: failed if any failed; else skipped if
// EVERY present gate is skipped; else passed. Only called with a non-empty list
// (a rollup is emitted only when ≥1 of its gates ran), so the "all skipped"
// branch never misclassifies an empty list as skipped.
function rollupStatus(
  gates: readonly ProductionGateResult[],
): ProductionGateStatus {
  if (gates.some((g) => g.status === "failed")) return "failed";
  if (gates.every((g) => g.status === "skipped")) return "skipped";
  return "passed";
}

// Copy one GateOutcome to its wire ProductionGateResult 1:1 — same gate name,
// same tri-state status, same optional code, same detail. A fresh object (not the
// report's) so the DTO owns its data. `code` is spread conditionally so an
// undefined code is omitted rather than serialized as `code: undefined`.
function toGateResult(outcome: GateOutcome): ProductionGateResult {
  return {
    gate: outcome.gate,
    status: outcome.status,
    detail: outcome.detail,
    ...(outcome.code !== undefined ? { code: outcome.code } : {}),
  };
}

// Parse the artifact hash summary out of the emitted manifest.json — a pure
// parse, never a re-hash. Production runs always emit a well-formed manifest
// (runProductionBuild forces includeManifest), but this must be TOTAL: a missing
// or malformed/unparseable manifest degrades to null rather than throwing. The
// per-file { path, sha256, bytes } and sourceFingerprint are read straight from
// the manifest the manifest gate already produced.
function parseArtifactSummary(
  artifact: NonNullable<ProductionBuildReport["artifact"]>,
): ProductionArtifactSummary | null {
  const manifestFile = artifact.files.find((f) => f.path === MANIFEST_PATH);
  if (!manifestFile) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(fileBytes(manifestFile)));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;

  const record = parsed as Record<string, unknown>;
  const { sourceFingerprint, files } = record;
  if (typeof sourceFingerprint !== "string" || !Array.isArray(files)) {
    return null;
  }

  const summaryFiles: ProductionArtifactSummary["files"] = [];
  for (const entry of files) {
    if (typeof entry !== "object" || entry === null) return null;
    const { path, sha256, bytes } = entry as Record<string, unknown>;
    if (
      typeof path !== "string" || typeof sha256 !== "string" ||
      typeof bytes !== "number"
    ) {
      return null;
    }
    summaryFiles.push({ path, sha256, bytes });
  }

  return { sourceFingerprint, files: summaryFiles };
}

/**
 * Project the orchestrator's ProductionBuildReport onto the serializable,
 * target-grouped ProductionBuildResult wire DTO. Pure, total, never-throws,
 * deterministic: no I/O, no hashing, no clock — the same report always yields a
 * byte-identical DTO.
 *
 * - `gates` is a faithful 1:1, pipeline-ordered mirror of report.gates (nothing
 *   dropped, reordered, or merged — route_parity appears here too), so the UI
 *   checklist is an honest record of what ran.
 * - `targets` is the per-target rollup (deno-source / node / binary status
 *   chips), present-only: a rollup appears only when ≥1 of its gates actually
 *   ran, so a stop-at-first-failure-truncated tail never fabricates a rollup.
 *   Fixed order (deno-source, node, binary); worst-of status per target.
 * - `parity` extracts the cross-target route_parity verdict on its own (null when
 *   that gate never ran); it also remains in the flat `gates` list.
 * - `artifact` is a pure parse of the emitted manifest.json (sourceFingerprint +
 *   per-file hashes), non-null only when report.artifact is (all gates passed)
 *   and the manifest parsed; the tarball digest is deferred to the endpoint
 *   slice (5.2).
 */
export function projectProductionBuildReport(
  report: ProductionBuildReport,
): ProductionBuildResult {
  const gates = report.gates.map(toGateResult);
  const routeSmoke = report.routeSmoke ?? EMPTY_ROUTE_SMOKE;

  const targets: ProductionTargetRollup[] = [];
  for (const target of TARGET_ORDER) {
    const targetGates = gates.filter((g) => gateTargetKey(g.gate) === target);
    // Present-only: a target whose gates never ran (truncated tail) is omitted,
    // never fabricated.
    if (targetGates.length === 0) continue;
    targets.push({
      target,
      status: rollupStatus(targetGates),
      gates: targetGates,
    });
  }

  const parity = gates.find((g) => gateTargetKey(g.gate) === "parity") ?? null;

  const artifact = report.artifact
    ? parseArtifactSummary(report.artifact)
    : null;

  return {
    ok: report.ok,
    status: report.ok ? "passed" : "failed",
    sourceFingerprint: report.sourceFingerprint,
    gates,
    targets,
    parity,
    routeSmoke: {
      ...routeSmoke,
      failures: routeSmoke.failures.map((failure) => ({
        target: failure.target,
        method: failure.method,
        path: failure.path,
        expectedStatus: failure.expectedStatus,
        actualStatus: failure.actualStatus,
        detail: failure.detail,
        ...(failure.bodySnippet !== undefined
          ? { bodySnippet: failure.bodySnippet }
          : {}),
      })),
    },
    artifact,
  };
}
