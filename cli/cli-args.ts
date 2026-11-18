// @layer cli — the pure argv parsers for the composition roots (serve, build,
// export, lock:refresh, mcp, lsp). They live apart from assembly.ts so a root
// can read its arguments without loading the stack: `opentide mcp` in a folder
// that is just a relay to serve must not pull in the database or the compiler
// (cli/startup-weight_test.ts holds that line).
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import {
  APP_PORT_AUTO,
  LAUNCHER_ENV,
  SERVE_EXIT_WHEN_IDLE_FLAG,
} from "../core/config.ts";
import type { Result } from "../core/types.ts";
import { hasProjectManifest } from "../core/project-layout.ts";
// Parse the headless serve entry args (--project/-p + --port + --app-port +
// --ui-dist) for main.ts and the `opentide serve` dispatcher. --port mirrors
// desktop-main.ts
// and the mcp root's --port so all control-server-bearing roots configure the
// port the same way (an invalid --port falls back to the default). --app-port
// sets the project's app-preview port; it defaults to APP_PORT_AUTO (0 =
// OS-assigned free port) so two stacks side-by-side never collide, matching the
// desktop root. Pass an explicit --app-port to pin a stable preview port.
// Reading argv belongs in the composition layer, not the core it drives
// (OpenTide §10). `argv` defaults to Deno.args for direct entry; the dispatcher
// (cli.ts) passes the args after the subcommand so `opentide serve --project x`
// parses.
export interface ServeArgs {
  projectPath: string | null;
  port: number;
  appPort: number;
  // --ui-dist DIR: serve a prebuilt IDE bundle from DIR via startControlServer's
  // staticUiDir, so a child is a self-contained stack (Feature B, decision #4).
  // null ⇒ no static UI (dev relies on the separate Vite server). Mirrors the
  // desktop root's existing --ui-dist spelling (desktop/desktop-main.ts).
  uiDist: string | null;
  // --exit-when-idle: exit once no client has been connected for a while. The
  // bridge passes it to the serve it starts (core/serve-process.ts).
  exitWhenIdle: boolean;
}

export function getServeArgs(
  defaultPort: number,
  argv: string[] = Deno.args,
): ServeArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      project: { type: "string", short: "p" },
      port: { type: "string" },
      "app-port": { type: "string" },
      "ui-dist": { type: "string" },
      [SERVE_EXIT_WHEN_IDLE_FLAG]: { type: "boolean" },
    },
    allowPositionals: true,
  });
  const parsed = values.port ? Number(values.port) : defaultPort;
  const port = Number.isFinite(parsed) && parsed > 0 ? parsed : defaultPort;
  // An unset or invalid --app-port yields APP_PORT_AUTO (0): let the OS assign a
  // free port. 0 is itself a valid explicit value with the same meaning.
  const parsedApp = values["app-port"] !== undefined
    ? Number(values["app-port"])
    : APP_PORT_AUTO;
  const appPort = Number.isInteger(parsedApp) && parsedApp >= 0
    ? parsedApp
    : APP_PORT_AUTO;
  return {
    projectPath: values.project ?? null,
    port,
    appPort,
    uiDist: values["ui-dist"] ?? null,
    exitWhenIdle: values[SERVE_EXIT_WHEN_IDLE_FLAG] === true,
  };
}

// What `opentide build` and `opentide export` produce. Node is the default:
// it is what an exported app runs on in production. `deno` remains for
// existing Deno deployments.
export const OUTPUT_TARGETS = ["node", "deno"] as const;
export type OutputTarget = typeof OUTPUT_TARGETS[number];
export const DEFAULT_OUTPUT_TARGET: OutputTarget = "node";

export function isOutputTarget(value: string): value is OutputTarget {
  return (OUTPUT_TARGETS as readonly string[]).includes(value);
}

// The `opentide build` entry args. A pure parser (same parseArgs shape as
// getServeArgs) so the dispatcher can enforce the required project and check
// the target without a loaded kernel. `target` is the raw --target value.
export interface BuildArgs {
  projectPath: string | null;
  includeSeedData: boolean;
  target: string;
}

export function getBuildArgs(argv: string[] = Deno.args): BuildArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      project: { type: "string", short: "p" },
      "include-seed-data": { type: "boolean" },
      target: { type: "string" },
    },
    allowPositionals: true,
  });
  return {
    projectPath: values.project ?? null,
    includeSeedData: Boolean(values["include-seed-data"]),
    target: values.target ?? DEFAULT_OUTPUT_TARGET,
  };
}

// The `opentide export` entry args: --project (required, enforced upstream),
// optional --out (output path — a directory for the default file-tree form, a
// .tar path for --tarball), and --tarball to select the packed form over the
// unpacked tree. Pure parser, unit-testable without a kernel.
export interface ExportArgs {
  projectPath: string | null;
  out: string | null;
  tarball: boolean;
  includeSeedData: boolean;
  // --force: overwrite an explicit --out target even when it is a non-empty dir
  // (tree form) or an existing file (tarball), clearing stale files first. The
  // managed defaults always overwrite; this only unlocks an explicit --out.
  force: boolean;
  // The raw --target value; see OUTPUT_TARGETS.
  target: string;
}

export function getExportArgs(argv: string[] = Deno.args): ExportArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      project: { type: "string", short: "p" },
      out: { type: "string" },
      tarball: { type: "boolean" },
      "include-seed-data": { type: "boolean" },
      force: { type: "boolean" },
      target: { type: "string" },
    },
    allowPositionals: true,
  });
  return {
    projectPath: values.project ?? null,
    out: values.out ?? null,
    tarball: Boolean(values.tarball),
    includeSeedData: Boolean(values["include-seed-data"]),
    force: Boolean(values.force),
    target: values.target ?? DEFAULT_OUTPUT_TARGET,
  };
}

// The `opentide lock:refresh` entry args: --project (required, enforced
// upstream) and a repeatable `--target` selecting which committed locks to
// regenerate (deno-source / node). No --target ⇒ null ⇒ the dispatcher applies
// the producer's default (both). Kept a pure argv parser — the raw target strings
// are validated against the closed target set in the composition root (cli.ts),
// which owns the verification constants. `--target a,b` is also split on commas so
// a single flag can name several targets.
export interface LockRefreshArgs {
  projectPath: string | null;
  // null when no --target was given (apply the default set); otherwise the raw,
  // comma-split, still-unvalidated target tokens.
  targets: string[] | null;
}

export function getLockRefreshArgs(
  argv: string[] = Deno.args,
): LockRefreshArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      project: { type: "string", short: "p" },
      target: { type: "string", multiple: true },
    },
    allowPositionals: true,
  });
  const raw = values.target as string[] | undefined;
  const targets = raw === undefined ? null : raw
    .flatMap((t) => t.split(","))
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  return { projectPath: values.project ?? null, targets };
}

// The MCP composition root's transport selection: default stdio, `--http`
// [`--port N`] serves over streamable-HTTP. `defaultPort` is passed in (the
// MCP_HTTP_PORT config constant) so this stays a pure argv parser with no
// core-config dependency. An invalid --port falls back to the default rather
// than binding somewhere unexpected.
export interface McpTransportArgs {
  projectPath: string | null;
  http: boolean;
  port: number;
  // --standalone: load the project in this process instead of bridging to the
  // project's serve process. Takes the project lock, so nothing else can share it.
  standalone: boolean;
  // --print-config <client>: emit a connect config and exit without serving.
  printConfig: string | null;
  // --help/-h: print usage and exit.
  help: boolean;
  // --tools git,docs: the toolsets to list besides core (core/tools/toolsets.ts).
  // Null: the project's opentide.json decides.
  tools: string | null;
}

export function getMcpTransportArgs(
  defaultPort: number,
  argv: string[] = Deno.args,
): McpTransportArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      project: { type: "string", short: "p" },
      http: { type: "boolean" },
      standalone: { type: "boolean" },
      port: { type: "string" },
      "print-config": { type: "string" },
      help: { type: "boolean", short: "h" },
      tools: { type: "string" },
    },
    allowPositionals: true,
  });
  const parsedPort = values.port ? Number(values.port) : defaultPort;
  const port = Number.isFinite(parsedPort) ? parsedPort : defaultPort;
  return {
    projectPath: values.project ?? null,
    http: Boolean(values.http),
    standalone: Boolean(values.standalone),
    port,
    printConfig: values["print-config"] ?? null,
    help: Boolean(values.help),
    tools: values.tools ?? null,
  };
}

// The project a command serves: `--project` when given, else the directory it
// was run from. Either way it must hold a project manifest; this never creates
// one. A client
// that spawns the server in the project (Claude Code, Codex, a plugin's fixed
// .mcp.json) then needs no path in its config.
export function resolveProjectPath(
  projectPath: string | null,
  cwd: string,
  isProject: (dir: string) => boolean = hasProjectManifest,
): Result<string> {
  const dir = resolve(projectPath ?? cwd);
  if (isProject(dir)) return { ok: true, data: dir };
  return {
    ok: false,
    error: {
      code: "NO_PROJECT",
      message: `${dir} is not an OpenTide project (no opentide.json).`,
      suggestion: "Run it from a project directory, pass --project <path>, " +
        "or create one with `opentide scaffold <dir> <name>`.",
    },
  };
}

// The directory the user ran the command from. `deno task` runs from the
// config's directory and records the caller's in INIT_CWD. The installed
// launcher runs `deno run` from where it was called, so its cwd is already
// right, and an INIT_CWD it sees was inherited from some unrelated npm or deno
// task further up.
export function invocationCwd(
  env: (name: string) => string | undefined = (name) => Deno.env.get(name),
  cwd: string = Deno.cwd(),
): string {
  if (env(LAUNCHER_ENV) !== undefined) return cwd;
  return env("INIT_CWD") ?? cwd;
}

// The `opentide lsp` composition root's args. Stage 0 is stdio-only
// (docs/lsp-support-plan.md §11.5), so --project is the only real flag; --http/
// --port slot in here as a later slice, mirroring getMcpTransportArgs. Pure argv
// parser (no core-config dependency), unit-testable without a kernel.
export interface LspArgs {
  projectPath: string | null;
  help: boolean;
}

export function getLspArgs(argv: string[] = Deno.args): LspArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      project: { type: "string", short: "p" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: true,
  });
  return {
    projectPath: values.project ?? null,
    help: Boolean(values.help),
  };
}
