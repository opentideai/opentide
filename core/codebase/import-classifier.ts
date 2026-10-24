import type {
  FrameworkHint,
  PackageManager,
  TsJsProjectDiscovery,
} from "./discovery.ts";
import type { TsJsSourceFile, TsJsSourceIndex } from "./source-index.ts";
import {
  type CodebaseGraph,
  type ComponentSemantic,
  edgeSemanticId,
  type FunctionSemantic,
  type HandlerAbiSemantic,
  type HandlerSemantic,
  type RouteSemantic,
  routeSemanticId,
  type SchemaFieldSemantic,
  type SchemaSemantic,
  type SemanticContribution,
  type SemanticDiagnostic,
  type SemanticEdge,
  type SemanticFact,
  semanticId,
  type SourceLanguage,
  type SourceLocation,
} from "./types.ts";
import { type CodebaseGraphSummary, summarizeCodebaseGraph } from "./import.ts";

export const IMPORT_CLASSIFIER_PLUGIN_ID = "agent-import-classifier";
export const IMPORT_CLASSIFIER_CALLER = "codebase_import_classifier";
export const IMPORT_CLASSIFIER_MAPPING_CONFIDENCE_MIN = 0.75;

export type ImportClassifierStatus =
  | "completed"
  | "skipped_unconfigured"
  | "failed";

export type ImportClassifierExcerptReason =
  | "entrypoint"
  | "route"
  | "component"
  | "schema"
  | "config"
  | "other";

export interface ImportClassifierSourceExcerpt {
  file: string;
  language: SourceLanguage;
  reason: ImportClassifierExcerptReason;
  startLine: number;
  endLine: number;
  content: string;
  truncated: boolean;
}

export interface ImportClassifierPackageHints {
  packageManager: PackageManager;
  lockfiles: string[];
  scripts: Record<string, string>;
  dependencies: string[];
  devDependencies: string[];
}

export interface ImportClassifierPluginDiagnostic {
  pluginId: string;
  severity: SemanticDiagnostic["severity"];
  message: string;
  locations?: SourceLocation[];
}

export interface ImportClassifierRequest {
  graphSummary: CodebaseGraphSummary;
  packageHints: ImportClassifierPackageHints;
  frameworkHints: FrameworkHint[];
  sourceExcerpts: ImportClassifierSourceExcerpt[];
  pluginDiagnostics: ImportClassifierPluginDiagnostic[];
}

export interface BuildImportClassifierRequestOptions {
  graph: CodebaseGraph;
  discovery: TsJsProjectDiscovery;
  sourceIndex: TsJsSourceIndex;
  maxExcerpts?: number;
  maxExcerptChars?: number;
}

export interface ImportClassifierContributionOptions {
  existingEntityIds?: Iterable<string>;
}

export interface ImportClassifierFact {
  kind:
    | "framework"
    | "convention"
    | "import-strategy"
    | "mapping"
    | "unknown";
  name: string;
  value: unknown;
  confidence: number;
  locations?: SourceLocation[];
  appliesToIds?: string[];
}

export type ImportClassifierMapping =
  | ImportClassifierRouteMapping
  | ImportClassifierHandlerMapping
  | ImportClassifierFunctionMapping
  | ImportClassifierSchemaMapping
  | ImportClassifierComponentMapping;

interface ImportClassifierMappingBase {
  kind: "route" | "handler" | "function" | "schema" | "component";
  name: string;
  confidence: number;
  locations?: SourceLocation[];
  tags?: string[];
  module?: string;
  sourceIds?: string[];
}

export interface ImportClassifierRouteMapping
  extends ImportClassifierMappingBase {
  kind: "route";
  method: string;
  path: string;
  framework?: string;
  handlerIds?: string[];
  middlewareIds?: string[];
  mountPath?: string;
  pathSyntax?: RouteSemantic["pathSyntax"];
  requestSchemaId?: string;
  responseSchemaIds?: string[];
}

export interface ImportClassifierHandlerMapping
  extends ImportClassifierMappingBase {
  kind: "handler";
  framework?: string;
  language?: SourceLanguage;
  abi?: HandlerAbiSemantic;
  symbolId?: string;
  routeIds?: string[];
}

export interface ImportClassifierFunctionMapping
  extends ImportClassifierMappingBase {
  kind: "function";
  language?: SourceLanguage;
  symbolId?: string;
  signature?: string;
  returnType?: string;
}

export interface ImportClassifierSchemaMapping
  extends ImportClassifierMappingBase {
  kind: "schema";
  schemaKind?: SchemaSemantic["schemaKind"];
  tableName?: string;
  typeName?: string;
  fields?: SchemaFieldSemantic[];
}

export interface ImportClassifierComponentMapping
  extends ImportClassifierMappingBase {
  kind: "component";
  language?: SourceLanguage;
  symbolId?: string;
  framework?: string;
  routeIds?: string[];
}

export interface ImportClassifierDiagnostic {
  severity: SemanticDiagnostic["severity"];
  message: string;
  confidence?: number;
  locations?: SourceLocation[];
  entityIds?: string[];
}

export interface ImportClassifierCandidateEntity {
  entityType:
    | "route"
    | "handler"
    | "function"
    | "schema"
    | "component"
    | "template"
    | "asset"
    | "type"
    | "unknown";
  name: string;
  confidence: number;
  rationale?: string;
  sourceIds?: string[];
  locations?: SourceLocation[];
  sourceExcerpt?: string;
  value?: unknown;
}

export interface ImportClassifierCompletedResult {
  status: "completed";
  model?: string;
  facts: ImportClassifierFact[];
  mappings: ImportClassifierMapping[];
  diagnostics: ImportClassifierDiagnostic[];
  candidateEntities: ImportClassifierCandidateEntity[];
}

export interface ImportClassifierSkippedResult {
  status: "skipped_unconfigured";
  reason: string;
  diagnostics: ImportClassifierDiagnostic[];
}

export interface ImportClassifierFailedResult {
  status: "failed";
  reason: string;
  diagnostics: ImportClassifierDiagnostic[];
  model?: string;
}

export type ImportClassifierResult =
  | ImportClassifierCompletedResult
  | ImportClassifierSkippedResult
  | ImportClassifierFailedResult;

const DEFAULT_MAX_EXCERPTS = 16;
const DEFAULT_MAX_EXCERPT_CHARS = 2400;

export function buildImportClassifierRequest(
  options: BuildImportClassifierRequestOptions,
): ImportClassifierRequest {
  return {
    graphSummary: summarizeCodebaseGraph(options.graph, options.discovery),
    packageHints: {
      packageManager: options.discovery.packageManager,
      lockfiles: options.discovery.lockfiles,
      scripts: options.discovery.packageJson?.scripts ?? {},
      dependencies: Object.keys(
        options.discovery.packageJson?.dependencies ?? {},
      )
        .toSorted(),
      devDependencies: Object.keys(
        options.discovery.packageJson?.devDependencies ?? {},
      )
        .toSorted(),
    },
    frameworkHints: options.discovery.frameworkHints,
    sourceExcerpts: selectSourceExcerpts(
      options.sourceIndex.files,
      options.maxExcerpts ?? DEFAULT_MAX_EXCERPTS,
      options.maxExcerptChars ?? DEFAULT_MAX_EXCERPT_CHARS,
    ),
    pluginDiagnostics: collectPluginDiagnostics(options.graph),
  };
}

export function importClassifierResultToSemanticContribution(
  result: ImportClassifierResult,
  options: ImportClassifierContributionOptions = {},
): SemanticContribution {
  const diagnostics = result.diagnostics.map((diagnostic, index) =>
    diagnosticToSemanticDiagnostic(result.status, diagnostic, index)
  );

  if (result.status !== "completed") {
    return {
      pluginId: IMPORT_CLASSIFIER_PLUGIN_ID,
      diagnostics,
      plugins: [{
        pluginId: IMPORT_CLASSIFIER_PLUGIN_ID,
        label: "Agent import classifier",
        status: result.status === "skipped_unconfigured" ? "skipped" : "error",
        diagnostics,
      }],
    };
  }

  const routes: RouteSemantic[] = [];
  const handlers: HandlerSemantic[] = [];
  const functions: FunctionSemantic[] = [];
  const schemas: SchemaSemantic[] = [];
  const components: ComponentSemantic[] = [];
  const edges: SemanticEdge[] = [];
  const existingEntityIds = new Set(options.existingEntityIds ?? []);
  const highConfidenceMappings = result.mappings.filter((mapping) =>
    mapping.confidence >= IMPORT_CLASSIFIER_MAPPING_CONFIDENCE_MIN
  );
  const nonCollidingMappings: ImportClassifierMapping[] = [];
  for (const mapping of highConfidenceMappings) {
    const id = semanticIdForMapping(mapping);
    if (existingEntityIds.has(id)) {
      diagnostics.push(diagnosticToSemanticDiagnostic("completed", {
        severity: "warning",
        message:
          `Kept model-assisted ${mapping.kind} mapping "${mapping.name}" as a fact because it collides with existing graph entity "${id}".`,
        locations: mapping.locations,
      }, diagnostics.length));
      continue;
    }
    nonCollidingMappings.push(mapping);
  }

  const availableIds = new Set(existingEntityIds);
  for (const mapping of highConfidenceMappings) {
    const id = semanticIdForMapping(mapping);
    if (!existingEntityIds.has(id)) availableIds.add(id);
  }

  for (const mapping of nonCollidingMappings) {
    switch (mapping.kind) {
      case "route": {
        const handlerIds = resolveReferencedIds(
          mapping.handlerIds ?? [],
          "handler",
          availableIds,
          diagnostics,
          mapping,
        );
        const middlewareIds = resolveReferencedIds(
          mapping.middlewareIds ?? [],
          "middleware",
          availableIds,
          diagnostics,
          mapping,
        );
        const route = routeMappingToSemantic(mapping, {
          handlerIds,
          middlewareIds,
        });
        routes.push(route);
        for (const handlerId of route.handlerIds) {
          edges.push({
            id: edgeSemanticId("routes-to", route.id, handlerId),
            type: "routes-to",
            sourceId: route.id,
            targetId: handlerId,
            source: agentSource("route-handler-mapping"),
            confidence: route.confidence,
            locations: route.locations,
          });
        }
        break;
      }
      case "handler":
        handlers.push(handlerMappingToSemantic(mapping));
        break;
      case "function":
        functions.push(functionMappingToSemantic(mapping));
        break;
      case "schema":
        schemas.push(schemaMappingToSemantic(mapping));
        break;
      case "component":
        components.push(componentMappingToSemantic(mapping));
        break;
    }
  }

  const facts = [
    ...result.facts.map(factToSemanticFact),
    ...highConfidenceMappings.map(mappingToSemanticFact),
    ...result.candidateEntities.map((candidate) =>
      candidateToSemanticFact(
        candidate,
        resolveCandidateSourceIds(candidate, availableIds, diagnostics),
      )
    ),
  ];

  return {
    pluginId: IMPORT_CLASSIFIER_PLUGIN_ID,
    routes,
    handlers,
    functions,
    schemas,
    components,
    facts,
    edges,
    diagnostics,
    plugins: [{
      pluginId: IMPORT_CLASSIFIER_PLUGIN_ID,
      label: "Agent import classifier",
      status: "completed",
      diagnostics,
    }],
  };
}

function selectSourceExcerpts(
  files: TsJsSourceFile[],
  maxExcerpts: number,
  maxChars: number,
): ImportClassifierSourceExcerpt[] {
  return files
    .map((file) => ({ file, classification: classifyFile(file) }))
    .filter(({ classification }) => classification.score > 0)
    .toSorted((a, b) =>
      b.classification.score - a.classification.score ||
      a.file.path.localeCompare(b.file.path)
    )
    .slice(0, maxExcerpts)
    .map(({ file, classification }) =>
      excerptFile(file, classification.reason, maxChars)
    );
}

function classifyFile(file: TsJsSourceFile): {
  reason: ImportClassifierExcerptReason;
  score: number;
} {
  const path = file.path.toLowerCase();
  const basename = path.split("/").at(-1) ?? path;
  const content = file.content.slice(0, 8000);

  if (
    /(^|\/)(main|server|app|index|entry|root)\.(mjs|cjs|js|jsx|ts|tsx)$/.test(
      path,
    ) ||
    /createServer|listen\(|new Hono\(|express\(/.test(content)
  ) {
    return { reason: "entrypoint", score: 100 };
  }
  if (
    path.includes("/routes/") ||
    path.includes("/api/") ||
    path.includes("/pages/") ||
    path.includes("/app/") ||
    basename === "route.ts" ||
    basename === "route.js" ||
    basename === "+server.ts" ||
    basename === "+server.js" ||
    /\.(get|post|put|patch|delete)\(/i.test(content)
  ) {
    return { reason: "route", score: 90 };
  }
  if (
    path.includes("/schema") ||
    path.includes("/schemas") ||
    path.includes("/db/") ||
    path.includes("/models/") ||
    /z\.object|sqliteTable|pgTable|createTable|drizzle|prisma/i.test(content)
  ) {
    return { reason: "schema", score: 80 };
  }
  if (
    file.language === "tsx" ||
    file.language === "jsx" ||
    path.includes("/components/") ||
    /^[A-Z]/.test(basename)
  ) {
    return { reason: "component", score: 70 };
  }
  if (
    basename.startsWith("vite.config") ||
    basename.startsWith("next.config") ||
    basename === "svelte.config.js" ||
    basename === "astro.config.ts"
  ) {
    return { reason: "config", score: 60 };
  }
  return { reason: "other", score: 0 };
}

function excerptFile(
  file: TsJsSourceFile,
  reason: ImportClassifierExcerptReason,
  maxChars: number,
): ImportClassifierSourceExcerpt {
  const content = file.content.length > maxChars
    ? file.content.slice(0, maxChars)
    : file.content;
  const endLine = Math.max(1, content.split("\n").length);
  return {
    file: file.path,
    language: file.language,
    reason,
    startLine: 1,
    endLine,
    content,
    truncated: file.content.length > content.length,
  };
}

function collectPluginDiagnostics(
  graph: CodebaseGraph,
): ImportClassifierPluginDiagnostic[] {
  const diagnostics: ImportClassifierPluginDiagnostic[] = [];
  for (const diagnostic of graph.diagnostics) {
    diagnostics.push({
      pluginId: diagnostic.source.pluginId,
      severity: diagnostic.severity,
      message: diagnostic.message,
      locations: diagnostic.locations,
    });
  }
  for (const plugin of graph.plugins) {
    for (const diagnostic of plugin.diagnostics ?? []) {
      diagnostics.push({
        pluginId: diagnostic.source.pluginId || plugin.pluginId,
        severity: diagnostic.severity,
        message: diagnostic.message,
        locations: diagnostic.locations,
      });
    }
  }
  return diagnostics;
}

function factToSemanticFact(fact: ImportClassifierFact): SemanticFact {
  return {
    id: semanticId("fact", `agent:${fact.kind}:${fact.name}`),
    kind: "fact",
    name: fact.name,
    factKind: fact.kind,
    value: fact.value,
    appliesToIds: fact.appliesToIds,
    source: agentSource(`fact:${fact.kind}`),
    confidence: clampConfidence(fact.confidence),
    locations: normalizeLocations(fact.locations),
  };
}

function mappingToSemanticFact(mapping: ImportClassifierMapping): SemanticFact {
  return {
    id: semanticId("fact", `agent:mapping:${mapping.kind}:${mapping.name}`),
    kind: "fact",
    name: `Mapping: ${mapping.kind} ${mapping.name}`,
    factKind: "mapping",
    value: mapping,
    appliesToIds: mapping.sourceIds,
    source: agentSource(`mapping:${mapping.kind}`),
    confidence: clampConfidence(mapping.confidence),
    locations: normalizeLocations(mapping.locations),
  };
}

function candidateToSemanticFact(
  candidate: ImportClassifierCandidateEntity,
  appliesToIds: string[] | undefined,
): SemanticFact {
  return {
    id: semanticId(
      "fact",
      `agent:candidate:${candidate.entityType}:${candidate.name}`,
    ),
    kind: "fact",
    name: `Candidate ${candidate.entityType}: ${candidate.name}`,
    factKind: "candidate-entity",
    value: candidate,
    appliesToIds,
    source: agentSource(`candidate:${candidate.entityType}`),
    confidence: clampConfidence(candidate.confidence),
    locations: normalizeLocations(candidate.locations),
  };
}

function resolveCandidateSourceIds(
  candidate: ImportClassifierCandidateEntity,
  availableIds: Set<string>,
  diagnostics: SemanticDiagnostic[],
): string[] | undefined {
  const resolved: string[] = [];
  for (const rawId of candidate.sourceIds ?? []) {
    const match = sourceIdCandidates(rawId).find((id) => availableIds.has(id));
    if (match) {
      if (!resolved.includes(match)) resolved.push(match);
      continue;
    }
    diagnostics.push(diagnosticToSemanticDiagnostic("completed", {
      severity: "warning",
      message:
        `Dropped unresolved source reference "${rawId}" from candidate ${candidate.entityType} "${candidate.name}".`,
      locations: candidate.locations,
    }, diagnostics.length));
  }
  return resolved.length > 0 ? resolved : undefined;
}

function sourceIdCandidates(rawId: string): string[] {
  const candidates = [rawId, rawId.toLowerCase()];
  const separator = rawId.indexOf(":");
  if (separator > 0 && separator < rawId.length - 1) {
    candidates.push(
      semanticId(rawId.slice(0, separator), rawId.slice(separator + 1)),
    );
  }
  return [...new Set(candidates)];
}

function semanticIdForMapping(mapping: ImportClassifierMapping): string {
  switch (mapping.kind) {
    case "route":
      return routeSemanticId(mapping.method, mapping.path);
    case "handler":
      return semanticId("handler", mapping.name);
    case "function":
      return semanticId("function", mapping.name);
    case "schema":
      return semanticId("schema", mapping.name);
    case "component":
      return semanticId("component", mapping.name);
  }
}

function resolveReferencedIds(
  rawIds: string[],
  targetKind: "handler" | "middleware" | "schema" | "route",
  availableIds: Set<string>,
  diagnostics: SemanticDiagnostic[],
  mapping: ImportClassifierMapping,
): string[] {
  const resolved: string[] = [];
  for (const rawId of rawIds) {
    const candidates = [rawId, semanticId(targetKind, rawId)];
    const match = candidates.find((candidate) => availableIds.has(candidate));
    if (match) {
      if (!resolved.includes(match)) resolved.push(match);
      continue;
    }
    diagnostics.push(diagnosticToSemanticDiagnostic("completed", {
      severity: "warning",
      message:
        `Dropped unresolved ${targetKind} reference "${rawId}" from ${mapping.kind} mapping "${mapping.name}".`,
      locations: mapping.locations,
    }, diagnostics.length));
  }
  return resolved;
}

function routeMappingToSemantic(
  mapping: ImportClassifierRouteMapping,
  links: { handlerIds: string[]; middlewareIds: string[] },
) {
  const method = mapping.method.toUpperCase();
  const id = routeSemanticId(method, mapping.path);
  const route: RouteSemantic = {
    id,
    kind: "route",
    name: mapping.name || `${method} ${mapping.path}`,
    method,
    path: mapping.path,
    framework: mapping.framework,
    handlerIds: links.handlerIds,
    middlewareIds: links.middlewareIds,
    mountPath: mapping.mountPath,
    pathSyntax: mapping.pathSyntax,
    requestSchemaId: mapping.requestSchemaId,
    responseSchemaIds: mapping.responseSchemaIds,
    source: agentSource("route"),
    confidence: clampConfidence(mapping.confidence),
    locations: normalizeLocations(mapping.locations),
    tags: mapping.tags,
    module: mapping.module,
  };
  return route;
}

function handlerMappingToSemantic(
  mapping: ImportClassifierHandlerMapping,
): HandlerSemantic {
  return {
    id: semanticId("handler", mapping.name),
    kind: "handler",
    name: mapping.name,
    framework: mapping.framework,
    language: mapping.language ?? languageFromLocations(mapping.locations),
    abi: mapping.abi ?? { id: "agent-inferred", params: [] },
    symbolId: mapping.symbolId,
    routeIds: mapping.routeIds ?? [],
    source: agentSource("handler"),
    confidence: clampConfidence(mapping.confidence),
    locations: normalizeLocations(mapping.locations),
    tags: mapping.tags,
    module: mapping.module,
  };
}

function functionMappingToSemantic(
  mapping: ImportClassifierFunctionMapping,
): FunctionSemantic {
  return {
    id: semanticId("function", mapping.name),
    kind: "function",
    name: mapping.name,
    language: mapping.language ?? languageFromLocations(mapping.locations),
    symbolId: mapping.symbolId,
    signature: mapping.signature,
    returnType: mapping.returnType,
    source: agentSource("function"),
    confidence: clampConfidence(mapping.confidence),
    locations: normalizeLocations(mapping.locations),
    tags: mapping.tags,
    module: mapping.module,
  };
}

function schemaMappingToSemantic(
  mapping: ImportClassifierSchemaMapping,
): SchemaSemantic {
  return {
    id: semanticId("schema", mapping.name),
    kind: "schema",
    name: mapping.name,
    schemaKind: mapping.schemaKind ?? "unknown",
    tableName: mapping.tableName,
    typeName: mapping.typeName,
    fields: mapping.fields,
    source: agentSource("schema"),
    confidence: clampConfidence(mapping.confidence),
    locations: normalizeLocations(mapping.locations),
    tags: mapping.tags,
    module: mapping.module,
  };
}

function componentMappingToSemantic(
  mapping: ImportClassifierComponentMapping,
): ComponentSemantic {
  return {
    id: semanticId("component", mapping.name),
    kind: "component",
    name: mapping.name,
    language: mapping.language ?? languageFromLocations(mapping.locations),
    symbolId: mapping.symbolId,
    framework: mapping.framework,
    routeIds: mapping.routeIds,
    source: agentSource("component"),
    confidence: clampConfidence(mapping.confidence),
    locations: normalizeLocations(mapping.locations),
    tags: mapping.tags,
    module: mapping.module,
  };
}

function diagnosticToSemanticDiagnostic(
  status: ImportClassifierStatus,
  diagnostic: ImportClassifierDiagnostic,
  index: number,
): SemanticDiagnostic {
  return {
    id: semanticId(
      "diagnostic",
      `agent-import-classifier:${status}:${index}:${diagnostic.message}`,
    ),
    severity: diagnostic.severity,
    message: diagnostic.message,
    source: agentSource(`diagnostic:${status}`),
    locations: normalizeLocations(diagnostic.locations),
    entityIds: diagnostic.entityIds,
  };
}

function agentSource(ruleId: string) {
  return {
    pluginId: IMPORT_CLASSIFIER_PLUGIN_ID,
    ruleId,
    method: "agent" as const,
    inferred: true,
  };
}

function normalizeLocations(
  locations: SourceLocation[] | undefined,
): SourceLocation[] {
  return (locations ?? [])
    .filter((location) =>
      typeof location.file === "string" &&
      Number.isFinite(location.startLine) &&
      Number.isFinite(location.startColumn)
    )
    .map((location) => ({
      file: location.file,
      startLine: Math.max(1, Math.trunc(location.startLine)),
      startColumn: Math.max(1, Math.trunc(location.startColumn)),
      ...(Number.isFinite(location.endLine)
        ? { endLine: Math.max(1, Math.trunc(location.endLine!)) }
        : {}),
      ...(Number.isFinite(location.endColumn)
        ? { endColumn: Math.max(1, Math.trunc(location.endColumn!)) }
        : {}),
    }));
}

function clampConfidence(confidence: number): number {
  if (!Number.isFinite(confidence)) return 0;
  return Math.max(0, Math.min(1, confidence));
}

function languageFromLocations(
  locations: SourceLocation[] | undefined,
): SourceLanguage {
  const file = locations?.[0]?.file.toLowerCase() ?? "";
  if (file.endsWith(".tsx")) return "tsx";
  if (file.endsWith(".jsx")) return "jsx";
  if (file.endsWith(".ts") || file.endsWith(".mts") || file.endsWith(".cts")) {
    return "typescript";
  }
  if (file.endsWith(".js") || file.endsWith(".mjs") || file.endsWith(".cjs")) {
    return "javascript";
  }
  return "unknown";
}
