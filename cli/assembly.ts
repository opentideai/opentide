// @layer composition — the OPEN layer assembly for the composition roots: core +
// verification. It never imports agent/ or tide/ — the closed Tide stack
// (model-backed audits) is assembled in tide/assembly.ts on top of the pieces
// exported here, and handed to the same roots as a StackAssembly. The chat
// agent runs as its own process (cli/agent-main.ts).
import { RoutingModelProvider } from "../providers/model-provider-router.ts";
import { routingUtilityModelCall } from "../providers/utility-provider.ts";
import { installUtilityModelProvider } from "../core/utility-model.ts";
import { createRecoveryChatRuntime } from "../core/recovery-chat.ts";
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

// The argv parsers live in cli-args.ts, which loads none of the stack, so a root
// can read its arguments before deciding whether it needs the stack at all.
export {
  DEFAULT_OUTPUT_TARGET,
  getBuildArgs,
  getExportArgs,
  getLockRefreshArgs,
  getLspArgs,
  getMcpTransportArgs,
  getServeArgs,
  invocationCwd,
  isOutputTarget,
  OUTPUT_TARGETS,
  resolveProjectPath,
} from "./cli-args.ts";
export type {
  BuildArgs,
  ExportArgs,
  LockRefreshArgs,
  LspArgs,
  McpTransportArgs,
  OutputTarget,
  ServeArgs,
} from "./cli-args.ts";

// The OpenTide composition — core + verification, no agent: stores, changeset
// governance, and the ledger hook are present. Audits and the other reviews run
// on the client's model (request_review); Tide's agent is one such client.
export function verificationOnlyComposition(): CompositionContext {
  // The open/BYO-key stack runs the same utility jobs (session naming, commit
  // subjects, completions), so it installs the same routing utility provider
  // (Stage 5 + Stage 4 multi-provider routing).
  installUtilityModelProvider(routingUtilityModelCall);
  return {
    changesetStoreFactory: defaultChangesetStoreFactory,
    auditStoreFactory: defaultAuditStoreFactory,
    mcpAuditStoreFactory: defaultMcpAuditStoreFactory,
    verificationTools: defaultVerificationToolHandlers,
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
// the recovery chat and the verification/audit/production routes. The chat
// agent is its own process (cli/agent-main.ts); serve has no chat runtime.
export type StackServerOptions = Pick<
  ControlServerOptions,
  "recoveryChatFactory" | "mountRoutes" | "buildTargetExtras"
>;

export function assembleStack(): StackServerOptions {
  return {
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

// Everything a composition root needs to boot one flavour of the stack: the
// per-Kernel composition and the control server's request-time options. The
// roots take one of these (defaulting to openAssembly); Tide passes its own.
export interface StackAssembly {
  composition(): CompositionContext;
  serverOptions(): StackServerOptions;
}

export const openAssembly: StackAssembly = {
  composition: verificationOnlyComposition,
  serverOptions: assembleStack,
};
