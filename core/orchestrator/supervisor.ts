// @layer core — the orchestrator supervisor (Feature B / B1b).
//
// A desiredState → actualState reconciler over a set of per-project children. It
// spawns one `opentide serve --project X --port N` child per running project,
// reads the child's ONE machine-readable ready line (core/orchestrator/handshake.ts),
// keeps it alive (crash restart with backoff, health polling), and persists the
// running set (core/orchestrator/state.ts) so boot re-spawns it. This is a LIBRARY:
// no HTTP server, no composition root, no dashboard (those are B1c / B3).
//
// The spawn mechanism is INJECTED (a SpawnFn the constructor accepts) so unit
// tests substitute a fake child and never boot a real kernel. The default mirrors
// `deno task kernel`. See docs/orchestrator-design.md §3.4, §6.

import { readEnv } from "../process-env.ts";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Result } from "../types.ts";
import {
  denoToolchainFailure,
  resolveDenoToolchain,
} from "../deno-toolchain.ts";
import {
  DEV_SERVER_HOST,
  OPENTIDE_DB_URL_ENV,
  ORCHESTRATOR_BACKOFF_BASE_MS,
  ORCHESTRATOR_BACKOFF_CAP_MS,
  ORCHESTRATOR_CHILD_PORT_BASE,
  ORCHESTRATOR_CHILD_PORT_RANGE,
  ORCHESTRATOR_HEALTH_INTERVAL_MS,
  ORCHESTRATOR_HEALTH_MAX_FAILURES,
  ORCHESTRATOR_LOG_BUFFER_LINES,
  ORCHESTRATOR_MAX_RESTARTS,
  ORCHESTRATOR_MAX_START_RETRIES,
  ORCHESTRATOR_READY_TIMEOUT_MS,
  ORCHESTRATOR_STABILITY_WINDOW_MS,
  ORCHESTRATOR_STOP_TIMEOUT_MS,
} from "../config.ts";
import {
  type ChildReadyLine,
  isChildReadyLine,
  OPENTIDE_ORCHESTRATED_ENV,
  OPENTIDE_ORCHESTRATED_ON,
} from "./handshake.ts";
import {
  type ChildExit,
  emptyOrchestratorState,
  getOrchestratorStatePath,
  type OrchestratorProjectRecord,
  readOrchestratorState,
  writeOrchestratorState,
} from "./state.ts";

// The in-memory actual state of a child (only running|stopped ever persist as
// desiredState — the rest are transient; §6.1).
export type ActualState =
  | "stopped"
  | "starting"
  | "running"
  | "crashed"
  | "failed";

// One captured line of a child's stdout/stderr (Feature B / B4b). Tagged by stream
// and timestamped so the dashboard can render the tail (stream-coloured, ordered).
// Array order is the capture order; `at` is the observation time (ISO 8601).
export interface LogLine {
  stream: "stdout" | "stderr";
  text: string;
  at: string;
}

// The subset of Deno.ChildProcess the supervisor needs. A real Deno.ChildProcess
// satisfies this structurally, so the default spawn returns one directly; a fake
// child in tests implements just these members.
export interface ChildHandle {
  readonly pid: number;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly status: Promise<Deno.CommandStatus>;
  kill(signo?: Deno.Signal): void;
}

// Everything the spawn seam needs to launch one child. Built by the supervisor;
// the SpawnFn turns it into a running process (real or fake).
export interface SpawnOptions {
  projectPath: string;
  controlPort: number;
  // App-preview port passed as --app-port; 0 = OS-assigned (the supervisor always
  // passes 0 — the app port is late-bound and non-authoritative, §3.5).
  appPort: number;
  // Prebuilt IDE bundle dir threaded to --ui-dist, or null for a dev child.
  uiDist: string | null;
  // Env for the child. Always carries OPENTIDE_ORCHESTRATED=1 so the child emits its
  // ready line; carries OPENTIDE_DB_URL when the orchestrator has one.
  env: Record<string, string>;
}

// The injected spawn seam. Returns a live child handle. Tests substitute a fake.
export type SpawnFn = (opts: SpawnOptions) => ChildHandle;

// A child's live view (dashboard-facing; §6.2). `process` is the abstract handle.
export interface RunningChild {
  record: OrchestratorProjectRecord;
  actualState: ActualState;
  process?: ChildHandle;
  startedAt?: number; // epoch ms of the current spawn
  restartCount: number; // crash restarts within the current stability window
  lastReady?: ChildReadyLine; // last handshake seen
}

// The reconciler's public API (§6.2). Result<T> throughout — never throws.
export interface Supervisor {
  init(): Promise<void>;
  start(projectPath: string): Promise<Result<RunningChild>>;
  stop(projectPath: string): Promise<Result<void>>;
  list(): RunningChild[];
  get(projectPath: string): RunningChild | null;
  // The buffered stdout/stderr tail for a child (Feature B / B4b). Returns a copy,
  // regardless of actualState (a crashed child's logs stay readable), or an empty
  // array for a path the supervisor never spawned.
  logs(projectPath: string): LogLine[];
  // Manual per-row restart (Feature B / B4c): stop then start. Reuses the two
  // existing verbs so spawn/stop logic is never duplicated, and runs server-side
  // so there is no client stop→poll→start race.
  restart(projectPath: string): Promise<Result<RunningChild>>;
  // Drop a fully stopped child record after an external path-key change such as a
  // project rename. Active or desired-running rows are preserved and report false.
  forgetStoppedProject(projectPath: string): Promise<boolean>;
  shutdownAll(): Promise<void>;
}

// Test-only overrides for the tunables so a suite never waits 30s (all default to
// the config constants). `healthEnabled` gates the /api/status poll — off in unit
// tests, whose fake children serve no HTTP.
export interface SupervisorConfig {
  portBase?: number;
  portRange?: number;
  readyTimeoutMs?: number;
  stopTimeoutMs?: number;
  maxStartRetries?: number;
  maxRestarts?: number;
  healthIntervalMs?: number;
  healthMaxFailures?: number;
  healthEnabled?: boolean;
  backoffBaseMs?: number;
  backoffCapMs?: number;
  stabilityWindowMs?: number;
  logBufferLines?: number;
  // Injectable clock/RNG so tests can be deterministic if needed (default to the
  // real ones — product code may use Date.now()/Math.random() freely).
  now?: () => number;
  random?: () => number;
  // Prebuilt IDE bundle dir passed to every child (--ui-dist), or null (dev).
  uiDist?: string | null;
}

// A one-shot resolvable used to hand a start()/init() caller the outcome the
// supervision loop reaches (running → ok, failed → error).
interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

// A cancellable timer whose promise resolves on fire OR on interrupt() — used for
// backoff delays so a stop/shutdown wakes the loop instead of hanging it.
function interruptibleDelay(ms: number): {
  promise: Promise<void>;
  interrupt: () => void;
} {
  let id: ReturnType<typeof setTimeout>;
  let resolveFn: () => void = () => {};
  const promise = new Promise<void>((r) => {
    resolveFn = r;
    id = setTimeout(r, ms);
  });
  return {
    promise,
    interrupt: () => {
      clearTimeout(id);
      resolveFn();
    },
  };
}

// The full in-memory child, extending the public view with supervision bookkeeping.
interface InternalChild extends RunningChild {
  // The single supervision-loop promise for this child; awaited by stop/shutdown.
  supervision?: Promise<void>;
  supervising: boolean;
  // Set by stop(): suppress restart, drive to "stopped" on exit.
  stopRequested: boolean;
  // Consecutive spawn attempts for the CURRENT start (reset once running).
  startRetries: number;
  // The pending backoff delay, interrupted by stop/shutdown to wake the loop.
  pendingDelay?: { interrupt: () => void };
  // The current spawn's stdout+stderr drain, awaited after exit so no reader leaks.
  drainDone?: Promise<void>;
  // Outcome channel for the in-flight start()/init() caller.
  settle?: Deferred<Result<RunningChild>>;
  // Bounded ring of captured stdout/stderr lines (B4b). Preserved across a
  // crash/exit; cleared only on a fresh manual start (fresh run = fresh logs).
  logs: LogLine[];
}

// Default kernel entry: the open serve root, cli/main.ts, resolved off this
// module's URL (core/orchestrator/supervisor.ts → ../../cli/main.ts), so it works
// from anywhere. The orchestrator is open, so its children boot the open stack.
const KERNEL_ENTRY = fileURLToPath(
  new URL("../../cli/main.ts", import.meta.url),
);

// The permission flags the kernel task uses (deno.json `kernel`, `opentide`). Kept
// in lockstep so a spawned child has exactly the capabilities a kernel run has.
const KERNEL_DENO_FLAGS = [
  "--env",
  "--allow-net",
  "--allow-read",
  "--allow-write",
  "--allow-env",
  "--allow-ffi",
  "--allow-run",
  "--allow-sys",
];

// The default spawn seam: launch a real kernel child mirroring `deno task kernel`,
// resolved via the shared toolchain seam + the kernel entry. Piped stdio so the
// supervisor reads the ready line and drains logs.
export function defaultSpawn(opts: SpawnOptions): ChildHandle {
  const args = [
    "run",
    ...KERNEL_DENO_FLAGS,
    KERNEL_ENTRY,
    "--project",
    opts.projectPath,
    "--port",
    String(opts.controlPort),
    "--app-port",
    String(opts.appPort),
  ];
  if (opts.uiDist) args.push("--ui-dist", opts.uiDist);
  // The orchestrator root is not compiled today, so the running executable IS a
  // deno here. Resolved through the shared seam anyway: if it is ever bundled,
  // Deno.execPath() would silently become the bundle and this would spawn kernels
  // that re-exec themselves instead of failing. KERNEL_ENTRY has the same
  // exposure — a compiled build keeps cli/main.ts in a virtual filesystem — so
  // the start path would break loudly rather than subtly.
  const toolchain = resolveDenoToolchain();
  if (!toolchain.ok) {
    throw new Error(
      denoToolchainFailure(
        "Starting a kernel child needs a Deno toolchain",
        toolchain.error,
      ),
    );
  }
  const command = new Deno.Command(toolchain.data, {
    args,
    env: opts.env,
    stdout: "piped",
    stderr: "piped",
  });
  return command.spawn();
}

export class ProjectSupervisor implements Supervisor {
  private readonly children = new Map<string, InternalChild>();
  private readonly statePath: string;
  private readonly spawn: SpawnFn;
  private shuttingDown = false;

  // Resolved tunables (config defaults unless overridden for tests).
  private readonly portBase: number;
  private readonly portRange: number;
  private readonly readyTimeoutMs: number;
  private readonly stopTimeoutMs: number;
  private readonly maxStartRetries: number;
  private readonly maxRestarts: number;
  private readonly healthIntervalMs: number;
  private readonly healthMaxFailures: number;
  private readonly healthEnabled: boolean;
  private readonly backoffBaseMs: number;
  private readonly backoffCapMs: number;
  private readonly stabilityWindowMs: number;
  private readonly logBufferLines: number;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly uiDist: string | null;

  constructor(
    opts: {
      statePath?: string;
      spawn?: SpawnFn;
      config?: SupervisorConfig;
    } = {},
  ) {
    this.statePath = opts.statePath ?? getOrchestratorStatePath();
    this.spawn = opts.spawn ?? defaultSpawn;
    const c = opts.config ?? {};
    this.portBase = c.portBase ?? ORCHESTRATOR_CHILD_PORT_BASE;
    this.portRange = c.portRange ?? ORCHESTRATOR_CHILD_PORT_RANGE;
    this.readyTimeoutMs = c.readyTimeoutMs ?? ORCHESTRATOR_READY_TIMEOUT_MS;
    this.stopTimeoutMs = c.stopTimeoutMs ?? ORCHESTRATOR_STOP_TIMEOUT_MS;
    this.maxStartRetries = c.maxStartRetries ?? ORCHESTRATOR_MAX_START_RETRIES;
    this.maxRestarts = c.maxRestarts ?? ORCHESTRATOR_MAX_RESTARTS;
    this.healthIntervalMs = c.healthIntervalMs ??
      ORCHESTRATOR_HEALTH_INTERVAL_MS;
    this.healthMaxFailures = c.healthMaxFailures ??
      ORCHESTRATOR_HEALTH_MAX_FAILURES;
    this.healthEnabled = c.healthEnabled ?? true;
    this.backoffBaseMs = c.backoffBaseMs ?? ORCHESTRATOR_BACKOFF_BASE_MS;
    this.backoffCapMs = c.backoffCapMs ?? ORCHESTRATOR_BACKOFF_CAP_MS;
    this.stabilityWindowMs = c.stabilityWindowMs ??
      ORCHESTRATOR_STABILITY_WINDOW_MS;
    this.logBufferLines = c.logBufferLines ?? ORCHESTRATOR_LOG_BUFFER_LINES;
    this.now = c.now ?? Date.now;
    this.random = c.random ?? Math.random;
    this.uiDist = c.uiDist ?? null;
  }

  // --- Public API (§6.2) -----------------------------------------------------

  // Boot: re-read the state file and spawn every desiredState="running" child.
  async init(): Promise<void> {
    const state = readOrchestratorState(this.statePath);
    const starts: Promise<Result<RunningChild>>[] = [];
    for (const record of state.projects) {
      const entry = this.adopt(record);
      if (record.desiredState === "running") {
        starts.push(this.launch(entry));
      } else {
        entry.actualState = "stopped";
      }
    }
    // Await every boot spawn so init() resolves once the set has settled
    // (each launch resolves on running OR failed — never hangs).
    await Promise.all(starts);
  }

  // Set desiredState="running", persist, and spawn if not already up. Idempotent:
  // an already-running project returns its current view.
  async start(projectPath: string): Promise<Result<RunningChild>> {
    const abs = resolve(projectPath);
    let entry = this.children.get(abs);
    if (!entry) {
      entry = this.adopt({ projectPath: abs, desiredState: "running" });
    }
    entry.record.desiredState = "running";
    entry.stopRequested = false;

    if (entry.actualState === "running" && entry.process) {
      await this.persist();
      return { ok: true, data: this.toView(entry) };
    }
    // A manual start begins a fresh run — drop the previous run's captured tail so
    // the buffer reflects this run only (a crash tail was readable until now).
    entry.logs = [];
    return await this.launch(entry);
  }

  // Set desiredState="stopped", persist, SIGTERM + await exit (SIGKILL on
  // timeout). Idempotent: stopping an unknown or already-stopped project is a
  // no-op success.
  async stop(projectPath: string): Promise<Result<void>> {
    const abs = resolve(projectPath);
    const entry = this.children.get(abs);
    if (!entry) return { ok: true, data: undefined };

    entry.record.desiredState = "stopped";
    entry.stopRequested = true;
    // Wake a loop parked in a backoff delay so it re-checks stopRequested.
    entry.pendingDelay?.interrupt();
    await this.persist();

    if (!entry.process && !entry.supervising) {
      entry.actualState = "stopped";
      await this.persist();
      return { ok: true, data: undefined };
    }

    await this.terminate(entry);
    // Wait for the supervision loop to observe the exit and settle to "stopped".
    if (entry.supervision) await entry.supervision;
    return { ok: true, data: undefined };
  }

  // Manual restart (B4c): stop then start, reusing the existing verbs. Server-side
  // so a caller makes one call and avoids a client stop→poll→start race. A fresh
  // start() clears the log buffer (B4b), giving the new run its own tail.
  async restart(projectPath: string): Promise<Result<RunningChild>> {
    const stopped = await this.stop(projectPath);
    if (!stopped.ok) return stopped;
    return await this.start(projectPath);
  }

  async forgetStoppedProject(projectPath: string): Promise<boolean> {
    const abs = resolve(projectPath);
    const entry = this.children.get(abs);
    if (!entry) return false;
    if (
      entry.actualState !== "stopped" ||
      entry.record.desiredState !== "stopped" ||
      entry.process ||
      entry.supervising
    ) {
      return false;
    }
    this.children.delete(abs);
    await this.persist();
    return true;
  }

  list(): RunningChild[] {
    return [...this.children.values()].map((e) => this.toView(e));
  }

  get(projectPath: string): RunningChild | null {
    const entry = this.children.get(resolve(projectPath));
    return entry ? this.toView(entry) : null;
  }

  // The buffered stdout/stderr tail for a child (B4b). A copy so a caller can't
  // mutate the ring; empty for a path the supervisor never spawned. Independent of
  // actualState — the whole point is a crashed/failed/stopped child stays readable.
  logs(projectPath: string): LogLine[] {
    const entry = this.children.get(resolve(projectPath));
    return entry ? entry.logs.map((l) => ({ ...l })) : [];
  }

  // Orchestrator shutdown: SIGTERM every live child, await all exits (SIGKILL on
  // timeout), persist final state. desiredState is left UNTOUCHED so the next
  // boot re-spawns the running set (decision #5).
  async shutdownAll(): Promise<void> {
    this.shuttingDown = true;
    const live = [...this.children.values()].filter(
      (e) => e.process || e.supervising,
    );
    for (const entry of live) entry.pendingDelay?.interrupt();
    await Promise.all(live.map((e) => this.terminate(e)));
    await Promise.all(
      [...this.children.values()].map((e) => e.supervision).filter(Boolean),
    );
    await this.persist();
  }

  // --- Internals -------------------------------------------------------------

  // Register (or reuse) an in-memory child for a record without spawning.
  private adopt(record: OrchestratorProjectRecord): InternalChild {
    const existing = this.children.get(record.projectPath);
    if (existing) return existing;
    const entry: InternalChild = {
      record: { ...record },
      actualState: "stopped",
      restartCount: 0,
      supervising: false,
      stopRequested: false,
      startRetries: 0,
      logs: [],
    };
    this.children.set(record.projectPath, entry);
    return entry;
  }

  // Start (or restart) supervision for a child, returning a promise that resolves
  // once it reaches running (ok) or failed (error). Idempotent: if a loop is
  // already supervising, returns the in-flight settle (or the current view).
  private launch(entry: InternalChild): Promise<Result<RunningChild>> {
    if (entry.supervising) {
      if (entry.settle) return entry.settle.promise;
      return Promise.resolve({ ok: true as const, data: this.toView(entry) });
    }
    entry.settle = deferred<Result<RunningChild>>();
    entry.startRetries = 0;
    entry.supervising = true;
    entry.supervision = this.runSupervision(entry).finally(() => {
      entry.supervising = false;
    });
    return entry.settle.promise;
  }

  // The single supervision loop for a child: spawn → await ready → (running →
  // await exit) → decide retry/restart/stop/fail → loop. One process.status is
  // awaited per iteration; all timers are cleaned up before the next.
  private async runSupervision(entry: InternalChild): Promise<void> {
    while (true) {
      if (entry.stopRequested) {
        entry.actualState = "stopped";
        await this.persist();
        return;
      }
      if (this.shuttingDown) return;

      const port = await this.allocatePort(entry);
      if (port === null) {
        await this.settleFail(
          entry,
          "NO_FREE_PORT",
          "No free control port available",
        );
        return;
      }

      const process = this.spawnChild(entry, port);
      entry.process = process;
      entry.record.controlPort = port;
      entry.record.pid = process.pid;
      entry.record.lastStartedAt = new Date().toISOString();
      entry.startedAt = this.now();
      entry.actualState = "starting";

      const ready = await this.awaitReady(entry, process);

      if (ready.kind === "ready") {
        entry.actualState = "running";
        entry.lastReady = ready.line;
        entry.startRetries = 0;
        if (ready.line.appPort !== null) {
          entry.record.lastKnownAppPort = ready.line.appPort;
        }
        await this.persist();
        this.settleOk(entry);

        const status = await this.awaitExitWhileRunning(entry, process);
        this.recordExit(entry, status);
        entry.process = undefined;
        await entry.drainDone;

        if (entry.stopRequested) {
          entry.actualState = "stopped";
          await this.persist();
          return;
        }
        if (this.shuttingDown) return;
        if (entry.record.desiredState !== "running") {
          entry.actualState = "stopped";
          await this.persist();
          return;
        }
        // Unexpected exit while desired-running → crash restart with backoff.
        entry.actualState = "crashed";
        entry.restartCount++;
        await this.persist();
        if (entry.restartCount > this.maxRestarts) {
          entry.actualState = "failed";
          await this.persist();
          return;
        }
        await this.backoff(entry, entry.restartCount);
        continue;
      }

      // Not ready: exit-before-ready, stream-end, or timeout.
      if (ready.kind === "timeout") {
        await this.terminate(entry);
      }
      // A terminate/exit resolved process.status; make sure we've observed it.
      const status = await process.status;
      this.recordExit(entry, status);
      entry.process = undefined;
      await entry.drainDone;

      if (entry.stopRequested) {
        entry.actualState = "stopped";
        await this.persist();
        return;
      }
      if (this.shuttingDown) return;

      // Reallocate on the next iteration: drop the suspect port so a genuinely
      // taken port (AddrInUse non-zero exit) isn't retried in place.
      entry.record.controlPort = undefined;
      entry.startRetries++;
      if (entry.startRetries > this.maxStartRetries) {
        await this.settleFail(
          entry,
          "START_FAILED",
          `Child for ${entry.record.projectPath} failed to start after ${this.maxStartRetries} retries`,
        );
        return;
      }
      await this.backoff(entry, entry.startRetries);
      continue;
    }
  }

  private spawnChild(entry: InternalChild, port: number): ChildHandle {
    const env: Record<string, string> = {
      [OPENTIDE_ORCHESTRATED_ENV]: OPENTIDE_ORCHESTRATED_ON,
    };
    const dbUrl = readEnv(OPENTIDE_DB_URL_ENV);
    if (dbUrl) env[OPENTIDE_DB_URL_ENV] = dbUrl;
    return this.spawn({
      projectPath: entry.record.projectPath,
      controlPort: port,
      appPort: 0,
      uiDist: this.uiDist,
      env,
    });
  }

  // Await the child's ready line, racing against its exit and the ready timeout.
  // Drains stdout for the whole call so the pipe never blocks; the drain ends when
  // the stream closes (on exit) and is awaited so no reader leaks.
  private async awaitReady(
    entry: InternalChild,
    process: ChildHandle,
  ): Promise<
    | { kind: "ready"; line: ChildReadyLine }
    | { kind: "stream-end" }
    | { kind: "exit" }
    | { kind: "timeout" }
  > {
    const ready = deferred<ChildReadyLine | null>();
    let readySeen = false;
    // Background stdout drain: buffer every line (B4b) AND resolve the deferred on
    // the first ready line, then keep draining until the stream closes (so later
    // logs are captured and don't fill the pipe).
    const drainDone = this.drainLines(process.stdout, (line) => {
      this.appendLog(entry, "stdout", line);
      if (!readySeen) {
        const parsed = this.parseJson(line);
        if (parsed !== undefined && isChildReadyLine(parsed)) {
          readySeen = true;
          ready.resolve(parsed);
        }
      }
    }).then(() => {
      if (!readySeen) {
        readySeen = true;
        ready.resolve(null);
      }
    });
    // Drain stderr too: buffer each line (crash diagnostics, B4b) and keep the pipe
    // clear so a chatty child never blocks on a full stderr.
    const stderrDone = this.drainLines(process.stderr, (line) => {
      this.appendLog(entry, "stderr", line);
    });
    entry.drainDone = Promise.all([drainDone, stderrDone]).then(() => {});

    const timer = this.readyTimer();
    try {
      const outcome = await Promise.race([
        ready.promise.then((line) =>
          line
            ? { kind: "ready" as const, line }
            : { kind: "stream-end" as const }
        ),
        process.status.then(() => ({ kind: "exit" as const })),
        timer.promise.then(() => ({ kind: "timeout" as const })),
      ]);
      return outcome;
    } finally {
      timer.cancel();
    }
  }

  // Await the running child's exit while polling its health on an interval. A
  // process that stays alive but fails /api/status past the threshold is treated
  // as hung → SIGTERM (which resolves status → crash restart). Also arms the
  // stability-window timer that resets restartCount for a long-lived child.
  private async awaitExitWhileRunning(
    entry: InternalChild,
    process: ChildHandle,
  ): Promise<Deno.CommandStatus> {
    const stability = this.stabilityTimer(entry);
    let healthTimer: ReturnType<typeof setInterval> | undefined;
    let healthFailures = 0;
    if (this.healthEnabled) {
      healthTimer = setInterval(async () => {
        const ok = await this.pollHealth(entry);
        healthFailures = ok ? 0 : healthFailures + 1;
        if (healthFailures >= this.healthMaxFailures && entry.process) {
          entry.process.kill("SIGTERM");
        }
      }, this.healthIntervalMs);
    }
    try {
      return await process.status;
    } finally {
      if (healthTimer) clearInterval(healthTimer);
      stability.cancel();
    }
  }

  // GET /api/status on the child's control port. True on a 2xx, false otherwise
  // (network error or non-2xx). Best-effort; never throws.
  private async pollHealth(entry: InternalChild): Promise<boolean> {
    const port = entry.record.controlPort;
    if (!port) return false;
    try {
      const res = await fetch(`http://${DEV_SERVER_HOST}:${port}/api/status`);
      // Drain the body so the connection can be reused / closed cleanly.
      await res.body?.cancel();
      return res.ok;
    } catch {
      return false;
    }
  }

  // SIGTERM a child then escalate to SIGKILL if it doesn't exit within the stop
  // timeout. Awaits the exit so the caller knows the process is gone.
  private async terminate(entry: InternalChild): Promise<void> {
    const process = entry.process;
    if (!process) return;
    try {
      process.kill("SIGTERM");
    } catch {
      // Already exited between the check and the kill — nothing to do.
      return;
    }
    const timer = interruptibleDelay(this.stopTimeoutMs);
    const escalated = timer.promise.then(() => {
      try {
        process.kill("SIGKILL");
      } catch {
        // Exited before escalation — fine.
      }
    });
    await process.status;
    timer.interrupt();
    await escalated;
  }

  // --- Port allocation (§3.4) ------------------------------------------------

  // Pick a free control port: PREFER the child's persisted port (URL stability)
  // when free, else walk upward from the base skipping ports assigned to other
  // live children. Returns null if the whole range is exhausted. The definitive
  // arbiter remains the child (no control-server fallback → AddrInUse exit), so a
  // transient test-bind race is caught by the retry path.
  private async allocatePort(entry: InternalChild): Promise<number | null> {
    const inUse = this.inUsePorts(entry);
    const preferred = entry.record.controlPort;
    if (
      preferred && !inUse.has(preferred) && await this.isPortFree(preferred)
    ) {
      return preferred;
    }
    for (
      let port = this.portBase;
      port < this.portBase + this.portRange;
      port++
    ) {
      if (inUse.has(port)) continue;
      if (await this.isPortFree(port)) return port;
    }
    return null;
  }

  // Control ports currently held by OTHER live children (starting/running).
  private inUsePorts(self: InternalChild): Set<number> {
    const ports = new Set<number>();
    for (const entry of this.children.values()) {
      if (entry === self) continue;
      if (!entry.process) continue;
      if (entry.record.controlPort) ports.add(entry.record.controlPort);
    }
    return ports;
  }

  // Transient test-bind: a port is free if we can listen on it and immediately
  // close. Racy in theory, but the child's AddrInUse exit is the real arbiter.
  private async isPortFree(port: number): Promise<boolean> {
    try {
      const listener = Deno.listen({ hostname: DEV_SERVER_HOST, port });
      listener.close();
      // Yield so the OS releases the port before the child binds it.
      await Promise.resolve();
      return true;
    } catch {
      return false;
    }
  }

  // --- stdout/stderr draining ------------------------------------------------

  // Read a stream line-delimited (UTF-8), invoking onLine per non-empty line. Ends
  // when the stream closes. Used for BOTH stdout (ready-line match + log capture)
  // and stderr (log capture) — the caller decides what to do with each line.
  private async drainLines(
    stream: ReadableStream<Uint8Array>,
    onLine: (line: string) => void,
  ): Promise<void> {
    const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += value;
        let idx: number;
        while ((idx = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (line) onLine(line);
        }
      }
      const tail = buffer.trim();
      if (tail) onLine(tail);
    } catch {
      // Reader errored (child killed mid-read) — treat as stream end.
    } finally {
      reader.releaseLock();
    }
  }

  // Parse a line as JSON, or undefined for a human log line (not a protocol frame).
  private parseJson(line: string): unknown {
    try {
      return JSON.parse(line);
    } catch {
      return undefined;
    }
  }

  // Append a captured line to the child's bounded ring (B4b), dropping the oldest
  // lines once the cap is exceeded so a long-lived child can't grow memory forever.
  private appendLog(
    entry: InternalChild,
    stream: "stdout" | "stderr",
    text: string,
  ): void {
    entry.logs.push({ stream, text, at: new Date().toISOString() });
    const overflow = entry.logs.length - this.logBufferLines;
    if (overflow > 0) entry.logs.splice(0, overflow);
  }

  // --- timers, backoff, settle, persist --------------------------------------

  // The ready-line timeout. cancel() only clears the OS timer (no late resolve),
  // so a settled race never triggers a spurious "timeout" branch.
  private readyTimer(): { promise: Promise<void>; cancel: () => void } {
    let id: ReturnType<typeof setTimeout>;
    const promise = new Promise<void>((r) => {
      id = setTimeout(r, this.readyTimeoutMs);
    });
    return { promise, cancel: () => clearTimeout(id) };
  }

  // Reset restartCount once a child stays running past the stability window, so a
  // long-lived child that crashes much later gets a fresh restart budget.
  private stabilityTimer(entry: InternalChild): { cancel: () => void } {
    const id = setTimeout(() => {
      entry.restartCount = 0;
    }, this.stabilityWindowMs);
    return { cancel: () => clearTimeout(id) };
  }

  // Exponential backoff with jitter: min(cap, base * 2^(attempt-1)) ± jitter.
  // Interruptible so stop/shutdown wakes the loop instead of blocking for seconds.
  private async backoff(entry: InternalChild, attempt: number): Promise<void> {
    const raw = this.backoffBaseMs * Math.pow(2, Math.max(0, attempt - 1));
    const capped = Math.min(this.backoffCapMs, raw);
    const jitter = capped * 0.2 * this.random();
    const delay = interruptibleDelay(Math.round(capped - jitter));
    entry.pendingDelay = delay;
    try {
      await delay.promise;
    } finally {
      entry.pendingDelay = undefined;
    }
  }

  private settleOk(entry: InternalChild): void {
    entry.settle?.resolve({ ok: true, data: this.toView(entry) });
    entry.settle = undefined;
  }

  private async settleFail(
    entry: InternalChild,
    code: string,
    message: string,
  ): Promise<void> {
    entry.actualState = "failed";
    await this.persist();
    entry.settle?.resolve({ ok: false, error: { code, message } });
    entry.settle = undefined;
  }

  private recordExit(entry: InternalChild, status: Deno.CommandStatus): void {
    const exit: ChildExit = {
      code: status.code,
      signal: status.signal ?? null,
      at: new Date().toISOString(),
    };
    entry.record.lastExit = exit;
  }

  // A dashboard-facing snapshot: a shallow copy of the record plus the live
  // fields, so a caller can't mutate the supervisor's internal record in place.
  private toView(entry: InternalChild): RunningChild {
    return {
      record: { ...entry.record },
      actualState: entry.actualState,
      process: entry.process,
      startedAt: entry.startedAt,
      restartCount: entry.restartCount,
      lastReady: entry.lastReady,
    };
  }

  // Persist ONLY the reconstruct-only fields, with desiredState clamped to the
  // two persisted values. Never writes actualState or the live handle.
  private async persist(): Promise<void> {
    const state = emptyOrchestratorState();
    for (const entry of this.children.values()) {
      state.projects.push({ ...entry.record });
    }
    writeOrchestratorState(this.statePath, state);
    // Async signature for a future non-blocking writer; the write is sync today.
    await Promise.resolve();
  }
}
