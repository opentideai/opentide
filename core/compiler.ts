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
  RuntimeScriptResult,
  TestFn,
} from "./types.ts";
import { detectHandlerAbi } from "./handler-abi.ts";
import type { KernelLog } from "./registries.ts";
import { errorMessage } from "./util.ts";
import { getKernelSettings } from "./config.ts";
import {
  instantiateDevTool,
  instantiateDevView,
  instantiateFunction,
  instantiateHandler,
  instantiateTest,
  runScriptJs,
  SCOPE_PREAMBLE_LINES,
  type UserCodeKind,
  userCodeUrl,
} from "./runner/instantiate.ts";

// Transpiles user code in the kernel, then hands the JS to
// ./runner/instantiate.ts to make it live.

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

export async function compileHandler(
  name: string,
  source: string,
  deps: CompileDeps,
): Promise<Result<HandlerFn>> {
  const js = await transpileUserCode("handler", name, source);
  if (!js.ok) return js;
  return instantiateHandler(
    name,
    js.data,
    detectHandlerAbi(source, name),
    deps,
  );
}

export async function compileFunction(
  name: string,
  source: string,
  deps: CompileDeps,
): Promise<Result<(...args: unknown[]) => unknown>> {
  const js = await transpileUserCode("function", name, source);
  if (!js.ok) return js;
  return instantiateFunction(name, js.data, deps);
}

export async function compileTest(
  name: string,
  source: string,
  deps: CompileDeps,
): Promise<Result<TestFn>> {
  const js = await transpileUserCode("test", name, source);
  if (!js.ok) return js;
  return instantiateTest(name, js.data, deps);
}

export async function compileDevView(
  name: string,
  source: string,
  deps: CompileDeps,
  kernelInspect: KernelInspectAPI,
): Promise<Result<DevViewFn>> {
  const js = await transpileUserCode("dev_view", name, source);
  if (!js.ok) return js;
  return instantiateDevView(name, js.data, deps, kernelInspect);
}

export async function compileDevTool(
  name: string,
  source: string,
  args: DevToolArgDef[],
  deps: CompileDeps,
): Promise<Result<DevToolFn>> {
  const js = await transpileUserCode("dev_tool", name, source);
  if (!js.ok) return js;
  return instantiateDevTool(name, js.data, args, deps);
}

export async function runScript(
  source: string,
  deps: CompileDeps,
  timeoutMs = getKernelSettings().scriptTimeoutMs,
  kernelLog?: KernelLog,
): Promise<RuntimeScriptResult> {
  const js = await transpileScript(source);
  if (!js.ok) return { ...js, logs: [] };
  return await runScriptJs(
    js.data,
    deps,
    timeoutMs,
    (level, message) => kernelLog?.log(level, "script", message),
  );
}

// A script is a body of statements; it runs as an async IIFE so it can await.
export async function transpileScript(
  source: string,
): Promise<Result<string>> {
  try {
    return {
      ok: true,
      data: await transformTypeScript(`(async () => {\n${source}\n})()`),
    };
  } catch (err) {
    return {
      ok: false,
      error: {
        code: "COMPILATION_ERROR",
        message: errorMessage(err),
        suggestion: "Fix the TypeScript syntax and try again.",
      },
    };
  }
}

const USER_CODE_LABELS: Record<UserCodeKind, string> = {
  handler: "handler",
  function: "function",
  test: "test",
  dev_view: "dev view",
  dev_tool: "dev tool",
};

// The JS that instantiate.ts runs for one entity. Handlers and functions carry
// an inline source map, shifted so V8 maps the lines of the wrapped script back
// to the TS source.
export function transpileUserCode(
  kind: UserCodeKind,
  name: string,
  source: string,
): Promise<Result<string>> {
  const label = USER_CODE_LABELS[kind];
  if (kind !== "handler" && kind !== "function") {
    return transpile(source, label);
  }
  return transpile(source, label, {
    sourcemap: "inline",
    sourcefile: userCodeUrl(kind, name),
  });
}

async function transpile(
  source: string,
  label: string,
  options: TransformOptions = {},
): Promise<Result<string>> {
  try {
    const code = await transformTypeScript(source, options);
    return {
      ok: true,
      data: options.sourcemap
        ? shiftSourceMap(code, SCOPE_PREAMBLE_LINES)
        : code,
    };
  } catch (err) {
    return {
      ok: false,
      error: {
        code: "COMPILATION_ERROR",
        message: errorMessage(err),
        suggestion:
          `Fix the TypeScript syntax in the ${label} source and try again.`,
      },
    };
  }
}

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
