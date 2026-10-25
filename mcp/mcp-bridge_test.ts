import { assert, assertEquals } from "@std/assert";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { initCompiler, stopCompiler } from "../core/compiler.ts";
import { startControlServer } from "../core/control-server.ts";
import { createProject } from "../core/project-manager.ts";
import { unloadProject } from "../core/project-loader.ts";
import { isProjectLockHeld } from "../core/project-lock.ts";
import { readServerToken } from "../core/server-token.ts";
import { testComposition } from "../cli/test-composition.ts";
import { locateServe, type SpawnedServe } from "../core/serve-process.ts";
import { proxyMcp } from "./mcp-bridge.ts";
import { mountMcpRoutes } from "./mcp-mount.ts";
import { isolateHome } from "../core/test-home_test.ts";

isolateHome();

const testOpts = { sanitizeResources: false, sanitizeOps: false };
const FAST = { timeoutMs: 1_000, pollMs: 10 };

function tempProject(name: string): { dir: string; cleanup: () => void } {
  const parent = mkdtempSync(join(tmpdir(), "genie-mcp-bridge-"));
  return {
    dir: createProject(parent, name).path,
    cleanup: () => rmSync(parent, { recursive: true, force: true }),
  };
}

function noSpawn(): SpawnedServe {
  throw new Error("must not spawn");
}

Deno.test(
  "proxyMcp relays to serve and exits on disconnect or loss",
  testOpts,
  async () => {
    await initCompiler();
    const a = tempProject("Bridge Proxy A");
    const b = tempProject("Bridge Proxy B");
    const control = await startControlServer(null, 0, {
      composition: testComposition(),
      projectAppPort: 0,
      mountRoutes: [mountMcpRoutes],
    });
    const url = `http://127.0.0.1:${control.server.addr.port}/mcp`;
    const bridge = async () => {
      const [clientSide, bridgeSide] = InMemoryTransport.createLinkedPair();
      const exit = proxyMcp(bridgeSide, url, readServerToken(a.dir)!);
      const client = new Client({ name: "bridge-test", version: "0.0.0" });
      await client.connect(clientSide);
      return { client, exit };
    };
    try {
      await control.setProject.open(a.dir);

      // The client hangs up: clean exit.
      const first = await bridge();
      const { tools } = await first.client.listTools();
      assert(tools.length > 0);
      await first.client.close();
      assertEquals(await first.exit, 0);

      // A probe before initialize (Claude Desktop's server/discover) gets
      // "method not found" from the bridge instead of killing it, and the
      // client's initialize still goes through.
      const [probeSide, probeBridge] = InMemoryTransport.createLinkedPair();
      const probeExit = proxyMcp(probeBridge, url, readServerToken(a.dir)!);
      const replies: unknown[] = [];
      probeSide.onmessage = (m: unknown) => void replies.push(m);
      await probeSide.start();
      await probeSide.send({
        jsonrpc: "2.0",
        id: "probe",
        method: "server/discover",
        params: {},
      });
      await new Promise((r) => setTimeout(r, 50));
      assertEquals(
        (replies[0] as { error?: { code: number } }).error?.code,
        -32601,
      );
      probeSide.onmessage = undefined;
      const probed = new Client({ name: "bridge-test", version: "0.0.0" });
      await probed.connect(probeSide);
      assert((await probed.listTools()).tools.length > 0);
      await probed.close();
      assertEquals(await probeExit, 0);

      // Serve drops the session (a project switch does): the bridge fails, so
      // the client sees its server die and restarts it.
      const second = await bridge();
      await second.client.listTools();
      await control.setProject.open(b.dir);
      assertEquals(await second.exit, 1);
    } finally {
      const ctx = control.setProject.current();
      if (ctx) await unloadProject(ctx);
      await control.server.shutdown();
      stopCompiler();
      a.cleanup();
      b.cleanup();
    }
  },
);

Deno.test(
  "locateServe starts a real serve process and attaches",
  testOpts,
  async () => {
    const { dir, cleanup } = tempProject("Bridge Spawn");
    let pid: number | null = null;
    try {
      const found = await locateServe(dir);
      assert(found.ok, found.ok ? "" : found.error.message);
      pid = found.data.pid;
      assert(found.data.started);
      assertEquals(found.data.started.pid, pid);

      // A second bridge attaches to it rather than starting another.
      const again = await locateServe(dir, { ...FAST, spawn: noSpawn });
      assert(again.ok);
      assertEquals(again.data.url, found.data.url);
    } finally {
      if (pid !== null) {
        Deno.kill(pid, "SIGTERM");
        while (isProjectLockHeld(dir)) {
          await new Promise((r) => setTimeout(r, 100));
        }
      }
      cleanup();
    }
  },
);
