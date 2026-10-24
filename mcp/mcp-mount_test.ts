import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { initCompiler, stopCompiler } from "../core/compiler.ts";
import {
  type ControlServer,
  startControlServer,
} from "../core/control-server.ts";
import { createProject } from "../core/project-manager.ts";
import { unloadProject } from "../core/project-loader.ts";
import { readLockHolder } from "../core/project-lock.ts";
import { readServerToken, serverTokenPath } from "../core/server-token.ts";
import { testComposition } from "../cli/test-composition.ts";
import { mountMcpRoutes } from "./mcp-mount.ts";
import { isolateHome } from "../core/test-home_test.ts";

isolateHome();

const testOpts = { sanitizeResources: false, sanitizeOps: false };

// A control server with only the MCP mounter, in launcher mode, plus two fresh
// projects to open on it.
async function withServe(
  fn: (
    control: ControlServer,
    mcpUrl: URL,
    projects: { a: string; b: string },
  ) => Promise<void>,
): Promise<void> {
  await initCompiler();
  const parent = mkdtempSync(join(tmpdir(), "genie-mcp-mount-"));
  const a = createProject(parent, "Mount A").path;
  const b = createProject(parent, "Mount B").path;
  const control = await startControlServer(null, 0, {
    composition: testComposition(),
    projectAppPort: 0,
    mountRoutes: [mountMcpRoutes],
  });
  try {
    await fn(
      control,
      new URL(`http://127.0.0.1:${control.server.addr.port}/mcp`),
      { a, b },
    );
  } finally {
    const ctx = control.setProject.current();
    if (ctx) await unloadProject(ctx);
    await control.server.shutdown();
    stopCompiler();
    rmSync(parent, { recursive: true, force: true });
  }
}

function initialize(headers: Record<string, string> = {}): RequestInit {
  return {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "accept": "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "mount-test", version: "0.0.0" },
      },
    }),
  };
}

async function errorCode(res: Response): Promise<string | undefined> {
  const body = await res.json();
  return body.error?.data?.code;
}

async function connect(url: URL, token: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: "mount-test", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

Deno.test({
  ...testOpts,
  name: "/mcp on serve: 403 foreign origin, 503 with no project",
  fn: async () => {
    await withServe(async (_control, url) => {
      const foreign = await fetch(
        url,
        initialize({ origin: "https://evil.com" }),
      );
      assertEquals(foreign.status, 403);
      assertEquals(await errorCode(foreign), "FORBIDDEN");

      const launcher = await fetch(url, initialize());
      assertEquals(launcher.status, 503);
      assertEquals(await errorCode(launcher), "NO_PROJECT");
    });
  },
});

Deno.test({
  ...testOpts,
  name: "/mcp on serve: open advertises port + token; 401 without it",
  fn: async () => {
    await withServe(async (control, url, { a }) => {
      await control.setProject.open(a);

      const holder = readLockHolder(a);
      assertEquals(holder?.role, "serve");
      assertEquals(holder?.controlPort, control.server.addr.port);
      const token = readServerToken(a);
      assert(token, "the token file should exist once a project is open");
      assertEquals(statSync(serverTokenPath(a)).mode & 0o777, 0o600);

      const anonymous = await fetch(url, initialize());
      assertEquals(anonymous.status, 401);
      assertEquals(await errorCode(anonymous), "UNAUTHORIZED");

      const client = await connect(url, token);
      try {
        const { tools } = await client.listTools();
        assert(
          tools.some((t: { name: string }) => t.name === "create_changeset"),
        );
      } finally {
        await client.close();
      }
    });
  },
});

Deno.test({
  ...testOpts,
  name: "/mcp on serve: a project switch ends sessions and rotates the token",
  fn: async () => {
    await withServe(async (control, url, { a, b }) => {
      await control.setProject.open(a);
      const tokenA = readServerToken(a)!;
      const client = await connect(url, tokenA);
      try {
        await client.listTools();

        await control.setProject.open(b);
        assertEquals(readServerToken(a), null, "A's token goes with A");
        const tokenB = readServerToken(b);
        assert(tokenB);
        assertNotEquals(tokenB, tokenA);

        // The old session captured A's kernel. It is gone, and A's token no
        // longer opens anything.
        let failed = false;
        try {
          await client.listTools();
        } catch {
          failed = true;
        }
        assert(failed, "a session from before the switch must not survive it");
        const stale = await fetch(
          url,
          initialize({ authorization: `Bearer ${tokenA}` }),
        );
        assertEquals(stale.status, 401);
        await stale.body?.cancel();

        const fresh = await connect(url, tokenB);
        await fresh.listTools();
        await fresh.close();
      } finally {
        await client.close().catch(() => {});
      }
    });
  },
});
