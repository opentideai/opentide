// The TypeScript runtime with user code run in the project's runner instead of
// the kernel (executionMode "bridge"). Transpiling, packages, export, build and
// the language service are the in-process adapter's; only running code moves.
//
// What the kernel's registries hold for each entity is a stub: calling it syncs
// the mirror (./mirror.ts), then asks the runner to run the entity by name.
// Defining one transpiles it here and has the runner instantiate it once
// without keeping it, so a bad define still fails the define.
//
// The runner starts on first use and stops with dispose(). One that exits, stops
// answering pings, or is left running a script or test past its timeout is
// dropped, killed if need be; the next call starts a new one and the mirror
// brings it up to date in full. Calls in flight on the old one fail.

import {
  appPreviewOrigin,
  getKernelSettings,
  RUNNER_HEARTBEAT_INTERVAL_MS,
  RUNNER_REQUEST_TIMEOUT_MS,
  RUNNER_TIMEOUT_GRACE_MS,
} from "../config.ts";
import { transpileScript } from "../compiler.ts";
import type { Kernel } from "../registries.ts";
import type { RuntimeAdapter } from "../runtime.ts";
import { activeTrace, outsideTrace } from "../trace-context.ts";
import type {
  DevToolFn,
  DevViewFn,
  HandlerFn,
  KernelInspectAPI,
  LogLevel,
  Result,
  RuntimeScriptResult,
  TestFn,
} from "../types.ts";
import { appFetchHandler } from "./app-fetch.ts";
import { dbExecHandler } from "./db-service.ts";
import { SCRIPT_TIMEOUT_CODE, scriptTimeoutMessage } from "./instantiate.ts";
import {
  MirrorCache,
  rpcStateChannel,
  StateMirror,
  type UserCodeSource,
} from "./mirror.ts";
import { failure, type PeerOptions, type RequestHandler } from "./peer.ts";
import {
  type CallInvoke,
  decodeResponse,
  type DevViewInvoke,
  encodeRequest,
  type HandlerInvoke,
  type InvokeAnswer,
  type KernelInspectSnapshot,
  MIRROR_CATEGORIES,
  RUNNER_ERROR_CODES,
  RUNNER_LOG_SOURCES,
  RUNNER_METHODS,
  RUNNER_NOTIFICATIONS,
  type RunnerLogLine,
  type ScriptInvoke,
  type ThrownError,
} from "./protocol.ts";
import type { RunnerHost } from "./runner-host.ts";

// Starts a runner whose kernel end answers and hears what `peer` says.
// `RunnerHost.inMemory` is one; a spawn with the project's flags is another.
export type RunnerStart = (peer: PeerOptions) => Promise<Result<RunnerHost>>;

export interface RunnerRuntimeAdapter extends RuntimeAdapter {
  readonly bridge: RunnerBridge;
}

export function createRunnerRuntimeAdapter(
  kernel: Kernel,
  base: RuntimeAdapter,
  start: RunnerStart,
  options: RunnerBridgeOptions = {},
): RunnerRuntimeAdapter {
  const bridge = new RunnerBridge(kernel, start, options);
  return {
    ...base,
    capabilities: { ...base.capabilities, executionMode: "bridge" },
    bridge,
    compileHandler: (name, source) =>
      bridge.define(
        { category: MIRROR_CATEGORIES.handler, key: name, source },
        handlerStub(bridge, name),
      ),
    compileFunction: (name, source) =>
      bridge.define(
        { category: MIRROR_CATEGORIES.function, key: name, source },
        functionStub(bridge, name),
      ),
    compileTest: (name, source) =>
      bridge.define(
        { category: MIRROR_CATEGORIES.test, key: name, source },
        testStub(bridge, name),
      ),
    compileDevView: (name, source, _deps, kernelInspect) =>
      bridge.define(
        { category: MIRROR_CATEGORIES.devView, key: name, source },
        devViewStub(bridge, kernel, name, kernelInspect),
      ),
    compileDevTool: (name, source, args) =>
      bridge.define(
        { category: MIRROR_CATEGORIES.devTool, key: name, source, args },
        devToolStub(bridge, name),
      ),
    runScript: (source, _deps, timeoutMs, kernelLog) =>
      runScriptInRunner(bridge, source, timeoutMs, kernelLog !== undefined),
    dispose: () => bridge.stop(),
    abandon: (reason) => bridge.restart(reason),
  };
}

export function isRunnerRuntimeAdapter(
  adapter: RuntimeAdapter,
): adapter is RunnerRuntimeAdapter {
  return "bridge" in adapter;
}

interface Connection {
  host: RunnerHost;
  mirror: StateMirror;
  // False once the kernel has dropped this runner. Its calls back are refused
  // from then on, so a killed runner's last queries can't reach the database.
  alive: boolean;
  heartbeat?: ReturnType<typeof setTimeout>;
}

export interface RunnerBridgeOptions {
  heartbeatIntervalMs?: number;
  // How long a ping may go unanswered. Default: the longest any caller waits
  // for user code, so code a caller still waits for is never killed by it.
  pingTimeoutMs?: number;
}

// A call's answer, and when it was sent: the runner's event times count from
// then.
interface Sent<T> {
  answer: T;
  sentAt: number;
}

export class RunnerBridge {
  private connecting: Promise<Result<Connection>> | null = null;
  private live: Connection | null = null;
  private stopped = false;
  private readonly mirrorCache = new MirrorCache();
  // Read once, like the app server's handler timeout: the settings are a file.
  private readonly callTimeoutMs = callTimeout();
  private readonly heartbeatIntervalMs: number;
  private readonly pingTimeoutMs: number;

  constructor(
    private readonly kernel: Kernel,
    private readonly start: RunnerStart,
    options: RunnerBridgeOptions = {},
  ) {
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ??
      RUNNER_HEARTBEAT_INTERVAL_MS;
    this.pingTimeoutMs = options.pingTimeoutMs ?? this.callTimeoutMs;
  }

  // The kernel's mirror of this runner, once it's running.
  async mirror(): Promise<Result<StateMirror>> {
    const conn = await this.connection();
    return conn.ok ? { ok: true, data: conn.data.mirror } : conn;
  }

  // The running runner's host, if one is running.
  get host(): RunnerHost | null {
    return this.live?.host ?? null;
  }

  async define<T>(entity: UserCodeSource, stub: T): Promise<Result<T>> {
    const conn = await this.connection();
    if (!conn.ok) return conn;
    const checked = await conn.data.mirror.check(entity);
    return checked.ok ? { ok: true, data: stub } : checked;
  }

  // A call into user code, waited on as long as any caller would wait.
  call(method: string, params: unknown): Promise<Result<Sent<InvokeAnswer>>> {
    return this.invoke<InvokeAnswer>(method, params, this.callTimeoutMs);
  }

  // Brings the runner up to date with the registries, then makes one call.
  async invoke<T>(
    method: string,
    params: unknown,
    timeoutMs: number,
  ): Promise<Result<Sent<T>>> {
    const conn = await this.connection();
    if (!conn.ok) return conn;
    const synced = await conn.data.mirror.sync();
    if (!synced.ok) return synced;
    for (const failure of synced.data.failures) {
      this.kernel.log.log(
        "warn",
        "system",
        `${failure.category} "${failure.key}" won't run in the user-code runner: ${failure.error.message}`,
      );
    }
    const sentAt = performance.now();
    const answer = await conn.data.host.request<T>(method, params, timeoutMs);
    return answer.ok
      ? { ok: true, data: { answer: answer.data, sentAt } }
      : answer;
  }

  // Kills the running runner, if there is one. The next call starts another.
  async restart(reason: string): Promise<void> {
    const conn = await this.current();
    if (conn) await this.drop(conn, `was killed: ${reason}`);
  }

  // For good: no runner starts after this.
  async stop(): Promise<void> {
    this.stopped = true;
    const conn = await this.current();
    if (!conn) return;
    this.retire(conn);
    await conn.host.stop();
  }

  private async current(): Promise<Connection | null> {
    const conn = await this.connecting;
    return conn?.ok && conn.data.alive ? conn.data : null;
  }

  private async connection(): Promise<Result<Connection>> {
    if (this.stopped) {
      return failure(
        RUNNER_ERROR_CODES.closed,
        "The user-code runner is stopped.",
      );
    }
    // Gone before its exit was seen: a call made now would only fail.
    if (this.live?.host.closed) {
      await this.drop(this.live, "lost its connection");
    }
    // Outside any trace: the connection's read loops live as long as it does,
    // and would otherwise carry the trace of the request that started it.
    this.connecting ??= outsideTrace(() => this.connect());
    return await this.connecting;
  }

  private async connect(): Promise<Result<Connection>> {
    // Filled in once it's up: until then, its calls back are answered.
    const made: { conn?: Connection } = {};
    const host = await this.start(
      kernelEnd(this.kernel, () => made.conn?.alive ?? true),
    );
    if (!host.ok) {
      this.connecting = null;
      return host;
    }
    const started: Connection = {
      host: host.data,
      mirror: new StateMirror(
        this.kernel,
        rpcStateChannel(host.data),
        this.mirrorCache,
      ),
      alive: true,
    };
    made.conn = started;
    this.live = started;
    void host.data.exited.then(() => this.drop(started, "exited"));
    this.beat(started);
    return { ok: true, data: started };
  }

  // Pings the runner every interval; one that doesn't answer is dropped.
  private beat(conn: Connection): void {
    const timer = setTimeout(async () => {
      const pong = await conn.host.request(
        RUNNER_METHODS.ping,
        null,
        this.pingTimeoutMs,
      );
      if (pong.ok) {
        if (conn.alive) this.beat(conn);
      } else if (pong.error.code === RUNNER_ERROR_CODES.timeout) {
        await this.drop(
          conn,
          `stopped answering (no ping answer in ${this.pingTimeoutMs} ms)`,
        );
      }
    }, this.heartbeatIntervalMs);
    Deno.unrefTimer(timer);
    conn.heartbeat = timer;
  }

  // Gives up on a runner: kills it if it's still there, and says why.
  private async drop(conn: Connection, reason: string): Promise<void> {
    if (!conn.alive) return;
    this.retire(conn);
    const exit = await conn.host.kill();
    const status = `exit code ${exit.code}${
      exit.signal ? `, ${exit.signal}` : ""
    }`;
    const stderr = conn.host.stderrTail();
    this.kernel.log.log(
      "warn",
      "system",
      `The user-code runner ${reason} (${status}). The next call starts a new one.${
        stderr ? `\n${stderr}` : ""
      }`,
    );
  }

  private retire(conn: Connection): void {
    conn.alive = false;
    clearTimeout(conn.heartbeat);
    if (this.live === conn) {
      this.live = null;
      this.connecting = null;
    }
  }
}

// What the kernel's end of the connection answers and hears. Nothing more is
// answered once the runner is dropped.
function kernelEnd(kernel: Kernel, alive: () => boolean): PeerOptions {
  const whileAlive = (handler: RequestHandler): RequestHandler => (params) =>
    alive()
      ? handler(params)
      : failure(RUNNER_ERROR_CODES.closed, "This runner was dropped.");
  return {
    handlers: {
      [RUNNER_METHODS.dbExec]: whileAlive(dbExecHandler(kernel.db)),
      [RUNNER_METHODS.appFetch]: whileAlive(
        appFetchHandler(() => appPreviewOrigin(kernel.appPort)),
      ),
    },
    onNotification: (method, params) => {
      if (method === RUNNER_NOTIFICATIONS.log && isLogLine(params)) {
        kernel.log.log(params.level, params.source, params.message);
      }
    },
  };
}

// --- Stubs: what the registries hold ---

function handlerStub(bridge: RunnerBridge, name: string): HandlerFn {
  return async (req, ctx) => {
    const params: HandlerInvoke = {
      name,
      request: await encodeRequest(req),
      ctx,
    };
    return settle(
      await bridge.call(RUNNER_METHODS.invokeHandler, params),
    ) as Response;
  };
}

function functionStub(
  bridge: RunnerBridge,
  name: string,
): (...args: unknown[]) => Promise<unknown> {
  return async (...args) => {
    const params: CallInvoke = { name, args };
    return settle(
      await bridge.call(RUNNER_METHODS.invokeFunction, params),
    );
  };
}

function testStub(bridge: RunnerBridge, name: string): TestFn {
  return async () => {
    const params: CallInvoke = { name, args: [] };
    settle(
      await bridge.call(RUNNER_METHODS.invokeTest, params),
    );
  };
}

function devToolStub(bridge: RunnerBridge, name: string): DevToolFn {
  return async (...args) => {
    const params: CallInvoke = { name, args };
    return settle(
      await bridge.call(RUNNER_METHODS.invokeDevTool, params),
    );
  };
}

function devViewStub(
  bridge: RunnerBridge,
  kernel: Kernel,
  name: string,
  inspect: KernelInspectAPI,
): DevViewFn {
  return async (object) => {
    const params: DevViewInvoke = {
      name,
      object,
      inspect: await inspectSnapshot(kernel, inspect),
    };
    return settle(
      await bridge.call(RUNNER_METHODS.invokeDevView, params),
    ) as Awaited<ReturnType<DevViewFn>>;
  };
}

async function runScriptInRunner(
  bridge: RunnerBridge,
  source: string,
  timeoutMs = getKernelSettings().scriptTimeoutMs,
  logToKernel: boolean,
): Promise<RuntimeScriptResult> {
  const js = await transpileScript(source);
  if (!js.ok) return { ...js, logs: [] };
  // Each line reaches kernel.log, which is the only log any caller passes.
  const params: ScriptInvoke = { js: js.data, timeoutMs, logToKernel };
  const ran = await bridge.invoke<RuntimeScriptResult>(
    RUNNER_METHODS.invokeScript,
    params,
    timeoutMs + RUNNER_TIMEOUT_GRACE_MS,
  );
  // A script that ran past its timeout may still be running, and writing.
  const outran = "a script ran past its timeout";
  if (!ran.ok) {
    if (ran.error.code !== RUNNER_ERROR_CODES.timeout) {
      return { ...ran, logs: [] };
    }
    await bridge.restart(outran);
    return {
      ok: false,
      error: {
        code: SCRIPT_TIMEOUT_CODE,
        message: scriptTimeoutMessage(timeoutMs),
      },
      logs: [],
    };
  }
  const { answer } = ran.data;
  if (!answer.ok && answer.error.code === SCRIPT_TIMEOUT_CODE) {
    await bridge.restart(outran);
  }
  return answer;
}

// Ends a stub's call the way the user code ended: its value, its Response, or
// its error rethrown. The runner's trace events join the request's trace.
function settle(sent: Result<Sent<InvokeAnswer>>): unknown {
  if (!sent.ok) {
    throw new Error(`User-code runner: ${sent.error.message}`);
  }
  const { answer, sentAt } = sent.data;
  activeTrace()?.adopt(answer.events, sentAt);
  const { outcome } = answer;
  switch (outcome.kind) {
    case "value":
      return outcome.value;
    case "response":
      return decodeResponse(outcome.response);
    case "thrown":
      throw rethrown(outcome.error);
  }
}

function rethrown(thrown: ThrownError): unknown {
  // User code threw something that isn't an Error: throw its text.
  if (thrown.name === undefined) return thrown.message;
  const err = new Error(thrown.message);
  err.name = thrown.name;
  if (thrown.stack) err.stack = thrown.stack;
  return err;
}

// The longest any caller waits for user code, plus the usual request time.
// The callers' own timeouts fire first and answer; this only stops a stub
// waiting for ever on a runner that never answers.
function callTimeout(): number {
  const s = getKernelSettings();
  return Math.max(s.handlerTimeoutMs, s.testTimeoutMs, s.scriptTimeoutMs) +
    RUNNER_REQUEST_TIMEOUT_MS;
}

async function inspectSnapshot(
  kernel: Kernel,
  inspect: KernelInspectAPI,
): Promise<KernelInspectSnapshot> {
  const devViews = inspect.listDevViews();
  return {
    routes: inspect.listRoutes(),
    handlers: inspect.listHandlers(),
    functions: inspect.listFunctions(),
    configs: inspect.listConfigs(),
    schemas: await inspect.listSchemas(),
    types: inspect.listTypes(),
    devViews,
    assets: Object.fromEntries(
      kernel.assets.list().map((
        a,
      ) => [a.name, inspect.getAssetContent(a.name)]),
    ),
    devViewSources: Object.fromEntries(
      devViews.flatMap((v) => {
        const source = inspect.getDevViewSource(v.name);
        return source === null ? [] : [[v.name, source]];
      }),
    ),
  };
}

const LOG_LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];

// The runner isn't trusted to send a well-formed line.
function isLogLine(params: unknown): params is RunnerLogLine {
  if (typeof params !== "object" || params === null) return false;
  const p = params as Record<string, unknown>;
  return typeof p.message === "string" &&
    LOG_LEVELS.includes(p.level as LogLevel) &&
    (RUNNER_LOG_SOURCES as readonly unknown[]).includes(p.source);
}
