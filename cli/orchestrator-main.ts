// @layer composition — orchestrator composition root (Feature B / B1c + B3a).
//
// The thin apex that turns the B1b supervisor LIBRARY into a runnable,
// systemd-manageable process. It constructs a ProjectSupervisor, runs init() on
// boot to re-spawn the persisted running set (decision #5, §6.3), binds the B3a
// dashboard HTTP API (§9), and installs a graceful shutdownAll() on SIGINT/SIGTERM.
// The repurposed /projects picker (B3b) still consumes those endpoints from the
// IDE. See docs/orchestrator-design.md §4, §9.
//
// Keep-alive reconciliation (B3a): B1c held an explicit ref'd timer because a
// signal listener alone does NOT keep the Deno event loop alive and it bound no
// server. B3a's Deno.serve (the dashboard) is now that resident resource, exactly
// like every other composition root — so the keep-alive timer is REMOVED. shutdown
// closes the server, which drains the loop; an empty running set boots resident on
// the bound port and still exits cleanly on SIGTERM.

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  defaultSpawn,
  ProjectSupervisor,
  type Supervisor,
} from "../core/orchestrator/supervisor.ts";
import {
  type DashboardServer,
  type RegistryReader,
  startDashboardServer,
} from "../core/orchestrator/dashboard-server.ts";
import { getOrchestratorArgs } from "./assembly.ts";

// Env override for the prebuilt IDE bundle dir, matching the desktop root's
// TIDE_UI_DIST spelling (a composition-root concern, inlined like desktop-main.ts
// does — not a core config value).
const ORCHESTRATOR_UI_DIST_ENV = "ORCHESTRATOR_UI_DIST";

// The repo's built IDE output (adapter-static; ide/svelte.config.js), resolved off
// this module's URL so it works regardless of cwd. The default --ui-dist when
// neither the flag nor the env override is given.
const DEFAULT_UI_DIST = fileURLToPath(new URL("../ide/build", import.meta.url));

// Resolve the built-IDE bundle dir threaded into every child (--ui-dist, §7):
// flag → ORCHESTRATOR_UI_DIST env → the repo's ide/build. Returns null when the
// resolved dir does not exist, so children fall back to their own dev server
// rather than the orchestrator crashing on boot.
export function resolveUiDist(flagValue: string | null): string | null {
  const candidate = flagValue ??
    Deno.env.get(ORCHESTRATOR_UI_DIST_ENV) ??
    DEFAULT_UI_DIST;
  return existsSync(candidate) ? candidate : null;
}

// A live orchestrator: the wired supervisor, the bound dashboard server, the uiDist
// threaded into children, and a memoized graceful shutdown. Returned by
// runOrchestrator so the direct entry can stay resident and a unit test can drive
// shutdown without real signals.
export interface OrchestratorHandle {
  supervisor: Supervisor;
  server: DashboardServer;
  uiDist: string | null;
  // Idempotent: SIGTERM every child, await exits, close the dashboard server. Calls
  // supervisor.shutdownAll() exactly once regardless of how many times it fires.
  shutdown: () => Promise<void>;
}

// Injected seams so a unit test drives the root WITHOUT booting a real kernel,
// binding a real port, or touching OS signals. All default to the production wiring.
export interface RunOrchestratorDeps {
  // Build the supervisor from the resolved uiDist. Default: a real
  // ProjectSupervisor (real kernel children, live state file). A test passes a
  // fake Supervisor and asserts init()/shutdownAll() and the threaded uiDist.
  supervisorFactory?: (uiDist: string | null) => Supervisor;
  // Bind the dashboard HTTP API around the supervisor. Default: the real
  // startDashboardServer (Deno.serve on ORCHESTRATOR_DASHBOARD_PORT, loopback). A
  // test passes a fake returning a no-op handle so nothing binds a real port.
  startServer?: (supervisor: Supervisor) => DashboardServer;
  // The registry read side the dashboard joins against (all known projects + name).
  // Default: project-manager's listProjects (used inside startDashboardServer).
  registryReader?: RegistryReader;
  // Register the resident lifecycle (OS signal + crash handlers) around the
  // shutdown fn; return a disposer shutdown() calls. Default wires the real thing;
  // a test passes a no-op so nothing lingers.
  installLifecycle?: (shutdown: () => Promise<void>) => () => void;
}

function defaultSupervisorFactory(uiDist: string | null): Supervisor {
  // statePath defaults to getOrchestratorStatePath() (honoring the
  // OPENTIDE_ORCHESTRATOR_STATE_PATH override); spawn defaults to defaultSpawn (a
  // real kernel child mirroring `deno task kernel`).
  return new ProjectSupervisor({ spawn: defaultSpawn, config: { uiDist } });
}

// The production resident lifecycle: signal + crash handlers. No keep-alive timer —
// the dashboard's Deno.serve is the resident resource that holds the event loop
// open (B3a; see file header). Returns a no-op disposer (nothing to release).
function installLifecycle(shutdown: () => Promise<void>): () => void {
  const onSignal = async () => {
    await shutdown();
    Deno.exit(0);
  };
  Deno.addSignalListener("SIGINT", onSignal);
  Deno.addSignalListener("SIGTERM", onSignal);

  // Crash handlers mirror cli/main.ts: best-effort child cleanup, then exit 1.
  const onCrash = (label: string, detail: unknown) => {
    console.error(`\nOrchestrator crash (${label}):`, detail);
    shutdown().finally(() => Deno.exit(1));
  };
  globalThis.addEventListener("unhandledrejection", (e) => {
    e.preventDefault();
    onCrash("unhandled rejection", e.reason);
  });
  globalThis.addEventListener("error", (e) => {
    e.preventDefault();
    onCrash("uncaught error", e.error ?? e.message);
  });

  return () => {};
}

// Boot the orchestrator: resolve uiDist, construct the supervisor, re-spawn the
// persisted running set (init, §6.3), and install graceful shutdown. Stays
// resident via the lifecycle keep-alive; never throws out of the root (the
// supervisor is Result<T> throughout — a corrupt state file degrades to an empty
// set). `argv` defaults to Deno.args for the direct entry.
export async function runOrchestrator(
  argv: string[] = Deno.args,
  deps: RunOrchestratorDeps = {},
): Promise<OrchestratorHandle> {
  console.log("OpenTide orchestrator starting...");

  const { uiDist: uiDistFlag } = getOrchestratorArgs(argv);
  const uiDist = resolveUiDist(uiDistFlag);
  if (uiDist === null) {
    console.log(
      "  No built IDE bundle found — children will need their own dev server (--ui-dist unset).",
    );
  } else {
    console.log(`  Children serve their IDE from ${uiDist}`);
  }

  const supervisor = (deps.supervisorFactory ?? defaultSupervisorFactory)(
    uiDist,
  );

  // Boot re-spawn (§6.3): init reads the state file and starts every
  // desiredState="running" child. It resolves once the set has settled (each
  // launch reaches running or failed) and never throws.
  await supervisor.init();
  console.log(`  Supervising ${supervisor.list().length} project(s).`);

  // B3a: bind the dashboard HTTP API (§9), loopback-only. This is the resident
  // resource that keeps the process alive (replacing B1c's keep-alive timer).
  const startServer = deps.startServer ??
    ((s: Supervisor) =>
      startDashboardServer(s, {
        registryReader: deps.registryReader,
        // B3b: serve the dashboard UI from the SAME built bundle threaded to
        // children. Null (no bundle) → API-only, exactly as B3a shipped.
        staticUiDir: uiDist ?? undefined,
        onListen: ({ hostname, port }) =>
          console.log(`  Dashboard on http://${hostname}:${port}`),
      }));
  const server = startServer(supervisor);
  console.log("Orchestrator ready. Press Ctrl+C to stop.");

  let shutdownPromise: Promise<void> | null = null;
  let releaseLifecycle: () => void = () => {};
  const shutdown = (): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      console.log("\nShutting down orchestrator...");
      await supervisor.shutdownAll();
      // Close the dashboard listener so the event loop drains and the process
      // exits cleanly even without an explicit Deno.exit (the signal path exits 0).
      await server.shutdown();
      releaseLifecycle();
      console.log("Goodbye.");
    })();
    return shutdownPromise;
  };

  releaseLifecycle = (deps.installLifecycle ?? installLifecycle)(shutdown);

  return { supervisor, server, uiDist, shutdown };
}

// Direct entry (`deno task orchestrator`) and the future `opentide orchestrator`
// dispatcher path. Importing this module must not auto-run it. A boot failure
// (should not happen — the supervisor never throws) exits non-zero rather than
// hanging.
if (import.meta.main) {
  runOrchestrator().catch((err) => {
    console.error(
      err instanceof Error ? err.stack ?? err.message : String(err),
    );
    Deno.exit(1);
  });
}
