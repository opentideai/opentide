import {
  type CodebaseGraph,
  createEmptyCodebaseGraph,
  mergeCodebaseContributions,
  type ProjectCommand,
  type SemanticContribution,
  type SemanticDiagnostic,
  type SemanticFact,
  semanticId,
  type SourceLanguage,
} from "./types.ts";
import type { PackageManager, TsJsProjectDiscovery } from "./discovery.ts";
import {
  sourceIndexContribution,
  type TsJsSourceIndex,
} from "./source-index.ts";
import { createHonoPlugin } from "./hono-plugin.ts";

export const GENERIC_TSJS_PLUGIN_ID = "generic-tsjs";

export interface SemanticsPluginCapabilities {
  detect: boolean;
  index: boolean;
  mutate: boolean;
  commands: boolean;
  generatedTypes: boolean;
  auditGuidance: boolean;
  preview: boolean;
}

export interface SemanticsPluginManifest {
  id: string;
  label: string;
  version: string;
  languages: readonly SourceLanguage[];
  detects: readonly string[];
  capabilities: SemanticsPluginCapabilities;
}

export interface DetectionContext {
  projectId: string;
  rootPath: string;
  discovery?: TsJsProjectDiscovery;
  sourceIndex?: TsJsSourceIndex;
}

export interface DetectionEvidence {
  kind: "file" | "dependency" | "config" | "source-pattern" | "user";
  description: string;
  file?: string;
}

export interface DetectionResult {
  matched: boolean;
  confidence: number;
  evidence: DetectionEvidence[];
  suggestedPriority?: number;
}

export interface IndexContext extends DetectionContext {
  detection: DetectionResult;
}

export interface SemanticsPlugin {
  manifest: SemanticsPluginManifest;
  detect(ctx: DetectionContext): Promise<DetectionResult> | DetectionResult;
  index(
    ctx: IndexContext,
  ): Promise<SemanticContribution> | SemanticContribution;
}

export interface IndexCodebaseOptions {
  enabledPluginIds?: readonly string[];
  disabledPluginIds?: readonly string[];
  indexedAt?: string;
}

interface SelectedPlugin {
  plugin: SemanticsPlugin;
  detection: DetectionResult;
}

export class SemanticsPluginRegistry {
  private readonly plugins = new Map<string, SemanticsPlugin>();

  register(plugin: SemanticsPlugin): void {
    if (this.plugins.has(plugin.manifest.id)) {
      throw new Error(
        `Semantics plugin "${plugin.manifest.id}" is already registered`,
      );
    }
    this.plugins.set(plugin.manifest.id, plugin);
  }

  replace(plugin: SemanticsPlugin): void {
    this.plugins.set(plugin.manifest.id, plugin);
  }

  get(id: string): SemanticsPlugin | undefined {
    return this.plugins.get(id);
  }

  list(): SemanticsPluginManifest[] {
    return [...this.plugins.values()]
      .map((plugin) => plugin.manifest)
      .toSorted((a, b) => a.id.localeCompare(b.id));
  }

  resolveEnabled(options: IndexCodebaseOptions = {}): SemanticsPlugin[] {
    const enabled = options.enabledPluginIds
      ? new Set(options.enabledPluginIds)
      : null;
    const disabled = new Set(options.disabledPluginIds ?? []);
    return [...this.plugins.values()]
      .filter((plugin) => !enabled || enabled.has(plugin.manifest.id))
      .filter((plugin) => !disabled.has(plugin.manifest.id))
      .toSorted((a, b) => a.manifest.id.localeCompare(b.manifest.id));
  }
}

export function createDefaultSemanticsPluginRegistry(): SemanticsPluginRegistry {
  const registry = new SemanticsPluginRegistry();
  registry.register(createGenericTsJsPlugin());
  registry.register(createHonoPlugin());
  return registry;
}

export async function indexCodebaseWithPlugins(
  registry: SemanticsPluginRegistry,
  ctx: DetectionContext,
  options: IndexCodebaseOptions = {},
): Promise<CodebaseGraph> {
  const base = createEmptyCodebaseGraph(
    ctx.projectId,
    ctx.rootPath,
    options.indexedAt,
  );
  const contributions: SemanticContribution[] = [];
  const selected: SelectedPlugin[] = [];

  for (const id of unknownEnabledPluginIds(registry, options)) {
    contributions.push(unknownEnabledPluginContribution(id));
  }

  for (const plugin of registry.resolveEnabled(options)) {
    let detection: DetectionResult;
    try {
      detection = await plugin.detect(ctx);
    } catch (err) {
      contributions.push(errorContribution(plugin.manifest, "detect", err));
      continue;
    }

    if (!detection.matched) {
      contributions.push({
        pluginId: plugin.manifest.id,
        plugins: [{
          pluginId: plugin.manifest.id,
          label: plugin.manifest.label,
          version: plugin.manifest.version,
          status: "skipped",
          confidence: detection.confidence,
        }],
      });
      continue;
    }

    selected.push({ plugin, detection });
  }

  selected.sort((a, b) =>
    (b.detection.suggestedPriority ?? 0) -
      (a.detection.suggestedPriority ?? 0) ||
    b.detection.confidence - a.detection.confidence ||
    a.plugin.manifest.id.localeCompare(b.plugin.manifest.id)
  );

  for (const { plugin, detection } of selected) {
    try {
      const contribution = await plugin.index({ ...ctx, detection });
      contributions.push({
        ...contribution,
        pluginId: contribution.pluginId || plugin.manifest.id,
        plugins: contribution.plugins ?? [{
          pluginId: plugin.manifest.id,
          label: plugin.manifest.label,
          version: plugin.manifest.version,
          status: "completed",
          confidence: detection.confidence,
        }],
      });
    } catch (err) {
      contributions.push(errorContribution(plugin.manifest, "index", err));
    }
  }

  return mergeCodebaseContributions(base, contributions);
}

export function createGenericTsJsPlugin(): SemanticsPlugin {
  return {
    manifest: {
      id: GENERIC_TSJS_PLUGIN_ID,
      label: "Generic TS/JS",
      version: "0.1.0",
      languages: ["typescript", "javascript", "tsx", "jsx"],
      detects: ["typescript", "javascript", "unknown-tsjs"],
      capabilities: {
        detect: true,
        index: true,
        mutate: false,
        commands: false,
        generatedTypes: false,
        auditGuidance: false,
        preview: false,
      },
    },
    detect() {
      return {
        matched: true,
        confidence: 1,
        suggestedPriority: -1000,
        evidence: [{
          kind: "user",
          description: "Generic TS/JS semantics plugin is always available.",
        }],
      };
    },
    index(ctx) {
      const discovery = ctx.discovery;
      const sourceContribution: SemanticContribution = ctx.sourceIndex
        ? sourceIndexContribution(GENERIC_TSJS_PLUGIN_ID, ctx.sourceIndex)
        : { pluginId: GENERIC_TSJS_PLUGIN_ID };
      return {
        ...sourceContribution,
        pluginId: GENERIC_TSJS_PLUGIN_ID,
        commands: [
          ...(sourceContribution.commands ?? []),
          ...(discovery ? commandsFromDiscovery(discovery) : []),
        ],
        facts: [
          ...(sourceContribution.facts ?? []),
          ...(discovery ? factsFromDiscovery(discovery) : []),
        ],
      };
    },
  };
}

function commandsFromDiscovery(
  discovery: TsJsProjectDiscovery,
): ProjectCommand[] {
  const scripts = discovery.packageJson?.scripts ?? {};
  const commands: ProjectCommand[] = installCommandFromDiscovery(discovery);
  for (const [name] of Object.entries(scripts)) {
    const commandKind = commandKindFromScriptName(name);
    if (!commandKind) continue;
    commands.push({
      id: semanticId("command", `${commandKind}:${name}`),
      kind: "command",
      name,
      commandKind,
      command: packageManagerRunCommand(discovery.packageManager, name),
      cwd: discovery.rootPath,
      packageManager: discovery.packageManager,
      source: {
        pluginId: GENERIC_TSJS_PLUGIN_ID,
        ruleId: "package-script",
        method: "manifest",
        inferred: false,
      },
      confidence: 0.95,
      locations: [{
        file: "package.json",
        startLine: 1,
        startColumn: 1,
      }],
    });
  }
  return commands.toSorted((a, b) =>
    a.commandKind.localeCompare(b.commandKind) || a.name.localeCompare(b.name)
  );
}

function installCommandFromDiscovery(
  discovery: TsJsProjectDiscovery,
): ProjectCommand[] {
  const command = installCommand(
    discovery.packageManager,
    discovery.configFiles,
  );
  if (!command) return [];
  return [{
    id: semanticId("command", "install"),
    kind: "command",
    name: "install",
    commandKind: "install",
    command,
    cwd: discovery.rootPath,
    packageManager: discovery.packageManager,
    source: {
      pluginId: GENERIC_TSJS_PLUGIN_ID,
      ruleId: "package-manager-install",
      method: "manifest",
      inferred: discovery.packageManager === "unknown",
    },
    confidence: discovery.packageManager === "unknown" ? 0.25 : 0.9,
    locations: discovery.lockfiles.length > 0
      ? discovery.lockfiles.map((file) => ({
        file,
        startLine: 1,
        startColumn: 1,
      }))
      : [{ file: "package.json", startLine: 1, startColumn: 1 }],
  }];
}

function factsFromDiscovery(discovery: TsJsProjectDiscovery): SemanticFact[] {
  const facts: SemanticFact[] = [];
  facts.push({
    id: semanticId("fact", `package-manager:${discovery.packageManager}`),
    kind: "fact",
    name: `Package manager: ${discovery.packageManager}`,
    factKind: "config",
    value: {
      packageManager: discovery.packageManager,
      lockfiles: discovery.lockfiles,
    },
    source: {
      pluginId: GENERIC_TSJS_PLUGIN_ID,
      ruleId: "package-manager",
      method: "manifest",
      inferred: discovery.packageManager === "unknown",
    },
    confidence: discovery.packageManager === "unknown" ? 0.2 : 0.95,
    locations: discovery.lockfiles.length > 0
      ? discovery.lockfiles.map((file) => ({
        file,
        startLine: 1,
        startColumn: 1,
      }))
      : [],
  });

  for (
    const [name, version] of Object.entries(
      discovery.packageJson?.dependencies ?? {},
    )
  ) {
    facts.push(dependencyFact(name, version, false));
  }
  for (
    const [name, version] of Object.entries(
      discovery.packageJson?.devDependencies ?? {},
    )
  ) {
    facts.push(dependencyFact(name, version, true));
  }
  for (const config of discovery.configFiles) {
    facts.push({
      id: semanticId("fact", `config:${config.kind}:${config.path}`),
      kind: "fact",
      name: `${config.kind}: ${config.path}`,
      factKind: "config",
      value: config,
      source: {
        pluginId: GENERIC_TSJS_PLUGIN_ID,
        ruleId: "config-file",
        method: "config",
        inferred: false,
      },
      confidence: 1,
      locations: [{ file: config.path, startLine: 1, startColumn: 1 }],
    });
  }
  for (const hint of discovery.frameworkHints) {
    facts.push({
      id: semanticId(
        "fact",
        `framework:${hint.id}:${hint.source}:${hint.evidence}`,
      ),
      kind: "fact",
      name: `Framework hint: ${hint.id}`,
      factKind: "framework",
      value: hint,
      source: {
        pluginId: GENERIC_TSJS_PLUGIN_ID,
        ruleId: "framework-hint",
        method: hint.source === "dependency" ? "manifest" : "config",
        inferred: true,
      },
      confidence: hint.confidence,
      locations: [{
        file: hint.source === "dependency" ? "package.json" : hint.evidence,
        startLine: 1,
        startColumn: 1,
      }],
    });
  }
  for (const root of discovery.sourceRoots) {
    facts.push({
      id: semanticId("fact", `source-root:${root}`),
      kind: "fact",
      name: `Source root: ${root}`,
      factKind: "entrypoint",
      value: { path: root },
      source: {
        pluginId: GENERIC_TSJS_PLUGIN_ID,
        ruleId: "source-root",
        method: "config",
        inferred: true,
      },
      confidence: 0.75,
      locations: [{ file: root, startLine: 1, startColumn: 1 }],
    });
  }

  return facts.toSorted((a, b) => a.id.localeCompare(b.id));
}

function dependencyFact(
  name: string,
  version: string,
  dev: boolean,
): SemanticFact {
  return {
    id: semanticId("fact", `dependency:${dev ? "dev" : "prod"}:${name}`),
    kind: "fact",
    name,
    factKind: "dependency",
    value: { name, version, dev },
    source: {
      pluginId: GENERIC_TSJS_PLUGIN_ID,
      ruleId: "package-dependency",
      method: "manifest",
      inferred: false,
    },
    confidence: 1,
    locations: [{ file: "package.json", startLine: 1, startColumn: 1 }],
  };
}

function commandKindFromScriptName(
  name: string,
): ProjectCommand["commandKind"] | null {
  const normalized = name.toLowerCase();
  if (normalized === "dev" || normalized === "start") return "dev";
  if (normalized === "test" || normalized.startsWith("test:")) return "test";
  if (normalized === "typecheck" || normalized === "check") return "typecheck";
  if (normalized === "lint" || normalized.startsWith("lint:")) return "lint";
  if (normalized === "build" || normalized.startsWith("build:")) return "build";
  if (normalized === "format" || normalized.startsWith("format:")) {
    return "format";
  }
  return null;
}

function packageManagerRunCommand(
  packageManager: PackageManager,
  scriptName: string,
): string {
  switch (packageManager) {
    case "pnpm":
      return `pnpm run ${scriptName}`;
    case "yarn":
      return `yarn ${scriptName}`;
    case "bun":
      return `bun run ${scriptName}`;
    case "deno":
      return `deno task ${scriptName}`;
    case "npm":
    case "unknown":
      return `npm run ${scriptName}`;
  }
}

function installCommand(
  packageManager: PackageManager,
  configFiles: TsJsProjectDiscovery["configFiles"],
): string | null {
  switch (packageManager) {
    case "pnpm":
      return "pnpm install";
    case "yarn":
      return "yarn install";
    case "bun":
      return "bun install";
    case "npm":
    case "unknown":
      return "npm install";
    case "deno":
      return configFiles.some((config) => config.kind === "deno")
        ? "deno cache"
        : null;
  }
}

function errorContribution(
  manifest: SemanticsPluginManifest,
  phase: "detect" | "index",
  err: unknown,
): SemanticContribution {
  const diagnostic: SemanticDiagnostic = {
    id: semanticId("diagnostic", `${manifest.id}:${phase}:error`),
    severity: "error",
    message: `Semantics plugin "${manifest.id}" failed during ${phase}: ${
      errorMessage(err)
    }`,
    source: {
      pluginId: manifest.id,
      method: "manifest",
      inferred: false,
    },
  };

  return {
    pluginId: manifest.id,
    diagnostics: [diagnostic],
    plugins: [{
      pluginId: manifest.id,
      label: manifest.label,
      version: manifest.version,
      status: "error",
      diagnostics: [diagnostic],
    }],
  };
}

function unknownEnabledPluginIds(
  registry: SemanticsPluginRegistry,
  options: IndexCodebaseOptions,
): string[] {
  if (!options.enabledPluginIds) return [];
  const knownIds = new Set(registry.list().map((manifest) => manifest.id));
  return [...options.enabledPluginIds]
    .filter((id) => !knownIds.has(id))
    .toSorted();
}

function unknownEnabledPluginContribution(id: string): SemanticContribution {
  const diagnostic: SemanticDiagnostic = {
    id: semanticId("diagnostic", `${id}:enabled-plugin-missing`),
    severity: "warning",
    message: `Enabled semantics plugin "${id}" is not registered.`,
    source: {
      pluginId: id,
      method: "manifest",
      inferred: false,
    },
  };

  return {
    pluginId: id,
    diagnostics: [diagnostic],
    plugins: [{
      pluginId: id,
      status: "error",
      diagnostics: [diagnostic],
    }],
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
