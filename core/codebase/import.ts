import {
  discoverTsJsProject,
  type PackageManager,
  type TsJsProjectDiscovery,
} from "./discovery.ts";
import {
  createDefaultSemanticsPluginRegistry,
  type IndexCodebaseOptions,
  indexCodebaseWithPlugins,
  type SemanticsPluginRegistry,
} from "./plugins.ts";
import {
  indexTsJsSource,
  type TsJsSourceIndex,
  type TsJsSourceIndexOptions,
} from "./source-index.ts";
import type { CodebaseGraph } from "./types.ts";

export interface SourceBackedCodebaseIndexOptions {
  projectId: string;
  rootPath: string;
  registry?: SemanticsPluginRegistry;
  pluginOptions?: Omit<IndexCodebaseOptions, "indexedAt">;
  sourceOptions?: TsJsSourceIndexOptions;
  indexedAt?: string;
}

export interface SourceBackedCodebaseIndexResult {
  graph: CodebaseGraph;
  discovery: TsJsProjectDiscovery;
  sourceIndex: TsJsSourceIndex;
}

export async function indexSourceBackedCodebase(
  options: SourceBackedCodebaseIndexOptions,
): Promise<SourceBackedCodebaseIndexResult> {
  const discovery = await discoverTsJsProject(options.rootPath);
  const sourceIndex = await indexTsJsSource(
    options.rootPath,
    discovery,
    options.sourceOptions,
  );
  const registry = options.registry ?? createDefaultSemanticsPluginRegistry();
  const graph = await indexCodebaseWithPlugins(
    registry,
    {
      projectId: options.projectId,
      rootPath: options.rootPath,
      discovery,
      sourceIndex,
    },
    {
      ...(options.pluginOptions ?? {}),
      indexedAt: options.indexedAt,
    },
  );

  return { graph, discovery, sourceIndex };
}

// Per-collection entity counts of an indexed graph. Every field maps 1:1 to a
// CodebaseGraph collection so callers get the full shape without walking arrays.
export interface CodebaseGraphCounts {
  files: number;
  modules: number;
  symbols: number;
  routes: number;
  handlers: number;
  middleware: number;
  functions: number;
  schemas: number;
  components: number;
  tests: number;
  commands: number;
  facts: number;
  edges: number;
  diagnostics: number;
}

// A compact, tool/API-friendly digest of a CodebaseGraph: counts plus the
// discovery basics an agent needs to reason about the project, WITHOUT the full
// (potentially large) graph payload. Returned by the index_codebase tool.
export interface CodebaseGraphSummary {
  projectId: string;
  rootPath: string;
  indexedAt: string;
  counts: CodebaseGraphCounts;
  packageManager: PackageManager;
  // Distinct detected framework ids, highest-confidence first (discovery already
  // sorts hints by confidence). Empty when no framework was detected.
  frameworks: string[];
  // Semantics plugins that ran during indexing (by id).
  plugins: string[];
}

export function summarizeCodebaseGraph(
  graph: CodebaseGraph,
  discovery: TsJsProjectDiscovery,
): CodebaseGraphSummary {
  const frameworks: string[] = [];
  for (const hint of discovery.frameworkHints) {
    if (!frameworks.includes(hint.id)) frameworks.push(hint.id);
  }
  return {
    projectId: graph.projectId,
    rootPath: graph.rootPath,
    indexedAt: graph.indexedAt,
    counts: {
      files: graph.files.length,
      modules: graph.modules.length,
      symbols: graph.symbols.length,
      routes: graph.routes.length,
      handlers: graph.handlers.length,
      middleware: graph.middleware.length,
      functions: graph.functions.length,
      schemas: graph.schemas.length,
      components: graph.components.length,
      tests: graph.tests.length,
      commands: graph.commands.length,
      facts: graph.facts.length,
      edges: graph.edges.length,
      diagnostics: graph.diagnostics.length,
    },
    packageManager: discovery.packageManager,
    frameworks,
    plugins: graph.plugins.map((plugin) => plugin.pluginId),
  };
}
