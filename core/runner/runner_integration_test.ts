// The boundary, proved in real child processes: a green unit suite says
// nothing about isolation, this does. Spawns real Deno children with the
// runner's flags and environment.

import { assert, assertEquals } from "@std/assert";
import { join } from "node:path";
import { createAppServer } from "../app-server.ts";
import { initCompiler, stopCompiler } from "../compiler.ts";
import { APP_PORT_AUTO } from "../config.ts";
import { Database } from "../db.ts";
import { Kernel } from "../registries.ts";
import { dispatchTool } from "../tools/dispatch.ts";
import { userConfigDir } from "../user-config-dir.ts";
import {
  hostInterfaceAddresses,
  runnerEnv,
  runnerPermissionFlags,
} from "./permissions.ts";
import {
  denoCacheDirs,
  denoSpawn,
  openTideConfigPath,
  RunnerHost,
  runnerScriptPath,
} from "./runner-host.ts";
import { RUNNER_METHODS, RUNNER_PROTOCOL_VERSION } from "./protocol.ts";

const PROJECT_VAR = "APP_GREETING";
// Deno sets these itself in every process: its node shim dir on PATH.
const DENO_OWN_VARS = ["DENO_NODE_SHIM_ACTIVE", "PATH"];
const PROBE = new URL("./testdata/boundary-probe.ts", import.meta.url).pathname;

async function sandbox() {
  const deno = Deno.execPath();
  const caches = await denoCacheDirs(deno);
  assert(caches.ok, JSON.stringify(caches));
  const projectDir = await Deno.makeTempDir({ prefix: "runner-project-" });
  const scratchDir = join(projectDir, ".opentide", "caches", "runner");
  await Deno.mkdir(scratchDir, { recursive: true });
  await Deno.writeTextFile(join(projectDir, ".opentide", "kernel.token"), "t");
  await Deno.writeTextFile(join(projectDir, ".env"), "SECRET=1\n");
  const flags = runnerPermissionFlags({
    cacheDirs: [caches.data.denoDir, caches.data.npmCache],
    scratchDir,
    configFile: openTideConfigPath(),
    interfaceAddresses: hostInterfaceAddresses(),
  });
  assert(flags.ok);
  return {
    deno,
    projectDir,
    scratchDir,
    denoDir: caches.data.denoDir,
    flags: flags.data,
    env: runnerEnv({ [PROJECT_VAR]: "hi" }, {
      denoDir: caches.data.denoDir,
      scratchDir,
    }),
    cleanup: () => Deno.remove(projectDir, { recursive: true }),
  };
}

// A non-loopback address of this machine, which the runner must not reach
// either: a kernel bound to the tailnet IP lives there.
function interfaceAddress(): string {
  const v4 = Deno.networkInterfaces().find((i) =>
    i.family === "IPv4" && !i.address.startsWith("127.")
  );
  return v4?.address ?? "127.0.0.1";
}

Deno.test("the real runner starts under its own flags, pings and exits", async () => {
  const box = await sandbox();
  try {
    const started = await RunnerHost.spawn({
      spawn: denoSpawn,
      spec: {
        command: box.deno,
        args: ["run", ...box.flags, runnerScriptPath()],
        env: box.env,
        cwd: box.scratchDir,
      },
    });
    assert(started.ok, JSON.stringify(started));
    const host = started.data;
    assertEquals(host.ready.protocolVersion, RUNNER_PROTOCOL_VERSION);
    assert(host.ready.pid !== Deno.pid);
    const ping = await host.request(RUNNER_METHODS.ping, null);
    assert(ping.ok);
    assertEquals(await host.stop(), { code: 0, signal: null });
  } finally {
    await box.cleanup();
  }
});

Deno.test("under the runner's flags, keys, shell, loopback and the cache are out of reach", async () => {
  const box = await sandbox();
  // Bound to 0.0.0.0, so it answers on loopback and on every interface.
  const listener = Deno.serve(
    { hostname: "0.0.0.0", port: 0, onListen: () => {} },
    () => new Response("reached"),
  );
  try {
    const out = await new Deno.Command(box.deno, {
      args: [
        "run",
        ...box.flags,
        PROBE,
        join(userConfigDir(), "config.json"),
        box.projectDir,
        box.denoDir,
        box.scratchDir,
        String(listener.addr.port),
        interfaceAddress(),
      ],
      env: box.env,
      cwd: box.scratchDir,
      clearEnv: true,
      stdout: "piped",
      stderr: "piped",
    }).output();
    const stderr = new TextDecoder().decode(out.stderr);
    assert(out.success, stderr);
    const { results, env } = JSON.parse(
      new TextDecoder().decode(out.stdout),
    );
    const denied = { ...results };
    delete denied.writeScratch;
    for (const [what, outcome] of Object.entries(denied)) {
      assertEquals(outcome, "NotCapable", `${what}: ${outcome}`);
    }
    assertEquals(results.writeScratch, "allowed");
    assertEquals(
      Object.keys(env).filter((k) => !DENO_OWN_VARS.includes(k)).sort(),
      [PROJECT_VAR, "DENO_DIR", "TMPDIR"].sort(),
    );
    const kernelPath = new Set((Deno.env.get("PATH") ?? "").split(":"));
    for (const entry of String(env.PATH ?? "").split(":")) {
      assert(!kernelPath.has(entry), `kernel PATH entry leaked: ${entry}`);
    }
  } finally {
    await listener.shutdown();
    await box.cleanup();
  }
});

// The same boundary, met by user code: a handler the kernel serves, run in a
// real runner child. And the one loopback user code is allowed, its own app,
// reached through the kernel.
Deno.test({
  name:
    "a handler in the real runner can't reach keys, shell or loopback, but can reach its app",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const box = await sandbox();
    const other = Deno.serve(
      { hostname: "0.0.0.0", port: 0, onListen: () => {} },
      () => new Response("reached"),
    );
    await initCompiler();
    const db = await Database.create({ driver: "pglite" });
    const kernel = new Kernel(db, {
      userCodeRunner: (peer) =>
        RunnerHost.spawn({
          spawn: denoSpawn,
          spec: {
            command: box.deno,
            args: ["run", ...box.flags, runnerScriptPath()],
            env: box.env,
            cwd: box.scratchDir,
          },
          peer,
        }),
    });
    const app = createAppServer(kernel, APP_PORT_AUTO);
    try {
      const configPath = join(userConfigDir(), "config.json");
      const probe = `async function probe() {
  const attempt = async (fn: () => unknown) => {
    try { await fn(); return "allowed"; }
    catch (err) { return err instanceof Error ? err.name : String(err); }
  };
  log("probed");
  return Response.json({
    readKeys: await attempt(() => Deno.readTextFile(${
        JSON.stringify(configPath)
      })),
    readDotEnv: await attempt(() => Deno.readTextFile(${
        JSON.stringify(join(box.projectDir, ".env"))
      })),
    spawnShell: await attempt(() => new Deno.Command("/bin/sh", { args: ["-c", "id"] }).outputSync()),
    fetchLoopback: await attempt(() => fetch("http://127.0.0.1:${other.addr.port}/").then((r) => r.text())),
  });
}`;
      const handlers: [string, string][] = [
        ["probe", probe],
        ["ping", `function ping() { return new Response("pong"); }`],
      ];
      for (const [name, source] of handlers) {
        const defined = await dispatchTool(
          "define_handler",
          { name, source },
          kernel,
          () => {},
          { manualEdit: true },
        );
        assert(defined.ok, defined.error?.message);
        kernel.routes.register("GET", `/${name}`, name);
      }
      app.rebuild();
      kernel.appPort = app.port;
      const res = await fetch(`http://127.0.0.1:${app.port}/probe`);
      assertEquals(res.status, 200, await res.clone().text());
      assertEquals(await res.json(), {
        readKeys: "NotCapable",
        readDotEnv: "NotCapable",
        spawnShell: "NotCapable",
        fetchLoopback: "NotCapable",
      });
      assertEquals(
        kernel.log.query({ source: "app" }).map((e) => e.message),
        ["probed"],
      );

      const tool = (name: string, input: Record<string, unknown>) =>
        dispatchTool(name, input, kernel, () => {}, { manualEdit: true });
      const defined = await tool("define_test", {
        name: "ownAppTest",
        source: `async function ownAppTest() {
  const res = await fetch(appUrl("/ping"));
  assertEquals(await res.text(), "pong");
}`,
      });
      assert(defined.ok, defined.error?.message);
      const ran = await tool("run_tests", {});
      assert(ran.ok, ran.error?.message);
      const [result] = (ran.data as {
        results: { name: string; passed: boolean; error?: string }[];
      }).results;
      assertEquals(
        { name: result?.name, passed: result?.passed, error: result?.error },
        { name: "ownAppTest", passed: true, error: undefined },
      );
    } finally {
      await app.shutdown();
      await kernel.runtime.dispose?.();
      await db.close();
      stopCompiler();
      await other.shutdown();
      await box.cleanup();
    }
  },
});
