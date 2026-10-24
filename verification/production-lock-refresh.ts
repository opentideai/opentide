// @layer verification — the committed-lock REFRESH producer (Milestone 7, Slice
// 7.1). This is the mirror image of the 6.x lock GATES: where those validate a
// pre-existing committed lock OFFLINE inside the pure build pipeline
// (verifyDependencyLock / verifyNodeDependencyLock), this PRODUCES that committed
// lock — it is network-allowed, it WRITES the lock files into <projectDir>, and it
// deliberately lives OUTSIDE runProductionBuild so the build stays pure and
// offline. Nothing in the pipeline calls this; the discipline flips from "validate
// an input, never produce" to "produce the input the gates will later validate —
// and prove it validates".
//
// It sits in the verification layer (not core) because it depends on the 6.x
// gates: core cannot import verification (that would be an upward import), and
// verification already hosts network-touching, process-spawning code (the Node
// smoke gate runs a real `npm ci`). The gate PHILOSOPHY of offline purity is a
// property of the lock gates, not the whole layer, so a network-allowed producer
// beside them is layer-legal and keeps lint:layers green.
//
// --- The forks the plan flagged, resolved empirically (npm 11/node 24, Deno 2.9) ---
//
// Fork #1 — Node producer ↔ gate consistency. Running the gate's OWN resolver
// invocation (NPM_LOCK_ONLY_ARGS = `npm install --package-lock-only …`) in a tmp
// dir holding just the GENERATED package.json produces a package-lock.json that
// `verifyNodeDependencyLock` then validates offline as `verified: true`, and a
// re-run over the same package.json yields a BYTE-IDENTICAL lock (idempotent).
// CONFIRMED.
//
// Fork #2 — the 6.3 exact-mirror convergence. With a user dep whose specifier is a
// range (`npm:is-odd@3`): pass-1 buildNodeFiles (no committed lock) emits
// package.json with `is-odd: "3"` → the produced lock's root mirror
// (`packages[""].dependencies`) is the range `"3"` while the resolved
// `node_modules/is-odd` is exact `3.0.1`. Feeding THAT lock back into pass-2
// buildNodeFiles pins `is-odd` to the exact `3.0.1` (Slice 6.3's precedence
// ladder), so regenerating over the pass-2 package.json yields a lock whose root
// mirror is ALSO exact `3.0.1`. So ONE refresh call runs an INTERNAL TWO-PASS to a
// fixed point (bounded, deterministic) and a single invocation makes the mirror
// exact even for a project that had no committed lock — chosen over one-pass +
// "run it twice". (The 6.3 note holds too: even the range-mirror pass-1 lock
// already validates the exact package.json, so the mirror-exactness is a
// cleanliness win, not a correctness requirement.) CONFIRMED.
//
// Fork #3 — Deno producer ↔ gate consistency. `deno install --entrypoint main.ts`
// (the non-frozen sibling of the gate's `deno install --frozen --entrypoint
// main.ts`) run over the exported deno-source tree produces a deno.lock that
// `verifyDependencyLock` then validates offline as `verified: true` (the generate
// step populated the local Deno cache, so the frozen check resolves against it
// with DENO_OFFLINE=1), and re-running yields a BYTE-IDENTICAL lock (idempotent).
// It pins the whole main.ts→deps.ts graph, which since the shell stopped importing
// Hono is @electric-sql/pglite alone on the Deno target. CONFIRMED.
//
// Fork #4 — adopted-project replacement. The producer regenerates over the
// GENERATED package.json (buildNodeFiles + 6.3 pins), NOT the adopted project's
// own — so it REPLACES an adopted `package-lock.json` (which node_dependency_lock
// would reject, per the 6.2 "adopted-vs-generated twist") with one that matches the
// bytes we ship, turning a would-be gate FAIL into a PASS. This is the concrete
// user value. Covered by tests.
//
// Fork #5 — build stays offline/pure. runProductionBuild never imports or calls
// this module (this is a leaf; production-build.ts does not depend on it), so a
// build with no committed lock still self-skips both lock gates, unchanged.
//
// --- Validate-before-write (a safety improvement over "write then validate") ---
//
// The plan says "after writing each lock, run the offline gate as a post-
// condition". We run the gate on the PRODUCED BYTES IN MEMORY and commit them to
// <projectDir> ONLY when it verifies — the gates validate the lock inside the
// `files` array they are handed (projectDir only locates their scratch tmp dir),
// so no read of <projectDir> is needed to validate. This proves exactly the same
// property ("the build will accept this lock") while never clobbering the
// project's committed lock with an unverified one.
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildNodeFiles, writeExportFiles } from "../core/build.ts";
import {
  DEFAULT_APP_NAME,
  DEFAULT_APP_VERSION,
  type ExportFile,
  exportProject,
  type ExportProjectOptions,
  sha256Hex,
} from "../core/export.ts";
import type { Kernel } from "../core/registries.ts";
import type { Result } from "../core/types.ts";
import {
  denoToolchainFailure,
  resolveDenoToolchain,
} from "../core/deno-toolchain.ts";
import { LOCKFILE_PATH, verifyDependencyLock } from "./production-lock.ts";
import {
  PACKAGE_LOCKFILE_PATH,
  verifyNodeDependencyLock,
} from "./production-node-lock.ts";
import {
  type BuildTarget,
  NODE_TOOLCHAIN_ABSENT_DETAIL,
  nodeToolchainAvailable,
  NPM_LOCK_ONLY_ARGS,
  TARGET_DENO_SOURCE,
  TARGET_NODE,
  TARGET_NOT_SELECTED_DETAIL,
} from "./production-build.ts";

// The refreshable targets: the deno-source lock (deno.lock — also the lock a
// binary target compiles from) and the Node lock (package-lock.json). A subset of
// BuildTarget; the binary target has no lock of its own (deno compile snapshots the
// graph), so it is not refreshable. Reusing BuildTarget keeps target identity
// single-sourced with the gates — no divergent target strings.
export type RefreshTarget = typeof TARGET_DENO_SOURCE | typeof TARGET_NODE;

// The default target set for a refresh: both. A selected-but-absent Node toolchain
// skips cleanly (mirroring the gate preflight); deno is always present.
export const DEFAULT_REFRESH_TARGETS: ReadonlySet<RefreshTarget> = new Set([
  TARGET_DENO_SOURCE,
  TARGET_NODE,
]);

// Semantic error codes (no magic strings). Two per target: a GENERATION failure
// (the producer spawn failed or exited non-zero) and — distinct, as the plan
// requires — a produced-but-UNVERIFIED lock (the offline post-condition gate
// rejected what we produced, which should never happen and signals a real defect
// in the producer, not a stale user input).
export const DENO_LOCK_REFRESH_FAILED = "DENO_LOCK_REFRESH_FAILED";
export const DENO_LOCK_REFRESH_UNVERIFIED = "DENO_LOCK_REFRESH_UNVERIFIED";
export const NODE_LOCK_REFRESH_FAILED = "NODE_LOCK_REFRESH_FAILED";
export const NODE_LOCK_REFRESH_UNVERIFIED = "NODE_LOCK_REFRESH_UNVERIFIED";

// Distinct tmp dirs under <projectDir>/dist, self-cleaning, distinct from every
// gate's tmp dir (.tmp-dep-lock / .tmp-node-dep-lock / .tmp-*-smoke) so a refresh
// never corrupts a gate's working dir and vice-versa.
const DENO_REFRESH_TMP_DIR = ".tmp-deno-lock-refresh";
const NODE_REFRESH_TMP_DIR = ".tmp-node-lock-refresh";

// The non-frozen Deno producer: resolve main.ts's module graph and WRITE deno.lock
// (the frozen sibling the gate runs is `deno install --frozen …`). Network-allowed;
// DENO_NO_UPDATE_CHECK keeps Deno's own update probe quiet.
const DENO_LOCK_GEN_ARGS = ["install", "--entrypoint", "main.ts"] as const;
const DENO_GEN_ENV: Record<string, string> = { DENO_NO_UPDATE_CHECK: "1" };

const NODE_BIN = "npm";
const DENO_JSON_PATH = "deno.json";
const PACKAGE_JSON_PATH = "package.json";

// A lock the refresh produced, validated offline-valid, and committed. `sha256` is
// the hex SHA-256 of the exact committed lock bytes — the content-addressed subject
// of the Slice 7.4 `lock_refresh` ledger attestation (a later edit that regenerates
// the lock mints a new attestation over the new hash).
export interface RefreshedLock {
  lockfile: string;
  packageCount: number;
  sha256: string;
}

export type RefreshTargetStatus = "refreshed" | "skipped" | "failed";

// One target's refresh outcome. `code` is set only on "failed"; `detail` carries
// the write-and-validate summary, the skip reason, or the failure message. Mirrors
// the gate report's GateOutcome tri-state shape. `lock` carries the produced-lock
// provenance (lockfile, package count, SHA-256) and is present ONLY on "refreshed"
// — the endpoint reads it to mint the Slice 7.4 `lock_refresh` attestation. It is
// internal-only: the wire projection (projectLockRefreshReport) drops it.
export interface RefreshTargetOutcome {
  target: RefreshTarget;
  status: RefreshTargetStatus;
  code?: string;
  detail: string;
  lock?: RefreshedLock;
}

// The whole refresh result. `ok` iff no selected target FAILED — a skipped target
// (not selected, or an absent Node toolchain) is not a failure. Never a Result
// error: like runProductionBuild, a failing target is an expected `ok: false`.
export interface LockRefreshReport {
  ok: boolean;
  targets: RefreshTargetOutcome[];
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// A copy of the caller's export options with any committed-lock bytes stripped, so
// the producer builds the artifact from the kernel's OWN specifiers (pass 1) rather
// than seeding pins from a possibly-stale committed lock. The Node pass-2 build
// re-adds the freshly-produced lock via packageLock.
function stripLocks(opts?: ExportProjectOptions): ExportProjectOptions {
  const next: ExportProjectOptions = { ...opts };
  delete next.denoLock;
  delete next.packageLock;
  return next;
}

// Run npm's lock-only resolver in `dir` (which must already hold the generated
// package.json) and return the produced package-lock.json bytes, or a failure
// message. Network-allowed; uses the real (warm) npm cache — the OFFLINE isolation
// is the validator's concern, not the producer's. Never throws.
async function generateNodeLock(dir: string): Promise<Result<string>> {
  let output: Deno.CommandOutput;
  try {
    output = await new Deno.Command(NODE_BIN, {
      args: [...NPM_LOCK_ONLY_ARGS],
      cwd: dir,
      stdout: "piped",
      stderr: "piped",
    }).output();
  } catch (err) {
    return refreshFailure(
      NODE_LOCK_REFRESH_FAILED,
      `npm ${NPM_LOCK_ONLY_ARGS.join(" ")} could not run: ${errorMessage(err)}`,
    );
  }
  if (!output.success) {
    const stderr = new TextDecoder().decode(output.stderr).trim();
    return refreshFailure(
      NODE_LOCK_REFRESH_FAILED,
      `npm lock generation failed (exit code ${output.code}).${
        stderr ? `\n${stderr}` : ""
      }`,
    );
  }
  try {
    return {
      ok: true,
      data: readFileSync(join(dir, PACKAGE_LOCKFILE_PATH), "utf-8"),
    };
  } catch (err) {
    return refreshFailure(
      NODE_LOCK_REFRESH_FAILED,
      `npm produced no ${PACKAGE_LOCKFILE_PATH}: ${errorMessage(err)}`,
    );
  }
}

function refreshFailure<T>(code: string, message: string): Result<T> {
  return { ok: false, error: { code, message } };
}

/**
 * Produce a committed `<projectDir>/package-lock.json` that matches the exported
 * Node artifact's GENERATED `package.json`, via the INTERNAL TWO-PASS that makes
 * the lock's root-manifest mirror EXACT (fork #2), then prove it offline-valid and
 * commit it. Network-allowed; never throws.
 *
 * Pass 1 builds the Node artifact from the kernel's own specifiers (committed lock
 * stripped) and resolves a lock over its package.json. Pass 2 feeds that lock back
 * into buildNodeFiles so Slice 6.3 pins each user dep to the lock's exact resolved
 * version; if the package.json actually changed (a range → exact promotion) it
 * resolves a second lock whose mirror is now exact, otherwise it reuses pass 1's
 * lock (idempotent — fork #1). The final lock is validated IN MEMORY by
 * `verifyNodeDependencyLock` and written to `<projectDir>/package-lock.json` ONLY
 * on `verified: true`.
 */
export async function refreshNodeLock(
  kernel: Kernel,
  projectDir: string,
  opts?: ExportProjectOptions,
): Promise<Result<RefreshedLock>> {
  const cleanOpts = stripLocks(opts);
  const name = opts?.projectName ?? DEFAULT_APP_NAME;
  const version = opts?.projectVersion ?? DEFAULT_APP_VERSION;
  const tmpDir = join(projectDir, "dist", NODE_REFRESH_TMP_DIR);
  try {
    // Pass 1: no committed lock → user deps are their reshaped specifiers.
    const nodeFiles1 = await buildNodeFiles(kernel, name, version, cleanOpts);
    const packageJson1 = nodeFiles1.find((f) => f.path === PACKAGE_JSON_PATH);
    if (!packageJson1) {
      return refreshFailure(
        NODE_LOCK_REFRESH_FAILED,
        `${PACKAGE_JSON_PATH} missing from the Node artifact.`,
      );
    }
    const lock1 = await resolveNodeLockInTmp(tmpDir, packageJson1);
    if (!lock1.ok) return lock1;

    // Pass 2: feed pass-1's lock so Slice 6.3 exact-pins user deps. Only re-resolve
    // when the package.json actually changed (a range→exact promotion); otherwise
    // the inputs are identical and the lock would be byte-identical (fork #1).
    const nodeFiles2 = await buildNodeFiles(kernel, name, version, {
      ...cleanOpts,
      packageLock: lock1.data,
    });
    const packageJson2 = nodeFiles2.find((f) => f.path === PACKAGE_JSON_PATH);
    if (!packageJson2) {
      return refreshFailure(
        NODE_LOCK_REFRESH_FAILED,
        `${PACKAGE_JSON_PATH} missing from the Node artifact.`,
      );
    }

    let finalPackageJson = packageJson1;
    let finalLock = lock1.data;
    if (packageJson2.content !== packageJson1.content) {
      const lock2 = await resolveNodeLockInTmp(tmpDir, packageJson2);
      if (!lock2.ok) return lock2;
      finalPackageJson = packageJson2;
      finalLock = lock2.data;
    }

    // Offline post-condition on the PRODUCED bytes, before touching <projectDir>.
    const lockFile: ExportFile = {
      path: PACKAGE_LOCKFILE_PATH,
      content: finalLock,
    };
    const verified = await verifyNodeDependencyLock(
      [finalPackageJson, lockFile],
      projectDir,
    );
    if (!verified.ok) {
      return refreshFailure(
        NODE_LOCK_REFRESH_UNVERIFIED,
        `Produced ${PACKAGE_LOCKFILE_PATH} did not pass the offline frozen check: ${verified.error.message}`,
      );
    }
    if (!verified.data.verified) {
      // Defensive: the lock we just produced carries a package-lock.json, so the
      // gate should never report the no-lock skip. Treat it as a producer defect.
      return refreshFailure(
        NODE_LOCK_REFRESH_UNVERIFIED,
        `Produced ${PACKAGE_LOCKFILE_PATH} was unexpectedly treated as absent by the frozen check.`,
      );
    }

    writeFileSync(join(projectDir, PACKAGE_LOCKFILE_PATH), finalLock);
    return {
      ok: true,
      data: {
        lockfile: PACKAGE_LOCKFILE_PATH,
        packageCount: verified.data.packageCount,
        sha256: await sha256Hex(new TextEncoder().encode(finalLock)),
      },
    };
  } catch (err) {
    // buildNodeFiles (esbuild transpile) can throw on malformed sources; contain it.
    return refreshFailure(NODE_LOCK_REFRESH_FAILED, errorMessage(err));
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

// Write just the package.json into a fresh tmp dir and resolve a lock over it.
// Re-creates the dir each call so pass 2 never inherits pass 1's package-lock.json.
async function resolveNodeLockInTmp(
  tmpDir: string,
  packageJson: ExportFile,
): Promise<Result<string>> {
  rmSync(tmpDir, { recursive: true, force: true });
  writeExportFiles(tmpDir, [packageJson]);
  return await generateNodeLock(tmpDir);
}

/**
 * Produce a committed `<projectDir>/deno.lock` for the exported deno-source tree
 * (fork #3), prove it offline-valid, and commit it. Network-allowed; never throws.
 *
 * Exports the deno-source tree (committed lock stripped) into a tmp dir, runs the
 * non-frozen `deno install --entrypoint main.ts` to resolve the graph and write
 * deno.lock, then validates those bytes IN MEMORY with `verifyDependencyLock` (an
 * offline `deno install --frozen`, which resolves against the cache the generate
 * step just populated) and writes `<projectDir>/deno.lock` ONLY on `verified:
 * true`. This is also the lock a binary target compiles from — there is no separate
 * binary lock.
 */
export async function refreshDenoLock(
  kernel: Kernel,
  projectDir: string,
  opts?: ExportProjectOptions,
): Promise<Result<RefreshedLock>> {
  const cleanOpts = stripLocks(opts);
  const tmpDir = join(projectDir, "dist", DENO_REFRESH_TMP_DIR);
  try {
    const { files } = await exportProject(kernel, cleanOpts);
    // Sanity: the deno-source tree always carries deno.json + main.ts.
    if (!files.some((f) => f.path === DENO_JSON_PATH)) {
      return refreshFailure(
        DENO_LOCK_REFRESH_FAILED,
        `${DENO_JSON_PATH} missing from the export.`,
      );
    }

    // Generating the lock IS this function, so a missing toolchain is a refresh
    // failure with a named cause rather than a spawn error. This is also the one
    // place a lock gets produced for a desktop-built app, so the message is what
    // a user sees when asking why their export ships unpinned.
    const toolchain = resolveDenoToolchain();
    if (!toolchain.ok) {
      return refreshFailure(
        DENO_LOCK_REFRESH_FAILED,
        denoToolchainFailure(
          "Refreshing the dependency lock needs a Deno toolchain",
          toolchain.error,
        ),
      );
    }

    rmSync(tmpDir, { recursive: true, force: true });
    writeExportFiles(tmpDir, files);

    let output: Deno.CommandOutput;
    try {
      output = await new Deno.Command(toolchain.data, {
        args: [...DENO_LOCK_GEN_ARGS],
        cwd: tmpDir,
        stdout: "piped",
        stderr: "piped",
        env: DENO_GEN_ENV,
      }).output();
    } catch (err) {
      return refreshFailure(
        DENO_LOCK_REFRESH_FAILED,
        `deno ${DENO_LOCK_GEN_ARGS.join(" ")} could not run: ${
          errorMessage(err)
        }`,
      );
    }
    if (!output.success) {
      const stderr = new TextDecoder().decode(output.stderr).trim();
      return refreshFailure(
        DENO_LOCK_REFRESH_FAILED,
        `deno lock generation failed (exit code ${output.code}).${
          stderr ? `\n${stderr}` : ""
        }`,
      );
    }

    let lockBytes: string;
    try {
      lockBytes = readFileSync(join(tmpDir, LOCKFILE_PATH), "utf-8");
    } catch (err) {
      return refreshFailure(
        DENO_LOCK_REFRESH_FAILED,
        `deno produced no ${LOCKFILE_PATH}: ${errorMessage(err)}`,
      );
    }

    // Offline post-condition on the produced bytes, before touching <projectDir>.
    const lockFile: ExportFile = { path: LOCKFILE_PATH, content: lockBytes };
    const verified = await verifyDependencyLock(
      [...files, lockFile],
      projectDir,
    );
    if (!verified.ok) {
      return refreshFailure(
        DENO_LOCK_REFRESH_UNVERIFIED,
        `Produced ${LOCKFILE_PATH} did not pass the offline frozen check: ${verified.error.message}`,
      );
    }
    if (!verified.data.verified) {
      return refreshFailure(
        DENO_LOCK_REFRESH_UNVERIFIED,
        `Produced ${LOCKFILE_PATH} was unexpectedly treated as absent by the frozen check.`,
      );
    }

    writeFileSync(join(projectDir, LOCKFILE_PATH), lockBytes);
    return {
      ok: true,
      data: {
        lockfile: LOCKFILE_PATH,
        packageCount: verified.data.packageCount,
        sha256: await sha256Hex(new TextEncoder().encode(lockBytes)),
      },
    };
  } catch (err) {
    return refreshFailure(DENO_LOCK_REFRESH_FAILED, errorMessage(err));
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

// Map a per-target Result to a RefreshTargetOutcome.
function toRefreshOutcome(
  target: RefreshTarget,
  result: Result<RefreshedLock>,
): RefreshTargetOutcome {
  if (!result.ok) {
    return {
      target,
      status: "failed",
      code: result.error.code,
      detail: result.error.message,
    };
  }
  const { lockfile, packageCount } = result.data;
  const noun = target === TARGET_NODE ? "package" : "specifier";
  return {
    target,
    status: "refreshed",
    detail: `Refreshed ${lockfile} (${packageCount} ${noun}${
      packageCount === 1 ? "" : "s"
    }); frozen-valid.`,
    lock: result.data,
  };
}

function skippedRefresh(
  target: RefreshTarget,
  reason: string,
): RefreshTargetOutcome {
  return { target, status: "skipped", detail: reason };
}

/**
 * Refresh the committed lock files for a selected set of targets, each written into
 * `<projectDir>` and proven offline-valid. Never throws; returns a per-target
 * report whose `ok` is true iff no selected target failed.
 *
 * `targets` selects which locks to refresh (default: both). A target not in the set
 * is reported as `skipped` (`"target not selected"`). The Node target additionally
 * passes the same `nodeToolchainAvailable` preflight the gates use — an absent
 * node/npm toolchain is a clean `skipped` (`"node/npm not found on PATH"`), not a
 * failure — so a Deno-only box can refresh its deno.lock and cleanly skip the Node
 * lock. The deno-source target never skips for toolchain reasons (deno is always
 * present). The probe is injectable so tests can exercise the absent path.
 *
 * This is a network-allowed producer, NOT a gate: it is never called by
 * runProductionBuild, and the pipeline stays pure and offline.
 */
export async function refreshLocks(
  kernel: Kernel,
  projectDir: string,
  opts?: ExportProjectOptions,
  targets: ReadonlySet<BuildTarget> = DEFAULT_REFRESH_TARGETS,
  nodeToolchainProbe: () => Promise<boolean> = nodeToolchainAvailable,
): Promise<LockRefreshReport> {
  const outcomes: RefreshTargetOutcome[] = [];

  // Deno-source lock (also the binary target's lock). Deno is always present.
  if (targets.has(TARGET_DENO_SOURCE)) {
    outcomes.push(
      toRefreshOutcome(
        TARGET_DENO_SOURCE,
        await refreshDenoLock(kernel, projectDir, opts),
      ),
    );
  } else {
    outcomes.push(
      skippedRefresh(TARGET_DENO_SOURCE, TARGET_NOT_SELECTED_DETAIL),
    );
  }

  // Node lock — selection checked FIRST (no probe spawn for an unselected target),
  // then the toolchain preflight, exactly like the gates.
  if (!targets.has(TARGET_NODE)) {
    outcomes.push(skippedRefresh(TARGET_NODE, TARGET_NOT_SELECTED_DETAIL));
  } else if (!(await nodeToolchainProbe())) {
    outcomes.push(skippedRefresh(TARGET_NODE, NODE_TOOLCHAIN_ABSENT_DETAIL));
  } else {
    outcomes.push(
      toRefreshOutcome(
        TARGET_NODE,
        await refreshNodeLock(kernel, projectDir, opts),
      ),
    );
  }

  return {
    ok: outcomes.every((o) => o.status !== "failed"),
    targets: outcomes,
  };
}
