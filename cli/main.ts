// @layer composition — headless composition root: boots one StackAssembly
// (OpenTide's open stack by default; tide/main.ts passes the Tide stack).
import { initCompiler, stopCompiler } from "../core/compiler.ts";
import {
  shutdownHttpServer,
  startControlServer,
} from "../core/control-server.ts";
import { getServeArgs, openAssembly, type StackAssembly } from "./assembly.ts";
import {
  loadProject,
  ProjectLockedError,
  unloadProject,
} from "../core/project-loader.ts";
import {
  CONTROL_SERVER_PORT,
  SERVER_SHUTDOWN_GRACE_MS,
} from "../core/config.ts";
import {
  type ChildReadyLine,
  formatReadyLine,
  isOrchestratedChild,
} from "../core/orchestrator/handshake.ts";

// Run the headless REST core: assemble the stack and serve the control server
// for one project. Reused verbatim by the direct entry (below), the `opentide
// serve` subcommand (cli.ts), which passes the args after the subcommand, and the
// Tide kernel (tide/main.ts), which passes its own assembly. `argv` defaults to
// Deno.args for the direct entry.
export async function serveHeadless(
  argv: string[] = Deno.args,
  assembly: StackAssembly = openAssembly,
): Promise<void> {
  console.log("OpenTide starting...");

  await initCompiler();
  console.log("  Compiler ready (esbuild)");

  // Assemble the stack into one composition and thread it through every project
  // this root loads.
  const composition = assembly.composition();

  // Launcher mode (no --project) is retained here for the `deno task kernel`
  // direct entry and the desktop path, which serve the IDE's project picker.
  // The headless `opentide serve` subcommand rejects no-project upstream in the
  // dispatcher (cli.ts) — expressing "one project per invocation" at the CLI
  // boundary without baking the single-project assumption deeper (D2).
  const { projectPath, port, appPort, uiDist } = getServeArgs(
    CONTROL_SERVER_PORT,
    argv,
  );
  const projectCtx = projectPath
    ? await loadProject(projectPath, { composition, appPort }).catch((err) => {
      // A busy project is a normal situation, not a crash. Print the reason and
      // exit quietly rather than dumping a stack the user cannot act on.
      if (err instanceof ProjectLockedError) {
        console.error(`\n  ${err.message}`);
        if (err.detail.suggestion) console.error(`  ${err.detail.suggestion}`);
        Deno.exit(1);
      }
      throw err;
    })
    : null;

  if (!projectCtx) {
    console.log("  No project specified — starting in launcher mode");
  }

  const { server: controlServer, chat, setProject } = await startControlServer(
    projectCtx,
    port,
    {
      composition,
      projectAppPort: appPort,
      // Serve a prebuilt IDE bundle when the orchestrator (or desktop) passes
      // one, so a child is a self-contained stack (Feature B, decision #4).
      staticUiDir: uiDist ?? undefined,
      ...assembly.serverOptions(),
    },
  );
  console.log(`  Control server listening on :${port}`);

  if (projectCtx) {
    console.log(
      `Kernel running (${projectCtx.entry.name}). Press Ctrl+C to stop.`,
    );
    // Orchestrator handshake (Feature B / B1a): when spawned by the supervisor
    // (OPENTIDE_ORCHESTRATED set), emit exactly one machine-readable ready line to
    // stdout — post-bind AND post-loadProject — so the supervisor learns the
    // child is up. A direct run emits nothing (see core/orchestrator/handshake.ts).
    // Launcher mode never emits it: the orchestrator only spawns project-mode
    // children.
    if (isOrchestratedChild()) {
      const readyLine: ChildReadyLine = {
        genie: "ready",
        controlPort: port,
        // Late-bound: an empty project has no app server yet. Best-effort only.
        appPort: projectCtx.appServer.listening
          ? projectCtx.appServer.port
          : null,
        pid: Deno.pid,
        project: projectCtx.entry.path,
      };
      await Deno.stdout.write(
        new TextEncoder().encode(formatReadyLine(readyLine)),
      );
    }
  } else {
    console.log("Launcher ready. Open http://localhost:5173/projects");
  }

  let shutdownPromise: Promise<void> | null = null;
  const shutdown = async () => {
    if (shutdownPromise) return await shutdownPromise;
    shutdownPromise = shutdownOnce();
    return await shutdownPromise;
  };

  const shutdownOnce = async () => {
    console.log("\nShutting down...");
    if (chat) await chat.close();
    await setProject.close();
    if (!(await shutdownHttpServer(controlServer))) {
      console.log(
        `  Open connections didn't close within ${SERVER_SHUTDOWN_GRACE_MS}ms; exiting anyway.`,
      );
    }
    stopCompiler();
    console.log("Goodbye.");
    Deno.exit(0);
  };

  // SIGHUP and SIGQUIT get the same treatment as the interactive two: the kernel owns
  // a PGlite data directory, whose fsyncs are no-ops, so any death that skips
  // unloadProject skips the checkpoint that makes the directory openable again. A
  // closed terminal window must not cost the project.
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"] as const) {
    Deno.addSignalListener(signal, shutdown);
  }

  let crashShutdownInProgress = false;
  const crashShutdown = async (label: string, detail: unknown) => {
    if (shutdownPromise || crashShutdownInProgress) return;
    crashShutdownInProgress = true;
    console.error(`\nCrash (${label}):`, detail);
    try {
      const currentProject = setProject.current();
      if (currentProject) await unloadProject(currentProject);
    } catch { /* best-effort */ }
    Deno.exit(1);
  };

  globalThis.addEventListener("unhandledrejection", (e) => {
    e.preventDefault();
    crashShutdown("unhandled rejection", e.reason);
  });

  globalThis.addEventListener("error", (e) => {
    e.preventDefault();
    crashShutdown("uncaught error", e.error ?? e.message);
  });
}

// Direct entry (the open kernel); the dispatcher (cli.ts) calls serveHeadless
// itself, so importing this module must not auto-run it.
if (import.meta.main) serveHeadless();
