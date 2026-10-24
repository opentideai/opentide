// @layer cli — `opentide task`: fork a project into a task, list tasks, merge or
// discard one. Every command talks to main's serve over REST, since that process holds
// main's database; if nothing is serving the project, one is started, the same
// way the MCP bridge does it. Core-only imports; cli.ts adds the client config.
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { DEV_SERVER_HOST } from "../core/config.ts";
import { locateServe } from "../core/serve-process.ts";
import type { TaskServe } from "../core/tasks/fork.ts";
import type { TaskMerge } from "../core/tasks/task-merge.ts";
import type {
  TaskOverlap,
  TaskRecord,
  TaskWithOverlaps,
} from "../core/tasks/task-store.ts";
import type { Result } from "../core/types.ts";
import { errorMessage } from "../core/util.ts";

export const DEFAULT_TASK_CLIENT = "claude-code";

export type TaskCommand =
  | {
    action: "start";
    projectPath: string;
    title: string;
    claims: string[];
    client: string;
  }
  | { action: "list"; projectPath: string }
  | { action: "merge" | "discard"; projectPath: string; id: string };

export type ParsedTaskCommand =
  | { ok: true; command: TaskCommand }
  | { ok: false; message: string };

export interface StartedTask {
  task: TaskRecord;
  overlaps: TaskOverlap[];
  serve?: TaskServe;
  serveError?: { code: string; message: string; suggestion?: string };
}

export interface MainServe {
  base: string;
  // Set when this command had to start main's serve.
  started: { pid: number; logPath: string | null } | null;
}

export function taskUsage(): string {
  return `USAGE:
  opentide task start   --project <path> --title "<title>" [--claim <scope>]... [--client <c>]
  opentide task list    --project <path>
  opentide task merge   --project <path> <task-id>
  opentide task discard --project <path> <task-id>

A claim is a category:key scope, e.g. handler:calcTotal or "route:GET /api/a".
--client picks the connect config printed for the fork: claude-code (default),
codex or cursor.`;
}

function usage(message: string): ParsedTaskCommand {
  return { ok: false, message: `error: ${message}` };
}

export function parseTaskCommand(rest: string[]): ParsedTaskCommand {
  const [action, ...argv] = rest;
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        project: { type: "string", short: "p" },
        title: { type: "string" },
        claim: { type: "string", multiple: true },
        client: { type: "string" },
      },
      allowPositionals: true,
    });
  } catch (err) {
    return usage(errorMessage(err));
  }
  const { values, positionals } = parsed;
  if (!values.project) return usage("`task` requires --project <path>.");
  const projectPath = resolve(values.project);
  switch (action) {
    case "start":
      if (!values.title) return usage("`task start` requires --title.");
      return {
        ok: true,
        command: {
          action,
          projectPath,
          title: values.title,
          claims: values.claim ?? [],
          client: values.client ?? DEFAULT_TASK_CLIENT,
        },
      };
    case "list":
      return { ok: true, command: { action, projectPath } };
    case "merge":
    case "discard": {
      const [id, ...extra] = positionals;
      if (!id || extra.length > 0) {
        return usage(`\`task ${action}\` takes exactly one <task-id>.`);
      }
      return { ok: true, command: { action, projectPath, id } };
    }
    default:
      return usage(
        action ? `unknown task command "${action}".` : "no task command given.",
      );
  }
}

// Main's serve: the one holding the project, or a new one started for it.
export async function locateMainServe(
  projectPath: string,
): Promise<Result<MainServe>> {
  const located = await locateServe(projectPath);
  if (!located.ok) return located;
  const { controlPort, pid, started } = located.data;
  return {
    ok: true,
    data: {
      base: `http://${DEV_SERVER_HOST}:${controlPort}`,
      started: started ? { pid, logPath: started.logPath } : null,
    },
  };
}

function requestFor(command: TaskCommand): { path: string; init: RequestInit } {
  switch (command.action) {
    case "start":
      return {
        path: "/api/tasks",
        init: {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            title: command.title,
            claims: command.claims,
          }),
        },
      };
    case "list":
      return { path: "/api/tasks", init: { method: "GET" } };
    case "merge":
      return {
        path: `/api/tasks/${encodeURIComponent(command.id)}/merge`,
        init: { method: "POST" },
      };
    case "discard":
      return {
        path: `/api/tasks/${encodeURIComponent(command.id)}`,
        init: { method: "DELETE" },
      };
  }
}

interface ApiError {
  error?: string;
  code?: string;
  suggestion?: string;
}

export async function callTasksApi(
  base: string,
  command: TaskCommand,
): Promise<Result<unknown>> {
  const { path, init } = requestFor(command);
  try {
    const res = await fetch(`${base}${path}`, init);
    const body = await res.json() as unknown;
    if (res.ok) return { ok: true, data: body };
    const err = body as ApiError;
    return {
      ok: false,
      error: {
        code: err.code ?? `HTTP_${res.status}`,
        message: err.error ?? `${init.method} ${path} returned ${res.status}.`,
        ...(err.suggestion ? { suggestion: err.suggestion } : {}),
      },
    };
  } catch (err) {
    return {
      ok: false,
      error: { code: "SERVE_UNREACHABLE", message: errorMessage(err) },
    };
  }
}

function overlapLines(overlaps: TaskOverlap[]): string[] {
  return overlaps.map((o) =>
    `Overlaps ${o.taskId} ("${o.title}") on ${o.scopes.join(", ")}`
  );
}

export function renderStarted(started: StartedTask): string[] {
  const { task, serve, serveError } = started;
  const lines = [
    ...overlapLines(started.overlaps),
    `Task ${task.id}: ${task.title}`,
    `Fork: ${task.path}`,
  ];
  if (task.baseChangesetId) {
    lines.push(`Base: start of open changeset ${task.baseChangesetId}`);
  }
  if (serve) {
    lines.push(`Serve: pid ${serve.pid}, port ${serve.port} (${serve.mcpUrl})`);
    if (serve.logPath) lines.push(`Log: ${serve.logPath}`);
  }
  if (serveError) {
    lines.push(`Serve didn't start: ${serveError.message}`);
    if (serveError.suggestion) lines.push(serveError.suggestion);
  }
  return lines;
}

export function renderTaskList(tasks: TaskWithOverlaps[]): string[] {
  if (tasks.length === 0) return ["No tasks."];
  return tasks.flatMap((t) => [
    [
      t.id,
      t.status,
      t.port !== undefined ? `port ${t.port}` : "not running",
      t.title,
    ].join("  "),
    `  ${t.path}`,
    ...(t.claims.length > 0 ? [`  claims: ${t.claims.join(", ")}`] : []),
    ...overlapLines(t.overlaps).map((line) => `  ${line}`),
  ]);
}

export function renderDiscarded(task: TaskRecord): string {
  return `Task ${task.id} ${task.status}; fork deleted.`;
}

const MERGE_HEADLINE: Record<TaskMerge["outcome"], string> = {
  "merged": "merged",
  "unverified": "applied, but main's changeset didn't pass its gate",
  "apply-failed": "stopped partway",
};

export function renderMerged(merge: TaskMerge): string[] {
  const { task, applied, failure, tests, readiness } = merge;
  const lines = [
    `Task ${task.id} ${MERGE_HEADLINE[merge.outcome]}.`,
    `Changeset: ${merge.changesetId}`,
    `Applied ${applied.length}:`,
    ...applied.map((a) => `  ${a.op} ${a.category}:${a.key}`),
  ];
  if (failure) {
    lines.push(
      `Failed: ${failure.op} ${failure.category}:${failure.key}: ${failure.message}`,
      "The changeset stays open. Finish it, or abandon it to rewind main.",
    );
  }
  if (tests) {
    lines.push(`Main's tests: ${tests.passed}/${tests.total} passed`);
  }
  if (readiness) {
    lines.push("Not completed:", ...readiness.map((r) => `  ${r}`));
  }
  for (const note of merge.notMerged) {
    if (note.severity !== "info") lines.push(`Not merged: ${note.message}`);
  }
  return lines;
}
