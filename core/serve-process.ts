// @layer core — finding and starting a project's `opentide serve` process. The
// MCP bridge uses it to attach a stdio client; task forks use it to start the
// fork's serve. The process is detached and outlives whoever started it.
//
// The lock record says who holds the project; the OS lock says whether they're
// still alive. A serve killed with -9 leaves a record pointing at a dead port,
// so the record is only trusted while the lock is held.
//
// deno.json is a non-.ts relative import the layer checker ignores; it lives at
// the repo root, one level above this module.
import { projectStateDir } from "./project-layout.ts";
import denoJson from "../deno.json" with { type: "json" };
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEV_SERVER_HOST,
  LAUNCHER_ENV,
  MCP_BRIDGE_POLL_MS,
  MCP_BRIDGE_STARTUP_TIMEOUT_MS,
  MCP_HTTP_PATH,
  SERVE_LOG_FILE,
} from "./config.ts";
import {
  isProjectLockHeld,
  type ProjectLockHolder,
  readLockHolder,
} from "./project-lock.ts";
import { readEnv } from "./process-env.ts";
import { readServerToken, removeServerToken } from "./server-token.ts";
import type { Result } from "./types.ts";

// Repo root = two levels up from this module (core/serve-process.ts → core → /).
export const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

export interface DenoInvocation {
  command: string;
  args: string[];
}

// Derive `deno run … <script>.ts` from a real deno.json task. The task's
// script path is repo-relative; absolutize it so the command runs from any
// working directory.
export function denoTaskInvocation(name: "mcp" | "opentide"): DenoInvocation {
  const task = denoJson.tasks[name];
  const tokens = task.split(/\s+/).filter((t) => t.length > 0);
  const scriptIdx = tokens.findIndex((t) => t.endsWith(".ts"));
  if (scriptIdx < 1) {
    throw new Error(`Unexpected shape for the "${name}" deno task: ${task}`);
  }
  const command = tokens[0]!; // "deno"
  const flags = tokens.slice(1, scriptIdx); // ["run", "--env", …permissions]
  const scriptAbs = join(REPO_ROOT, tokens[scriptIdx]!);
  return { command, args: [...flags, scriptAbs] };
}

// How this process was started, which decides how it starts another opentide:
//   binary   — a `deno compile` build: the executable is opentide itself, with
//              permissions baked in, and its sources exist only in the binary's
//              virtual filesystem;
//   launcher — install.sh's `opentide` script, which pins the release's config
//              and lockfile and names itself in OPENTIDE_LAUNCHER;
//   clone    — `deno task` from a checkout.
export type OpentideRuntime =
  | { kind: "binary" }
  | { kind: "launcher"; path: string }
  | { kind: "clone" };

export function currentRuntime(): OpentideRuntime {
  if (Deno.build.standalone) return { kind: "binary" };
  const launcher = readEnv(LAUNCHER_ENV);
  return launcher ? { kind: "launcher", path: launcher } : { kind: "clone" };
}

export function opentideInvocation(
  subcommand: "serve" | "mcp",
  runtime: OpentideRuntime = currentRuntime(),
): DenoInvocation {
  switch (runtime.kind) {
    case "binary":
      return { command: Deno.execPath(), args: [subcommand] };
    case "launcher":
      return { command: runtime.path, args: [subcommand] };
    case "clone": {
      if (subcommand === "mcp") return denoTaskInvocation("mcp");
      const { command, args } = denoTaskInvocation("opentide");
      return { command, args: [...args, "serve"] };
    }
  }
}

// The directory an opentide child should start in: the repo root from a clone,
// where the task's `--env` finds `.env`; anywhere otherwise.
export function opentideCwd(
  runtime: OpentideRuntime = currentRuntime(),
): string | null {
  return runtime.kind === "clone" ? REPO_ROOT : null;
}

// A serve process started here. It is detached and outlives its starter.
export interface SpawnedServe {
  pid: number;
  // Null where output can't be redirected (Windows); it is discarded there.
  logPath: string | null;
  exited(): boolean;
}

export interface ServeTarget {
  url: string;
  token: string;
  pid: number;
  controlPort: number;
  // Set when the serve process was started here; null when it attached.
  started: SpawnedServe | null;
}

export interface LocateOptions {
  spawn?: (projectDir: string) => SpawnedServe;
  timeoutMs?: number;
  pollMs?: number;
}

function freePort(): number {
  const listener = Deno.listen({ hostname: DEV_SERVER_HOST, port: 0 });
  const { port } = listener.addr as Deno.NetAddr;
  listener.close();
  return port;
}

// Start `opentide serve` for the project, detached, on a free port. On Unix a
// shell redirects its output to .opentide/serve.log and then execs deno, so the
// pid we hold is the pid serve writes into the lock record.
export function spawnServe(projectDir: string): SpawnedServe {
  const invocation = opentideInvocation("serve");
  const args = invocation.args;
  // From a clone the task says plain `deno`; run the deno running this instead.
  const program = invocation.command === "deno"
    ? Deno.execPath()
    : invocation.command;
  const argv = [
    ...args,
    "--project",
    projectDir,
    "--port",
    String(freePort()),
  ];
  const common = {
    cwd: opentideCwd() ?? projectDir,
    stdin: "null",
    stdout: "null",
    stderr: "null",
    detached: true,
  } as const;
  const unix = Deno.build.os !== "windows";
  const logPath = unix
    ? join(projectStateDir(projectDir), SERVE_LOG_FILE)
    : null;
  if (logPath) mkdirSync(dirname(logPath), { recursive: true });
  const command = logPath
    ? new Deno.Command("/bin/sh", {
      ...common,
      args: [
        "-c",
        'exec "$@" >>"$OPENTIDE_SERVE_LOG" 2>&1',
        "opentide-serve",
        program,
        ...argv,
      ],
      env: { OPENTIDE_SERVE_LOG: logPath },
    })
    : new Deno.Command(program, { ...common, args: argv });
  const child = command.spawn();
  let exited = false;
  child.status.then(() => {
    exited = true;
  });
  child.unref();
  return { pid: child.pid, logPath, exited: () => exited };
}

function fail(
  code: string,
  message: string,
  suggestion?: string,
): Result<never> {
  return {
    ok: false,
    error: { code, message, ...(suggestion ? { suggestion } : {}) },
  };
}

function describe(holder: ProjectLockHolder | null): string {
  return holder ? `${holder.process} (pid ${holder.pid})` : "another process";
}

// The serve target the record points at, once it names a port and the token is
// on disk. Only meaningful while the lock is held by that record's writer.
function attach(
  projectDir: string,
  holder: ProjectLockHolder | null,
  started: SpawnedServe | null,
): ServeTarget | null {
  if (holder?.role !== "serve" || holder.controlPort === undefined) return null;
  const token = readServerToken(projectDir);
  if (!token) return null;
  return {
    url: `http://${DEV_SERVER_HOST}:${holder.controlPort}${MCP_HTTP_PATH}`,
    token,
    pid: holder.pid,
    controlPort: holder.controlPort,
    started,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Find the serve process that holds `projectDir`, starting one if nothing holds
 * it. Refuses a standalone `opentide mcp` holder: nothing can attach to that.
 */
export async function locateServe(
  projectDir: string,
  opts: LocateOptions = {},
): Promise<Result<ServeTarget>> {
  if (!existsSync(projectDir)) {
    return fail("PROJECT_NOT_FOUND", `No project at ${projectDir}.`);
  }
  const spawn = opts.spawn ?? spawnServe;
  const timeoutMs = opts.timeoutMs ?? MCP_BRIDGE_STARTUP_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  let started: SpawnedServe | null = null;

  while (true) {
    const holder = readLockHolder(projectDir);

    if (started && !started.exited()) {
      // Our child writes its own pid into the record once it holds the lock.
      // Until then the record is whatever the last holder left.
      const target = holder?.pid === started.pid
        ? attach(projectDir, holder, started)
        : null;
      if (target) return { ok: true, data: target };
    } else if (!isProjectLockHeld(projectDir)) {
      if (started) {
        return fail(
          "SERVE_START_FAILED",
          `opentide serve (pid ${started.pid}) exited before it was ready.`,
          started.logPath ? `See ${started.logPath}.` : undefined,
        );
      }
      // Nobody alive holds it. A token left by a holder that died without
      // unloading is now a lie; drop it before the new serve writes its own.
      removeServerToken(projectDir);
      started = spawn(projectDir);
    } else {
      // Held by a live process: ours lost a start race, or it was there first.
      if (holder?.role === "mcp") {
        return fail(
          "PROJECT_ALREADY_OPEN",
          `This project is open in a standalone MCP server ` +
            `(${describe(holder)}), which can't be shared.`,
          "Stop it and run `opentide serve --project <path>` instead; " +
            "every MCP client can then attach to that.",
        );
      }
      const target = attach(projectDir, holder, null);
      if (target) return { ok: true, data: target };
    }

    if (Date.now() >= deadline) {
      return fail(
        "SERVE_NOT_READY",
        `No serve process for this project answered within ${timeoutMs}ms. ` +
          `It is held by ${describe(holder)}.`,
        started?.logPath
          ? `See ${started.logPath}.`
          : "If that isn't `opentide serve`, stop it and try again.",
      );
    }
    await sleep(opts.pollMs ?? MCP_BRIDGE_POLL_MS);
  }
}
