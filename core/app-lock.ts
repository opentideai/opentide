// @layer core — the app's own dependency lock.
//
// `install_package` loads an npm package with a dynamic `import()` so the module
// is live in `packages.<name>`. That import resolves against the LOCK OF THE
// PROCESS, which is the kernel repo's — so an app's dependency used to be
// recorded in the kernel's `deno.lock` and nowhere near the app. Two bad
// consequences: the kernel repo accumulated dependency records for software it
// does not ship, and the app itself exported with no lock at all, which is why
// the production `dependency_lock` gate has been skipping (verification/
// production-lock.ts) and `audit-packages.ts` had nothing pinned to audit.
//
// This module fixes the second consequence: it records each app package's
// resolution in `<projectDir>/deno.lock`, where the export already knows to look
// (core/export.ts ships it verbatim) and where the gate can verify it offline.
//
// The FIRST consequence — the kernel's own lock collecting app resolutions —
// is deliberately left alone. `--no-lock` on the runtime entrypoints would stop
// it, but several deps in deno.json carry no version at all, so the lockfile is
// the only thing pinning them: without it `npm:@electric-sql/pglite@*` floats off
// its pinned 0.4.5 to whatever npm serves today, and the new engine cannot open
// existing data directories. That was tried and reverted. See
// docs/dependencies.md.
//
// The mechanism is a `deno cache` subprocess pointed at the project's lock. It
// cannot be done in-process: a lockfile path is fixed for the lifetime of a Deno
// process, so the only way to write a different one is to run another Deno.
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { errorMessage } from "./util.ts";
import { resolveDenoToolchain } from "./deno-toolchain.ts";
import type { Result } from "./types.ts";

// The lockfile a project owns, matching what verification/production-lock.ts
// reads and core/export.ts ships.
export const PROJECT_LOCKFILE = "deno.lock";

// How long a lock sync may take before it is abandoned. Generous — it may have to
// reach npm for a package that is not in the local Deno cache yet — but bounded,
// because a hung subprocess must never wedge an install.
export const LOCK_SYNC_TIMEOUT_MS = 90_000;
// The cap on the project-load path, which a user is waiting behind. Much shorter
// because by then every package has just been imported, so `deno cache` resolves
// from the local Deno cache and does no network work. If it somehow cannot, the
// next install repairs the lock — that is worth more than a slow project open.
export const LOCK_SYNC_LOAD_TIMEOUT_MS = 15_000;

export interface LockSyncResult {
  // Specifiers that were missing from the lock and have now been recorded.
  added: string[];
  // True when nothing had to run: every specifier was already pinned.
  upToDate: boolean;
}

/**
 * The specifiers a lock does not yet pin.
 *
 * Deliberately a substring test against the raw lockfile text rather than a
 * parse: Deno's lockfile schema is its own business and has changed shape across
 * versions, whereas the exact specifier string we wrote ("npm:marked@18") is
 * stable and is what appears as a key. The failure mode of being too crude here
 * is a redundant `deno cache` run, which is a no-op — so crude is the right
 * trade against parsing a format we do not own.
 */
// The lock keys a specifier could legitimately appear under.
//
// An UNPINNED install ("npm:linkedom", no version — which install_package
// produces when the agent omits one) is recorded by Deno as "npm:linkedom@*".
// Without this, such a package reads as missing on every single check and the
// sync spawns a `deno cache` on every project load forever. Scoped names are why
// this is not a naive indexOf("@"): "npm:@mozilla/readability" has an `@` that is
// part of the scope, not a version.
export function lockKeyCandidates(specifier: string): string[] {
  const body = specifier.startsWith("npm:")
    ? specifier.slice("npm:".length)
    : specifier;
  const scopeEnd = body.startsWith("@") ? body.indexOf("/") + 1 : 0;
  const pinned = scopeEnd >= 0 && body.includes("@", scopeEnd);
  return pinned ? [specifier] : [specifier, `${specifier}@*`];
}

export function missingSpecifiers(
  lockText: string | undefined,
  specifiers: readonly string[],
): string[] {
  const unique = [...new Set(specifiers)];
  if (!lockText) return unique;
  return unique.filter((specifier) =>
    !lockKeyCandidates(specifier).some((key) => lockText.includes(`"${key}"`))
  );
}

function readLock(projectDir: string): string | undefined {
  try {
    return readFileSync(join(projectDir, PROJECT_LOCKFILE), "utf-8");
  } catch {
    return undefined;
  }
}

// A module whose only job is to name every dependency, so `deno cache` resolves
// the full set in one pass. Sorted so the same package set always produces the
// same bytes — this file is temporary, but determinism here keeps a re-run from
// looking like a change.
export function lockEntrypointSource(specifiers: readonly string[]): string {
  return [...new Set(specifiers)].sort()
    .map((specifier) => `import ${JSON.stringify(specifier)};`)
    .join("\n") + "\n";
}

/**
 * Record every app package's resolution in `<projectDir>/deno.lock`.
 *
 * MERGES, never rewrites: `deno cache --lock` adds to an existing lock and
 * leaves the rest alone. That matters because a source-backed project's
 * `deno.lock` is the user's own file, describing their own code — clobbering it
 * to hold only the packages Genie installed would destroy real data. The cost of
 * merging is that a removed package's entry lingers, which is harmless: a lock
 * entry is a resolution record, inert unless something imports it.
 *
 * Returns a Result rather than throwing, and the caller is expected to treat a
 * failure as non-fatal — the package is already installed and working in memory
 * by the time this runs. A missing `deno` binary (a compiled desktop build has
 * no Deno on PATH) is the expected reason to fail, and it must not turn a
 * successful install into a failed one.
 */
export async function syncProjectLock(
  projectDir: string,
  specifiers: readonly string[],
  timeoutMs: number = LOCK_SYNC_TIMEOUT_MS,
  // The toolchain lookup, injectable so a test can assert the no-deno path on a
  // box that has deno — mirroring refreshLocks' `nodeToolchainProbe`. Production
  // callers pass nothing.
  toolchainProbe: () => Result<string> = resolveDenoToolchain,
): Promise<Result<LockSyncResult>> {
  const missing = missingSpecifiers(readLock(projectDir), specifiers);
  if (missing.length === 0) {
    return { ok: true, data: { added: [], upToDate: true } };
  }

  // Resolve the toolchain BEFORE staging a temp entrypoint: with no `deno` to
  // run there is nothing to stage it for, and the resolver's reason is better
  // than the spawn error it replaces. Still LOCK_SYNC_UNAVAILABLE, still
  // best-effort — the caller logs it and the install stands.
  const toolchain = toolchainProbe();
  if (!toolchain.ok) {
    return {
      ok: false,
      error: {
        code: "LOCK_SYNC_UNAVAILABLE",
        message: toolchain.error.message,
        suggestion: [
          "The package is installed and usable; only its lock record is missing.",
          toolchain.error.suggestion,
        ].filter(Boolean).join(" "),
      },
    };
  }

  // Resolve the FULL set, not just the missing ones: a lock records a coherent
  // graph, and asking for everything lets Deno reconcile shared transitive deps
  // in one pass instead of appending N partial views of them.
  const all = [...new Set(specifiers)];
  let entrypoint: string;
  try {
    entrypoint = await Deno.makeTempFile({
      prefix: "genie-lock-",
      suffix: ".ts",
    });
    await Deno.writeTextFile(entrypoint, lockEntrypointSource(all));
  } catch (err) {
    return {
      ok: false,
      error: {
        code: "LOCK_SYNC_SETUP_FAILED",
        message: `Could not stage the lock entrypoint: ${errorMessage(err)}`,
      },
    };
  }

  try {
    const command = new Deno.Command(toolchain.data, {
      args: [
        "cache",
        // The project is not this repo: its deps must not be resolved through
        // the kernel's import map, or an app importing "marked" would silently
        // pick up the kernel's pin.
        "--no-config",
        `--lock=${join(projectDir, PROJECT_LOCKFILE)}`,
        entrypoint,
      ],
      stdout: "piped",
      stderr: "piped",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const { code, stderr } = await command.output();
    if (code !== 0) {
      return {
        ok: false,
        error: {
          code: "LOCK_SYNC_FAILED",
          message: new TextDecoder().decode(stderr).trim() ||
            `deno cache exited ${code}.`,
          suggestion:
            "The package is installed and usable; only its lock record is missing. " +
            "Re-run the install once the resolution problem is fixed to restore it.",
        },
      };
    }
    return { ok: true, data: { added: missing, upToDate: false } };
  } catch (err) {
    return {
      ok: false,
      error: {
        code: "LOCK_SYNC_UNAVAILABLE",
        message: errorMessage(err),
        // The no-toolchain case is caught above, so anything reaching here is a
        // spawn or timeout failure of a `deno` that does exist.
        suggestion:
          "The package is installed and usable; only its lock record is missing. " +
          "Re-run the install once `deno cache` can run to restore it.",
      },
    };
  } finally {
    await Deno.remove(entrypoint).catch(() => {});
  }
}
