import { assert, assertEquals, assertExists } from "@std/assert";
import { fileURLToPath } from "node:url";
import { rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { formatReadyLine } from "./handshake.ts";
import {
  type ChildHandle,
  ProjectSupervisor,
  type SpawnFn,
  type SpawnOptions,
  type SupervisorConfig,
} from "./supervisor.ts";
import { readOrchestratorState } from "./state.ts";

// --- test doubles ----------------------------------------------------------

// How a fake child should behave for one spawn.
interface FakeSpec {
  // Emit a valid ready line on stdout (child reaches "running").
  emitReady?: boolean;
  // If set, resolve status (simulated crash) this many ms after emitting ready.
  crashAfterReadyMs?: number;
  // Exit code used for a crash / immediate-exit fake (default 3).
  exitCode?: number;
  // Stay alive with no output until killed (drives the ready-timeout path).
  neverExit?: boolean;
  // Extra human (non-JSON) lines to emit on stdout after the ready line (B4b log
  // capture): the buffer must retain these alongside the ready frame.
  stdoutLines?: string[];
  // Lines to emit on stderr (B4b): crash diagnostics the buffer must retain.
  stderrLines?: string[];
}

// An in-memory ChildHandle: full control over stdout, exit, and kill, with zero
// subprocesses — deterministic for the state-machine tests.
class FakeChild implements ChildHandle {
  readonly pid: number;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly status: Promise<Deno.CommandStatus>;
  readonly killSignals: Deno.Signal[] = [];
  private stdoutCtl!: ReadableStreamDefaultController<Uint8Array>;
  private resolveStatus!: (s: Deno.CommandStatus) => void;
  private settled = false;
  private readonly timers: ReturnType<typeof setTimeout>[] = [];

  constructor(pid: number, spec: FakeSpec, port: number, project: string) {
    this.pid = pid;
    const enc = new TextEncoder();
    this.stdout = new ReadableStream<Uint8Array>({
      start: (c) => (this.stdoutCtl = c),
    });
    // stderr enqueues its lines up front then closes (B4b log-capture path). An
    // empty stderrLines closes immediately, as before.
    this.stderr = new ReadableStream<Uint8Array>({
      start: (c) => {
        for (const line of spec.stderrLines ?? []) {
          c.enqueue(enc.encode(line + "\n"));
        }
        c.close();
      },
    });
    this.status = new Promise((r) => (this.resolveStatus = r));

    if (spec.emitReady) {
      this.stdoutCtl.enqueue(
        enc.encode(
          formatReadyLine({
            genie: "ready",
            controlPort: port,
            appPort: null,
            pid,
            project,
          }),
        ),
      );
    }
    // Extra human stdout lines (non-JSON) the buffer must capture alongside the
    // frame — emitted before any exit so the controller is still open.
    for (const line of spec.stdoutLines ?? []) {
      this.stdoutCtl.enqueue(enc.encode(line + "\n"));
    }

    if (spec.emitReady) {
      if (spec.crashAfterReadyMs !== undefined) {
        this.timers.push(
          setTimeout(
            () => this.exit(spec.exitCode ?? 1, null),
            spec.crashAfterReadyMs,
          ),
        );
      }
      // else: stay alive until killed
    } else if (!spec.neverExit) {
      // Exit before ready (early failure / AddrInUse analog).
      this.exit(spec.exitCode ?? 3, null);
    }
    // neverExit && !emitReady → silent until kill (ready-timeout path)
  }

  private exit(code: number, signal: Deno.Signal | null): void {
    if (this.settled) return;
    this.settled = true;
    for (const t of this.timers) clearTimeout(t);
    try {
      this.stdoutCtl.close();
    } catch {
      // already closed
    }
    this.resolveStatus({ success: code === 0, code, signal });
  }

  kill(signo?: Deno.Signal): void {
    const signal = signo ?? "SIGTERM";
    this.killSignals.push(signal);
    this.exit(128 + (signal === "SIGKILL" ? 9 : 15), signal);
  }
}

interface FakeSpawn {
  fn: SpawnFn;
  calls: SpawnOptions[];
  children: FakeChild[];
}

// A SpawnFn backed by FakeChild. `specs` is either a per-call list (last entry
// repeats) or a function of the call index.
function fakeSpawn(
  specs: FakeSpec[] | ((call: number) => FakeSpec),
): FakeSpawn {
  const calls: SpawnOptions[] = [];
  const children: FakeChild[] = [];
  let n = 0;
  const fn: SpawnFn = (opts) => {
    calls.push(opts);
    const spec = typeof specs === "function"
      ? specs(n)
      : specs[Math.min(n, specs.length - 1)] ?? {};
    const child = new FakeChild(
      9000 + n,
      spec,
      opts.controlPort,
      opts.projectPath,
    );
    children.push(child);
    n++;
    return child;
  };
  return { fn, calls, children };
}

// A real-subprocess SpawnFn that runs a fixture script (exercises the true stdout
// pipe + line parser + SIGTERM path without booting a kernel).
function fixtureSpawn(script: string): SpawnFn {
  const path = fileURLToPath(new URL(`./fixtures/${script}`, import.meta.url));
  return (opts) => {
    const command = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        path,
        "--project",
        opts.projectPath,
        "--port",
        String(opts.controlPort),
        "--app-port",
        String(opts.appPort),
      ],
      env: opts.env,
      stdout: "piped",
      stderr: "piped",
    });
    return command.spawn();
  };
}

async function withTempState(
  fn: (statePath: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({
    dir: "/private/tmp",
    prefix: "orchestrator-sup-",
  });
  try {
    await fn(join(dir, "orchestrator.json"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function waitFor(
  cond: () => boolean,
  timeoutMs = 3000,
): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor: condition not met within timeout");
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

// Fast, network-free defaults for the deterministic in-memory tests.
const FAST: SupervisorConfig = {
  healthEnabled: false,
  portBase: 41000,
  readyTimeoutMs: 60,
  stopTimeoutMs: 300,
  backoffBaseMs: 5,
  backoffCapMs: 20,
  stabilityWindowMs: 10_000,
  maxStartRetries: 1,
  maxRestarts: 2,
};

const PROJECT_A = "/tmp/fake-project-a";
const PROJECT_B = "/tmp/fake-project-b";

// --- tests -----------------------------------------------------------------

Deno.test("init re-spawns only desiredState=running children", async () => {
  await withTempState(async (statePath) => {
    writeFileSync(
      statePath,
      JSON.stringify({
        version: 1,
        projects: [
          { projectPath: PROJECT_A, desiredState: "running" },
          { projectPath: PROJECT_B, desiredState: "stopped" },
        ],
      }),
    );
    const spawn = fakeSpawn([{ emitReady: true }]);
    const sup = new ProjectSupervisor({
      statePath,
      spawn: spawn.fn,
      config: FAST,
    });
    try {
      await sup.init();
      assertEquals(spawn.calls.length, 1);
      assertEquals(spawn.calls[0]?.projectPath, PROJECT_A);
      assertEquals(sup.get(PROJECT_A)?.actualState, "running");
      assertEquals(sup.get(PROJECT_B)?.actualState, "stopped");
    } finally {
      await sup.shutdownAll();
    }
  });
});

Deno.test("forgetStoppedProject removes a fully stopped child and persists", async () => {
  await withTempState(async (statePath) => {
    writeFileSync(
      statePath,
      JSON.stringify({
        version: 1,
        projects: [{ projectPath: PROJECT_B, desiredState: "stopped" }],
      }),
    );
    const spawn = fakeSpawn([{ emitReady: true }]);
    const sup = new ProjectSupervisor({
      statePath,
      spawn: spawn.fn,
      config: FAST,
    });
    await sup.init();

    assertEquals(sup.get(PROJECT_B)?.actualState, "stopped");
    assertEquals(await sup.forgetStoppedProject(PROJECT_B), true);
    assertEquals(sup.get(PROJECT_B), null);
    assertEquals(readOrchestratorState(statePath).projects, []);
    assertEquals(await sup.forgetStoppedProject("/tmp/not-known"), false);
  });
});

Deno.test("start is idempotent and persists desiredState=running", async () => {
  await withTempState(async (statePath) => {
    const spawn = fakeSpawn([{ emitReady: true }]);
    const sup = new ProjectSupervisor({
      statePath,
      spawn: spawn.fn,
      config: FAST,
    });
    try {
      const first = await sup.start(PROJECT_A);
      assertEquals(first.ok, true);
      const second = await sup.start(PROJECT_A);
      assertEquals(second.ok, true);
      // Second start did not spawn a new child.
      assertEquals(spawn.calls.length, 1);

      const state = readOrchestratorState(statePath);
      const record = state.projects.find((p) => p.projectPath === PROJECT_A);
      assertEquals(record?.desiredState, "running");
      assertExists(record?.controlPort);
    } finally {
      await sup.shutdownAll();
    }
  });
});

Deno.test("ready line drives starting→running with a real child (handshake)", async () => {
  await withTempState(async (statePath) => {
    const sup = new ProjectSupervisor({
      statePath,
      spawn: fixtureSpawn("fake-child-ready.ts"),
      config: { ...FAST, readyTimeoutMs: 5000 },
    });
    try {
      const result = await sup.start(PROJECT_A);
      assertEquals(result.ok, true);
      const child = sup.get(PROJECT_A);
      assertEquals(child?.actualState, "running");
      // The parsed ready line confirms the assigned control port.
      assertEquals(
        child?.lastReady?.controlPort,
        child?.record.controlPort,
      );
    } finally {
      await sup.shutdownAll();
    }
  });
});

Deno.test("early exit before ready retries then fails (real crash fixture)", async () => {
  await withTempState(async (statePath) => {
    const sup = new ProjectSupervisor({
      statePath,
      spawn: fixtureSpawn("fake-child-crash.ts"),
      config: { ...FAST, maxStartRetries: 1, readyTimeoutMs: 3000 },
    });
    const result = await sup.start(PROJECT_A);
    assertEquals(result.ok, false);
    if (!result.ok) assertEquals(result.error.code, "START_FAILED");
    assertEquals(sup.get(PROJECT_A)?.actualState, "failed");
  });
});

Deno.test("ready timeout retries then fails", async () => {
  await withTempState(async (statePath) => {
    const spawn = fakeSpawn([{ neverExit: true }]);
    const sup = new ProjectSupervisor({
      statePath,
      spawn: spawn.fn,
      config: { ...FAST, readyTimeoutMs: 30, maxStartRetries: 1 },
    });
    const result = await sup.start(PROJECT_A);
    assertEquals(result.ok, false);
    assertEquals(sup.get(PROJECT_A)?.actualState, "failed");
    // initial attempt + one retry = two spawns, each SIGTERM'd on timeout.
    assertEquals(spawn.calls.length, 2);
    for (const child of spawn.children) {
      assertEquals(child.killSignals.includes("SIGTERM"), true);
    }
  });
});

Deno.test("stop SIGTERMs a running child and flips it to stopped", async () => {
  await withTempState(async (statePath) => {
    const spawn = fakeSpawn([{ emitReady: true }]);
    const sup = new ProjectSupervisor({
      statePath,
      spawn: spawn.fn,
      config: FAST,
    });
    await sup.start(PROJECT_A);
    assertEquals(sup.get(PROJECT_A)?.actualState, "running");

    const stopped = await sup.stop(PROJECT_A);
    assertEquals(stopped.ok, true);
    assertEquals(sup.get(PROJECT_A)?.actualState, "stopped");
    assertEquals(sup.get(PROJECT_A)?.process, undefined);
    assertEquals(spawn.children[0]?.killSignals.includes("SIGTERM"), true);

    // Persisted desiredState is stopped.
    const state = readOrchestratorState(statePath);
    assertEquals(
      state.projects.find((p) => p.projectPath === PROJECT_A)?.desiredState,
      "stopped",
    );

    // Idempotent: stopping again, or an unknown project, is a no-op success.
    assertEquals((await sup.stop(PROJECT_A)).ok, true);
    assertEquals((await sup.stop("/tmp/never-known")).ok, true);
  });
});

Deno.test("port allocation skips in-use and OS-occupied ports", async () => {
  await withTempState(async (statePath) => {
    const spawn = fakeSpawn([{ emitReady: true }]);
    const sup = new ProjectSupervisor({
      statePath,
      spawn: spawn.fn,
      config: FAST,
    });
    try {
      await sup.start(PROJECT_A);
      await sup.start(PROJECT_B);
      // B skips A's in-memory-held port.
      assertEquals(sup.get(PROJECT_A)?.record.controlPort, 41000);
      assertEquals(sup.get(PROJECT_B)?.record.controlPort, 41001);

      // Occupy the next port at the OS level; the allocator must skip it too.
      const blocker = Deno.listen({ hostname: "127.0.0.1", port: 41002 });
      try {
        await sup.start("/tmp/fake-project-c");
        assertEquals(sup.get("/tmp/fake-project-c")?.record.controlPort, 41003);
      } finally {
        blocker.close();
      }
    } finally {
      await sup.shutdownAll();
    }
  });
});

Deno.test("crash with desiredState=running schedules a backoff restart", async () => {
  await withTempState(async (statePath) => {
    // First spawn: ready then crash after 10ms. Second spawn: ready and stays up.
    const spawn = fakeSpawn((call) =>
      call === 0
        ? { emitReady: true, crashAfterReadyMs: 10, exitCode: 1 }
        : { emitReady: true }
    );
    const sup = new ProjectSupervisor({
      statePath,
      spawn: spawn.fn,
      config: FAST,
    });
    try {
      await sup.start(PROJECT_A);
      // The crash triggers a backoff restart; wait for the second spawn to land.
      await waitFor(() =>
        spawn.calls.length === 2 &&
        sup.get(PROJECT_A)?.actualState === "running"
      );
      assertEquals(sup.get(PROJECT_A)?.restartCount, 1);
    } finally {
      await sup.shutdownAll();
    }
  });
});

Deno.test("crash restart gives up after maxRestarts then fails", async () => {
  await withTempState(async (statePath) => {
    // Every spawn reaches running then crashes → exhausts the restart budget.
    const spawn = fakeSpawn([{
      emitReady: true,
      crashAfterReadyMs: 5,
      exitCode: 1,
    }]);
    const sup = new ProjectSupervisor({
      statePath,
      spawn: spawn.fn,
      config: { ...FAST, maxRestarts: 2 },
    });
    await sup.start(PROJECT_A);
    await waitFor(() => sup.get(PROJECT_A)?.actualState === "failed");
    // initial + 2 restarts = 3 spawns.
    assertEquals(spawn.calls.length, 3);
  });
});

Deno.test("shutdownAll kills every child and persists desiredState untouched", async () => {
  await withTempState(async (statePath) => {
    const spawn = fakeSpawn([{ emitReady: true }]);
    const sup = new ProjectSupervisor({
      statePath,
      spawn: spawn.fn,
      config: FAST,
    });
    await sup.start(PROJECT_A);
    await sup.start(PROJECT_B);

    await sup.shutdownAll();

    for (const child of spawn.children) {
      assertEquals(child.killSignals.includes("SIGTERM"), true);
    }
    // desiredState is left as running so the next boot re-spawns the set.
    const state = readOrchestratorState(statePath);
    assertEquals(
      state.projects.map((p) => p.desiredState).sort(),
      ["running", "running"],
    );
    assertEquals(state.projects.length, 2);
  });
});

// --- B4b: per-child log capture -------------------------------------------

Deno.test("logs buffer captures stdout and stderr lines tagged by stream", async () => {
  await withTempState(async (statePath) => {
    const spawn = fakeSpawn([{
      emitReady: true,
      stdoutLines: ["hello from stdout"],
      stderrLines: ["warn: something", "error: boom"],
    }]);
    const sup = new ProjectSupervisor({
      statePath,
      spawn: spawn.fn,
      config: FAST,
    });
    try {
      await sup.start(PROJECT_A);
      // Wait until the stderr diagnostics and the human stdout line are captured.
      await waitFor(() =>
        sup.logs(PROJECT_A).some((l) => l.text === "error: boom") &&
        sup.logs(PROJECT_A).some((l) => l.text === "hello from stdout")
      );
      const lines = sup.logs(PROJECT_A);
      const stdout = lines.filter((l) => l.stream === "stdout").map((l) =>
        l.text
      );
      const stderr = lines.filter((l) => l.stream === "stderr").map((l) =>
        l.text
      );
      // The ready frame (JSON) is captured on stdout too, alongside the human line.
      assert(stdout.includes("hello from stdout"));
      assertEquals(stderr, ["warn: something", "error: boom"]);
      // Every line carries an observation timestamp.
      for (const l of lines) assert(l.at.length > 0);
    } finally {
      await sup.shutdownAll();
    }
  });
});

Deno.test("logs buffer caps at logBufferLines, dropping the oldest", async () => {
  await withTempState(async (statePath) => {
    const stdoutLines = Array.from({ length: 10 }, (_, i) => `line ${i}`);
    const spawn = fakeSpawn([{ emitReady: true, stdoutLines }]);
    const sup = new ProjectSupervisor({
      statePath,
      spawn: spawn.fn,
      config: { ...FAST, logBufferLines: 3 },
    });
    try {
      await sup.start(PROJECT_A);
      // Once the last line lands, nothing else is emitted so the ring is stable.
      await waitFor(() => sup.logs(PROJECT_A).some((l) => l.text === "line 9"));
      const texts = sup.logs(PROJECT_A).map((l) => l.text);
      assertEquals(texts.length, 3);
      // Only the newest 3 survive; the ready frame + earlier lines were dropped.
      assertEquals(texts, ["line 7", "line 8", "line 9"]);
    } finally {
      await sup.shutdownAll();
    }
  });
});

Deno.test("logs buffer survives a crash (readable while failed)", async () => {
  await withTempState(async (statePath) => {
    // Reach ready, emit a stderr diagnostic, then crash with no restart budget.
    const spawn = fakeSpawn([{
      emitReady: true,
      crashAfterReadyMs: 5,
      exitCode: 7,
      stderrLines: ["fatal: kaboom"],
    }]);
    const sup = new ProjectSupervisor({
      statePath,
      spawn: spawn.fn,
      config: { ...FAST, maxRestarts: 0 },
    });
    try {
      await sup.start(PROJECT_A);
      await waitFor(() => sup.get(PROJECT_A)?.actualState === "failed");
      // The crash tail is still readable after the child is gone.
      const stderr = sup.logs(PROJECT_A).filter((l) => l.stream === "stderr");
      assertEquals(stderr.map((l) => l.text), ["fatal: kaboom"]);
    } finally {
      await sup.shutdownAll();
    }
  });
});

Deno.test("a manual start clears the previous run's log buffer", async () => {
  await withTempState(async (statePath) => {
    const spawn = fakeSpawn((call) =>
      call === 0
        ? { emitReady: true, stdoutLines: ["first run log"] }
        : { emitReady: true, stdoutLines: ["second run log"] }
    );
    const sup = new ProjectSupervisor({
      statePath,
      spawn: spawn.fn,
      config: FAST,
    });
    try {
      await sup.start(PROJECT_A);
      await waitFor(() =>
        sup.logs(PROJECT_A).some((l) => l.text === "first run log")
      );
      await sup.stop(PROJECT_A);
      // Logs from the first run stay readable while stopped.
      assert(sup.logs(PROJECT_A).some((l) => l.text === "first run log"));

      await sup.start(PROJECT_A);
      await waitFor(() =>
        sup.logs(PROJECT_A).some((l) => l.text === "second run log")
      );
      // The fresh start dropped the first run's lines.
      const texts = sup.logs(PROJECT_A).map((l) => l.text);
      assert(!texts.includes("first run log"));
    } finally {
      await sup.shutdownAll();
    }
  });
});

// --- B4c: manual restart ---------------------------------------------------

Deno.test("restart calls stop then start (in order), leaving the child running", async () => {
  await withTempState(async (statePath) => {
    const spawn = fakeSpawn([{ emitReady: true }]);
    const sup = new ProjectSupervisor({
      statePath,
      spawn: spawn.fn,
      config: FAST,
    });
    try {
      await sup.start(PROJECT_A);
      assertEquals(spawn.calls.length, 1);

      // Spy on the two verbs restart delegates to, recording call order.
      const order: string[] = [];
      const realStop = sup.stop.bind(sup);
      const realStart = sup.start.bind(sup);
      sup.stop = (p: string) => {
        order.push("stop");
        return realStop(p);
      };
      sup.start = (p: string) => {
        order.push("start");
        return realStart(p);
      };

      const res = await sup.restart(PROJECT_A);
      assertEquals(res.ok, true);
      // restart = stop then start, and it reuses the verbs (a second spawn ran).
      assertEquals(order, ["stop", "start"]);
      assertEquals(spawn.calls.length, 2);
      assertEquals(sup.get(PROJECT_A)?.actualState, "running");
      // The first child was SIGTERM'd (the stop half); the second is fresh.
      assertEquals(spawn.children[0]?.killSignals.includes("SIGTERM"), true);
      assertEquals(spawn.children[1]?.killSignals.length, 0);
    } finally {
      await sup.shutdownAll();
    }
  });
});

Deno.test("start resolves the absolute path so lookups are stable", async () => {
  await withTempState(async (statePath) => {
    const spawn = fakeSpawn([{ emitReady: true }]);
    const sup = new ProjectSupervisor({
      statePath,
      spawn: spawn.fn,
      config: FAST,
    });
    try {
      await sup.start(PROJECT_A);
      // get() with the same path (already absolute here) resolves identically.
      assertExists(sup.get(resolve(PROJECT_A)));
    } finally {
      await sup.shutdownAll();
    }
  });
});
