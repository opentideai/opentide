import { assertEquals } from "@std/assert";
import { Kernel } from "./registries.ts";
import { Database } from "./db.ts";
import {
  compileHandler,
  initCompiler,
  runScript,
  stopCompiler,
} from "./compiler.ts";
import { createAppServer } from "./app-server.ts";
import type { CompileDeps } from "./types.ts";

const TEST_PORT = 4003;

async function withCompiler<T>(
  fn: (kernel: Kernel, deps: CompileDeps) => Promise<T>,
): Promise<T> {
  await initCompiler();
  const db = await Database.create({ driver: "pglite" });
  const kernel = new Kernel(db);
  const deps = await kernel.compileDeps();
  try {
    return await fn(kernel, deps);
  } finally {
    await db.close();
    stopCompiler();
  }
}

const testOpts = { sanitizeResources: false, sanitizeOps: false };

Deno.test({
  ...testOpts,
  name: "Throwing handler returns 500 and logs error",
  fn: async () => {
    await withCompiler(async (kernel, deps) => {
      const src = `async function boom(c: any) { throw new Error("kaboom"); }`;
      const result = await compileHandler("boom", src, deps);
      assertEquals(result.ok, true);
      if (!result.ok) throw new Error("unreachable");
      kernel.handlers.register("boom", src, result.data);
      kernel.routes.register("GET", "/boom", "boom");

      const appServer = createAppServer(kernel, TEST_PORT);
      appServer.rebuild();

      try {
        const res = await fetch(`http://localhost:${TEST_PORT}/boom`);
        assertEquals(res.status, 500);
        const body = await res.json();
        assertEquals(body.error, "kaboom");

        const errors = kernel.log.query({ level: "error", limit: 1 });
        assertEquals(errors.length, 1);
        assertEquals(errors[0]!.message, "kaboom");
        assertEquals(errors[0]!.route, "GET /boom");

        const okSrc =
          `async function ok(c: any) { return c.json({ status: "ok" }); }`;
        const okResult = await compileHandler("ok", okSrc, deps);
        assertEquals(okResult.ok, true);
        if (!okResult.ok) throw new Error("unreachable");
        kernel.handlers.register("ok", okSrc, okResult.data);
        kernel.routes.register("GET", "/ok", "ok");
        appServer.rebuild();

        const res2 = await fetch(`http://localhost:${TEST_PORT}/ok`);
        assertEquals(res2.status, 200);
        assertEquals((await res2.json()).status, "ok");
      } finally {
        await appServer.shutdown();
      }
    });
  },
});

Deno.test({
  ...testOpts,
  name: "Missing handler returns 500 and logs error",
  fn: async () => {
    await withCompiler(async (kernel, _deps) => {
      kernel.routes.register("GET", "/ghost", "nonexistent");

      const appServer = createAppServer(kernel, TEST_PORT);
      appServer.rebuild();

      try {
        const res = await fetch(`http://localhost:${TEST_PORT}/ghost`);
        assertEquals(res.status, 500);
        const body = await res.json();
        assertEquals(body.error.includes("nonexistent"), true);

        const errors = kernel.log.query({ level: "error", limit: 1 });
        assertEquals(errors.length, 1);
        assertEquals(errors[0]!.message.includes("nonexistent"), true);
      } finally {
        await appServer.shutdown();
      }
    });
  },
});

Deno.test({
  ...testOpts,
  name: "Unknown path returns a JSON 404 (F-03)",
  fn: async () => {
    await withCompiler(async (kernel, deps) => {
      const src = `async function ok(c: any) { return c.json({ ok: true }); }`;
      const result = await compileHandler("ok", src, deps);
      assertEquals(result.ok, true);
      if (!result.ok) throw new Error("unreachable");
      kernel.handlers.register("ok", src, result.data);
      kernel.routes.register("GET", "/ok", "ok");

      const appServer = createAppServer(kernel, TEST_PORT);
      appServer.rebuild();

      try {
        const res = await fetch(`http://localhost:${TEST_PORT}/nope`);
        assertEquals(res.status, 404);
        assertEquals(
          res.headers.get("content-type")?.includes("application/json"),
          true,
        );
        const body = await res.json();
        assertEquals(body.error, true);
        assertEquals(body.code, "NOT_FOUND");
      } finally {
        await appServer.shutdown();
      }
    });
  },
});

Deno.test({
  ...testOpts,
  name: "Wrong method on a known path returns 405 + Allow (F-04)",
  fn: async () => {
    await withCompiler(async (kernel, deps) => {
      const src = `async function ok(c: any) { return c.json({ ok: true }); }`;
      const result = await compileHandler("ok", src, deps);
      assertEquals(result.ok, true);
      if (!result.ok) throw new Error("unreachable");
      kernel.handlers.register("ok", src, result.data);
      kernel.routes.register("GET", "/thing/:id", "ok");

      const appServer = createAppServer(kernel, TEST_PORT);
      appServer.rebuild();

      try {
        // POST to a path registered only for GET (with a param) → 405, not 404.
        const res = await fetch(`http://localhost:${TEST_PORT}/thing/42`, {
          method: "POST",
        });
        assertEquals(res.status, 405);
        assertEquals(res.headers.get("allow"), "GET");
        const body = await res.json();
        assertEquals(body.error, true);
        assertEquals(body.code, "METHOD_NOT_ALLOWED");
      } finally {
        await appServer.shutdown();
      }
    });
  },
});

Deno.test({
  ...testOpts,
  name: "Slow handler times out with 503",
  fn: async () => {
    await withCompiler(async (kernel, deps) => {
      const src = `async function slow(c: any) {
      await new Promise(r => setTimeout(r, 5000));
      return c.json({ msg: "too late" });
    }`;
      const result = await compileHandler("slow", src, deps);
      assertEquals(result.ok, true);
      if (!result.ok) throw new Error("unreachable");
      kernel.handlers.register("slow", src, result.data);
      kernel.routes.register("GET", "/slow", "slow");

      const appServer = createAppServer(kernel, TEST_PORT, 200);
      appServer.rebuild();

      try {
        const res = await fetch(`http://localhost:${TEST_PORT}/slow`);
        assertEquals(res.status, 503);
        const body = await res.json();
        assertEquals(body.error.includes("timed out"), true);

        const errors = kernel.log.query({ level: "warn", limit: 1 });
        assertEquals(errors.length, 1);
        assertEquals(errors[0]!.message.includes("timed out"), true);

        const requests = kernel.requestLog.recent(1);
        assertEquals(requests.length, 1);
        assertEquals(requests[0]!.status, 503);
      } finally {
        await appServer.shutdown();
      }
    });
  },
});

Deno.test({
  ...testOpts,
  name: "Request log captures successful requests",
  fn: async () => {
    await withCompiler(async (kernel, deps) => {
      const src =
        `async function ping(c: any) { return c.json({ pong: true }); }`;
      const result = await compileHandler("ping", src, deps);
      assertEquals(result.ok, true);
      if (!result.ok) throw new Error("unreachable");
      kernel.handlers.register("ping", src, result.data);
      kernel.routes.register("GET", "/ping", "ping");

      const appServer = createAppServer(kernel, TEST_PORT);
      appServer.rebuild();

      try {
        const res = await fetch(`http://localhost:${TEST_PORT}/ping`);
        assertEquals(res.status, 200);
        await res.json();

        const requests = kernel.requestLog.recent(1);
        assertEquals(requests.length, 1);
        assertEquals(requests[0]!.method, "GET");
        assertEquals(requests[0]!.path, "/ping");
        assertEquals(requests[0]!.status, 200);
        assertEquals(typeof requests[0]!.durationMs, "number");
      } finally {
        await appServer.shutdown();
      }
    });
  },
});

Deno.test({
  ...testOpts,
  name: "run_script executes and captures output",
  fn: async () => {
    await withCompiler(async (_kernel, deps) => {
      const result = await runScript(
        `
      log("hello");
      log("value:", 42);
      return 1 + 2;
    `,
        deps,
      );
      assertEquals(result.ok, true);
      if (!result.ok) throw new Error("unreachable");
      assertEquals(result.output, 3);
      assertEquals(result.logs, ["hello", "value: 42"]);
    });
  },
});

Deno.test({
  ...testOpts,
  name: "run_script can access db and config",
  fn: async () => {
    await withCompiler(async (kernel, deps) => {
      await kernel.db.defineSchema(
        "items",
        "CREATE TABLE items (id SERIAL PRIMARY KEY, name TEXT)",
      );
      await kernel.db.execute("INSERT INTO items (name) VALUES ($1)", ["test"]);
      kernel.configs.set("count", 5);

      const result = await runScript(
        `
      const rows = await db.query("SELECT * FROM items");
      const count = config.get("count");
      log("rows:", rows.length, "count:", count);
      return { rows, count };
    `,
        deps,
      );
      assertEquals(result.ok, true);
      if (!result.ok) throw new Error("unreachable");
      const data = result.output as { rows: unknown[]; count: number };
      assertEquals(data.rows.length, 1);
      assertEquals(data.count, 5);
      assertEquals(result.logs, ["rows: 1 count: 5"]);
    });
  },
});

Deno.test({
  ...testOpts,
  name: "run_script returns error on bad syntax",
  fn: async () => {
    await withCompiler(async (_kernel, deps) => {
      const result = await runScript(`const x: string = `, deps);
      assertEquals(result.ok, false);
      if (result.ok) throw new Error("unreachable");
      assertEquals(result.error.code, "COMPILATION_ERROR");
    });
  },
});

Deno.test({
  ...testOpts,
  name: "run_script returns error on runtime throw",
  fn: async () => {
    await withCompiler(async (_kernel, deps) => {
      const result = await runScript(`throw new Error("oops");`, deps);
      assertEquals(result.ok, false);
      if (result.ok) throw new Error("unreachable");
      assertEquals(result.error.code, "RUNTIME_ERROR");
      assertEquals(result.error.message, "oops");
    });
  },
});

Deno.test({
  ...testOpts,
  name: "run_script times out on slow code",
  fn: async () => {
    await withCompiler(async (_kernel, deps) => {
      const result = await runScript(
        `await new Promise(r => setTimeout(r, 5000));`,
        deps,
        200,
      );
      assertEquals(result.ok, false);
      if (result.ok) throw new Error("unreachable");
      assertEquals(result.error.code, "TIMEOUT");
    });
  },
});
