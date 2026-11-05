// The boundary, proved in real child processes: a green unit suite says
// nothing about isolation, this does. Spawns real Deno children with the
// runner's flags and environment.

import { assert, assertEquals } from "@std/assert";
import { join } from "node:path";
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
