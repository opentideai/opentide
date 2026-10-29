// @layer composition — the `opentide` CLI dispatcher. This is a composition root
// (like main.ts / mcp-main.ts / desktop-main.ts): it is the only thing here that
// assembles layers, and it does so by REUSING the existing roots rather than
// forking them — `serve` runs main.ts's serveHeadless, `mcp` runs mcp-main.ts's
// serveMcp (both extracted for reuse and guarded by import.meta.main so importing
// them here does not auto-run them). Argv shaping / usage live in the cli L2
// module (cli-commands.ts); this file wires the parsed command to a root.
import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  getBuildArgs,
  getExportArgs,
  getLockRefreshArgs,
  getServeArgs,
  isOutputTarget,
  OUTPUT_TARGETS,
  type OutputTarget,
  verificationOnlyComposition,
} from "./assembly.ts";
import {
  type BuildTarget,
  TARGET_DENO_SOURCE,
  TARGET_NODE,
} from "../verification/production-build.ts";
import {
  DEFAULT_REFRESH_TARGETS,
  refreshLocks,
} from "../verification/production-lock-refresh.ts";
import {
  CONTROL_SERVER_PORT,
  OPENTIDE_VERSION,
  SERVE_IDLE_EXIT_MS,
} from "../core/config.ts";
import { cliUsage, parseCliCommand, scaffoldCommand } from "./cli-commands.ts";
import { initCompiler, stopCompiler } from "../core/compiler.ts";
import {
  type BuildOptions,
  type BuildResult,
  DEFAULT_BUILD_OPTIONS,
  getVersion,
  writeExportFiles,
} from "../core/build.ts";
import type { ExportFile } from "../core/export.ts";
import type { Kernel } from "../core/registries.ts";
import {
  loadProject,
  type ProjectContext,
  unloadProject,
} from "../core/project-loader.ts";
import { projectSlug } from "../core/project-manager.ts";
import { errorMessage } from "../core/util.ts";
import { serveHeadless } from "./main.ts";
import { serveMcp } from "./mcp-main.ts";
import { serveLsp } from "./lsp-main.ts";
import {
  callTasksApi,
  locateMainServe,
  parseTaskCommand,
  renderDiscarded,
  renderMerged,
  renderStarted,
  renderTaskList,
  type StartedTask,
  type TaskCommand,
  taskUsage,
} from "./task-commands.ts";
import type { TaskRecord, TaskWithOverlaps } from "../core/tasks/task-store.ts";
import type { TaskMerge } from "../core/tasks/task-merge.ts";
import {
  connectConfigTarget,
  generateConnectConfig,
  isMcpClient,
  MCP_CLIENTS,
} from "../mcp/mcp-connect.ts";

// Assemble the open stack for a single run-once command (build/export), then tear
// it down. Mirrors serveHeadless's prelude (initCompiler → loadProject with the
// open composition) but binds the app server to an ephemeral port (appPort:0, like
// desktop-main.ts) so a build never collides with a running kernel's APP_PORT,
// and always unloads + stops the compiler afterwards. loadProject sits OUTSIDE
// the try: if it throws, there is no ctx to unload and the process exits anyway.
async function withLoadedProject<T>(
  projectPath: string,
  fn: (ctx: ProjectContext) => Promise<T>,
): Promise<T> {
  await initCompiler();
  const ctx = await loadProject(projectPath, {
    appPort: 0,
    composition: verificationOnlyComposition(),
  });
  try {
    return await fn(ctx);
  } finally {
    await unloadProject(ctx);
    stopCompiler();
  }
}

// The shared shape of the run-once, project-loading commands (build/export):
// reject a missing --project up front (D2, exit 2 via usage), else assemble the
// project, run `fn`, and map any failure — a runtime that lacks the method or a
// build/export throw — to stderr + exit 1. Keeps each case to just its parser
// and body.
async function runLoadedCommand(
  projectPath: string | null,
  missingProjectMessage: string,
  fn: (ctx: ProjectContext) => Promise<void>,
): Promise<void> {
  if (projectPath === null) usageErrorAndExit(missingProjectMessage);
  try {
    await withLoadedProject(projectPath, fn);
  } catch (e) {
    console.error(`error: ${errorMessage(e)}`);
    Deno.exit(1);
  }
}

// Guard an explicit `--out` export target so a run never silently clobbers or
// leaves stale files behind (F-11). For the tree form the hazard is a non-empty
// directory — a merge-write would leave a since-deleted handler's file lingering;
// for the tarball form it is any pre-existing path. Refuse (the caller maps the
// throw to stderr + a non-zero exit) unless --force, which clears the target
// first so no stale files survive. The managed defaults never reach here — they
// keep overwriting silently as before.
function prepareExplicitOut(
  target: string,
  tarball: boolean,
  force: boolean,
): void {
  if (!existsSync(target)) return;
  const occupied = tarball ||
    !statSync(target).isDirectory() ||
    readdirSync(target).length > 0;
  if (!occupied) return;
  if (!force) {
    throw new Error(
      `export target already exists and is not empty: ${target} ` +
        "(pass --force to overwrite it).",
    );
  }
  rmSync(target, { recursive: true, force: true });
  if (!tarball) mkdirSync(target, { recursive: true });
}

// The --target of `build` / `export`, or a usage error naming the choices.
function outputTargetOrExit(raw: string): OutputTarget {
  if (isOutputTarget(raw)) return raw;
  usageErrorAndExit(
    `error: unknown --target "${raw}". Use one of: ${
      OUTPUT_TARGETS.join(", ")
    }.`,
  );
}

// Print usage to stdout and exit 0 — the user asked for help.
function printHelpAndExit(): never {
  console.log(cliUsage());
  Deno.exit(0);
}

// Print usage to stderr and exit 2 — the invocation was wrong (no/unknown
// command, or a headless `serve` with no project). Mirrors mcp-main.ts's
// stderr+exit-2 discipline for usage errors.
function usageErrorAndExit(message: string): never {
  console.error(message);
  console.error("");
  console.error(cliUsage());
  Deno.exit(2);
}

async function buildForTarget(
  kernel: Kernel,
  entry: { path: string; name: string },
  target: OutputTarget,
  version: string,
  opts: BuildOptions,
): Promise<BuildResult> {
  const { runtime } = kernel;
  if (target === "node" && runtime.buildNodeProject) {
    return await runtime.buildNodeProject(
      kernel,
      entry.path,
      entry.name,
      version,
      opts,
    );
  }
  if (target === "deno" && runtime.buildDenoProject) {
    return await runtime.buildDenoProject(kernel, entry.path, version, opts);
  }
  throw new Error(
    `runtime "${kernel.runtimeId}" does not support the ${target} build`,
  );
}

async function exportForTarget(
  kernel: Kernel,
  entry: { path: string; name: string },
  target: OutputTarget,
  includeSeedData: boolean,
): Promise<{ files: ExportFile[]; tarball: Uint8Array }> {
  const opts = { ...DEFAULT_BUILD_OPTIONS, includeSeedData };
  if (target === "node") {
    if (!kernel.runtime.exportNodeProject) {
      throw new Error(
        `runtime "${kernel.runtimeId}" does not support the node export`,
      );
    }
    return await kernel.runtime.exportNodeProject(
      kernel,
      entry.path,
      entry.name,
      getVersion(entry.path),
      opts,
    );
  }
  if (!kernel.runtime.exportProject) {
    throw new Error(`runtime "${kernel.runtimeId}" does not support export`);
  }
  return await kernel.runtime.exportProject(kernel, {
    ...opts,
    projectName: entry.name,
  });
}

export async function runCli(argv: string[] = Deno.args): Promise<void> {
  const { command, rest, help, version } = parseCliCommand(argv);

  if (help) printHelpAndExit();
  if (version) {
    console.log(`opentide ${OPENTIDE_VERSION}`);
    Deno.exit(0);
  }
  if (command === null) usageErrorAndExit("error: no command given.");

  switch (command) {
    case "serve": {
      // Headless serve is single-project: reject no-project here (D2) so the
      // single-project contract lives at the CLI boundary, not in the core.
      // main.ts's launcher mode stays available via `deno task kernel`.
      if (getServeArgs(CONTROL_SERVER_PORT, rest).projectPath === null) {
        usageErrorAndExit(
          "error: `serve` requires --project <path> " +
            "(launcher / multi-project mode is IDE-only).",
        );
      }
      await serveHeadless(rest);
      return;
    }
    case "mcp":
      // serveMcp owns its own no-project handling and stdout discipline.
      await serveMcp(rest);
      return;
    case "lsp":
      // serveLsp, like serveMcp, owns its own no-project handling and stdout
      // discipline (stdout is the LSP JSON-RPC channel).
      await serveLsp(rest);
      return;
    case "scaffold": {
      // The one assemble-nothing command: scaffoldCommand does the pure work
      // (wrapping core's createProject) and returns a result; this root only
      // renders it. Run-once, then exit — unlike serve/mcp, which stay up.
      const result = scaffoldCommand(rest);
      if (!result.ok) {
        if (result.kind === "usage") usageErrorAndExit(result.message);
        console.error(result.message);
        Deno.exit(1);
      }
      // createProject derives the folder from slug(<name>) under <dir> (D2), so
      // echo the resolved path — that, not the literal <dir>, is where it landed.
      console.log(`Created project "${result.name}" at ${result.path}`);
      return;
    }
    case "build": {
      // Unlike scaffold, build assembles a Kernel — so its body lives here in the
      // composition root, not the cli L2 module.
      const args = getBuildArgs(rest);
      const target = outputTargetOrExit(args.target);
      await runLoadedCommand(
        args.projectPath,
        "error: `build` requires --project <path>.",
        async ({ kernel, entry }) => {
          const version = getVersion(entry.path);
          const opts = {
            ...DEFAULT_BUILD_OPTIONS,
            includeSeedData: args.includeSeedData,
          };
          const result = await buildForTarget(
            kernel,
            entry,
            target,
            version,
            opts,
          );
          console.log(
            `Built ${target} target -> ${result.path} ` +
              `(${result.fileCount} files, v${result.version})`,
          );
        },
      );
      return;
    }
    case "export": {
      const { projectPath, out, tarball, includeSeedData, force, target: raw } =
        getExportArgs(rest);
      const target = outputTargetOrExit(raw);
      await runLoadedCommand(
        projectPath,
        "error: `export` requires --project <path>.",
        async ({ kernel, entry }) => {
          // One call serves both forms — the result carries the file tree AND
          // the tarball; --tarball only picks which we write.
          const result = await exportForTarget(
            kernel,
            entry,
            target,
            includeSeedData,
          );
          if (tarball) {
            // Derive the default filename from a SLUG of the project name, never
            // the raw name — a name like "../x" would otherwise escape the
            // project dir, and an interior "/" would ENOENT-crash (F-10). An
            // explicit --out is the user's own choice and passes through.
            const tarPath = out ??
              join(entry.path, `${projectSlug(entry.name)}.tar`);
            // Only an explicit --out is guarded; the managed default overwrites.
            if (out !== null) prepareExplicitOut(out, true, force);
            writeFileSync(tarPath, result.tarball);
            console.log(
              `Exported tarball -> ${tarPath} (${result.files.length} files)`,
            );
          } else {
            const outDir = out ?? join(entry.path, "export");
            // Only an explicit --out is guarded; the managed default overwrites.
            if (out !== null) prepareExplicitOut(out, false, force);
            writeExportFiles(outDir, result.files);
            console.log(
              `Exported project -> ${outDir} (${result.files.length} files)`,
            );
          }
        },
      );
      return;
    }
    case "lock:refresh": {
      // Like build/export, this assembles a Kernel, so its body lives in the
      // composition root. It is the network-allowed PRODUCER of the committed locks
      // the 6.x gates validate — it writes deno.lock / package-lock.json into the
      // project and lives entirely OUTSIDE the pure build path.
      const { projectPath, targets: rawTargets } = getLockRefreshArgs(rest);
      const targets = resolveRefreshTargets(rawTargets);
      await runLoadedCommand(
        projectPath,
        "error: `lock:refresh` requires --project <path>.",
        async ({ kernel, entry }) => {
          const report = await refreshLocks(kernel, entry.path, {
            projectName: entry.name,
          }, targets);
          for (const t of report.targets) {
            console.log(`${t.target}: ${t.status} — ${t.detail}`);
          }
          if (!report.ok) {
            // A produced-but-invalid or un-producible lock is a hard failure; the
            // process exits non-zero so a caller/CI can key on it.
            throw new Error("one or more lock targets failed to refresh.");
          }
        },
      );
      return;
    }
    case "task":
      await runTaskCommand(rest);
      return;
    default:
      usageErrorAndExit(`error: unknown command "${command}".`);
  }
}

function failAndExit(
  error: { message: string; suggestion?: string },
): never {
  console.error(`error: ${error.message}`);
  if (error.suggestion) console.error(error.suggestion);
  Deno.exit(1);
}

// What `task start` prints after the fork: a config that points a client at it.
function forkClientConfig(client: string, forkPath: string): string[] {
  if (!isMcpClient(client)) return [];
  return [
    "",
    `# ${client} config for the fork — write to: ${
      connectConfigTarget(client)
    }`,
    generateConnectConfig(client, {
      transport: "stdio",
      projectPath: forkPath,
    }),
  ];
}

function renderTaskResult(command: TaskCommand, data: unknown): string[] {
  switch (command.action) {
    case "start": {
      const started = data as StartedTask;
      return [
        ...renderStarted(started),
        ...forkClientConfig(command.client, started.task.path),
      ];
    }
    case "list":
      return renderTaskList(data as TaskWithOverlaps[]);
    case "merge":
      return renderMerged(data as TaskMerge);
    case "discard":
      return [renderDiscarded(data as TaskRecord)];
  }
}

// `opentide task …`. The REST client and rendering live in task-commands.ts;
// this adds the client config, which comes from the mcp layer.
async function runTaskCommand(rest: string[]): Promise<void> {
  const parsed = parseTaskCommand(rest);
  if (!parsed.ok) {
    console.error(parsed.message);
    console.error("");
    console.error(taskUsage());
    Deno.exit(2);
  }
  const { command } = parsed;
  if (command.action === "start" && !isMcpClient(command.client)) {
    usageErrorAndExit(
      `error: unknown --client "${command.client}" ` +
        `(expected one of: ${MCP_CLIENTS.join(", ")}).`,
    );
  }
  const main = await locateMainServe(command.projectPath);
  if (!main.ok) failAndExit(main.error);
  if (main.data.started) {
    const { pid, logPath } = main.data.started;
    console.error(
      `Started opentide serve (pid ${pid}) for this project; it stops itself ` +
        `after ${SERVE_IDLE_EXIT_MS / 60_000} minutes with no client.` +
        (logPath ? ` Log: ${logPath}` : ""),
    );
  }
  const result = await callTasksApi(main.data.base, command);
  if (!result.ok) failAndExit(result.error);
  console.log(renderTaskResult(command, result.data).join("\n"));
  if (
    command.action === "merge" &&
    (result.data as TaskMerge).outcome !== "merged"
  ) {
    Deno.exit(1);
  }
}

// Validate the raw `--target` tokens against the closed refreshable-target set
// (deno-source / node) and build the selection. No tokens ⇒ the producer's default
// (both). `binary` is deliberately rejected — a compiled binary snapshots the graph
// and has no lock of its own; it shares deno-source's deno.lock. An unknown token
// is a usage error (exit 2).
function resolveRefreshTargets(
  rawTargets: string[] | null,
): ReadonlySet<BuildTarget> {
  if (rawTargets === null) return DEFAULT_REFRESH_TARGETS;
  const selected = new Set<BuildTarget>();
  for (const token of rawTargets) {
    if (token === TARGET_DENO_SOURCE || token === TARGET_NODE) {
      selected.add(token);
    } else {
      usageErrorAndExit(
        `error: unknown --target "${token}" ` +
          `(expected "${TARGET_DENO_SOURCE}" or "${TARGET_NODE}").`,
      );
    }
  }
  if (selected.size === 0) {
    usageErrorAndExit("error: --target requires at least one target.");
  }
  return selected;
}

if (import.meta.main) runCli();
