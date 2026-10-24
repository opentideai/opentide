// @layer core — the one answer to "is a Deno toolchain available, and where?"
//
// Several kernel features shell out to `deno`: the app dependency lock (deno
// cache), binary export and the export type check (deno compile / deno check),
// debug sessions (deno run), and the production gates (deno install --frozen,
// deno task start). Each used to resolve the binary its own way, and both ways
// were wrong in a compiled build:
//
//   - `Deno.execPath()` is the RUNNING EXECUTABLE. Under `deno run` that is a
//     real deno, but inside a `deno compile` binary it is the compiled binary
//     itself. Spawning it with deno's arguments does not fail cleanly — the
//     desktop sidecar's arg parser ignores bare positionals, so `deno check
//     main.ts` booted a SECOND full kernel that bound the control port and never
//     exited, leaving a zombie behind an HTTP request that hung forever.
//   - Bare `"deno"` relies on PATH. A desktop user has no deno on PATH, so the
//     spawn failed with `Failed to spawn 'deno': entity not found` — truthful to
//     the kernel, meaningless to the person who clicked the button.
//
// `Deno.build.standalone` is the official, first-class signal for the compiled
// case (false under `deno run`, true inside a `deno compile` binary), so this
// needs no heuristics. Callers ask once, and report their own specific reason
// when the answer is no — nothing here decides whether a missing toolchain is
// fatal, because that differs per feature (a missing lock record is best-effort;
// a verification gate that cannot run must not report a pass).
import { statSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import type { Result } from "./types.ts";

export const DENO_TOOLCHAIN_UNAVAILABLE = "DENO_TOOLCHAIN_UNAVAILABLE";

// The executable's name on each platform, for the PATH scan.
const DENO_BINARY_NAME = "deno";
const DENO_BINARY_NAME_WINDOWS = "deno.exe";

// What a caller appends to its own message so the user knows what to do about
// it. Kept here so all six call sites give the same instruction.
export const DENO_TOOLCHAIN_SUGGESTION =
  "Install Deno (https://deno.land) and make sure `deno` is on PATH, then retry.";

// The seams a test overrides. Defaults read the real process; every field is
// optional so production callers pass nothing.
export interface DenoToolchainProbe {
  // Deno.build.standalone — true inside a `deno compile` binary.
  standalone?: boolean;
  // The running executable's path (only trustworthy when not standalone).
  execPath?: () => string;
  // The raw PATH variable to scan when the running executable is not a deno.
  pathVar?: string | null;
  // Path separator for PATH entries, and the binary name to look for. Both
  // default to the host's, and exist so a test can exercise the Windows shape
  // on a POSIX box.
  pathDelimiter?: string;
  binaryName?: string;
  // Whether a candidate path is an existing regular file. Defaults to a stat.
  isFile?: (path: string) => boolean;
}

// `Deno.execPath()` can report a path that no longer exists — Linux appends
// " (deleted)" when the running binary was replaced or removed underneath the
// process. That string is not a usable command, so it falls through to the PATH
// scan rather than being spawned. Preserved from the previous
// denoExecutablePath() behaviour it replaces.
function usableExecPath(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.includes("(deleted)")) return null;
  return trimmed;
}

function defaultIsFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

// The desktop bundle ships its own `deno` beside the sidecar (Tauri externalBin,
// scripts/build-desktop.ts), because a desktop user has none on PATH and four
// kernel features need one. Checked BEFORE the PATH scan so the bundle is
// self-contained and does not silently pick up whatever version a developer
// happens to have installed — the bundled one is the version this kernel was
// built against.
//
// Only meaningful when standalone: under `deno run` the running executable is
// already a toolchain and we never get here.
function findBesideExecutable(probe: DenoToolchainProbe): string | null {
  const running = usableExecPath((probe.execPath ?? Deno.execPath)());
  if (!running) return null;
  const name = probe.binaryName ??
    (Deno.build.os === "windows" ? DENO_BINARY_NAME_WINDOWS : DENO_BINARY_NAME);
  const candidate = join(dirname(running), name);
  return (probe.isFile ?? defaultIsFile)(candidate) ? candidate : null;
}

function findOnPath(probe: DenoToolchainProbe): string | null {
  const pathVar = probe.pathVar !== undefined
    ? probe.pathVar
    : Deno.env.get("PATH") ?? null;
  if (!pathVar) return null;
  const sep = probe.pathDelimiter ?? delimiter;
  const name = probe.binaryName ??
    (Deno.build.os === "windows" ? DENO_BINARY_NAME_WINDOWS : DENO_BINARY_NAME);
  const isFile = probe.isFile ?? defaultIsFile;
  for (const dir of pathVar.split(sep)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    if (isFile(candidate)) return candidate;
  }
  return null;
}

function unavailable(standalone: boolean): Result<string> {
  return {
    ok: false,
    error: {
      code: DENO_TOOLCHAIN_UNAVAILABLE,
      message: standalone
        ? "No Deno toolchain found. This kernel is a compiled binary, so it " +
          "cannot run `deno` itself; no `deno` was bundled beside it, and none " +
          "is on PATH."
        : "No Deno toolchain found: no `deno` executable is on PATH.",
      suggestion: DENO_TOOLCHAIN_SUGGESTION,
    },
  };
}

/**
 * Resolve a command that really is a Deno toolchain, or explain why there isn't
 * one. Never throws, never spawns anything.
 *
 * - Not standalone → the running executable IS deno; use its path.
 * - Standalone → the `deno` bundled beside the sidecar, else scan PATH.
 * - Neither → `DENO_TOOLCHAIN_UNAVAILABLE` with a reason that names the
 *   compiled-binary case explicitly, because that is the one a desktop user hits
 *   and the one no error message used to mention.
 */
export function resolveDenoToolchain(
  probe: DenoToolchainProbe = {},
): Result<string> {
  const standalone = probe.standalone ?? Deno.build.standalone;
  if (!standalone) {
    const running = usableExecPath((probe.execPath ?? Deno.execPath)());
    if (running) return { ok: true, data: running };
  } else {
    const bundled = findBesideExecutable(probe);
    if (bundled) return { ok: true, data: bundled };
  }
  const onPath = findOnPath(probe);
  if (onPath) return { ok: true, data: onPath };
  return unavailable(standalone);
}

/**
 * The resolver's message as a single line, for callers whose failure channel is
 * a bare string (a build job's `error`, a gate's failure detail) rather than a
 * Result. `prefix` names what specifically could not happen, so the user reads
 * "Binary export needs a Deno toolchain" before the reason.
 */
export function denoToolchainFailure(
  prefix: string,
  error: { message: string; suggestion?: string },
): string {
  return [`${prefix}: ${error.message}`, error.suggestion]
    .filter(Boolean)
    .join(" ");
}
