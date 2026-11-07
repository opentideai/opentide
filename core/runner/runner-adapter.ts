// The TypeScript runtime with user code run in the project's runner instead of
// the kernel (executionMode "bridge"). Transpiling, packages, export, build and
// the language service are the in-process adapter's; only running code moves.
//
// What the kernel's registries hold for each entity is a stub: calling it syncs
// the mirror (./mirror.ts), then asks the runner to run the entity by name.
// Defining one transpiles it here and has the runner instantiate it once
// without keeping it, so a bad define still fails the define.
//
// The runner starts on first use. Starting it with the project, restarting it
// and stopping it with the project is the lifecycle slice's job.

import {
  appPreviewOrigin,
  getKernelSettings,
  RUNNER_REQUEST_TIMEOUT_MS,
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
import { rpcStateChannel, StateMirror, type UserCodeSource } from "./mirror.ts";
import type { PeerOptions } from "./peer.ts";
import {
  type CallInvoke,
  decodeResponse,
  type DevViewInvoke,
  encodeRequest,
  type HandlerInvoke,
  type InvokeAnswer,
  type KernelInspectSnapshot,
  MIRROR_CATEGORIES,
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
): RunnerRuntimeAdapter {
  const bridge = new RunnerBridge(kernel, start);
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
}

// A call's answer, and when it was sent: the runner's event times count from
// then.
interface Sent<T> {
  answer: T;
  sentAt: number;
}

export class RunnerBridge {
  private connecting: Promise<Result<Connection>> | null = null;
  // Read once, like the app server's handler timeout: the settings are a file.
  private readonly callTimeoutMs = callTimeout();

  constructor(
    private readonly kernel: Kernel,
    private readonly start: RunnerStart,
  ) {}

  // The kernel's mirror of this runner, once it's running.
  async mirror(): Promise<Result<StateMirror>> {
    const conn = await this.connection();
    return conn.ok ? { ok: true, data: conn.data.mirror } : conn;
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

  async stop(): Promise<void> {
    const conn = await this.connecting;
    this.connecting = null;
    if (conn?.ok) await conn.data.host.stop();
  }

  private connection(): Promise<Result<Connection>> {
    // Outside any trace: the connection's read loops live as long as it does,
    // and would otherwise carry the trace of the request that started it.
    this.connecting ??= outsideTrace(() => this.connect());
    return this.connecting;
  }

  private async connect(): Promise<Result<Connection>> {
    const host = await this.start(kernelEnd(this.kernel));
    if (!host.ok) {
      this.connecting = null;
      return host;
    }
    return {
      ok: true,
      data: {
        host: host.data,
        mirror: new StateMirror(this.kernel, rpcStateChannel(host.data)),
      },
    };
  }
}

// What the kernel's end of the connection answers and hears.
function kernelEnd(kernel: Kernel): PeerOptions {
  return {
    handlers: {
      [RUNNER_METHODS.dbExec]: dbExecHandler(kernel.db),
      [RUNNER_METHODS.appFetch]: appFetchHandler(() =>
        appPreviewOrigin(kernel.appPort)
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
    timeoutMs + RUNNER_REQUEST_TIMEOUT_MS,
  );
  return ran.ok ? ran.data.answer : { ...ran, logs: [] };
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
