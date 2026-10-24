// @layer core — the shared atomic-JSON file primitive.
//
// A crash or a concurrent multi-writer must never leave a truncated/interleaved
// JSON file on disk, and a corrupt file (crash mid-write, manual edit) must never
// brick the operation that reads it. Both concerns had three hand-rolled copies
// across the tree (project-manager.ts's writeRegistryFileAtomic / readRegistryFile
// and writeManifestAtomic); the orchestrator state store (Feature B) would have
// been a fourth. Per CLAUDE.md DRY this extracts the one pattern the callers now
// share. See docs/orchestrator-design.md §5.

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

// Atomic write: serialize `value` to a temp sibling then rename over the target —
// rename is atomic on POSIX, so a crash or a concurrent writer can never expose a
// half-written file (a reader sees either the old bytes or the new, never a splice).
// Pretty-printed (2-space) so the on-disk file stays human-inspectable.
export function writeJsonAtomic(path: string, value: unknown): void {
  const tmpPath = `${path}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(value, null, 2));
  renameSync(tmpPath, path);
}

// Read + JSON.parse a file, degrading to `fallback()` instead of throwing when the
// file is absent or corrupt. A corrupt file (parse error, or a `validate` that
// rejects the shape) is quarantined by renaming it to `${path}.corrupt` for a
// post-mortem rather than being silently discarded, then the fallback is returned —
// a bad state file must never brick boot.
//
// `validate`, when supplied, both narrows the parsed `unknown` to `T` and acts as a
// second corruption gate: returning null means "structurally wrong" and triggers
// the same quarantine-then-fallback path as a parse error. Omit it to accept any
// parseable JSON verbatim (the registry/manifest callers, preserving their prior
// unchecked-cast behavior).
export function readJsonQuarantine<T>(
  path: string,
  fallback: () => T,
  validate?: (raw: unknown) => T | null,
): T {
  if (!existsSync(path)) return fallback();
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    quarantine(path);
    return fallback();
  }
  if (!validate) return raw as T;
  const validated = validate(raw);
  if (validated === null) {
    quarantine(path);
    return fallback();
  }
  return validated;
}

// Move a corrupt file aside for post-mortem. Best-effort: if even the rename fails
// (permissions, races), we still degrade to the fallback rather than throwing.
function quarantine(path: string): void {
  try {
    renameSync(path, `${path}.corrupt`);
  } catch {
    // Can't move it aside — still degrade to the fallback in the caller.
  }
}
