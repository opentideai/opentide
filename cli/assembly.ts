// @layer composition — the OPEN layer assembly for the composition roots: core +
// verification + the agent loop on the generic default brain. It never imports
// agent/ or tide/ — the closed Tide stack (tuned brain, model-backed audits) is
// assembled in tide/assembly.ts on top of the pieces exported here, and handed to
// the same roots as a StackAssembly.
import { ChatOrchestrator } from "../agent-loop/chat.ts";
import { DefaultChatIntelligence } from "../agent-loop/default-brain.ts";
import { RoutingModelProvider } from "../providers/model-provider-router.ts";
import { routingUtilityModelCall } from "../providers/utility-provider.ts";
import { installUtilityModelProvider } from "../core/utility-model.ts";
import { createRecoveryChatRuntime } from "../core/recovery-chat.ts";
import type { ChatIntelligence } from "../core/chat-intelligence.ts";
import {
  defaultAuditStoreFactory,
  defaultChangesetStoreFactory,
  defaultMcpAuditStoreFactory,
} from "../verification/store-registration.ts";
import { defaultVerificationToolHandlers } from "../verification/verification-tool-handlers.ts";
import { initVerificationLedger } from "../verification/verification-ledger.ts";
import { refreshModelsOnStart } from "../core/model-refresh-hook.ts";
import { defaultSaveRiskPolicy } from "../verification/save-risk.ts";
import { mountVerificationRoutes } from "../verification/verification-routes.ts";
import { mountAuditRoutes } from "../verification/audit-routes.ts";
import { mountProductionRoutes } from "../verification/production-routes.ts";
import { mountMcpRoutes } from "../mcp/mcp-mount.ts";
import {
  runBinarySmokeGate,
  runDenoSmokeGate,
  runNodeSmokeGate,
  TARGET_DENO_SOURCE,
  TARGET_NODE,
} from "../verification/production-build.ts";
import { refreshLocks } from "../verification/production-lock-refresh.ts";
import { readCommittedLock } from "../verification/production-lock.ts";
import { readCommittedNodeLock } from "../verification/production-node-lock.ts";
import type { CompositionContext } from "../core/composition.ts";
import type {
  BuildLockTarget,
  BuildTargetExtraOptions,
  BuildTargetExtraResult,
  BuildTargetExtras,
  BuildTargetExtraTarget,
  ControlServerOptions,
} from "../core/control-server.ts";
import type { ProjectContext } from "../core/project-loader.ts";
import type { ExportProjectOptions } from "../core/export.ts";
import { APP_PORT_AUTO } from "../core/config.ts";
import { parseArgs } from "node:util";

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
  };
}

// The `opentide build` entry args. Deno-only build this slice (no --target
// matrix), so --project is the only flag — kept a pure parser (same parseArgs
// shape as getServeArgs) so the dispatcher can enforce the D2 required-project
// contract without a loaded kernel.
export interface BuildArgs {
  projectPath: string | null;
  includeSeedData: boolean;
}

export function getBuildArgs(argv: string[] = Deno.args): BuildArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      project: { type: "string", short: "p" },
      "include-seed-data": { type: "boolean" },
    },
    allowPositionals: true,
  });
  return {
    projectPath: values.project ?? null,
    includeSeedData: Boolean(values["include-seed-data"]),
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
    },
    allowPositionals: true,
  });
  return {
    projectPath: values.project ?? null,
    out: values.out ?? null,
    tarball: Boolean(values.tarball),
    includeSeedData: Boolean(values["include-seed-data"]),
    force: Boolean(values.force),
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
  };
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

// The orchestrator composition root's args (Feature B / B1c). The orchestrator
// supervises `opentide serve` children; the one flag it needs is --ui-dist DIR:
// the prebuilt IDE bundle it threads into every child (--ui-dist) so each child
// self-serves its own IDE (decision #4). Mirrors the desktop/serve --ui-dist
// spelling; defaults null (the root then falls back to the repo's ide/build, and
// finally to a dev child with no static UI). Pure argv parser (no core-config or
// kernel dependency), unit-testable like getServeArgs/getLspArgs.
export interface OrchestratorArgs {
  uiDist: string | null;
}

export function getOrchestratorArgs(
  argv: string[] = Deno.args,
): OrchestratorArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      "ui-dist": { type: "string" },
    },
    allowPositionals: true,
  });
  return { uiDist: values["ui-dist"] ?? null };
}

// The OpenTide composition — core + verification, no agent: stores, changeset
// governance, and the ledger hook are present, but the model-backed audit
// provider and the agent's refutation handlers are absent. This is the executable
// proof that model-backed audits + refutation live entirely in the agent assembly
// (OpenTide §Phase 6): executeAudit returns "not configured" and refute_claims is
// hidden from the MCP surface, while deterministic verification still works. The
// Tide composition (tide/assembly.ts) is this plus the agent seams.
export function verificationOnlyComposition(): CompositionContext {
  // The open/BYO-key stack runs the same utility jobs (session naming, commit
  // subjects, completions), so it installs the same routing utility provider
  // (Stage 5 + Stage 4 multi-provider routing).
  installUtilityModelProvider(routingUtilityModelCall);
  return {
    changesetStoreFactory: defaultChangesetStoreFactory,
    auditStoreFactory: defaultAuditStoreFactory,
    mcpAuditStoreFactory: defaultMcpAuditStoreFactory,
    auditProvider: null,
    verificationTools: defaultVerificationToolHandlers,
    agentTools: null,
    verificationDiagnostics: null,
    saveRiskPolicy: defaultSaveRiskPolicy,
    initHooks: [initVerificationLedger, refreshModelsOnStart],
  };
}

function targetSet(targets: readonly BuildLockTarget[]): Set<
  typeof TARGET_DENO_SOURCE | typeof TARGET_NODE
> {
  return new Set(
    targets.map((target) =>
      target === "node" ? TARGET_NODE : TARGET_DENO_SOURCE
    ),
  );
}

function smokeExportOptions(
  ctx: ProjectContext,
  options: BuildTargetExtraOptions,
): ExportProjectOptions {
  const exportOptions: ExportProjectOptions = {
    ...options.buildOptions,
    projectName: options.projectName,
    projectVersion: options.projectVersion,
  };
  if (options.buildOptions.includeDenoLock === true) {
    exportOptions.denoLock = readCommittedLock(ctx.entry.path);
  }
  if (options.buildOptions.includePackageLock === true) {
    exportOptions.packageLock = readCommittedNodeLock(ctx.entry.path);
  }
  return exportOptions;
}

function failedExtraResult(
  prefix: string,
  error: unknown,
): BuildTargetExtraResult {
  const message = error instanceof Error ? error.message : String(error);
  return { ok: false, detail: `${prefix}: ${message}` };
}

async function runBuildSmokeExtra(
  ctx: ProjectContext,
  target: BuildTargetExtraTarget,
  options: BuildTargetExtraOptions,
): Promise<BuildTargetExtraResult> {
  try {
    const exportOptions = smokeExportOptions(ctx, options);
    const result = target === "deno"
      ? await runDenoSmokeGate(ctx.kernel, ctx.entry.path, exportOptions)
      : target === "node"
      ? await runNodeSmokeGate(ctx.kernel, ctx.entry.path, exportOptions)
      : await runBinarySmokeGate(ctx.kernel, ctx.entry.path, exportOptions);
    if (!result.ok) {
      return {
        ok: false,
        detail: `${result.error.code}: ${result.error.message}`,
      };
    }
    return { ok: true, detail: "Smoke test passed." };
  } catch (err) {
    return failedExtraResult("Smoke test could not run", err);
  }
}

async function refreshLocksExtra(
  ctx: ProjectContext,
  targets: readonly BuildLockTarget[],
  options: BuildTargetExtraOptions,
): Promise<BuildTargetExtraResult> {
  try {
    const report = await refreshLocks(
      ctx.kernel,
      ctx.entry.path,
      {
        ...options.buildOptions,
        projectName: options.projectName,
        projectVersion: options.projectVersion,
      },
      targetSet(targets),
    );
    const selected = new Set(targets);
    const details = report.targets
      .filter((target) =>
        selected.has(target.target === TARGET_NODE ? "node" : "deno-source")
      )
      .map((target) => `${target.target}: ${target.detail}`);
    if (!report.ok) {
      return {
        ok: false,
        detail: details.length
          ? `Lock refresh failed: ${details.join("; ")}`
          : "Lock refresh failed.",
      };
    }
    return {
      ok: true,
      detail: details.length ? details.join("; ") : "Lock refresh completed.",
    };
  } catch (err) {
    return failedExtraResult("Lock refresh could not run", err);
  }
}

const buildTargetExtras: BuildTargetExtras = {
  refreshLocksBeforeBuild: refreshLocksExtra,
  runSmokeTest: runBuildSmokeExtra,
};

// The request-time options a composition root spreads into startControlServer:
// the agent loop on `brain`, the recovery chat, and the verification/audit/
// production routes. Both stacks share everything but the brain.
export type StackServerOptions = Pick<
  ControlServerOptions,
  "chatFactory" | "recoveryChatFactory" | "mountRoutes" | "buildTargetExtras"
>;

export function assembleStack(
  brain: () => ChatIntelligence,
): StackServerOptions {
  return {
    // The ChatOrchestrator takes a ModelProvider as its 5th arg (the multi-model
    // transport seam, docs/multi-model-harness-plan.md). The client-side loop drives the
    // RoutingModelProvider, which per turn dispatches to the provider backing the resolved
    // model (Anthropic or OpenAI). Each impl self-sources its key lazily and degrades to
    // MODEL_UNCONFIGURED when keyless — the loop's resolveModel check fires first, so no
    // dead id is shipped.
    chatFactory: (project, mcp) =>
      new ChatOrchestrator(
        project.kernel,
        project.rebuild,
        mcp,
        brain(),
        new RoutingModelProvider(),
      ),
    recoveryChatFactory: () =>
      createRecoveryChatRuntime(new RoutingModelProvider()),
    mountRoutes: [
      mountVerificationRoutes,
      mountAuditRoutes,
      mountProductionRoutes,
      mountMcpRoutes,
    ],
    buildTargetExtras,
  };
}

// The OPEN OpenTide stack: the agentic loop driven by the generic
// DefaultChatIntelligence. Paired with verificationOnlyComposition(), this runs
// chat end-to-end with zero agent/ code, BYO-key on whichever provider the user
// configured — model-backed audits return "not configured" while the loop, tools,
// and deterministic verification all work.
export function assembleOpenStack(): StackServerOptions {
  return assembleStack(() => new DefaultChatIntelligence());
}

// Everything a composition root needs to boot one flavour of the stack: the
// per-Kernel composition and the control server's request-time options. The
// roots take one of these (defaulting to openAssembly); Tide passes its own.
export interface StackAssembly {
  composition(): CompositionContext;
  serverOptions(): StackServerOptions;
}

export const openAssembly: StackAssembly = {
  composition: verificationOnlyComposition,
  serverOptions: assembleOpenStack,
};
