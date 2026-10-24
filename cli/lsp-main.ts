// @layer composition — outbound LSP composition root. Assembles the same stack
// as the headless kernel and the MCP root (the open assembly unless a caller
// passes another) and serves the language-intelligence surface over the Language
// Server Protocol (JSON-RPC) on stdio instead of REST. This is the "external
// editors and agents consume the intelligence" face (docs/lsp-support-plan.md
// Stage 0), the read-only sibling of the MCP authoring surface: no IDE, no agent
// loop — just the language service, translated to LSP.
//
import { initCompiler, stopCompiler } from "../core/compiler.ts";
import { getLspArgs, openAssembly, type StackAssembly } from "./assembly.ts";
import { loadProject, unloadProject } from "../core/project-loader.ts";
import { LspServer } from "../lsp/server.ts";
import { serveLspStdio } from "../lsp/transport.ts";

// Usage/errors go to stderr; stdout is the LSP JSON-RPC channel and must carry
// only protocol frames — same discipline as mcp-main.ts.
const USAGE =
  `opentide lsp — Language Server Protocol server (editors & agents consume the intelligence)

USAGE:
  deno task lsp --project <path>

OPTIONS:
  -p, --project <path>   Project to serve (required).
  -h, --help             Show this help.

TRANSPORTS:
  stdio (default)   The editor/agent spawns the server and speaks LSP over stdio.
                    There is no HTTP/WebSocket transport yet.

Docs: docs/lsp-connect.md`;

// stdout is the LSP JSON-RPC transport channel, so it must carry ONLY protocol
// frames. project-loader/app-server/compiler log via console.log → stdout, which
// would corrupt the stream; redirect those to stderr before loading anything.
// console.error already goes to stderr. Done at serve time (not module top-level)
// so the dispatcher (cli.ts) can import this module without clobbering stdout.
function redirectStdoutToStderr(): void {
  for (const level of ["log", "info", "debug", "warn"] as const) {
    console[level] = (...args: unknown[]) => console.error(...args);
  }
}

// Serve the outbound LSP server over stdio. Reused verbatim by the `deno task lsp`
// direct entry (below) and the `opentide lsp` subcommand (cli.ts), which passes
// the args after the subcommand. `argv` defaults to Deno.args for the direct entry.
export async function serveLsp(
  argv: string[] = Deno.args,
  assembly: StackAssembly = openAssembly,
): Promise<void> {
  redirectStdoutToStderr();
  const { projectPath, help } = getLspArgs(argv);

  if (help) {
    console.error(USAGE);
    Deno.exit(0);
  }
  if (!projectPath) {
    console.error(USAGE);
    Deno.exit(2);
  }

  await initCompiler();
  console.error("  Compiler ready (esbuild)");

  // Thread the assembly's composition through the loaded project — parity with
  // the MCP root, so both standard-protocol surfaces boot the same kernel.
  const projectCtx = await loadProject(projectPath, {
    composition: assembly.composition(),
  });
  // loadProject already logs `Project "<name>" loaded` (redirected to stderr
  // here), so we don't repeat it (F-05).

  // The whole server is gated on the runtime offering language intelligence
  // (docs/lsp-support-plan.md Stage 0). Refuse to serve a runtime that can't,
  // rather than advertising an empty capability set and idling.
  if (!projectCtx.kernel.runtime.capabilities.languageIntelligence) {
    console.error(
      `  runtime "${projectCtx.kernel.runtimeId}" has no language ` +
        "intelligence; nothing to serve over LSP.",
    );
    await unloadProject(projectCtx).catch(() => {});
    stopCompiler();
    Deno.exit(1);
  }

  let shuttingDown = false;
  const shutdown = async (code: number) => {
    if (shuttingDown) return;
    shuttingDown = true;
    await unloadProject(projectCtx).catch(() => {});
    stopCompiler();
    Deno.exit(code);
  };

  Deno.addSignalListener("SIGINT", () => void shutdown(0));
  Deno.addSignalListener("SIGTERM", () => void shutdown(0));

  const server = new LspServer({
    kernel: projectCtx.kernel,
    rebuild: projectCtx.rebuild,
  });
  console.error("  LSP server ready on stdio. Connect an editor or agent.");
  // Resolves when the client disconnects (stdin closes) or sends `exit`; then
  // tear down cleanly.
  await serveLspStdio(server);
  await shutdown(0);
}

// Direct entry (`deno task lsp`); the dispatcher (cli.ts) calls serveLsp itself,
// so importing this module must not auto-run it.
if (import.meta.main) serveLsp();
