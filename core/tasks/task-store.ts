// @layer core — task records for one project's forks, kept in main's
// `.opentide/tasks.json`. Only main's serve writes the file, so there is one writer.
// Claims are advisory: they report overlap, they never refuse anything.
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { readJsonQuarantine, writeJsonAtomic } from "../atomic-json.ts";

import type { TaskOverlap, TaskRecord, TaskWithOverlaps } from "../../shared/tasks.ts";

export type {
  TaskOverlap,
  TaskRecord,
  TaskStatus,
  TaskWithOverlaps,
} from "../../shared/tasks.ts";

interface TasksFile {
  version: 1;
  tasks: TaskRecord[];
}

function emptyTasksFile(): TasksFile {
  return { version: 1, tasks: [] };
}

function validTasksFile(raw: unknown): TasksFile | null {
  if (typeof raw !== "object" || raw === null) return null;
  const tasks = (raw as { tasks?: unknown }).tasks;
  return Array.isArray(tasks)
    ? { version: 1, tasks: tasks as TaskRecord[] }
    : null;
}

export function readTasks(tasksFile: string): TaskRecord[] {
  return readJsonQuarantine(tasksFile, emptyTasksFile, validTasksFile).tasks;
}

export function writeTasks(tasksFile: string, tasks: TaskRecord[]): void {
  mkdirSync(dirname(tasksFile), { recursive: true });
  writeJsonAtomic(tasksFile, { version: 1, tasks } satisfies TasksFile);
}

export function openTasks(tasks: TaskRecord[]): TaskRecord[] {
  return tasks.filter((t) => t.status === "open");
}

// A claim is the changeScope spelling: a category, a colon, a non-empty key.
export function isValidClaim(claim: string): boolean {
  const colon = claim.indexOf(":");
  return colon > 0 && colon < claim.length - 1;
}

export function normalizeClaims(claims: string[]): string[] {
  return [...new Set(claims.map((c) => c.trim()))].sort();
}

// Every other open task that claims something `task` claims.
export function taskOverlaps(
  task: Pick<TaskRecord, "id" | "claims">,
  tasks: TaskRecord[],
): TaskOverlap[] {
  const mine = new Set(task.claims);
  return openTasks(tasks)
    .filter((other) => other.id !== task.id)
    .map((other) => ({
      taskId: other.id,
      title: other.title,
      scopes: other.claims.filter((c) => mine.has(c)),
    }))
    .filter((o) => o.scopes.length > 0);
}

export function withOverlaps(tasks: TaskRecord[]): TaskWithOverlaps[] {
  return tasks.map((task) => ({
    ...task,
    overlaps: task.status === "open" ? taskOverlaps(task, tasks) : [],
  }));
}
