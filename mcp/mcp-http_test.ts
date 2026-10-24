import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Kernel } from "../core/registries.ts";
import { Database } from "../core/db.ts";
import { initCompiler, stopCompiler } from "../core/compiler.ts";
import { createAppServer } from "../core/app-server.ts";
import { type McpHttpServer, serveMcpHttp } from "./mcp-http.ts";
import type { McpServerDeps } from "./mcp-server.ts";
// The open test composition (stores + verification tool handlers), the same set
// `opentide mcp` carries in production. Each Kernel is built with it.
import { testComposition } from "../cli/test-composition.ts";

const testOpts = { sanitizeResources: false, sanitizeOps: false };
const TEST_TOKEN = "test-token-0123456789abcdef";
const AUTH_HEADER = { authorization: `Bearer ${TEST_TOKEN}` };
const noop = () => {};

async function withKernel<T>(fn: (kernel: Kernel) => Promise<T>): Promise<T> {
  const db = await Database.create({ driver: "pglite" });
  const kernel = new Kernel(db, { composition: testComposition() });
  try {
    return await fn(kernel);
  } finally {
    await db.close();
  }
}

// Like withKernel but with the esbuild compiler up and a live app-server, so a
// route built through MCP dispatch can actually be served and fetched — same
// shape as mcp-projection_test.ts's withServedKernel.
async function withServedKernel<T>(
  fn: (kernel: Kernel, rebuild: () => void, baseUrl: string) => Promise<T>,
): Promise<T> {
  await initCompiler();
  const db = await Database.create({ driver: "pglite" });
  const kernel = new Kernel(db, { composition: testComposition() });
  const port = await freePort();
  const appServer = createAppServer(kernel, port);
  const rebuild = () => appServer.rebuild();
  try {
    return await fn(kernel, rebuild, `http://127.0.0.1:${port}`);
  } finally {
    await appServer.shutdown();
    await db.close();
    stopCompiler();
  }
}

async function freePort(): Promise<number> {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  listener.close();
  return port;
}

// Serve the MCP HTTP transport on a free port for the duration of `fn`.
async function withMcpHttp<T>(
  deps: McpServerDeps,
  fn: (server: McpHttpServer, url: URL) => Promise<T>,
): Promise<T> {
  const port = await freePort();
  const server = serveMcpHttp(deps, port, TEST_TOKEN);
  try {
    return await fn(server, new URL(`http://127.0.0.1:${server.port}/mcp`));
  } finally {
    await server.shutdown();
  }
}

// A real MCP Client over a StreamableHTTPClientTransport pointed at a running
// serveMcpHttp. Returns the transport too so a test can call terminateSession()
// (the client-side DELETE) directly.
async function connectHttpClient(
  url: URL,
): Promise<{
  client: Client;
  transport: StreamableHTTPClientTransport;
  dispose: () => Promise<void>;
}> {
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: AUTH_HEADER },
  });
  const client = new Client({ name: "mcp-http-test-client", version: "0.0.0" });
  await client.connect(transport);
  return {
    client,
    transport,
    dispose: async () => {
      await client.close().catch(() => {});
    },
  };
}

// A minimal valid changeset plan: one "should" criterion (so the completion
// gate's optional model-backed auto-refute never fires — hermetic, no API key)
// and one planned check. Copied from mcp-projection_test.ts.
function demoPlan() {
  return {
    summary: "Add an MCP-built demo route",
    steps: [] as string[],
    acceptanceCriteria: [{
      id: "claim_serves",
      text: "GET /api/mcp-demo returns ok.",
      source: "agent",
      priority: "should",
    }],
    verificationPlan: [{
      id: "check_serves",
      claimIds: ["claim_serves"],
      kind: "e2e",
      description: "Fetch the route and assert a 200 body.",
    }],
  };
}

// Join the text content blocks of a callTool result.
function toolText(result: { content: unknown }): string {
  return (result.content as Array<{ type: string; text?: string }>)
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("\n");
}

// Parse the LAST text block of a callTool result as JSON. create_changeset
// prepends a human-readable note block and puts the changeset JSON last, so the
// changeset object is always the final text block.
function parseLastJson<T>(result: { content: unknown }): T {
  const blocks = result.content as Array<{ type: string; text?: string }>;
  const last = blocks.filter((b) => b.type === "text").at(-1);
  return JSON.parse(last!.text!) as T;
}

// The Slice C gate: a real MCP client over streamable-HTTP — no IDE, no
// integrated agent — lists tools, creates a changeset that reaches in_progress,
// builds a handler + registers a route, and the route serves in the live core.
Deno.test({
  ...testOpts,
  name:
    "MCP over HTTP: list → create → in_progress → build route serves → complete",
  fn: async () => {
    await withServedKernel(async (kernel, rebuild, baseUrl) => {
      await withMcpHttp({ kernel, rebuild }, async (_server, url) => {
        const { client, dispose } = await connectHttpClient(url);
        try {
          const { tools } = await client.listTools();
          const names = new Set(tools.map((t: { name: string }) => t.name));
          for (
            const verb of [
              "create_changeset",
              "define_handler",
              "register_route",
            ]
          ) {
            assert(names.has(verb), `${verb} should be advertised over HTTP`);
          }

          const created = await client.callTool({
            name: "create_changeset",
            arguments: { title: "HTTP demo", plan: demoPlan() },
          });
          assertEquals(created.isError, undefined);
          assertStringIncludes(toolText(created), "auto-approved and started");
          assertStringIncludes(toolText(created), "in_progress");

          const handler = await client.callTool({
            name: "define_handler",
            arguments: {
              name: "mcp_http",
              source:
                `async function mcp_http(c: any) { return c.json({ ok: true, via: "http" }); }`,
            },
          });
          assertEquals(
            handler.isError,
            undefined,
            `define_handler: ${toolText(handler)}`,
          );

          const route = await client.callTool({
            name: "register_route",
            arguments: {
              method: "GET",
              path: "/api/mcp-http",
              handlerName: "mcp_http",
            },
          });
          assertEquals(
            route.isError,
            undefined,
            `register_route: ${toolText(route)}`,
          );

          // The externally-built route serves from the live core.
          const res = await fetch(`${baseUrl}/api/mcp-http`);
          assertEquals(res.status, 200);
          assertEquals(await res.json(), { ok: true, via: "http" });

          // Record a passing verification run, then complete the changeset.
          const created2 = parseLastJson<{ id: string }>(created);
          const verified = await client.callTool({
            name: "record_verification_run",
            arguments: {
              changeset_id: created2.id,
              status: "passed",
              summary: "Route serves as expected.",
              evidence: [{
                id: "ev_serves",
                kind: "test_result",
                summary: "GET /api/mcp-http returned 200.",
                status: "passed",
              }],
              claimResults: [{
                claimId: "claim_serves",
                status: "passed",
                evidenceIds: ["ev_serves"],
              }],
              residualRisks: [],
            },
          });
          assertEquals(
            verified.isError,
            undefined,
            `verification: ${toolText(verified)}`,
          );

          const completed = await client.callTool({
            name: "complete_changeset",
            arguments: { changeset_id: created2.id },
          });
          assertEquals(
            completed.isError,
            undefined,
            `complete: ${toolText(completed)}`,
          );
          assertStringIncludes(toolText(completed), "completed");
        } finally {
          await dispose();
        }
      });
    });
  },
});

// Two concurrent HTTP sessions (two Mcp-Session-Ids): a changeset created by A
// does not satisfy the mutation gate for B — CHANGESET_REQUIRED. This is the
// per-session isolation guarantee across the network boundary.
Deno.test({
  ...testOpts,
  name: "MCP over HTTP: sessions are isolated across concurrent clients",
  fn: async () => {
    await withKernel(async (kernel) => {
      await withMcpHttp({ kernel, rebuild: noop }, async (_server, url) => {
        const a = await connectHttpClient(url);
        const b = await connectHttpClient(url);
        try {
          // Distinct sessions were minted (the transport captured each id).
          assert(a.transport.sessionId, "A should have a session id");
          assert(b.transport.sessionId, "B should have a session id");
          assert(
            a.transport.sessionId !== b.transport.sessionId,
            "each client gets its own MCP session",
          );

          const created = await a.client.callTool({
            name: "create_changeset",
            arguments: { title: "A's work", plan: demoPlan() },
          });
          assertEquals(created.isError, undefined);

          // B's session has no active changeset → the mutation gate must bite.
          const blocked = await b.client.callTool({
            name: "define_handler",
            arguments: {
              name: "b_orphan",
              source: `async function b_orphan(c: any) { return c.json({}); }`,
            },
          });
          assertEquals(blocked.isError, true);
          assertStringIncludes(toolText(blocked), "CHANGESET_REQUIRED");

          // Both calls are audited as HTTP, each under its own session. A
          // refusal from the gate is still a call that was allowed to run.
          const calls = await kernel.mcpAudit!.list();
          assertEquals(calls.map((c) => c.transport), ["http", "http"]);
          assertEquals(calls.map((c) => c.decision), ["allow", "allow"]);
          assert(calls[0]!.sessionId !== calls[1]!.sessionId);
        } finally {
          await a.dispose();
          await b.dispose();
        }
      });
    });
  },
});

// The gate bites over HTTP for a session with no changeset (CHANGESET_REQUIRED),
// and the readiness gate — the actual moat — still blocks completion with no
// verification run (INCOMPLETE_VERIFICATION). Same assertions as the stdio /
// in-process tests, now across the HTTP transport.
Deno.test({
  ...testOpts,
  name: "MCP over HTTP: gate + readiness still bite",
  fn: async () => {
    await withKernel(async (kernel) => {
      await withMcpHttp({ kernel, rebuild: noop }, async (_server, url) => {
        const { client, dispose } = await connectHttpClient(url);
        try {
          // No changeset in this session yet → mutation blocked.
          const blocked = await client.callTool({
            name: "define_handler",
            arguments: {
              name: "orphan",
              source: `async function orphan(c: any) { return c.json({}); }`,
            },
          });
          assertEquals(blocked.isError, true);
          assertStringIncludes(toolText(blocked), "CHANGESET_REQUIRED");

          // Create a changeset, then try to complete it with no verification.
          const created = await client.callTool({
            name: "create_changeset",
            arguments: { title: "Unverified", plan: demoPlan() },
          });
          assertEquals(created.isError, undefined);
          const changeset = parseLastJson<{ id: string }>(created);

          const completed = await client.callTool({
            name: "complete_changeset",
            arguments: { changeset_id: changeset.id },
          });
          assertEquals(completed.isError, true);
          assertStringIncludes(toolText(completed), "INCOMPLETE_VERIFICATION");
        } finally {
          await dispose();
        }
      });
    });
  },
});

// Session teardown: a client-initiated DELETE (terminateSession) removes the
// session from the server's registry — a subsequent call on that id is rejected.
Deno.test({
  ...testOpts,
  name: "MCP over HTTP: DELETE tears down the session",
  fn: async () => {
    await withKernel(async (kernel) => {
      await withMcpHttp({ kernel, rebuild: noop }, async (_server, url) => {
        const { client, transport, dispose } = await connectHttpClient(url);
        try {
          // Session is live: a read tool succeeds.
          const before = await client.listTools();
          assert(
            before.tools.length > 0,
            "session should be usable before DELETE",
          );
          const sessionId = transport.sessionId;
          assert(sessionId, "client should have a session id");

          // Client-initiated DELETE removes the session server-side.
          await transport.terminateSession();

          // A raw request reusing the now-dead session id is rejected: the
          // server no longer has that transport in its registry.
          const res = await fetch(url, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "accept": "application/json, text/event-stream",
              "mcp-session-id": sessionId,
              ...AUTH_HEADER,
            },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "tools/list",
              params: {},
            }),
          });
          assertEquals(res.status, 404, "dead session id should be rejected");
          await res.body?.cancel();
        } finally {
          await dispose();
        }
      });
    });
  },
});

// A bare initialize POST, for the guard tests: they only care about the status.
function initializeRequest(headers: Record<string, string>): RequestInit {
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
        clientInfo: { name: "guard-test", version: "0.0.0" },
      },
    }),
  };
}

Deno.test({
  ...testOpts,
  name: "MCP over HTTP: no token is 401, a wrong one too",
  fn: async () => {
    await withKernel(async (kernel) => {
      await withMcpHttp({ kernel, rebuild: noop }, async (_server, url) => {
        const attempts: Record<string, string>[] = [
          {},
          { authorization: "Bearer not-the-token" },
        ];
        for (const headers of attempts) {
          const res = await fetch(url, initializeRequest(headers));
          assertEquals(res.status, 401);
          const body = await res.json();
          assertEquals(body.error.data.code, "UNAUTHORIZED");
        }
      });
    });
  },
});

Deno.test({
  ...testOpts,
  name: "MCP over HTTP: a foreign Origin is 403 even with the token",
  fn: async () => {
    await withKernel(async (kernel) => {
      await withMcpHttp({ kernel, rebuild: noop }, async (_server, url) => {
        const res = await fetch(
          url,
          initializeRequest({ ...AUTH_HEADER, origin: "https://evil.com" }),
        );
        assertEquals(res.status, 403);
        await res.body?.cancel();
      });
    });
  },
});

Deno.test({
  ...testOpts,
  name: "MCP over HTTP: only the /mcp path is served",
  fn: async () => {
    await withKernel(async (kernel) => {
      await withMcpHttp({ kernel, rebuild: noop }, async (_server, url) => {
        const res = await fetch(
          new URL("/other", url),
          initializeRequest(AUTH_HEADER),
        );
        assertEquals(res.status, 404);
        await res.body?.cancel();
      });
    });
  },
});
