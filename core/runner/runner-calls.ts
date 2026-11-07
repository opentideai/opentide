// The runner's answers to the invoke methods: run one piece of user code from
// ./runner-state.ts and say how it ended. Each call runs in its own trace
// context, and its events go back with the answer for the kernel to merge
// into the request's trace.
//
// Whatever user code returns or throws has to cross back as data. A Response
// is sent whole (./protocol.ts refuses event streams); a value has to survive
// the codec, or the call fails saying which part didn't; a thrown error keeps
// its name, message and stack but not its class.

import { TraceContext } from "../trace-context.ts";
import type { CompileLog, HandlerContext, LogLevel } from "../types.ts";
import { errorMessage } from "../util.ts";
import { formatLogArgs, runScriptJs } from "./instantiate.ts";
import { runCall, type RunnerCall } from "./call-context.ts";
import type { RequestHandler } from "./peer.ts";
import {
  type CallInvoke,
  decodeRequest,
  type DevViewInvoke,
  encodeResponse,
  encodeValue,
  type HandlerInvoke,
  type InvokeAnswer,
  type InvokeOutcome,
  RUNNER_ERROR_CODES,
  RUNNER_METHODS,
  type RunnerLogLine,
  type ScriptInvoke,
  type ThrownError,
} from "./protocol.ts";
import type { RunnerState } from "./runner-state.ts";

export type LogSink = (line: RunnerLogLine) => void;

export function callHandlers(
  state: RunnerState,
  sink: LogSink,
): Record<string, RequestHandler> {
  return {
    [RUNNER_METHODS.invokeHandler]: (params) => {
      const p = params as HandlerInvoke;
      if (!isNamed(p)) return badParams(RUNNER_METHODS.invokeHandler);
      const fn = state.handler(p.name);
      return answer({}, async () => {
        if (!fn) return notLoaded("Handler", p.name);
        return await outcomeOf(
          await fn(decodeRequest(p.request), p.ctx as HandlerContext),
        );
      });
    },
    [RUNNER_METHODS.invokeFunction]: (params) => {
      const p = params as CallInvoke;
      if (!isCall(p)) return badParams(RUNNER_METHODS.invokeFunction);
      const fn = state.function(p.name);
      return answer({}, async () => {
        if (!fn) return notLoaded("Function", p.name);
        return await outcomeOf(await fn(...p.args));
      });
    },
    [RUNNER_METHODS.invokeTest]: (params) => {
      const p = params as CallInvoke;
      if (!isNamed(p)) return badParams(RUNNER_METHODS.invokeTest);
      const fn = state.test(p.name);
      return answer({}, async () => {
        if (!fn) return notLoaded("Test", p.name);
        return await outcomeOf(await fn());
      });
    },
    [RUNNER_METHODS.invokeDevTool]: (params) => {
      const p = params as CallInvoke;
      if (!isCall(p)) return badParams(RUNNER_METHODS.invokeDevTool);
      const fn = state.devTool(p.name);
      return answer({}, async () => {
        if (!fn) return notLoaded("Dev tool", p.name);
        return await outcomeOf(await fn(...p.args));
      });
    },
    [RUNNER_METHODS.invokeDevView]: (params) => {
      const p = params as DevViewInvoke;
      if (!isNamed(p)) return badParams(RUNNER_METHODS.invokeDevView);
      const fn = state.devView(p.name);
      return answer({ inspect: p.inspect }, async () => {
        if (!fn) return notLoaded("Dev view", p.name);
        return await outcomeOf(await fn(p.object));
      });
    },
    [RUNNER_METHODS.invokeScript]: async (params) => {
      const p = params as ScriptInvoke;
      if (typeof p?.js !== "string" || typeof p.timeoutMs !== "number") {
        return badParams(RUNNER_METHODS.invokeScript);
      }
      const result = await runScriptJs(
        p.js,
        state.deps,
        p.timeoutMs,
        (level, message) => {
          if (p.logToKernel) sink({ source: "script", level, message });
        },
      );
      if (!result.ok) return { ok: true, data: result };
      const output = encodeValue(result.output);
      return {
        ok: true,
        data: output.ok ? result : {
          ok: false,
          error: unreturnable(output.error.message),
          logs: result.logs,
        },
      };
    },
  };
}

// User code's log(): each line goes to the kernel's log as it's logged.
export function forwardingLog(sink: LogSink): CompileLog {
  const at = (level: LogLevel) => (...args: unknown[]) =>
    sink({ source: "app", level, message: formatLogArgs(args) });
  return Object.assign(at("info"), {
    debug: at("debug"),
    info: at("info"),
    warn: at("warn"),
    error: at("error"),
  });
}

async function answer(
  call: Omit<RunnerCall, "trace">,
  run: () => Promise<InvokeOutcome>,
) {
  const trace = new TraceContext();
  const startedAt = performance.now();
  const outcome = await runCall({ ...call, trace }, async () => {
    try {
      return await run();
    } catch (err) {
      return thrown(err);
    }
  });
  const data: InvokeAnswer = { outcome, events: trace.relativeTo(startedAt) };
  return { ok: true as const, data };
}

async function outcomeOf(value: unknown): Promise<InvokeOutcome> {
  if (value instanceof Response) {
    const response = await encodeResponse(value);
    return response.ok
      ? { kind: "response", response: response.data }
      : thrown(new Error(response.error.message));
  }
  const encoded = encodeValue(value);
  return encoded.ok
    ? { kind: "value", value }
    : thrown(new Error(unreturnable(encoded.error.message).message));
}

function unreturnable(detail: string) {
  return {
    code: RUNNER_ERROR_CODES.unserializable,
    message:
      `User code returned a value that can't leave the runner: ${detail}`,
  };
}

// A thrown non-Error (`throw "nope"`) has no name, and the kernel rethrows it
// as the bare value's text.
function thrown(err: unknown): InvokeOutcome {
  const error: ThrownError = err instanceof Error
    ? { name: err.name, message: err.message, stack: err.stack }
    : { message: errorMessage(err) };
  return { kind: "thrown", error };
}

function notLoaded(label: string, name: string): InvokeOutcome {
  return thrown(
    new Error(
      `${label} "${name}" isn't loaded in the user-code runner (${RUNNER_ERROR_CODES.notLoaded}).`,
    ),
  );
}

function isNamed(p: unknown): p is { name: string } {
  return typeof p === "object" && p !== null &&
    typeof (p as { name?: unknown }).name === "string";
}

function isCall(p: unknown): p is CallInvoke {
  return isNamed(p) && Array.isArray((p as { args?: unknown }).args);
}

function badParams(method: string) {
  return {
    ok: false as const,
    error: {
      code: RUNNER_ERROR_CODES.invalidParams,
      message: `${method} got params of the wrong shape`,
    },
  };
}
