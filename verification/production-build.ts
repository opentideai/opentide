// @layer verification — Milestone 2 production-build orchestrator (the plan's
// Phase 4, "Split generation from production validation"). It assembles the pure
// gates that exist today into ONE ordered pipeline over a single release-candidate
// export, so a later API/UI/ledger slice can call it. It does not build the API
// endpoint, the UI, ledger integration, or any target-specific packaging.
//
// The gates run in the Phase-4 order — manifest → determinism → type check →
// dependency lock → app smoke → deno smoke — and the pipeline STOPS at the first failure: a broken
// export makes later gates meaningless. A failing gate is an EXPECTED outcome
// (ok: false in the report), not an error, so the orchestrator returns no Result
// error and never throws, consistent with the gates-never-throw philosophy of
// production-manifest.ts.
//
// deno_smoke is the first Milestone-3 target gate: it boots the exported app as a
// real child process over its generated `deno task start` and probes it over real
// HTTP, exercising the production entrypoint the in-process app_smoke can't. Its
// boot/probe/contract machinery is shared with the app/Node gates via
// verification/production-smoke.ts (the extraction the deno_smoke slice deferred,
// forced by the Node-target gate below becoming the second consumer).
import { rmSync } from "node:fs";
import { join } from "node:path";
import {
  binaryCompileArgs,
  binaryOutputFilename,
  binaryRuntimeIncludePaths,
  buildNodeFiles,
  checkExportTypes,
  defaultBinaryCompileTarget,
  type ExportTypeCheckIssue,
  type ExportTypeCheckResult,
  writeExportFiles,
} from "../core/build.ts";
import {
  APP_RUNTIME_PERMISSIONS,
  DEFAULT_APP_NAME,
  DEFAULT_APP_VERSION,
  type ExportFile,
  exportProject,
  type ExportProjectOptions,
  MANIFEST_PATH,
} from "../core/export.ts";
import type { Kernel } from "../core/registries.ts";
import type { Result } from "../core/types.ts";
import {
  denoToolchainFailure,
  resolveDenoToolchain,
} from "../core/deno-toolchain.ts";
import {
  verifyExportDeterminism,
  verifyManifest,
} from "./production-manifest.ts";
import {
  EXPORT_DEPENDENCY_LOCK_FAILED,
  NO_COMMITTED_LOCK_DETAIL,
  readCommittedLock,
  verifyDependencyLock,
} from "./production-lock.ts";
import {
  EXPORT_NODE_DEPENDENCY_LOCK_FAILED,
  NO_COMMITTED_NODE_LOCK_DETAIL,
  readCommittedNodeLock,
  verifyNodeDependencyLock,
} from "./production-node-lock.ts";
import {
  cancelStreams,
  checkOneRouteSmokeContract,
  checkSmokeContract,
  checkVersionCommand,
  drainStderr,
  errorMessage,
  HEALTH_ROUTE,
  OPENAPI_FILE,
  OPENAPI_ROUTE,
  probeRouteSmoke,
  probeSmokeOverHttp,
  reapChild,
  type RouteProbeResult,
  SERVER_READY_TIMEOUT_MS,
  type SmokeOutcome,
  VERSION_RUN_TIMEOUT_MS,
  waitForReadyUrl,
} from "./production-smoke.ts";
import {
  buildRouteSmokePlan,
  isPlatformRoute,
  type SkippedRoute,
} from "./route-smoke-plan.ts";
import {
  comparableTargetRouteResults,
  compareTargetParity,
  type TargetRouteResults,
} from "./route-parity.ts";

// --- Gate identity + error codes (no magic strings) ---------------------------

// Gate names are stable identifiers a report consumer (API/UI/ledger) keys on.
export const GATE_MANIFEST = "manifest";
export const GATE_DETERMINISM = "determinism";
export const GATE_TYPE_CHECK = "type_check";
// The committed-lock validation gate (Milestone 6, Slice 6.1). A deno-source gate
// that always runs but self-skips when the export carries no committed deno.lock.
// See verification/production-lock.ts.
export const GATE_DEPENDENCY_LOCK = "dependency_lock";
export const GATE_APP_SMOKE = "app_smoke";
// Target-scoped: the real-process Deno-target boot gate (Milestone 3). Its
// Node/binary siblings will seat next to it here as they land.
export const GATE_DENO_SMOKE = "deno_smoke";
// The committed Node-lock validation gate (Milestone 6, Slice 6.2). A NODE-scoped
// gate (opt-in on TARGET_NODE, behind the node/npm toolchain preflight) that
// self-skips when the Node artifact carries no committed package-lock.json. It is
// sequenced BEFORE node_smoke — a locked-but-unbootable artifact should not smoke.
// See verification/production-node-lock.ts.
export const GATE_NODE_DEPENDENCY_LOCK = "node_dependency_lock";
// The real-process Node-target boot gate (Milestone 3, second slice). Built and
// tested but not yet wired into runProductionBuild — see runNodeSmokeGate.
export const GATE_NODE_SMOKE = "node_smoke";
// The real-process binary-target boot gate (Milestone 3, third slice). Wired into
// runProductionBuild as an opt-in per-target gate (Slice 3.5.2) — see
// runBinarySmokeGate and the targets parameter.
export const GATE_BINARY_SMOKE = "binary_smoke";
// The cross-target route parity gate (Milestone 4, Slice 4.4). Appended AFTER
// binary_smoke because it compares whatever target results the prior gates
// retained. It is NOT wired to the targets set — it self-skips when fewer than two
// targets actually produced route results. See runProductionBuild's parity step.
export const GATE_ROUTE_PARITY = "route_parity";

// --- Build-target identity (no magic strings) ---------------------------------

// The selectable production targets. deno-source is ALWAYS validated (the five
// core gates); node and binary are opt-in per-target smoke gates. These literals
// are the single source of truth for target identity — no bare target strings
// elsewhere. Callers pass a ReadonlySet<BuildTarget> to runProductionBuild.
export const TARGET_DENO_SOURCE = "deno-source";
export const TARGET_NODE = "node";
export const TARGET_BINARY = "binary";
export type BuildTarget =
  | typeof TARGET_DENO_SOURCE
  | typeof TARGET_NODE
  | typeof TARGET_BINARY;

export interface ProductionBuildOptions extends ExportProjectOptions {
  strictRouteSmoke?: boolean;
}

// The skip reason for a target the caller did not select. Kept specific to
// non-selection: the toolchain-absent case (Slice 3.5.3) has its OWN reason below.
// Exported so tests can assert the skip detail without a magic string.
export const TARGET_NOT_SELECTED_DETAIL = "target not selected";

// The skip reason for a SELECTED target whose toolchain is absent (Slice 3.5.3).
// Distinct from TARGET_NOT_SELECTED_DETAIL: this target WAS selected, but its
// toolchain (node + npm) isn't on PATH, so the gate is skipped rather than failed.
// A single fixed reason covers either binary being missing. Exported so tests can
// assert it without a magic string.
export const NODE_TOOLCHAIN_ABSENT_DETAIL = "node/npm not found on PATH";

// How long each toolchain-probe `--version` spawn may run before it is aborted and
// treated as "toolchain absent". A `--version` returns near-instantly; a few
// seconds is ample and keeps a wedged binary from hanging the preflight.
const TOOLCHAIN_PROBE_TIMEOUT_MS = 5_000;

// The error codes this slice introduces. The manifest/determinism codes
// (MANIFEST_*, EXPORT_NONDETERMINISTIC) are reused straight from the gates in
// production-manifest.ts rather than re-declared here.
export const EXPORT_TYPE_CHECK_FAILED = "EXPORT_TYPE_CHECK_FAILED";
export const EXPORT_APP_SMOKE_FAILED = "EXPORT_APP_SMOKE_FAILED";
// Re-exported from production-lock.ts so consumers/tests read every gate's
// umbrella failure code from this one module (production-lock.ts owns it to keep
// the gate module import-cycle-free).
export { EXPORT_DEPENDENCY_LOCK_FAILED };
// Re-exported from production-node-lock.ts for the same reason (that gate module
// owns it to stay import-cycle-free).
export { EXPORT_NODE_DEPENDENCY_LOCK_FAILED };
export const EXPORT_DENO_SMOKE_FAILED = "EXPORT_DENO_SMOKE_FAILED";
export const EXPORT_NODE_SMOKE_FAILED = "EXPORT_NODE_SMOKE_FAILED";
export const EXPORT_BINARY_SMOKE_FAILED = "EXPORT_BINARY_SMOKE_FAILED";
export const EXPORT_ROUTE_PARITY_FAILED = "EXPORT_ROUTE_PARITY_FAILED";

// The route_parity skip reason: it self-skips when fewer than two targets actually
// produced route results (the default deno-source-only run, or a run where
// node/binary skipped for non-selection or an absent toolchain), so there is
// nothing to compare. Exported so tests can assert the skip without a magic string.
export const ROUTE_PARITY_SINGLE_TARGET_DETAIL =
  "route parity needs ≥2 probed targets";

// How many failing type-check issues to inline into a gate's detail message
// before summarizing the rest as a count.
const MAX_REPORTED_ISSUES = 3;

// --- App-smoke gate constants -------------------------------------------------

// The smoke harness is a tiny Deno entry written alongside main.ts. Because IT is
// the entrypoint (not main.ts), main.ts's isEntrypoint() stays false and no server
// binds — createApp() is imported and driven via app.fetch() instead.
const SMOKE_HARNESS_PATH = "__smoke.ts";
const SMOKE_TMP_DIR = ".tmp-smoke";

// Run the harness with the same permission set the exported app uses. That set is
// defined once, in core/export.ts, and the generated deno.json `start` task and
// binaryCompileArgs both build from it — this used to be a third hand-maintained
// copy, which is exactly how the gate came to smoke-test a permission set the
// shipped binary did not have. --no-check because the type-check gate has already
// type-checked this exact export; re-checking here is redundant cost.

// --- App-target boot-flag constants -------------------------------------------

// The exact CLI flags the generated entrypoint understands (see core/export.ts's
// generated server runtime): print the version and exit, or start on a random
// available port. Target-neutral — the same flag parsing runs under `deno task
// start` and `node main.js` — so both the Deno and Node boot gates share them.
const APP_VERSION_FLAG = "--version";
const APP_RANDOM_PORT_FLAG = "--random-port";

// --- Deno-smoke gate constants ------------------------------------------------

// This gate boots the REAL entrypoint (main.ts) as a child process over the
// generated `deno task start`, so it has its own tmp dir (distinct from
// app-smoke's) and speaks to the app over real TCP rather than app.fetch().
const DENO_SMOKE_TMP_DIR = ".tmp-deno-smoke";

// --- Node-smoke gate constants ------------------------------------------------

// This gate boots the transpiled Node artifact (`node main.js`) as a child
// process, so it has its own tmp dir (distinct from every other smoke dir).
const NODE_SMOKE_TMP_DIR = ".tmp-node-smoke";

// The binaries the Node gate shells out to and the transpiled entry name.
const NODE_BIN = "node";
const NPM_BIN = "npm";
const MAIN_JS = "main.js";

// The Node gate proves a FROZEN install in two steps, both against its own tmp
// dir. Step 1 (`npm install --package-lock-only`) resolves the tree and writes a
// package-lock.json WITHOUT building node_modules — this is the ephemeral lock the
// export deliberately does not ship: a real committed lock carries integrity
// hashes and resolved registry URLs for the whole transitive tree, which cannot be
// produced purely (no network) at export time, and shipping one would force
// verifyExportDeterminism to byte-cover it — a much larger slice. Step 2
// (`npm ci`) wipes node_modules and installs STRICTLY from that lock, failing if
// the lock and package.json disagree or the lock is absent, which exercises the
// real `npm ci` code path a Node user's CI runs. --ignore-scripts is kept on both
// (pglite/hono/node-server have no native postinstall) so the safety posture does
// not regress. These are DELIBERATELY no longer identical to core/build_test.ts's
// throwaway `npm install` (which only validates transpile/boot): that test checks
// the artifact loads; this gate checks frozen-install integrity — the divergence
// is the point, not drift.
// Exported so the network-allowed lock-refresh producer
// (verification/production-lock-refresh.ts) generates the committed Node lock
// with the EXACT same resolver invocation this gate uses to make its ephemeral
// one — "produce the input the gate later validates" reuses the gate's own
// command, so producer and validator can never drift on how the tree is resolved.
export const NPM_LOCK_ONLY_ARGS = [
  "install",
  "--package-lock-only",
  "--ignore-scripts",
  "--no-audit",
  "--no-fund",
] as const;
const NPM_CI_ARGS = [
  "ci",
  "--ignore-scripts",
  "--no-audit",
  "--no-fund",
] as const;

// --- Binary-smoke gate constants ----------------------------------------------

// This gate `deno compile`s the export into a standalone native binary and runs
// THAT executable directly (`./app`), so it has its own tmp dir (distinct from
// every other smoke dir). A native compile snapshots the whole runtime into the
// bundle, so it is far slower than a source spawn — the compile timeout is
// generous accordingly (tens of seconds is normal).
const BINARY_SMOKE_TMP_DIR = ".tmp-binary-smoke";
const BINARY_COMPILE_TIMEOUT_MS = 180_000;

// --- Report shape -------------------------------------------------------------

// The three terminal states of a gate. These literals are the single source of
// truth for the values — no bare "passed"/"failed"/"skipped" strings elsewhere.
// "skipped" means the gate did not run and that is NOT a failure (a not-selected
// target, or a selected target whose toolchain is absent); its producers are
// target selection (Slice 3.5.2) and toolchain preflight (Slice 3.5.3), both now
// live in the pipeline.
export type GateStatus = "passed" | "failed" | "skipped";

// The outcome of one gate: its name, tri-state status, the reused error code
// (set only on "failed"), and a human-readable detail — the success summary, the
// failure message, or the skip reason depending on status.
//
// NOTE: this is NOT the same type as agent-loop's `GateOutcome`
// ({ passed: boolean; diagnostics: string }); that is an unrelated verification
// primitive in a different layer. This one is the production-build report shape.
export interface GateOutcome {
  gate: string;
  status: GateStatus;
  code?: string;
  detail: string;
}

export type RouteSmokeStatus = "passed" | "warning";

export interface RouteSmokeFailure {
  target: BuildTarget;
  method: string;
  path: string;
  expectedStatus: number;
  actualStatus: number | null;
  detail: string;
  bodySnippet?: string;
}

export interface TargetRouteSmokeDiagnostic {
  target: BuildTarget;
  status: RouteSmokeStatus;
  routesProbed: number;
  routesFailed: number;
  skipped: readonly SkippedRoute[];
  failures: readonly RouteSmokeFailure[];
}

export interface ProductionRouteSmokeDiagnostic {
  status: RouteSmokeStatus;
  routesProbed: number;
  routesFailed: number;
  skipped: number;
  failures: readonly RouteSmokeFailure[];
}

// The orchestrator's whole result. `sourceFingerprint` comes from the manifest
// gate's success payload (null if that gate never succeeded). `artifact` — the
// in-memory release candidate — is present only when every gate passed.
export interface ProductionBuildReport {
  ok: boolean;
  sourceFingerprint: string | null;
  gates: GateOutcome[];
  routeSmoke?: ProductionRouteSmokeDiagnostic;
  artifact?: { files: ExportFile[]; tarball: Uint8Array };
}

// --- Type-check gate wrapper --------------------------------------------------

// Wrap core/build.ts's checkExportTypes as a Result-returning gate. On success it
// passes the file count through; on a type error it returns EXPORT_TYPE_CHECK_FAILED
// with the first few issues (file:line — message) plus the total count. If the
// subprocess itself can't spawn (e.g. no --allow-run), that is caught and mapped
// to the same failure code — the gate never throws.
export async function runTypeCheckGate(
  kernel: Kernel,
  projectDir: string,
  opts?: ExportProjectOptions,
): Promise<Result<{ fileCount: number }>> {
  let result: ExportTypeCheckResult;
  try {
    result = await checkExportTypes(kernel, projectDir, opts);
  } catch (err) {
    return {
      ok: false,
      error: {
        code: EXPORT_TYPE_CHECK_FAILED,
        message: `Export type check could not run: ${
          err instanceof Error ? err.message : String(err)
        }`,
      },
    };
  }
  if (result.ok) return { ok: true, data: { fileCount: result.fileCount } };
  return {
    ok: false,
    error: {
      code: EXPORT_TYPE_CHECK_FAILED,
      message: formatTypeCheckFailure(result),
    },
  };
}

function formatTypeCheckFailure(result: ExportTypeCheckResult): string {
  const { issues } = result;
  const header = `Export type check failed with ${issues.length} issue${
    issues.length === 1 ? "" : "s"
  }.`;
  const shown = issues.slice(0, MAX_REPORTED_ISSUES).map(formatIssue);
  if (shown.length === 0) {
    // No structured issues parsed (e.g. a compiler crash): fall back to the raw
    // check output so the failure is still actionable.
    return result.output ? `${header}\n${result.output}` : header;
  }
  const remaining = issues.length - shown.length;
  const more = remaining > 0 ? `\n… and ${remaining} more.` : "";
  return `${header}\n${shown.join("\n")}${more}`;
}

function formatIssue(issue: ExportTypeCheckIssue): string {
  return `${issue.file}:${issue.line} — ${issue.message}`;
}

// --- App-smoke gate wrapper ---------------------------------------------------

// The typed success payload: the observed /_health status and whether the
// /openapi.json contract was checked (only when the export emitted openapi.json).
export interface AppSmokeVerification {
  healthStatus: number;
  openApiChecked: boolean;
}

// Emit the harness source. The /openapi.json probe is baked in ONLY when the
// export emitted openapi.json, so the harness never fetches a route that was not
// wired. The harness reports facts; the gate applies the contract.
function smokeHarnessSource(expectOpenApi: boolean): string {
  const lines: string[] = [];
  lines.push(`import { createApp } from "./main.ts";`);
  lines.push(``);
  // This file is the entrypoint, so main.ts's isEntrypoint() stays false and no
  // server binds. We drive the fully-wired app in-process via app.fetch().
  lines.push(`const app = await createApp();`);
  lines.push(``);
  lines.push(
    `const health = await app.fetch(new Request("http://local${HEALTH_ROUTE}"));`,
  );
  lines.push(
    `const healthBody: unknown = await health.json().catch(() => null);`,
  );
  lines.push(`const outcome: Record<string, unknown> = {`);
  lines.push(`  healthStatus: health.status,`);
  lines.push(`  health: healthBody,`);
  lines.push(`};`);
  if (expectOpenApi) {
    lines.push(``);
    lines.push(
      `const openapi = await app.fetch(new Request("http://local${OPENAPI_ROUTE}"));`,
    );
    lines.push(`const openapiText = await openapi.text();`);
    lines.push(`let openapiJsonValid = false;`);
    lines.push(
      `try { JSON.parse(openapiText); openapiJsonValid = true; } catch { openapiJsonValid = false; }`,
    );
    lines.push(`outcome.openapiStatus = openapi.status;`);
    lines.push(`outcome.openapiJsonValid = openapiJsonValid;`);
  }
  lines.push(``);
  lines.push(`console.log(JSON.stringify(outcome));`);
  return lines.join("\n") + "\n";
}

function smokeFailure<T>(message: string): Result<T> {
  return { ok: false, error: { code: EXPORT_APP_SMOKE_FAILED, message } };
}

// Scan subprocess stdout for the single JSON outcome line (from the end, so any
// incidental earlier output — e.g. a runtime notice — is ignored).
function parseSmokeOutcome(stdout: string): SmokeOutcome | null {
  const lines = stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(lines[i]!) as unknown;
      if (
        parsed && typeof parsed === "object" && "healthStatus" in parsed
      ) {
        return parsed as SmokeOutcome;
      }
    } catch {
      // Not the JSON outcome line; keep scanning.
    }
  }
  return null;
}

// Wrap the app-start / /_health (+ /openapi.json) smoke as a Result-returning
// gate. Writes the export to a tmp dir under projectDir/dist, spawns a Deno
// subprocess that imports the generated main.ts's createApp() and probes the
// health (and, when emitted, OpenAPI) routes via app.fetch(), then maps the
// observed outcome to the contract. Runs in a subprocess — not in-process —
// because importing generated main.ts boots PGlite's ./data in the cwd and would
// leak module-cache/resources into the long-lived orchestrator process. Any
// spawn failure, non-zero exit, missing outcome, or contract mismatch maps to
// EXPORT_APP_SMOKE_FAILED; the gate never throws.
export async function runAppSmokeGate(
  kernel: Kernel,
  projectDir: string,
  opts?: ExportProjectOptions,
): Promise<Result<AppSmokeVerification>> {
  const tmpDir = join(projectDir, "dist", SMOKE_TMP_DIR);
  try {
    const { files } = await exportProject(kernel, opts);
    // The /openapi.json requirement is waived unless the export emitted the file.
    const expectOpenApi = files.some((f) => f.path === OPENAPI_FILE);

    rmSync(tmpDir, { recursive: true, force: true });
    const harness: ExportFile = {
      path: SMOKE_HARNESS_PATH,
      content: smokeHarnessSource(expectOpenApi),
    };
    writeExportFiles(tmpDir, [...files, harness]);

    const toolchain = resolveDenoToolchain();
    if (!toolchain.ok) {
      return smokeFailure(
        denoToolchainFailure(
          "The app smoke gate needs a Deno toolchain",
          toolchain.error,
        ),
      );
    }

    let result: Deno.CommandOutput;
    try {
      const cmd = new Deno.Command(toolchain.data, {
        args: [
          "run",
          "--no-check",
          ...APP_RUNTIME_PERMISSIONS,
          SMOKE_HARNESS_PATH,
        ],
        cwd: tmpDir,
        stdout: "piped",
        stderr: "piped",
      });
      result = await cmd.output();
    } catch (err) {
      return smokeFailure(
        `App smoke could not run: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    const stdout = new TextDecoder().decode(result.stdout).trim();
    const stderr = new TextDecoder().decode(result.stderr).trim();

    if (!result.success) {
      return smokeFailure(
        `App failed to start (exit code ${result.code}).${
          stderr ? `\n${stderr}` : ""
        }`,
      );
    }

    const outcome = parseSmokeOutcome(stdout);
    if (!outcome) {
      return smokeFailure(
        `App smoke produced no parseable outcome.${
          stdout ? `\nstdout:\n${stdout}` : ""
        }${stderr ? `\nstderr:\n${stderr}` : ""}`,
      );
    }

    const contractError = checkSmokeContract(outcome, expectOpenApi, opts);
    if (contractError) return smokeFailure(contractError);

    return {
      ok: true,
      data: {
        healthStatus: outcome.healthStatus,
        openApiChecked: expectOpenApi,
      },
    };
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

// --- Route-smoke sub-check (shared by the target smoke gates) -----------------

// What the route-smoke pass observed: how many of the app's own routes were
// probed, every route the plan declined (with its reason) so a passing gate still
// reports the coverage gap honestly, and the per-route observations themselves —
// retained (not discarded after the contract check) so the Slice-4.4 parity gate
// can compare them across targets.
interface RouteSmokeResult {
  routesProbed: number;
  skipped: readonly SkippedRoute[];
  results: readonly RouteProbeResult[];
}

function routeSmokeFailures(
  target: BuildTarget,
  results: readonly RouteProbeResult[],
): RouteSmokeFailure[] {
  const failures: RouteSmokeFailure[] = [];
  for (const result of results) {
    const detail = checkOneRouteSmokeContract(result);
    if (detail === null) continue;
    failures.push({
      target,
      method: result.method,
      path: result.path,
      expectedStatus: result.expectedStatus,
      actualStatus: result.actualStatus,
      detail,
      ...(result.bodySnippet !== undefined
        ? { bodySnippet: result.bodySnippet }
        : {}),
    });
  }
  return failures;
}

function targetRouteSmokeDiagnostic(
  target: BuildTarget,
  routeSmoke: RouteSmokeResult,
): TargetRouteSmokeDiagnostic {
  const failures = routeSmokeFailures(target, routeSmoke.results);
  return {
    target,
    status: failures.length === 0 ? "passed" : "warning",
    routesProbed: routeSmoke.routesProbed,
    routesFailed: failures.length,
    skipped: routeSmoke.skipped,
    failures,
  };
}

function summarizeRouteSmoke(
  diagnostics: readonly TargetRouteSmokeDiagnostic[],
): ProductionRouteSmokeDiagnostic {
  const failures = diagnostics.flatMap((d) => [...d.failures]);
  return {
    status: failures.length === 0 ? "passed" : "warning",
    routesProbed: diagnostics.reduce((n, d) => n + d.routesProbed, 0),
    routesFailed: failures.length,
    skipped: diagnostics.reduce((n, d) => n + d.skipped.length, 0),
    failures,
  };
}

function strictRouteSmokeError(
  routeSmoke: TargetRouteSmokeDiagnostic,
): string | null {
  return routeSmoke.failures[0]?.detail ?? null;
}

// Build the safe-subset plan from the kernel's registered routes, probe every
// non-platform route against the live app over real HTTP, and apply the route
// contract. Shared verbatim by the Deno/Node/binary gates (the routes are the same
// kernel routes regardless of target; only the base URL differs), so the "build
// plan → probe → check → count" logic lives here once. The platform pair
// (/_health, /openapi.json) is filtered out via isPlatformRoute — checkSmokeContract
// already probed it strictly, and re-hitting would double-fetch. Never throws
// (probeRouteSmoke and checkRouteSmokeContract never throw).
async function runRouteSmokeSubcheck(
  kernel: Kernel,
  base: URL,
  expectOpenApi: boolean,
): Promise<RouteSmokeResult> {
  const plan = buildRouteSmokePlan(kernel.routes.list(), expectOpenApi);
  const appProbes = plan.probes.filter((p) => !isPlatformRoute(p.path));
  const results = await probeRouteSmoke(base, appProbes);
  return {
    routesProbed: appProbes.length,
    skipped: plan.skipped,
    results,
  };
}

// Human-readable route-coverage suffix appended to a passing target gate's detail,
// e.g. "12 routes probed, 3 skipped (mutating method ×2, requires path parameter
// ×1)" — so a green gate still shows every skipped route's reason (no silent
// drops). Reasons are counted and sorted for deterministic output.
function routeSmokeDetail(
  routesProbed: number,
  skipped: readonly SkippedRoute[],
): string {
  const head = `${routesProbed} route${
    routesProbed === 1 ? "" : "s"
  } probed, ${skipped.length} skipped`;
  if (skipped.length === 0) return head;
  const counts = new Map<string, number>();
  for (const s of skipped) {
    counts.set(s.reason, (counts.get(s.reason) ?? 0) + 1);
  }
  const parts = [...counts.entries()]
    .toSorted((a, b) => a[0].localeCompare(b[0]))
    .map(([reason, n]) => `${reason} ×${n}`);
  return `${head} (${parts.join(", ")})`;
}

function targetRouteSmokeDetail(
  routeSmoke: TargetRouteSmokeDiagnostic,
): string {
  const coverage = routeSmokeDetail(
    routeSmoke.routesProbed,
    routeSmoke.skipped,
  );
  if (routeSmoke.routesFailed === 0) return coverage;
  return `${coverage}; route smoke warning: ${routeSmoke.routesFailed} failed.`;
}

// Human-readable detail for a PASSING route_parity gate, e.g. "Route parity holds
// across deno-source, node — 1 route compared (0 body-compared)." N is the count of
// routes compared (the baseline's route count — the plan is identical per target),
// and M is how many of those the author opted into body comparison for
// (a non-null bodyHash on the baseline). Deno-source is the baseline (first).
function routeParityDetail(
  observations: readonly TargetRouteResults[],
  routeSmoke: readonly TargetRouteSmokeDiagnostic[],
): string {
  const targets = observations.map((o) => o.target).join(", ");
  const baseline = observations[0]?.results ?? [];
  const compared = baseline.length;
  const bodyCompared = baseline.filter((r) => r.bodyHash !== null).length;
  const failedExcluded = routeSmoke.reduce((n, d) => n + d.routesFailed, 0);
  const skippedExcluded = routeSmoke.reduce((n, d) => n + d.skipped.length, 0);
  const excluded = failedExcluded > 0 || skippedExcluded > 0
    ? ` Excluded from parity: ${failedExcluded} failed route probe${
      failedExcluded === 1 ? "" : "s"
    }, ${skippedExcluded} skipped route${skippedExcluded === 1 ? "" : "s"}.`
    : "";
  return `Route parity holds across ${targets} — ${compared} route${
    compared === 1 ? "" : "s"
  } compared (${bodyCompared} body-compared).${excluded}`;
}

// --- Deno-smoke gate wrapper --------------------------------------------------

// The typed success payload: the observed /_health status, whether the
// /openapi.json contract was checked, that the `--version` sub-check ran, and the
// route-smoke coverage (how many of the app's own routes were probed, plus every
// route the plan skipped with its reason).
export interface DenoSmokeVerification {
  healthStatus: number;
  openApiChecked: boolean;
  versionChecked: boolean;
  routesProbed: number;
  skipped: readonly SkippedRoute[];
  routeSmoke: TargetRouteSmokeDiagnostic;
  // The per-route observations, retained for the Slice-4.4 cross-target parity gate.
  routeResults: readonly RouteProbeResult[];
}

function denoSmokeFailure<T>(message: string): Result<T> {
  return { ok: false, error: { code: EXPORT_DENO_SMOKE_FAILED, message } };
}

// Wrap the real-process Deno-target boot smoke as a Result-returning gate. Unlike
// the in-process app-smoke gate (which imports createApp() and calls app.fetch()
// so no socket ever binds), this boots the exact task the shipped app runs
// (`deno task start` → `deno run --env --no-check <perms> main.ts`), exercising
// the production entrypoint the in-process gate cannot: the isEntrypoint() guard,
// parseStartupOptions, startServer/port-fallback, Deno.serve, the ready-line
// handshake, and SIGTERM shutdown. It first runs `-- --version` to completion,
// then boots `-- --random-port` and probes /_health (and /openapi.json when
// emitted) over real TCP against the shared checkSmokeContract. Any spawn
// failure, non-zero/early exit, ready-line timeout, non-200, contract mismatch,
// or invalid JSON maps to EXPORT_DENO_SMOKE_FAILED; the gate never throws and
// always reaps the child. Additive to (not a replacement for) runAppSmokeGate.
export async function runDenoSmokeGate(
  kernel: Kernel,
  projectDir: string,
  opts?: ProductionBuildOptions,
): Promise<Result<DenoSmokeVerification>> {
  const tmpDir = join(projectDir, "dist", DENO_SMOKE_TMP_DIR);
  try {
    const { files } = await exportProject(kernel, opts);
    // The /openapi.json requirement is waived unless the export emitted the file.
    const expectOpenApi = files.some((f) => f.path === OPENAPI_FILE);

    rmSync(tmpDir, { recursive: true, force: true });
    // No __smoke.ts harness — this gate runs the real entrypoint, not a harness.
    writeExportFiles(tmpDir, files);

    // The deno-source gate runs the exported app through `deno task start`, so it
    // needs a real toolchain. Checked before the version sub-check because both
    // sub-steps spawn it, and because `task start` is all positionals — pointing
    // it at a compiled kernel by way of Deno.execPath() did not fail, it booted a
    // second kernel that bound the control port and never exited.
    const toolchain = resolveDenoToolchain();
    if (!toolchain.ok) {
      return denoSmokeFailure(
        denoToolchainFailure(
          "The deno-source smoke gate needs a Deno toolchain",
          toolchain.error,
        ),
      );
    }

    // 1) Version sub-check: prints the version and exits without booting.
    const versionError = await checkVersionCommand({
      command: toolchain.data,
      args: ["task", "start", "--", APP_VERSION_FLAG],
      cwd: tmpDir,
      expected: `${opts?.projectName ?? DEFAULT_APP_NAME} ${
        opts?.projectVersion ?? DEFAULT_APP_VERSION
      }`,
      timeoutMs: VERSION_RUN_TIMEOUT_MS,
    });
    if (versionError) return denoSmokeFailure(versionError);

    // 2) Boot + real-HTTP smoke.
    let child: Deno.ChildProcess;
    try {
      child = new Deno.Command(toolchain.data, {
        args: ["task", "start", "--", APP_RANDOM_PORT_FLAG],
        cwd: tmpDir,
        stdout: "piped",
        stderr: "piped",
      }).spawn();
    } catch (err) {
      return denoSmokeFailure(`App could not start: ${errorMessage(err)}`);
    }

    let base: URL;
    try {
      base = await waitForReadyUrl(child, SERVER_READY_TIMEOUT_MS);
    } catch (err) {
      // Ready-line timeout or an early exit (boot error). Reap FIRST so the
      // child's stderr pipe closes and the drain terminates, THEN surface what it
      // wrote, THEN cancel the (now fully-read) streams.
      await reapChild(child);
      const stderr = await drainStderr(child);
      await cancelStreams(child);
      return denoSmokeFailure(
        `App failed to boot: ${errorMessage(err)}${
          stderr ? `\n${stderr}` : ""
        }`,
      );
    }

    try {
      const outcome = await probeSmokeOverHttp(base, expectOpenApi);
      const contractError = checkSmokeContract(outcome, expectOpenApi, opts);
      if (contractError) return denoSmokeFailure(contractError);
      // Additive after the health contract: probe the app's own declared routes.
      const routeSmoke = await runRouteSmokeSubcheck(
        kernel,
        base,
        expectOpenApi,
      );
      const routeSmokeDiagnostic = targetRouteSmokeDiagnostic(
        TARGET_DENO_SOURCE,
        routeSmoke,
      );
      if (opts?.strictRouteSmoke === true) {
        const strictError = strictRouteSmokeError(routeSmokeDiagnostic);
        if (strictError) return denoSmokeFailure(strictError);
      }
      return {
        ok: true,
        data: {
          healthStatus: outcome.healthStatus,
          openApiChecked: expectOpenApi,
          versionChecked: true,
          routesProbed: routeSmoke.routesProbed,
          skipped: routeSmoke.skipped,
          routeSmoke: routeSmokeDiagnostic,
          routeResults: routeSmoke.results,
        },
      };
    } catch (err) {
      return denoSmokeFailure(`App smoke probe failed: ${errorMessage(err)}`);
    } finally {
      await reapChild(child);
      await cancelStreams(child);
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

// --- Node-smoke gate wrapper --------------------------------------------------

// The typed success payload: the observed /_health status, whether the
// /openapi.json contract was checked, that the `--version` sub-check ran, and the
// route-smoke coverage (probed count + skipped routes with reasons).
export interface NodeSmokeVerification {
  healthStatus: number;
  openApiChecked: boolean;
  versionChecked: boolean;
  routesProbed: number;
  skipped: readonly SkippedRoute[];
  routeSmoke: TargetRouteSmokeDiagnostic;
  // The per-route observations, retained for the Slice-4.4 cross-target parity gate.
  routeResults: readonly RouteProbeResult[];
}

function nodeSmokeFailure<T>(message: string): Result<T> {
  return { ok: false, error: { code: EXPORT_NODE_SMOKE_FAILED, message } };
}

// Run one npm invocation in tmpDir. Shared by both frozen-install steps
// (--package-lock-only and ci), which differ only in their args; `label` names the
// step in any error message. A non-zero exit or a spawn failure (npm absent)
// returns the captured stderr; null on success. Never throws.
async function runNpm(
  args: readonly string[],
  tmpDir: string,
  label: string,
): Promise<string | null> {
  let output: Deno.CommandOutput;
  try {
    const cmd = new Deno.Command(NPM_BIN, {
      args: [...args],
      cwd: tmpDir,
      stdout: "piped",
      stderr: "piped",
    });
    output = await cmd.output();
  } catch (err) {
    return `${label} could not run: ${errorMessage(err)}`;
  }
  if (!output.success) {
    const stderr = new TextDecoder().decode(output.stderr).trim();
    return `${label} failed (exit code ${output.code}).${
      stderr ? `\n${stderr}` : ""
    }`;
  }
  return null;
}

// Probe whether the Node toolchain is available on this box. The Node gate needs
// BOTH `node` (to boot main.js) and `npm` (for the frozen install), so both must
// be present; a single fixed skip reason (NODE_TOOLCHAIN_ABSENT_DETAIL) covers
// either being missing. Each is probed by spawning it with `--version` (bounded by
// AbortSignal.timeout) and checking for a clean exit 0 — NOT a `which`/`where`
// shellout, which is not cross-platform. Any spawn error (ENOENT — the binary is
// absent), non-zero exit, or timeout maps to `false`; this NEVER throws, so it can
// be used as a preflight without a try/catch at the call site.
export async function nodeToolchainAvailable(): Promise<boolean> {
  return (await probeVersion(NODE_BIN)) && (await probeVersion(NPM_BIN));
}

// Spawn `<bin> --version` with output discarded, bounded by the probe timeout, and
// return true only if it spawned and exited 0. ENOENT/non-zero/timeout → false;
// never throws.
async function probeVersion(bin: string): Promise<boolean> {
  try {
    const output = await new Deno.Command(bin, {
      args: [APP_VERSION_FLAG],
      stdout: "null",
      stderr: "null",
      signal: AbortSignal.timeout(TOOLCHAIN_PROBE_TIMEOUT_MS),
    }).output();
    return output.success;
  } catch {
    return false;
  }
}

// Wrap the real-process Node-target boot smoke as a Result-returning gate. The
// Node artifact is a DIFFERENT set of bytes than the Deno source export — esbuild
// transpiles every .ts → .js, rewriteMainForNode retargets the isEntrypoint()
// predicate and the Deno.* FS/serve calls, deno.json → package.json, and the
// server binds via @hono/node-server rather than Deno.serve — so a Node-only
// regression (a bad specifier rewrite, a broken entrypoint predicate, a missing
// runtime shim) is invisible to the Deno gate. This boots the exact `node main.js`
// a Node user runs and reaches it over TCP. It transpiles the Node target, proves
// a FROZEN install of its deps (required before load) — generate an ephemeral
// package-lock.json via `npm install --package-lock-only`, then `npm ci` strictly
// from it (a clean-tree install that fails if the lock and package.json disagree),
// gate-side rather than from a committed lockfile (see NPM_LOCK_ONLY_ARGS) — runs
// `node main.js --version` to completion (invoked DIRECTLY, not via `npm run
// start`, whose lifecycle chatter would break the exact-match), then boots
// `node main.js --random-port` and probes
// /_health (and /openapi.json when emitted) over real HTTP against the shared
// checkSmokeContract. Any spawn/install failure, non-zero/early exit, ready-line
// timeout, non-200, contract mismatch, or invalid JSON maps to
// EXPORT_NODE_SMOKE_FAILED; the gate never throws and always reaps the child
// (registerShutdown wires process.on("SIGTERM") so it reaps cleanly).
//
// Wired into runProductionBuild as an OPT-IN per-target gate (Slice 3.5.2): it runs
// only when the caller's `targets` set contains TARGET_NODE; otherwise the
// orchestrator emits a skipped outcome ("target not selected") in its place. It is
// opt-in because node/npm are not guaranteed on the box, so a mandatory Node gate
// would fail every production build on a Deno-only machine — an environment
// dependency the orchestrator must not silently acquire. The orchestrator
// preflights node/npm (nodeToolchainAvailable) and emits a clean skip
// (NODE_TOOLCHAIN_ABSENT_DETAIL) for a selected-but-absent toolchain, so this gate
// only runs when the toolchain is present; EXPORT_NODE_SMOKE_FAILED now signals a
// genuine install/boot failure, not a missing toolchain.
//
// An absent DENO toolchain is deliberately NOT treated this way. That used to be
// unthinkable — the interpreter running the orchestrator was the toolchain — but a
// `deno compile`d kernel (the desktop sidecar) has no deno at all, so every
// deno-target gate now preflights it via core/deno-toolchain.ts and FAILS rather
// than skips. The asymmetry is the point: Node is an optional extra target, while
// the deno-source tree IS the artifact, and `reportOk` counts a skipped gate as
// acceptable — so skipping these would hand back a green production build over an
// artifact nothing verified.
export async function runNodeSmokeGate(
  kernel: Kernel,
  projectDir: string,
  opts?: ProductionBuildOptions,
): Promise<Result<NodeSmokeVerification>> {
  const tmpDir = join(projectDir, "dist", NODE_SMOKE_TMP_DIR);
  const projectName = opts?.projectName ?? DEFAULT_APP_NAME;
  const projectVersion = opts?.projectVersion ?? DEFAULT_APP_VERSION;
  try {
    const nodeFiles = await buildNodeFiles(
      kernel,
      projectName,
      projectVersion,
      opts,
    );
    // openapi.json is a static asset (not transpiled), so the filename is
    // unchanged in the Node artifact; the /openapi.json requirement is waived
    // unless it was emitted.
    const expectOpenApi = nodeFiles.some((f) => f.path === OPENAPI_FILE);

    rmSync(tmpDir, { recursive: true, force: true });
    writeExportFiles(tmpDir, nodeFiles);

    // 1) Frozen install in two steps — node main.js can't load the module until
    //    node_modules exists (`import { serve } from "@hono/node-server"` in main.js
    //    and `import { PGlite }` in deps.ts both resolve before the --version branch
    //    runs), so both precede the sub-checks.
    //    (a) Generate the ephemeral lock without building node_modules.
    const lockError = await runNpm(
      NPM_LOCK_ONLY_ARGS,
      tmpDir,
      "npm install --package-lock-only",
    );
    if (lockError) return nodeSmokeFailure(lockError);
    //    (b) Frozen, clean-tree install strictly from that lock (npm ci wipes
    //        node_modules and fails if the lock and package.json disagree).
    const ciError = await runNpm(NPM_CI_ARGS, tmpDir, "npm ci");
    if (ciError) return nodeSmokeFailure(ciError);

    // 2) Version sub-check: `node main.js --version` prints the version and exits
    //    without booting. Invoked directly, not via `npm run start`.
    const versionError = await checkVersionCommand({
      command: NODE_BIN,
      args: [MAIN_JS, APP_VERSION_FLAG],
      cwd: tmpDir,
      expected: `${projectName} ${projectVersion}`,
      timeoutMs: VERSION_RUN_TIMEOUT_MS,
    });
    if (versionError) return nodeSmokeFailure(versionError);

    // 3) Boot + real-HTTP smoke.
    let child: Deno.ChildProcess;
    try {
      child = new Deno.Command(NODE_BIN, {
        args: [MAIN_JS, APP_RANDOM_PORT_FLAG],
        cwd: tmpDir,
        stdout: "piped",
        stderr: "piped",
      }).spawn();
    } catch (err) {
      return nodeSmokeFailure(`App could not start: ${errorMessage(err)}`);
    }

    let base: URL;
    try {
      base = await waitForReadyUrl(child, SERVER_READY_TIMEOUT_MS);
    } catch (err) {
      // Ready-line timeout or an early exit (boot error). Reap FIRST so the
      // child's stderr pipe closes and the drain terminates, THEN surface what it
      // wrote, THEN cancel the (now fully-read) streams.
      await reapChild(child);
      const stderr = await drainStderr(child);
      await cancelStreams(child);
      return nodeSmokeFailure(
        `App failed to boot: ${errorMessage(err)}${
          stderr ? `\n${stderr}` : ""
        }`,
      );
    }

    try {
      const outcome = await probeSmokeOverHttp(base, expectOpenApi);
      const contractError = checkSmokeContract(outcome, expectOpenApi, opts);
      if (contractError) return nodeSmokeFailure(contractError);
      // Additive after the health contract: probe the app's own declared routes.
      const routeSmoke = await runRouteSmokeSubcheck(
        kernel,
        base,
        expectOpenApi,
      );
      const routeSmokeDiagnostic = targetRouteSmokeDiagnostic(
        TARGET_NODE,
        routeSmoke,
      );
      if (opts?.strictRouteSmoke === true) {
        const strictError = strictRouteSmokeError(routeSmokeDiagnostic);
        if (strictError) return nodeSmokeFailure(strictError);
      }
      return {
        ok: true,
        data: {
          healthStatus: outcome.healthStatus,
          openApiChecked: expectOpenApi,
          versionChecked: true,
          routesProbed: routeSmoke.routesProbed,
          skipped: routeSmoke.skipped,
          routeSmoke: routeSmokeDiagnostic,
          routeResults: routeSmoke.results,
        },
      };
    } catch (err) {
      return nodeSmokeFailure(`App smoke probe failed: ${errorMessage(err)}`);
    } finally {
      await reapChild(child);
      await cancelStreams(child);
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

// --- Binary-smoke gate wrapper ------------------------------------------------

// The typed success payload: the observed /_health status, whether the
// /openapi.json contract was checked, that the `--version` sub-check ran, the host
// triple the binary was compiled for (so a report can show which target was
// smoke-tested), and the route-smoke coverage (probed count + skipped routes with
// reasons).
export interface BinarySmokeVerification {
  healthStatus: number;
  openApiChecked: boolean;
  versionChecked: boolean;
  target: string;
  routesProbed: number;
  skipped: readonly SkippedRoute[];
  routeSmoke: TargetRouteSmokeDiagnostic;
  // The per-route observations, retained for the Slice-4.4 cross-target parity gate.
  routeResults: readonly RouteProbeResult[];
}

function binarySmokeFailure<T>(message: string): Result<T> {
  return { ok: false, error: { code: EXPORT_BINARY_SMOKE_FAILED, message } };
}

// Wrap the real-process binary-target boot smoke as a Result-returning gate. The
// compiled binary is a DIFFERENT artifact than the Deno source export: `deno
// compile` snapshots the whole module graph into a single self-contained
// executable with an embedded runtime — there is no deno.json, no on-the-fly npm:
// specifier resolution, no `deno task start`; the app is invoked as `./app`
// directly and the isEntrypoint() predicate must fire inside the compiled bundle
// rather than under `deno run`. A binary-only regression (a specifier that
// resolves under `deno run` but not when snapshotted into the bundle, a
// compile-time failure the source check misses, an entrypoint predicate that
// doesn't fire in the compiled context) ships silently today — this gate compiles
// the exact executable a binary user runs and reaches it over TCP.
//
// It compiles for the HOST triple (defaultBinaryCompileTarget) — mandatory, not
// optional: only a host-native binary can be executed here, and the host's runtime
// is already local so no cross-target runtime download happens. It writes the FULL
// export tree into tmpDir and both compiles and runs the binary with cwd = tmpDir,
// because `deno compile` bundles only the TS module graph — schema.sql,
// openapi.json, and assets are NOT embedded; the generated main.ts reads them from
// the process cwd at runtime (and PGlite opens ./data there). It then runs
// `./app --version` to completion (invoked DIRECTLY), boots `./app --random-port`,
// and probes /_health (+ /openapi.json when emitted) over real HTTP against the
// shared checkSmokeContract. Any compile failure, spawn failure, non-zero/early
// exit, ready-line timeout, non-200, contract mismatch, or invalid JSON maps to
// EXPORT_BINARY_SMOKE_FAILED; the gate never throws and always reaps the child
// (registerShutdown wires Deno.addSignalListener("SIGTERM") in the compiled app so
// it reaps cleanly). The compile is bounded by AbortSignal.timeout so a hung
// `deno compile` can't wedge the gate.
//
// Wired into runProductionBuild as an OPT-IN per-target gate (Slice 3.5.2): it runs
// only when the caller's `targets` set contains TARGET_BINARY; otherwise the
// orchestrator emits a skipped outcome ("target not selected") in its place. It is
// opt-in for a DIFFERENT reason than the Node gate: `deno compile` is always
// available (the orchestrator runs on Deno), so this is NOT the toolchain-
// availability concern that keeps node_smoke opt-in. Instead, a binary smoke pays a
// full `deno compile` (tens of seconds) to validate a target the user may not have
// selected — a per-target opt-in, not something every production build should
// shoulder. Every existing invariant (artifact-only-on-full-pass, stop-at-first) is
// untouched; the default (deno-source-only) run never pays this compile.
export async function runBinarySmokeGate(
  kernel: Kernel,
  projectDir: string,
  opts?: ProductionBuildOptions,
): Promise<Result<BinarySmokeVerification>> {
  const tmpDir = join(projectDir, "dist", BINARY_SMOKE_TMP_DIR);
  const projectName = opts?.projectName ?? DEFAULT_APP_NAME;
  const projectVersion = opts?.projectVersion ?? DEFAULT_APP_VERSION;
  // Compile for the host triple: only a host-native binary can be executed here,
  // and its runtime is already local (no cross-target runtime download).
  const target = defaultBinaryCompileTarget();
  const binaryName = binaryOutputFilename(projectName, projectVersion, target);
  const binaryPath = join(tmpDir, binaryName);
  try {
    const { files } = await exportProject(kernel, opts);
    // The /openapi.json requirement is waived unless the export emitted the file.
    const expectOpenApi = files.some((f) => f.path === OPENAPI_FILE);

    rmSync(tmpDir, { recursive: true, force: true });
    // Write the FULL export tree, then explicitly include the generated runtime
    // files that main.ts reads through import.meta.url-relative paths.
    writeExportFiles(tmpDir, files);

    // 1) Compile the host-native binary. --no-check is already in binaryCompileArgs
    //    — the type-check gate owns type-checking, so re-checking here is redundant
    //    (same rationale as the other gates). Bounded by a generous timeout since a
    //    native compile snapshots the runtime.
    const toolchain = resolveDenoToolchain();
    if (!toolchain.ok) {
      return binarySmokeFailure(
        denoToolchainFailure(
          "The binary smoke gate needs a Deno toolchain",
          toolchain.error,
        ),
      );
    }

    let compile: Deno.CommandOutput;
    try {
      compile = await new Deno.Command(toolchain.data, {
        args: binaryCompileArgs(
          binaryPath,
          join(tmpDir, "main.ts"),
          target,
          binaryRuntimeIncludePaths(files).map((path) => join(tmpDir, path)),
        ),
        cwd: tmpDir,
        stdout: "piped",
        stderr: "piped",
        signal: AbortSignal.timeout(BINARY_COMPILE_TIMEOUT_MS),
      }).output();
    } catch (err) {
      return binarySmokeFailure(
        `Binary compile could not run: ${errorMessage(err)}`,
      );
    }
    if (!compile.success) {
      const stderr = new TextDecoder().decode(compile.stderr).trim();
      return binarySmokeFailure(
        `Binary compile failed (exit code ${compile.code}).${
          stderr ? `\n${stderr}` : ""
        }`,
      );
    }

    // 2) Version sub-check: `./app --version` prints the version and exits without
    //    booting (the version branch runs before createApp()). Invoked directly.
    const versionError = await checkVersionCommand({
      command: binaryPath,
      args: [APP_VERSION_FLAG],
      cwd: tmpDir,
      expected: `${projectName} ${projectVersion}`,
      timeoutMs: VERSION_RUN_TIMEOUT_MS,
    });
    if (versionError) return binarySmokeFailure(versionError);

    // 3) Boot + real-HTTP smoke.
    let child: Deno.ChildProcess;
    try {
      child = new Deno.Command(binaryPath, {
        args: [APP_RANDOM_PORT_FLAG],
        cwd: tmpDir,
        stdout: "piped",
        stderr: "piped",
      }).spawn();
    } catch (err) {
      return binarySmokeFailure(`App could not start: ${errorMessage(err)}`);
    }

    let base: URL;
    try {
      base = await waitForReadyUrl(child, SERVER_READY_TIMEOUT_MS);
    } catch (err) {
      // Ready-line timeout or an early exit (boot error). Reap FIRST so the
      // child's stderr pipe closes and the drain terminates, THEN surface what it
      // wrote, THEN cancel the (now fully-read) streams.
      await reapChild(child);
      const stderr = await drainStderr(child);
      await cancelStreams(child);
      return binarySmokeFailure(
        `App failed to boot: ${errorMessage(err)}${
          stderr ? `\n${stderr}` : ""
        }`,
      );
    }

    try {
      const outcome = await probeSmokeOverHttp(base, expectOpenApi);
      const contractError = checkSmokeContract(outcome, expectOpenApi, opts);
      if (contractError) return binarySmokeFailure(contractError);
      // Additive after the health contract: probe the app's own declared routes.
      const routeSmoke = await runRouteSmokeSubcheck(
        kernel,
        base,
        expectOpenApi,
      );
      const routeSmokeDiagnostic = targetRouteSmokeDiagnostic(
        TARGET_BINARY,
        routeSmoke,
      );
      if (opts?.strictRouteSmoke === true) {
        const strictError = strictRouteSmokeError(routeSmokeDiagnostic);
        if (strictError) return binarySmokeFailure(strictError);
      }
      return {
        ok: true,
        data: {
          healthStatus: outcome.healthStatus,
          openApiChecked: expectOpenApi,
          versionChecked: true,
          target,
          routesProbed: routeSmoke.routesProbed,
          skipped: routeSmoke.skipped,
          routeSmoke: routeSmokeDiagnostic,
          routeResults: routeSmoke.results,
        },
      };
    } catch (err) {
      return binarySmokeFailure(`App smoke probe failed: ${errorMessage(err)}`);
    } finally {
      await reapChild(child);
      await cancelStreams(child);
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

// --- Ordered gate pipeline ----------------------------------------------------

type GateRunner = () => Promise<GateOutcome>;

interface GateStep {
  gate: string;
  run: GateRunner;
}

// Run gate steps in order, STOPPING at the first FAILED gate — a broken export
// makes later gates meaningless — while keeping every gate already attempted in
// the returned list. A "skipped" (or "passed") outcome does NOT stop the pipeline:
// skips pass through and later gates still run. Pure and never-throwing as long as
// each step's run() never throws (every gate wrapper guarantees this). Exported so
// the stop-at-first-failure ordering can be asserted directly.
export async function sequenceGates(steps: GateStep[]): Promise<GateOutcome[]> {
  const outcomes: GateOutcome[] = [];
  for (const step of steps) {
    const outcome = await step.run();
    outcomes.push(outcome);
    if (outcome.status === "failed") break;
  }
  return outcomes;
}

// Map a gate's Result to a GateOutcome: a success summary ("passed"), or the
// failure's reused code + message ("failed"). A Result never yields a skip —
// skips don't come from a Result; use skippedOutcome for those.
function toOutcome<T>(
  gate: string,
  result: Result<T>,
  detail: (data: T) => string,
): GateOutcome {
  return result.ok ? { gate, status: "passed", detail: detail(result.data) } : {
    gate,
    status: "failed",
    code: result.error.code,
    detail: result.error.message,
  };
}

// Construct a "skipped" outcome — the gate did not run and that is not a failure.
// `reason` is the human-readable skip explanation carried in `detail`; no code is
// set (codes are only for failures). Called by the target-selection (Slice 3.5.2)
// and toolchain-preflight (Slice 3.5.3) slices.
export function skippedOutcome(gate: string, reason: string): GateOutcome {
  return { gate, status: "skipped", detail: reason };
}

// Whether the whole build passed: the pipeline ran to completion (a
// stop-at-first-failure run is shorter than the step count) and no gate failed.
// Skipped gates are acceptable — they are neither a pass that hides non-execution
// nor a failure. Exported so the pass/fail semantics can be unit-tested directly.
export function reportOk(gates: GateOutcome[], stepCount: number): boolean {
  return gates.length === stepCount &&
    gates.every((g) => g.status !== "failed");
}

// --- Orchestrator -------------------------------------------------------------

/**
 * Run the required production gates over a single release-candidate export, in
 * Phase-4 order (manifest → determinism → type check → dependency lock → app
 * smoke → deno smoke),
 * followed by the opt-in per-target smoke gates (node smoke → binary smoke) and a
 * trailing cross-target route parity gate (Slice 4.4), stopping at the first
 * failure. Returns a typed report; never throws and never returns a Result error —
 * a failing gate is represented as `ok: false`. The artifact is included only when
 * every gate passed (release candidate ready). The type-check, app-smoke,
 * deno-smoke, node-smoke, and binary-smoke gates' tmp-dir writes (each cleaned up in
 * a finally) are the orchestrator's only side effects; route_parity does no I/O — it
 * compares the route observations the target gates retained.
 *
 * `targets` selects which build targets to validate. deno-source is ALWAYS
 * validated (the five core gates) regardless of the set's contents; node and binary
 * are opt-in. Default = deno-source only, so node_smoke and binary_smoke are both
 * skipped ("target not selected") — the report always shows every known target's
 * disposition rather than omitting an unselected one, and the default run's `ok`
 * verdict is identical to before (the five core gates plus two trailing skip rows,
 * now followed by a route_parity skip: with only deno-source probed there is
 * nothing to compare, so it self-skips and the `ok` verdict is still unchanged).
 * route_parity is NOT tied to the targets set — it compares whatever targets
 * actually produced route results, so it only asserts agreement (status,
 * content-type, and deterministic-body hashes) when ≥2 targets ran; deno-source is
 * always the baseline.
 *
 * A *selected* Node target additionally passes a toolchain preflight
 * (`nodeToolchainProbe`, defaulting to the real `nodeToolchainAvailable`): if
 * node/npm are absent from PATH, node_smoke is reported as skipped
 * ("node/npm not found on PATH") rather than failed — so a Deno-only CI can honestly
 * select the Node target and get a clean skip instead of a red build. Selection is
 * checked BEFORE the probe, so an unselected Node target never pays a probe spawn.
 * The binary target never skips for toolchain reasons — `deno compile` is always
 * available (the orchestrator runs on Deno) — only for non-selection. The probe is
 * injectable purely so tests can exercise the absent-toolchain path on a box that
 * has node.
 */
export async function runProductionBuild(
  kernel: Kernel,
  projectDir: string,
  opts?: ProductionBuildOptions,
  targets: ReadonlySet<BuildTarget> = new Set([TARGET_DENO_SOURCE]),
  nodeToolchainProbe: () => Promise<boolean> = nodeToolchainAvailable,
): Promise<ProductionBuildReport> {
  // The release-candidate artifact: exported ONCE, with a manifest, and reused as
  // the input to the manifest gate. When the project ships a committed deno.lock
  // (Slice 6.1), its bytes are sourced here and threaded through exportOpts so the
  // export emits it verbatim — the build validates that lock, never produces one.
  // A generated app with no committed lock leaves denoLock undefined, so no
  // deno.lock is emitted and the dependency_lock gate skips.
  // The committed Node lock (Slice 6.2) is sourced the same way and threaded via
  // packageLock so the deno-source export emits it for free manifest/determinism
  // coverage, then buildNodeFiles carries it verbatim into the Node artifact where
  // node_dependency_lock validates it. Absent → no package-lock.json emitted and
  // that gate skips.
  const committedLock = readCommittedLock(projectDir);
  const committedNodeLock = readCommittedNodeLock(projectDir);
  const exportOpts: ProductionBuildOptions = {
    ...opts,
    includeManifest: true,
    includeMigrations: opts?.includeMigrations ?? true,
    includeReferenceSeeds: opts?.includeReferenceSeeds ?? true,
    ...(committedLock !== undefined ? { denoLock: committedLock } : {}),
    ...(committedNodeLock !== undefined
      ? { packageLock: committedNodeLock }
      : {}),
  };
  const { files, tarball } = await exportProject(kernel, exportOpts);

  // Captured from the manifest gate's success payload (via closure) so the report
  // can surface it even on a later-gate failure.
  let sourceFingerprint: string | null = null;

  // Each passing target gate's retained route observations, keyed by target and in
  // gate order (deno-source is inserted first — it always runs — so it is the
  // parity baseline; node/binary only appear when they actually ran). The trailing
  // route_parity step compares whatever landed here, so a skipped/failed target
  // simply never contributes.
  const targetRouteResults = new Map<string, readonly RouteProbeResult[]>();
  const routeSmokeDiagnostics: TargetRouteSmokeDiagnostic[] = [];

  const steps: GateStep[] = [
    {
      gate: GATE_MANIFEST,
      run: async () => {
        const result = await verifyManifest(files);
        if (result.ok) sourceFingerprint = result.data.sourceFingerprint;
        return toOutcome(
          GATE_MANIFEST,
          result,
          (d) =>
            `Verified ${d.verifiedFileCount} files against ${MANIFEST_PATH}.`,
        );
      },
    },
    {
      gate: GATE_DETERMINISM,
      run: async () => {
        const result = await verifyExportDeterminism(kernel, exportOpts);
        return toOutcome(
          GATE_DETERMINISM,
          result,
          () => "Re-exporting the kernel is byte-reproducible.",
        );
      },
    },
    {
      gate: GATE_TYPE_CHECK,
      run: async () => {
        const result = await runTypeCheckGate(kernel, projectDir, exportOpts);
        return toOutcome(
          GATE_TYPE_CHECK,
          result,
          (d) => `Type-checked ${d.fileCount} generated files.`,
        );
      },
    },
    // Dependency-lock runs after the type check (a locked-but-untyped app should
    // not proceed) and before any boot (a static/offline check is cheaper than
    // starting a process). It ALWAYS runs — a deno-source gate, not opt-in — but
    // self-skips when the export carries no committed deno.lock (a generated app
    // that never had one), so the default run gets one clean skip row here.
    {
      gate: GATE_DEPENDENCY_LOCK,
      run: async () => {
        const result = await verifyDependencyLock(files, projectDir);
        if (result.ok && !result.data.verified) {
          return skippedOutcome(GATE_DEPENDENCY_LOCK, result.data.reason);
        }
        return toOutcome(
          GATE_DEPENDENCY_LOCK,
          result,
          (d) =>
            d.verified
              ? `Committed ${d.lockfile} frozen-valid (${d.packageCount} locked specifier${
                d.packageCount === 1 ? "" : "s"
              }).`
              : NO_COMMITTED_LOCK_DETAIL,
        );
      },
    },
    // App-smoke runs before the real-process boot: a non-type-checking app can't
    // be trusted to import, so it is gated behind GATE_TYPE_CHECK.
    {
      gate: GATE_APP_SMOKE,
      run: async () => {
        const result = await runAppSmokeGate(kernel, projectDir, exportOpts);
        return toOutcome(
          GATE_APP_SMOKE,
          result,
          (d) =>
            `App started; GET ${HEALTH_ROUTE} OK${
              d.openApiChecked ? ` + GET ${OPENAPI_ROUTE} OK` : ""
            }.`,
        );
      },
    },
    // Deno-smoke runs last: booting a real child process on a real socket is the
    // most expensive gate, so it is gated behind the cheap in-process app-smoke
    // (no port contention, no subprocess) that already proved the app boots.
    {
      gate: GATE_DENO_SMOKE,
      run: async () => {
        const result = await runDenoSmokeGate(kernel, projectDir, exportOpts);
        if (result.ok) {
          targetRouteResults.set(TARGET_DENO_SOURCE, result.data.routeResults);
          routeSmokeDiagnostics.push(result.data.routeSmoke);
        }
        return toOutcome(
          GATE_DENO_SMOKE,
          result,
          (d) =>
            `App booted on a random port; GET ${HEALTH_ROUTE} + --version OK${
              d.openApiChecked ? `, GET ${OPENAPI_ROUTE} OK` : ""
            }. ${targetRouteSmokeDetail(d.routeSmoke)}.`,
        );
      },
    },
    // Opt-in per-target gates. Always appended so the report lists every known
    // target's disposition; each runs its real gate only when selected, else emits
    // a "target not selected" skip that passes through the sequencer. Node precedes
    // binary, matching the GATE_* constant order.
    //
    // node_dependency_lock (Slice 6.2) is the first Node-scoped gate — it precedes
    // node_smoke because a locked-but-unbootable artifact should not smoke. Like
    // node_smoke it is opt-in on TARGET_NODE and honors the toolchain preflight
    // (selection checked FIRST, then the probe), then self-skips when the Node
    // artifact carries no committed package-lock.json. It builds its OWN Node files
    // (buildNodeFiles carries the committed lock through) and validates offline in
    // its own tmp dir, so it never corrupts node_smoke's ephemeral install.
    {
      gate: GATE_NODE_DEPENDENCY_LOCK,
      run: async () => {
        if (!targets.has(TARGET_NODE)) {
          return skippedOutcome(
            GATE_NODE_DEPENDENCY_LOCK,
            TARGET_NOT_SELECTED_DETAIL,
          );
        }
        if (!(await nodeToolchainProbe())) {
          return skippedOutcome(
            GATE_NODE_DEPENDENCY_LOCK,
            NODE_TOOLCHAIN_ABSENT_DETAIL,
          );
        }
        // No committed lock → skip WITHOUT paying a Node transpile. (verify also
        // handles an absent lock defensively — that path is exercised in isolation
        // by production-node-lock_test.ts — but the common no-lock build should
        // not pay buildNodeFiles just to discover there is nothing to validate.)
        if (committedNodeLock === undefined) {
          return skippedOutcome(
            GATE_NODE_DEPENDENCY_LOCK,
            NO_COMMITTED_NODE_LOCK_DETAIL,
          );
        }
        const nodeFiles = await buildNodeFiles(
          kernel,
          opts?.projectName ?? DEFAULT_APP_NAME,
          opts?.projectVersion ?? DEFAULT_APP_VERSION,
          exportOpts,
        );
        const result = await verifyNodeDependencyLock(nodeFiles, projectDir);
        if (result.ok && !result.data.verified) {
          return skippedOutcome(GATE_NODE_DEPENDENCY_LOCK, result.data.reason);
        }
        return toOutcome(
          GATE_NODE_DEPENDENCY_LOCK,
          result,
          (d) =>
            d.verified
              ? `Committed ${d.lockfile} frozen-valid for the Node artifact (${d.packageCount} locked package${
                d.packageCount === 1 ? "" : "s"
              }).`
              : NO_COMMITTED_NODE_LOCK_DETAIL,
        );
      },
    },
    {
      gate: GATE_NODE_SMOKE,
      run: async () => {
        // Selection is checked FIRST (cheap, no spawn): an unselected Node target
        // skips without ever consulting the probe.
        if (!targets.has(TARGET_NODE)) {
          return skippedOutcome(GATE_NODE_SMOKE, TARGET_NOT_SELECTED_DETAIL);
        }
        // Selected but no node/npm on PATH → a clean skip, not a failure, so a
        // Deno-only box can select node and get an honest "no toolchain" skip.
        if (!(await nodeToolchainProbe())) {
          return skippedOutcome(GATE_NODE_SMOKE, NODE_TOOLCHAIN_ABSENT_DETAIL);
        }
        const result = await runNodeSmokeGate(kernel, projectDir, exportOpts);
        if (result.ok) {
          targetRouteResults.set(TARGET_NODE, result.data.routeResults);
          routeSmokeDiagnostics.push(result.data.routeSmoke);
        }
        return toOutcome(
          GATE_NODE_SMOKE,
          result,
          (d) =>
            `Node app booted on a random port; node main.js --version + GET ${HEALTH_ROUTE} OK${
              d.openApiChecked ? `, GET ${OPENAPI_ROUTE} OK` : ""
            }. ${targetRouteSmokeDetail(d.routeSmoke)}.`,
        );
      },
    },
    {
      gate: GATE_BINARY_SMOKE,
      run: async () => {
        if (!targets.has(TARGET_BINARY)) {
          return skippedOutcome(GATE_BINARY_SMOKE, TARGET_NOT_SELECTED_DETAIL);
        }
        const result = await runBinarySmokeGate(kernel, projectDir, exportOpts);
        if (result.ok) {
          targetRouteResults.set(TARGET_BINARY, result.data.routeResults);
          routeSmokeDiagnostics.push(result.data.routeSmoke);
        }
        return toOutcome(
          GATE_BINARY_SMOKE,
          result,
          (d) =>
            `Binary (${d.target}) booted on a random port; --version + GET ${HEALTH_ROUTE} OK${
              d.openApiChecked ? `, GET ${OPENAPI_ROUTE} OK` : ""
            }. ${targetRouteSmokeDetail(d.routeSmoke)}.`,
        );
      },
    },
    // Cross-target route parity (Slice 4.4). Runs LAST — it compares the route
    // observations the target gates above retained, so it must see them all. It is
    // NOT tied to the targets set: it compares whatever actually produced results.
    // With fewer than two probed targets (the default deno-source-only run, or a
    // run where node/binary skipped) there is nothing to compare, so it self-skips
    // — one trailing skip row that passes through the sequencer, leaving the default
    // run's `ok` verdict unchanged. A failed target stops the pipeline before this
    // step (never compare a failed boot). Pure comparison, no I/O.
    {
      gate: GATE_ROUTE_PARITY,
      run: () => {
        if (targetRouteResults.size < 2) {
          return Promise.resolve(
            skippedOutcome(
              GATE_ROUTE_PARITY,
              ROUTE_PARITY_SINGLE_TARGET_DETAIL,
            ),
          );
        }
        const observations: TargetRouteResults[] = [
          ...targetRouteResults.entries(),
        ].map(([target, results]) => ({ target, results }));
        const comparableObservations = comparableTargetRouteResults(
          observations,
        );
        const mismatch = compareTargetParity(comparableObservations);
        if (mismatch !== null) {
          return Promise.resolve({
            gate: GATE_ROUTE_PARITY,
            status: "failed",
            code: EXPORT_ROUTE_PARITY_FAILED,
            detail: mismatch,
          });
        }
        return Promise.resolve({
          gate: GATE_ROUTE_PARITY,
          status: "passed",
          detail: routeParityDetail(
            comparableObservations,
            routeSmokeDiagnostics,
          ),
        });
      },
    },
  ];

  const gates = await sequenceGates(steps);
  const ok = reportOk(gates, steps.length);
  const routeSmoke = summarizeRouteSmoke(routeSmokeDiagnostics);

  return ok
    ? { ok, sourceFingerprint, gates, routeSmoke, artifact: { files, tarball } }
    : { ok, sourceFingerprint, gates, routeSmoke };
}
