import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { initCompiler, stopCompiler } from "../core/compiler.ts";
import { startControlServer } from "../core/control-server.ts";
import { createProject } from "../core/project-manager.ts";
import { unloadProject } from "../core/project-loader.ts";
import { readServerToken } from "../core/server-token.ts";
import { testComposition } from "../cli/test-composition.ts";
import { generalGuide } from "../core/agent-guide.ts";
import { mountMcpRoutes } from "./mcp-mount.ts";
import { projectedMcpTools } from "./mcp-projection.ts";
import {
  listApps,
  runWorkspace,
  WORKSPACE_TOOLS,
  type WorkspaceMemory,
  type WorkspaceOptions,
} from "./mcp-workspace.ts";
import { isolateHome } from "../core/test-home_test.ts";

isolateHome();

const testOpts = { sanitizeResources: false, sanitizeOps: false };

interface CallResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

function text(result: unknown): string {
  return (result as CallResult).content.map((c) => c.text ?? "").join("\n");
}

function memory(start: string | null = null) {
  const written: string[] = [];
  const mem: WorkspaceMemory = {
    read: () => start,
    write: (_folder, app) => void written.push(app),
  };
  return { mem, written };
}

Deno.test("listApps lists only the project folders directly inside", () => {
  const folder = mkdtempSync(join(tmpdir(), "genie-mcp-ws-list-"));
  try {
    createProject(folder, "Zed App");
    createProject(folder, "Alpha");
    Deno.mkdirSync(join(folder, "not-an-app"));
    assertEquals(listApps(folder), ["alpha", "zed-app"]);
    assertEquals(listApps(join(folder, "missing")), []);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

Deno.test(
  "runWorkspace lists, creates and switches apps in one session",
  testOpts,
  async () => {
    await initCompiler();
    const folder = mkdtempSync(join(tmpdir(), "genie-mcp-ws-"));
    const composition = testComposition();
    const control = await startControlServer(null, 0, {
      composition,
      projectAppPort: 0,
      mountRoutes: [mountMcpRoutes],
    });
    const url = `http://127.0.0.1:${control.server.addr.port}/mcp`;
    const located: string[] = [];
    // Closed in finally too: a client left open after a failed assertion holds
    // serve's SSE stream, and shutting serve down would wait on it forever.
    const clients: Client[] = [];
    const options = (
      eager: boolean,
      mem: WorkspaceMemory,
    ): WorkspaceOptions => ({
      folder,
      eager,
      surface: projectedMcpTools(composition),
      guide: generalGuide(composition),
      // One serve stands in for every app's: opening an app loads it there.
      locate: async (dir) => {
        located.push(dir);
        await control.setProject.open(dir);
        return { ok: true, data: { url, token: readServerToken(dir)! } };
      },
      create: (parent, name) => ({
        ok: true,
        data: createProject(parent, name).path,
      }),
      memory: mem,
    });
    const connect = async (eager: boolean, mem: WorkspaceMemory) => {
      const [clientSide, bridgeSide] = InMemoryTransport.createLinkedPair();
      const exit = runWorkspace(bridgeSide, options(eager, mem));
      const client = new Client({ name: "workspace-test", version: "0.0.0" });
      clients.push(client);
      await client.connect(clientSide);
      return { client, exit };
    };
    const openPath = () => control.setProject.current()?.entry.path;
    const call = (client: Client, name: string, args = {}) =>
      client.callTool({ name, arguments: args });

    try {
      // Named folder, nothing open: the whole surface is listed, and a project
      // tool says how to open an app.
      const { mem, written } = memory();
      const eager = await connect(true, mem);
      const listed = (await eager.client.listTools()).tools.map((
        t: { name: string },
      ) => t.name);
      assertEquals(
        listed.length,
        WORKSPACE_TOOLS.length + projectedMcpTools(composition).length,
      );
      assert(listed.includes("project_status"));
      assertStringIncludes(
        eager.client.getInstructions() ?? "",
        "No app is open yet",
      );
      const closed = await call(eager.client, "project_status");
      assert(closed.isError);
      assertStringIncludes(text(closed), "No app is open");
      // show_app's page is served with nothing open; the tool itself isn't.
      const { resources } = await eager.client.listResources();
      assertEquals(resources.length, 1);
      const read = await eager.client.readResource({ uri: resources[0]!.uri });
      assertEquals(read.contents[0]!.mimeType, "text/html;profile=mcp-app");
      const shown = await call(eager.client, "show_app");
      assert(shown.isError);
      assertStringIncludes(text(shown), "No app is open");

      // new_project creates and opens it; project tools then reach it.
      const created = await call(eager.client, "new_project", {
        name: "Alpha",
      });
      assert(!created.isError, text(created));
      assertStringIncludes(text(created), "Created and opened alpha");
      const alpha = await call(eager.client, "project_status");
      assert(!alpha.isError, text(alpha));
      assertEquals(openPath(), join(folder, "alpha"));

      // open_project switches the same session to another app.
      createProject(folder, "Beta");
      const opened = await call(eager.client, "open_project", { name: "beta" });
      assert(!opened.isError, text(opened));
      const beta = await call(eager.client, "project_status");
      assert(!beta.isError, text(beta));
      assertEquals(openPath(), join(folder, "beta"));
      assertEquals(written, ["alpha", "beta"]);

      const missing = await call(eager.client, "open_project", {
        name: "nope",
      });
      assert(missing.isError);
      assertStringIncludes(text(missing), "Apps in");

      const apps = JSON.parse(text(await call(eager.client, "list_projects")));
      assertEquals(apps.open, "beta");
      assertEquals(apps.apps.map((a: { name: string }) => a.name), [
        "alpha",
        "beta",
      ]);
      await eager.client.close();
      assertEquals(await eager.exit, 0);

      // The directory a client started in: only the app tools, until one is
      // open; then the client is told the list changed.
      const lean = await connect(false, memory().mem);
      assertEquals(
        (await lean.client.listTools()).tools.map((t: { name: string }) =>
          t.name
        ),
        WORKSPACE_TOOLS.map((t) => t.name),
      );
      const changed = new Promise<void>((resolve) =>
        lean.client.setNotificationHandler(
          ToolListChangedNotificationSchema,
          () => resolve(),
        )
      );
      await call(lean.client, "open_project", { name: "alpha" });
      await changed;
      assert((await lean.client.listTools()).tools.length > 3);
      await lean.client.close();
      assertEquals(await lean.exit, 0);

      // A restart reopens the app last opened, before answering initialize.
      located.length = 0;
      const again = await connect(true, memory("beta").mem);
      assertEquals(located, [join(folder, "beta")]);
      assertStringIncludes(
        again.client.getInstructions() ?? "",
        "The open app is beta",
      );
      const status = await call(again.client, "project_status");
      assert(!status.isError, text(status));
      assertEquals(openPath(), join(folder, "beta"));
      await again.client.close();
      assertEquals(await again.exit, 0);
    } finally {
      for (const client of clients) await client.close().catch(() => {});
      const ctx = control.setProject.current();
      if (ctx) await unloadProject(ctx);
      await control.server.shutdown();
      stopCompiler();
      rmSync(folder, { recursive: true, force: true });
    }
  },
);

Deno.test("open_project reports why an app's server couldn't start", async () => {
  const folder = mkdtempSync(join(tmpdir(), "genie-mcp-ws-fail-"));
  try {
    createProject(folder, "Broken");
    const [clientSide, bridgeSide] = InMemoryTransport.createLinkedPair();
    const exit = runWorkspace(bridgeSide, {
      folder,
      eager: true,
      surface: [],
      guide: "",
      locate: () =>
        Promise.resolve({
          ok: false,
          error: { code: "SERVE_START_FAILED", message: "serve exited early" },
        }),
      create: () => ({
        ok: false,
        error: { code: "NO", message: "not here" },
      }),
      memory: memory().mem,
    });
    const client = new Client({ name: "workspace-test", version: "0.0.0" });
    await client.connect(clientSide);
    const opened = await client.callTool({
      name: "open_project",
      arguments: { name: "broken" },
    });
    assert(opened.isError);
    assertStringIncludes(text(opened), "serve exited early");
    const created = await client.callTool({
      name: "new_project",
      arguments: { name: "x" },
    });
    assert(created.isError);
    assertStringIncludes(text(created), "not here");
    await client.close();
    assertEquals(await exit, 0);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
