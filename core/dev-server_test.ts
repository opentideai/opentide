import { assert, assertEquals } from "@std/assert";
import { join } from "node:path";
import { rmSync, writeFileSync } from "node:fs";
import { Kernel } from "./registries.ts";
import { Database } from "./db.ts";
import type { AppServer } from "./app-server.ts";
import { DevServerManager, resolveDevRunConfig } from "./dev-server.ts";
import {
  createProject,
  PROJECT_MODE_SOURCE_BACKED,
  removeProject,
  writeProjectMode,
} from "./project-manager.ts";
import { createEmptyCodebaseGraph } from "./codebase/types.ts";
import { isolateHome, TEST_TMP_DIR } from "./test-home_test.ts";

isolateHome();

const testOpts = { sanitizeResources: false, sanitizeOps: false };

// A minimal AppServer stand-in: DevServerManager only ever calls setProxy /
// clearProxy, so we spy those and stub the rest of the interface.
function spyAppServer() {
  const state = {
    proxyPort: null as number | null,
    setCalls: 0,
    clearCalls: 0,
  };
  const server: AppServer = {
    rebuild() {},
    restart() {},
    async shutdown() {},
    setProxy(port: number) {
      state.proxyPort = port;
      state.setCalls++;
    },
    clearProxy() {
      state.proxyPort = null;
      state.clearCalls++;
    },
    rebind(p: number) {
      return Promise.resolve(p);
    },
    get port() {
      return 0;
    },
    get listening() {
      return false;
    },
  };
  return { server, state };
}

function pidAlive(pid: number): boolean {
  try {
    // Signal 0 probes existence without delivering a signal.
    Deno.kill(pid, "SIGCONT");
    return true;
  } catch {
    return false;
  }
}

async function makeKernel(): Promise<{ kernel: Kernel; db: Database }> {
  const db = await Database.create({ driver: "pglite" });
  return { kernel: new Kernel(db), db };
}

// A trivial "dev server": a Deno.serve HTTP script that binds the PORT env the
// manager hints, and responds with a recognizable body.
function writeFixtureDevScript(dir: string): string {
  const scriptPath = join(dir, "fixture-dev-server.ts");
  writeFileSync(
    scriptPath,
    `const port = Number(Deno.env.get("PORT"));
Deno.serve({ port, onListen: () => console.log("listening on http://localhost:" + port) }, () =>
  new Response("hello from fixture dev server"));
`,
  );
  return scriptPath;
}

Deno.test({
  ...testOpts,
  name:
    "DevServerManager: start detects the port, proxies, serves, and stops clean",
  fn: async () => {
    const baseDir = await Deno.makeTempDir({
      dir: TEST_TMP_DIR,
      prefix: "tideide-devserver-run-",
    });
    const { kernel, db } = await makeKernel();
    const { server, state } = spyAppServer();
    const manager = new DevServerManager(kernel, server, baseDir);
    try {
      const scriptPath = writeFixtureDevScript(baseDir);
      // Auto-port path: no configured port ⇒ the manager picks a free one, hints
      // it via PORT, and detects it by probing.
      const started = await manager.start({
        command: `deno run --allow-net --allow-env ${scriptPath}`,
      });
      assert(started.ok, `start should succeed: ${JSON.stringify(started)}`);
      if (!started.ok) return;

      const port = started.data.detectedPort;
      assert(port !== null && port > 0, "a port should be detected");
      assertEquals(started.data.running, true);
      assertEquals(started.data.proxied, true);
      // The preview listener was pointed at the detected child port.
      assertEquals(state.setCalls, 1);
      assertEquals(state.proxyPort, port);

      // The child actually serves through its own port.
      const res = await fetch(`http://127.0.0.1:${port}/`);
      const body = await res.text();
      assertEquals(body, "hello from fixture dev server");

      const childPid = started.data.pid;
      assert(childPid !== null, "a child pid should be recorded");

      const stopped = await manager.stop();
      assert(stopped.ok, "stop should succeed");
      assertEquals(manager.running, false);
      assertEquals(manager.status().detectedPort, null);
      // The proxy was cleared on stop.
      assertEquals(state.clearCalls, 1);

      // No child survives stop.
      assertEquals(pidAlive(childPid!), false);
    } finally {
      await manager.shutdown();
      await db.close();
      removeProject(baseDir);
      rmSync(baseDir, { recursive: true, force: true });
    }
  },
});

Deno.test({
  ...testOpts,
  name:
    "resolveDevRunConfig: registry-native never resolves a command (mode gating)",
  fn: async () => {
    const baseDir = await Deno.makeTempDir({
      dir: TEST_TMP_DIR,
      prefix: "tideide-devserver-gate-",
    });
    const { kernel, db } = await makeKernel();
    try {
      // createProject defaults to registry-native.
      const entry = createProject(baseDir, "Native App");

      // Even with a dev command available in the graph, a registry-native project
      // is refused — it can never auto-spawn.
      const graph = createEmptyCodebaseGraph(entry.path, entry.path);
      graph.commands.push({
        id: "command:dev:dev",
        kind: "command",
        name: "dev",
        commandKind: "dev",
        command: "npm run dev",
        cwd: entry.path,
        packageManager: "npm",
        source: { pluginId: "test", method: "manifest", inferred: false },
        confidence: 0.95,
        locations: [{ file: "package.json", startLine: 1, startColumn: 1 }],
      });
      kernel.codebaseGraph = graph;

      const gated = resolveDevRunConfig(kernel, entry.path);
      assertEquals(gated.ok, false);
      if (!gated.ok) assertEquals(gated.error.code, "MODE_NOT_SOURCE_BACKED");

      // Flip to source-backed: now the graph dev command resolves.
      assertEquals(
        writeProjectMode(entry.path, PROJECT_MODE_SOURCE_BACKED).ok,
        true,
      );
      const resolved = resolveDevRunConfig(kernel, entry.path);
      assert(resolved.ok, "source-backed should resolve the dev command");
      if (resolved.ok) {
        assertEquals(resolved.data.command, "npm run dev");
        assertEquals(resolved.data.cwd, entry.path);
      }

      // Explicit command wins over the graph, and is honored.
      const explicit = resolveDevRunConfig(kernel, entry.path, {
        command: "deno task dev",
      });
      assert(explicit.ok);
      if (explicit.ok) assertEquals(explicit.data.command, "deno task dev");
    } finally {
      await db.close();
      removeProject(baseDir);
      rmSync(baseDir, { recursive: true, force: true });
    }
  },
});

Deno.test({
  ...testOpts,
  name: "resolveDevRunConfig: source-backed with no command is an error",
  fn: async () => {
    const baseDir = await Deno.makeTempDir({
      dir: TEST_TMP_DIR,
      prefix: "tideide-devserver-nocmd-",
    });
    const { kernel, db } = await makeKernel();
    try {
      const entry = createProject(baseDir, "Empty Source App");
      writeProjectMode(entry.path, PROJECT_MODE_SOURCE_BACKED);
      // No graph, no persisted config, no explicit command.
      const resolved = resolveDevRunConfig(kernel, entry.path);
      assertEquals(resolved.ok, false);
      if (!resolved.ok) {
        assertEquals(resolved.error.code, "DEV_COMMAND_UNKNOWN");
      }
    } finally {
      await db.close();
      removeProject(baseDir);
      rmSync(baseDir, { recursive: true, force: true });
    }
  },
});
