// @layer core — interval-guarded database backups and checkpoints, shared by every
// face that drives the kernel.
//
// A backup used to happen in exactly two places: a clean unload (project-loader) and
// the IDE's per-turn hook (control-server). Both are IDE- or exit-shaped, so a headless
// MCP session — which is how an external agent drives a project, with no chat turns and
// no guarantee of a clean exit — could work for hours against a PGlite data dir whose
// last backup was taken when the process started.
//
// The cadence lives here rather than in either caller because two faces over one project
// would otherwise keep two clocks and write two backups into the same directory, each
// evicting the other's under maxDbBackups. One map, one interval, whoever gets there
// first.
import { mkdirSync } from "node:fs";
import type { Kernel } from "./registries.ts";
import { type BackupMetadata, createBackup, saveBackup } from "./backup.ts";
import {
  DB_BACKUP_INTERVAL_MS,
  DB_CHECKPOINT_INTERVAL_MS,
  getKernelSettings,
} from "./config.ts";
import { getProjectPaths } from "./project-manager.ts";

// Keyed by project directory — `entry.path`, which is also what loadProject assigns to
// kernel.projectDir, so the IDE and the tool-dispatch path key the same map entry.
// Two projects loaded in one process keep separate clocks.
//
// Deliberately NOT seeded on load: the first mutating call of a session takes a backup,
// which is the copy of the project as it was before this session touched it — the one
// you want when a session goes wrong.
const lastBackupAt = new Map<string, number>();

// Projects with a backup in flight. createBackup reads every table, so a burst of
// mutating calls could otherwise start several at once; the interval guard alone does
// not cover that, because it is only advanced once the decision is made.
const inFlight = new Set<string>();

// Record that a backup was just written by some other path (unload, an explicit
// request), so the next interval is measured from it and the faces do not pile up.
export function noteBackupTaken(
  projectDir: string,
  at: number = Date.now(),
): void {
  lastBackupAt.set(projectDir, at);
}

// Forget a project's clock. Called on unload so a reload of the same directory in a
// long-lived process starts fresh rather than inheriting a stale timestamp.
export function forgetBackupClock(projectDir: string): void {
  lastBackupAt.delete(projectDir);
  inFlight.delete(projectDir);
  lastCheckpointAt.delete(projectDir);
  checkpointInFlight.delete(projectDir);
}

// The checkpoint clock, kept separate from the backup clock because the two protect
// different things. A backup protects against a bad write — it is the copy you restore
// when the session went wrong. A checkpoint protects against the process dying: on
// PGlite it is the only thing that puts writes onto the files at all, so the gap since
// the last one is exactly what an unclean kill destroys. Seeded on first call rather
// than on load, like the backup clock, so a session that never mutates never pays.
const lastCheckpointAt = new Map<string, number>();
const checkpointInFlight = new Set<string>();

function backupIsDue(projectDir: string, now: number): boolean {
  const last = lastBackupAt.get(projectDir);
  return last === undefined || now - last >= DB_BACKUP_INTERVAL_MS;
}

// Write a periodic backup if one is due. Returns the metadata when a backup was
// written, null when it was not due, was already running, or is disabled by
// maxDbBackups: 0.
//
// Never throws. A backup is a safety net, not a precondition — a project whose backup
// fails must still be workable, and the caller (a tool dispatch, a finished chat turn)
// has nothing useful to do with the failure anyway.
export async function maybePeriodicBackup(
  kernel: Kernel,
  projectDir: string,
): Promise<BackupMetadata | null> {
  const settings = getKernelSettings();
  if (settings.maxDbBackups <= 0) return null;

  const now = Date.now();
  if (!backupIsDue(projectDir, now) || inFlight.has(projectDir)) return null;

  // Claim the slot BEFORE the await: createBackup is asynchronous and the next
  // mutating call can arrive while it runs.
  lastBackupAt.set(projectDir, now);
  inFlight.add(projectDir);
  try {
    const paths = getProjectPaths(projectDir);
    mkdirSync(paths.backups, { recursive: true });
    const backup = await createBackup(kernel, kernel.db, "periodic");
    saveBackup(backup, paths.backups, settings.maxDbBackups);
    return backup.metadata;
  } catch {
    // The clock stays advanced on failure: a database that cannot be dumped will not
    // dump on the next tool call either, and retrying every call would turn one broken
    // backup into a stalled session.
    return null;
  } finally {
    inFlight.delete(projectDir);
  }
}

// Checkpoint the database if one is due. Returns true when a checkpoint was written,
// false when it was not due, was already running, or the backend does not need one.
//
// Never throws, for the same reason maybePeriodicBackup does not: the callers are tool
// dispatch and finished chat turns, which have nothing to do with the failure and must
// keep working against a database that cannot flush.
export async function maybePeriodicCheckpoint(
  kernel: Kernel,
  projectDir: string,
  now: number = Date.now(),
): Promise<boolean> {
  const last = lastCheckpointAt.get(projectDir);
  const due = last === undefined || now - last >= DB_CHECKPOINT_INTERVAL_MS;
  if (!due || checkpointInFlight.has(projectDir)) return false;

  // Claim the slot BEFORE the await, as with backups: a checkpoint is not instant and
  // the next mutating call can arrive while it runs.
  lastCheckpointAt.set(projectDir, now);
  checkpointInFlight.add(projectDir);
  try {
    await kernel.db.checkpoint();
    return true;
  } finally {
    checkpointInFlight.delete(projectDir);
  }
}
