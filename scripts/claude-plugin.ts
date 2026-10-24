// The Claude Code plugin: plugins/opentide in the public repo, which is also its
// own marketplace (.claude-plugin/marketplace.json).
//
//   /plugin marketplace add opentideai/opentide
//   /plugin install opentide@opentide
//
// Its slash commands are the MCP prompts (mcp/mcp-prompts.ts) written out as
// files, so /opentide:start reads the same text the prompt serves. The commands
// and the plugin's version are GENERATED; edit the prompts, then run
//
//     deno task plugin:generate
//
// scripts/claude-plugin_test.ts fails when the files on disk drift.
//
// In this repo the plugin lives under mirror/, which the export copies over the
// public root; in the public repo (and in check:open's copy) it is at the root.
import { existsSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { OPENTIDE_VERSION } from "../core/config.ts";
import { coreOnlyComposition } from "../core/composition.ts";
import { MCP_PROMPTS, type McpPromptDefinition } from "../mcp/mcp-prompts.ts";

export const PLUGIN_NAME = "opentide";
export const PLUGIN_DIR = `plugins/${PLUGIN_NAME}`;
export const MARKETPLACE_PATH = ".claude-plugin/marketplace.json";
export const MANIFEST_PATH = `${PLUGIN_DIR}/.claude-plugin/plugin.json`;
export const MCP_CONFIG_PATH = `${PLUGIN_DIR}/.mcp.json`;
export const LAUNCHER_PATH = `${PLUGIN_DIR}/bin/opentide-mcp`;

// What Claude Code substitutes in .mcp.json for the plugin's install directory.
const PLUGIN_ROOT_VAR = "${CLAUDE_PLUGIN_ROOT}";
const ARGUMENTS_VAR = "$ARGUMENTS";

const REPO_ROOT = normalize(
  join(dirname(new URL(import.meta.url).pathname), ".."),
);

// Where the plugin and the marketplace file sit: mirror/ here, the root elsewhere.
export function pluginBase(repoRoot = REPO_ROOT): string {
  const mirror = join(repoRoot, "mirror");
  return existsSync(join(mirror, PLUGIN_DIR)) ? mirror : repoRoot;
}

export function commandPath(prompt: McpPromptDefinition): string {
  return `${PLUGIN_DIR}/commands/${prompt.name}.md`;
}

// A required argument becomes what the user typed after the command; an optional
// one renders as absent, with what they typed appended for the agent to use.
export function renderCommand(prompt: McpPromptDefinition): string {
  const args: Record<string, string | undefined> = {};
  const optional: string[] = [];
  for (const arg of prompt.arguments ?? []) {
    if (arg.required) args[arg.name] = ARGUMENTS_VAR;
    else optional.push(arg.name);
  }
  const hint = (prompt.arguments ?? []).map((a) =>
    a.required ? `<${a.name}>` : `[${a.name}]`
  ).join(" ");
  const body = prompt.render(args, coreOnlyComposition());
  const trailer = optional.length === 0
    ? ""
    : `\n\n${
      optional.map((name) => `${name}, if given: ${ARGUMENTS_VAR}`).join("\n")
    }`;
  return [
    "---",
    `description: ${JSON.stringify(prompt.description)}`,
    ...(hint ? [`argument-hint: ${JSON.stringify(hint)}`] : []),
    // A person starts these by name, as with the prompts; Claude never does.
    "disable-model-invocation: true",
    "---",
    "",
    `${body}${trailer}`,
    "",
  ].join("\n");
}

export function renderManifest(): string {
  return JSON.stringify(
    {
      name: PLUGIN_NAME,
      displayName: "OpenTide",
      version: OPENTIDE_VERSION,
      description:
        "Build and change a running OpenTide app from Claude Code: every change goes through a verified, reversible changeset.",
      author: { name: "OpenTide", url: "https://github.com/opentideai" },
      homepage: "https://github.com/opentideai/opentide",
      repository: "https://github.com/opentideai/opentide",
      license: "Apache-2.0",
      keywords: ["mcp", "opentide", "typescript", "deno", "verification"],
    },
    null,
    2,
  ) + "\n";
}

export function renderMcpConfig(): string {
  return JSON.stringify(
    {
      mcpServers: {
        [PLUGIN_NAME]: {
          command: "sh",
          args: [`${PLUGIN_ROOT_VAR}/bin/opentide-mcp`],
        },
      },
    },
    null,
    2,
  ) + "\n";
}

// Every generated file, by path under pluginBase().
export function generatedFiles(): Record<string, string> {
  const files: Record<string, string> = {
    [MANIFEST_PATH]: renderManifest(),
    [MCP_CONFIG_PATH]: renderMcpConfig(),
  };
  for (const prompt of MCP_PROMPTS) {
    files[commandPath(prompt)] = renderCommand(prompt);
  }
  return files;
}

if (import.meta.main) {
  const base = pluginBase();
  for (const [path, content] of Object.entries(generatedFiles())) {
    const target = join(base, path);
    await Deno.mkdir(dirname(target), { recursive: true });
    await Deno.writeTextFile(target, content);
    console.log(`wrote ${target}`);
  }
}
