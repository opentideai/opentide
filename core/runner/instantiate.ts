// Turns transpiled JS into live user code: binds the platform's names in its
// scope, runs it, and checks it defined what it was meant to. No transpiling
// happens here, and nothing here imports esbuild or TypeScript, because this
// runs in the sandboxed runner, which can't spawn esbuild's service. The kernel
// transpiles (core/compiler.ts) and hands over the JS.

import type {
  CompileDeps,
  DevToolArgDef,
  DevToolFn,
  DevViewFn,
  HandlerFn,
  KernelInspectAPI,
  Result,
  TestFn,
} from "../types.ts";
import { AssertionError } from "../types.ts";
import {
  type HandlerAbi,
  type LegacyHandlerFn,
  wrapLegacyContextHandler,
} from "../handler-abi.ts";
import { errorMessage } from "../util.ts";
import type {
  DevToolScopeName,
  DevViewScopeName,
  EntityScopeName,
  TestScopeName,
} from "../reserved-names.ts";

export type UserCodeKind =
  | "handler"
  | "function"
  | "test"
  | "dev_view"
  | "dev_tool";

const USER_CODE_URL_SCHEME = "opentide://";
const SCRIPT_URL = `${USER_CODE_URL_SCHEME}scripts/inline.ts`;

// The URL user code is known by in stack traces, the debugger and source maps.
export function userCodeUrl(kind: UserCodeKind, name: string): string {
  return `${USER_CODE_URL_SCHEME}${kind}s/${name}.ts`;
}

// new Function() wraps the body as `(function anonymous(params\n) {\n<body>\n})`,
// and bindScope puts `"use strict";\n` first, so transpiled code starts this many
// lines into the V8 script. The compiler shifts inline source maps by it.
export const SCOPE_PREAMBLE_LINES = 3;

export function instantiateHandler(
  name: string,
  jsCode: string,
  abi: HandlerAbi,
  deps: CompileDeps,
): Result<HandlerFn> {
  const result = instantiateNamed(name, jsCode, {
    kind: "handler",
    label: "handler",
    scope: entityScope(deps),
    notAFunction: {
      message:
        `The source must define a request handler function named "${name}".`,
      // Untyped on purpose: `HandlerContext` is not a declared global in the
      // language service yet, so naming it here would hand the agent a
      // suggestion that does not typecheck.
      suggestion:
        `Ensure the source contains: async function ${name}(req, ctx) { ... }`,
    },
  });
  if (!result.ok) return result;
  // The single place a live handler is produced, and therefore the single place
  // the legacy-ABI shim has to be applied (core/handler-abi.ts). Handlers that
  // are re-registered from an existing entry carry an already-wrapped function
  // and never come back through here, so the wrap cannot be applied twice.
  const fn = abi === "legacy-context"
    ? wrapLegacyContextHandler(result.data as LegacyHandlerFn)
    : result.data as HandlerFn;
  return { ok: true, data: fn };
}

export function instantiateFunction(
  name: string,
  jsCode: string,
  deps: CompileDeps,
): Result<(...args: unknown[]) => unknown> {
  const result = instantiateNamed(name, jsCode, {
    kind: "function",
    label: "function",
    scope: entityScope(deps),
    notAFunction: {
      message: `The source must define a function named "${name}".`,
      suggestion: `Ensure the source contains: function ${name}(...) { ... }`,
    },
  });
  if (!result.ok) return result;
  return { ok: true, data: result.data as (...args: unknown[]) => unknown };
}

export function instantiateTest(
  name: string,
  jsCode: string,
  deps: CompileDeps,
): Result<TestFn> {
  const scope: Record<TestScopeName, unknown> = {
    ...entityScope(deps),
    getAppPort: deps.getAppPort,
    appUrl: deps.appUrl,
    assert: testAssert,
    assertEquals: testAssertEquals,
    assertNotEquals: testAssertNotEquals,
    assertThrows: testAssertThrows,
    assertRejects: testAssertRejects,
  };
  const result = instantiateNamed(name, jsCode, {
    kind: "test",
    label: "test",
    scope,
    notAFunction: {
      message: `Test source must define a function named "${name}".`,
      suggestion: `async function ${name}() { assertEquals(1 + 1, 2); }`,
    },
  });
  if (!result.ok) return result;
  return { ok: true, data: result.data as TestFn };
}

export function instantiateDevView(
  name: string,
  jsCode: string,
  deps: CompileDeps,
  kernelInspect: KernelInspectAPI,
): Result<DevViewFn> {
  const scope: Record<DevViewScopeName, unknown> = {
    ...devToolScope(deps),
    kernel: kernelInspect,
  };
  const result = instantiateNamed(name, jsCode, {
    kind: "dev_view",
    label: "dev view",
    scope,
    notAFunction: {
      message: `Dev view source must define a function named "${name}".`,
      suggestion:
        `function ${name}(object) { return { type: "stack", children: [] }; }`,
    },
  });
  if (!result.ok) return result;
  return { ok: true, data: result.data as DevViewFn };
}

export function instantiateDevTool(
  name: string,
  jsCode: string,
  args: DevToolArgDef[],
  deps: CompileDeps,
): Result<DevToolFn> {
  const argList = args.map((a) => `${a.name}: ${a.type}`).join(", ");
  const result = instantiateNamed(name, jsCode, {
    kind: "dev_tool",
    label: "dev tool",
    scope: devToolScope(deps),
    notAFunction: {
      message: `Dev tool source must define a function named "${name}".`,
      suggestion: `function ${name}(${argList}) { return { result: "..." }; }`,
    },
  });
  if (!result.ok) return result;
  return { ok: true, data: result.data as DevToolFn };
}

// A script is an expression (the compiler wraps it in an async IIFE), so the
// result is a thunk that starts it. The caller owns timing and the timeout.
export function instantiateScript(
  jsCode: string,
  deps: CompileDeps,
  log: CompileDeps["log"],
): Result<() => unknown> {
  try {
    return {
      ok: true,
      data: bindScope(
        entityScope(deps, log),
        `return ${jsCode}\n//# sourceURL=${SCRIPT_URL}`,
      ),
    };
  } catch (err) {
    return {
      ok: false,
      error: { code: "RUNTIME_ERROR", message: errorMessage(err) },
    };
  }
}

interface NamedSpec {
  kind: UserCodeKind;
  label: string;
  scope: Readonly<Record<string, unknown>>;
  notAFunction: { message: string; suggestion: string };
}

function instantiateNamed(
  name: string,
  jsCode: string,
  spec: NamedSpec,
): Result<unknown> {
  let fn: unknown;
  try {
    fn = bindScope(
      spec.scope,
      `${jsCode}\nreturn ${name};\n//# sourceURL=${
        userCodeUrl(spec.kind, name)
      }`,
    )();
  } catch (err) {
    return {
      ok: false,
      error: {
        code: "RUNTIME_ERROR",
        message: `Failed to instantiate ${spec.label} "${name}": ${
          errorMessage(err)
        }`,
      },
    };
  }
  if (typeof fn !== "function") {
    return {
      ok: false,
      error: { code: "NOT_A_FUNCTION", ...spec.notAFunction },
    };
  }
  return { ok: true, data: fn };
}

// The scope's names become the function's parameters, so user code reads them
// as plain identifiers. Throws on a syntax error; calling the thunk runs the body.
function bindScope(
  scope: Readonly<Record<string, unknown>>,
  body: string,
): () => unknown {
  const names = Object.keys(scope);
  const factory = new Function(...names, `"use strict";\n${body}`);
  return () => factory(...names.map((name) => scope[name]));
}

// The names are core/reserved-names.ts's, which is what makes them reserved:
// the define tools refuse an entity named after any of them.
function entityScope(
  deps: CompileDeps,
  log: CompileDeps["log"] = deps.log,
): Record<EntityScopeName, unknown> {
  return { ...devToolScope(deps), log, assertNever: runtimeAssertNever };
}

function devToolScope(deps: CompileDeps): Record<DevToolScopeName, unknown> {
  return {
    db: deps.db,
    functions: deps.functions,
    config: deps.config,
    templates: deps.templates,
    packages: deps.packages,
    env: deps.env,
    log: deps.log,
  };
}

// Runtime implementation of the `assertNever` exhaustiveness guard bound into
// handler/function/test/script scope. Mirrors the exported deps.ts helper.
function runtimeAssertNever(x: never): never {
  throw new Error(`Unexpected value: ${JSON.stringify(x)}`);
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
