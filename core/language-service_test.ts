import { assertEquals } from "@std/assert";
import { GenieLanguageService } from "./language-service.ts";
import { Database } from "./db.ts";
import { Kernel } from "./registries.ts";
import {
  compileFunction,
  compileHandler,
  initCompiler,
  stopCompiler,
} from "./compiler.ts";

let sharedKernel: Kernel | null = null;

async function createTestKernel(): Promise<Kernel> {
  if (sharedKernel) return sharedKernel;

  await initCompiler();
  // Process-lifetime on purpose: every test in this file reuses this kernel, so no
  // single test may close its database.
  const db = await Database.create({ driver: "pglite" });
  const kernel = new Kernel(db);

  const deps = await kernel.compileDeps();

  const fnSource = `function validateAuth(token: string): boolean {
  if (!token) return false;
  return token.length > 10;
}`;
  const fnResult = await compileFunction("validateAuth", fnSource, deps);
  if (fnResult.ok) {
    kernel.functions.register("validateAuth", fnSource, fnResult.data);
  }

  const handlerSource = `async function getUsers(c: Context) {
  const rows = await db.query("SELECT * FROM users");
  const token = c.req.header("authorization");
  const valid = functions.call("validateAuth", token);
  if (!valid) return c.json({ error: "unauthorized" }, 401);
  return c.json(rows);
}`;
  const handlerResult = await compileHandler("getUsers", handlerSource, deps);
  if (handlerResult.ok) {
    kernel.handlers.register("getUsers", handlerSource, handlerResult.data);
  }

  kernel.routes.register("GET", "/api/users", "getUsers");
  kernel.configs.set("config", { debug: true });

  sharedKernel = kernel;
  return kernel;
}

const testOpts = {
  sanitizeResources: false,
  sanitizeOps: false,
  sanitizeExit: false,
};

Deno.test(
  "language service - diagnostics for valid handler",
  testOpts,
  async () => {
    const kernel = await createTestKernel();
    const ls = new GenieLanguageService();

    const diagnostics = ls.getDiagnostics("handler", "getUsers", kernel);
    const errors = diagnostics.filter((d) => d.severity === "error");
    assertEquals(
      errors.length,
      0,
      `Unexpected errors: ${JSON.stringify(errors, null, 2)}`,
    );

    ls.dispose();
    stopCompiler();
  },
);

Deno.test(
  "language service - diagnostics for invalid code",
  testOpts,
  async () => {
    const kernel = await createTestKernel();
    const ls = new GenieLanguageService();

    kernel.handlers.register(
      "broken",
      "function broken(c { return c.json({}); }",
      () => new Response(),
    );

    const diagnostics = ls.getDiagnostics("handler", "broken", kernel);
    const errors = diagnostics.filter((d) => d.severity === "error");
    assertEquals(errors.length > 0, true, "Should have syntax errors");

    ls.dispose();
    stopCompiler();
  },
);

Deno.test("language service - completions on db.", testOpts, async () => {
  const kernel = await createTestKernel();
  const ls = new GenieLanguageService();

  // Handler source line 2: "  const rows = await db.query(..."
  //                          1234567890123456789012345
  // db is at col 22-23, dot at col 24. Completions after dot = col 25
  const completions = ls.getCompletions("handler", "getUsers", 2, 25, kernel);
  const labels = completions.map((c) => c.label);
  assertEquals(
    labels.includes("query"),
    true,
    `Expected "query" in completions, got: ${labels.join(", ")}`,
  );
  assertEquals(
    labels.includes("execute"),
    true,
    `Expected "execute" in completions, got: ${labels.join(", ")}`,
  );

  ls.dispose();
  stopCompiler();
});

Deno.test(
  "language service - completions on state.get()",
  testOpts,
  async () => {
    const kernel = await createTestKernel();
    const ls = new GenieLanguageService();

    kernel.handlers.register(
      "stateTest",
      `async function stateTest(c: Context) {
  const val = state.get("test");
  return c.json(val);
}`,
      () => new Response(),
    );

    // Line 2: "  const val = state.get("test");"
    //          1234567890123456789012345
    // state at col 15-19, dot at col 20, completions at col 21
    const completions = ls.getCompletions(
      "handler",
      "stateTest",
      2,
      21,
      kernel,
    );
    const labels = completions.map((c) => c.label);
    assertEquals(
      labels.includes("get"),
      true,
      `Expected "get" in completions, got: ${labels.join(", ")}`,
    );
    assertEquals(
      labels.includes("set"),
      true,
      `Expected "set" in completions, got: ${labels.join(", ")}`,
    );
    assertEquals(
      labels.includes("delete"),
      true,
      `Expected "delete" in completions, got: ${labels.join(", ")}`,
    );

    ls.dispose();
    stopCompiler();
  },
);

Deno.test("language service - hover info on db", testOpts, async () => {
  const kernel = await createTestKernel();
  const ls = new GenieLanguageService();

  // Line 2: "  const rows = await db.query(..."
  // db at col 22-23. Hover at col 22 (on 'd')
  const hover = ls.getHoverInfo("handler", "getUsers", 2, 22, kernel);
  assertEquals(hover !== null, true, "Should have hover info for 'db'");
  if (hover) {
    assertEquals(
      hover.text.includes("query"),
      true,
      `Hover should mention query, got: ${hover.text}`,
    );
  }

  ls.dispose();
  stopCompiler();
});

Deno.test("language service - function diagnostics", testOpts, async () => {
  const kernel = await createTestKernel();
  const ls = new GenieLanguageService();

  const diagnostics = ls.getDiagnostics("function", "validateAuth", kernel);
  const errors = diagnostics.filter((d) => d.severity === "error");
  assertEquals(
    errors.length,
    0,
    `Unexpected errors in function: ${JSON.stringify(errors)}`,
  );

  ls.dispose();
  stopCompiler();
});

Deno.test(
  "language service - go to definition cross-entity",
  testOpts,
  async () => {
    const kernel = await createTestKernel();
    const ls = new GenieLanguageService();

    // In handler getUsers, "validateAuth" is referenced via functions.call
    // But go-to-def on a function name used directly should work if it's in scope
    // Let's test: add a handler that directly calls validateAuth (which is in global scope in script mode)
    kernel.handlers.register(
      "directCall",
      `async function directCall(c: Context) {
  const ok = validateAuth("mytoken123456");
  return c.json({ ok });
}`,
      () => new Response(),
    );

    // Line 2: "  const ok = validateAuth("mytoken123456");"
    //          1234567890123456
    // validateAuth starts at col 16
    const defs = ls.getDefinition("handler", "directCall", 2, 16, kernel);
    assertEquals(
      defs.length > 0,
      true,
      `Should find definition for validateAuth, got: ${JSON.stringify(defs)}`,
    );
    if (defs.length > 0) {
      assertEquals(defs[0]!.entityType, "function");
      assertEquals(defs[0]!.entityName, "validateAuth");
    }

    ls.dispose();
    stopCompiler();
  },
);

// Stage 3 of the framework-free handler ABI: the fetch API has to be declared,
// or every handler written the new way lights up with "Cannot find name 'Response'".
// These assert the declarations exist, not that they are complete — the point is
// that an ordinary handler type-checks clean, not that we reimplemented lib.dom.

const FETCH_ABI_HANDLER =
  `async function listTodos(req: Request, ctx: HandlerContext): Promise<Response> {
  const url = new URL(req.url);
  const limit = url.searchParams.get("limit");
  const auth = req.headers.get("authorization");
  const id = ctx.params.id;
  if (!auth) return new Response("no", { status: 401 });
  if (req.method === "POST") {
    const body = await req.json();
    return Response.json({ body, id, limit }, { status: 201 });
  }
  const headers = new Headers({ "content-type": "application/json" });
  return new Response(JSON.stringify({ id, limit }), { status: 200, headers });
}`;

Deno.test(
  "language service - fetch-ABI handler has no diagnostics",
  testOpts,
  async () => {
    const kernel = await createTestKernel();
    const ls = new GenieLanguageService();

    const diagnostics = ls.getDiagnostics(
      "handler",
      "listTodos",
      kernel,
      FETCH_ABI_HANDLER,
    );
    const errors = diagnostics.filter((d) => d.severity === "error");
    assertEquals(
      errors.length,
      0,
      `Unexpected errors: ${JSON.stringify(errors, null, 2)}`,
    );

    ls.dispose();
    stopCompiler();
  },
);

Deno.test(
  "language service - legacy Context handler still has no diagnostics",
  testOpts,
  async () => {
    const kernel = await createTestKernel();
    const ls = new GenieLanguageService();

    const legacy = `async function legacyHandler(c: Context) {
  const id = c.req.param("id");
  const q = c.req.query("q");
  c.header("x-trace", "1");
  if (!id) return c.notFound();
  return c.json({ id, q }, 200);
}`;

    const diagnostics = ls.getDiagnostics(
      "handler",
      "legacyHandler",
      kernel,
      legacy,
    );
    const errors = diagnostics.filter((d) => d.severity === "error");
    assertEquals(
      errors.length,
      0,
      `Unexpected errors: ${JSON.stringify(errors, null, 2)}`,
    );

    ls.dispose();
    stopCompiler();
  },
);

Deno.test(
  "language service - documented runtime globals are declared",
  testOpts,
  async () => {
    const kernel = await createTestKernel();
    const ls = new GenieLanguageService();

    // core/docs/generated/compilation.md tells the agent these are available, and
    // they are — every one resolves through Deno's global scope at runtime. They
    // were simply absent from lib.esnext, so using any of them reported TS2304.
    const source =
      `async function usesRuntime(req: Request, ctx: HandlerContext) {
  console.log("hit", ctx.params.id);
  const bytes = new TextEncoder().encode(await req.text());
  const text = new TextDecoder().decode(bytes);
  const id = crypto.randomUUID();
  const hashed = await crypto.subtle.digest("SHA-256", bytes);
  const encoded = btoa(text);
  const copy = structuredClone({ id });
  const started = performance.now();
  const timer = setTimeout(() => {}, 10);
  clearTimeout(timer);
  const upstream = await fetch("https://example.test", { method: "GET" });
  return Response.json({ id, encoded, copy, started, hashed: hashed.byteLength, ok: upstream.ok });
}`;

    const diagnostics = ls.getDiagnostics(
      "handler",
      "usesRuntime",
      kernel,
      source,
    );
    const errors = diagnostics.filter((d) => d.severity === "error");
    assertEquals(
      errors.length,
      0,
      `Unexpected errors: ${JSON.stringify(errors, null, 2)}`,
    );

    ls.dispose();
    stopCompiler();
  },
);

Deno.test(
  "language service - test-scope helpers are declared",
  testOpts,
  async () => {
    const kernel = await createTestKernel();
    const ls = new GenieLanguageService();

    // define_test promises appUrl(path) and getAppPort(), and the compiler binds them
    // (core/reserved-names.ts TEST_ONLY_SCOPE_NAMES); every entity also gets
    // assertNever. Missing from the ambient lib, each reported TS2304.
    const source = `async function testScope() {
  const res = await fetch(appUrl("/api/items"));
  assertEquals(typeof getAppPort(), "number");
  const kind = "a" as "a";
  switch (kind) {
    case "a": break;
    default: assertNever(kind);
  }
  assert(res.ok);
}`;

    const diagnostics = ls.getDiagnostics("test", "testScope", kernel, source);
    const errors = diagnostics.filter((d) => d.severity === "error");
    assertEquals(
      errors.length,
      0,
      `Unexpected errors: ${JSON.stringify(errors, null, 2)}`,
    );

    ls.dispose();
    stopCompiler();
  },
);
