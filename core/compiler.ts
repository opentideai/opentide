import * as esbuild from "esbuild";
import * as ts from "typescript";
import type {
  CompileDeps,
  DevToolArgDef,
  DevToolFn,
  DevViewFn,
  HandlerFn,
  KernelInspectAPI,
  Result,
  TestFn,
} from "./types.ts";
import { AssertionError } from "./types.ts";
import type { LegacyHandlerFn } from "./handler-abi.ts";
import { detectHandlerAbi, wrapLegacyContextHandler } from "./handler-abi.ts";
import type { KernelLog } from "./registries.ts";
import { errorMessage } from "./util.ts";
import {
  ENTITY_SCOPE_NAMES,
  type EntityScopeName,
  TEST_SCOPE_NAMES,
  type TestScopeName,
} from "./reserved-names.ts";

let warmedUp = false;
let childProcessPatched = false;

async function patchChildProcessUnref(): Promise<void> {
  if (childProcessPatched) return;
  childProcessPatched = true;
  const childProcess = await import("node:child_process");
  type ChildProcessModule = {
    ChildProcess?: {
      prototype?: {
        unref?: (this: unknown) => unknown;
      };
    };
  };
  const proto = (childProcess as ChildProcessModule).ChildProcess?.prototype;
  const original = proto?.unref;
  if (!proto || typeof original !== "function") return;
  proto.unref = function () {
    try {
      return original.call(this);
    } catch {
      // Deno compiled binaries can throw from the Node child_process shim here.
      return this;
    }
  };
}

interface TransformOptions {
  sourcemap?: "inline";
  sourcefile?: string;
}

export function isEsbuildServiceFailure(err: unknown): boolean {
  const message = errorMessage(err);
  return message.includes("Cannot read properties of undefined") ||
    message.includes("The service is no longer running") ||
    message.includes("The service was stopped") ||
    (message.includes("spawn ") && message.includes("ENOENT")) ||
    message.includes("spawn failed");
}

async function transformTypeScript(
  source: string,
  options: TransformOptions = {},
): Promise<string> {
  try {
    const result = await esbuild.transform(source, {
      loader: "ts",
      target: "esnext",
      sourcemap: options.sourcemap,
      sourcefile: options.sourcefile,
    });
    return result.code;
  } catch (err) {
    if (!isEsbuildServiceFailure(err)) throw err;
    const result = ts.transpileModule(source, {
      fileName: options.sourcefile,
      compilerOptions: {
        target: ts.ScriptTarget.ESNext,
        module: ts.ModuleKind.ESNext,
        inlineSourceMap: options.sourcemap === "inline",
        inlineSources: options.sourcemap === "inline",
      },
    });
    return result.outputText;
  }
}

export async function initCompiler(): Promise<void> {
  if (warmedUp) return;
  await patchChildProcessUnref();
  // Warm up esbuild by running a no-op transform (auto-starts the service)
  await transformTypeScript("");
  warmedUp = true;
}

export function stopCompiler(): void {
  if (!warmedUp) return;
  try {
    esbuild.stop();
  } catch {
    // Ignore — esbuild may already be stopped
  }
  warmedUp = false;
}

// Runtime implementation of the `assertNever` exhaustiveness guard injected
// into handler/function/test/script scope. Mirrors the exported deps.ts helper.
function runtimeAssertNever(x: never): never {
  throw new Error(`Unexpected value: ${JSON.stringify(x)}`);
}

export async function compileHandler(
  name: string,
  source: string,
  deps: CompileDeps,
): Promise<Result<HandlerFn>> {
  const result = await compile<HandlerFn>(name, source, deps, "handler");
  if (!result.ok) return result;
  // The single place a live handler is produced, and therefore the single place
  // the legacy-ABI shim has to be applied (core/handler-abi.ts). Handlers that
  // are re-registered from an existing entry carry an already-wrapped function
  // and never come back through here, so the wrap cannot be applied twice.
  if (detectHandlerAbi(source, name) === "legacy-context") {
    return {
      ok: true,
      data: wrapLegacyContextHandler(
        result.data as unknown as LegacyHandlerFn,
      ),
    };
  }
  return result;
}

export async function compileFunction(
  name: string,
  source: string,
  deps: CompileDeps,
): Promise<Result<(...args: unknown[]) => unknown>> {
  return compile(name, source, deps, "function");
}

export async function compileTest(
  name: string,
  source: string,
  deps: CompileDeps,
): Promise<Result<TestFn>> {
  let jsCode: string;
  try {
    jsCode = await transformTypeScript(source);
  } catch (err) {
    return {
      ok: false,
      error: {
        code: "COMPILATION_ERROR",
        message: errorMessage(err),
        suggestion: "Fix the TypeScript syntax in the test source.",
      },
    };
  }

  try {
    const sourceURL = `//# sourceURL=opentide://tests/${name}.ts`;
    // See compile(): the names are core/reserved-names.ts's, so they are reserved.
    const scope: Record<TestScopeName, unknown> = {
      db: deps.db,
      functions: deps.functions,
      config: deps.config,
      templates: deps.templates,
      packages: deps.packages,
      env: deps.env,
      log: deps.log,
      assertNever: runtimeAssertNever,
      getAppPort: deps.getAppPort,
      appUrl: deps.appUrl,
      assert: testAssert,
      assertEquals: testAssertEquals,
      assertNotEquals: testAssertNotEquals,
      assertThrows: testAssertThrows,
      assertRejects: testAssertRejects,
    };
    const factory = new Function(
      ...TEST_SCOPE_NAMES,
      `"use strict";\n${jsCode}\nreturn ${name};\n${sourceURL}`,
    );
    const fn = factory(...TEST_SCOPE_NAMES.map((binding) => scope[binding]));
    if (typeof fn !== "function") {
      return {
        ok: false,
        error: {
          code: "NOT_A_FUNCTION",
          message: `Test source must define a function named "${name}".`,
          suggestion: `async function ${name}() { assertEquals(1 + 1, 2); }`,
        },
      };
    }
    return { ok: true, data: fn as TestFn };
  } catch (err) {
    return {
      ok: false,
      error: {
        code: "RUNTIME_ERROR",
        message: `Failed to instantiate test "${name}": ${errorMessage(err)}`,
      },
    };
  }
}

function testAssert(condition: unknown, message?: string): void {
  if (!condition) {
    throw new AssertionError(message ?? "Assertion failed: value is falsy");
  }
}

function testAssertEquals(
  actual: unknown,
  expected: unknown,
  message?: string,
): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new AssertionError(message ?? `Expected ${e}, got ${a}`);
}

function testAssertNotEquals(
  actual: unknown,
  expected: unknown,
  message?: string,
): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    throw new AssertionError(
      message ?? `Expected values to differ, but both are ${a}`,
    );
  }
}

function testAssertThrows(fn: () => unknown, message?: string): void {
  try {
    fn();
  } catch {
    return;
  }
  throw new AssertionError(
    message ?? "Expected function to throw, but it did not",
  );
}

async function testAssertRejects(
  fn: () => Promise<unknown>,
  message?: string,
): Promise<void> {
  try {
    await fn();
  } catch {
    return;
  }
  throw new AssertionError(
    message ?? "Expected function to reject, but it did not",
  );
}

export interface ScriptResult {
  ok: true;
  output: unknown;
  logs: string[];
  durationMs: number;
}

export interface ScriptError {
  ok: false;
  error: { code: string; message: string; suggestion?: string };
  logs: string[];
}

import { getKernelSettings } from "./config.ts";

export async function runScript(
  source: string,
  deps: CompileDeps,
  timeoutMs = getKernelSettings().scriptTimeoutMs,
  kernelLog?: KernelLog,
): Promise<ScriptResult | ScriptError> {
  let jsCode: string;
  try {
    const wrapped = `(async () => {\n${source}\n})()`;
    jsCode = await transformTypeScript(wrapped);
  } catch (err) {
    return {
      ok: false,
      error: {
        code: "COMPILATION_ERROR",
        message: errorMessage(err),
        suggestion: "Fix the TypeScript syntax and try again.",
      },
      logs: [],
    };
  }

  const logs: string[] = [];
  const formatArgs = (...args: unknown[]) =>
    args.map((a) => typeof a === "string" ? a : JSON.stringify(a)).join(" ");
  const log = Object.assign(
    (...args: unknown[]) => {
      const msg = formatArgs(...args);
      logs.push(msg);
      kernelLog?.log("debug", "script", msg);
    },
    {
      debug: (...args: unknown[]) => {
        const msg = formatArgs(...args);
        logs.push(msg);
        kernelLog?.log("debug", "script", msg);
      },
      info: (...args: unknown[]) => {
        const msg = formatArgs(...args);
        logs.push(msg);
        kernelLog?.log("info", "script", msg);
      },
      warn: (...args: unknown[]) => {
        const msg = formatArgs(...args);
        logs.push(msg);
        kernelLog?.log("warn", "script", msg);
      },
      error: (...args: unknown[]) => {
        const msg = formatArgs(...args);
        logs.push(msg);
        kernelLog?.log("error", "script", msg);
      },
    },
  );

  let scriptTimerId: ReturnType<typeof setTimeout>;
  try {
    const factory = new Function(
      "db",
      "functions",
      "config",
      "templates",
      "packages",
      "env",
      "log",
      "assertNever",
      `"use strict";\nreturn ${jsCode}\n//# sourceURL=opentide://scripts/inline.ts`,
    );
    const timeout = new Promise<never>((_, reject) => {
      scriptTimerId = setTimeout(
        () => reject(new Error(`Script timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
    });
    const start = performance.now();
    // LIMITATION: in-process scripts cannot be forcibly cancelled. On timeout
    // the race rejects with TIMEOUT and we stop awaiting, but the script keeps
    // running to completion and may still mutate the DB. A late rejection is
    // not a hazard — Promise.race attaches a reaction to this promise, so it
    // never surfaces as an unhandledrejection. Forcibly killing a runaway
    // script would require executing it in a terminable Worker (see H8b).
    const output = await Promise.race([
      Promise.resolve(
        factory(
          deps.db,
          deps.functions,
          deps.config,
          deps.templates,
          deps.packages,
          deps.env,
          log,
          runtimeAssertNever,
        ),
      ),
      timeout,
    ]);
    clearTimeout(scriptTimerId!);
    return {
      ok: true,
      output: output === undefined ? null : output,
      logs,
      durationMs: Math.round(performance.now() - start),
    };
  } catch (err) {
    clearTimeout(scriptTimerId!);
    const message = errorMessage(err);
    return {
      ok: false,
      error: {
        code: message.includes("timed out") ? "TIMEOUT" : "RUNTIME_ERROR",
        message,
      },
      logs,
    };
  }
}

export async function compileDevView(
  name: string,
  source: string,
  deps: CompileDeps,
  kernelInspect: KernelInspectAPI,
): Promise<Result<DevViewFn>> {
  let jsCode: string;
  try {
    jsCode = await transformTypeScript(source);
  } catch (err) {
    return {
      ok: false,
      error: {
        code: "COMPILATION_ERROR",
        message: errorMessage(err),
        suggestion: "Fix the TypeScript syntax in the dev view source.",
      },
    };
  }

  try {
    const sourceURL = `//# sourceURL=opentide://dev_views/${name}.ts`;
    const factory = new Function(
      "db",
      "functions",
      "config",
      "templates",
      "packages",
      "env",
      "log",
      "kernel",
      `"use strict";\n${jsCode}\nreturn ${name};\n${sourceURL}`,
    );
    const fn = factory(
      deps.db,
      deps.functions,
      deps.config,
      deps.templates,
      deps.packages,
      deps.env,
      deps.log,
      kernelInspect,
    );
    if (typeof fn !== "function") {
      return {
        ok: false,
        error: {
          code: "NOT_A_FUNCTION",
          message: `Dev view source must define a function named "${name}".`,
          suggestion:
            `function ${name}(object) { return { type: "stack", children: [] }; }`,
        },
      };
    }
    return { ok: true, data: fn as DevViewFn };
  } catch (err) {
    return {
      ok: false,
      error: {
        code: "RUNTIME_ERROR",
        message: `Failed to instantiate dev view "${name}": ${
          errorMessage(err)
        }`,
      },
    };
  }
}

export async function compileDevTool(
  name: string,
  source: string,
  args: DevToolArgDef[],
  deps: CompileDeps,
): Promise<Result<DevToolFn>> {
  let jsCode: string;
  try {
    jsCode = await transformTypeScript(source);
  } catch (err) {
    return {
      ok: false,
      error: {
        code: "COMPILATION_ERROR",
        message: errorMessage(err),
        suggestion: "Fix the TypeScript syntax in the dev tool source.",
      },
    };
  }

  try {
    const sourceURL = `//# sourceURL=opentide://dev_tools/${name}.ts`;
    const factory = new Function(
      "db",
      "functions",
      "config",
      "templates",
      "packages",
      "env",
      "log",
      `"use strict";\n${jsCode}\nreturn ${name};\n${sourceURL}`,
    );
    const fn = factory(
      deps.db,
      deps.functions,
      deps.config,
      deps.templates,
      deps.packages,
      deps.env,
      deps.log,
    );
    if (typeof fn !== "function") {
      const argList = args.map((a) => `${a.name}: ${a.type}`).join(", ");
      return {
        ok: false,
        error: {
          code: "NOT_A_FUNCTION",
          message: `Dev tool source must define a function named "${name}".`,
          suggestion:
            `function ${name}(${argList}) { return { result: "..." }; }`,
        },
      };
    }
    return { ok: true, data: fn as DevToolFn };
  } catch (err) {
    return {
      ok: false,
      error: {
        code: "RUNTIME_ERROR",
        message: `Failed to instantiate dev tool "${name}": ${
          errorMessage(err)
        }`,
      },
    };
  }
}

// new Function() wraps the body as `(function anonymous(params\n) {\n<body>\n})`.
// We prepend `"use strict";\n` to the body, so the esbuild output starts 3 lines
// into the V8 script. Shift the inline source map by 3 so V8 maps TS lines correctly.
const NEW_FUNCTION_LINE_OFFSET = 3;

function shiftSourceMap(code: string, offset: number): string {
  const marker = "//# sourceMappingURL=data:application/json;base64,";
  const idx = code.indexOf(marker);
  if (idx === -1) return code;
  const eol = code.indexOf("\n", idx);
  const b64 = code.slice(idx + marker.length, eol === -1 ? undefined : eol);
  try {
    const json = JSON.parse(atob(b64));
    json.mappings = ";".repeat(offset) + json.mappings;
    const shifted = btoa(JSON.stringify(json));
    return code.slice(0, idx) + marker + shifted +
      (eol === -1 ? "" : code.slice(eol));
  } catch {
    return code;
  }
}

async function compile<T>(
  name: string,
  source: string,
  deps: CompileDeps,
  kind: "handler" | "function",
): Promise<Result<T>> {
  let jsCode: string;
  try {
    const code = await transformTypeScript(source, {
      sourcemap: "inline",
      sourcefile: `opentide://${kind}s/${name}.ts`,
    });
    jsCode = shiftSourceMap(code, NEW_FUNCTION_LINE_OFFSET);
  } catch (err) {
    const msg = errorMessage(err);
    return {
      ok: false,
      error: {
        code: "COMPILATION_ERROR",
        message: msg,
        suggestion:
          `Fix the TypeScript syntax in the ${kind} source and try again.`,
      },
    };
  }

  try {
    const sourceURL = `//# sourceURL=opentide://${kind}s/${name}.ts`;
    // Parameter names come from core/reserved-names.ts, which is what makes them
    // reserved: the define tools refuse an entity named after any of them.
    const scope: Record<EntityScopeName, unknown> = {
      db: deps.db,
      functions: deps.functions,
      config: deps.config,
      templates: deps.templates,
      packages: deps.packages,
      env: deps.env,
      log: deps.log,
      assertNever: runtimeAssertNever,
    };
    const factory = new Function(
      ...ENTITY_SCOPE_NAMES,
      `"use strict";\n${jsCode}\nreturn ${name};\n${sourceURL}`,
    );
    const fn = factory(
      ...ENTITY_SCOPE_NAMES.map((binding) => scope[binding]),
    ) as T;
    if (typeof fn !== "function") {
      return {
        ok: false,
        error: {
          code: "NOT_A_FUNCTION",
          message: `The source must define a ${
            kind === "handler" ? "request handler" : ""
          } function named "${name}".`,
          suggestion: `Ensure the source contains: ${
            kind === "handler"
              // Untyped on purpose: `HandlerContext` is not a declared global
              // in the language service yet, so naming it here would hand the
              // agent a suggestion that does not typecheck.
              ? `async function ${name}(req, ctx) { ... }`
              : `function ${name}(...) { ... }`
          }`,
        },
      };
    }
    return { ok: true, data: fn };
  } catch (err) {
    const msg = errorMessage(err);
    return {
      ok: false,
      error: {
        code: "RUNTIME_ERROR",
        message: `Failed to instantiate ${kind} "${name}": ${msg}`,
      },
    };
  }
}
