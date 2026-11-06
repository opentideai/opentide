import { assert, assertEquals } from "@std/assert";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initCompiler, stopCompiler } from "../compiler.ts";
import { appPreviewUrl } from "../config.ts";
import { Database } from "../db.ts";
import { loadKernelState, saveKernelState } from "../persistence.ts";
import { Kernel } from "../registries.ts";
import { dispatchTool } from "../tools/dispatch.ts";
import type { HandlerContext } from "../types.ts";
import { dbExecHandler } from "./db-service.ts";
import {
  rpcStateChannel,
  type RunnerStateChannel,
  StateMirror,
} from "./mirror.ts";
import { RpcPeer } from "./peer.ts";
import {
  MIRROR_CATEGORIES,
  mirrorEntryId,
  type MirrorManifestEntry,
  RUNNER_METHODS,
} from "./protocol.ts";
import { serveRunner } from "./runner.ts";
import type { RunnerState } from "./runner-state.ts";
import { createMemoryTransportPair } from "./transport.ts";

const testOpts = { sanitizeResources: false, sanitizeOps: false };
const TIMEOUT_MS = 5_000;
const noop = () => {};
const manual = { manualEdit: true };

interface Linked {
  kernel: Kernel;
  mirror: StateMirror;
  state: RunnerState;
  kernelPeer: RpcPeer;
}

// A kernel, and a runner served in this process over the memory transport,
// with the runner's db answered by the kernel's.
async function withLinked(fn: (l: Linked) => Promise<void>): Promise<void> {
  await initCompiler();
  const db = await Database.create({ driver: "pglite" });
  const kernel = new Kernel(db);
  const [kernelEnd, runnerEnd] = createMemoryTransportPair();
  const kernelPeer = new RpcPeer(kernelEnd, {
    handlers: { [RUNNER_METHODS.dbExec]: dbExecHandler(db, kernel.tracer) },
  });
  const runner = await serveRunner(runnerEnd, { onShutdown: noop });
  const mirror = new StateMirror(kernel, rpcStateChannel(kernelPeer));
  try {
    await fn({ kernel, mirror, state: runner.state, kernelPeer });
  } finally {
    await kernelPeer.close();
    await runner.peer.done;
    await db.close();
    stopCompiler();
  }
}

async function tool(
  kernel: Kernel,
  name: string,
  input: Record<string, unknown>,
): Promise<void> {
  const result = await dispatchTool(name, input, kernel, noop, manual);
  assert(result.ok, `${name}: ${result.error?.message}`);
}

async function synced(mirror: StateMirror) {
  const report = await mirror.sync();
  assert(report.ok, JSON.stringify(report));
  return report.data;
}

function sortManifest(entries: MirrorManifestEntry[]): MirrorManifestEntry[] {
  return [...entries].sort((a, b) =>
    mirrorEntryId(a) < mirrorEntryId(b) ? -1 : 1
  );
}

// After a sync, the runner holds exactly what the kernel has, hash for hash.
// Returns the ids, so a test can say what that is.
async function assertInStep(l: Linked): Promise<string[]> {
  await synced(l.mirror);
  const held = await l.kernelPeer.request<MirrorManifestEntry[]>(
    RUNNER_METHODS.stateManifest,
    null,
    TIMEOUT_MS,
  );
  assert(held.ok, JSON.stringify(held));
  const expected = sortManifest(await l.mirror.kernelManifest());
  assertEquals(sortManifest(held.data), expected);
  return expected.map(mirrorEntryId);
}

const ctx = { params: {} } as HandlerContext;

async function callHandler(state: RunnerState, name: string): Promise<string> {
  const handler = state.handler(name);
  assert(handler, `runner has no handler ${name}`);
  const res = await handler(new Request("http://app.local/"), ctx);
  return await res.text();
}

const FN_DOUBLE = "function double(x: number): number { return x * 2; }";
const FN_QUAD =
  "function quad(x: number): number { return functions.call('double', functions.call('double', x)) as number; }";
const HANDLER_HELLO =
  "async function hello(req: Request) { return new Response(`${config.get('greeting')} ${env.WHO} ${templates.get('page')}`); }";

async function defineEverything(kernel: Kernel): Promise<void> {
  await tool(kernel, "define_function", { name: "double", source: FN_DOUBLE });
  await tool(kernel, "define_function", { name: "quad", source: FN_QUAD });
  await tool(kernel, "define_handler", {
    name: "hello",
    source: HANDLER_HELLO,
  });
  await tool(kernel, "define_test", {
    name: "doublesTest",
    source:
      "async function doublesTest() { assertEquals(functions.call('quad', 1), 4); }",
  });
  await tool(kernel, "define_dev_view", {
    name: "plainView",
    targetType: "handler",
    title: "Plain",
    source:
      "function plainView(o: unknown) { return { type: 'stack', children: [] }; }",
  });
  await tool(kernel, "define_dev_tool", {
    name: "echoTool",
    description: "Echoes",
    args: [{ name: "x", type: "string", description: "x", required: true }],
    source: "function echoTool(args: { x: string }) { return args.x; }",
  });
  await tool(kernel, "upload_text_asset", {
    name: "site.css",
    content: "body {}",
    mimeType: "text/css",
  });
  await tool(kernel, "define_template", {
    name: "page",
    content: '<link href="/_assets/site.css">',
  });
  await tool(kernel, "set_config", { name: "greeting", value: "hi" });
  await tool(kernel, "define_schema", {
    tableName: "notes",
    sql: "CREATE TABLE notes (id serial PRIMARY KEY, body text)",
  });
  kernel.env.set("WHO", "you");
}

Deno.test({
  ...testOpts,
  name:
    "every kind of state crosses, and the runner runs it as the kernel would",
  fn: () =>
    withLinked(async (l) => {
      await defineEverything(l.kernel);
      const ids = await assertInStep(l);
      const categories = new Set(ids.map((id) => id.split(":")[0]));
      for (const category of Object.values(MIRROR_CATEGORIES)) {
        // Packages need a live npm import to define; not exercised here.
        if (category === MIRROR_CATEGORIES.package) continue;
        assert(categories.has(category), `nothing mirrored for ${category}`);
      }

      assertEquals(l.state.function("quad")?.(3), 12);
      const asset = l.kernel.assets.get("site.css");
      const version = String(new Date(asset!.registeredAt).getTime());
      assertEquals(
        await callHandler(l.state, "hello"),
        `hi you <link href="/_assets/site.css?v=${version}">`,
      );
      await l.state.test("doublesTest")?.();
      assertEquals(await l.state.devTool("echoTool")?.({ x: "ok" }), "ok");
      assertEquals(
        await l.state.devView("plainView")?.({}),
        { type: "stack", children: [] },
      );
      assertEquals(l.state.deps.getAppPort(), l.kernel.appPort);
      assertEquals(
        l.state.deps.appUrl("/x"),
        appPreviewUrl(l.kernel.appPort, "/x"),
      );
      await l.state.deps.db.execute("INSERT INTO notes (body) VALUES ('n')");
      const notes = l.state.deps.db.tables.notes;
      assertEquals(
        await l.state.deps.db.select({ body: notes.body }).from(notes),
        [{ body: "n" }],
      );
    }),
});

Deno.test({
  ...testOpts,
  name: "define, remove, rename, undo and redo keep the runner in step",
  fn: () =>
    withLinked(async (l) => {
      await tool(l.kernel, "define_function", {
        name: "double",
        source: FN_DOUBLE,
      });
      await tool(l.kernel, "define_function", {
        name: "quad",
        source: FN_QUAD,
      });
      await assertInStep(l);
      assertEquals(l.state.function("quad")?.(1), 4);

      await tool(l.kernel, "define_function", {
        name: "double",
        source: "function double(x: number): number { return x * 3; }",
      });
      await assertInStep(l);
      assertEquals(l.state.function("quad")?.(1), 9);

      await tool(l.kernel, "remove_entity", { type: "function", key: "quad" });
      await assertInStep(l);
      assertEquals(l.state.function("quad"), undefined);

      await tool(l.kernel, "apply_rename", {
        turnId: "rename_double",
        edits: [],
        rename: {
          entityType: "function",
          from: "double",
          to: "twice",
          source: "function twice(x: number): number { return x * 2; }",
        },
      });
      await assertInStep(l);
      assertEquals(l.state.function("double"), undefined);
      assertEquals(l.state.function("twice")?.(5), 10);

      await tool(l.kernel, "undo_turn", {});
      await assertInStep(l);
      assertEquals(l.state.function("twice"), undefined);
      assertEquals(l.state.function("double")?.(1), 3);

      await tool(l.kernel, "redo_turn", {});
      await assertInStep(l);
      assertEquals(l.state.function("twice")?.(5), 10);
    }),
});

Deno.test({
  ...testOpts,
  name: "a snapshot restore and a project load keep the runner in step",
  fn: () =>
    withLinked(async (l) => {
      await defineEverything(l.kernel);
      const snapshot = await l.kernel.snapshots.save(l.kernel, "before");
      await tool(l.kernel, "remove_entity", { type: "handler", key: "hello" });
      await tool(l.kernel, "set_config", { name: "greeting", value: "yo" });
      await assertInStep(l);
      assertEquals(l.state.handler("hello"), undefined);

      const restored = await l.kernel.snapshots.restore(
        snapshot.id,
        l.kernel,
        noop,
      );
      assert(restored.ok);
      await assertInStep(l);
      assert(l.state.handler("hello"));
      assertEquals(l.state.deps.config.get("greeting"), "hi");

      // A project load, and a task fork's (core/tasks/fork.ts), both go
      // through loadKernelState into a kernel the runner already mirrors.
      const dir = mkdtempSync(join(tmpdir(), "mirror-load-"));
      const db = await Database.create({ driver: "pglite" });
      try {
        saveKernelState(l.kernel, dir);
        const loaded = new Kernel(db);
        const mirror = new StateMirror(loaded, rpcStateChannel(l.kernelPeer));
        await synced(mirror);
        const result = await loadKernelState(loaded, dir, noop);
        assertEquals(result.errors, []);
        await assertInStep({ ...l, kernel: loaded, mirror });
        assertEquals(l.state.function("quad")?.(1), 4);
      } finally {
        await db.close();
        rmSync(dir, { recursive: true, force: true });
      }
    }),
});

Deno.test({
  ...testOpts,
  name: "env changes reach the runner: a secret set and cleared, an .env edit",
  fn: () =>
    withLinked(async (l) => {
      const env = l.state.deps.env;
      l.kernel.secrets.define("API_TOKEN");
      l.kernel.secrets.setValue("API_TOKEN", "s3cret");
      l.kernel.env.set("MODE", "dev");
      await assertInStep(l);
      assertEquals(env.API_TOKEN, "s3cret");
      assertEquals(env.MODE, "dev");

      l.kernel.secrets.clearValue("API_TOKEN");
      l.kernel.env.set("MODE", "prod");
      await assertInStep(l);
      assertEquals(env.API_TOKEN, undefined);
      assertEquals(env.MODE, "prod");
      assertEquals(Object.keys(env), ["MODE"]);
    }),
});

Deno.test({
  ...testOpts,
  name: "a registry edited directly, with no tool involved, is picked up",
  fn: () =>
    withLinked(async (l) => {
      await assertInStep(l);
      l.kernel.functions.register(
        "direct",
        "function direct() { return 1; }",
        () => 0,
      );
      l.kernel.configs.set("flag", { on: true });
      await assertInStep(l);
      assertEquals(l.state.function("direct")?.(), 1);
      assertEquals(l.state.deps.config.get("flag"), { on: true });
    }),
});

Deno.test({
  ...testOpts,
  name: "an unchanged entry isn't sent again; a changed one is sent alone",
  fn: () =>
    withLinked(async (l) => {
      await defineEverything(l.kernel);
      assert((await synced(l.mirror)).sent > 0);
      assertEquals(await synced(l.mirror), {
        sent: 0,
        removed: 0,
        failures: [],
      });
      l.kernel.configs.set("greeting", "hey");
      assertEquals(await synced(l.mirror), {
        sent: 1,
        removed: 0,
        failures: [],
      });
    }),
});

Deno.test({
  ...testOpts,
  name: "a broken entry is reported once, and sent again only when it changes",
  fn: () =>
    withLinked(async (l) => {
      l.kernel.functions.register(
        "bad",
        "function bad() { return 1; }",
        () => 0,
      );
      await assertInStep(l);
      assertEquals(l.state.function("bad")?.(), 1);

      // Won't transpile: the kernel reports it, and the runner drops its copy.
      l.kernel.functions.register("bad", "function bad( {", () => 0);
      const first = await synced(l.mirror);
      assertEquals(first.failures.map((f) => [f.key, f.error.code]), [
        ["bad", "COMPILATION_ERROR"],
      ]);
      assertEquals(l.state.function("bad"), undefined);
      assertEquals(await synced(l.mirror), {
        sent: 0,
        removed: 0,
        failures: [],
      });
      await assertInStep(l);

      // Transpiles, but throws as it loads: the runner reports it.
      l.kernel.functions.register(
        "bad",
        "throw new Error('at load'); function bad() {}",
        () => 0,
      );
      const second = await synced(l.mirror);
      assertEquals(second.failures.map((f) => [f.key, f.error.code]), [
        ["bad", "RUNTIME_ERROR"],
      ]);
      assertEquals(await synced(l.mirror), {
        sent: 0,
        removed: 0,
        failures: [],
      });
      await assertInStep(l);

      l.kernel.functions.register(
        "bad",
        "function bad() { return 2; }",
        () => 0,
      );
      assertEquals((await synced(l.mirror)).failures, []);
      assertEquals(l.state.function("bad")?.(), 2);
    }),
});

Deno.test({
  ...testOpts,
  name: "two syncs started together send each change once",
  fn: () =>
    withLinked(async (l) => {
      await defineEverything(l.kernel);
      const [a, b] = await Promise.all([l.mirror.sync(), l.mirror.sync()]);
      assert(a.ok && b.ok);
      assert(a.data.sent > 0);
      assertEquals(b.data.sent, 0);
      await assertInStep(l);
    }),
});

Deno.test({
  ...testOpts,
  name:
    "after a failed send or a reset, the mirror asks the runner what it holds",
  fn: () =>
    withLinked(async (l) => {
      const real = rpcStateChannel(l.kernelPeer);
      let failNextSync = false;
      let asked = 0;
      const channel: RunnerStateChannel = {
        sync: (request) => {
          if (!failNextSync) return real.sync(request);
          failNextSync = false;
          return Promise.resolve({
            ok: false,
            error: { code: "RUNNER_CLOSED", message: "gone" },
          });
        },
        manifest: () => {
          asked++;
          return real.manifest();
        },
      };
      const mirror = new StateMirror(l.kernel, channel);
      l.kernel.configs.set("a", 1);
      l.kernel.configs.set("b", 2);
      await synced(mirror);
      assertEquals(asked, 1);

      l.kernel.configs.set("a", 3);
      failNextSync = true;
      assert(!(await mirror.sync()).ok);
      assertEquals(await synced(mirror), { sent: 1, removed: 0, failures: [] });
      assertEquals(asked, 2);

      mirror.reset();
      assertEquals(await synced(mirror), { sent: 0, removed: 0, failures: [] });
      assertEquals(asked, 3);
      await assertInStep({ ...l, mirror });
    }),
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

// runner.ts is what runner-main.ts loads, state included.
Deno.test("the runner loads no transpiler and no database driver", async () => {
  const loaded = await importedSpecifiers("./runner.ts");
  for (
    const pkg of ["esbuild", "typescript", "@electric-sql/pglite", "postgres"]
  ) {
    assert(!loaded.some((s) => s.startsWith(`npm:/${pkg}@`)), pkg);
  }
});
