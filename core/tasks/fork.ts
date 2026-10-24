// @layer core — creating, running and discarding task forks. A fork is a copy of
// the project directory (files, state, DB) that runs as its own project under its
// own `opentide serve`, so two agents can work at once and merge back later
// (docs/opentide-task-forks-plan.md). This runs in main's serve, the only process
// that can snapshot main's database.
import { readEnv } from "../process-env.ts";
import { copyFileSync, cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import {
  readChangesetSnapshot,
  rewindToChangesetStart,
} from "../changeset-snapshots.ts";
import {
  MAX_OPEN_TASKS,
  OPENTIDE_DB_URL_ENV,
  SERVE_LOG_FILE,
  TASK_STOP_TIMEOUT_MS,
} from "../config.ts";
import {
  getProjectPaths,
  markProjectAsFork,
  PROJECT_MODE_SOURCE_BACKED,
  readProjectFork,
  readProjectMode,
} from "../project-manager.ts";
import {
  isProjectLockHeld,
  PROJECT_LOCK_FILE,
  readLockHolder,
} from "../project-lock.ts";
import { Database } from "../db.ts";
import { loadKernelState } from "../persistence.ts";
import { Kernel } from "../registries.ts";
import { SecretsStore } from "../secrets.ts";
import { type LocateOptions, locateServe } from "../serve-process.ts";
import { SERVER_TOKEN_FILE } from "../server-token.ts";
import { flushKernelProjectState } from "../tools/dispatch.ts";
import type { Result } from "../types.ts";
import { errorMessage } from "../util.ts";
import { freezeForkBaseProject } from "./diff-inputs.ts";
import {
  isValidClaim,
  normalizeClaims,
  openTasks,
  readTasks,
  taskOverlaps,
  type TaskRecord,
  type TaskWithOverlaps,
  withOverlaps,
  writeTasks,
} from "./task-store.ts";
import type {
  CreatedTask,
  CreatedTaskWithServe,
  TaskServe,
} from "../../shared/tasks.ts";

export type {
  CreatedTask,
  CreatedTaskWithServe,
  TaskServe,
} from "../../shared/tasks.ts";

const STOP_POLL_MS = 100;

// Project-relative paths a fork never inherits: the database (copied separately,
// consistently), main's git, main's live-process files, caches, and main's own
// task bookkeeping.
const FORK_EXCLUDED_PATHS = [
  "data",
  ".git",
  `.opentide/${PROJECT_LOCK_FILE}`,
  `.opentide/${SERVER_TOKEN_FILE}`,
  `.opentide/${SERVE_LOG_FILE}`,
  ".opentide/caches",
  ".opentide/backups",
  ".opentide/tasks.json",
  ".opentide/fork-base",
  ".opentide/snapshots",
];

// A refusal found while building, carried out of the build as its own code.
class ForkRefusal extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly suggestion?: string,
  ) {
    super(message);
  }
}

export interface CreateTaskInput {
  title: string;
  claims?: string[];
}

export function taskError<T>(
  code: string,
  message: string,
  suggestion?: string,
): Result<T> {
  return {
    ok: false,
    error: { code, message, ...(suggestion ? { suggestion } : {}) },
  };
}

export function mainDir(kernel: Kernel): Result<string> {
  return kernel.projectDir
    ? { ok: true, data: kernel.projectDir }
    : taskError("NO_PROJECT", "No project directory is loaded.");
}

function checkClaims(claims: string[]): Result<string[]> {
  const bad = claims.filter((c) => !isValidClaim(c.trim()));
  if (bad.length > 0) {
    return taskError(
      "INVALID_CLAIM",
      `Claims must be category:key scopes. Not valid: ${bad.join(", ")}`,
      "Use the changeScope spelling, e.g. handler:calcTotal or route:GET /api/a.",
    );
  }
  return { ok: true, data: normalizeClaims(claims) };
}

// A fork cut while a changeset is open starts from that changeset's start
// snapshot, not from its half-done work. Without the snapshot there's no clean
// point to fork from.
function refuseWithoutCleanPoint(
  projectDir: string,
  openChangesetId: string | null,
): Result<void> {
  if (openChangesetId && !readChangesetSnapshot(projectDir, openChangesetId)) {
    return taskError(
      "TASK_NO_CLEAN_POINT",
      `Changeset "${openChangesetId}" is open and has no start snapshot to fork from.`,
      "Complete or abandon it, then fork.",
    );
  }
  return { ok: true, data: undefined };
}

function refuseFork(projectDir: string, tasks: TaskRecord[]): Result<void> {
  const parent = readProjectFork(projectDir);
  if (parent) {
    return taskError(
      "TASK_IN_FORK",
      "This project is itself a task fork, so it can't start tasks.",
      `Start the task from main: ${parent.parentPath}`,
    );
  }
  if (readProjectMode(projectDir) === PROJECT_MODE_SOURCE_BACKED) {
    return taskError(
      "TASK_SOURCE_BACKED",
      "A source-backed project's code lives outside the project directory, so it can't be forked.",
    );
  }
  if (readEnv(OPENTIDE_DB_URL_ENV)) {
    return taskError(
      "TASK_EXTERNAL_DB",
      `${OPENTIDE_DB_URL_ENV} is set, so every fork would share one database.`,
      `Unset ${OPENTIDE_DB_URL_ENV} to use forks.`,
    );
  }
  if (openTasks(tasks).length >= MAX_OPEN_TASKS) {
    return taskError(
      "TASK_LIMIT",
      `This project already has ${MAX_OPEN_TASKS} open tasks.`,
      "Merge or discard one first.",
    );
  }
  return { ok: true, data: undefined };
}

function newTaskId(): string {
  return `task_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

function copyProjectFiles(projectDir: string, forkDir: string): void {
  const root = resolve(projectDir);
  cpSync(root, forkDir, {
    recursive: true,
    errorOnExist: true,
    force: false,
    filter: (src) =>
      !FORK_EXCLUDED_PATHS.includes(relative(root, src).replaceAll("\\", "/")),
  });
}

async function restoreDatabase(snapshot: Blob, dataDir: string): Promise<void> {
  const { PGlite } = await import("@electric-sql/pglite");
  const restored = await PGlite.create({ loadDataDir: snapshot, dataDir });
  await restored.close();
}

// Opens the fork without servers, rewinds it to the open changeset's start, and
// abandons that changeset in the fork's own history, where it never happened.
async function rewindFork(
  main: Kernel,
  projectDir: string,
  forkDir: string,
  changesetId: string,
): Promise<void> {
  const paths = getProjectPaths(forkDir);
  const snapshotFile = join(paths.snapshotsDir, `${changesetId}.json`);
  mkdirSync(paths.snapshotsDir, { recursive: true });
  copyFileSync(
    join(getProjectPaths(projectDir).snapshotsDir, `${changesetId}.json`),
    snapshotFile,
  );
  const db = await Database.create({
    driver: "pglite",
    dataDir: paths.dataDir,
    schemaDir: paths.schemaDir,
  });
  try {
    const fork = new Kernel(db, {
      historyDir: paths.historyDir,
      composition: main.composition,
    });
    fork.projectDir = forkDir;
    fork.env.load(forkDir);
    const noRebuild = () => {};
    await loadKernelState(fork, paths.stateDir, noRebuild);
    const rewound = await rewindToChangesetStart(fork, changesetId, noRebuild);
    if (!rewound.ok) {
      const { code, message, suggestion } = rewound.error;
      throw new ForkRefusal(code, message, suggestion);
    }
    if ((await fork.activeChangesetId()) === changesetId) {
      await fork.changesets.abandon(changesetId);
    }
    await db.checkpoint();
  } finally {
    await db.close();
    rmSync(snapshotFile, { force: true });
  }
}

// Fork = main's files minus the excluded paths, a consistent copy of main's
// database, main's secrets under the fork's own path key, and, when a changeset
// is open, all of that rewound to the changeset's start. The fork's state is then
// frozen as the merge base.
async function buildFork(
  kernel: Kernel,
  projectDir: string,
  forkDir: string,
  task: TaskRecord,
): Promise<void> {
  // The snapshot is the only await. Everything after it is synchronous, so no
  // other write can land between the DB copy and the state copy.
  const snapshot = await kernel.db.snapshot();
  if (!snapshot) {
    throw new Error("This database can't produce a snapshot to fork from.");
  }
  flushKernelProjectState(kernel);
  const fork = getProjectPaths(forkDir);
  mkdirSync(resolve(forkDir, ".."), { recursive: true });
  copyProjectFiles(projectDir, forkDir);
  markProjectAsFork(forkDir, {
    parentPath: resolve(projectDir),
    taskId: task.id,
    title: task.title,
    createdAt: task.createdAt,
  });
  SecretsStore.copyProjectSecrets(resolve(projectDir), forkDir);
  await restoreDatabase(snapshot, fork.dataDir);
  if (task.baseChangesetId) {
    await rewindFork(kernel, projectDir, forkDir, task.baseChangesetId);
  }
  cpSync(fork.stateDir, join(fork.forkBaseDir, "state"), { recursive: true });
  freezeForkBaseProject(forkDir);
}

function removeFork(forkDir: string): void {
  rmSync(forkDir, { recursive: true, force: true });
  SecretsStore.deleteProjectSecrets(forkDir);
}

// The serve that holds the fork right now, if any. The recorded pid and port go
// stale when the serve stops or the machine restarts; the lock doesn't.
export function liveServe(
  forkDir: string,
): { pid: number; port: number } | null {
  if (!existsSync(forkDir) || !isProjectLockHeld(forkDir)) return null;
  const holder = readLockHolder(forkDir);
  return holder?.role === "serve" && holder.controlPort !== undefined
    ? { pid: holder.pid, port: holder.controlPort }
    : null;
}

function withLiveServe(task: TaskRecord): TaskRecord {
  const { pid: _pid, port: _port, ...rest } = task;
  const live = task.status === "open" ? liveServe(task.path) : null;
  return live ? { ...rest, ...live } : rest;
}

export function listTasks(kernel: Kernel): Result<TaskWithOverlaps[]> {
  const dir = mainDir(kernel);
  if (!dir.ok) return dir;
  const tasks = readTasks(getProjectPaths(dir.data).tasksFile);
  return { ok: true, data: withOverlaps(tasks.map(withLiveServe)) };
}

export async function createTaskFork(
  kernel: Kernel,
  input: CreateTaskInput,
): Promise<Result<CreatedTask>> {
  const dir = mainDir(kernel);
  if (!dir.ok) return dir;
  const title = input.title.trim();
  if (title === "") return taskError("INVALID_TITLE", "A task needs a title.");
  const claims = checkClaims(input.claims ?? []);
  if (!claims.ok) return claims;

  const paths = getProjectPaths(dir.data);
  const tasks = readTasks(paths.tasksFile);
  const refused = refuseFork(dir.data, tasks);
  if (!refused.ok) return refused;
  const openChangesetId = await kernel.activeChangesetId();
  const unclean = refuseWithoutCleanPoint(dir.data, openChangesetId);
  if (!unclean.ok) return unclean;

  const id = newTaskId();
  const forkDir = join(paths.taskForksDir, id);
  const task: TaskRecord = {
    id,
    title,
    path: forkDir,
    status: "open",
    createdAt: new Date().toISOString(),
    claims: claims.data,
    ...(openChangesetId ? { baseChangesetId: openChangesetId } : {}),
  };
  try {
    await buildFork(kernel, dir.data, forkDir, task);
  } catch (err) {
    removeFork(forkDir);
    return err instanceof ForkRefusal
      ? taskError(err.code, err.message, err.suggestion)
      : taskError("TASK_FORK_FAILED", errorMessage(err));
  }
  // Re-read: another create may have landed during the DB copy.
  const latest = readTasks(paths.tasksFile);
  writeTasks(paths.tasksFile, [...latest, task]);
  return { ok: true, data: { task, overlaps: taskOverlaps(task, latest) } };
}

export function findTask(
  tasks: TaskRecord[],
  id: string,
): Result<TaskRecord> {
  const task = tasks.find((t) => t.id === id);
  return task
    ? { ok: true, data: task }
    : taskError("TASK_NOT_FOUND", `No task "${id}".`);
}

export function saveTask(tasksFile: string, task: TaskRecord): void {
  writeTasks(
    tasksFile,
    readTasks(tasksFile).map((t) => (t.id === task.id ? task : t)),
  );
}

export function updateTaskClaims(
  kernel: Kernel,
  id: string,
  claims: string[],
): Result<CreatedTask> {
  const dir = mainDir(kernel);
  if (!dir.ok) return dir;
  const checked = checkClaims(claims);
  if (!checked.ok) return checked;
  const tasksFile = getProjectPaths(dir.data).tasksFile;
  const tasks = readTasks(tasksFile);
  const found = findTask(tasks, id);
  if (!found.ok) return found;
  if (found.data.status !== "open") {
    return taskError("TASK_NOT_OPEN", `Task "${id}" is ${found.data.status}.`);
  }
  const task = { ...found.data, claims: checked.data };
  saveTask(tasksFile, task);
  return { ok: true, data: { task, overlaps: taskOverlaps(task, tasks) } };
}

// Starts the fork's `opentide serve`, detached, or attaches to the one already
// running, and records its pid and port on the task.
export async function startTaskServe(
  kernel: Kernel,
  id: string,
  opts: LocateOptions = {},
): Promise<Result<{ task: TaskRecord; serve: TaskServe }>> {
  const dir = mainDir(kernel);
  if (!dir.ok) return dir;
  const tasksFile = getProjectPaths(dir.data).tasksFile;
  const found = findTask(readTasks(tasksFile), id);
  if (!found.ok) return found;
  if (found.data.status !== "open") {
    return taskError("TASK_NOT_OPEN", `Task "${id}" is ${found.data.status}.`);
  }
  const located = await locateServe(found.data.path, opts);
  if (!located.ok) return located;
  const { pid, controlPort, url, started } = located.data;
  const task = { ...found.data, pid, port: controlPort };
  saveTask(tasksFile, task);
  return {
    ok: true,
    data: {
      task,
      serve: {
        pid,
        port: controlPort,
        mcpUrl: url,
        logPath: started?.logPath ?? null,
        started: started !== null,
      },
    },
  };
}

// Forks the project and starts the fork's serve. A serve that won't start
// leaves the fork in place and says why in `serveError`.
export async function startTask(
  kernel: Kernel,
  input: CreateTaskInput,
  opts: { serve?: boolean } = {},
): Promise<Result<CreatedTaskWithServe>> {
  const created = await createTaskFork(kernel, input);
  if (!created.ok || opts.serve === false) return created;
  const started = await startTaskServe(kernel, created.data.task.id);
  return {
    ok: true,
    data: started.ok
      ? { ...created.data, ...started.data }
      : { ...created.data, serveError: started.error },
  };
}

function signal(pid: number): void {
  try {
    Deno.kill(pid, "SIGTERM");
  } catch {
    // Already gone; the lock check below is what decides.
  }
}

async function waitForLockRelease(forkDir: string): Promise<boolean> {
  const deadline = Date.now() + TASK_STOP_TIMEOUT_MS;
  while (isProjectLockHeld(forkDir)) {
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, STOP_POLL_MS));
  }
  return true;
}

// Stops the serve we started for the fork and waits for it to let go; false
// when the fork is still held. Only a fork held by our serve is worth stopping.
// Anything else holding the lock was opened by hand and won't let go because we
// asked, and a recorded pid that no longer holds the fork may be some other
// process now. Unloading flushes the fork's state.
export async function releaseFork(task: TaskRecord): Promise<boolean> {
  const pid = task.pid;
  const ours = pid !== undefined && isProjectLockHeld(task.path) &&
    readLockHolder(task.path)?.pid === pid;
  return ours
    ? (signal(pid), await waitForLockRelease(task.path))
    : !isProjectLockHeld(task.path);
}

// Stops the fork's serve (if any), deletes the fork and its secrets, and marks the
// task discarded. A merged task keeps its status; only its directory goes.
// Idempotent: discarding twice is a no-op the second time.
export async function discardTaskFork(
  kernel: Kernel,
  id: string,
): Promise<Result<TaskRecord>> {
  const dir = mainDir(kernel);
  if (!dir.ok) return dir;
  const tasksFile = getProjectPaths(dir.data).tasksFile;
  const found = findTask(readTasks(tasksFile), id);
  if (!found.ok) return found;
  const task = found.data;
  if (
    (task.status === "discarded" || task.discardedAt) && !existsSync(task.path)
  ) {
    return { ok: true, data: task };
  }
  if (!(await releaseFork(task))) {
    return taskError(
      "TASK_BUSY",
      `Task "${id}" is still open in another process.`,
      "Close whatever has the fork open, then discard again.",
    );
  }
  removeFork(task.path);
  const { pid: _pid, port: _port, ...rest } = task;
  const discarded: TaskRecord = {
    ...rest,
    status: task.status === "merged" ? "merged" : "discarded",
    discardedAt: new Date().toISOString(),
  };
  saveTask(tasksFile, discarded);
  return { ok: true, data: discarded };
}
