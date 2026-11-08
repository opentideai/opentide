// A project's runner over its life, in real child processes: started with the
// project, killed when user code outruns its timeout, replaced when it dies or
// stops answering, and stopped with the project.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { testStoreComposition } from "../../verification/test-stores.ts";
import { initCompiler, stopCompiler, transpileScript } from "../compiler.ts";
import { PROJECT_MANIFEST_FILE } from "../project-layout.ts";
import { Database } from "../db.ts";
import { loadProject, unloadProject } from "../project-loader.ts";
import type { ProjectContext } from "../project-loader.ts";
import { createProject, removeProject } from "../project-manager.ts";
import { Kernel } from "../registries.ts";
import { isolateHome, TEST_TMP_DIR } from "../test-home_test.ts";
import { dispatchTool } from "../tools/dispatch.ts";
import {
  type ProjectRunnerSource,
  projectRunnerStart,
} from "./project-runner.ts";
import { RUNNER_METHODS } from "./protocol.ts";
import {
  isRunnerRuntimeAdapter,
  RunnerBridge,
  type RunnerBridgeOptions,
  type RunnerRuntimeAdapter,
  type RunnerStart,
} from "./runner-adapter.ts";

const TIMEOUT_MS = 1_000;
isolateHome({
  kernel: { scriptTimeoutMs: TIMEOUT_MS, testTimeoutMs: TIMEOUT_MS },
});

const testOpts = { sanitizeResources: false, sanitizeOps: false };

const PING = `function ping() { return new Response("pong"); }`;

interface Project {
  ctx: ProjectContext;
  runtime: RunnerRuntimeAdapter;
  tool(name: string, input: Record<string, unknown>): ReturnType<
    typeof dispatchTool
  >;
  get(path: string): Promise<{ status: number; body: string }>;
  pid(): number | undefined;
  warnings(): string[];
  allWarnings(): string[];
}

// A project on disk loaded with its runner on, and a broken deno.json in it:
// a runner that read the project's config would fail to start.
async function withProject(fn: (p: Project) => Promise<void>) {
  await initCompiler();
  const baseDir = await Deno.makeTempDir({
    dir: TEST_TMP_DIR,
    prefix: "runner-lifecycle-",
  });
  const entry = createProject(baseDir, "Lifecycle App");
  writeFileSync(join(entry.path, "deno.json"), "{ not json");
  const ctx = await loadProject(entry.path, {
    appPort: 0,
    composition: testStoreComposition(),
    userCodeRunner: true,
  });
  const runtime = ctx.kernel.runtime;
  assert(isRunnerRuntimeAdapter(runtime));
  const tool = (name: string, input: Record<string, unknown>) =>
    dispatchTool(name, input, ctx.kernel, () => {}, { manualEdit: true });
  try {
    await fn({
      ctx,
      runtime,
      tool,
      async get(path) {
        const res = await fetch(
          `http://127.0.0.1:${ctx.appServer.port}${path}`,
        );
        return { status: res.status, body: await res.text() };
      },
      pid: () => runtime.bridge.host?.ready.pid,
      warnings: () =>
        ctx.kernel.log.query({ source: "system", level: "warn" })
          .map((e) => e.message)
          .filter((m) => m.startsWith("The user-code runner")),
      allWarnings: () =>
        ctx.kernel.log.query({ source: "system", level: "warn" })
          .map((e) => e.message),
    });
  } finally {
    await unloadProject(ctx);
    removeProject(entry.path);
    rmSync(baseDir, { recursive: true, force: true });
    stopCompiler();
  }
}

async function route(p: Project, name: string, source: string) {
  const defined = await p.tool("define_handler", { name, source });
  assert(defined.ok, defined.error?.message);
  p.ctx.kernel.routes.register("GET", `/${name}`, name);
  p.ctx.rebuild();
}

async function ticks(ctx: ProjectContext): Promise<number> {
  const rows = await ctx.db.query("SELECT count(*)::int AS n FROM ticks");
  return (rows[0] as { n: number }).n;
}

async function until(check: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    assert(Date.now() < deadline, "timed out waiting");
    await new Promise((r) => setTimeout(r, 25));
  }
}

Deno.test({
  ...testOpts,
  name:
    "a script past its timeout is killed and writes nothing more; the next call gets a new runner",
  fn: () =>
    withProject(async (p) => {
      await p.ctx.db.execute("CREATE TABLE ticks (n int)");
      await route(p, "ping", PING);
      assertEquals(await p.get("/ping"), { status: 200, body: "pong" });
      const first = p.pid();
      assert(first !== undefined && first !== Deno.pid);

      const ran = await p.tool("run_script", {
        source: `while (true) {
  await db.execute("INSERT INTO ticks VALUES (1)");
}`,
      });
      assert(!ran.ok);
      assertStringIncludes(ran.error!.message, "timed out");
      const written = await ticks(p.ctx);
      assert(written > 0, "the script never ran");
      await new Promise((r) => setTimeout(r, 500));
      assertEquals(await ticks(p.ctx), written);
      assertEquals(p.pid(), undefined);
      assertStringIncludes(
        p.warnings().join("\n"),
        "was killed: a script ran past its timeout",
      );

      // The new runner is brought up to date in full.
      assertEquals(await p.get("/ping"), { status: 200, body: "pong" });
      assert(p.pid() !== first);
    }),
});

Deno.test({
  ...testOpts,
  name: "a runner that exits is replaced on the next call",
  fn: () =>
    withProject(async (p) => {
      await route(p, "ping", PING);
      await route(p, "die", `function die() { Deno.exit(3); }`);
      assertEquals((await p.get("/die")).status, 500);
      assertEquals(await p.get("/ping"), { status: 200, body: "pong" });
      assertStringIncludes(p.warnings().join("\n"), "exit code 3");
    }),
});

Deno.test({
  ...testOpts,
  name: "a test that never yields is killed at the test timeout",
  fn: () =>
    withProject(async (p) => {
      await route(p, "ping", PING);
      const defined = await p.tool("define_test", {
        name: "spinTest",
        source: `function spinTest() { while (true) {} }`,
      });
      assert(defined.ok, defined.error?.message);
      const ran = await p.tool("run_tests", {});
      assert(ran.ok, ran.error?.message);
      const [result] = (ran.data as {
        results: { passed: boolean; error?: string }[];
      }).results;
      assertEquals(result?.passed, false);
      assertStringIncludes(result?.error ?? "", "Test timed out after 1s");
      assertStringIncludes(
        p.warnings().join("\n"),
        "was killed: a test outran its run",
      );
      assertEquals(await p.get("/ping"), { status: 200, body: "pong" });
    }),
});

Deno.test({
  ...testOpts,
  name: "a package installed in the project imports in the real runner",
  fn: () =>
    withProject(async (p) => {
      const failed = await p.ctx.kernel.packages.restore([{
        name: "stdassert",
        specifier: "jsr:@std/assert@1",
        installedAt: new Date().toISOString(),
      }]);
      assertEquals(failed, []);
      await route(
        p,
        "pkg",
        `function pkg() { return new Response(typeof packages.stdassert.assertEquals); }`,
      );
      assertEquals(await p.get("/pkg"), { status: 200, body: "function" });
    }),
});

Deno.test({
  ...testOpts,
  name: "closing the project stops its runner",
  fn: async () => {
    let exited: Promise<unknown> | undefined;
    await withProject(async (p) => {
      await route(p, "ping", PING);
      assertEquals(await p.get("/ping"), { status: 200, body: "pong" });
      exited = p.runtime.bridge.host?.exited;
    });
    assert(exited);
    const outcome = await Promise.race([
      exited.then(() => "exited"),
      new Promise((r) => setTimeout(() => r("running"), 0)),
    ]);
    assertEquals(outcome, "exited");
  },
});

function setRunner(p: Project, runner: unknown) {
  const manifest = join(p.ctx.entry.path, PROJECT_MANIFEST_FILE);
  const meta = JSON.parse(readFileSync(manifest, "utf-8"));
  writeFileSync(manifest, JSON.stringify({ ...meta, runner }));
}

Deno.test({
  ...testOpts,
  name:
    "a runner setting that would open the kernel fails the call, and ffi is warned of",
  fn: () =>
    withProject(async (p) => {
      setRunner(p, { net: ["localhost"] });
      const refused = await p.tool("run_script", { source: "return 1;" });
      assert(!refused.ok);
      assertStringIncludes(
        refused.error!.message,
        'runner.net entry "localhost"',
      );

      setRunner(p, { net: ["localhost:5432"], ffi: true });
      const ran = await p.tool("run_script", { source: "return 1;" });
      assert(ran.ok, ran.error?.message);
      assertStringIncludes(p.allWarnings().join("\n"), "turns on ffi");
    }),
});

// A scratch dir and a bridge on a plain kernel, for what a project can't set.
async function withBridge(
  fn: (bridge: RunnerBridge, kernel: Kernel, dir: string) => Promise<void>,
  start: (dir: string) => RunnerStart,
  options: RunnerBridgeOptions = {},
) {
  await initCompiler();
  const dir = await Deno.makeTempDir({ prefix: "runner-bridge-" });
  const db = await Database.create({ driver: "pglite" });
  const kernel = new Kernel(db);
  const bridge = new RunnerBridge(kernel, start(dir), options);
  try {
    await fn(bridge, kernel, dir);
  } finally {
    await bridge.stop();
    await db.close();
    stopCompiler();
    await Deno.remove(dir, { recursive: true });
  }
}

const BARE_PROJECT: ProjectRunnerSource = {
  env: () => ({}),
  settings: () => ({ ok: true, data: {} }),
  warn: () => {},
};

function scratch(dir: string) {
  return {
    scratchDir: join(dir, "runner"),
    bundledScript: join(dir, "runner-main.js"),
  };
}

async function script(source: string) {
  const js = await transpileScript(source);
  assert(js.ok);
  return { js: js.data, timeoutMs: TIMEOUT_MS, logToKernel: false };
}

Deno.test({
  ...testOpts,
  name: "a runner that stops answering pings is killed",
  fn: () =>
    withBridge(
      async (bridge, kernel) => {
        const wedge = await bridge.invoke(
          RUNNER_METHODS.invokeScript,
          await script(`setTimeout(() => { while (true) {} }, 50);`),
          TIMEOUT_MS * 2,
        );
        assert(wedge.ok, JSON.stringify(wedge));
        // The drop clears the host before the kill, and logs after it.
        await until(() =>
          kernel.log.query({ source: "system", level: "warn" })
            .some((e) => e.message.includes("stopped answering"))
        );
        assertEquals(bridge.host, null);
        const after = await bridge.invoke(
          RUNNER_METHODS.invokeScript,
          await script(`return 2;`),
          TIMEOUT_MS * 2,
        );
        assert(after.ok);
        assertEquals((after.data.answer as { output: unknown }).output, 2);
      },
      (dir) => projectRunnerStart(scratch(dir), BARE_PROJECT),
      { heartbeatIntervalMs: 100, pingTimeoutMs: 300 },
    ),
});

Deno.test({
  ...testOpts,
  name: "the bundled runner a compiled build spawns starts and runs code",
  fn: async () => {
    const out = await Deno.makeTempDir({ prefix: "runner-bundle-" });
    try {
      const bundle = join(out, "runner-bundle.js");
      const built = await new Deno.Command(Deno.execPath(), {
        args: [
          "bundle",
          "--quiet",
          "--platform=deno",
          `--output=${bundle}`,
          new URL("./runner-main.ts", import.meta.url).pathname,
        ],
        stderr: "piped",
      }).output();
      assert(built.success, new TextDecoder().decode(built.stderr));
      await withBridge(
        async (bridge, _kernel, dir) => {
          // Where a project's deno.json would be: --no-config must skip it.
          writeFileSync(join(dir, "deno.json"), "{ not json");
          const ran = await bridge.invoke(
            RUNNER_METHODS.invokeScript,
            await script(`return 1 + 1;`),
            TIMEOUT_MS * 2,
          );
          assert(ran.ok, JSON.stringify(ran));
          assertEquals((ran.data.answer as { output: unknown }).output, 2);
        },
        (dir) =>
          projectRunnerStart(scratch(dir), BARE_PROJECT, {
            kind: "bundle",
            bundle: pathToFileURL(bundle),
          }),
      );
    } finally {
      await Deno.remove(out, { recursive: true });
    }
  },
});
