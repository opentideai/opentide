import { assert, assertEquals } from "@std/assert";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  generatedFiles,
  LAUNCHER_PATH,
  MARKETPLACE_PATH,
  MCP_CONFIG_PATH,
  PLUGIN_DIR,
  PLUGIN_NAME,
  pluginBase,
} from "./claude-plugin.ts";
import { MCP_PROMPTS } from "../mcp/mcp-prompts.ts";

const base = pluginBase();

Deno.test("claude plugin: the generated files are current (deno task plugin:generate)", async () => {
  for (const [path, expected] of Object.entries(generatedFiles())) {
    const actual = await Deno.readTextFile(join(base, path));
    assertEquals(actual, expected, `${path} is stale`);
  }
});

Deno.test("claude plugin: one command per MCP prompt, and no others", () => {
  const commands = [...Deno.readDirSync(join(base, PLUGIN_DIR, "commands"))]
    .map((e) => e.name).sort();
  assertEquals(commands, MCP_PROMPTS.map((p) => `${p.name}.md`).sort());
});

Deno.test("claude plugin: the marketplace lists the plugin at its directory", async () => {
  const market = JSON.parse(
    await Deno.readTextFile(join(base, MARKETPLACE_PATH)),
  );
  assertEquals(market.name, PLUGIN_NAME);
  assert(typeof market.owner?.name === "string");
  assertEquals(market.plugins.length, 1);
  assertEquals(market.plugins[0].name, PLUGIN_NAME);
  assertEquals(market.plugins[0].source, `./${PLUGIN_DIR}`);
});

Deno.test("claude plugin: .mcp.json runs the launcher the plugin ships", async () => {
  const config = JSON.parse(
    await Deno.readTextFile(join(base, MCP_CONFIG_PATH)),
  );
  const server = config.mcpServers[PLUGIN_NAME];
  assertEquals(server.command, "sh");
  assertEquals(server.args, ["${CLAUDE_PLUGIN_ROOT}/bin/opentide-mcp"]);
  assert(existsSync(join(base, LAUNCHER_PATH)));
});

Deno.test("claude plugin: without opentide installed, the launcher says how to install it", async () => {
  const home = await Deno.makeTempDir({ prefix: "opentide-plugin-" });
  try {
    const out = await new Deno.Command("sh", {
      args: [join(base, LAUNCHER_PATH)],
      env: { PATH: "/usr/bin:/bin", HOME: home },
      clearEnv: true,
      stdout: "piped",
      stderr: "piped",
    }).output();
    assertEquals(out.code, 127);
    assertEquals(out.stdout.length, 0);
    const stderr = new TextDecoder().decode(out.stderr);
    assert(stderr.includes("OpenTide isn't installed"), stderr);
    assert(stderr.includes("install.sh | sh"), stderr);
  } finally {
    await Deno.remove(home, { recursive: true });
  }
});

Deno.test("claude plugin: the launcher prefers the installed opentide and passes arguments", async () => {
  const home = await Deno.makeTempDir({ prefix: "opentide-plugin-" });
  try {
    const bin = join(home, ".opentide", "bin");
    await Deno.mkdir(bin, { recursive: true });
    const fake = join(bin, "opentide");
    await Deno.writeTextFile(fake, '#!/bin/sh\necho "ran: $*"\n');
    await Deno.chmod(fake, 0o755);
    const out = await new Deno.Command("sh", {
      args: [join(base, LAUNCHER_PATH), "--standalone"],
      env: { PATH: "/usr/bin:/bin", HOME: home },
      clearEnv: true,
      stdout: "piped",
    }).output();
    assertEquals(out.code, 0);
    assertEquals(
      new TextDecoder().decode(out.stdout).trim(),
      "ran: mcp --standalone",
    );
  } finally {
    await Deno.remove(home, { recursive: true });
  }
});
