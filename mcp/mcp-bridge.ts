// @layer mcp — `opentide mcp` as a stdio bridge to the project's serve process.
//
// One process owns a project at a time (core/project-lock.ts). Before Phase 2
// that made `opentide mcp` and `opentide serve` mutually exclusive: whichever
// started second was refused. Now serve answers MCP itself, at /mcp on its
// control port, and this module is what an stdio client spawns instead. It finds
// the serve process that holds the project (starting one if nothing does) and
// relays JSON-RPC between the client's stdio and serve's /mcp, untouched. So
// Claude Code, Codex, Cursor and the IDE all land on the same kernel. Finding and
// starting serve lives in core/serve-process.ts; task forks start theirs the same
// way.
import process from "node:process";
import { resolve } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { locateServe, type ServeTarget } from "../core/serve-process.ts";
import type { Result } from "../core/types.ts";
import { errorMessage } from "../core/util.ts";

export function isRequest(
  msg: JSONRPCMessage,
): msg is JSONRPCMessage & { id: string | number; method: string } {
  return "method" in msg && "id" in msg;
}

// JSON-RPC's "method not found".
export const METHOD_NOT_FOUND = -32601;

// A request sent before initialize has no session, and serve's /mcp refuses it.
// Some clients probe first (Claude Desktop sends server/discover) and fall back
// to initialize on "method not found", so the bridge answers those itself.
export function preInitializeReply(
  msg: JSONRPCMessage & { id: string | number; method: string },
): JSONRPCMessage {
  if (msg.method === "ping") return { jsonrpc: "2.0", id: msg.id, result: {} };
  return {
    jsonrpc: "2.0",
    id: msg.id,
    error: {
      code: METHOD_NOT_FOUND,
      message: `Method not found: ${msg.method} (send initialize first)`,
    },
  };
}

function negotiatedVersion(msg: JSONRPCMessage): string | null {
  if (!("result" in msg)) return null;
  const version = (msg.result as { protocolVersion?: unknown }).protocolVersion;
  return typeof version === "string" ? version : null;
}

/**
 * Relay JSON-RPC between `downstream` (the client, normally stdio) and serve's
 * /mcp. Resolves with an exit code: 0 when the client disconnects, 1 when serve
 * goes away or refuses a message. The client restarts us; the restart finds or
 * starts serve again.
 */
export function proxyMcp(
  downstream: Transport,
  url: string,
  token: string,
): Promise<number> {
  const upstream = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  // The HTTP transport stamps every request after initialize with the
  // negotiated version. A real Client sets it; a relay has to read it off the
  // initialize reply.
  const initializeIds = new Set<string | number>();
  let initializeSent = false;

  return new Promise((resolveExit) => {
    let finished = false;
    const finish = async (code: number) => {
      if (finished) return;
      finished = true;
      if (code === 0) await upstream.terminateSession().catch(() => {});
      await upstream.close().catch(() => {});
      await downstream.close().catch(() => {});
      resolveExit(code);
    };
    const lost = (err: unknown) => {
      if (finished) return;
      console.error(`  MCP bridge lost serve at ${url}: ${errorMessage(err)}`);
      void finish(1);
    };

    downstream.onmessage = (msg: JSONRPCMessage) => {
      if (isRequest(msg) && msg.method === "initialize") {
        initializeIds.add(msg.id);
        initializeSent = true;
      } else if (!initializeSent) {
        // Notifications before initialize have nowhere to go; drop them.
        if (isRequest(msg)) {
          downstream.send(preInitializeReply(msg)).catch(() => void finish(1));
        }
        return;
      }
      upstream.send(msg).catch(lost);
    };
    upstream.onmessage = (msg: JSONRPCMessage) => {
      if ("id" in msg && msg.id !== null && initializeIds.delete(msg.id)) {
        const version = negotiatedVersion(msg);
        if (version) upstream.setProtocolVersion(version);
      }
      downstream.send(msg).catch(() => void finish(1));
    };
    downstream.onclose = () => void finish(0);
    upstream.onerror = lost;
    downstream.onerror = (err: Error) =>
      console.error(`  MCP bridge stdio error: ${errorMessage(err)}`);

    upstream.start()
      .then(() => downstream.start())
      .catch(lost);
  });
}

// Find or start the serve process for `projectDir`, telling the person at the
// other end of stderr what happened. Shared with the workspace bridge.
export async function locateAndReport(
  projectDir: string,
): Promise<Result<ServeTarget>> {
  const located = await locateServe(resolve(projectDir));
  if (!located.ok) {
    console.error(`  ${located.error.message}`);
    if (located.error.suggestion) {
      console.error(`  ${located.error.suggestion}`);
    }
    return located;
  }
  const { url, pid, started } = located.data;
  if (started) {
    console.error(
      `  Started opentide serve (pid ${pid}) for ${projectDir}. It keeps ` +
        `running after this bridge exits; stop it with \`kill ${pid}\`.` +
        (started.logPath ? `\n  Log: ${started.logPath}` : ""),
    );
  }
  console.error(`  MCP bridge ready: stdio <-> ${url} (serve pid ${pid}).`);
  return located;
}

// The SDK's stdio transport never notices stdin ending, and the upstream SSE
// stream keeps the process alive, so a client that only closes our stdin would
// leave us running forever.
export function stdioTransport(): StdioServerTransport {
  const stdio = new StdioServerTransport();
  process.stdin.once("end", () => void stdio.close());
  return stdio;
}

// `opentide mcp --project <path>` without --standalone. Logs go to stderr;
// stdout belongs to the relayed JSON-RPC.
export async function runMcpBridge(projectPath: string): Promise<number> {
  const located = await locateAndReport(projectPath);
  if (!located.ok) return 1;
  return await proxyMcp(stdioTransport(), located.data.url, located.data.token);
}
