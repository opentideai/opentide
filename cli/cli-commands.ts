// @layer cli — the pure, core-only surface of the `opentide` CLI: subcommand
// parsing, usage text, and the core-wrapping command bodies. May import only
// core (§3.2) — `scaffold` (Slice B) wraps `createProject` from the core
// project-manager, this module's first core import. The composition dispatcher
// (cli.ts) owns all layer assembly (composition / loadProject / serve); this
// module knows nothing about how a command is wired to a server, only how the
// argv is shaped, what the surface advertises, and — for the assemble-nothing
// commands — the pure work itself. build/export (Slice C) need a loaded Kernel
// and so stay in the composition root, not here.
import { createProject } from "../core/project-manager.ts";
import { errorMessage } from "../core/util.ts";

export interface ParsedCli {
  // The subcommand (first positional), or null when none was given.
  command: string | null;
  // The argv after the subcommand, forwarded verbatim to the command (so the
  // existing --project/--http/… parsers see exactly what they'd see directly).
  rest: string[];
  // True when the user explicitly asked for help (`-h`/`--help`/`help`) at the
  // top level rather than naming a command.
  help: boolean;
  // True for a top-level `--version` / `-V` / `version`.
  version: boolean;
}

// Split argv into a subcommand and the remaining args. The subcommand is the
// first token; a leading help flag (or no token) yields a null command so the
// dispatcher shows usage. Command-specific flags are NOT interpreted here — the
// per-command parsers (getServeArgs / getMcpTransportArgs) own them.
export function parseCliCommand(argv: string[]): ParsedCli {
  const first = argv[0];
  const help = first === "-h" || first === "--help" || first === "help";
  const version = first === "-V" || first === "--version" ||
    first === "version";
  if (!first || help || version) {
    return { command: null, rest: [], help, version };
  }
  return { command: first, rest: argv.slice(1), help: false, version: false };
}

export function cliUsage(): string {
  return `opentide — headless entry point for the OpenTide core

USAGE:
  opentide <command> [options]

COMMANDS:
  serve      Run the headless REST core (no UI, no API key) for one project.
  mcp        Serve the outbound MCP server for external coding agents.
  lsp        Serve the outbound LSP server for external editors and agents.
  scaffold   Create a new, loadable project under a parent directory.
  build      Build a deployable app into dist/ (Node by default).
  export     Export the app as an unpacked file tree or a tarball (Node by default).
  task       Fork a project into a parallel task (start), list or discard tasks.
  lock:refresh
             Regenerate the committed deno.lock / package-lock.json (network-
             allowed; runs OUTSIDE the build path) and prove each is frozen-valid.

Run a command with its own flags; pass --help to a command for its options.
\`opentide --version\` prints the version. From a clone, \`deno task opentide\`
runs the same commands.

EXAMPLES:
  opentide serve    --project /path/to/project [--port <n>] [--app-port <n>]
  opentide mcp      --project /path/to/project [--standalone | --http]
  opentide lsp      --project /path/to/project
  opentide scaffold ./parent-dir "My App"
  opentide build    --project /path/to/project [--target node|deno] [--include-seed-data]
  opentide export   --project /path/to/project [--target node|deno] [--out <p>] [--tarball] [--force] [--include-seed-data]
  opentide lock:refresh --project /path/to/project [--target deno-source|node]
  opentide task start --project /path/to/project --title "<t>" [--claim <scope>]...
  opentide task list  --project /path/to/project
  opentide task merge --project /path/to/project <task-id>
  opentide task discard --project /path/to/project <task-id>

Docs: docs/opentide-cli.md`;
}

// The outcome of running `scaffold` — the pure work, decoupled from rendering so
// the happy path is unit-testable without a subprocess (Slice B decision 3). This
// carries the *semantic* category; the dispatcher (cli.ts) owns how each maps to
// a stream + numeric exit code:
//   ok         → the project was created; report the resolved path.
//   kind:usage → bad invocation (missing/extra args).
//   kind:error → createProject failed (e.g. a project already exists there).
export type ScaffoldResult =
  | { ok: true; path: string; name: string }
  | { ok: false; kind: "usage" | "error"; message: string };

// Create a new project from `scaffold`'s positional args (<dir> <name>), the argv
// after the subcommand. This is the genuinely assemble-nothing command: it wraps
// the core `createProject` primitive verbatim and touches no kernel, no layers,
// no stores. Note the D2 ergonomics leak we deliberately do NOT paper over —
// createProject treats <dir> as the PARENT and creates <dir>/slug(<name>), so the
// created folder is the slug of the name, not the literal <dir>; the dispatcher
// surfaces the resolved path so the user sees exactly where it landed.
export function scaffoldCommand(rest: string[]): ScaffoldResult {
  const [dir, name, ...extra] = rest;
  if (!dir || !name) {
    return {
      ok: false,
      kind: "usage",
      message: "error: `scaffold` requires <dir> and <name>.",
    };
  }
  if (extra.length > 0) {
    return {
      ok: false,
      kind: "usage",
      message: `error: unexpected argument "${extra[0]}" ` +
        "(scaffold takes exactly <dir> <name>).",
    };
  }
  try {
    const project = createProject(dir, name);
    return { ok: true, path: project.path, name: project.name };
  } catch (e) {
    return { ok: false, kind: "error", message: `error: ${errorMessage(e)}` };
  }
}
