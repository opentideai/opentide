import {
  assert,
  assertEquals,
  assertFalse,
  assertStringIncludes,
} from "@std/assert";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import denoJson from "../deno.json" with { type: "json" };
import { DEV_SERVER_HOST, MCP_HTTP_PORT } from "../core/config.ts";
import {
  type ConnectOptions,
  generateConnectConfig,
  isMcpClient,
  MCP_CLIENTS,
  type McpClient,
  PROJECT_PATH_PLACEHOLDER,
} from "./mcp-connect.ts";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const ABS_PROJECT = "/tmp/genie-throwaway";

// Independently derive what the stdio deno invocation MUST be, straight from the
// real `mcp` task — so this test fails if the generator ever hardcodes a second
// copy of the flags that drifts from the task the maintainer edits.
function expectedDenoArgs(project: string): string[] {
  const tokens = denoJson.tasks.mcp.split(/\s+/).filter((t) => t.length > 0);
  const scriptIdx = tokens.findIndex((t) => t.endsWith(".ts"));
  const flags = tokens.slice(1, scriptIdx);
  const scriptAbs = join(REPO_ROOT, tokens[scriptIdx]!);
  return [...flags, scriptAbs, "--project", project];
}

const HTTP_URL = `http://${DEV_SERVER_HOST}:${MCP_HTTP_PORT}/mcp`;

// Generate a JSON-client config and return the single server entry under test.
function serverOf(client: McpClient, opts: ConnectOptions) {
  return JSON.parse(generateConnectConfig(client, opts)).mcpServers.opentide;
}

Deno.test("claude-code stdio: valid JSON, deno command matches the real task", () => {
  const server = serverOf("claude-code", {
    transport: "stdio",
    projectPath: ABS_PROJECT,
  });
  assertEquals(server.type, "stdio");
  assertEquals(server.command, "deno");
  assertEquals(server.args, expectedDenoArgs(ABS_PROJECT));
});

Deno.test("cursor stdio: valid JSON, no type field, args match the task", () => {
  const server = serverOf("cursor", {
    transport: "stdio",
    projectPath: ABS_PROJECT,
  });
  assertFalse("type" in server); // Cursor infers transport from command/url.
  assertEquals(server.command, "deno");
  assertEquals(server.args, expectedDenoArgs(ABS_PROJECT));
});

Deno.test("codex stdio: TOML shape with table, command, args, cwd, timeout", () => {
  const toml = generateConnectConfig("codex", {
    transport: "stdio",
    projectPath: ABS_PROJECT,
  });
  assertStringIncludes(toml, "[mcp_servers.opentide]");
  assertStringIncludes(toml, 'command = "deno"');
  assertStringIncludes(toml, `cwd = "${REPO_ROOT}"`);
  assertStringIncludes(toml, "startup_timeout_sec = 30");
  // The args array embeds every derived flag, the absolute script, and the project.
  const expectedArgs = `args = [${
    expectedDenoArgs(ABS_PROJECT).map((a) => `"${a}"`).join(", ")
  }]`;
  assertStringIncludes(toml, expectedArgs);
});

Deno.test("claude-code http: type http + url, no spawn command", () => {
  const server = serverOf("claude-code", {
    transport: "http",
    projectPath: ABS_PROJECT,
  });
  assertEquals(server.type, "http");
  assertEquals(server.url, HTTP_URL);
  assertEquals(server.headers, {
    Authorization: "Bearer ${OPENTIDE_MCP_TOKEN}",
  });
  assertFalse("command" in server);
});

Deno.test("cursor http: url only, no type, no command", () => {
  const server = serverOf("cursor", {
    transport: "http",
    projectPath: ABS_PROJECT,
  });
  assertEquals(server.url, HTTP_URL);
  assertEquals(server.headers, {
    Authorization: "Bearer ${env:OPENTIDE_MCP_TOKEN}",
  });
  assertFalse("type" in server);
  assertFalse("command" in server);
});

Deno.test("codex http: url line, no command", () => {
  const toml = generateConnectConfig("codex", {
    transport: "http",
    projectPath: ABS_PROJECT,
  });
  assertStringIncludes(toml, "[mcp_servers.opentide]");
  assertStringIncludes(toml, `url = "${HTTP_URL}"`);
  assertStringIncludes(toml, `bearer_token_env_var = "OPENTIDE_MCP_TOKEN"`);
  assertFalse(toml.includes("command ="));
});

Deno.test("http --port override is reflected in the url", () => {
  const server = serverOf("cursor", {
    transport: "http",
    projectPath: ABS_PROJECT,
    port: 4000,
  });
  assertEquals(server.url, `http://${DEV_SERVER_HOST}:4000/mcp`);
});

Deno.test("serverName override sets the config entry key", () => {
  const parsed = JSON.parse(
    generateConnectConfig("claude-code", {
      transport: "stdio",
      projectPath: ABS_PROJECT,
      serverName: "my-tide",
    }),
  );
  assert("my-tide" in parsed.mcpServers);
  assertFalse("opentide" in parsed.mcpServers);
});

Deno.test("stdio placeholder passes through verbatim for a template", () => {
  const args: string[] = serverOf("cursor", {
    transport: "stdio",
    projectPath: PROJECT_PATH_PLACEHOLDER,
  }).args;
  assertEquals(args[args.length - 1], PROJECT_PATH_PLACEHOLDER);
});

Deno.test("every client × transport emits parseable output", () => {
  for (const client of MCP_CLIENTS) {
    for (const transport of ["stdio", "http"] as const) {
      const out = generateConnectConfig(client, {
        transport,
        projectPath: ABS_PROJECT,
      });
      assert(out.length > 0, `${client}/${transport} produced empty output`);
      if (client === "codex") {
        assertStringIncludes(out, "[mcp_servers.opentide]");
      } else {
        JSON.parse(out); // throws on malformed JSON
      }
    }
  }
});

Deno.test("isMcpClient guards the client set", () => {
  assert(isMcpClient("claude-code"));
  assert(isMcpClient("codex"));
  assert(isMcpClient("cursor"));
  assertFalse(isMcpClient("vscode"));
  assertFalse(isMcpClient(""));
});

// Thin CLI check: --print-config prints valid config to stdout and exits 0
// WITHOUT standing up a server (the subprocess returns promptly instead of
// blocking on stdio/HTTP). Also proves the stdout channel isn't clobbered by the
// module-level console.log→stderr redirect in mcp-main.ts.
Deno.test("--print-config prints config and exits 0 without serving", async () => {
  const cmd = new Deno.Command("deno", {
    args: [
      "task",
      "mcp",
      "--print-config",
      "cursor",
      "--project",
      ABS_PROJECT,
    ],
    cwd: REPO_ROOT,
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stdout } = await cmd.output();
  assertEquals(code, 0);
  const parsed = JSON.parse(new TextDecoder().decode(stdout));
  assertEquals(parsed.mcpServers.opentide.command, "deno");
});
