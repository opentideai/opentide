// @layer core — the diff preview for one task: what merging it would apply, what
// conflicts, and what doesn't merge. Runs in main's serve. Both sides are read
// from disk, so main flushes first, and a fork with its serve up is asked to
// flush over REST: an MCP session in the fork never flushes on its own.
import { DEV_SERVER_HOST } from "../config.ts";
import { getProjectPaths } from "../project-manager.ts";
import type { Kernel } from "../registries.ts";
import { flushKernelProjectState } from "../tools/dispatch.ts";
import type { Result } from "../types.ts";
import { errorMessage } from "../util.ts";
import { readBaseSide, readLiveSide } from "./diff-inputs.ts";
import { findTask, liveServe, mainDir, taskError } from "./fork.ts";
import type { TaskDiff } from "../../shared/tasks.ts";
import { diffBlocksMerge, diffTaskState } from "./state-diff.ts";
import { readTasks } from "./task-store.ts";

export type { TaskDiff } from "../../shared/tasks.ts";

export const STATE_FLUSH_PATH = "/api/state/flush";

async function flushForkServe(forkDir: string): Promise<Result<void>> {
  const live = liveServe(forkDir);
  if (!live) return { ok: true, data: undefined };
  try {
    const res = await fetch(
      `http://${DEV_SERVER_HOST}:${live.port}${STATE_FLUSH_PATH}`,
      { method: "POST" },
    );
    await res.body?.cancel();
    if (res.ok) return { ok: true, data: undefined };
    return taskError(
      "TASK_FORK_UNREACHABLE",
      `The fork's serve answered ${res.status} to a state flush.`,
    );
  } catch (err) {
    return taskError(
      "TASK_FORK_UNREACHABLE",
      `The fork's serve (pid ${live.pid}) didn't take a state flush: ${
        errorMessage(err)
      }`,
      "Stop the fork's serve and try again; a stopped fork is read from disk.",
    );
  }
}

export async function diffTask(
  kernel: Kernel,
  id: string,
): Promise<Result<TaskDiff>> {
  const dir = mainDir(kernel);
  if (!dir.ok) return dir;
  const found = findTask(readTasks(getProjectPaths(dir.data).tasksFile), id);
  if (!found.ok) return found;
  const task = found.data;
  if (task.status !== "open") {
    return taskError("TASK_NOT_OPEN", `Task "${id}" is ${task.status}.`);
  }
  const flushed = await flushForkServe(task.path);
  if (!flushed.ok) return flushed;
  flushKernelProjectState(kernel);
  const base = readBaseSide(task.path);
  if (!base.ok) return base;
  const fork = readLiveSide(task.path);
  if (!fork.ok) return fork;
  const main = readLiveSide(dir.data);
  if (!main.ok) return main;
  const diff = diffTaskState(base.data, fork.data, main.data, {
    runtimeId: kernel.runtimeId,
    language: kernel.runtime.defaultLanguage,
  });
  return { ok: true, data: { task, ...diff, blocked: diffBlocksMerge(diff) } };
}
