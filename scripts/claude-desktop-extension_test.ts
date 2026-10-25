import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "node:path";
import { OPENTIDE_VERSION } from "../core/config.ts";
import {
  buildExtension,
  EXTENSION_FILE,
  extensionSourceDir,
  ICON_PATH,
  PROJECT_FIELD,
  renderExtensionManifest,
  SHIM_PATH,
} from "./claude-desktop-extension.ts";

const source = extensionSourceDir();
const shim = join(source, SHIM_PATH);

function available(command: string): boolean {
  try {
    return new Deno.Command(command, {
      args: ["-v"],
      stdout: "null",
      stderr: "null",
    }).outputSync().success;
  } catch {
    return false;
  }
}

const hasNode = available("node");
const hasZip = available("zip") && available("unzip");

function request(id: number, method: string, params: unknown = {}): string {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
}

const INITIALIZE = request(1, "initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "test", version: "0" },
});

async function runShim(home: string, project: string, stdin = "") {
  const child = new Deno.Command("node", {
    args: [shim, project, "9.9.9"],
    env: { PATH: Deno.env.get("PATH") ?? "", HOME: home, OPENTIDE_HOME: "" },
    clearEnv: true,
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(stdin));
  await writer.close();
  const out = await child.output();
  const decode = (b: Uint8Array) => new TextDecoder().decode(b);
  return {
    code: out.code,
    stdout: decode(out.stdout),
    stderr: decode(out.stderr),
  };
}

Deno.test("claude desktop extension: the manifest runs the shim on the chosen folder", () => {
  const manifest = JSON.parse(renderExtensionManifest());
  assertEquals(manifest.version, OPENTIDE_VERSION);
  assertEquals(manifest.server.type, "node");
  assertEquals(manifest.server.entry_point, SHIM_PATH);
  assertEquals(manifest.server.mcp_config.args, [
    `\${__dirname}/${SHIM_PATH}`,
    `\${user_config.${PROJECT_FIELD}}`,
    OPENTIDE_VERSION,
  ]);
  const field = manifest.user_config[PROJECT_FIELD];
  assertEquals(field.type, "directory");
  assertEquals(field.required, true);
  assertEquals(manifest.icon, ICON_PATH);
});

Deno.test({
  name:
    "claude desktop extension: without opentide installed, it connects with one tool that says how to install it",
  ignore: !hasNode,
}, async () => {
  const home = await Deno.makeTempDir({ prefix: "opentide-mcpb-" });
  try {
    const r = await runShim(
      home,
      "/some/project",
      INITIALIZE + request(2, "tools/list") +
        request(3, "tools/call", { name: "opentide_setup", arguments: {} }),
    );
    assertEquals(r.code, 0);
    const [init, list, call] = r.stdout.trim().split("\n").map((l) =>
      JSON.parse(l)
    );
    assertEquals(init.result.serverInfo.version, "9.9.9");
    assertStringIncludes(init.result.instructions, "OpenTide isn't installed");
    assertEquals(list.result.tools.map((t: { name: string }) => t.name), [
      "opentide_setup",
    ]);
    assertStringIncludes(call.result.content[0].text, "install.sh | sh");
  } finally {
    await Deno.remove(home, { recursive: true });
  }
});

Deno.test({
  name:
    "claude desktop extension: the shim runs the installed opentide mcp on the folder",
  ignore: !hasNode,
}, async () => {
  const home = await Deno.makeTempDir({ prefix: "opentide-mcpb-" });
  try {
    const bin = join(home, ".opentide", "bin");
    await Deno.mkdir(bin, { recursive: true });
    const fake = join(bin, "opentide");
    await Deno.writeTextFile(fake, '#!/bin/sh\necho "ran: $*"\nexit 3\n');
    await Deno.chmod(fake, 0o755);
    const r = await runShim(home, "/my project");
    assertEquals(r.stdout.trim(), "ran: mcp --project /my project");
    assertEquals(r.code, 3);
    const tilde = await runShim(home, "~/apps/todo");
    assertEquals(
      tilde.stdout.trim(),
      `ran: mcp --project ${join(home, "apps/todo")}`,
    );
  } finally {
    await Deno.remove(home, { recursive: true });
  }
});

Deno.test({
  name:
    "claude desktop extension: the shim pipes stdin and stdout through to opentide",
  ignore: !hasNode,
}, async () => {
  const home = await Deno.makeTempDir({ prefix: "opentide-mcpb-" });
  try {
    const bin = join(home, ".opentide", "bin");
    await Deno.mkdir(bin, { recursive: true });
    const fake = join(bin, "opentide");
    await Deno.writeTextFile(
      fake,
      '#!/bin/sh\nwhile read -r line; do echo "got: $line"; done\necho bye >&2\n',
    );
    await Deno.chmod(fake, 0o755);
    // Like Desktop's UtilityProcess: fd 0 is empty, and process.stdin is a
    // stream fed from elsewhere (here, an environment variable).
    const harness = join(home, "harness.js");
    await Deno.writeTextFile(
      harness,
      `const { Readable } = require("node:stream");
Object.defineProperty(process, "stdin", {
  value: Readable.from([process.env.FEED]),
});
process.argv.splice(1, 1);
require(process.argv[1]);
`,
    );
    const child = new Deno.Command("node", {
      args: [harness, shim, "/p", "9.9.9"],
      env: {
        PATH: Deno.env.get("PATH") ?? "",
        HOME: home,
        OPENTIDE_HOME: "",
        FEED: "one\ntwo\n",
      },
      clearEnv: true,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    });
    const out = await child.output();
    const decode = (b: Uint8Array) => new TextDecoder().decode(b);
    const r = {
      code: out.code,
      stdout: decode(out.stdout),
      stderr: decode(out.stderr),
    };
    assertEquals(r.stdout, "got: one\ngot: two\n");
    assertStringIncludes(r.stderr, "bye");
    assertEquals(r.code, 0);
  } finally {
    await Deno.remove(home, { recursive: true });
  }
});

Deno.test({
  name:
    "claude desktop extension: the .mcpb holds the manifest, the shim and the icon",
  ignore: !hasZip,
}, async () => {
  const out = await Deno.makeTempDir({ prefix: "opentide-mcpb-" });
  try {
    const path = await buildExtension(source, out);
    assertEquals(path, join(out, EXTENSION_FILE));
    const listing = await new Deno.Command("unzip", {
      args: ["-Z1", path],
      stdout: "piped",
    }).output();
    const entries = new TextDecoder().decode(listing.stdout).split("\n")
      .filter((e) => e && !e.endsWith("/")).sort();
    assertEquals(entries, [ICON_PATH, "manifest.json", SHIM_PATH].sort());
    const manifest = await new Deno.Command("unzip", {
      args: ["-p", path, "manifest.json"],
      stdout: "piped",
    }).output();
    assert(
      new TextDecoder().decode(manifest.stdout) === renderExtensionManifest(),
    );
  } finally {
    await Deno.remove(out, { recursive: true });
  }
});
