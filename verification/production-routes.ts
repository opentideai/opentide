// @layer verification — the production-build HTTP API (Milestone 5, Slice 5.2),
// mounted into the core app via the route-mount hook (OpenTide §3.3) so the
// control server (core, L1) never imports verification (L2). This is the FIRST
// real caller of both runProductionBuild (verification/production-build.ts) and
// projectProductionBuildReport (verification/production-build-report.ts): it runs
// the build, projects the report into the ProductionBuildResult wire DTO, computes
// the one hash the projection deferred (the async SHA-256 over the tarball), and
// serves the result plus a downloadable artifact.
//
// It reaches the app only through the RouteMounter seam (a sibling importing down
// to core/export + core/build is allowed; importing UP from core into verification
// is not), so the layering §3.3 forbids is never crossed — the mounter is added to
// ControlServerOptions.mountRoutes in cli/assembly.ts alongside the verification
// and audit mounters.
//
// Async build-job model. A production build is slow — real subprocess boots
// (`deno task start`, `node main.js`) plus an optional `deno compile` (tens of
// seconds) — while the internal control API enforces a 30s handler timeout, so a
// synchronous request would time out. POST therefore kicks the build off detached
// and returns a job id immediately; GET polls status/result; a third GET streams
// the artifact bytes. Jobs live in an in-memory, per-server Map (a build is a
// transient operation like a dev-server process, not durable state — a kernel
// restart drops jobs and the UI re-triggers).
//
// Single-flight is REQUIRED, not a nicety: runProductionBuild writes to FIXED
// tmp-dir paths under projectDir/dist (.tmp-smoke, .tmp-deno-smoke, .tmp-node-smoke,
// .tmp-binary-smoke), each rmSync-ed at gate start and in finally — two concurrent
// builds on the same project would clobber each other's tmp dirs mid-run. So at
// most one running build per server: a POST while a build runs returns 409.
//
// --- Lock-refresh endpoints (Milestone 7, Slice 7.2) --------------------------
// This module also hosts the committed-lock REFRESH surface — the producer half of
// the lock program (verification/production-lock-refresh.ts, Slice 7.1) made
// reachable from the IDE. Four decisions, resolved before coding:
//
// 1. Async, not synchronous. A refresh is a network install of the FULL transitive
//    graph — a cold `deno install --entrypoint main.ts` (pulling @electric-sql/pglite,
//    a multi-MB wasm) plus `npm install --package-lock-only`, run TWICE (the Node
//    two-pass) and each offline-revalidated. Warm that lock-only resolve is ~1s, but
//    a cold cache's metadata + tarball fetches routinely blow past the internal
//    control API's 30s handler timeout. So — exactly like the production build — POST
//    mints a job and returns 202 immediately; GET polls the envelope.
//
// 2. Single-flight is MUTUALLY EXCLUSIVE with the build, not merely per-refresh. A
//    refresh WRITES <projectDir>/deno.lock + package-lock.json while a build READS
//    them (readCommittedLock/readCommittedNodeLock) and both churn <projectDir>/dist
//    tmp dirs — a refresh mid-build would change the very lock the build is
//    validating. So the refresh is folded into THIS module to share ONE `running`
//    guard with the build: at most one build-or-refresh in flight per server; a POST
//    of either while the other runs is a 409 naming the running op.
//
// 3. NO ledger attestation. A production build is a grounded verifier run and mints
//    attestations (Slice 5.4); a lock refresh is a PRODUCER action (it makes an
//    input), not a verifier run, so it attests nothing — consistent with the 6.x
//    deferral of a dependency_lock attestation kind.
//
// 4. Placement + namespace. POST /api/production/lock-refresh + GET
//    /api/production/lock-refresh/:id, folded into mountProductionRoutes (per #2, to
//    share the single-flight guard) — no new mounter, so core (L1) still reaches this
//    only through the existing RouteMounter seam. There is NO download endpoint: a
//    refresh's artifact is the committed lock written into the project, not a tarball.
import type { Hono } from "hono";
import type { CoreRouteContext } from "../core/route-mount.ts";
import type { Kernel } from "../core/registries.ts";
import { getVersion } from "../core/build.ts";
import { type ExportProjectOptions, sha256Hex } from "../core/export.ts";
import type { AttestationInput } from "../core/types.ts";
import {
  PRODUCTION_CHANGESET_ID,
  PRODUCTION_CHANGESET_TITLE,
  PRODUCTION_SCOPE,
} from "../core/fingerprint.ts";
import { createTimestampedId } from "../core/ids.ts";
import { errorMessage } from "../core/util.ts";
import {
  type BuildTarget,
  GATE_APP_SMOKE,
  GATE_BINARY_SMOKE,
  GATE_DENO_SMOKE,
  GATE_DETERMINISM,
  GATE_MANIFEST,
  GATE_NODE_SMOKE,
  GATE_ROUTE_PARITY,
  GATE_TYPE_CHECK,
  type ProductionBuildOptions,
  type ProductionBuildReport,
  runProductionBuild,
  TARGET_BINARY,
  TARGET_DENO_SOURCE,
  TARGET_NODE,
} from "./production-build.ts";
import { projectProductionBuildReport } from "./production-build-report.ts";
import {
  DEFAULT_REFRESH_TARGETS,
  type LockRefreshReport,
  refreshLocks,
  type RefreshTarget,
} from "./production-lock-refresh.ts";
import { projectLockRefreshReport } from "./production-lock-refresh-report.ts";
import type {
  ProductionBuildDownload,
  ProductionBuildJob,
  ProductionBuildResult,
} from "../shared/production-build.ts";
import type { LockRefreshJob } from "../shared/lock-refresh.ts";

// The build runner the mounter drives, defaulting to the real orchestrator. Kept
// injectable so tests can drive POST → poll → download against a fake that returns
// a canned report instantly (no subprocess), while the real end-to-end path stays
// covered by production-build_test.ts. runProductionBuild's extra optional
// toolchain-probe param is assignable to this narrower shape.
export type ProductionBuildRunner = (
  kernel: Kernel,
  projectDir: string,
  opts?: ProductionBuildOptions,
  targets?: ReadonlySet<BuildTarget>,
) => Promise<ProductionBuildReport>;

// The lock-refresh runner the mounter drives, defaulting to the real producer. Kept
// injectable so tests drive POST → poll against a fake that returns a canned report
// instantly (no network), while the real producer↔gate path stays covered by
// production-lock-refresh_test.ts. refreshLocks's extra optional toolchain-probe
// param is assignable to this narrower shape.
export type LockRefreshRunner = (
  kernel: Kernel,
  projectDir: string,
  opts?: ExportProjectOptions,
  targets?: ReadonlySet<RefreshTarget>,
) => Promise<LockRefreshReport>;

// The job id prefix, mirroring the existing `ev_srcrun_${uuid}` id convention.
const JOB_ID_PREFIX = "prod_";
// A distinct prefix for refresh jobs so a mistyped id never collides with a build.
const REFRESH_JOB_ID_PREFIX = "lockref_";

// The targets a caller may SELECT. deno-source is always validated (never
// selected explicitly), so only node and binary are accepted in the request body;
// anything else is an unknown target.
const SELECTABLE_TARGETS: ReadonlySet<BuildTarget> = new Set([
  TARGET_NODE,
  TARGET_BINARY,
]);

// The canonical order the built targets are reported in on the job envelope
// (deno-source, node, binary) — the same order the projection's per-target rollup
// uses, so the two never disagree.
const TARGET_ORDER: readonly BuildTarget[] = [
  TARGET_DENO_SOURCE,
  TARGET_NODE,
  TARGET_BINARY,
];

// The targets a refresh caller may SELECT (Slice 7.2). Unlike the build (where
// deno-source is always built and never named), a refresh names both explicitly;
// binary is deliberately absent — a compiled binary has no lock of its own. The
// canonical envelope order is deno-source, node.
const REFRESH_SELECTABLE_TARGETS: ReadonlySet<RefreshTarget> = new Set([
  TARGET_DENO_SOURCE,
  TARGET_NODE,
]);
const REFRESH_TARGET_ORDER: readonly RefreshTarget[] = [
  TARGET_DENO_SOURCE,
  TARGET_NODE,
];

// Artifact download wire constants (the /api/export precedent): a tar stream as an
// attachment. The filename mirrors the Deno app convention (<slug>-v<version>.tar).
const TARBALL_CONTENT_TYPE = "application/x-tar";
const TARBALL_FILENAME_FALLBACK_BASE = "genie-project";

// Control-API error messages (terser { error } convention). No magic strings.
const ERR_BUILD_RUNNING = "a production build is already running";
const ERR_REFRESH_RUNNING = "a lock refresh is already running";
const ERR_JOB_NOT_FOUND = "build job not found";
const ERR_REFRESH_JOB_NOT_FOUND = "lock refresh job not found";
const ERR_NO_PROJECT_DIR = "no project directory is loaded";
const ERR_BUILD_INCOMPLETE = "build is not complete";
const ERR_NO_ARTIFACT = "build produced no artifact";
const ERR_NO_REFRESH_TARGETS = "no valid refresh targets selected";

function unknownTargetError(target: string): string {
  return `unknown target "${target}"; valid targets are ${TARGET_NODE}, ${TARGET_BINARY}`;
}

function unknownRefreshTargetError(target: string): string {
  return `unknown target "${target}"; valid targets are ${TARGET_DENO_SOURCE}, ${TARGET_NODE}`;
}

function tarballFilenameBase(projectName: string): string {
  return projectName.toLowerCase().replace(/[^a-z0-9-]/g, "-") ||
    TARBALL_FILENAME_FALLBACK_BASE;
}

// The single-flight guard is SHARED across the build and refresh endpoints (Slice
// 7.2 decision #2): a build reads the locks a refresh writes, so at most one of
// either runs at a time. The 409 message names the operation actually in flight, so
// a build-blocks-build 409 stays "a production build is already running" (unchanged)
// while a build blocked by a refresh reads "a lock refresh is already running".
type RunKind = "build" | "refresh";
interface RunningOp {
  id: string;
  kind: RunKind;
}

function busyError(running: RunningOp): string {
  return running.kind === "build" ? ERR_BUILD_RUNNING : ERR_REFRESH_RUNNING;
}

// The internal job record: the wire envelope plus the retained release-candidate
// tarball bytes for the download endpoint. The bytes are NEVER serialized (the
// envelope type has no tarball field, and the GET handler returns record.job).
interface JobRecord {
  job: ProductionBuildJob;
  tarball: Uint8Array | null;
}

// --- Ledger attestations (Slice 5.4) ------------------------------------------
// A passing production build is a grounded verifier run (real subprocess boots +
// a deterministically re-hashed manifest), so it mints durable attestations into
// the verification ledger — "we built and smoke-verified a release candidate
// against source fingerprint X on date Y" becomes queryable history. Attestations
// are derived ONLY from the real gate outcomes in ProductionBuildResult, never
// from request input — the property that makes them tamper-proof. See
// docs/production-output-contract.md ("Ledger attestations (Slice 5.4)").

// Whether a named gate is present in the flat gate list AND passed. On an ok build
// every gate that ran passed and none failed (the pipeline stops at the first
// failure), so a skipped or unrun gate reads as not-passed here.
function gatePassed(result: ProductionBuildResult, gate: string): boolean {
  return result.gates.some((g) => g.gate === gate && g.status === "passed");
}

// The comma-joined targets whose per-target rollup passed — the human "targets
// built" fragment several summaries share.
function builtTargets(result: ProductionBuildResult): string {
  return result.targets
    .filter((t) => t.status === "passed")
    .map((t) => t.target)
    .join(", ");
}

/**
 * Map a production-build DTO to the ledger attestations it earns (Slice 5.4).
 *
 * Pure and side-effect-free so it can be unit-tested in isolation. Returns `[]`
 * for a non-ok build (a failed build produces no artifact and attests nothing) or
 * one with no source fingerprint (an ok build always has one — a defensive
 * guard). Otherwise one attestation per kind whose mapped gate(s) passed:
 *   - production_export ← manifest + determinism + type check + app smoke
 *   - route_smoke       ← deno smoke (and node smoke too, when node was built)
 *   - target_parity     ← route parity
 *   - binary_smoke      ← binary smoke
 *   - artifact_hash     ← the build carried an artifact (all gates passed)
 *
 * `tarballSha256` is the endpoint-computed digest folded into the artifact_hash
 * summary; the DTO does not carry it (it lives with the retained bytes), so it is
 * passed in rather than read off `result`.
 */
export function productionAttestationInputs(
  result: ProductionBuildResult,
  tarballSha256: string | null,
): AttestationInput[] {
  if (!result.ok || result.sourceFingerprint === null) return [];
  const built = builtTargets(result);
  const builtSuffix = built ? ` (${built})` : "";
  const base: Omit<AttestationInput, "kind" | "summary"> = {
    status: "passed",
    scope: PRODUCTION_SCOPE,
    fingerprint: result.sourceFingerprint,
  };
  const inputs: AttestationInput[] = [];

  if (
    gatePassed(result, GATE_MANIFEST) &&
    gatePassed(result, GATE_DETERMINISM) &&
    gatePassed(result, GATE_TYPE_CHECK) &&
    gatePassed(result, GATE_APP_SMOKE)
  ) {
    inputs.push({
      ...base,
      kind: "production_export",
      summary:
        `Production export verified: manifest, determinism, type check, and app smoke passed${builtSuffix}.`,
    });
  }

  // route_smoke: the deno-target boot gate passed, and — when node was also built
  // — its boot gate too. A non-selected node smoke is skipped on an ok build, so
  // "node built" means its gate ran (passed, since nothing failed on an ok build).
  const nodeBuilt = result.gates.some(
    (g) => g.gate === GATE_NODE_SMOKE && g.status !== "skipped",
  );
  if (
    gatePassed(result, GATE_DENO_SMOKE) &&
    (!nodeBuilt || gatePassed(result, GATE_NODE_SMOKE))
  ) {
    inputs.push({
      ...base,
      kind: "route_smoke",
      summary:
        `Exported app booted and served routes over real HTTP${builtSuffix}.`,
    });
  }

  if (gatePassed(result, GATE_ROUTE_PARITY)) {
    inputs.push({
      ...base,
      kind: "target_parity",
      summary: `Cross-target route parity verified${builtSuffix}.`,
    });
  }

  if (gatePassed(result, GATE_BINARY_SMOKE)) {
    inputs.push({
      ...base,
      kind: "binary_smoke",
      summary: "Compiled binary booted and served routes over real HTTP.",
    });
  }

  if (result.artifact) {
    const fileCount = result.artifact.files.length;
    const digest = tarballSha256 ? `, tarball sha256 ${tarballSha256}` : "";
    inputs.push({
      ...base,
      kind: "artifact_hash",
      summary: `Release artifact hashed: ${fileCount} file(s)${digest}.`,
    });
  }

  return inputs;
}

/**
 * Map a finished refresh report to the ledger attestations it earns (Slice 7.4).
 *
 * Pure and side-effect-free (unit-tested like productionAttestationInputs). One
 * `lock_refresh` attestation per REFRESHED target — a skipped or failed target
 * attests nothing (mirroring how a failed build gate attests nothing). The
 * `fingerprint` is the SHA-256 of the exact committed lock bytes (the refresh's
 * `lock.sha256`), so the attestation is content-addressed to the lock it asserts;
 * the `summary` reuses the outcome's human `detail` plus that hash. All are
 * "production"-scoped and point-in-time, exactly like the build kinds.
 *
 * A "refreshed" outcome always carries `lock` (the producer sets it on success), so
 * the `!t.lock` guard is defensive — a lock-less "refreshed" outcome is skipped
 * rather than minting a fingerprint-less attestation.
 */
export function lockRefreshAttestationInputs(
  report: LockRefreshReport,
): AttestationInput[] {
  const inputs: AttestationInput[] = [];
  for (const t of report.targets) {
    if (t.status !== "refreshed" || !t.lock) continue;
    inputs.push({
      kind: "lock_refresh",
      status: "passed",
      scope: PRODUCTION_SCOPE,
      fingerprint: t.lock.sha256,
      summary: `${t.detail} sha256 ${t.lock.sha256}.`,
    });
  }
  return inputs;
}

// Best-effort: write a set of attestation inputs into the verification ledger.
// Never throws to its caller — a ledger-write failure must not change the job's
// terminal state (the build/refresh result stays authoritative; attestations are
// purely additive). Attaches to the active in_progress changeset when one exists,
// else to a synthetic sentinel changeset (the ledger's changeset_id is plain text,
// no FK). Shared by the build (Slice 5.4) and lock-refresh (Slice 7.4) mint paths.
// `context` names the source only for the failure log line.
async function recordAttestationsBestEffort(
  kernel: Kernel,
  inputs: AttestationInput[],
  context: string,
): Promise<void> {
  try {
    if (inputs.length === 0) return;
    // A project has one writer at a time (changesets.create refuses a second
    // session), so the project's active changeset is the one this belongs to.
    const active = await kernel.changesets.getActive();
    if (active?.status === "in_progress") {
      for (const att of inputs) {
        await kernel.changesets.recordAttestation(active.id, att);
      }
    } else {
      for (const att of inputs) {
        await kernel.changesets.recordLedgerEntry({
          ...att,
          id: createTimestampedId("att"),
          createdAt: new Date().toISOString(),
          changesetId: PRODUCTION_CHANGESET_ID,
          changesetTitle: PRODUCTION_CHANGESET_TITLE,
        });
      }
    }
  } catch (err) {
    kernel.log.log(
      "warn",
      "system",
      `Recording ${context} attestations failed: ${errorMessage(err)}`,
    );
  }
}

// Mint a passing build's attestations (Slice 5.4). Mirrors the
// captureAttestationEvidenceDocument guard precedent.
function recordProductionAttestations(
  kernel: Kernel,
  result: ProductionBuildResult,
  tarballSha256: string | null,
): Promise<void> {
  return recordAttestationsBestEffort(
    kernel,
    productionAttestationInputs(result, tarballSha256),
    "production-build",
  );
}

// Mint a refresh's per-target attestations (Slice 7.4).
function recordLockRefreshAttestations(
  kernel: Kernel,
  report: LockRefreshReport,
): Promise<void> {
  return recordAttestationsBestEffort(
    kernel,
    lockRefreshAttestationInputs(report),
    "lock-refresh",
  );
}

/**
 * Mount the production-build (Slice 5.2) and lock-refresh (Slice 7.2) endpoints
 * onto the core Hono app. Both live here because they SHARE one single-flight guard
 * (a refresh writes the very locks a build reads — Slice 7.2 decision #2), so at
 * most one build-or-refresh runs per server.
 *
 * Build:
 * - `POST /api/production/build` — body { targets?: ("node"|"binary")[],
 *   includeEnvFile?, includeSeedData?, includeMigrations?,
 *   includeReferenceSeeds?, strictRouteSmoke? }. Validates targets
 *   (unknown → 400), builds the target set (deno-source always included), and —
 *   if nothing is already running (single-flight, 409 otherwise) — mints a job,
 *   kicks off the build detached, and returns 202 with the running envelope.
 * - `GET /api/production/build/:id` — the job envelope; 404 on unknown id.
 * - `GET /api/production/build/:id/download` — streams the retained tarball
 *   (application/x-tar attachment); 404 unknown id, 409 if the job isn't done or
 *   produced no artifact.
 *
 * Lock refresh (network-allowed PRODUCER — writes deno.lock / package-lock.json into
 * the project; no download. Since Slice 7.4 each REFRESHED target mints a
 * `lock_refresh` ledger attestation fingerprinted to the committed lock's SHA-256):
 * - `POST /api/production/lock-refresh` — body { targets?: ("deno-source"|"node")[] }
 *   (default: both). Validates targets (unknown → 400; none valid → 400), and — if
 *   nothing is already running (shared single-flight, 409 otherwise) — mints a job,
 *   kicks off the refresh detached, and returns 202.
 * - `GET /api/production/lock-refresh/:id` — the job envelope; 404 on unknown id.
 *
 * `runBuild` / `runRefresh` are injected (defaults: the real runProductionBuild /
 * refreshLocks) so tests drive the job lifecycle without a real subprocess.
 */
export function mountProductionRoutes(
  app: Hono,
  core: CoreRouteContext,
  runBuild: ProductionBuildRunner = runProductionBuild,
  runRefresh: LockRefreshRunner = refreshLocks,
): void {
  // Per-server, ephemeral job registries + a SHARED single-flight guard. Owned by
  // this closure: a kernel restart drops jobs (the UI re-triggers), and at most one
  // build-or-refresh runs at a time (fixed tmp-dir paths + the build↔refresh lock
  // read/write hazard forbid overlap).
  const jobs = new Map<string, JobRecord>();
  const refreshJobs = new Map<string, LockRefreshJob>();
  let running: RunningOp | null = null;

  app.post("/api/production/build", async (c) => {
    const guard = core.requireKernel(c);
    if (guard) return guard;

    const body = await c.req.json<{
      targets?: string[];
      includeEnvFile?: boolean;
      includeSeedData?: boolean;
      includeMigrations?: boolean;
      includeReferenceSeeds?: boolean;
      strictRouteSmoke?: boolean;
    }>().catch(() => null);

    // Validate the optional target selection against the selectable set;
    // deno-source is always built and is never named explicitly.
    const selected: BuildTarget[] = [];
    for (const target of body?.targets ?? []) {
      if (!SELECTABLE_TARGETS.has(target as BuildTarget)) {
        return c.json({ error: unknownTargetError(target) }, 400);
      }
      selected.push(target as BuildTarget);
    }
    const targetSet = new Set<BuildTarget>([TARGET_DENO_SOURCE, ...selected]);

    // Single-flight (shared with refresh): refuse while anything runs (fixed
    // tmp-dir paths / lock hazard). This check → the `running` assignment below is
    // await-free, so two concurrent POSTs cannot both pass it.
    if (running !== null) {
      return c.json({ error: busyError(running), id: running.id }, 409);
    }

    const kernel = core.kernel();
    const projectDir = kernel.projectDir;
    if (projectDir === null) {
      return c.json({ error: ERR_NO_PROJECT_DIR }, 400);
    }

    // Read the project identity for production metadata and the download filename.
    // includeManifest is NOT set here — runProductionBuild forces it.
    const project = core.project();
    const version = getVersion(projectDir);
    const opts: ProductionBuildOptions = {
      includeEnvFile: body?.includeEnvFile === true,
      includeSeedData: body?.includeSeedData === true,
      includeMigrations: body?.includeMigrations !== false,
      includeReferenceSeeds: body?.includeReferenceSeeds !== false,
      strictRouteSmoke: body?.strictRouteSmoke === true,
      projectName: project.name,
      projectVersion: version,
    };
    const filenameBase = tarballFilenameBase(project.name);

    const id = `${JOB_ID_PREFIX}${crypto.randomUUID()}`;
    const record: JobRecord = {
      job: {
        id,
        status: "running",
        startedAt: new Date().toISOString(),
        targets: TARGET_ORDER.filter((t) => targetSet.has(t)),
      },
      tarball: null,
    };
    jobs.set(id, record);
    running = { id, kind: "build" };

    // Detached: run the build and transition the job on completion — do NOT await
    // (the response returns immediately). The whole body is wrapped so an
    // unexpected throw leaves the job "error", never stranded "running";
    // runProductionBuild itself never throws, so "error" only fires on an
    // exception around it. The finally always releases the single-flight lock.
    void (async () => {
      try {
        const report = await runBuild(kernel, projectDir, opts, targetSet);
        const result = projectProductionBuildReport(report);
        // The tarball digest the projection deferred, computed here where the
        // bytes live. Present only when the build produced an artifact (all gates
        // passed); a gate-failed build carries none.
        let download: ProductionBuildDownload | null = null;
        if (report.artifact) {
          const tarball = report.artifact.tarball;
          record.tarball = tarball;
          download = {
            tarballSha256: await sha256Hex(tarball),
            filename: `${filenameBase}-v${version}.tar`,
            bytes: tarball.byteLength,
          };
        }
        record.job = {
          ...record.job,
          status: "done",
          completedAt: new Date().toISOString(),
          result,
          download,
        };
        // Slice 5.4: a passing build is a grounded verifier run — mint its ledger
        // attestations. recordProductionAttestations is self-guarded (best-effort,
        // never throws), so this is purely additive and can never flip the job's
        // terminal state, which is already "done" above.
        await recordProductionAttestations(
          kernel,
          result,
          download?.tarballSha256 ?? null,
        );
      } catch (err) {
        record.job = {
          ...record.job,
          status: "error",
          completedAt: new Date().toISOString(),
          error: err instanceof Error ? err.message : String(err),
        };
      } finally {
        running = null;
      }
    })();

    return c.json(record.job, 202);
  });

  app.get("/api/production/build/:id", (c) => {
    const guard = core.requireKernel(c);
    if (guard) return guard;
    const record = jobs.get(c.req.param("id"));
    if (!record) return c.json({ error: ERR_JOB_NOT_FOUND }, 404);
    return c.json(record.job);
  });

  app.get("/api/production/build/:id/download", (c) => {
    const guard = core.requireKernel(c);
    if (guard) return guard;
    const record = jobs.get(c.req.param("id"));
    if (!record) return c.json({ error: ERR_JOB_NOT_FOUND }, 404);
    // A running or errored job has no artifact to serve; a done-but-gate-failed
    // build has none either. Both are 409 (the id is known — not a 404).
    if (record.job.status !== "done") {
      return c.json({ error: ERR_BUILD_INCOMPLETE }, 409);
    }
    if (record.tarball === null || !record.job.download) {
      return c.json({ error: ERR_NO_ARTIFACT }, 409);
    }
    return new Response(record.tarball as unknown as BodyInit, {
      headers: {
        "Content-Type": TARBALL_CONTENT_TYPE,
        "Content-Disposition":
          `attachment; filename=${record.job.download.filename}`,
      },
    });
  });

  // --- Lock refresh (Slice 7.2) ------------------------------------------------

  app.post("/api/production/lock-refresh", async (c) => {
    const guard = core.requireKernel(c);
    if (guard) return guard;

    const body = await c.req.json<{ targets?: string[] }>().catch(() => null);

    // A refresh names BOTH targets explicitly (unlike the build). An omitted
    // `targets` (undefined) defaults to both; an explicit but empty/all-invalid set
    // is a 400, not a silent no-op. `binary` is rejected — it has no lock.
    let targetSet: ReadonlySet<RefreshTarget>;
    if (body?.targets === undefined) {
      targetSet = DEFAULT_REFRESH_TARGETS;
    } else {
      const selected = new Set<RefreshTarget>();
      for (const target of body.targets) {
        if (!REFRESH_SELECTABLE_TARGETS.has(target as RefreshTarget)) {
          return c.json({ error: unknownRefreshTargetError(target) }, 400);
        }
        selected.add(target as RefreshTarget);
      }
      if (selected.size === 0) {
        return c.json({ error: ERR_NO_REFRESH_TARGETS }, 400);
      }
      targetSet = selected;
    }

    // Single-flight (shared with the build): a refresh writes the locks a build
    // reads, so they must never overlap. Await-free check → assignment.
    if (running !== null) {
      return c.json({ error: busyError(running), id: running.id }, 409);
    }

    const kernel = core.kernel();
    const projectDir = kernel.projectDir;
    if (projectDir === null) {
      return c.json({ error: ERR_NO_PROJECT_DIR }, 400);
    }

    // The produced lock must match the bytes the build validates, so the refresh
    // resolves over the SAME project version the build uses (getVersion); projectName
    // is left to the producer's default, like the build endpoint.
    const opts: ExportProjectOptions = {
      projectVersion: getVersion(projectDir),
    };

    const id = `${REFRESH_JOB_ID_PREFIX}${crypto.randomUUID()}`;
    let job: LockRefreshJob = {
      id,
      status: "running",
      startedAt: new Date().toISOString(),
      targets: REFRESH_TARGET_ORDER.filter((t) => targetSet.has(t)),
    };
    refreshJobs.set(id, job);
    running = { id, kind: "refresh" };

    // Detached: run the refresh and transition the job on completion — do NOT await.
    // refreshLocks never throws (a failed target is an ok:false report, not an
    // exception), so "error" only fires on an unexpected throw around it. The finally
    // always releases the shared single-flight lock.
    void (async () => {
      try {
        const report = await runRefresh(kernel, projectDir, opts, targetSet);
        job = {
          ...job,
          status: "done",
          completedAt: new Date().toISOString(),
          result: projectLockRefreshReport(report),
        };
        // Slice 7.4: each refreshed target is a grounded verifier run (the producer
        // proved the committed lock offline-valid before writing it) — mint its
        // ledger attestation. Self-guarded (best-effort, never throws), so it is
        // purely additive and can never flip the job's terminal state (already
        // "done" above). A failed/skipped target attests nothing.
        await recordLockRefreshAttestations(kernel, report);
      } catch (err) {
        job = {
          ...job,
          status: "error",
          completedAt: new Date().toISOString(),
          error: err instanceof Error ? err.message : String(err),
        };
      } finally {
        refreshJobs.set(id, job);
        running = null;
      }
    })();

    return c.json(job, 202);
  });

  app.get("/api/production/lock-refresh/:id", (c) => {
    const guard = core.requireKernel(c);
    if (guard) return guard;
    const job = refreshJobs.get(c.req.param("id"));
    if (!job) return c.json({ error: ERR_REFRESH_JOB_NOT_FOUND }, 404);
    return c.json(job);
  });
}
