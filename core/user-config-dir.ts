import { existsSync, renameSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ~/.config/opentide. Builds before the rename used ~/.config/tideide; the first
// call per HOME moves that directory here and leaves a symlink at the old path,
// so an older binary (or the Tide desktop) still finds keys and backups.
const USER_CONFIG_DIR_NAME = "opentide";
const LEGACY_USER_CONFIG_DIR_NAME = "tideide";

const settledHomes = new Map<string, string>();

// Resolved per call, not at module load, so tests that relocate HOME get a
// clean config root.
export function userConfigDir(): string {
  const home = homedir();
  const known = settledHomes.get(home);
  if (known) return known;
  const configRoot = join(home, ".config");
  const dir = adoptLegacyUserConfigDir(
    join(configRoot, LEGACY_USER_CONFIG_DIR_NAME),
    join(configRoot, USER_CONFIG_DIR_NAME),
  );
  settledHomes.set(home, dir);
  return dir;
}

// Moves `legacy` to `dir` once and links the old path to the new one. Returns
// the directory to use: `dir`, or `legacy` when the move failed and nothing
// else made `dir` in the meantime.
export function adoptLegacyUserConfigDir(legacy: string, dir: string): string {
  if (existsSync(dir) || !existsSync(legacy)) return dir;
  try {
    renameSync(legacy, dir);
  } catch {
    // Another process may have moved it first.
    return existsSync(dir) ? dir : legacy;
  }
  try {
    symlinkSync(USER_CONFIG_DIR_NAME, legacy);
  } catch {
    // The link only serves older builds; the move itself succeeded.
  }
  return dir;
}
