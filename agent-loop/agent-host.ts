// @layer agent-loop — the agent's view of serve: who the IDE's user is, which
// project the IDE has open, and an MCP connection to it.
//
// The login is the agent's: serve has none, and the open project is a plain
// question to serve's REST API. The MCP connection is the one any client
// gets, with the project's token from .opentide/kernel.token, as the stdio
// bridge reads it. The project's external MCP servers are the agent's own and
// connect from here.
import type { Hono } from "hono";
import { type AuthProvider, LocalAuthProvider } from "../core/auth-provider.ts";
import { AGENT_MCP_CLIENT_NAME, MCP_HTTP_PATH } from "../core/config.ts";
import { getProjectPaths } from "../core/project-manager.ts";
import { KernelLog } from "../core/registries.ts";
import { readServerToken } from "../core/server-token.ts";
import { errorMessage } from "../core/util.ts";
import type { AgentChat, AgentHost, AgentProject } from "./agent-server.ts";
import type { ChatBackend } from "./chat-backend.ts";
import type { MCPManager } from "../core/mcp.ts";
import { projectMcpServers } from "./agent-mcp-servers.ts";
import {
  connectMcp,
  type McpCaller,
  mcpChatBackend,
} from "./chat-backend-mcp.ts";

export interface ServeHostOptions {
  // serve's control origin, e.g. http://localhost:3003.
  server: URL;
  // Who is signed in. Local (everyone is the local user) when absent.
  auth?: AuthProvider;
  // The login surface that goes with `auth`.
  mountAuthRoutes?(app: Hono): void;
  // The chat runtime over a project's backend, uninitialized, calling external
  // tools through `mcp`.
  chat(backend: ChatBackend, mcp: MCPManager): AgentChat;
  log?: KernelLog;
  fetch?: typeof fetch;
}

export function serveAgentHost(options: ServeHostOptions): AgentHost {
  const fetchFn = options.fetch ?? fetch;
  const log = options.log ?? new KernelLog();

  async function get<T>(path: string): Promise<T | null> {
    const res = await fetchFn(new URL(path, options.server));
    if (!res.ok) {
      await res.body?.cancel();
      return null;
    }
    return await res.json() as T;
  }

  const auth = options.auth ?? new LocalAuthProvider();
  return {
    user: (req) => auth.resolveUser(req),
    accountEntitlementsSupported: auth.accountEntitlementsSupported,
    ...(options.mountAuthRoutes
      ? { mountAuthRoutes: options.mountAuthRoutes }
      : {}),
    projectPath: async () =>
      (await get<{ project: { path: string } | null }>("/api/project"))
        ?.project?.path ?? null,
    attach: (path) => attachProject(path, options, log),
  };
}

async function attachProject(
  path: string,
  options: ServeHostOptions,
  log: KernelLog,
): Promise<AgentProject> {
  const token = readServerToken(path);
  if (!token) {
    throw new Error(
      `serve hasn't advertised ${path}: no token in .opentide/kernel.token`,
    );
  }
  const client = await connectMcp(
    new URL(MCP_HTTP_PATH, options.server),
    token,
    AGENT_MCP_CLIENT_NAME,
  );
  const backend = mcpChatBackend(client as unknown as McpCaller, {
    historyDir: getProjectPaths(path).historyDir,
    log,
  });
  const mcpServers = projectMcpServers(path);
  const chat = options.chat(backend, mcpServers.manager);
  try {
    await chat.initialize();
  } catch (err) {
    await client.close();
    throw err;
  }
  // A slow or dead server shouldn't hold up the first turn; its tools arrive
  // when it connects.
  const connecting = mcpServers.sync().then(({ errors }) => {
    for (const err of errors) log.log("error", "system", `MCP: ${err}`);
  }).catch((err) => log.log("error", "system", `MCP: ${errorMessage(err)}`));
  return {
    path,
    chat,
    history: backend.history,
    mcpServers,
    stale: () => readServerToken(path) !== token,
    close: async () => {
      await chat.close();
      // A server still connecting would outlive closeAll and leak.
      await connecting;
      await mcpServers.close();
      await client.close();
    },
  };
}
