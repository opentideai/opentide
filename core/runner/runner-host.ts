// The kernel's side of a project's runner: spawns it, waits for it to say it is
// ready, sends it requests and stops it. The spawn is injected, so tests drive
// a fake process and kernels with no project dir run the runner in-process over
// the memory transport.

import type { Result } from "../types.ts";
import {
  RUNNER_READY_TIMEOUT_MS,
  RUNNER_REQUEST_TIMEOUT_MS,
  RUNNER_SHUTDOWN_GRACE_MS,
  RUNNER_STDERR_TAIL_BYTES,
} from "../config.ts";
import {
  RUNNER_ERROR_CODES,
  RUNNER_METHODS,
  RUNNER_NOTIFICATIONS,
  RUNNER_PROTOCOL_VERSION,
  type RunnerReady,
} from "./protocol.ts";
import { failure, RpcPeer } from "./peer.ts";
import {
  createMemoryTransportPair,
  createStreamTransport,
} from "./transport.ts";
import { serveRunner } from "./runner.ts";

export interface RunnerExit {
  code: number;
  signal: string | null;
}

export interface RunnerProcess {
  pid: number;
  stdin: WritableStream<Uint8Array>;
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  status: Promise<RunnerExit>;
  kill(signal: Deno.Signal): void;
}

export interface RunnerSpawnSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
}

export type SpawnFn = (spec: RunnerSpawnSpec) => RunnerProcess;

export interface SpawnRunnerOptions {
  spec: RunnerSpawnSpec;
  spawn?: SpawnFn;
  readyTimeoutMs?: number;
  onStderr?: (text: string) => void;
}

// clearEnv: the runner sees only the env the spec names, never the kernel's.
export const denoSpawn: SpawnFn = (spec) => {
  const child = new Deno.Command(spec.command, {
    args: spec.args,
    env: spec.env,
    cwd: spec.cwd,
    clearEnv: true,
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  return {
    pid: child.pid,
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr,
    status: child.status.then((s) => ({ code: s.code, signal: s.signal })),
    kill(signal) {
      try {
        child.kill(signal);
      } catch (err) {
        // Only an already-exited child is fine to ignore.
        if (!(err instanceof TypeError)) throw err;
      }
    },
  };
};

// runner-main.ts as a file on disk. A compiled build has none; the lifecycle
// slice writes a bundled copy out instead.
export function runnerScriptPath(): string {
  return new URL("./runner-main.ts", import.meta.url).pathname;
}

// OpenTide's own deno.json, which the runner is pinned to via --config.
export function openTideConfigPath(): string {
  return new URL("../../deno.json", import.meta.url).pathname;
}

// Deno's cache dirs (DENO_DIR and the npm cache), as `deno info` reports them.
export async function denoCacheDirs(
  denoPath: string,
): Promise<Result<{ denoDir: string; npmCache: string }>> {
  const out = await new Deno.Command(denoPath, {
    args: ["info", "--json"],
    stdout: "piped",
    stderr: "piped",
  }).output();
  const info = out.success
    ? JSON.parse(new TextDecoder().decode(out.stdout)) as Record<
      string,
      unknown
    >
    : {};
  if (typeof info.denoDir !== "string" || typeof info.npmCache !== "string") {
    return failure(
      RUNNER_ERROR_CODES.startFailed,
      `deno info --json named no cache dirs: ${
        new TextDecoder().decode(out.stderr).trim()
      }`,
    );
  }
  return { ok: true, data: { denoDir: info.denoDir, npmCache: info.npmCache } };
}

interface Channel {
  stop(peer: RpcPeer): Promise<RunnerExit>;
  exited: Promise<RunnerExit>;
}

export class RunnerHost {
  private stopping: Promise<RunnerExit> | null = null;

  private constructor(
    private readonly peer: RpcPeer,
    private readonly channel: Channel,
    readonly ready: RunnerReady,
    private readonly stderr: StderrTail,
  ) {}

  get exited(): Promise<RunnerExit> {
    return this.channel.exited;
  }

  static async spawn(
    options: SpawnRunnerOptions,
  ): Promise<Result<RunnerHost>> {
    const child = (options.spawn ?? denoSpawn)(options.spec);
    const stderr = new StderrTail(child.stderr, options.onStderr);
    const announced = readyLatch();
    const peer = new RpcPeer(
      createStreamTransport(child.stdout, child.stdin),
      { onNotification: announced.onNotification },
    );
    const channel: Channel = {
      exited: child.status,
      async stop(p) {
        const grace = setTimeout(
          () => child.kill("SIGKILL"),
          RUNNER_SHUTDOWN_GRACE_MS,
        );
        await p.request(
          RUNNER_METHODS.shutdown,
          null,
          RUNNER_SHUTDOWN_GRACE_MS,
        );
        const exit = await child.status;
        clearTimeout(grace);
        await p.close();
        await stderr.done;
        return exit;
      },
    };
    const ready = await waitForReady(
      announced.ready,
      child.status,
      options.readyTimeoutMs ?? RUNNER_READY_TIMEOUT_MS,
    );
    if (!ready.ok) {
      child.kill("SIGKILL");
      await child.status;
      await peer.close();
      await stderr.done;
      const tail = stderr.text();
      return failure(
        ready.error.code,
        tail ? `${ready.error.message}\n${tail}` : ready.error.message,
      );
    }
    return {
      ok: true,
      data: new RunnerHost(peer, channel, ready.data, stderr),
    };
  }

  // The runner served in this process. No boundary: for tests and kernels
  // with no project dir.
  static async inMemory(): Promise<Result<RunnerHost>> {
    const [kernelEnd, runnerEnd] = createMemoryTransportPair();
    const announced = readyLatch();
    const peer = new RpcPeer(kernelEnd, {
      onNotification: announced.onNotification,
    });
    let markExited: (exit: RunnerExit) => void = () => {};
    const exited = new Promise<RunnerExit>((r) => (markExited = r));
    const runner = await serveRunner(runnerEnd, {
      onShutdown: () => {
        void runnerEnd.close().then(() =>
          markExited({ code: 0, signal: null })
        );
      },
    });
    const channel: Channel = {
      exited,
      async stop(p) {
        await p.request(
          RUNNER_METHODS.shutdown,
          null,
          RUNNER_SHUTDOWN_GRACE_MS,
        );
        const exit = await exited;
        await p.close();
        await runner.done;
        return exit;
      },
    };
    const ready = await waitForReady(
      announced.ready,
      exited,
      RUNNER_READY_TIMEOUT_MS,
    );
    if (!ready.ok) return ready;
    return {
      ok: true,
      data: new RunnerHost(peer, channel, ready.data, StderrTail.none()),
    };
  }

  request<T>(
    method: string,
    params: unknown,
    timeoutMs: number = RUNNER_REQUEST_TIMEOUT_MS,
  ): Promise<Result<T>> {
    return this.peer.request<T>(method, params, timeoutMs);
  }

  // Asks the runner to exit, kills it if it hasn't within the grace period.
  // Safe to call more than once.
  stop(): Promise<RunnerExit> {
    this.stopping ??= this.channel.stop(this.peer);
    return this.stopping;
  }

  stderrTail(): string {
    return this.stderr.text();
  }
}

function readyLatch(): {
  ready: Promise<unknown>;
  onNotification: (method: string, params: unknown) => void;
} {
  let resolve: (params: unknown) => void = () => {};
  const ready = new Promise<unknown>((r) => (resolve = r));
  return {
    ready,
    onNotification(method, params) {
      if (method === RUNNER_NOTIFICATIONS.ready) resolve(params);
    },
  };
}

async function waitForReady(
  announced: Promise<unknown>,
  exited: Promise<RunnerExit>,
  timeoutMs: number,
): Promise<Result<RunnerReady>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const outcome = await Promise.race([
    announced.then((params) => ({ kind: "ready" as const, params })),
    exited.then((exit) => ({ kind: "exited" as const, exit })),
    new Promise<{ kind: "timeout" }>((r) => {
      timer = setTimeout(() => r({ kind: "timeout" }), timeoutMs);
    }),
  ]);
  clearTimeout(timer);
  switch (outcome.kind) {
    case "timeout":
      return failure(
        RUNNER_ERROR_CODES.startFailed,
        `The runner did not say it was ready within ${timeoutMs} ms.`,
      );
    case "exited":
      return failure(
        RUNNER_ERROR_CODES.startFailed,
        `The runner exited before it was ready (code ${outcome.exit.code}).`,
      );
    case "ready":
      return checkReady(outcome.params);
  }
}

function checkReady(params: unknown): Result<RunnerReady> {
  const ready = params as Partial<RunnerReady> | null;
  if (ready?.protocolVersion !== RUNNER_PROTOCOL_VERSION) {
    return failure(
      RUNNER_ERROR_CODES.protocolMismatch,
      `The runner speaks protocol ${ready?.protocolVersion}, the kernel ${RUNNER_PROTOCOL_VERSION}.`,
    );
  }
  return { ok: true, data: ready as RunnerReady };
}

// Drains the runner's stderr, which it must do or a chatty runner blocks on a
// full pipe, and keeps the last few KB for error messages.
class StderrTail {
  private tail = "";
  readonly done: Promise<void>;

  constructor(
    stream: ReadableStream<Uint8Array> | null,
    onText?: (text: string) => void,
  ) {
    this.done = stream ? this.drain(stream, onText) : Promise.resolve();
  }

  static none(): StderrTail {
    return new StderrTail(null);
  }

  text(): string {
    return this.tail.trim();
  }

  private async drain(
    stream: ReadableStream<Uint8Array>,
    onText?: (text: string) => void,
  ): Promise<void> {
    const decoder = new TextDecoder();
    for await (const chunk of stream) {
      const text = decoder.decode(chunk, { stream: true });
      onText?.(text);
      this.tail = (this.tail + text).slice(-RUNNER_STDERR_TAIL_BYTES);
    }
  }
}
