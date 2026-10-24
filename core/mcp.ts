// @layer core — INBOUND MCP client manager. Consumes external MCP servers a user
// configures (stdio or streamable-HTTP) and projects their tools into the agent's
// tool surface. NOTE: this is the inbound face; the outbound mcp-* modules
// (mcp-projection/-server/-http/-connect) are the separate L2 `mcp` layer that
// serves OUR core to external agents. Do not conflate the two.
//
// Both faces now ride the official @modelcontextprotocol/sdk: this manager drives
// external servers through the SDK `Client` + its stdio / streamable-HTTP client
// transports, so there is one MCP code path across inbound and outbound and no
// hand-rolled JSON-RPC/transport plumbing to maintain (OpenTide §4, Phase 3 E).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { CustomToolDef } from "./tools/definitions.ts";

export interface MCPServerConfig {
  name: string;
  enabled: boolean;
  transport: "url" | "stdio";
  url?: string;
  authToken?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}

// Identity this manager advertises to external servers during the SDK handshake.
const CLIENT_NAME = "opentide";
const CLIENT_VERSION = "0.1.0";

// Per-request timeout for MCP round-trips (initialize, list, call). Preserves the
// 30s bound the hand-rolled transports enforced; the SDK's own default is 60s, so
// this is set explicitly rather than inherited to keep the prior behavior.
const REQUEST_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// MCP Manager
// ---------------------------------------------------------------------------

interface ConnectedServer {
  client: Client;
  // The SDK Tool descriptors as listed, kept as-is — getCustomTools()/
  // getToolsHash()/resolveQualifiedTool() read only name/description/inputSchema.
  tools: Tool[];
  config: MCPServerConfig;
}

export type MCPServerStatus =
  | "connected"
  | "disconnected"
  | "connecting"
  | "error";

export class MCPManager {
  private servers = new Map<string, ConnectedServer>();
  private statuses = new Map<
    string,
    { status: MCPServerStatus; error?: string }
  >();

  // Build the SDK client transport for a config. Production callers reach this
  // via connect(); it is factored out so the transport-selection logic stays in
  // one place.
  private createTransport(config: MCPServerConfig): Transport {
    if (config.transport === "stdio") {
      if (!config.command) {
        throw new Error("command is required for stdio transport");
      }
      return new StdioClientTransport({
        command: config.command,
        args: config.args ?? [],
        // Deliberate narrowing: the SDK's getDefaultEnvironment() is a curated
        // SAFE SUBSET (PATH/HOME + a few platform vars), NOT the full parent
        // environment the old transport passed via Deno.env.toObject(). We don't
        // leak the kernel's whole env (API tokens, proxy vars, NODE_OPTIONS) to a
        // third-party server; the config's own env overrides layer on top. A
        // server needing an inherited var must now list it explicitly in config.
        env: config.env
          ? { ...getDefaultEnvironment(), ...config.env }
          : undefined,
        // Swallow the child's stderr — this manager runs inside the kernel and a
        // chatty server must not corrupt our output (the old transport did the
        // same by piping stderr to a black hole).
        stderr: "ignore",
      });
    }
    if (!config.url) throw new Error("url is required for url transport");
    // Streamable-HTTP negotiation (single endpoint: POST + GET/SSE) covers modern
    // "url" servers. Legacy two-endpoint HTTP+SSE servers (protocol 2024-11-05)
    // would need SSEClientTransport; none are in use, so it is intentionally not
    // wired up here — add it only when a real server requires it.
    return new StreamableHTTPClientTransport(new URL(config.url), {
      requestInit: config.authToken
        ? { headers: { Authorization: `Bearer ${config.authToken}` } }
        : undefined,
    });
  }

  // transportOverride is a test seam (an in-memory SDK transport) — production
  // callers omit it and the transport is built from the config.
  async connect(
    config: MCPServerConfig,
    transportOverride?: Transport,
  ): Promise<void> {
    this.statuses.set(config.name, { status: "connecting" });

    const transport = transportOverride ?? this.createTransport(config);
    const client = new Client({ name: CLIENT_NAME, version: CLIENT_VERSION });

    try {
      // connect() runs the MCP initialize handshake (incl. protocol-version
      // negotiation) — no manual initialize/initialized round-trip needed.
      await client.connect(transport, { timeout: REQUEST_TIMEOUT_MS });

      const { tools } = await client.listTools(undefined, {
        timeout: REQUEST_TIMEOUT_MS,
      });

      this.servers.set(config.name, { client, tools: tools as Tool[], config });
      this.statuses.set(config.name, { status: "connected" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.statuses.set(config.name, { status: "error", error: message });
      await client.close().catch(() => {});
      throw err;
    }
  }

  async disconnect(name: string): Promise<void> {
    const entry = this.servers.get(name);
    if (entry) {
      await entry.client.close().catch(() => {});
      this.servers.delete(name);
    }
    this.statuses.set(name, { status: "disconnected" });
  }

  getStatus(name: string): { status: MCPServerStatus; error?: string } {
    return this.statuses.get(name) ?? { status: "disconnected" };
  }

  private qualifiedToolName(server: string, tool: string): string {
    return `mcp__${server}__${tool}`;
  }

  // Resolve a qualified name back to its server+tool by exact-matching the
  // registered tools, rather than splitting on "__" (which is ambiguous when a
  // server or tool name itself contains "__").
  private resolveQualifiedTool(
    qualifiedName: string,
  ): { server: string; tool: string } | null {
    for (const [serverName, { tools }] of this.servers) {
      for (const tool of tools) {
        if (this.qualifiedToolName(serverName, tool.name) === qualifiedName) {
          return { server: serverName, tool: tool.name };
        }
      }
    }
    return null;
  }

  getCustomTools(): CustomToolDef[] {
    const result: CustomToolDef[] = [];
    for (const [serverName, { tools }] of this.servers) {
      for (const tool of tools) {
        result.push({
          type: "custom",
          name: this.qualifiedToolName(serverName, tool.name),
          description: `[MCP: ${serverName}] ${tool.description ?? tool.name}`,
          input_schema: tool.inputSchema as Record<string, unknown>,
        });
      }
    }
    return result;
  }

  getToolsHash(): string {
    const entries = [...this.servers.entries()].map(([name, { tools }]) => ({
      name,
      tools: tools.map((t) => t.name).sort(),
    }));
    return JSON.stringify(entries);
  }

  async callTool(
    qualifiedName: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const resolved = this.resolveQualifiedTool(qualifiedName);
    if (!resolved) {
      throw new Error(`MCP server not found for tool: ${qualifiedName}`);
    }

    const entry = this.servers.get(resolved.server);
    if (!entry) {
      throw new Error(`MCP server "${resolved.server}" not connected`);
    }

    return await entry.client.callTool(
      { name: resolved.tool, arguments: args },
      undefined,
      { timeout: REQUEST_TIMEOUT_MS },
    );
  }

  isMcpTool(name: string): boolean {
    return name.startsWith("mcp__");
  }

  async sync(configs: MCPServerConfig[]): Promise<{ errors: string[] }> {
    const errors: string[] = [];
    const wanted = new Map(
      configs.filter((c) => c.enabled).map((c) => [c.name, c]),
    );

    // Disconnect removed or disabled servers
    for (const name of [...this.servers.keys()]) {
      if (!wanted.has(name)) {
        await this.disconnect(name);
      }
    }

    // Also clean up statuses for servers no longer in config
    const allNames = new Set(configs.map((c) => c.name));
    for (const name of [...this.statuses.keys()]) {
      if (!allNames.has(name)) this.statuses.delete(name);
    }

    // Connect new servers (skip already connected with same config)
    for (const [name, config] of wanted) {
      const existing = this.servers.get(name);
      if (
        existing && JSON.stringify(existing.config) === JSON.stringify(config)
      ) continue;

      if (existing) await this.disconnect(name);

      try {
        await this.connect(config);
      } catch (err) {
        errors.push(
          `${name}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // Mark disabled servers
    for (const config of configs) {
      if (!config.enabled && !this.statuses.has(config.name)) {
        this.statuses.set(config.name, { status: "disconnected" });
      }
    }

    return { errors };
  }

  async closeAll(): Promise<void> {
    for (const name of [...this.servers.keys()]) {
      await this.disconnect(name);
    }
    this.statuses.clear();
  }
}
