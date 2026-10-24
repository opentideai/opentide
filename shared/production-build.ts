// @layer shared — L0, the OpenTide *open* wire contract for the production-build
// RESULT projection (Milestone 5, Slice 5.1). Type-only; imports NOTHING
// (self-contained; nothing sits below L0). Consumed by the Deno backend
// (re-exported from core/types.ts) and, when the Production Build UI lands (Slice
// 5.3), the IDE via the `$shared` alias — the same open-wire-contract role
// shared/verification.ts plays for the verification surface.
//
// This is the shape a CALLER wants, not the pipeline's internal
// ProductionBuildReport. The pure projection projectProductionBuildReport
// (verification/production-build-report.ts) regroups and renames the report the
// orchestrator already produced onto these types — a projection, not a re-run: no
// gate executes and no byte is re-hashed here. See docs/production-output-contract.md
// ("Production build result projection").

// The tri-state status of a single gate, mirroring the verification layer's
// GateStatus but as the WIRE type — so a UI consuming this DTO never imports a
// verification-layer type. The projection maps GateOutcome.status onto these
// literals 1:1 (they are the same three strings).
export type ProductionGateStatus = "passed" | "failed" | "skipped";

// One gate's outcome as it crosses the wire: mirrors the verification layer's
// GateOutcome verbatim (gate name, tri-state status, the reused error code set
// only on "failed", and a human-readable detail — success summary, failure
// message, or skip reason depending on status).
export interface ProductionGateResult {
  gate: string;
  status: ProductionGateStatus;
  code?: string;
  detail: string;
}

// The selectable production targets as wire literals. These MATCH
// production-build.ts's TARGET_* constants (deno-source / node / binary); the
// projection maps the constants onto them (a test pins the alignment) so the
// strings have one source of truth without shared/ importing upward into
// verification/.
export type ProductionTargetKey = "deno-source" | "node" | "binary";

// A per-target rollup: the target's identity, its worst-of rollup status
// (failed if any of its gates failed; else skipped if all present gates are
// skipped; else passed), and the gates that rolled into it (present-only — a
// stop-at-first-failure run truncates the tail, so a target whose gates never
// ran is omitted, never fabricated).
export interface ProductionTargetRollup {
  target: ProductionTargetKey;
  status: ProductionGateStatus;
  gates: ProductionGateResult[];
}

// The artifact's hash summary, parsed out of the emitted manifest.json (never
// re-hashed): the manifest's sourceFingerprint plus its per-file
// { path, sha256, bytes } entries. Present only when the report carried an
// artifact (all gates passed) AND its manifest parsed. The tarball digest is
// deliberately NOT here — it is async and belongs to the endpoint slice (5.2)
// that already holds the bytes; keeping it out preserves the projection's
// pure/sync/never-throws property.
export interface ProductionArtifactSummary {
  sourceFingerprint: string;
  files: { path: string; sha256: string; bytes: number }[];
}

export interface ProductionRouteSmokeFailure {
  target: ProductionTargetKey;
  method: string;
  path: string;
  expectedStatus: number;
  actualStatus: number | null;
  detail: string;
  bodySnippet?: string;
}

export interface ProductionRouteSmokeDiagnostic {
  status: "passed" | "warning";
  routesProbed: number;
  routesFailed: number;
  skipped: number;
  failures: ProductionRouteSmokeFailure[];
}

// The whole production-build result as it crosses the wire — what the HTTP API
// (5.2) returns, the UI (5.3) renders, and the ledger (5.4) attests over.
export interface ProductionBuildResult {
  ok: boolean;
  // report.ok ? "passed" : "failed" — never "skipped" at the top level.
  status: "passed" | "failed";
  sourceFingerprint: string | null;
  // The FLAT, pipeline-ordered gate list — the UI checklist. A faithful 1:1
  // mirror of report.gates (route_parity included), so the checklist never lies
  // about what ran.
  gates: ProductionGateResult[];
  // Per-target rollup — the UI status chips. Present-only, deterministic order
  // (deno-source, node, binary).
  targets: ProductionTargetRollup[];
  // The cross-target route_parity verdict surfaced on its own (it is
  // cross-target, not a target rollup). Also still appears in the flat gates[]
  // list — the flat list is the literal checklist; this is the extracted
  // convenience. Null when the parity gate never ran.
  parity: ProductionGateResult | null;
  // Advisory app-route smoke diagnostics. Boot/framework gates remain blocking;
  // app-authored route probe failures are warnings unless strictRouteSmoke was
  // explicitly requested.
  routeSmoke?: ProductionRouteSmokeDiagnostic;
  // Present only when the report's artifact is (all gates passed) and its
  // manifest parsed; a pure manifest parse, never a re-hash.
  artifact: ProductionArtifactSummary | null;
}

// --- Build-job envelope (Slice 5.2) -------------------------------------------
// A production build is slow (real subprocess boots + an optional `deno compile`),
// far beyond the internal control API's 30s handler timeout, so it runs as an
// async job: a POST mints a job and returns immediately, a GET polls it, a third
// GET streams its artifact. These types are the wire shape the IDE (5.3) consumes
// over `$shared` — the endpoint owns an internal job registry whose retained
// tarball bytes are NEVER on the wire (only the digest below crosses it).

// The lifecycle of a build job. "running": the build is in flight. "done": it ran
// to a verdict — its `result.ok` may be true OR false (a gate failure is a
// result, not an error). "error": the build could not run at all (e.g. the export
// threw before any gate) — it carries a message, no result. runProductionBuild
// itself never throws, so "error" only fires on an unexpected exception around it.
export type ProductionBuildJobStatus = "running" | "done" | "error";

// The download affordance for a done build that produced an artifact: the async
// SHA-256 over the release-candidate tarball (the one hash the 5.1 projection
// deferred, computed at the endpoint that holds the bytes), the attachment
// filename, and the tarball's byte length. Present (non-null) only when the
// build's `result.artifact` is; null on a done-but-artifactless (gate-failed)
// build. The raw tarball bytes themselves stay an internal job field.
export interface ProductionBuildDownload {
  tarballSha256: string;
  filename: string;
  bytes: number;
}

// One production build job as it crosses the wire. `targets` is the full set the
// build validated (deno-source is always present, plus any selected node/binary),
// in canonical order. `result` is the projected DTO once done; `download` is
// present only on a done build whose result carried an artifact (null when it did
// not); `error` is set only on the "error" status.
export interface ProductionBuildJob {
  id: string;
  status: ProductionBuildJobStatus;
  startedAt: string;
  completedAt?: string;
  targets: ProductionTargetKey[];
  result?: ProductionBuildResult;
  download?: ProductionBuildDownload | null;
  error?: string;
}
