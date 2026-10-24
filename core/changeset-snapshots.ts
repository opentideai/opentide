// @layer core — changeset start snapshots. When a changeset begins, the project's
// code (registries, schema definitions) and its text files go to
// `.opentide/snapshots/<changesetId>.json`. Abandoning the changeset rewinds to it,
// and a fork cut while it is open starts from it. App rows are never in it: the
// schema rewinds by reversing the changeset's migrations, and rows stay put.
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { writeJsonAtomic } from "./atomic-json.ts";
import {
  CHANGESET_SNAPSHOT_MAX_FILE_BYTES,
  getKernelSettings,
} from "./config.ts";
import { saveKernelState } from "./persistence.ts";
import { getProjectPaths } from "./project-manager.ts";
import type { Kernel } from "./registries.ts";
import type { SnapshotData } from "./snapshots.ts";
import type { ChangesetStatus, Result } from "./types.ts";
import { errorMessage } from "./util.ts";

// Top-level project entries a snapshot never holds: the database, git, build
// output, dependencies, and everything the kernel writes for itself (registry
// state, manifest, caches, assets). Those either rewind another way or aren't
// the project's code.
const SNAPSHOT_SKIPPED_TOP_LEVEL = new Set([
  "data",
  ".git",
  ".opentide",
  ".genie",
  "node_modules",
  "dist",
  "assets",
  "branch-snapshots",
  "opentide.json",
  "registry-cache.json",
  "kernel-state.json",
]);
// Skipped wherever they turn up.
const SNAPSHOT_SKIPPED_ANYWHERE = new Set(["node_modules", ".git"]);
const SNAPSHOT_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const ENV_FILE = ".env";
const SECRET_FILE_MODE = 0o600;

const OPEN_STATUSES = new Set<ChangesetStatus>([
  "planning",
  "approved",
  "in_progress",
]);

export interface ChangesetSnapshot {
  version: 1;
  changesetId: string;
  createdAt: string;
  code: SnapshotData;
  // Project-relative paths with `/` separators.
  files: Array<{ path: string; content: string }>;
  // Files left out because they're binary or too big. A rewind neither restores
  // nor deletes them.
  skipped: string[];
}

export interface RewindReport {
  migrationsUndone: number;
  filesRestored: number;
  filesDeleted: number;
}

export type AbandonRewind =
  | ({ rewound: true } & RewindReport)
  | { rewound: false; reason: string; code?: string };

export interface ProjectFiles {
  files: Map<string, string>;
  skipped: string[];
}

function fail<T>(code: string, message: string): Result<T> {
  return { ok: false, error: { code, message } };
}

function snapshotPath(projectDir: string, changesetId: string): string | null {
  return SNAPSHOT_ID_PATTERN.test(changesetId)
    ? join(getProjectPaths(projectDir).snapshotsDir, `${changesetId}.json`)
    : null;
}

function readText(path: string): string | null {
  if (statSync(path).size > CHANGESET_SNAPSHOT_MAX_FILE_BYTES) return null;
  const bytes = readFileSync(path);
  if (bytes.includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function isSkipped(rel: string, name: string): boolean {
  return SNAPSHOT_SKIPPED_ANYWHERE.has(name) ||
    (!rel.includes("/") && SNAPSHOT_SKIPPED_TOP_LEVEL.has(name));
}

export function readProjectFiles(projectDir: string): ProjectFiles {
  const out: ProjectFiles = { files: new Map(), skipped: [] };
  const walk = (relDir: string) => {
    for (const name of readdirSync(join(projectDir, relDir)).sort()) {
      const rel = relDir ? `${relDir}/${name}` : name;
      if (isSkipped(rel, name)) continue;
      const abs = join(projectDir, rel);
      const stat = lstatSync(abs);
      if (stat.isDirectory()) walk(rel);
      if (!stat.isFile()) continue;
      const text = readText(abs);
      if (text === null) out.skipped.push(rel);
      else out.files.set(rel, text);
    }
  };
  walk("");
  return out;
}

export function readChangesetSnapshot(
  projectDir: string,
  changesetId: string,
): ChangesetSnapshot | null {
  const path = snapshotPath(projectDir, changesetId);
  if (!path || !existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as ChangesetSnapshot;
  } catch {
    return null;
  }
}

export function deleteChangesetSnapshot(
  projectDir: string,
  changesetId: string,
): void {
  const path = snapshotPath(projectDir, changesetId);
  if (path) rmSync(path, { force: true });
}

// Deletes the oldest snapshots until at most `keep` are left. Never deletes one
// named in `protect`, even if that leaves more than `keep`.
export function pruneChangesetSnapshots(
  projectDir: string,
  keep: number,
  protect: string[],
): string[] {
  const dir = getProjectPaths(projectDir).snapshotsDir;
  if (!existsSync(dir)) return [];
  const all = readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => ({
      id: name.slice(0, -".json".length),
      mtime: statSync(join(dir, name)).mtimeMs,
    }))
    .sort((a, b) => a.mtime - b.mtime);
  const excess = all.length - keep;
  const doomed = all.filter((s) => !protect.includes(s.id)).slice(
    0,
    Math.max(0, excess),
  );
  for (const s of doomed) deleteChangesetSnapshot(projectDir, s.id);
  return doomed.map((s) => s.id);
}

export async function takeChangesetSnapshot(
  kernel: Kernel,
  changesetId: string,
): Promise<Result<{ path: string }>> {
  const projectDir = kernel.projectDir;
  if (!projectDir) return fail("NO_PROJECT", "No project directory is loaded.");
  const keep = getKernelSettings().maxChangesetSnapshots;
  if (keep === 0) {
    return fail(
      "SNAPSHOTS_OFF",
      "Changeset snapshots are off (maxChangesetSnapshots is 0).",
    );
  }
  const path = snapshotPath(projectDir, changesetId);
  if (!path) return fail("INVALID_ID", `Bad changeset id "${changesetId}".`);
  try {
    const code = await kernel.snapshots.capture(
      kernel,
      `Start of changeset ${changesetId}`,
      { rows: false },
    );
    const { files, skipped } = readProjectFiles(projectDir);
    mkdirSync(dirname(path), { recursive: true });
    writeJsonAtomic(
      path,
      {
        version: 1,
        changesetId,
        createdAt: new Date().toISOString(),
        code,
        files: [...files].map(([p, content]) => ({ path: p, content })),
        skipped,
      } satisfies ChangesetSnapshot,
    );
    pruneChangesetSnapshots(projectDir, keep, [changesetId]);
    return { ok: true, data: { path } };
  } catch (err) {
    return fail("SNAPSHOT_FAILED", errorMessage(err));
  }
}

function removeEmptyParents(projectDir: string, rel: string): void {
  let dir = dirname(rel);
  while (dir !== "." && dir !== "") {
    const abs = join(projectDir, dir);
    if (readdirSync(abs).length > 0) return;
    rmdirSync(abs);
    dir = dirname(dir);
  }
}

function restoreProjectFiles(
  projectDir: string,
  snapshot: ChangesetSnapshot,
): Pick<RewindReport, "filesRestored" | "filesDeleted"> {
  const current = readProjectFiles(projectDir);
  const known = new Set([
    ...snapshot.files.map((f) => f.path),
    ...snapshot.skipped,
  ]);
  let filesDeleted = 0;
  for (const rel of [...current.files.keys(), ...current.skipped]) {
    if (known.has(rel)) continue;
    rmSync(join(projectDir, rel), { force: true });
    removeEmptyParents(projectDir, rel);
    filesDeleted++;
  }
  let filesRestored = 0;
  for (const file of snapshot.files) {
    if (current.files.get(file.path) === file.content) continue;
    const abs = join(projectDir, file.path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(
      abs,
      file.content,
      file.path === ENV_FILE ? { mode: SECRET_FILE_MODE } : {},
    );
    filesRestored++;
  }
  return { filesRestored, filesDeleted };
}

// Puts the project back where it stood when the changeset began: schema first
// (reversing the changeset's migrations, all or nothing), then the registries,
// then the files. Rows written during the changeset stay, except in tables or
// columns the changeset itself created.
export async function rewindToChangesetStart(
  kernel: Kernel,
  changesetId: string,
  rebuild: () => void,
): Promise<Result<RewindReport>> {
  const projectDir = kernel.projectDir;
  if (!projectDir) return fail("NO_PROJECT", "No project directory is loaded.");
  const snapshot = readChangesetSnapshot(projectDir, changesetId);
  if (!snapshot) {
    return fail(
      "NO_CHANGESET_SNAPSHOT",
      `No start snapshot for changeset "${changesetId}".`,
    );
  }
  const schema = await kernel.db.undoChangesetMigrations(changesetId);
  if (!schema.ok) return schema;
  const migrationsUndone = schema.data.undone.length;
  const code = await kernel.snapshots.restoreData(
    snapshot.code,
    kernel,
    rebuild,
    { tables: "keep" },
  );
  if (!code.ok) {
    return fail(
      "CHANGESET_REWIND_FAILED",
      `Undid ${migrationsUndone} migrations, then the code restore failed: ` +
        code.error,
    );
  }
  const files = restoreProjectFiles(projectDir, snapshot);
  kernel.env.load(projectDir);
  saveKernelState(kernel, getProjectPaths(projectDir).stateDir);
  return { ok: true, data: { migrationsUndone, ...files } };
}

// What abandon does before it marks a changeset abandoned: rewind an open
// changeset to its start snapshot, and drop the snapshot once it's used. Never
// fails the abandon; it says what happened instead.
export async function rewindForAbandon(
  kernel: Kernel,
  changesetId: string,
  rebuild: () => void,
): Promise<AbandonRewind> {
  const cs = await kernel.changesets.get(changesetId);
  if (!cs || !OPEN_STATUSES.has(cs.status)) {
    return { rewound: false, reason: "The changeset isn't open." };
  }
  const projectDir = kernel.projectDir;
  if (!projectDir || !readChangesetSnapshot(projectDir, changesetId)) {
    return {
      rewound: false,
      code: "NO_CHANGESET_SNAPSHOT",
      reason: "No start snapshot, so its work stays in place.",
    };
  }
  const rewound = await rewindToChangesetStart(kernel, changesetId, rebuild);
  if (!rewound.ok) {
    return {
      rewound: false,
      code: rewound.error.code,
      reason: rewound.error.message,
    };
  }
  deleteChangesetSnapshot(projectDir, changesetId);
  return { rewound: true, ...rewound.data };
}
