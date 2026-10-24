import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  type CallToolRequest,
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { MCPManager, type MCPServerConfig } from "./mcp.ts";
import { Kernel } from "./registries.ts";
import { Database } from "./db.ts";
import { serveMcpHttp } from "../mcp/mcp-http.ts";
// Full-stack registration (stores + verification/agent tool handlers) so the
// outbound server used as a real fixture advertises and dispatches the tool
// surface. Side-effect import, same as the other MCP tests.
import { testComposition } from "../cli/test-composition.ts";

// Real subprocesses / sockets keep async ops alive briefly past a test's end —
// the same relaxation the other real-transport MCP tests use.
const testOpts = { sanitizeResources: false, sanitizeOps: false };

// The text of a callTool result's content blocks, joined. The inbound callTool
// returns the SDK CallToolResult verbatim (unchanged shape from the hand-rolled
// path), so tests read it exactly as an MCP client would.
function toolText(result: unknown): string {
  const { content } = result as {
    content: Array<{ type: string; text?: string }>;
  };
  return content.filter((b) => b.type === "text").map((b) => b.text ?? "").join(
    "\n",
  );
}

// ---------------------------------------------------------------------------
// Hermetic contract tests: a real SDK Client (inside MCPManager) linked to a
// minimal in-memory SDK Server via the connect() test seam. These pin the
// public naming/resolution contract without a subprocess or socket.
// ---------------------------------------------------------------------------

// A minimal in-memory MCP server advertising the given tool names; every
// tools/call echoes back {name, arguments} as JSON text so a test can prove the
// qualified name routed to the exact underlying tool.
async function inMemoryServer(
  toolNames: string[],
): Promise<{ transport: Transport; close: () => Promise<void> }> {
  const server = new Server(
    { name: "fixture", version: "0.0.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: toolNames.map((name) => ({
      name,
      inputSchema: { type: "object" as const, properties: {} },
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, (req: CallToolRequest) => ({
    content: [{
      type: "text" as const,
      text: JSON.stringify({
        name: req.params.name,
        arguments: req.params.arguments ?? {},
      }),
    }],
  }));
  const [clientTransport, serverTransport] = InMemoryTransport
    .createLinkedPair();
  await server.connect(serverTransport);
  return { transport: clientTransport, close: () => server.close() };
}

const baseConfig = (name: string): MCPServerConfig => ({
  name,
  enabled: true,
  transport: "url",
  url: "http://example.invalid",
});

Deno.test({
  ...testOpts,
  name: "MCP qualified tool names round-trip even with __ in names",
  fn: async () => {
    const mgr = new MCPManager();
    // Both the server name and a tool name contain "__" — the ambiguous case
    // that naive string-splitting got wrong.
    const { transport, close } = await inMemoryServer(["do__thing", "plain"]);
    await mgr.connect(baseConfig("my__server"), transport);

    const names = mgr.getCustomTools().map((t) => t.name).sort();
    assertEquals(names, [
      "mcp__my__server__do__thing",
      "mcp__my__server__plain",
    ]);

    // callTool must route the qualified name back to the exact tool — the echo
    // server proves which underlying tool + args the manager dispatched.
    const result = await mgr.callTool("mcp__my__server__do__thing", { a: 1 });
    assertEquals(JSON.parse(toolText(result)), {
      name: "do__thing",
      arguments: { a: 1 },
    });

    await mgr.closeAll();
    await close().catch(() => {});
  },
});

Deno.test({
  ...testOpts,
  name: "MCP callTool throws on an unknown qualified name",
  fn: async () => {
    const mgr = new MCPManager();
    const { transport, close } = await inMemoryServer(["x"]);
    await mgr.connect(baseConfig("srv"), transport);

    await assertRejects(() => mgr.callTool("mcp__srv__nope", {}));

    await mgr.closeAll();
    await close().catch(() => {});
  },
});

// ---------------------------------------------------------------------------
// Real streamable-HTTP: point MCPManager at a live in-process outbound MCP
// server (serveMcpHttp) — the manager builds a real StreamableHTTPClientTransport
// over a real socket and drives the actual SDK Client. list-tools + call-tool
// round-trip through the outbound projection and core dispatch.
// ---------------------------------------------------------------------------

async function withKernel<T>(fn: (kernel: Kernel) => Promise<T>): Promise<T> {
  const db = await Database.create({ driver: "pglite" });
  const kernel = new Kernel(db, { composition: testComposition() });
  try {
    return await fn(kernel);
  } finally {
    await db.close();
  }
}

async function freePort(): Promise<number> {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  listener.close();
  return port;
}

Deno.test({
  ...testOpts,
  name:
    "MCPManager drives a real external server over streamable-HTTP (list + call)",
  fn: async () => {
    await withKernel(async (kernel) => {
      const port = await freePort();
      const token = "inbound-test-token";
      const server = serveMcpHttp({ kernel, rebuild: () => {} }, port, token);
      const url = `http://127.0.0.1:${server.port}/mcp`;
      const mgr = new MCPManager();
      try {
        await mgr.connect({
          name: "outbound",
          enabled: true,
          transport: "url",
          url,
          authToken: token,
        });
        assertEquals(mgr.getStatus("outbound").status, "connected");

        // The outbound catalog is advertised, qualified under the server name.
        const names = new Set(mgr.getCustomTools().map((t) => t.name));
        assert(
          names.has("mcp__outbound__list_routes"),
          "outbound read verb should be advertised inbound",
        );

        // Register a route, then read it back THROUGH the MCP call path.
        kernel.routes.register(
          "GET",
          "/api/inbound-demo",
          "demo_handler",
          undefined,
          "demo",
        );
        const result = await mgr.callTool("mcp__outbound__list_routes", {});
        assertStringIncludes(toolText(result), "/api/inbound-demo");
      } finally {
        await mgr.closeAll();
        await server.shutdown();
      }
    });
  },
});

// ---------------------------------------------------------------------------
// Real stdio: spawn a minimal standalone SDK stdio MCP server (written to a temp
// file) and connect MCPManager to it — the manager builds a real
// StdioClientTransport and spawns the process. list-tools + call-tool round-trip
// over the pipe, including a tool name with "__".
// ---------------------------------------------------------------------------

// A self-contained stdio MCP server: pinned-version npm specifiers (no import
// map, so it runs from a temp path), one plain tool and one "__"-containing name.
const STDIO_FIXTURE_SRC = `
import { Server } from "npm:@modelcontextprotocol/sdk@1/server/index.js";
import { StdioServerTransport } from "npm:@modelcontextprotocol/sdk@1/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "npm:@modelcontextprotocol/sdk@1/types.js";

const server = new Server(
  { name: "stdio-fixture", version: "0.0.0" },
  { capabilities: { tools: {} } },
);
server.setRequestHandler(ListToolsRequestSchema, () => ({
  tools: [
    { name: "echo", description: "Echo args back.", inputSchema: { type: "object", properties: { value: { type: "string" } } } },
    { name: "greet__user", description: "Name with __.", inputSchema: { type: "object", properties: {} } },
  ],
}));
server.setRequestHandler(CallToolRequestSchema, (req) => ({
  content: [{ type: "text", text: JSON.stringify({ tool: req.params.name, args: req.params.arguments ?? {} }) }],
}));
await server.connect(new StdioServerTransport());
`;

Deno.test({
  ...testOpts,
  name: "MCPManager drives a real external server over stdio (list + call)",
  fn: async () => {
    const fixturePath = await Deno.makeTempFile({ suffix: ".mjs" });
    await Deno.writeTextFile(fixturePath, STDIO_FIXTURE_SRC);
    const mgr = new MCPManager();
    try {
      await mgr.connect({
        name: "stdiofix",
        enabled: true,
        transport: "stdio",
        command: Deno.execPath(),
        args: [
          "run",
          "--allow-read",
          "--allow-env",
          "--allow-sys",
          fixturePath,
        ],
      });
      assertEquals(mgr.getStatus("stdiofix").status, "connected");

      const names = mgr.getCustomTools().map((t) => t.name).sort();
      assertEquals(names, [
        "mcp__stdiofix__echo",
        "mcp__stdiofix__greet__user",
      ]);

      const echoed = await mgr.callTool("mcp__stdiofix__echo", { value: "hi" });
      assertEquals(JSON.parse(toolText(echoed)), {
        tool: "echo",
        args: { value: "hi" },
      });

      // The "__"-containing tool routes correctly over a real transport too.
      const greeted = await mgr.callTool("mcp__stdiofix__greet__user", {});
      assertEquals(JSON.parse(toolText(greeted)).tool, "greet__user");

      await mgr.closeAll();
      assertEquals(mgr.getStatus("stdiofix").status, "disconnected");
    } finally {
      await mgr.closeAll();
      await Deno.remove(fixturePath).catch(() => {});
    }
  },
});
