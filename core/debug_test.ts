import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "node:path";
import { Kernel } from "./registries.ts";
import { Database } from "./db.ts";
import { compileHandler, initCompiler, stopCompiler } from "./compiler.ts";
import { createAppServer } from "./app-server.ts";
import { APP_PORT_AUTO } from "./config.ts";
import { userConfigDir } from "./user-config-dir.ts";
import { DebugManager } from "./debug-manager.ts";

const testOpts = { sanitizeResources: false, sanitizeOps: false };

async function withDebugKernel<T>(
  fn: (kernel: Kernel, projectDir: string) => Promise<T>,
  opts: ConstructorParameters<typeof Kernel>[1] = {},
): Promise<T> {
  await initCompiler();
  const tmpDir = Deno.makeTempDirSync();
  const dataDir = `${tmpDir}/data`;
  const db = await Database.create({ driver: "pglite", dataDir });
  const kernel = new Kernel(db, opts);
  try {
    return await fn(kernel, tmpDir);
  } finally {
    await db.close();
    stopCompiler();
    try {
      Deno.removeSync(tmpDir, { recursive: true });
    } catch { /* ok */ }
  }
}

Deno.test({
  ...testOpts,
  name: "Debug manager deduplicates persisted breakpoints by location",
  fn: async () => {
    await withDebugKernel(async (kernel, projectDir) => {
      await Deno.writeTextFile(
        `${projectDir}/breakpoints.json`,
        JSON.stringify([
          {
            id: "bp-1",
            entityType: "function",
            entityName: "getRandomImage",
            line: 50,
            enabled: true,
          },
          {
            id: "bp-2",
            entityType: "function",
            entityName: "getRandomImage",
            line: 50,
            enabled: true,
          },
        ]),
      );

      const appServer = createAppServer(kernel, 4014);
      try {
        const dm = new DebugManager(kernel, appServer, projectDir);

        const breakpoints = dm.listBreakpoints();
        assertEquals(breakpoints.length, 1);
        assertEquals(breakpoints[0]!.id, "bp-1");

        const saved = JSON.parse(
          await Deno.readTextFile(`${projectDir}/breakpoints.json`),
        );
        assertEquals(saved.length, 1);
        assertEquals(saved[0].id, "bp-1");
      } finally {
        await appServer.shutdown();
      }
    });
  },
});

Deno.test({
  ...testOpts,
  name: "Debug manager starts and stops subprocess",
  fn: async () => {
    await withDebugKernel(async (kernel, projectDir) => {
      const deps = await kernel.compileDeps();

      const handlerSrc =
        `async function ping(c: any) { return c.text("pong"); }`;
      const hResult = await compileHandler("ping", handlerSrc, deps);
      assert(hResult.ok);
      kernel.handlers.register("ping", handlerSrc, hResult.data);
      kernel.routes.register("GET", "/ping", "ping");

      const appServer = createAppServer(kernel, 4010);
      appServer.rebuild();

      const dm = new DebugManager(kernel, appServer, projectDir);

      try {
        assertEquals(dm.active, false);

        await dm.start();
        assertEquals(dm.active, true);

        const res = await fetch("http://localhost:4010/ping");
        assertEquals(res.status, 200);
        const text = await res.text();
        assertEquals(text, "pong");

        await dm.stop();
        assertEquals(dm.active, false);
      } finally {
        await dm.stop().catch(() => {});
        await appServer.shutdown();
      }
    });
  },
});

Deno.test({
  ...testOpts,
  name: "Debug manager serves registered assets through proxy",
  fn: async () => {
    await withDebugKernel(async (kernel, projectDir) => {
      const deps = await kernel.compileDeps();

      const handlerSrc = `async function page(c: any) {
  return c.html('<!doctype html><html><head><link rel="stylesheet" href="/_assets/site.css"></head><body><h1>styled</h1></body></html>');
}`;
      const hResult = await compileHandler("page", handlerSrc, deps);
      assert(hResult.ok);
      kernel.handlers.register("page", handlerSrc, hResult.data);
      kernel.routes.register("GET", "/", "page");
      kernel.assets.register(
        "site.css",
        new TextEncoder().encode("h1 { color: rgb(12, 34, 56); }"),
        "text/css",
      );

      const appServer = createAppServer(kernel, 4015);
      appServer.rebuild();

      const dm = new DebugManager(kernel, appServer, projectDir);

      try {
        await dm.start();

        const pageRes = await fetch("http://localhost:4015/");
        assertEquals(pageRes.status, 200);
        assert((await pageRes.text()).includes("/_assets/site.css"));

        const assetRes = await fetch("http://localhost:4015/_assets/site.css");
        assertEquals(assetRes.status, 200);
        assertEquals(assetRes.headers.get("content-type"), "text/css");
        assertEquals(await assetRes.text(), "h1 { color: rgb(12, 34, 56); }");
      } finally {
        await dm.stop().catch(() => {});
        await appServer.shutdown();
      }
    });
  },
});

Deno.test({
  ...testOpts,
  name: "Debug manager sets breakpoint and pauses execution",
  fn: async () => {
    await withDebugKernel(async (kernel, projectDir) => {
      const deps = await kernel.compileDeps();

      const handlerSrc = `async function greet(c: any) {
  const name = "world";
  return c.text("hello " + name);
}`;
      const hResult = await compileHandler("greet", handlerSrc, deps);
      assert(hResult.ok);
      kernel.handlers.register("greet", handlerSrc, hResult.data);
      kernel.routes.register("GET", "/greet", "greet");

      const appServer = createAppServer(kernel, 4011);
      appServer.rebuild();

      const dm = new DebugManager(kernel, appServer, projectDir);

      try {
        await dm.start();

        const bpId = await dm.setBreakpoint("handler", "greet", 2);
        assert(bpId);

        const breakpoints = dm.listBreakpoints();
        assertEquals(breakpoints.length, 1);
        assertEquals(breakpoints[0]!.entityName, "greet");
        assertEquals(breakpoints[0]!.line, 2);

        const fetchPromise = fetch("http://localhost:4011/greet");

        await new Promise<void>((resolve) => {
          const check = () => {
            if (dm.paused) {
              resolve();
              return;
            }
            setTimeout(check, 50);
          };
          setTimeout(check, 100);
        });

        assert(dm.paused, "Should be paused at breakpoint");
        assert(dm.pauseState);
        assertEquals(dm.pauseState.entityName, "greet");

        const topFrame = dm.pauseState.callFrames.find((f) =>
          f.entityName === "greet"
        );
        if (topFrame) {
          const vars = await dm.getVariables(topFrame.callFrameId);
          assert(Array.isArray(vars));
        }

        await dm.resume();
        const res = await fetchPromise;
        assertEquals(res.status, 200);
        const text = await res.text();
        assertEquals(text, "hello world");
      } finally {
        await dm.stop().catch(() => {});
        await appServer.shutdown();
      }
    });
  },
});

Deno.test({
  ...testOpts,
  name: "Debug manager maps source lines to generated breakpoint locations",
  fn: async () => {
    await withDebugKernel(async (kernel, projectDir) => {
      const deps = await kernel.compileDeps();

      const handlerSrc = `async function mapped(c: any) {
  const seed = "  ok  ";
  const a = seed
    .trim()
    .toUpperCase()
    .toLowerCase();
  const b = seed
    .trim()
    .toUpperCase()
    .toLowerCase();
  const cased = seed
    .trim()
    .toUpperCase()
    .toLowerCase();
  const marker = seed
    .trim()
    .toUpperCase();

  return c.text(marker + a + b + cased);
}`;
      const hResult = await compileHandler("mapped", handlerSrc, deps);
      assert(hResult.ok);
      kernel.handlers.register("mapped", handlerSrc, hResult.data);
      kernel.routes.register("GET", "/mapped", "mapped");

      const appServer = createAppServer(kernel, 4014);
      appServer.rebuild();

      const dm = new DebugManager(kernel, appServer, projectDir);

      try {
        const bpId = await dm.setBreakpoint("handler", "mapped", 16);
        assert(bpId);

        await dm.start();

        const fetchPromise = fetch("http://localhost:4014/mapped");

        await new Promise<void>((resolve, reject) => {
          const deadline = Date.now() + 3000;
          const check = () => {
            if (dm.paused) {
              resolve();
              return;
            }
            if (Date.now() > deadline) {
              reject(new Error("Timed out waiting for mapped breakpoint"));
              return;
            }
            setTimeout(check, 50);
          };
          setTimeout(check, 100);
        });

        assert(dm.paused, "Should pause at mapped source breakpoint");
        assertEquals(dm.pauseState?.entityName, "mapped");

        await dm.resume();
        const res = await fetchPromise;
        assertEquals(res.status, 200);
      } finally {
        await dm.stop().catch(() => {});
        await appServer.shutdown();
      }
    });
  },
});

Deno.test({
  ...testOpts,
  name: "Debug manager handles breakpoint removal",
  fn: async () => {
    await withDebugKernel(async (kernel, projectDir) => {
      const deps = await kernel.compileDeps();

      const handlerSrc =
        `async function echo(c: any) { return c.text("echo"); }`;
      const hResult = await compileHandler("echo", handlerSrc, deps);
      assert(hResult.ok);
      kernel.handlers.register("echo", handlerSrc, hResult.data);
      kernel.routes.register("GET", "/echo", "echo");

      const appServer = createAppServer(kernel, 4012);
      appServer.rebuild();

      const dm = new DebugManager(kernel, appServer, projectDir);

      try {
        const bpId = await dm.setBreakpoint("handler", "echo", 1);
        assertEquals(dm.listBreakpoints().length, 1);

        await dm.start();

        await dm.removeBreakpoint(bpId);
        assertEquals(dm.listBreakpoints().length, 0);

        const res = await fetch("http://localhost:4012/echo");
        assertEquals(res.status, 200);
        assertEquals(await res.text(), "echo");
      } finally {
        await dm.stop().catch(() => {});
        await appServer.shutdown();
      }
    });
  },
});

async function defineRoute(
  kernel: Kernel,
  name: string,
  source: string,
): Promise<void> {
  const compiled = await compileHandler(
    name,
    source,
    await kernel.compileDeps(),
  );
  assert(compiled.ok);
  kernel.handlers.register(name, source, compiled.data);
  kernel.routes.register("GET", `/${name}`, name);
}

Deno.test({
  ...testOpts,
  name:
    "Debug session: user code runs in a runner child under the runner's flags, even when the project runs it in-process",
  fn: async () => {
    await withDebugKernel(async (kernel, projectDir) => {
      const keys = join(userConfigDir(), "config.json");
      await defineRoute(
        kernel,
        "probe",
        `async function probe(c: any) {
  let read = "allowed";
  try { await Deno.readTextFile(${
          JSON.stringify(keys)
        }); } catch (e) { read = e.name; }
  return c.json({ pid: Deno.pid, read });
}`,
      );
      const appServer = createAppServer(kernel, APP_PORT_AUTO);
      appServer.rebuild();
      const dm = new DebugManager(kernel, appServer, projectDir);
      try {
        await dm.start();
        const res = await fetch(`http://127.0.0.1:${appServer.port}/probe`);
        assertEquals(res.status, 200);
        const body = await res.json();
        assert(body.pid !== Deno.pid, "the debuggee is its own process");
        assertEquals(body.read, "NotCapable");
      } finally {
        await dm.stop().catch(() => {});
        await appServer.shutdown();
      }
    }, { userCodeRunner: null });
  },
});

Deno.test({
  ...testOpts,
  name: "Debug session: a runner that exits ends the session",
  fn: async () => {
    await withDebugKernel(async (kernel, projectDir) => {
      await defineRoute(
        kernel,
        "bye",
        `function bye(c: any) { Deno.exit(3); return c.text("unreachable"); }`,
      );
      const appServer = createAppServer(kernel, APP_PORT_AUTO);
      appServer.rebuild();
      const dm = new DebugManager(kernel, appServer, projectDir);
      const errors: unknown[] = [];
      const stopped = new Promise<void>((resolve) =>
        dm.on("stopped", () => resolve())
      );
      dm.on("error", (data) => errors.push(data));
      try {
        await dm.start();
        const res = await fetch(`http://127.0.0.1:${appServer.port}/bye`);
        await res.body?.cancel();
        await stopped;
        assertEquals(dm.active, false);
        assertStringIncludes(String(errors[0]), "exited unexpectedly");
      } finally {
        await dm.stop().catch(() => {});
        await appServer.shutdown();
      }
    });
  },
});
