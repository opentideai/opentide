// @layer mcp — connect-config generator for external MCP clients (OpenTide §7,
// Phase 3 Slice D). Emits ready-to-paste configuration for Claude Code, Codex,
// and Cursor so a user copies a working entry rather than hand-editing a template
// that drifts. Sibling of the transports (mcp-server.ts / mcp-http.ts); imports
// only core (config.ts) + platform deps, no new SDK surface.
//
// The invocation is the running binary when opentide is compiled, otherwise
// DERIVED from the real `mcp` task in deno.json (opentideInvocation,
// core/serve-process.ts) — the single source of truth for the permission flags
// — so a generated config can never fall out of sync with the task the
// maintainer edits.
import {
  DEV_SERVER_HOST,
  MCP_HTTP_PATH,
  MCP_HTTP_PORT,
  MCP_SERVER_NAME,
  SERVER_TOKEN_ENV,
} from "../core/config.ts";
import {
  type DenoInvocation,
  opentideCwd,
  opentideInvocation,
} from "../core/serve-process.ts";

// The external clients whose connect config we can emit. The three Phase-3-Slice-D
// targets (OpenTide §7): Claude Code, Codex, Cursor.
export type McpClient = "claude-code" | "codex" | "cursor";
export const MCP_CLIENTS: readonly McpClient[] = [
  "claude-code",
  "codex",
  "cursor",
];

export type McpTransport = "stdio" | "http";

// Emitted verbatim into a stdio config when no --project is supplied, so the only
// hand-edit a user ever makes is swapping this for their project's absolute path.
export const PROJECT_PATH_PLACEHOLDER = "/absolute/path/to/your/project";

// Deno JIT-compiles the kernel graph on first run; Codex's default MCP startup
// timeout (10s) can be tight for that cold start, so the generated stdio config
// bumps it. Named to avoid an inline magic number (CLAUDE.md).
const CODEX_STARTUP_TIMEOUT_SEC = 30;

export interface ConnectOptions {
  transport: McpTransport;
  // Absolute project path for stdio (or PROJECT_PATH_PLACEHOLDER for a template).
  // Ignored for http — the client connects to a URL, it does not spawn the server.
  projectPath: string;
  // http only; defaults to MCP_HTTP_PORT.
  port?: number;
  // Config entry key; defaults to MCP_SERVER_NAME ("opentide").
  serverName?: string;
}

// The full argv an stdio client spawns: the derived deno invocation plus the
// project selector. (HTTP clients connect to a URL and never spawn the server, so
// this is stdio-only.)
function stdioInvocation(projectPath: string): DenoInvocation {
  const { command, args } = opentideInvocation("mcp");
  return { command, args: [...args, "--project", projectPath] };
}

function httpUrl(port: number = MCP_HTTP_PORT): string {
  return `http://${DEV_SERVER_HOST}:${port}${MCP_HTTP_PATH}`;
}

// HTTP needs the server's bearer token. A printed config can't hold the minted
// one (it changes every start), so it points at SERVER_TOKEN_ENV, which the user
// sets for both the server and the client. Each client spells env expansion its
// own way.
function bearerHeader(envRef: string): Record<string, string> {
  return { Authorization: `Bearer ${envRef}` };
}

// --- TOML serialization (Codex). Minimal but correct for the string / string[]
// values we emit: basic strings, backslash- and quote-escaped. ---
function tomlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function tomlStringArray(values: string[]): string {
  return `[${values.map(tomlString).join(", ")}]`;
}

// Claude Code — `.mcp.json`. `type` is explicit ("stdio" | "http"); HTTP needs it
// (a bare `url` without `type` is a config error). No `cwd` field is supported, so
// the stdio form relies on the absolute script path.
function claudeCodeConfig(opts: ConnectOptions, name: string): string {
  const server = opts.transport === "http"
    ? {
      type: "http" as const,
      url: httpUrl(opts.port),
      headers: bearerHeader(`\${${SERVER_TOKEN_ENV}}`),
    }
    : { type: "stdio" as const, ...stdioInvocation(opts.projectPath) };
  return JSON.stringify({ mcpServers: { [name]: server } }, null, 2);
}

// Cursor — `.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (global). Same
// object shape as Claude Code but no `type` field: Cursor infers the transport
// from `command` (stdio) vs `url` (remote).
function cursorConfig(opts: ConnectOptions, name: string): string {
  const server = opts.transport === "http"
    ? {
      url: httpUrl(opts.port),
      headers: bearerHeader(`\${env:${SERVER_TOKEN_ENV}}`),
    }
    : stdioInvocation(opts.projectPath);
  return JSON.stringify({ mcpServers: { [name]: server } }, null, 2);
}

// Codex — `~/.codex/config.toml`, one `[mcp_servers.<name>]` table. Transport is
// inferred from `command` (stdio) vs `url` (streamable-HTTP); there is no `type`
// key. Codex supports `cwd`, so from a clone the stdio form pins it to the repo
// root (where `--env` resolves `.env`); the binary needs none.
function codexConfig(opts: ConnectOptions, name: string): string {
  const header = `[mcp_servers.${name}]`;
  if (opts.transport === "http") {
    return [
      header,
      `url = ${tomlString(httpUrl(opts.port))}`,
      `bearer_token_env_var = ${tomlString(SERVER_TOKEN_ENV)}`,
      "",
    ].join("\n");
  }
  const { command, args } = stdioInvocation(opts.projectPath);
  const cwd = opentideCwd();
  return [
    header,
    `command = ${tomlString(command)}`,
    `args = ${tomlStringArray(args)}`,
    ...(cwd ? [`cwd = ${tomlString(cwd)}`] : []),
    `startup_timeout_sec = ${CODEX_STARTUP_TIMEOUT_SEC}`,
    "",
  ].join("\n");
}

export function isMcpClient(value: string): value is McpClient {
  return (MCP_CLIENTS as readonly string[]).includes(value);
}

// Where the emitted config belongs, for the --print-config guidance header and
// the docs. Not part of the config body itself.
export function connectConfigTarget(client: McpClient): string {
  switch (client) {
    case "claude-code":
      return ".mcp.json (project scope) — or run `claude mcp add`";
    case "codex":
      return "~/.codex/config.toml";
    case "cursor":
      return ".cursor/mcp.json (project) or ~/.cursor/mcp.json (global)";
  }
}

// Produce the ready-to-paste config string for one client × transport.
export function generateConnectConfig(
  client: McpClient,
  opts: ConnectOptions,
): string {
  const name = opts.serverName ?? MCP_SERVER_NAME;
  switch (client) {
    case "claude-code":
      return claudeCodeConfig(opts, name);
    case "codex":
      return codexConfig(opts, name);
    case "cursor":
      return cursorConfig(opts, name);
  }
}

// A POSIX shell word: single-quoted unless it's plain.
function shellWord(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value)
    ? value
    : `'${value.replaceAll("'", `'\\''`)}'`;
}

export interface TaskConnect {
  // The stdio server entry, for any client that takes an `mcpServers` map.
  mcpServers: Record<string, unknown>;
  // Claude Code, started in the fork with only the fork's server.
  claudeCode: string;
}

// How a separate client reaches a task's fork. start_task returns this: the
// calling agent can't work in the fork over its own connection.
export function taskConnect(forkPath: string): TaskConnect {
  const config = JSON.parse(
    claudeCodeConfig(
      { transport: "stdio", projectPath: forkPath },
      MCP_SERVER_NAME,
    ),
  ) as { mcpServers: Record<string, unknown> };
  return {
    mcpServers: config.mcpServers,
    claudeCode: `cd ${shellWord(forkPath)} && claude --mcp-config ${
      shellWord(JSON.stringify(config))
    } --strict-mcp-config`,
  };
}
