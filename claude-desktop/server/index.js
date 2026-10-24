// Starts the OpenTide MCP server for Claude Desktop: the installed
// `opentide mcp` on the project folder chosen in the extension's settings.
//
//   node index.js <project folder>
//
// Desktop runs this on its own Node, without the shell's PATH, so it looks for
// the launcher where install.sh puts it.
//
// When that isn't there, it still connects, with one tool and instructions
// that say how to install OpenTide. Desktop shows a server that fails to start
// only as "unable to connect", and puts its stderr in main.log, not the log
// its "View logs" opens; Claude, asked to use OpenTide, reads the tool.
"use strict";
const { spawn } = require("node:child_process");
const { existsSync } = require("node:fs");
const { homedir } = require("node:os");
const { join } = require("node:path");

const INSTALL_COMMAND =
  "curl -fsSL https://github.com/opentideai/opentide/releases/latest/download/install.sh | sh";
const NOT_INSTALLED =
  `OpenTide isn't installed. Install it in a terminal, then turn the OpenTide extension off and on again in Claude Desktop (Settings → Extensions):\n  ${INSTALL_COMMAND}`;
const SETUP_TOOL = "opentide_setup";
const PROTOCOL_VERSION = "2025-06-18";
// JSON-RPC's "method not found".
const METHOD_NOT_FOUND = -32601;
const FORWARDED_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];

function launcherPath() {
  const home = process.env.OPENTIDE_HOME || join(homedir(), ".opentide");
  return join(home, "bin", "opentide");
}

// Desktop takes the folder as typed, so "~/apps/todo" arrives unexpanded.
function expandHome(path) {
  if (path === "~") return homedir();
  if (path && path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

function runOpenTide(launcher, project) {
  const args = project ? ["mcp", "--project", project] : ["mcp"];
  const child = spawn(launcher, args, { stdio: "inherit" });
  for (const signal of FORWARDED_SIGNALS) {
    process.on(signal, () => child.kill(signal));
  }
  child.on("error", (err) => {
    process.stderr.write(`Couldn't start ${launcher}: ${err.message}\n`);
    process.exit(1);
  });
  child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
}

function reply(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function notInstalledResult(request, version) {
  switch (request.method) {
    case "initialize":
      return {
        protocolVersion: request.params?.protocolVersion ?? PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "opentide", version },
        instructions: NOT_INSTALLED,
      };
    case "ping":
      return {};
    case "tools/list":
      return {
        tools: [{
          name: SETUP_TOOL,
          title: "Set up OpenTide",
          description:
            "OpenTide isn't installed on this computer, so its tools aren't available. Call this when the user asks for anything OpenTide does, and give them the steps it returns.",
          inputSchema: { type: "object", properties: {} },
        }],
      };
    case "tools/call":
      return { content: [{ type: "text", text: NOT_INSTALLED }] };
    default:
      return undefined;
  }
}

// A server with only the setup tool, until OpenTide is installed and Desktop
// restarts the extension.
function serveNotInstalled(version) {
  process.stderr.write(`${NOT_INSTALLED}\n`);
  let buffered = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffered += chunk;
    let newline;
    while ((newline = buffered.indexOf("\n")) >= 0) {
      const line = buffered.slice(0, newline).trim();
      buffered = buffered.slice(newline + 1);
      if (!line) continue;
      let request;
      try {
        request = JSON.parse(line);
      } catch {
        continue;
      }
      if (request.id === undefined) continue;
      const result = notInstalledResult(request, version);
      reply(
        result === undefined
          ? {
            jsonrpc: "2.0",
            id: request.id,
            error: {
              code: METHOD_NOT_FOUND,
              message: `${request.method} isn't available: ${NOT_INSTALLED}`,
            },
          }
          : { jsonrpc: "2.0", id: request.id, result },
      );
    }
  });
  process.stdin.on("end", () => process.exit(0));
}

const [project, version = "0.0.0"] = process.argv.slice(2);
const launcher = launcherPath();
if (existsSync(launcher)) runOpenTide(launcher, expandHome(project));
else serveNotInstalled(version);
