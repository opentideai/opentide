import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAppServer } from "../app-server.ts";
import { initCompiler, stopCompiler } from "../compiler.ts";
import { APP_AUTH_GATE_CONFIG, APP_PORT_AUTO } from "../config.ts";
import { Database } from "../db.ts";
import { loadKernelState, saveKernelState } from "../persistence.ts";
import { Kernel } from "../registries.ts";
import { dispatchTool } from "../tools/dispatch.ts";
import type { TraceEvent } from "../trace-context.ts";
import type { LogEntry } from "../types.ts";
import { RUNNER_ERROR_CODES } from "./protocol.ts";
import { isRunnerRuntimeAdapter } from "./runner-adapter.ts";
import { RunnerHost } from "./runner-host.ts";

const testOpts = { sanitizeResources: false, sanitizeOps: false };
const noop = () => {};
const manual = { manualEdit: true };

type Mode = "in-process" | "runner";
const MODES: Mode[] = ["in-process", "runner"];

interface App {
  kernel: Kernel;
  get(path: string): Promise<{ status: number; body: string }>;
}

// A kernel serving its app on a free port, its user code run in-process or
// in a runner served in this process over the memory transport.
async function withApp<T>(mode: Mode, fn: (app: App) => Promise<T>) {
  await initCompiler();
  const db = await Database.create({ driver: "pglite" });
  const kernel = new Kernel(
    db,
    mode === "runner" ? { userCodeRunner: RunnerHost.inMemory } : {},
  );
  const server = createAppServer(kernel, APP_PORT_AUTO);
  try {
    return await fn({
      kernel,
      async get(path) {
        server.rebuild();
        kernel.appPort = server.port;
        const res = await fetch(`http://127.0.0.1:${server.port}${path}`);
        return { status: res.status, body: await res.text() };
      },
    });
  } finally {
    await server.shutdown();
    await kernel.runtime.dispose?.();
    await db.close();
    stopCompiler();
  }
}

// Runs the same scenario on both kinds of kernel and hands back both results.
async function bothWays<T>(fn: (app: App) => Promise<T>): Promise<T[]> {
  const results: T[] = [];
  for (const mode of MODES) results.push(await withApp(mode, fn));
  return results;
}

async function assertSame<T>(fn: (app: App) => Promise<T>): Promise<T> {
  const [inProcess, runner] = await bothWays(fn);
  assertEquals(runner, inProcess);
  return inProcess!;
}

async function tool(
  kernel: Kernel,
  name: string,
  input: Record<string, unknown>,
) {
  return await dispatchTool(name, input, kernel, noop, manual);
}

async function define(
  kernel: Kernel,
  name: string,
  input: Record<string, unknown>,
): Promise<void> {
  const result = await tool(kernel, name, input);
  assert(result.ok, `${name}: ${result.error?.message}`);
}

async function route(kernel: Kernel, path: string, handler: string) {
  await define(kernel, "define_handler", {
    name: handler,
    source: HANDLERS[handler],
  });
  kernel.routes.register("GET", path, handler);
}

const HANDLERS: Record<string, string> = {
  report: `async function report(req: Request) {
  log.info("report ran");
  await db.execute("INSERT INTO notes (body) VALUES ($1)", ["a"]);
  const rows = await db.query("SELECT body FROM notes");
  const n = functions.call("double", rows.length) as number;
  const notes = db.tables.notes;
  const drizzled = await db.select({ body: notes.body }).from(notes);
  return Response.json({
    n,
    greeting: config.get("greeting"),
    who: env.WHO,
    page: templates.get("page"),
    drizzled,
    path: new URL(req.url).pathname,
  });
}`,
  boom: `function boom() { throw new Error("kaput"); }`,
  open: `function open() { return new Response("in"); }`,
  gate: `function gate(req: Request) {
  return new URL(req.url).searchParams.get("k") === "1"
    ? null
    : new Response("no", { status: 401 });
}`,
  item: `function item(req: Request, ctx: { params: { id: string } }) {
  return Response.json({ id: ctx.params.id, q: new URL(req.url).search });
}`,
  pkg: `function pkg() {
  return new Response(typeof packages.stdassert.assertEquals);
}`,
  sse: `function sse() {
  return new Response(new ReadableStream({ start() {} }), {
    headers: { "content-type": "text/event-stream" },
  });
}`,
};

async function defineReportDeps(kernel: Kernel): Promise<void> {
  await define(kernel, "define_function", {
    name: "double",
    source: "function double(x: number): number { return x * 2; }",
  });
  await define(kernel, "define_template", {
    name: "page",
    content: "<p>page</p>",
  });
  await define(kernel, "set_config", { name: "greeting", value: "hi" });
  await define(kernel, "define_schema", {
    tableName: "notes",
    sql: "CREATE TABLE notes (id serial PRIMARY KEY, body text)",
  });
  kernel.env.set("WHO", "you");
}

// What a trace says, without the times.
function traceShape(events: TraceEvent[]) {
  return events.map(({ type, entityType, entityName, data }) => {
    const { durationMs: _, ...rest } = data;
    return { type, entityType, entityName, data: rest };
  });
}

function logged(kernel: Kernel, source: LogEntry["source"]) {
  return kernel.log.query({ source }).map((e) => [e.level, e.message]);
}

Deno.test({
  ...testOpts,
  name:
    "a handler answers, traces and logs the same in the runner as in-process",
  fn: async () => {
    const seen = await assertSame(async ({ kernel, get }) => {
      await defineReportDeps(kernel);
      await route(kernel, "/report", "report");
      const response = await get("/report");
      const trace = kernel.tracer.getRecentTraces(1)[0];
      assert(trace, "no trace");
      return {
        response,
        trace: traceShape(trace.events),
        ids: trace.events.map((e) => e.id),
        appLog: logged(kernel, "app"),
      };
    });
    assertEquals(seen.response.status, 200);
    assertEquals(JSON.parse(seen.response.body), {
      n: 2,
      greeting: "hi",
      who: "you",
      page: "<p>page</p>",
      drizzled: [{ body: "a" }],
      path: "/report",
    });
    assertEquals(seen.trace.map((e) => e.type), [
      "db-execute",
      "db-query",
      "function-call",
      "exit",
      "template-read",
    ]);
    assertEquals(seen.ids, [1, 2, 3, 4, 5]);
    assertEquals(seen.appLog, [["info", "report ran"]]);
  },
});

Deno.test({
  ...testOpts,
  name: "a throwing handler is a 500 with its message and stack, both ways",
  fn: async () => {
    const seen = await assertSame(async ({ kernel, get }) => {
      await route(kernel, "/boom", "boom");
      const response = await get("/boom");
      const entry = kernel.log.query({ source: "handler", level: "error" })
        .at(-1);
      return {
        response,
        message: entry?.message,
        stackNamesSource: entry?.stack?.includes("opentide://handlers/boom.ts"),
      };
    });
    assertEquals(seen.response.status, 500);
    assertEquals(JSON.parse(seen.response.body), { error: "kaput" });
    assertEquals(seen.message, "kaput");
    assertEquals(seen.stackNamesSource, true);
  },
});

Deno.test({
  ...testOpts,
  name: "route params and the query reach the handler",
  fn: async () => {
    const seen = await assertSame(async ({ kernel, get }) => {
      await route(kernel, "/items/:id", "item");
      return await get("/items/42?x=1");
    });
    assertEquals(seen, { status: 200, body: '{"id":"42","q":"?x=1"}' });
  },
});

Deno.test({
  ...testOpts,
  name: "the auth gate's null lets a request through, its Response stops it",
  fn: async () => {
    const seen = await assertSame(async ({ kernel, get }) => {
      await route(kernel, "/open", "open");
      await define(kernel, "define_handler", {
        name: "gate",
        source: HANDLERS.gate,
      });
      await define(kernel, "set_config", {
        name: APP_AUTH_GATE_CONFIG,
        value: "gate",
      });
      return [await get("/open?k=1"), await get("/open")];
    });
    assertEquals(seen, [{ status: 200, body: "in" }, {
      status: 401,
      body: "no",
    }]);
  },
});

Deno.test({
  ...testOpts,
  name:
    "a bad define fails the define with the same error, and changes nothing",
  fn: async () => {
    const seen = await assertSame(async ({ kernel, get }) => {
      await route(kernel, "/open", "open");
      const errors = [];
      for (const source of ["const open = 1;", "function open( {"]) {
        const result = await tool(kernel, "define_handler", {
          name: "open",
          source,
        });
        assert(!result.ok);
        errors.push(result.error?.code);
      }
      return { errors, still: await get("/open") };
    });
    assertEquals(seen.errors, ["NOT_A_FUNCTION", "COMPILATION_ERROR"]);
    assertEquals(seen.still, { status: 200, body: "in" });
  },
});

Deno.test({
  ...testOpts,
  name: "tests pass and fail the same way",
  fn: async () => {
    const seen = await assertSame(async ({ kernel }) => {
      await define(kernel, "define_function", {
        name: "double",
        source: "function double(x: number): number { return x * 2; }",
      });
      await define(kernel, "define_test", {
        name: "doublesTest",
        source:
          "async function doublesTest() { assertEquals(functions.call('double', 2), 4); }",
      });
      await define(kernel, "define_test", {
        name: "wrongTest",
        source:
          "async function wrongTest() { assertEquals(functions.call('double', 2), 5); }",
      });
      const run = await tool(kernel, "run_tests", {});
      assert(run.ok, run.error?.message);
      const data = run.data as {
        passed: number;
        failed: number;
        results: Record<string, unknown>[];
      };
      return {
        passed: data.passed,
        failed: data.failed,
        results: data.results.map(({ name, passed, error, errorName }) => ({
          name,
          passed,
          error,
          errorName,
        })),
      };
    });
    assertEquals(seen.passed, 1);
    assertEquals(seen.failed, 1);
    assertEquals(seen.results[1], {
      name: "wrongTest",
      passed: false,
      error: "Expected 5, got 4",
      errorName: "AssertionError",
    });
  },
});

Deno.test({
  ...testOpts,
  name: "scripts return, log, fail and time out the same way",
  fn: async () => {
    const seen = await assertSame(async ({ kernel }) => {
      const deps = await kernel.compileDeps();
      const run = (source: string, timeoutMs?: number) =>
        kernel.runtime.runScript!(source, deps, timeoutMs, kernel.log);
      const done = await run("log('hi', { n: 1 }); return 1 + 1;");
      assert(done.ok);
      return {
        done: { output: done.output, logs: done.logs },
        thrown: await run("throw new Error('x');"),
        broken: (await run("return (;")).ok,
        slow: await run("await new Promise(() => {});", 50),
        scriptLog: logged(kernel, "script"),
      };
    });
    assertEquals(seen.done, { output: 2, logs: ['hi {"n":1}'] });
    assertEquals(seen.thrown, {
      ok: false,
      error: { code: "RUNTIME_ERROR", message: "x" },
      logs: [],
    });
    assertEquals(seen.broken, false);
    assert(!seen.slow.ok);
    assertEquals(seen.slow.error.code, "TIMEOUT");
    assertEquals(seen.scriptLog, [["debug", 'hi {"n":1}']]);
  },
});

Deno.test({
  ...testOpts,
  name: "dev tools, dev views and kernel-side function calls answer the same",
  fn: async () => {
    const seen = await assertSame(async ({ kernel }) => {
      await define(kernel, "define_function", {
        name: "double",
        source: "function double(x: number): number { return x * 2; }",
      });
      await define(kernel, "define_dev_tool", {
        name: "twice",
        description: "Doubles",
        args: [{ name: "x", type: "number", description: "x", required: true }],
        source:
          "function twice(x: number) { return functions.call('double', x); }",
      });
      await define(kernel, "upload_text_asset", {
        name: "note.txt",
        content: "a note",
        mimeType: "text/plain",
      });
      await define(kernel, "define_dev_view", {
        name: "inspectView",
        targetType: "handler",
        title: "Inspect",
        source: `function inspectView(o: { name: string }) {
  return {
    type: "markdown",
    content: [o.name, kernel.listFunctions().map((f: { name: string }) => f.name).join(","), kernel.getAssetContent("note.txt"), kernel.getAssetContent("none")].join("|"),
  };
}`,
      });
      const toolRun = await tool(kernel, "call_dev_tool", {
        name: "twice",
        args: { x: 21 },
      });
      const view = kernel.devViews.get("inspectView");
      return {
        tool: toolRun.data,
        view: await view?.fn({ name: "obj" }),
        fn: await kernel.functions.get("double")?.(4),
      };
    });
    assertEquals(seen, {
      tool: 42,
      view: { type: "markdown", content: "obj|double|a note|" },
      fn: 8,
    });
  },
});

Deno.test({
  ...testOpts,
  name: "a package the kernel installed is importable in the runner",
  fn: async () => {
    const seen = await assertSame(async ({ kernel, get }) => {
      const failed = await kernel.packages.restore([{
        name: "stdassert",
        specifier: "jsr:@std/assert@1",
        installedAt: new Date().toISOString(),
      }]);
      assertEquals(failed, []);
      await route(kernel, "/pkg", "pkg");
      return await get("/pkg");
    });
    assertEquals(seen, { status: 200, body: "function" });
  },
});

Deno.test({
  ...testOpts,
  name:
    "what can't cross the runner fails loudly instead of hanging or vanishing",
  fn: async () => {
    await withApp("runner", async ({ kernel, get }) => {
      await route(kernel, "/sse", "sse");
      const sse = await get("/sse");
      assertEquals(sse.status, 500);
      assertStringIncludes(sse.body, "text/event-stream");

      await define(kernel, "define_dev_tool", {
        name: "mapTool",
        description: "A Map",
        args: [],
        source: "function mapTool() { return new Map(); }",
      });
      const map = await tool(kernel, "call_dev_tool", {
        name: "mapTool",
        args: {},
      });
      assert(!map.ok);
      assertStringIncludes(map.error!.message, "can't leave the runner");
      assertStringIncludes(map.error!.message, "$ is a Map");
    });
  },
});

Deno.test({
  ...testOpts,
  name: "with a runner the kernel holds stubs, and the runner the code",
  fn: async () => {
    await withApp("runner", async ({ kernel, get }) => {
      assert(isRunnerRuntimeAdapter(kernel.runtime));
      assertEquals(kernel.runtime.capabilities.executionMode, "bridge");
      await route(kernel, "/open", "open");
      assertEquals(await get("/open"), { status: 200, body: "in" });
      const mirror = await kernel.runtime.bridge.mirror();
      assert(mirror.ok);
      const kernelHas = await mirror.data.kernelManifest();
      assert(
        kernelHas.some((e) => e.category === "handler" && e.key === "open"),
      );
      // Redefined in the registry only: the next call picks it up.
      const result = await kernel.runtime.compileHandler!(
        "open",
        `function open() { return new Response("again"); }`,
        await kernel.compileDeps(),
      );
      assert(result.ok);
      kernel.handlers.register(
        "open",
        `function open() { return new Response("again"); }`,
        result.data,
      );
      assertEquals(await get("/open"), { status: 200, body: "again" });
    });
  },
});

Deno.test({
  ...testOpts,
  name: "a saved project loads into a runner kernel and serves",
  fn: async () => {
    const dir = mkdtempSync(join(tmpdir(), "runner-load-"));
    try {
      await withApp("runner", async ({ kernel }) => {
        await defineReportDeps(kernel);
        await define(kernel, "define_handler", {
          name: "report",
          source: HANDLERS.report,
        });
        saveKernelState(kernel, dir);
      });
      await withApp("runner", async ({ kernel, get }) => {
        await define(kernel, "define_schema", {
          tableName: "notes",
          sql: "CREATE TABLE notes (id serial PRIMARY KEY, body text)",
        });
        const loaded = await loadKernelState(kernel, dir, noop);
        assertEquals(loaded.errors, []);
        kernel.routes.register("GET", "/report", "report");
        const res = await get("/report");
        assertEquals(res.status, 200, res.body);
        assertEquals(JSON.parse(res.body).n, 2);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
});

Deno.test({
  ...testOpts,
  name: "a runner that won't start fails the define",
  fn: async () => {
    await initCompiler();
    const db = await Database.create({ driver: "pglite" });
    let starts = 0;
    const kernel = new Kernel(db, {
      userCodeRunner: () => {
        starts++;
        return Promise.resolve({
          ok: false,
          error: { code: RUNNER_ERROR_CODES.startFailed, message: "no deno" },
        });
      },
    });
    try {
      for (let i = 0; i < 2; i++) {
        const result = await tool(kernel, "define_function", {
          name: "f",
          source: "function f() { return 1; }",
        });
        assert(!result.ok);
        assertEquals(result.error?.code, RUNNER_ERROR_CODES.startFailed);
      }
      // A failed start isn't cached: each define tries again.
      assertEquals(starts, 2);
    } finally {
      await db.close();
      stopCompiler();
    }
  },
});
