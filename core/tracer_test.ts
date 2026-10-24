import { assert, assertEquals } from "@std/assert";
import { Kernel } from "./registries.ts";
import { Database } from "./db.ts";
import {
  compileFunction,
  compileHandler,
  initCompiler,
  stopCompiler,
} from "./compiler.ts";
import { createAppServer } from "./app-server.ts";

const TEST_PORT = 4004;
const testOpts = { sanitizeResources: false, sanitizeOps: false };

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

Deno.test({
  ...testOpts,
  name: "Tracer captures request trace with events",
  fn: async () => {
    await withCompiler(async (kernel) => {
      const deps = await kernel.compileDeps();

      const fnSrc = `function double(n: number) { return n * 2; }`;
      const fnResult = await compileFunction("double", fnSrc, deps);
      assert(fnResult.ok);
      kernel.functions.register("double", fnSrc, fnResult.data);

      kernel.configs.set("counter", 0);

      const handlerSrc = `async function hello(c: any) {
      const val = config.get("counter");
      config.set("counter", (val as number) + 1);
      const doubled = functions.call("double", 21);
      const rows = await db.query("SELECT 1 as num");
      return c.json({ val, doubled, rows });
    }`;
      const hResult = await compileHandler("hello", handlerSrc, deps);
      assert(hResult.ok);
      kernel.handlers.register("hello", handlerSrc, hResult.data);
      kernel.routes.register("GET", "/hello", "hello");

      const appServer = createAppServer(kernel, TEST_PORT);
      appServer.rebuild();

      try {
        const res = await fetch(`http://localhost:${TEST_PORT}/hello`);
        assertEquals(res.status, 200);
        const body = await res.json();
        assertEquals(body.val, 0);
        assertEquals(body.doubled, 42);

        const traces = kernel.tracer.getRecentTraces(10);
        assertEquals(traces.length, 1);

        const trace = traces[0]!;
        assertEquals(trace.method, "GET");
        assertEquals(trace.path, "/hello");
        assertEquals(trace.status, 200);
        assert(trace.durationMs! > 0);
        assert(trace.events.length > 0);

        const types = trace.events.map((e) => e.type);
        assert(
          types.includes("function-call"),
          "should have function-call event",
        );
        assert(types.includes("db-query"), "should have db-query event");

        const fnCall = trace.events.find((e) => e.type === "function-call")!;
        assertEquals(fnCall.entityName, "double");

        const dbQuery = trace.events.find((e) => e.type === "db-query")!;
        assertEquals(dbQuery.data.sql, "SELECT 1 as num");
        assert(typeof dbQuery.data.rowCount === "number");
      } finally {
        await appServer.shutdown();
      }
    });
  },
});

Deno.test({
  ...testOpts,
  name: "Tracer captures error traces",
  fn: async () => {
    await withCompiler(async (kernel) => {
      const deps = await kernel.compileDeps();

      const handlerSrc =
        `async function fail(c: any) { throw new Error("boom"); }`;
      const hResult = await compileHandler("fail", handlerSrc, deps);
      assert(hResult.ok);
      kernel.handlers.register("fail", handlerSrc, hResult.data);
      kernel.routes.register("GET", "/fail", "fail");

      const appServer = createAppServer(kernel, TEST_PORT);
      appServer.rebuild();

      try {
        const res = await fetch(`http://localhost:${TEST_PORT}/fail`);
        assertEquals(res.status, 500);

        const traces = kernel.tracer.getRecentTraces(10);
        assertEquals(traces.length, 1);

        const trace = traces[0]!;
        assertEquals(trace.status, 500);
        assert(trace.durationMs! >= 0);
      } finally {
        await appServer.shutdown();
      }
    });
  },
});

Deno.test({
  ...testOpts,
  name: "Tracer ring buffer limits stored traces",
  fn: async () => {
    await withCompiler(async (kernel) => {
      const deps = await kernel.compileDeps();

      const handlerSrc =
        `async function ping(c: any) { return c.text("pong"); }`;
      const hResult = await compileHandler("ping", handlerSrc, deps);
      assert(hResult.ok);
      kernel.handlers.register("ping", handlerSrc, hResult.data);
      kernel.routes.register("GET", "/ping", "ping");

      const appServer = createAppServer(kernel, TEST_PORT);
      appServer.rebuild();

      try {
        for (let i = 0; i < 5; i++) {
          await fetch(`http://localhost:${TEST_PORT}/ping`);
        }

        const traces = kernel.tracer.getRecentTraces(100);
        assertEquals(traces.length, 5);

        assertEquals(traces[4]!.status, 200);
      } finally {
        await appServer.shutdown();
      }
    });
  },
});
