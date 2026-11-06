import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import type { CompileDeps, HandlerContext } from "../types.ts";
import { AssertionError } from "../types.ts";
import {
  instantiateDevTool,
  instantiateDevView,
  instantiateFunction,
  instantiateHandler,
  instantiateScript,
  instantiateTest,
  userCodeUrl,
} from "./instantiate.ts";

function deps(overrides: Partial<CompileDeps> = {}): CompileDeps {
  const log = Object.assign(() => {}, {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  });
  return {
    db: {} as CompileDeps["db"],
    functions: {} as CompileDeps["functions"],
    config: { get: () => "from-config" } as unknown as CompileDeps["config"],
    templates: {} as CompileDeps["templates"],
    packages: {},
    env: { GREETING: "hi" },
    log,
    getAppPort: () => 4321,
    appUrl: (path = "/") => `http://app.local${path}`,
    ...overrides,
  };
}

const ctx = {} as HandlerContext;

Deno.test("a handler sees the scope by name and comes back callable", async () => {
  const result = instantiateHandler(
    "greet",
    "async function greet(req) { return new Response(env.GREETING + ' ' + config.get('x')); }",
    "fetch",
    deps(),
  );
  assert(result.ok);
  const res = await result.data(new Request("http://app.local/"), ctx);
  assertEquals(await res.text(), "hi from-config");
});

Deno.test("a legacy-context handler is wrapped, so it answers a Request", async () => {
  const result = instantiateHandler(
    "old",
    "function old(c) { return c.text('legacy ' + c.req.query('q')); }",
    "legacy-context",
    deps(),
  );
  assert(result.ok);
  const res = await result.data(new Request("http://app.local/?q=ok"), ctx);
  assertEquals(await res.text(), "legacy ok");
});

Deno.test("code that doesn't define the named function is NOT_A_FUNCTION", () => {
  const result = instantiateFunction("missing", "const missing = 1;", deps());
  assert(!result.ok);
  assertEquals(result.error.code, "NOT_A_FUNCTION");
  assertEquals(
    result.error.message,
    'The source must define a function named "missing".',
  );
});

Deno.test("JS that won't parse or throws at load is RUNTIME_ERROR, named", () => {
  for (
    const js of ["function f( {", "throw new Error('boom'); function f() {}"]
  ) {
    const result = instantiateFunction("f", js, deps());
    assert(!result.ok);
    assertEquals(result.error.code, "RUNTIME_ERROR");
    assert(
      result.error.message.startsWith('Failed to instantiate function "f": '),
      result.error.message,
    );
  }
});

Deno.test("user code runs strict and can't see the instantiator's own locals", () => {
  const result = instantiateFunction(
    "probe",
    "function probe() { return [typeof this, typeof scope, typeof names]; }",
    deps(),
  );
  assert(result.ok);
  const probe = result.data;
  assertEquals(probe(), ["undefined", "undefined", "undefined"]);
});

Deno.test("a test gets the asserts and the app URL helpers", async () => {
  const result = instantiateTest(
    "checks",
    `async function checks() {
      assertEquals(getAppPort(), 4321);
      assertEquals(appUrl("/x"), "http://app.local/x");
      assertNotEquals(1, 2);
      assertThrows(() => { throw new Error("x"); });
      await assertRejects(() => Promise.reject(new Error("x")));
      assert(true);
      assertEquals({ a: 1 }, { a: 2 });
    }`,
    deps(),
  );
  assert(result.ok);
  await assertRejects(() => result.data(), AssertionError, 'Expected {"a":2}');
});

Deno.test("a dev view gets the kernel inspector; a dev tool doesn't", () => {
  const kernel = { marker: "inspector" };
  const view = instantiateDevView(
    "v",
    "function v() { return kernel.marker; }",
    deps(),
    kernel as never,
  );
  assert(view.ok);
  assertEquals(view.data({} as never) as unknown, "inspector");

  const tool = instantiateDevTool(
    "t",
    "function t() { return typeof kernel + ' ' + typeof assertNever; }",
    [],
    deps(),
  );
  assert(tool.ok);
  assertEquals(tool.data({}), "undefined undefined");
});

Deno.test("a script waits to be started, and logs through the log it was given", async () => {
  const lines: string[] = [];
  const log = Object.assign((...a: unknown[]) => lines.push(a.join(" ")), {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  });
  const script = instantiateScript(
    "(async () => { log('ran', env.GREETING); return 7; })()",
    deps(),
    log,
  );
  assert(script.ok);
  assertEquals(lines, []);
  assertEquals(await script.data(), 7);
  assertEquals(lines, ["ran hi"]);
});

Deno.test("a script that won't parse is RUNTIME_ERROR", () => {
  const script = instantiateScript("(async () => {", deps(), deps().log);
  assert(!script.ok);
  assertEquals(script.error.code, "RUNTIME_ERROR");
});

Deno.test("stack traces name the entity by its opentide:// URL", () => {
  const result = instantiateFunction(
    "thrower",
    "function thrower() { throw new Error('x'); }",
    deps(),
  );
  assert(result.ok);
  const err = assertThrows(() => result.data()) as Error;
  assert(
    err.stack?.includes(userCodeUrl("function", "thrower")),
    err.stack,
  );
});

async function importedSpecifiers(module: string): Promise<string[]> {
  const out = await new Deno.Command(Deno.execPath(), {
    args: ["info", "--json", new URL(module, import.meta.url).href],
    stdout: "piped",
    stderr: "piped",
  }).output();
  assert(out.success, new TextDecoder().decode(out.stderr));
  const graph = JSON.parse(new TextDecoder().decode(out.stdout)) as {
    modules: { specifier: string }[];
  };
  return graph.modules.map((m) => m.specifier);
}

const imports = (specifiers: string[], pkg: string) =>
  specifiers.some((s) => s.startsWith(`npm:/${pkg}@`));

// The runner can't spawn esbuild's service, so the code it loads must not pull
// in a transpiler. The compiler does, which shows the check can see one.
Deno.test("instantiate.ts imports no transpiler; compiler.ts does", async () => {
  const runnerSide = await importedSpecifiers("./instantiate.ts");
  assert(!imports(runnerSide, "esbuild"));
  assert(!imports(runnerSide, "typescript"));
  const kernelSide = await importedSpecifiers("../compiler.ts");
  assert(imports(kernelSide, "esbuild"));
  assert(imports(kernelSide, "typescript"));
});
