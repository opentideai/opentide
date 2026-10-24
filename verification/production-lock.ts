// @layer verification — the dependency-lock gate (Milestone 6, Slice 6.1). A
// Result-returning, never-throwing gate that proves the committed `deno.lock`
// shipped in a Deno-source export is FROZEN-valid for that export's exact
// dependency graph, validated OFFLINE against the local Deno cache. It is the
// deno-source counterpart to the Node smoke gate's ephemeral frozen install —
// but where that gate *generates* a throwaway lock, this gate *validates* a
// committed one that ships in the artifact.
//
// --- The two forks the plan flagged, resolved empirically (Deno 2.9) ----------
//
// Fork #1 — where the committed lock comes from. The lock is a PRE-EXISTING
// input, never produced at build time: `readCommittedLock(projectDir)` reads
// `<projectDir>/deno.lock` verbatim (an adopted / source-backed Deno project has
// one; core/codebase/discovery.ts already maps deno.lock → the "deno" package
// manager). The orchestrator threads its bytes through `ExportProjectOptions.
// denoLock` so `exportProject` emits it as an ExportFile without itself touching
// the filesystem (keeping the export path pure and deterministic — same bytes in,
// same bytes out). A generated-from-scratch app has no committed lock, so none is
// emitted and this gate SKIPS cleanly (a missing lock for an app that never had
// one is not a regression). The framework's own root deno.lock is deliberately
// NOT used: it is a full-graph SUPERSET (ai-sdk, mcp, drizzle, …), and `--frozen`
// requires the lock to match the module graph EXACTLY — a superset is reported
// "out of date", so only a lock built for the exported app's graph validates.
//
// Fork #2 — the offline frozen check. `deno install --frozen --entrypoint main.ts`
// with `DENO_OFFLINE=1`: it loads main.ts's module graph, recomputes what the lock
// must be, and diffs it against the committed lock — exit 0 on an exact match
// (validated against the pre-populated cache, no network), exit 1 on any mismatch
// (a wrong/absent version, a superset, a corrupt lock). The gate keys on that exit
// code the way the Node gate keys on `npm ci`. The build only ever VALIDATES this
// lock — refreshing/regenerating it is an explicit, network-allowed action OUTSIDE
// the build path (a later slice), never something a production build does.
//
// Because the lock ships as an ExportFile, the manifest gate hashes it and the
// determinism gate byte-covers it for FREE — no change to those gates.
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { type ExportFile, fileBytes } from "../core/export.ts";
import { writeExportFiles } from "../core/build.ts";
import type { Result } from "../core/types.ts";
import {
  denoToolchainFailure,
  resolveDenoToolchain,
} from "../core/deno-toolchain.ts";

// The committed lockfile's path in the export tree (Deno's fixed lockfile name).
export const LOCKFILE_PATH = "deno.lock";

// The entrypoint whose module graph the frozen check resolves against.
const MAIN_ENTRYPOINT = "main.ts";

// Semantic error codes (no magic strings). MALFORMED is the pure pre-check
// failure; the umbrella EXPORT_DEPENDENCY_LOCK_FAILED covers the frozen check
// (a stale/mismatched lock or a spawn failure) — mirroring the one-umbrella-code
// convention of the other process gates (EXPORT_TYPE_CHECK_FAILED, …).
export const DEPENDENCY_LOCK_INVALID = "DEPENDENCY_LOCK_INVALID";
export const EXPORT_DEPENDENCY_LOCK_FAILED = "EXPORT_DEPENDENCY_LOCK_FAILED";

// The skip reason for an export that carries no committed lock — a generated app
// that never had one. Exported so tests can assert the skip without a magic string.
export const NO_COMMITTED_LOCK_DETAIL = "no committed deno.lock to validate";

// The gate's own tmp dir under <projectDir>/dist, distinct from every smoke dir.
const LOCK_TMP_DIR = ".tmp-dep-lock";

// The offline frozen-validation command. `--frozen` makes a mismatch a non-zero
// exit instead of a silent lock rewrite; `--entrypoint main.ts` gives it the
// module graph to validate the lock against.
const FROZEN_CHECK_ARGS = [
  "install",
  "--frozen",
  "--entrypoint",
  MAIN_ENTRYPOINT,
] as const;

// Force the validation fully offline: the committed lock is checked against the
// pre-populated local cache, never the network — "the build validates, never
// refreshes, a lock." DENO_NO_UPDATE_CHECK keeps Deno's own update probe off the
// wire too, so the gate makes no network calls at all.
const OFFLINE_ENV: Record<string, string> = {
  DENO_OFFLINE: "1",
  DENO_NO_UPDATE_CHECK: "1",
};

// The gate's typed outcome. A discriminated union so the orchestrator can map a
// clean SKIP (`verified: false`, no committed lock) to a skipped GateOutcome and
// a real validation (`verified: true`) to a passed one — both are `ok: true`
// Results; only a malformed/stale lock is an `ok: false` failure.
export type DependencyLockVerification =
  | { verified: true; lockfile: string; packageCount: number }
  | { verified: false; reason: string };

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Read the committed `<projectDir>/deno.lock` verbatim, or undefined when the
// project has none (a generated app) or it can't be read. Never throws — a
// missing/unreadable lock simply means "nothing to ship", and the gate then
// skips. This is the ONLY filesystem read in the sourcing path; the export
// itself stays pure by receiving the bytes via ExportProjectOptions.denoLock.
export function readCommittedLock(projectDir: string): string | undefined {
  try {
    return readFileSync(join(projectDir, LOCKFILE_PATH), "utf-8");
  } catch {
    return undefined;
  }
}

// Count the specifiers a lock pins, for the passing gate's detail. Returns 0 for
// a lock with no `specifiers` map. Assumes `text` already parsed as an object
// (the structure pre-check runs first).
function countLockedSpecifiers(parsed: Record<string, unknown>): number {
  const specifiers = parsed.specifiers;
  return specifiers && typeof specifiers === "object"
    ? Object.keys(specifiers).length
    : 0;
}

// Pure well-formedness pre-check on the committed lock BEFORE spawning anything:
// it must parse as a JSON object carrying a string `version` (every Deno lockfile
// does). Returns the parsed object on success, or a MALFORMED failure message.
// A garbage lock fails here (fast, offline) rather than as an opaque frozen exit.
function parseLock(text: string): Result<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return {
      ok: false,
      error: {
        code: DEPENDENCY_LOCK_INVALID,
        message: `${LOCKFILE_PATH} is not valid JSON: ${errorMessage(err)}`,
      },
    };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return {
      ok: false,
      error: {
        code: DEPENDENCY_LOCK_INVALID,
        message: `${LOCKFILE_PATH} must be a JSON object.`,
      },
    };
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.version !== "string") {
    return {
      ok: false,
      error: {
        code: DEPENDENCY_LOCK_INVALID,
        message: `${LOCKFILE_PATH} is missing a string "version".`,
      },
    };
  }
  return { ok: true, data: record };
}

function lockFailure(message: string): Result<DependencyLockVerification> {
  return {
    ok: false,
    error: { code: EXPORT_DEPENDENCY_LOCK_FAILED, message },
  };
}

/**
 * Gate: the committed `deno.lock` shipped in `files` is frozen-valid for the
 * exported app's exact dependency graph, validated offline. Never throws.
 *
 * - No `deno.lock` in the export → `ok: true` with `verified: false` (a clean
 *   SKIP; the orchestrator renders it as a skipped gate, not a failure).
 * - Present but malformed (unparseable / not an object / no version) →
 *   `DEPENDENCY_LOCK_INVALID` (a fast, offline, pure pre-check).
 * - Present and well-formed → writes the full export to a tmp dir and runs the
 *   offline frozen check; exit 0 → `verified: true`; any non-zero exit or a
 *   spawn failure → `EXPORT_DEPENDENCY_LOCK_FAILED` (stale / mismatched lock).
 *
 * `projectDir` only locates the (self-cleaning) tmp dir; the lock bytes come from
 * `files`, so this gate re-reads nothing from the project.
 */
export async function verifyDependencyLock(
  files: ExportFile[],
  projectDir: string,
): Promise<Result<DependencyLockVerification>> {
  const lock = files.find((f) => f.path === LOCKFILE_PATH);
  if (!lock) {
    return { ok: true, data: { verified: false, reason: NO_COMMITTED_LOCK_DETAIL } };
  }

  const parsed = parseLock(new TextDecoder().decode(fileBytes(lock)));
  if (!parsed.ok) return parsed;
  const packageCount = countLockedSpecifiers(parsed.data);

  // A gate that cannot run must not report a pass, so a missing toolchain fails
  // this gate exactly as a spawn failure always did — but naming the cause. Note
  // the asymmetry with the no-lock case above, which SKIPS: an app that never had
  // a lock is not a regression, whereas a lock we are unable to check is.
  const toolchain = resolveDenoToolchain();
  if (!toolchain.ok) {
    return lockFailure(
      denoToolchainFailure(
        "The dependency lock check needs a Deno toolchain",
        toolchain.error,
      ),
    );
  }

  const tmpDir = join(projectDir, "dist", LOCK_TMP_DIR);
  try {
    rmSync(tmpDir, { recursive: true, force: true });
    // The frozen check needs the WHOLE export (main.ts + its graph + the lock),
    // so the full file set is written, not just the lock.
    writeExportFiles(tmpDir, files);

    let output: Deno.CommandOutput;
    try {
      output = await new Deno.Command(toolchain.data, {
        args: [...FROZEN_CHECK_ARGS],
        cwd: tmpDir,
        stdout: "piped",
        stderr: "piped",
        env: OFFLINE_ENV,
      }).output();
    } catch (err) {
      return lockFailure(
        `Dependency lock check could not run: ${errorMessage(err)}`,
      );
    }

    if (!output.success) {
      const stderr = new TextDecoder().decode(output.stderr).trim();
      return lockFailure(
        `Committed ${LOCKFILE_PATH} is not frozen-valid for the exported app (exit code ${output.code}).${
          stderr ? `\n${stderr}` : ""
        }`,
      );
    }

    return {
      ok: true,
      data: { verified: true, lockfile: LOCKFILE_PATH, packageCount },
    };
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}
