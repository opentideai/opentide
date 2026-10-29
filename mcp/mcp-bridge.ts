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
import {
  MCP_BRIDGE_RECONNECT_ATTEMPTS,
  MCP_BRIDGE_RECONNECT_DELAY_MS,
  MCP_BRIDGE_STARTUP_TIMEOUT_MS,
  SERVE_IDLE_EXIT_MS,
} from "../core/config.ts";

export function isRequest(
  msg: JSONRPCMessage,
): msg is JSONRPCMessage & { id: string | number; method: string } {
  return "method" in msg && "id" in msg;
}

const INITIALIZED_NOTIFICATION = "notifications/initialized";

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

// Where the bridge relays to: a serve's /mcp and its bearer token.
export interface BridgeTarget {
  url: string;
  token: string;
}

// Finds the project's serve again after the one the bridge had went away.
export type Relocate = () => Promise<Result<BridgeTarget>>;

export interface ProxyOptions {
  relocate?: Relocate;
  reconnectDelayMs?: number;
  reconnectAttempts?: number;
}

// JSON-RPC server error for a call cut off when serve went away mid-call.
export const UPSTREAM_LOST = -32000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Relay JSON-RPC between `downstream` (the client, normally stdio) and serve's
 * /mcp. Resolves with an exit code: 0 when the client disconnects, 1 when serve
 * goes away for good or refuses a message.
 *
 * With `relocate`, losing serve isn't the end. Serve goes away when it idles
 * out or hands the project to Tide, and clients don't restart a server that
 * died mid-session. So the bridge finds the project's serve again, replays the
 * client's initialize there, and carries on. Calls that were in flight get an
 * error the client can retry.
 */
export function proxyMcp(
  downstream: Transport,
  first: BridgeTarget,
  opts: ProxyOptions = {},
): Promise<number> {
  const delayMs = opts.reconnectDelayMs ?? MCP_BRIDGE_RECONNECT_DELAY_MS;
  const attempts = opts.reconnectAttempts ?? MCP_BRIDGE_RECONNECT_ATTEMPTS;
  // The HTTP transport stamps every request after initialize with the
  // negotiated version. A real Client sets it; a relay has to read it off the
  // initialize reply.
  const initializeIds = new Set<string | number>();
  // Requests sent upstream and not yet answered: the ones to fail on a loss.
  const inFlight = new Set<string | number>();
  // The client's handshake, replayed against a new serve on reconnect.
  let initialize: JSONRPCMessage | null = null;
  let initialized: JSONRPCMessage | null = null;
  let target = first;
  let upstream: StreamableHTTPClientTransport;
  let reconnecting = false;
  const queued: JSONRPCMessage[] = [];
  let replay: { id: string; resolve: (msg: JSONRPCMessage) => void } | null =
    null;
  let replays = 0;

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

    const open = (t: BridgeTarget): StreamableHTTPClientTransport => {
      const u = new StreamableHTTPClientTransport(new URL(t.url), {
        requestInit: { headers: { Authorization: `Bearer ${t.token}` } },
      });
      u.onmessage = (msg: JSONRPCMessage) => fromUpstream(u, msg);
      u.onerror = (err: Error) => lost(u, err);
      return u;
    };

    const fromUpstream = (
      u: StreamableHTTPClientTransport,
      msg: JSONRPCMessage,
    ) => {
      if (u !== upstream) return;
      if ("id" in msg && msg.id !== null) {
        if (replay && msg.id === replay.id) {
          replay.resolve(msg);
          return;
        }
        if (initializeIds.delete(msg.id)) {
          const version = negotiatedVersion(msg);
          if (version) upstream.setProtocolVersion(version);
        }
        if ("result" in msg || "error" in msg) inFlight.delete(msg.id);
      }
      downstream.send(msg).catch(() => void finish(1));
    };

    const toUpstream = (msg: JSONRPCMessage) => {
      if (reconnecting) {
        queued.push(msg);
        return;
      }
      if (isRequest(msg)) inFlight.add(msg.id);
      const u = upstream;
      u.send(msg).catch((err: unknown) => lost(u, err));
    };

    // Fail the calls the old serve will never answer.
    const failInFlight = () => {
      for (const id of inFlight) {
        downstream.send({
          jsonrpc: "2.0",
          id,
          error: {
            code: UPSTREAM_LOST,
            message: "OpenTide's server went away mid-call (it stopped, or " +
              "the project was handed over). Retry the call.",
          },
        }).catch(() => {});
      }
      inFlight.clear();
      initializeIds.clear();
    };

    const replayInitialize = async () => {
      if (!initialize || !("method" in initialize)) return;
      const id = `opentide-bridge-reinit-${++replays}`;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const answer = new Promise<JSONRPCMessage>((resolve, reject) => {
        replay = { id, resolve };
        timer = setTimeout(
          () => reject(new Error("initialize got no answer")),
          MCP_BRIDGE_STARTUP_TIMEOUT_MS,
        );
      });
      try {
        await upstream.send({ ...initialize, id } as JSONRPCMessage);
        const reply = await answer;
        if ("error" in reply) throw new Error(reply.error.message);
        const version = negotiatedVersion(reply);
        if (version) upstream.setProtocolVersion(version);
        if (initialized) await upstream.send(initialized);
      } finally {
        clearTimeout(timer);
        replay = null;
      }
    };

    const reconnect = async (relocate: Relocate): Promise<boolean> => {
      const old = upstream;
      old.onmessage = undefined;
      old.onerror = undefined;
      void old.close().catch(() => {});
      failInFlight();
      for (let attempt = 1; attempt <= attempts; attempt++) {
        // Whoever took the project over gets it first.
        await sleep(delayMs);
        if (finished) return false;
        const found = await relocate();
        if (!found.ok) continue; // locateAndReport has said why
        target = found.data;
        upstream = open(target);
        try {
          await upstream.start();
          await replayInitialize();
          console.error(`  MCP bridge reconnected: stdio <-> ${target.url}.`);
          return true;
        } catch (err) {
          console.error(
            `  MCP bridge couldn't reconnect to ${target.url}: ${
              errorMessage(err)
            }`,
          );
          await upstream.close().catch(() => {});
        }
      }
      return false;
    };

    const lost = (u: StreamableHTTPClientTransport, err: unknown) => {
      if (finished || reconnecting || u !== upstream) return;
      console.error(
        `  MCP bridge lost serve at ${target.url}: ${errorMessage(err)}`,
      );
      if (!opts.relocate) {
        void finish(1);
        return;
      }
      reconnecting = true;
      void reconnect(opts.relocate).then((ok) => {
        reconnecting = false;
        if (!ok) {
          void finish(1);
          return;
        }
        for (const msg of queued.splice(0)) toUpstream(msg);
      });
    };

    downstream.onmessage = (msg: JSONRPCMessage) => {
      if (isRequest(msg) && msg.method === "initialize") {
        initializeIds.add(msg.id);
        initialize = msg;
      } else if (!initialize) {
        // Notifications before initialize have nowhere to go; drop them.
        if (isRequest(msg)) {
          downstream.send(preInitializeReply(msg)).catch(() => void finish(1));
        }
        return;
      } else if (
        "method" in msg && !("id" in msg) &&
        msg.method === INITIALIZED_NOTIFICATION
      ) {
        initialized = msg;
      }
      toUpstream(msg);
    };
    downstream.onclose = () => void finish(0);
    downstream.onerror = (err: Error) =>
      console.error(`  MCP bridge stdio error: ${errorMessage(err)}`);

    upstream = open(first);
    const initial = upstream;
    initial.start()
      .then(() => downstream.start())
      .catch((err: unknown) => lost(initial, err));
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
        `running after this bridge exits and stops itself after ` +
        `${SERVE_IDLE_EXIT_MS / 60_000} minutes with no client.` +
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
  return await proxyMcp(stdioTransport(), located.data, {
    relocate: () => locateAndReport(projectPath),
  });
}
