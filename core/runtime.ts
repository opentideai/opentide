import type {
  CompileDeps,
  DevToolArgDef,
  DevToolFn,
  DevViewFn,
  HandlerFn,
  KernelInspectAPI,
  Result,
  TestFn,
} from "./types.ts";
import type {
  CompletionItem,
  DefinitionResult,
  DiagnosticEntry,
  HighlightRange,
  HoverResult,
  ReferenceResult,
  RenameLocation,
} from "./language-service.ts";
import type { ExportProjectOptions, ExportProjectResult } from "./export.ts";
import type { PackageEntry, SerializedPackageEntry } from "./packages.ts";
import type {
  BinaryCompileTarget,
  BuildOptions,
  BuildResult,
} from "./build.ts";
import type { EntitySource, UnusedPackageInfo } from "./qc.ts";
import type { Kernel, KernelLog } from "./registries.ts";
import { errorMessage } from "./util.ts";

export const DEFAULT_RUNTIME_ID = "typescript";

export type RuntimeLanguageId =
  | "typescript"
  | "javascript"
  // See shared/audits.ts AuditCategory: keeps the two literals in autocomplete
  // while still accepting any string.
  | (string & Record<never, never>);
export type RuntimeExecutionMode = "in-process" | "bridge" | "proxy";
export type SharedGatewayExecutionMode = Exclude<RuntimeExecutionMode, "proxy">;
export type RuntimeSourceKind =
  | "handler"
  | "function"
  | "test"
  | "dev_view"
  | "dev_tool"
  | "script";

export interface RuntimeCapabilities {
  executionMode: RuntimeExecutionMode;
  handlers: boolean;
  functions: boolean;
  tests: boolean;
  scripts: boolean;
  devViews: boolean;
  devTools: boolean;
  packages: boolean;
  languageIntelligence: boolean;
  exportTargets: readonly string[];
  buildTargets: readonly string[];
}

/**
 * What a runtime's handlers are handed and what they must hand back. Named by
 * shape, not by library: the kernel's own router happens to be Hono, but that is
 * a hosting detail a handler never sees. `"web-request"` means the first argument
 * is a standard `Request` (the second is the kernel's `HandlerContext`), and
 * `"web-response"` means the return value is a standard `Response`.
 */
export interface SharedGatewayRuntimeContract {
  executionMode: SharedGatewayExecutionMode;
  request: "web-request";
  response: "web-response";
}

export interface RuntimeMetadata {
  id: string;
  label: string;
  defaultLanguage: RuntimeLanguageId;
  supportedLanguages: readonly RuntimeLanguageId[];
  capabilities: RuntimeCapabilities;
}

export interface RuntimeScriptSuccess {
  ok: true;
  output: unknown;
  logs: string[];
  durationMs: number;
}

export interface RuntimeScriptFailure {
  ok: false;
  error: { code: string; message: string; suggestion?: string };
  logs: string[];
}

export type RuntimeScriptResult = RuntimeScriptSuccess | RuntimeScriptFailure;

export interface RuntimeAdapter extends RuntimeMetadata {
  initialize?: () => Promise<void> | void;
  dispose?: () => Promise<void> | void;

  compileHandler?: (
    name: string,
    source: string,
    deps: CompileDeps,
  ) => Promise<Result<HandlerFn>>;
  compileFunction?: (
    name: string,
    source: string,
    deps: CompileDeps,
  ) => Promise<Result<(...args: unknown[]) => unknown>>;
  compileTest?: (
    name: string,
    source: string,
    deps: CompileDeps,
  ) => Promise<Result<TestFn>>;
  compileDevView?: (
    name: string,
    source: string,
    deps: CompileDeps,
    kernelInspect: KernelInspectAPI,
  ) => Promise<Result<DevViewFn>>;
  compileDevTool?: (
    name: string,
    source: string,
    args: DevToolArgDef[],
    deps: CompileDeps,
  ) => Promise<Result<DevToolFn>>;
  runScript?: (
    source: string,
    deps: CompileDeps,
    timeoutMs?: number,
    kernelLog?: KernelLog,
  ) => Promise<RuntimeScriptResult>;

  installPackage?: (
    kernel: Kernel,
    name: string,
    version?: string,
  ) => Promise<PackageEntry>;
  removePackage?: (kernel: Kernel, name: string) => boolean;
  getPackageEntry?: (kernel: Kernel, name: string) => PackageEntry | undefined;
  listPackages?: (kernel: Kernel) => SerializedPackageEntry[];
  restorePackages?: (
    kernel: Kernel,
    entries: SerializedPackageEntry[],
  ) => Promise<string[]>;
  packageProxy?: (kernel: Kernel) => Record<string, unknown>;
  findUnusedPackages?: (
    kernel: Kernel,
  ) => Promise<{ used: UnusedPackageInfo[]; unused: UnusedPackageInfo[] }>;

  exportRuntimeNotes?: (
    kernel: Kernel,
    opts?: Pick<ExportProjectOptions, "includeSeedData">,
  ) => string[];
  exportProject?: (
    kernel: Kernel,
    opts?: ExportProjectOptions,
  ) => Promise<ExportProjectResult>;
  buildDenoProject?: (
    kernel: Kernel,
    projectDir: string,
    version: string,
    opts?: BuildOptions,
  ) => Promise<BuildResult>;
  buildDocker?: (
    kernel: Kernel,
    projectDir: string,
    version: string,
    includeCompose: boolean,
    opts?: BuildOptions,
  ) => Promise<BuildResult>;
  buildZip?: (
    kernel: Kernel,
    projectName: string,
    version: string,
    opts?: BuildOptions,
    projectDir?: string | null,
  ) => Promise<Uint8Array>;
  buildNodeProject?: (
    kernel: Kernel,
    projectDir: string,
    projectName: string,
    version: string,
    opts?: BuildOptions,
  ) => Promise<BuildResult>;
  buildNodeZip?: (
    kernel: Kernel,
    projectDir: string,
    projectName: string,
    version: string,
    opts?: BuildOptions,
  ) => Promise<Uint8Array>;
  buildBinary?: (
    kernel: Kernel,
    projectDir: string,
    projectName: string,
    version: string,
    opts?: BuildOptions,
    compileTarget?: BinaryCompileTarget,
    waitForCompletion?: boolean,
  ) => Promise<string>;

  getCompletions?: (
    entityType: string,
    entityName: string,
    line: number,
    column: number,
    kernel: Kernel,
    content?: string,
  ) => Promise<CompletionItem[]>;
  getDiagnostics?: (
    entityType: string,
    entityName: string,
    kernel: Kernel,
    content?: string,
  ) => Promise<DiagnosticEntry[]>;
  getHoverInfo?: (
    entityType: string,
    entityName: string,
    line: number,
    column: number,
    kernel: Kernel,
    content?: string,
  ) => Promise<HoverResult | null>;
  getDefinition?: (
    entityType: string,
    entityName: string,
    line: number,
    column: number,
    kernel: Kernel,
    content?: string,
  ) => Promise<DefinitionResult[]>;
  getReferences?: (
    entityType: string,
    entityName: string,
    line: number,
    column: number,
    kernel: Kernel,
    content?: string,
  ) => Promise<ReferenceResult[]>;
  getDocumentHighlights?: (
    entityType: string,
    entityName: string,
    line: number,
    column: number,
    kernel: Kernel,
    content?: string,
  ) => Promise<HighlightRange[]>;
  getRenameLocations?: (
    entityType: string,
    entityName: string,
    line: number,
    column: number,
    kernel: Kernel,
    content?: string,
  ) => Promise<RenameLocation[]>;
}

export function runtimeMetadata(adapter: RuntimeAdapter): RuntimeMetadata {
  return {
    id: adapter.id,
    label: adapter.label,
    defaultLanguage: adapter.defaultLanguage,
    supportedLanguages: adapter.supportedLanguages,
    capabilities: adapter.capabilities,
  };
}

export function sharedGatewayContract(
  adapter: RuntimeAdapter,
): SharedGatewayRuntimeContract | null {
  const mode = adapter.capabilities.executionMode;
  if (mode === "proxy") return null;
  return {
    executionMode: mode,
    request: "web-request",
    response: "web-response",
  };
}

export class RuntimeRegistry {
  private readonly adapters = new Map<string, RuntimeAdapter>();

  register(adapter: RuntimeAdapter): void {
    this.adapters.set(adapter.id, adapter);
  }

  get(id: string): RuntimeAdapter | undefined {
    return this.adapters.get(id);
  }

  resolve(id: string | null | undefined): RuntimeAdapter {
    return this.get(id ?? DEFAULT_RUNTIME_ID) ?? this.get(DEFAULT_RUNTIME_ID)!;
  }

  list(): RuntimeMetadata[] {
    return [...this.adapters.values()].map(runtimeMetadata);
  }
}

// Record the project's installed packages in its own lockfile. Best-effort by
// design (see core/app-lock.ts): the packages are already live in memory, so a
// sync failure is a missing provenance record, not a broken install — it is
// logged and swallowed rather than surfaced as an error the agent must handle.
//
// Silent when there is no project directory (launcher mode, in-memory tests):
// there is nowhere to write a lock and nothing has gone wrong.
async function syncPackageLock(
  kernel: Kernel,
  timeoutMs?: number,
): Promise<void> {
  const projectDir = kernel.projectDir;
  if (!projectDir) return;
  const specifiers = kernel.packages.list().map((pkg) => pkg.specifier);
  if (specifiers.length === 0) return;
  try {
    const { syncProjectLock, LOCK_SYNC_TIMEOUT_MS } = await import(
      "./app-lock.ts"
    );
    const result = await syncProjectLock(
      projectDir,
      specifiers,
      timeoutMs ?? LOCK_SYNC_TIMEOUT_MS,
    );
    if (!result.ok) {
      kernel.log.log(
        "warn",
        "system",
        `App dependency lock not updated: ${result.error.code} — ${result.error.message}`,
      );
    } else if (!result.data.upToDate) {
      kernel.log.log(
        "info",
        "system",
        `App dependency lock updated (${result.data.added.length} specifier(s)).`,
      );
    }
  } catch (err) {
    kernel.log.log(
      "warn",
      "system",
      `App dependency lock sync failed: ${errorMessage(err)}`,
    );
  }
}

export function createTypeScriptRuntimeAdapter(): RuntimeAdapter {
  return {
    id: DEFAULT_RUNTIME_ID,
    label: "TypeScript / JavaScript",
    defaultLanguage: "typescript",
    supportedLanguages: ["typescript", "javascript"],
    capabilities: {
      executionMode: "in-process",
      handlers: true,
      functions: true,
      tests: true,
      scripts: true,
      devViews: true,
      devTools: true,
      packages: true,
      languageIntelligence: true,
      exportTargets: ["deno", "zip"],
      buildTargets: ["deno", "node", "node-zip", "docker", "binary"],
    },
    async compileHandler(name, source, deps) {
      const { compileHandler } = await import("./compiler.ts");
      return await compileHandler(name, source, deps);
    },
    async compileFunction(name, source, deps) {
      const { compileFunction } = await import("./compiler.ts");
      return await compileFunction(name, source, deps);
    },
    async compileTest(name, source, deps) {
      const { compileTest } = await import("./compiler.ts");
      return await compileTest(name, source, deps);
    },
    async compileDevView(name, source, deps, kernelInspect) {
      const { compileDevView } = await import("./compiler.ts");
      return await compileDevView(name, source, deps, kernelInspect);
    },
    async compileDevTool(name, source, args, deps) {
      const { compileDevTool } = await import("./compiler.ts");
      return await compileDevTool(name, source, args, deps);
    },
    async runScript(source, deps, timeoutMs, kernelLog) {
      const { runScript } = await import("./compiler.ts");
      return await runScript(source, deps, timeoutMs, kernelLog);
    },
    async installPackage(kernel, name, version) {
      const entry = await kernel.packages.install(name, version);
      // Record the resolution in the APP's lock, not the kernel's. The dynamic
      // import above cannot do this — a Deno process has one lockfile for its
      // lifetime — so it takes a subprocess, and it is best-effort: the package
      // is already live in `packages.<name>` and a missing lock record must never
      // undo a working install. See core/app-lock.ts.
      await syncPackageLock(kernel);
      return entry;
    },
    removePackage(kernel, name) {
      return kernel.packages.remove(name);
    },
    getPackageEntry(kernel, name) {
      return kernel.packages.getEntry(name);
    },
    listPackages(kernel) {
      return kernel.packages.list();
    },
    async restorePackages(kernel, entries) {
      const errors = await kernel.packages.restore(entries);
      // Projects whose packages were installed before the lock was recorded get
      // it here, on the next load. syncProjectLock no-ops without spawning
      // anything when every specifier is already pinned, so the common path costs
      // one file read — and the load path gets the shorter cap, because a user is
      // waiting behind it and every package was just imported anyway.
      const { LOCK_SYNC_LOAD_TIMEOUT_MS } = await import("./app-lock.ts");
      await syncPackageLock(kernel, LOCK_SYNC_LOAD_TIMEOUT_MS);
      return errors;
    },
    packageProxy(kernel) {
      return kernel.packages.proxy();
    },
    async findUnusedPackages(kernel) {
      const { findUnusedPackages } = await import("./qc.ts");
      const packages = kernel.packages.list();
      const entities: EntitySource[] = [];
      for (const h of kernel.handlers.list()) {
        entities.push({ name: h.name, source: h.source, kind: "handler" });
      }
      for (const f of kernel.functions.list()) {
        entities.push({ name: f.name, source: f.source, kind: "function" });
      }
      for (const t of kernel.tests.list()) {
        entities.push({ name: t.name, source: t.source, kind: "function" });
      }
      const result = findUnusedPackages(
        packages.map((p) => p.name),
        entities,
      );
      for (const group of [result.used, result.unused]) {
        for (const item of group) {
          const pkg = packages.find((p) => p.name === item.name);
          if (pkg) {
            item.specifier = pkg.specifier;
            item.installedAt = pkg.installedAt;
          }
        }
      }
      return result;
    },
    exportRuntimeNotes(_kernel, opts) {
      return [
        "App configs are embedded into `deps.ts` at export time and read with `config.get(name)`.",
        "Environment variables and secrets are read from process environment first, then `.env` if present.",
        opts?.includeSeedData
          ? "`seed.sql` is included and applies captured local rows only when initializing a fresh database."
          : "Exports are schema-only by default; database rows are included only when seed export is enabled.",
      ];
    },
    async exportProject(kernel, opts) {
      const { exportProject } = await import("./export.ts");
      return await exportProject(kernel, opts);
    },
    async buildDenoProject(kernel, projectDir, version, opts) {
      const { buildDenoProject } = await import("./build.ts");
      return await buildDenoProject(kernel, projectDir, version, opts);
    },
    async buildDocker(kernel, projectDir, version, includeCompose, opts) {
      const { buildDocker } = await import("./build.ts");
      return await buildDocker(
        kernel,
        projectDir,
        version,
        includeCompose,
        opts,
      );
    },
    async buildZip(kernel, projectName, version, opts, projectDir) {
      const { buildZip } = await import("./build.ts");
      return await buildZip(kernel, projectName, version, opts, projectDir);
    },
    async buildNodeProject(kernel, projectDir, projectName, version, opts) {
      const { buildNodeProject } = await import("./build.ts");
      return await buildNodeProject(
        kernel,
        projectDir,
        projectName,
        version,
        opts,
      );
    },
    async buildNodeZip(kernel, projectDir, projectName, version, opts) {
      const { buildNodeZip } = await import("./build.ts");
      return await buildNodeZip(kernel, projectDir, projectName, version, opts);
    },
    async buildBinary(
      kernel,
      projectDir,
      projectName,
      version,
      opts,
      target,
      waitForCompletion,
    ) {
      const { buildBinary } = await import("./build.ts");
      return await buildBinary(
        kernel,
        projectDir,
        projectName,
        version,
        opts,
        target,
        waitForCompletion,
      );
    },
    async getCompletions(
      entityType,
      entityName,
      line,
      column,
      kernel,
      content,
    ) {
      const { getSharedLanguageService } = await import(
        "./language-service.ts"
      );
      return getSharedLanguageService().getCompletions(
        entityType,
        entityName,
        line,
        column,
        kernel,
        content,
      );
    },
    async getDiagnostics(entityType, entityName, kernel, content) {
      const { getSharedLanguageService } = await import(
        "./language-service.ts"
      );
      return getSharedLanguageService().getDiagnostics(
        entityType,
        entityName,
        kernel,
        content,
      );
    },
    async getHoverInfo(entityType, entityName, line, column, kernel, content) {
      const { getSharedLanguageService } = await import(
        "./language-service.ts"
      );
      return getSharedLanguageService().getHoverInfo(
        entityType,
        entityName,
        line,
        column,
        kernel,
        content,
      );
    },
    async getDefinition(entityType, entityName, line, column, kernel, content) {
      const { getSharedLanguageService } = await import(
        "./language-service.ts"
      );
      return getSharedLanguageService().getDefinition(
        entityType,
        entityName,
        line,
        column,
        kernel,
        content,
      );
    },
    async getReferences(entityType, entityName, line, column, kernel, content) {
      const { getSharedLanguageService } = await import(
        "./language-service.ts"
      );
      return getSharedLanguageService().getReferences(
        entityType,
        entityName,
        line,
        column,
        kernel,
        content,
      );
    },
    async getDocumentHighlights(
      entityType,
      entityName,
      line,
      column,
      kernel,
      content,
    ) {
      const { getSharedLanguageService } = await import(
        "./language-service.ts"
      );
      return getSharedLanguageService().getDocumentHighlights(
        entityType,
        entityName,
        line,
        column,
        kernel,
        content,
      );
    },
    async getRenameLocations(
      entityType,
      entityName,
      line,
      column,
      kernel,
      content,
    ) {
      const { getSharedLanguageService } = await import(
        "./language-service.ts"
      );
      return getSharedLanguageService().getRenameLocations(
        entityType,
        entityName,
        line,
        column,
        kernel,
        content,
      );
    },
  };
}

export function createDefaultRuntimeRegistry(): RuntimeRegistry {
  const registry = new RuntimeRegistry();
  registry.register(createTypeScriptRuntimeAdapter());
  return registry;
}

const defaultRuntimeRegistry = createDefaultRuntimeRegistry();

export function getDefaultRuntimeRegistry(): RuntimeRegistry {
  return defaultRuntimeRegistry;
}
