// @layer mcp — HTTP/SSE (streamable-HTTP) transport for the outbound MCP server
// (OpenTide §4, Phase 3 Slice C). Second transport alongside stdio
// (mcp-server.ts), bound to the SAME createMcpServer projection + dispatch — no
// forked catalog, no forked dispatch. Read-and-mutate parity with stdio, now
// reachable by HTTP-based external agents.
//
// Layer rule (§3.2): mcp (L2) imports only core (L1). It reuses createMcpServer
// verbatim; the SDK transport is a platform dep and Deno.serve is the platform.
//
// Statefulness (ratified decision, §7 Slice C): the mutating flow spans multiple
// calls (create_changeset → define_handler → register_route → complete_changeset)
// and the changeset gate resolves the active changeset by ChangeContext.sessionId.
// A stateless "new server per request" would mint a fresh session each call, so a
// prior in_progress changeset would not be active and the gate would bite
// mid-build. So: one Server + transport per MCP session, a session registry keyed
// by the Mcp-Session-Id header, create-on-initialize, teardown on transport close.
// Each session's createMcpServer already mints its own isolated ChangeContext
// session id, so per-session gate isolation falls out for free.
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createMcpServer, type McpServerDeps } from "./mcp-server.ts";
import { DEV_SERVER_HOST, MCP_HTTP_PATH } from "../core/config.ts";
import { isLoopbackRequest } from "../core/loopback-guard.ts";
import { bearerMatches, SERVER_TOKEN_FILE } from "../core/server-token.ts";

// The streamable-HTTP session header (case-insensitive; Headers.get lowercases).
const MCP_SESSION_HEADER = "mcp-session-id";

// Handle to a running MCP HTTP server. `port` reflects the actually-bound port
// (relevant when 0 was requested). `shutdown` stops accepting connections and
// tears down every live session.
export interface McpHttpServer {
  port: number;
  shutdown: () => Promise<void>;
}

// A JSON-RPC error response for requests rejected before a transport exists
// (guards, unknown/missing session, non-initialize POST without a session). The
// transport itself produces spec-correct errors once a request reaches it; this
// only covers the decisions we make above it. `reason` is a machine-readable code
// in `error.data` so a client can tell "no project" from "bad token".
export function jsonRpcError(
  status: number,
  message: string,
  reason?: string,
): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message,
        ...(reason ? { data: { code: reason } } : {}),
      },
      id: null,
    }),
    { status, headers: { "content-type": "application/json" } },
  );
}

// Loopback Host/Origin, or 403. First of the two guards, and the only one that
// runs when the server has no project (and so no token) yet.
export function rejectForeignRequest(req: Request): Response | null {
  return isLoopbackRequest(req) ? null : jsonRpcError(
    403,
    "Forbidden: non-loopback Host or Origin.",
    "FORBIDDEN",
  );
}

// The per-server bearer token, or 401. An empty token never matches anything.
export function rejectBadToken(req: Request, token: string): Response | null {
  if (token && bearerMatches(req.headers.get("authorization"), token)) {
    return null;
  }
  return jsonRpcError(
    401,
    `Missing or wrong bearer token. Send "Authorization: Bearer <token>" ` +
      `with the token from the project's .opentide/${SERVER_TOKEN_FILE}.`,
    "UNAUTHORIZED",
  );
}

// The MCP session router, without a listener. Standalone `--http` wraps it in its
// own Deno.serve; `opentide serve` mounts it at /mcp on the control server.
export interface McpHttpHandler {
  handle: (req: Request) => Promise<Response>;
  // Close every live session. Each session's Server captured the kernel it was
  // opened against, so a project switch must end them all.
  closeAll: () => Promise<void>;
}

// `getDeps` is read when a session opens, not when the handler is built, so a
// mounted handler follows the control server's current project.
export function createMcpHttpHandler(
  getDeps: () => McpServerDeps,
): McpHttpHandler {
  const sessions = new Map<string, WebStandardStreamableHTTPServerTransport>();

  // Stand up a new session on an initialize POST: mint a Server (which mints its
  // own ChangeContext session) + a stateful transport, register the transport
  // when it reports its generated session id, and drop it when it closes (client
  // DELETE or disconnect). Closing the transport also tears down the connected
  // Server — the SDK chains the Server's close onto transport.onclose — so the
  // registry only needs to hold the transport. Returns it so the caller can hand
  // it the initialize request.
  async function openSession(): Promise<
    WebStandardStreamableHTTPServerTransport
  > {
    const server = createMcpServer(getDeps(), "http");
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (sessionId: string) => {
        sessions.set(sessionId, transport);
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId);
    };
    await server.connect(transport);
    return transport;
  }

  async function handle(req: Request): Promise<Response> {
    const sessionId = req.headers.get(MCP_SESSION_HEADER);

    // Existing session: route straight to its transport, body untouched.
    if (sessionId) {
      const transport = sessions.get(sessionId);
      if (!transport) {
        return jsonRpcError(404, `Unknown MCP session: ${sessionId}`);
      }
      return await transport.handleRequest(req);
    }

    // No session id: the only legitimate case is an initialize POST, which opens
    // one. Peek the body to classify it, then pass it through as parsedBody so the
    // transport doesn't try to re-read the consumed stream.
    if (req.method === "POST") {
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return jsonRpcError(400, "Invalid JSON-RPC request body.");
      }
      if (isInitializeRequest(body)) {
        const transport = await openSession();
        return await transport.handleRequest(req, { parsedBody: body });
      }
      return jsonRpcError(
        400,
        "Missing Mcp-Session-Id header; only an initialize request may omit it.",
      );
    }

    // GET/DELETE without a session id have nothing to act on.
    return jsonRpcError(400, "Missing Mcp-Session-Id header.");
  }

  async function closeAll(): Promise<void> {
    // Closing each transport tears down its Server (chained onclose) and fires
    // the onclose that prunes the map. Snapshot the values first so those
    // deletions don't mutate the map mid-iteration, then clear defensively.
    for (const transport of [...sessions.values()]) {
      await transport.close().catch(() => {});
    }
    sessions.clear();
  }

  return { handle, closeAll };
}

// Serve the outbound MCP server over streamable-HTTP on a loopback port, at
// MCP_HTTP_PATH. Returns once the listener is bound; the returned handle exposes
// the bound port and a shutdown that closes the listener and all sessions.
// Handles POST (client→server, incl. initialize), GET (SSE stream), and DELETE
// (session teardown) per the streamable-HTTP spec — the transport does the
// protocol work; this module is the HTTP glue + session registry.
export function serveMcpHttp(
  deps: McpServerDeps,
  port: number,
  token: string,
): McpHttpServer {
  const handler = createMcpHttpHandler(() => deps);

  const httpServer = Deno.serve(
    { hostname: DEV_SERVER_HOST, port, onListen: () => {} },
    (req) => {
      if (new URL(req.url).pathname !== MCP_HTTP_PATH) {
        return jsonRpcError(
          404,
          `Not found. The MCP endpoint is ${MCP_HTTP_PATH}.`,
        );
      }
      return rejectForeignRequest(req) ?? rejectBadToken(req, token) ??
        handler.handle(req);
    },
  );

  const shutdown = async (): Promise<void> => {
    await handler.closeAll();
    await httpServer.shutdown();
    await httpServer.finished;
  };

  return {
    port: (httpServer.addr as Deno.NetAddr).port,
    shutdown,
  };
}
