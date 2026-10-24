import {
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

// A project's manifest and its local state directory. Projects made before the
// rename have tideide.json and .tideide/. Opening, loading or locking such a
// project renames both and points its .gitignore at the new directory. Until
// then the path helpers resolve to whichever layout is on disk, so reading
// another project (summaries, its sessions) sees its real state and moves
// nothing.
export const PROJECT_MANIFEST_FILE = "opentide.json";
export const PROJECT_STATE_DIR_NAME = ".opentide";
const LEGACY_PROJECT_MANIFEST_FILE = "tideide.json";
const LEGACY_PROJECT_STATE_DIR_NAME = ".tideide";
const GITIGNORE_FILE = ".gitignore";

const adopted = new Set<string>();

export function projectManifestPath(projectDir: string): string {
  const current = join(projectDir, PROJECT_MANIFEST_FILE);
  const legacy = join(projectDir, LEGACY_PROJECT_MANIFEST_FILE);
  return !existsSync(current) && existsSync(legacy) ? legacy : current;
}

export function projectStateDir(projectDir: string): string {
  const current = join(projectDir, PROJECT_STATE_DIR_NAME);
  const legacy = join(projectDir, LEGACY_PROJECT_STATE_DIR_NAME);
  return existsSync(legacy) && holdsNoFiles(current) ? legacy : current;
}

// True for a project in either layout. Read-only.
export function hasProjectManifest(projectDir: string): boolean {
  return existsSync(join(projectDir, PROJECT_MANIFEST_FILE)) ||
    existsSync(join(projectDir, LEGACY_PROJECT_MANIFEST_FILE));
}

// Renames a pre-rename project's manifest and state dir, once per process per
// directory. Anything already at the new name is left alone, so this never
// overwrites. A failed rename leaves the old layout in place for the next try.
export function adoptLegacyProjectLayout(projectDir: string): void {
  const dir = resolve(projectDir);
  if (adopted.has(dir)) return;
  adopted.add(dir);
  const movedState = moveIfOnlyLegacy(
    join(dir, LEGACY_PROJECT_STATE_DIR_NAME),
    join(dir, PROJECT_STATE_DIR_NAME),
  );
  moveIfOnlyLegacy(
    join(dir, LEGACY_PROJECT_MANIFEST_FILE),
    join(dir, PROJECT_MANIFEST_FILE),
  );
  if (movedState) repointGitignore(join(dir, GITIGNORE_FILE));
}

// True when `path` is absent, or a directory tree with no files in it: the
// empty history/ skeleton a session store makes counts as nothing there.
function holdsNoFiles(path: string): boolean {
  if (!existsSync(path)) return true;
  if (!statSync(path).isDirectory()) return false;
  return readdirSync(path).every((name) => holdsNoFiles(join(path, name)));
}

function moveIfOnlyLegacy(legacy: string, current: string): boolean {
  if (!existsSync(legacy) || !holdsNoFiles(current)) return false;
  try {
    rmSync(current, { recursive: true, force: true });
    renameSync(legacy, current);
    return true;
  } catch {
    // Another process got there first, or the directory is read-only. Either
    // way nothing was lost.
    return false;
  }
}

function repointGitignore(path: string): void {
  if (!existsSync(path)) return;
  const text = readFileSync(path, "utf-8");
  const next = text.replaceAll(
    `${LEGACY_PROJECT_STATE_DIR_NAME}/`,
    `${PROJECT_STATE_DIR_NAME}/`,
  );
  if (next !== text) writeFileSync(path, next);
}
