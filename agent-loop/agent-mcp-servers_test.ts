import { assert, assertEquals } from "@std/assert";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseMcpServerConfigInput,
  projectMcpServers,
} from "./agent-mcp-servers.ts";
import {
  AGENT_MCP_SERVERS_FILE,
  AGENT_MCP_SERVERS_FILE_MODE,
  LEGACY_MCP_SERVERS_CONFIG,
} from "../core/config.ts";
import { projectStateDir } from "../core/project-layout.ts";
import { getProjectPaths } from "../core/project-manager.ts";
import { isolateHome, TEST_TMP_DIR } from "../core/test-home_test.ts";

isolateHome();

// Disabled, so nothing tries to connect.
const OFF = {
  name: "docs",
  transport: "url",
  url: "http://127.0.0.1:1/mcp",
  enabled: false,
};

async function projectDir(): Promise<string> {
  return await Deno.makeTempDir({ dir: TEST_TMP_DIR, prefix: "agent-mcp-" });
}

function storeFile(dir: string): string {
  return join(projectStateDir(dir), AGENT_MCP_SERVERS_FILE);
}

Deno.test("the agent's MCP list persists owner-only and survives a reload", async () => {
  const dir = await projectDir();
  const servers = projectMcpServers(dir);
  const added = await servers.add(OFF);
  assert(added.ok);
  assertEquals(added.server.status, "disconnected");
  assertEquals(
    statSync(storeFile(dir)).mode & 0o777,
    AGENT_MCP_SERVERS_FILE_MODE,
  );

  const edited = await servers.update("docs", { authToken: "t0ken" });
  assert(edited.ok);
  assertEquals(projectMcpServers(dir).list().map((s) => s.authToken), [
    "t0ken",
  ]);

  assert(await servers.remove("docs"));
  assertEquals(await servers.remove("docs"), false);
  assertEquals(JSON.parse(readFileSync(storeFile(dir), "utf-8")), []);
  await servers.close();
});

Deno.test("the agent's MCP list refuses duplicates, strangers and bad fields", async () => {
  const dir = await projectDir();
  const servers = projectMcpServers(dir);
  assert((await servers.add(OFF)).ok);
  assertEquals(await servers.add(OFF), {
    ok: false,
    status: 409,
    error: 'Server "docs" already exists',
  });
  assertEquals(await servers.update("nope", {}), {
    ok: false,
    status: 404,
    error: 'Server "nope" not found',
  });
  assertEquals(await servers.update("docs", { enabled: "yes" }), {
    ok: false,
    status: 400,
    error: "enabled must be a boolean",
  });
  await servers.close();
});

Deno.test("a project's list in serve's configs is copied once, serve's left alone", async () => {
  const dir = await projectDir();
  const stateDir = getProjectPaths(dir).stateDir;
  mkdirSync(stateDir, { recursive: true });
  const configs = JSON.stringify([
    { name: "other", value: 1, updatedAt: "2026-10-01T00:00:00Z" },
    {
      name: LEGACY_MCP_SERVERS_CONFIG,
      value: [OFF],
      updatedAt: "2026-10-01T00:00:00Z",
    },
  ]);
  writeFileSync(join(stateDir, "configs.json"), configs);

  const servers = projectMcpServers(dir);
  assertEquals(servers.list().map((s) => s.name), ["docs"]);
  assert(await servers.remove("docs"));
  assertEquals(projectMcpServers(dir).list(), []);
  assertEquals(readFileSync(join(stateDir, "configs.json"), "utf-8"), configs);
  await servers.close();
});

Deno.test("parseMcpServerConfigInput rejects non-string stdio args", () => {
  assertEquals(
    parseMcpServerConfigInput({
      name: "local",
      transport: "stdio",
      command: "tool",
      args: ["ok", 123],
    }),
    { ok: false, error: "args must be an array of strings" },
  );
});

Deno.test("parseMcpServerConfigInput rejects non-string stdio env values", () => {
  assertEquals(
    parseMcpServerConfigInput({
      name: "local",
      transport: "stdio",
      command: "tool",
      env: { GOOD: "yes", BAD: false },
    }),
    { ok: false, error: "env must be an object of string values" },
  );
});
