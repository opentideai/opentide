// @layer shared — L0, the OpenTide *open* wire contract for the committed-lock
// REFRESH surface (Milestone 7, Slice 7.2). Type-only; imports NOTHING
// (self-contained; nothing sits below L0). Consumed by the Deno backend
// (re-exported from core/types.ts) and the IDE via the `$shared` alias — the same
// open-wire-contract role shared/production-build.ts plays for the production-build
// surface.
//
// This is the shape a CALLER wants, not the producer's internal LockRefreshReport
// (verification/production-lock-refresh.ts). The pure projection
// projectLockRefreshReport (verification/production-lock-refresh-report.ts) regroups
// the report the producer already returned onto these types — a projection, not a
// re-run: no lock is regenerated and no byte re-hashed here. See
// docs/production-output-contract.md ("Lock refresh API + UI (Slice 7.2)").
//
// The refresh mirrors the production-build job model (POST mints an async job, GET
// polls it) because it is network-bound (a cold `deno install` / `npm install
// --package-lock-only` over the full transitive graph exceeds the control API's 30s
// handler timeout) and single-flight with the build (a refresh writes the very
// deno.lock / package-lock.json a build reads). There is NO download endpoint — a
// refresh's artifact is the committed lock files written into the project, not a
// downloadable tarball.

// The REFRESHABLE targets as wire literals. A strict SUBSET of
// production-build.ts's TARGET_* constants (deno-source / node — NOT binary; a
// compiled binary snapshots the graph and has no lock of its own, it shares
// deno-source's deno.lock). These MATCH the TARGET_* constants; the projection maps
// the constants onto them (a test pins the alignment) so the strings have one source
// of truth without shared/ importing upward into verification/.
export type RefreshTargetKey = "deno-source" | "node";

// One refresh target's outcome as it crosses the wire, mirroring the producer's
// RefreshTargetOutcome verbatim: "refreshed" (produced, validated offline, and
// committed), "skipped" (not selected, or an absent node/npm toolchain), or "failed"
// (generation failed, or the produced lock did not pass its offline post-condition).
// `code` is the reused error code, set only on "failed"; `detail` is the human
// summary, skip reason, or failure message depending on status.
export type RefreshTargetStatus = "refreshed" | "skipped" | "failed";

export interface LockRefreshTargetResult {
  target: RefreshTargetKey;
  status: RefreshTargetStatus;
  code?: string;
  detail: string;
}

// The whole refresh result as it crosses the wire — what the HTTP API (7.2) returns
// and the IDE renders. `ok` is true iff no selected target failed (a skipped target
// is not a failure), mirroring the producer's LockRefreshReport.ok.
export interface LockRefreshResult {
  ok: boolean;
  targets: LockRefreshTargetResult[];
}

// --- Refresh-job envelope -----------------------------------------------------
// A refresh runs as an async job for the same reasons a production build does: it
// is network-bound (beyond the 30s handler timeout) and single-flight with the
// build. A POST mints a job and returns immediately, a GET polls it. Unlike the
// build there is no third GET — the refresh commits lock files into the project
// rather than producing a downloadable tarball.

// The lifecycle of a refresh job. "running": in flight. "done": it ran to a verdict
// — its `result.ok` may be true OR false (a failed target is a result, not an
// error). "error": the refresh could not run at all (an unexpected exception around
// the producer) — it carries a message, no result. refreshLocks itself never throws,
// so "error" only fires on an exception around it.
export type LockRefreshJobStatus = "running" | "done" | "error";

// One refresh job as it crosses the wire. `targets` is the selected set the refresh
// acted on, in canonical order (deno-source, node). `result` is the projected DTO
// once done; `error` is set only on the "error" status.
export interface LockRefreshJob {
  id: string;
  status: LockRefreshJobStatus;
  startedAt: string;
  completedAt?: string;
  targets: RefreshTargetKey[];
  result?: LockRefreshResult;
  error?: string;
}
