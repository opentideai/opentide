// @layer agent-loop — the external MCP servers a project's chat connects to.
//
// They are the agent's, like a desktop client's MCP list is that client's:
// serve never sees them. The list lives in the project's .opentide/, owner-only
// because it holds auth tokens. A project that kept it in serve's configs gets
// a copy on first read; serve's copy is left where it is.
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  AGENT_MCP_SERVERS_FILE,
  AGENT_MCP_SERVERS_FILE_MODE,
  LEGACY_MCP_SERVERS_CONFIG,
} from "../core/config.ts";
import {
  MCPManager,
  type MCPServerConfig,
  type MCPServerStatus,
} from "../core/mcp.ts";
import { projectStateDir } from "../core/project-layout.ts";
import { getProjectPaths } from "../core/project-manager.ts";

export interface McpServerView extends MCPServerConfig {
  status: MCPServerStatus;
  error?: string;
}

export type McpServerEdit =
  | { ok: true; server: McpServerView; syncErrors: string[] }
  | { ok: false; status: 400 | 404 | 409; error: string };

export interface ProjectMcpServers {
  // The manager the chat calls tools through.
  readonly manager: MCPManager;
  list(): McpServerView[];
  add(body: Record<string, unknown>): Promise<McpServerEdit>;
  update(name: string, body: Record<string, unknown>): Promise<McpServerEdit>;
  remove(name: string): Promise<boolean>;
  sync(): Promise<{ errors: string[] }>;
  close(): Promise<void>;
}

export function projectMcpServers(
  projectDir: string,
  manager = new MCPManager(),
): ProjectMcpServers {
  const file = join(projectStateDir(projectDir), AGENT_MCP_SERVERS_FILE);
  let servers = existsSync(file)
    ? readServers(file)
    : legacyServers(projectDir);

  function view(config: MCPServerConfig): McpServerView {
    return { ...config, ...manager.getStatus(config.name) };
  }

  async function save(next: MCPServerConfig[]): Promise<{ errors: string[] }> {
    servers = next;
    writeServers(file, servers);
    return await manager.sync(servers);
  }

  async function saved(config: MCPServerConfig): Promise<McpServerEdit> {
    const { errors } = await save(
      servers.map((s) => s.name === config.name ? config : s),
    );
    return { ok: true, server: view(config), syncErrors: errors };
  }

  return {
    manager,
    list: () => servers.map(view),
    add: async (body) => {
      const parsed = parseMcpServerConfigInput(body);
      if (!parsed.ok) return { ok: false, status: 400, error: parsed.error };
      const config = parsed.config;
      if (servers.some((s) => s.name === config.name)) {
        return {
          ok: false,
          status: 409,
          error: `Server "${config.name}" already exists`,
        };
      }
      servers = [...servers, config];
      return await saved(config);
    },
    update: async (name, body) => {
      const server = servers.find((s) => s.name === name);
      if (!server) {
        return { ok: false, status: 404, error: `Server "${name}" not found` };
      }
      const patched = patchMcpServerConfig(server, body);
      if (!patched.ok) return { ok: false, status: 400, error: patched.error };
      return await saved(patched.config);
    },
    remove: async (name) => {
      if (!servers.some((s) => s.name === name)) return false;
      await save(servers.filter((s) => s.name !== name));
      return true;
    },
    sync: () => manager.sync(servers),
    close: () => manager.closeAll(),
  };
}

function readServers(file: string): MCPServerConfig[] {
  const parsed: unknown = JSON.parse(readFileSync(file, "utf-8"));
  return Array.isArray(parsed) ? parsed as MCPServerConfig[] : [];
}

function writeServers(file: string, servers: MCPServerConfig[]): void {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, JSON.stringify(servers, null, 2), {
    mode: AGENT_MCP_SERVERS_FILE_MODE,
  });
  // `mode` only applies when the file is created.
  chmodSync(file, AGENT_MCP_SERVERS_FILE_MODE);
}

// The list serve kept in its configs, as its state file has it.
function legacyServers(projectDir: string): MCPServerConfig[] {
  const configs = join(getProjectPaths(projectDir).stateDir, "configs.json");
  if (!existsSync(configs)) return [];
  const entries: unknown = JSON.parse(readFileSync(configs, "utf-8"));
  if (!Array.isArray(entries)) return [];
  const entry = entries.find((e) =>
    isRecord(e) && e.name === LEGACY_MCP_SERVERS_CONFIG
  ) as { value?: unknown } | undefined;
  return Array.isArray(entry?.value) ? entry.value as MCPServerConfig[] : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((a) => typeof a === "string");
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) &&
    Object.values(value).every((v) => typeof v === "string");
}

type ConfigResult =
  | { ok: true; config: MCPServerConfig }
  | { ok: false; error: string };

// The fields an edit may carry and what each must be.
const FIELD_CHECKS: Array<{
  key: keyof MCPServerConfig;
  valid: (v: unknown) => boolean;
  error: string;
}> = [
  { key: "url", valid: (v) => typeof v === "string", error: "a string" },
  { key: "authToken", valid: (v) => typeof v === "string", error: "a string" },
  { key: "command", valid: (v) => typeof v === "string", error: "a string" },
  { key: "args", valid: isStringArray, error: "an array of strings" },
  { key: "env", valid: isStringRecord, error: "an object of string values" },
  { key: "enabled", valid: (v) => typeof v === "boolean", error: "a boolean" },
];

function badField(body: Record<string, unknown>): string | null {
  for (const { key, valid, error } of FIELD_CHECKS) {
    if (body[key] !== undefined && !valid(body[key])) {
      return `${key} must be ${error}`;
    }
  }
  return null;
}

export function parseMcpServerConfigInput(
  body: Record<string, unknown>,
): ConfigResult {
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const transport = body.transport;
  if (!name) return { ok: false, error: "name is required" };
  if (transport !== "url" && transport !== "stdio") {
    return { ok: false, error: "transport is required (url or stdio)" };
  }
  const bad = badField(body);
  if (bad) return { ok: false, error: bad };

  const url = typeof body.url === "string" ? body.url.trim() : "";
  const command = typeof body.command === "string" ? body.command.trim() : "";
  if (transport === "url" && !url) {
    return { ok: false, error: "url is required for url transport" };
  }
  if (transport === "stdio" && !command) {
    return { ok: false, error: "command is required for stdio transport" };
  }
  const enabled = body.enabled !== false;
  if (transport === "url") {
    return {
      ok: true,
      config: {
        name,
        enabled,
        transport,
        url,
        authToken: body.authToken as string | undefined,
      },
    };
  }
  return {
    ok: true,
    config: {
      name,
      enabled,
      transport,
      command,
      args: body.args as string[] | undefined,
      env: body.env as Record<string, string> | undefined,
    },
  };
}

// The server with the edit's fields replaced. A new object, so the manager sees
// the change and reconnects.
function patchMcpServerConfig(
  server: MCPServerConfig,
  body: Record<string, unknown>,
): ConfigResult {
  const bad = badField(body);
  if (bad) return { ok: false, error: bad };
  const patch: Partial<MCPServerConfig> = {};
  for (const { key } of FIELD_CHECKS) {
    if (body[key] !== undefined) {
      (patch as Record<string, unknown>)[key] = body[key];
    }
  }
  return { ok: true, config: { ...server, ...patch } };
}
