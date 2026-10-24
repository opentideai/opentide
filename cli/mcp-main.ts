// @layer composition — outbound MCP composition root. Assembles the same stack
// as the headless kernel (the open assembly unless a caller passes another) and
// serves the core tool surface over MCP stdio instead of the
// REST control server. This is the "external agents drive the core" face
// (OpenTide §4, Phase 3): no IDE, no integrated agent loop — just the tools.
//
import { resolve } from "node:path";
import { initCompiler, stopCompiler } from "../core/compiler.ts";
import {
  getMcpTransportArgs,
  type McpTransportArgs,
  openAssembly,
  type StackAssembly,
} from "./assembly.ts";
import { loadProject, unloadProject } from "../core/project-loader.ts";
import { serveMcpStdio } from "../mcp/mcp-server.ts";
import { serveMcpHttp } from "../mcp/mcp-http.ts";
import { runMcpBridge } from "../mcp/mcp-bridge.ts";
import {
  connectConfigTarget,
  generateConnectConfig,
  isMcpClient,
  MCP_CLIENTS,
  type McpTransport,
  PROJECT_PATH_PLACEHOLDER,
} from "../mcp/mcp-connect.ts";
import {
  MCP_HTTP_PATH,
  MCP_HTTP_PORT,
  SERVER_TOKEN_ENV,
} from "../core/config.ts";
import {
  resolveServerToken,
  serverTokenPath,
  writeServerToken,
} from "../core/server-token.ts";

// Usage/errors go to stderr; keeping stdout clean matters because it is the
// stdio-serve JSON-RPC channel (and the --print-config paste target).
const USAGE =
  `opentide mcp — outbound MCP server (external agents drive the core)

USAGE:
  deno task mcp --project <path> [--standalone | --http [--port N]]
  deno task mcp --print-config <${
    MCP_CLIENTS.join("|")
  }> [--project <path>] [--http [--port N]]

OPTIONS:
  -p, --project <path>       Project to serve (required to serve; embedded in a printed stdio config).
      --standalone           Load the project in this process instead of bridging to its serve process.
      --http                 Serve streamable-HTTP on 127.0.0.1:<port> instead of stdio.
      --port <N>             HTTP port (default ${MCP_HTTP_PORT}).
      --print-config <client>  Print a ready-to-paste client config and exit (${
    MCP_CLIENTS.join(", ")
  }).
  -h, --help                 Show this help.

TRANSPORTS:
  stdio (default)   The client spawns this as a bridge to the project's
                    \`opentide serve\`, starting serve if it isn't running.
                    Several clients and the IDE share the one serve process.
  stdio --standalone  The old in-process server. Holds the project alone.
  http (--http)     A standalone HTTP server. \`opentide serve\` already answers
                    MCP at ${MCP_HTTP_PATH} on its control port; prefer that.

Docs: docs/mcp-connect.md`;

// stdout is the MCP JSON-RPC transport channel, so it must carry ONLY protocol
// frames. Everything downstream (project-loader, app-server, compiler) logs via
// console.log → stdout, which would corrupt the stream. Redirect those to stderr
// before loading anything. console.error already goes to stderr. This is done at
// the start of serveMcp (not module top-level) so the dispatcher (cli.ts) can
// import this module for the mcp branch without clobbering the serve branch's
// stdout logging.
function redirectStdoutToStderr(): void {
  for (const level of ["log", "info", "debug", "warn"] as const) {
    console[level] = (...args: unknown[]) => console.error(...args);
  }
}

// Write straight to stdout, bypassing the console.log→stderr redirect above, so
// --print-config emits a clean config body a user can pipe or copy.
function writeStdout(text: string): void {
  const bytes = new TextEncoder().encode(text);
  for (let written = 0; written < bytes.length;) {
    written += Deno.stdout.writeSync(bytes.subarray(written));
  }
}

// Emit a connect config for the requested client and exit — no project load, no
// server. The guidance header goes to stderr; the config body to stdout.
function printConfigAndExit(args: McpTransportArgs): never {
  const client = args.printConfig!;
  if (!isMcpClient(client)) {
    console.error(
      `Unknown --print-config client "${client}". Expected one of: ` +
        `${MCP_CLIENTS.join(", ")}.`,
    );
    Deno.exit(2);
  }
  const transport: McpTransport = args.http ? "http" : "stdio";
  const projectPath = args.projectPath
    ? resolve(args.projectPath)
    : PROJECT_PATH_PLACEHOLDER;
  const config = generateConnectConfig(client, {
    transport,
    projectPath,
    port: args.port,
  });
  console.error(
    `# ${client} — ${transport} — write to: ${connectConfigTarget(client)}`,
  );
  if (transport === "stdio" && !args.projectPath) {
    console.error(
      `# NOTE: replace ${PROJECT_PATH_PLACEHOLDER} with your project's absolute path.`,
    );
  }
  writeStdout(`${config}\n`);
  Deno.exit(0);
}

// Serve the outbound MCP server. Reused verbatim by the `deno task mcp` direct
// entry (below) and the `opentide mcp` subcommand (cli.ts), which passes the
// args after the subcommand. `argv` defaults to Deno.args for the direct entry.
export async function serveMcp(
  argv: string[] = Deno.args,
  assembly: StackAssembly = openAssembly,
): Promise<void> {
  redirectStdoutToStderr();
  const args = getMcpTransportArgs(MCP_HTTP_PORT, argv);
  const { projectPath, http, port } = args;

  if (args.help) {
    console.error(USAGE);
    Deno.exit(0);
  }
  if (args.printConfig !== null) printConfigAndExit(args);

  if (!projectPath) {
    console.error(USAGE);
    Deno.exit(2);
  }

  if (!http && !args.standalone) Deno.exit(await runMcpBridge(projectPath));

  await initCompiler();
  console.error("  Compiler ready (esbuild)");

  // Thread the assembly's composition through the loaded project. Verbs whose
  // capability it lacks are hidden from the projection; model-backed verbs it
  // carries degrade gracefully (not-configured) rather than throw.
  const projectCtx = await loadProject(projectPath, {
    composition: assembly.composition(),
  });
  // loadProject already logs `Project "<name>" loaded` (redirected to stderr
  // here), so we don't repeat it (F-05).

  // A standalone MCP server holds the project alone: nothing can attach to it,
  // and a later `opentide serve` has to be refused, not proxied.
  projectCtx.lock?.advertise({ role: "mcp" });

  const deps = { kernel: projectCtx.kernel, rebuild: projectCtx.rebuild };
  // The HTTP transport runs its own listener until shutdown; capture it so the
  // signal handlers can stop it before tearing the project down.
  const token = http ? resolveServerToken() : null;
  if (token) {
    const written = writeServerToken(projectCtx.entry.path, token);
    if (!written.ok) console.error(`  ${written.error.message}`);
  }
  const httpServer = token ? serveMcpHttp(deps, port, token) : null;

  let shuttingDown = false;
  const shutdown = async (code: number) => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (httpServer) await httpServer.shutdown().catch(() => {});
    await unloadProject(projectCtx).catch(() => {});
    stopCompiler();
    Deno.exit(code);
  };

  // Every signal that can reasonably reach a stdio MCP server, not just the two an
  // interactive terminal sends. SIGHUP is the one that bites: the client closing, the
  // terminal window going away or an SSH session dropping all deliver it, and the
  // default action is immediate death — no unload, no checkpoint, and on PGlite that
  // means a data directory that will not open again. SIGKILL cannot be caught, which
  // is why the periodic checkpoint in backup-cadence.ts exists as well as this.
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"] as const) {
    Deno.addSignalListener(signal, () => void shutdown(0));
  }

  if (httpServer) {
    // Loopback only (DEV_SERVER_HOST) — the MCP surface exposes mutating verbs.
    const portHint = httpServer.port !== MCP_HTTP_PORT
      ? ` --port ${httpServer.port}`
      : "";
    console.error(
      `  MCP server ready on http://127.0.0.1:${httpServer.port}${MCP_HTTP_PATH}. ` +
        "Connect an external agent (streamable-HTTP).\n" +
        `  Bearer token: ${serverTokenPath(projectCtx.entry.path)} ` +
        `(pin it across restarts with ${SERVER_TOKEN_ENV}).\n` +
        `  Client config: deno task mcp --print-config cursor --http${portHint}`,
    );
    // Stay up until a signal triggers shutdown; the listener runs in background.
    return;
  }

  console.error("  MCP server ready on stdio. Connect an external agent.");
  // Resolves when the client disconnects (stdin closes); then tear down cleanly.
  await serveMcpStdio(deps);
  await shutdown(0);
}

// Direct entry (`deno task mcp`); the dispatcher (cli.ts) calls serveMcp itself,
// so importing this module must not auto-run it.
if (import.meta.main) serveMcp();
