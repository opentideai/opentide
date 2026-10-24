import { assertEquals } from "@std/assert";
import { Kernel } from "./registries.ts";
import { Database } from "./db.ts";
import { compileHandler, initCompiler, stopCompiler } from "./compiler.ts";
import { createAppServer } from "./app-server.ts";
import type { CompileDeps } from "./types.ts";

const TEST_PORT = 4001;

function makeDeps(kernel: Kernel): CompileDeps {
  const noop = (..._args: unknown[]) => {};
  return {
    db: {
      query: async () => [],
      execute: async () => ({ changes: 0 }),
    },
    functions: kernel.functions,
    config: kernel.configs,
    templates: kernel.templates,
    packages: kernel.packages.proxy(),
    env: kernel.env.all(),
    log: Object.assign(noop, {
      debug: noop,
      info: noop,
      warn: noop,
      error: noop,
    }),
    getAppPort: () => kernel.appPort,
    appUrl: (path = "/") =>
      `http://localhost:${kernel.appPort}${
        path.startsWith("/") ? path : "/" + path
      }`,
  };
}

async function withCompiler<T>(fn: (kernel: Kernel) => Promise<T>): Promise<T> {
  await initCompiler();
  const db = await Database.create({ driver: "pglite" });
  const kernel = new Kernel(db);
  try {
    return await fn(kernel);
  } finally {
    await db.close();
    stopCompiler();
  }
}

const testOpts = { sanitizeResources: false, sanitizeOps: false };

Deno.test({
  ...testOpts,
  name: "Stage 1: register handler, hit route, replace, remove",
  fn: async () => {
    await withCompiler(async (kernel) => {
      const appServer = createAppServer(kernel, TEST_PORT);
      const rebuild = () => appServer.rebuild();

      try {
        const src1 =
          `async function hello(c: any) { return c.json({ msg: "hello" }); }`;
        const result = await compileHandler("hello", src1, makeDeps(kernel));
        assertEquals(result.ok, true);
        if (!result.ok) throw new Error("unreachable");
        kernel.handlers.register("hello", src1, result.data);

        kernel.routes.register("GET", "/greet", "hello");
        rebuild();

        const res1 = await fetch(`http://localhost:${TEST_PORT}/greet`);
        assertEquals(res1.status, 200);
        assertEquals((await res1.json()).msg, "hello");

        const src2 =
          `async function hello(c: any) { return c.json({ msg: "goodbye" }); }`;
        const result2 = await compileHandler("hello", src2, makeDeps(kernel));
        assertEquals(result2.ok, true);
        if (!result2.ok) throw new Error("unreachable");
        kernel.handlers.register("hello", src2, result2.data);
        rebuild();

        const res2 = await fetch(`http://localhost:${TEST_PORT}/greet`);
        assertEquals(res2.status, 200);
        assertEquals((await res2.json()).msg, "goodbye");

        kernel.routes.unregister("GET", "/greet");
        rebuild();

        const res3 = await fetch(`http://localhost:${TEST_PORT}/greet`);
        assertEquals(res3.status, 404);
        await res3.body?.cancel();
      } finally {
        await appServer.shutdown();
      }
    });
  },
});

Deno.test({
  ...testOpts,
  name: "Compiler returns structured error on bad TypeScript",
  fn: async () => {
    await withCompiler(async (kernel) => {
      const result = await compileHandler(
        "broken",
        `async function broken(c: any { return c.json({}); }`,
        makeDeps(kernel),
      );
      assertEquals(result.ok, false);
      if (result.ok) throw new Error("unreachable");
      assertEquals(result.error.code, "COMPILATION_ERROR");
    });
  },
});

Deno.test({
  ...testOpts,
  name: "Compiler returns error when function name doesn't match",
  fn: async () => {
    await withCompiler(async (kernel) => {
      const result = await compileHandler(
        "myHandler",
        `async function wrongName(c: any) { return c.json({}); }`,
        makeDeps(kernel),
      );
      assertEquals(result.ok, false);
      if (result.ok) throw new Error("unreachable");
      assertEquals(result.error.code, "RUNTIME_ERROR");
    });
  },
});
