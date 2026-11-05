import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  type RunnerExit,
  RunnerHost,
  type RunnerProcess,
  type SpawnFn,
} from "./runner-host.ts";
import {
  RUNNER_ERROR_CODES,
  RUNNER_METHODS,
  RUNNER_NOTIFICATIONS,
  RUNNER_PROTOCOL_VERSION,
} from "./protocol.ts";
import { RpcPeer } from "./peer.ts";
import { createStreamTransport, type RunnerTransport } from "./transport.ts";
import { serveRunner } from "./runner.ts";

const SPEC = { command: "deno", args: [], env: {}, cwd: "/" };
const SHORT_MS = 50;

interface FakeRunner {
  transport: RunnerTransport;
  exit(code: number, signal?: string): void;
  stderr(text: string): void;
}

// A process whose runner side is the given function, wired over real streams.
function fakeSpawn(
  behave: (runner: FakeRunner) => void,
): { spawn: SpawnFn; kills: string[] } {
  const kills: string[] = [];
  const spawn: SpawnFn = () => {
    const stdin = new TransformStream<Uint8Array, Uint8Array>();
    const stdout = new TransformStream<Uint8Array, Uint8Array>();
    const stderr = new TransformStream<Uint8Array, Uint8Array>();
    const errWriter = stderr.writable.getWriter();
    const transport = createStreamTransport(stdin.readable, stdout.writable);
    let markExit: (exit: RunnerExit) => void = () => {};
    const status = new Promise<RunnerExit>((r) => (markExit = r));
    let exited = false;
    const exit = (code: number, signal: string | null = null) => {
      if (exited) return;
      exited = true;
      void transport.close();
      void errWriter.close();
      markExit({ code, signal });
    };
    const process: RunnerProcess = {
      pid: 4242,
      stdin: stdin.writable,
      stdout: stdout.readable,
      stderr: stderr.readable,
      status,
      kill(signal) {
        kills.push(signal);
        exit(137, signal);
      },
    };
    behave({
      transport,
      exit,
      stderr: (text) => void errWriter.write(new TextEncoder().encode(text)),
    });
    return process;
  };
  return { spawn, kills };
}

// The real runner side, exiting when asked to.
function realRunner(runner: FakeRunner): void {
  void serveRunner(runner.transport, { onShutdown: () => runner.exit(0) });
}

Deno.test("spawn waits for ready, answers a ping and stops cleanly", async () => {
  const { spawn, kills } = fakeSpawn(realRunner);
  const started = await RunnerHost.spawn({ spec: SPEC, spawn });
  assert(started.ok, JSON.stringify(started));
  const host = started.data;
  assertEquals(host.ready.protocolVersion, RUNNER_PROTOCOL_VERSION);
  assertEquals(await host.request(RUNNER_METHODS.ping, null), {
    ok: true,
    data: { protocolVersion: RUNNER_PROTOCOL_VERSION },
  });
  assertEquals(await host.stop(), { code: 0, signal: null });
  assertEquals(await host.stop(), { code: 0, signal: null });
  assertEquals(kills, []);
});

Deno.test("a runner that dies before ready fails start, with its stderr", async () => {
  const { spawn } = fakeSpawn((runner) => {
    runner.stderr("error: Module not found runner-main.ts");
    setTimeout(() => runner.exit(1), 5);
  });
  const started = await RunnerHost.spawn({ spec: SPEC, spawn });
  assert(!started.ok);
  assertEquals(started.error.code, RUNNER_ERROR_CODES.startFailed);
  assertStringIncludes(started.error.message, "exited before it was ready");
  assertStringIncludes(started.error.message, "Module not found");
});

Deno.test("a runner that never says ready is killed at the timeout", async () => {
  const { spawn, kills } = fakeSpawn(() => {});
  const started = await RunnerHost.spawn({
    spec: SPEC,
    spawn,
    readyTimeoutMs: SHORT_MS,
  });
  assert(!started.ok);
  assertEquals(started.error.code, RUNNER_ERROR_CODES.startFailed);
  assertEquals(kills, ["SIGKILL"]);
});

Deno.test("a runner on another protocol version is refused and killed", async () => {
  const { spawn, kills } = fakeSpawn((runner) => {
    const peer = new RpcPeer(runner.transport);
    void peer.notify(RUNNER_NOTIFICATIONS.ready, {
      protocolVersion: RUNNER_PROTOCOL_VERSION + 1,
      pid: 1,
      denoVersion: "x",
    });
  });
  const started = await RunnerHost.spawn({ spec: SPEC, spawn });
  assert(!started.ok);
  assertEquals(started.error.code, RUNNER_ERROR_CODES.protocolMismatch);
  assertEquals(kills, ["SIGKILL"]);
});

Deno.test("a runner that ignores shutdown is killed after the grace period", async () => {
  const { spawn, kills } = fakeSpawn((runner) => {
    void serveRunner(runner.transport, { onShutdown: () => {} });
  });
  const started = await RunnerHost.spawn({ spec: SPEC, spawn });
  assert(started.ok);
  const exit = await started.data.stop();
  assertEquals(exit.signal, "SIGKILL");
  assertEquals(kills, ["SIGKILL"]);
});

Deno.test("a crash fails the calls in flight", async () => {
  let crash = () => {};
  const { spawn } = fakeSpawn((runner) => {
    crash = () => runner.exit(1);
    void new RpcPeer(runner.transport, {
      handlers: { [RUNNER_METHODS.ping]: () => new Promise(() => {}) },
    }).notify(RUNNER_NOTIFICATIONS.ready, {
      protocolVersion: RUNNER_PROTOCOL_VERSION,
      pid: 1,
      denoVersion: "x",
    });
  });
  const started = await RunnerHost.spawn({ spec: SPEC, spawn });
  assert(started.ok);
  const inFlight = started.data.request(RUNNER_METHODS.ping, null);
  crash();
  const result = await inFlight;
  assert(!result.ok);
  assertEquals(result.error.code, RUNNER_ERROR_CODES.closed);
  assertEquals((await started.data.exited).code, 1);
});

Deno.test("the in-memory runner answers and stops", async () => {
  const started = await RunnerHost.inMemory();
  assert(started.ok);
  const ping = await started.data.request(RUNNER_METHODS.ping, null);
  assert(ping.ok);
  assertEquals((await started.data.stop()).code, 0);
});
