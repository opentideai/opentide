export type SourceLanguage =
  | "typescript"
  | "javascript"
  | "tsx"
  | "jsx"
  | "json"
  | "css"
  | "html"
  | "markdown"
  | "unknown";

export const CODEBASE_GRAPH_SCHEMA_VERSION = 1;

export type FactSourceMethod =
  | "ast"
  | "ts-language-service"
  | "config"
  | "manifest"
  | "agent"
  | "user";

export interface FactSource {
  pluginId: string;
  ruleId?: string;
  method: FactSourceMethod;
  inferred: boolean;
}

export interface SourceLocation {
  file: string;
  startLine: number;
  startColumn: number;
  endLine?: number;
  endColumn?: number;
}

export interface SemanticMetadata {
  id: string;
  name: string;
  kind: string;
  source: FactSource;
  confidence: number;
  locations: SourceLocation[];
  tags?: string[];
  module?: string;
}

export interface PluginRunSummary {
  pluginId: string;
  label?: string;
  version?: string;
  status: "matched" | "skipped" | "completed" | "error";
  confidence?: number;
  startedAt?: string;
  completedAt?: string;
  diagnostics?: SemanticDiagnostic[];
}

export interface CodeFile extends SemanticMetadata {
  kind: "file";
  path: string;
  language: SourceLanguage;
  sizeBytes?: number;
  generated?: boolean;
}

export interface CodeModule extends SemanticMetadata {
  kind: "module";
  file: string;
  importIds: string[];
  exportIds: string[];
}

export interface CodeSymbol extends SemanticMetadata {
  kind: "symbol";
  symbolKind:
    | "function"
    | "class"
    | "interface"
    | "type"
    | "enum"
    | "variable"
    | "component"
    | "method"
    | "property"
    | "unknown";
  file: string;
  exported?: boolean;
  signature?: string;
  /** Names of decorators applied to this symbol, e.g. ["Component", "Injectable"]. */
  decorators?: string[];
}

export interface RouteSemantic extends SemanticMetadata {
  kind: "route";
  method: string;
  path: string;
  framework?: string;
  handlerIds: string[];
  middlewareIds: string[];
  mountPath?: string;
  pathSyntax?: "hono" | "express" | "next-file" | "file-system" | "unknown";
  requestSchemaId?: string;
  responseSchemaIds?: string[];
}

export interface HandlerParamSemantic {
  name: string;
  role:
    | "context"
    | "request"
    | "response"
    | "next"
    | "event"
    | "params"
    | "unknown";
  typeName?: string;
}

export interface HandlerAbiSemantic {
  id: string;
  params: HandlerParamSemantic[];
  responseStyle?: "return-response" | "res-mutation" | "mixed" | "unknown";
}

export interface HandlerSemantic extends SemanticMetadata {
  kind: "handler";
  framework?: string;
  language: SourceLanguage;
  abi: HandlerAbiSemantic;
  symbolId?: string;
  routeIds: string[];
}

export interface MiddlewareSemantic extends SemanticMetadata {
  kind: "middleware";
  framework?: string;
  language: SourceLanguage;
  abi?: HandlerAbiSemantic;
  symbolId?: string;
  routeIds: string[];
}

export interface FunctionSemantic extends SemanticMetadata {
  kind: "function";
  language: SourceLanguage;
  symbolId?: string;
  signature?: string;
  returnType?: string;
}

export interface SchemaSemantic extends SemanticMetadata {
  kind: "schema";
  schemaKind: "database" | "validation" | "type" | "orm" | "unknown";
  tableName?: string;
  typeName?: string;
  fields?: SchemaFieldSemantic[];
}

export interface SchemaFieldSemantic {
  name: string;
  type?: string;
  optional?: boolean;
  primaryKey?: boolean;
}

export interface ComponentSemantic extends SemanticMetadata {
  kind: "component";
  language: SourceLanguage;
  symbolId?: string;
  framework?: string;
  routeIds?: string[];
}

export interface TestSemantic extends SemanticMetadata {
  kind: "test";
  language: SourceLanguage;
  framework?: string;
  file: string;
  targetIds: string[];
}

export interface ProjectCommand extends SemanticMetadata {
  kind: "command";
  commandKind:
    | "install"
    | "dev"
    | "test"
    | "typecheck"
    | "lint"
    | "build"
    | "format"
    | "unknown";
  command: string;
  cwd?: string;
  packageManager?: "npm" | "pnpm" | "yarn" | "bun" | "deno" | "unknown";
}

export interface SemanticFact extends SemanticMetadata {
  kind: "fact";
  factKind:
    | "framework"
    | "dependency"
    | "route-dsl"
    | "entrypoint"
    | "config"
    | "convention"
    | "import-strategy"
    | "mapping"
    | "candidate-entity"
    | "ignored"
    | "unknown";
  value: unknown;
  appliesToIds?: string[];
}

export type SemanticEdgeType =
  | "routes-to"
  | "uses-middleware"
  | "calls"
  | "imports"
  | "reads-env"
  | "reads-config"
  | "queries-schema"
  | "renders"
  | "tested-by"
  | "mounts"
  | "exports"
  | "defines";

export interface SemanticEdge {
  id: string;
  type: SemanticEdgeType;
  sourceId: string;
  targetId: string;
  source: FactSource;
  confidence: number;
  locations?: SourceLocation[];
  label?: string;
}

export interface SemanticDiagnostic {
  id: string;
  severity: "info" | "warning" | "error";
  message: string;
  source: FactSource;
  locations?: SourceLocation[];
  entityIds?: string[];
}

export interface CodebaseGraph {
  schemaVersion: typeof CODEBASE_GRAPH_SCHEMA_VERSION;
  projectId: string;
  rootPath: string;
  indexedAt: string;
  plugins: PluginRunSummary[];
  files: CodeFile[];
  modules: CodeModule[];
  symbols: CodeSymbol[];
  routes: RouteSemantic[];
  handlers: HandlerSemantic[];
  middleware: MiddlewareSemantic[];
  functions: FunctionSemantic[];
  schemas: SchemaSemantic[];
  components: ComponentSemantic[];
  tests: TestSemantic[];
  commands: ProjectCommand[];
  facts: SemanticFact[];
  edges: SemanticEdge[];
  diagnostics: SemanticDiagnostic[];
}

export interface GraphValidationIssue {
  severity: "warning" | "error";
  code: string;
  message: string;
  entityId?: string;
  location?: SourceLocation;
}

export interface SemanticContribution {
  pluginId: string;
  files?: CodeFile[];
  modules?: CodeModule[];
  symbols?: CodeSymbol[];
  routes?: RouteSemantic[];
  handlers?: HandlerSemantic[];
  middleware?: MiddlewareSemantic[];
  functions?: FunctionSemantic[];
  schemas?: SchemaSemantic[];
  components?: ComponentSemantic[];
  tests?: TestSemantic[];
  commands?: ProjectCommand[];
  facts?: SemanticFact[];
  edges?: SemanticEdge[];
  diagnostics?: SemanticDiagnostic[];
  plugins?: PluginRunSummary[];
}

type EntityWithMetadata = SemanticMetadata;

const ENTITY_COLLECTIONS = [
  "files",
  "modules",
  "symbols",
  "routes",
  "handlers",
  "middleware",
  "functions",
  "schemas",
  "components",
  "tests",
  "commands",
  "facts",
] as const;

export function createEmptyCodebaseGraph(
  projectId: string,
  rootPath: string,
  indexedAt = new Date().toISOString(),
): CodebaseGraph {
  return {
    schemaVersion: CODEBASE_GRAPH_SCHEMA_VERSION,
    projectId,
    rootPath,
    indexedAt,
    plugins: [],
    files: [],
    modules: [],
    symbols: [],
    routes: [],
    handlers: [],
    middleware: [],
    functions: [],
    schemas: [],
    components: [],
    tests: [],
    commands: [],
    facts: [],
    edges: [],
    diagnostics: [],
  };
}

export function semanticId(kind: string, key: string): string {
  return `${sanitizeIdPart(kind)}:${sanitizeIdPart(key)}`;
}

export function fileSemanticId(path: string): string {
  return semanticId("file", normalizePathKey(path));
}

export function symbolSemanticId(file: string, name: string): string {
  return semanticId("symbol", `${normalizePathKey(file)}#${name}`);
}

export function routeSemanticId(method: string, path: string): string {
  return semanticId("route", `${method.toUpperCase()} ${path}`);
}

export function edgeSemanticId(
  type: SemanticEdgeType,
  sourceId: string,
  targetId: string,
): string {
  return semanticId("edge", `${type}:${sourceId}->${targetId}`);
}

export function mergeCodebaseContributions(
  base: CodebaseGraph,
  contributions: SemanticContribution[],
): CodebaseGraph {
  const graph = cloneGraph(base);

  for (const contribution of contributions) {
    for (const collection of ENTITY_COLLECTIONS) {
      mergeEntityCollection(
        graph[collection] as EntityWithMetadata[],
        (contribution[collection] ?? []) as EntityWithMetadata[],
      );
    }
    mergeEdges(graph.edges, contribution.edges ?? []);
    mergeDiagnostics(graph.diagnostics, contribution.diagnostics ?? []);
    mergePluginRuns(
      graph.plugins,
      contribution.plugins ?? [{
        pluginId: contribution.pluginId,
        status: "completed",
      }],
    );
  }

  sortGraph(graph);
  return graph;
}

export function validateCodebaseGraph(
  graph: CodebaseGraph,
): GraphValidationIssue[] {
  const issues: GraphValidationIssue[] = [];
  const entityIds = new Set<string>();

  for (const collection of ENTITY_COLLECTIONS) {
    for (const entity of graph[collection] as EntityWithMetadata[]) {
      if (entityIds.has(entity.id)) {
        issues.push({
          severity: "error",
          code: "DUPLICATE_ENTITY_ID",
          message: `Duplicate semantic entity id "${entity.id}".`,
          entityId: entity.id,
        });
      }
      entityIds.add(entity.id);
      validateConfidence(entity.id, entity.confidence, issues);
      validateLocations(entity.id, entity.locations, issues);
    }
  }

  const edgeIds = new Set<string>();
  for (const edge of graph.edges) {
    if (edgeIds.has(edge.id)) {
      issues.push({
        severity: "error",
        code: "DUPLICATE_EDGE_ID",
        message: `Duplicate semantic edge id "${edge.id}".`,
        entityId: edge.id,
      });
    }
    edgeIds.add(edge.id);
    validateConfidence(edge.id, edge.confidence, issues);
    validateLocations(edge.id, edge.locations ?? [], issues);
    if (!entityIds.has(edge.sourceId)) {
      issues.push({
        severity: "error",
        code: "BROKEN_EDGE_SOURCE",
        message:
          `Edge "${edge.id}" references missing source "${edge.sourceId}".`,
        entityId: edge.id,
      });
    }
    if (!entityIds.has(edge.targetId)) {
      issues.push({
        severity: "error",
        code: "BROKEN_EDGE_TARGET",
        message:
          `Edge "${edge.id}" references missing target "${edge.targetId}".`,
        entityId: edge.id,
      });
    }
  }

  for (const route of graph.routes) {
    for (const handlerId of route.handlerIds) {
      if (!entityIds.has(handlerId)) {
        issues.push({
          severity: "error",
          code: "BROKEN_ROUTE_HANDLER",
          message:
            `Route "${route.id}" references missing handler "${handlerId}".`,
          entityId: route.id,
        });
      }
    }
    for (const middlewareId of route.middlewareIds) {
      if (!entityIds.has(middlewareId)) {
        issues.push({
          severity: "error",
          code: "BROKEN_ROUTE_MIDDLEWARE",
          message:
            `Route "${route.id}" references missing middleware "${middlewareId}".`,
          entityId: route.id,
        });
      }
    }
  }

  for (const test of graph.tests) {
    for (const targetId of test.targetIds) {
      if (!entityIds.has(targetId)) {
        issues.push({
          severity: "warning",
          code: "BROKEN_TEST_TARGET",
          message: `Test "${test.id}" references missing target "${targetId}".`,
          entityId: test.id,
        });
      }
    }
  }

  return issues;
}

function mergeEntityCollection<T extends EntityWithMetadata>(
  target: T[],
  incoming: T[],
): void {
  const byId = new Map(target.map((entry) => [entry.id, entry]));
  for (const entry of incoming) {
    const existing = byId.get(entry.id);
    if (!existing) {
      target.push(entry);
      byId.set(entry.id, entry);
      continue;
    }
    Object.assign(existing, mergeEntity(existing, entry));
  }
}

function mergeEntity<T extends EntityWithMetadata>(
  existing: T,
  incoming: T,
): T {
  const merged = {
    ...existing,
    ...incoming,
    confidence: Math.max(existing.confidence, incoming.confidence),
    locations: mergeLocations(existing.locations, incoming.locations),
    tags: mergeStringArrays(existing.tags, incoming.tags),
  } as T;

  mergeKnownRelationshipArrays(merged, existing, incoming);
  return merged;
}

function mergeKnownRelationshipArrays<T extends EntityWithMetadata>(
  merged: T,
  existing: T,
  incoming: T,
): void {
  const arrayKeys = [
    "handlerIds",
    "middlewareIds",
    "responseSchemaIds",
    "routeIds",
    "importIds",
    "exportIds",
    "targetIds",
    "appliesToIds",
  ] as const;

  for (const key of arrayKeys) {
    const existingValue = getStringArray(existing, key);
    const incomingValue = getStringArray(incoming, key);
    const mergedValue = mergeStringArrays(existingValue, incomingValue);
    if (mergedValue) {
      (merged as Record<string, unknown>)[key] = mergedValue;
    }
  }
}

function getStringArray(value: unknown, key: string): string[] | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = (value as Record<string, unknown>)[key];
  if (!Array.isArray(candidate)) return undefined;
  return candidate.every((item) => typeof item === "string")
    ? candidate as string[]
    : undefined;
}

function mergeEdges(target: SemanticEdge[], incoming: SemanticEdge[]): void {
  const byId = new Map(target.map((entry) => [entry.id, entry]));
  for (const edge of incoming) {
    const existing = byId.get(edge.id);
    if (!existing) {
      target.push(edge);
      byId.set(edge.id, edge);
      continue;
    }
    Object.assign(existing, {
      ...existing,
      ...edge,
      confidence: Math.max(existing.confidence, edge.confidence),
      locations: mergeLocations(existing.locations ?? [], edge.locations ?? []),
    });
  }
}

function mergeDiagnostics(
  target: SemanticDiagnostic[],
  incoming: SemanticDiagnostic[],
): void {
  const byId = new Map(target.map((entry) => [entry.id, entry]));
  for (const diagnostic of incoming) {
    const existing = byId.get(diagnostic.id);
    if (!existing) {
      target.push(diagnostic);
      byId.set(diagnostic.id, diagnostic);
      continue;
    }
    Object.assign(existing, {
      ...existing,
      ...diagnostic,
      locations: mergeLocations(
        existing.locations ?? [],
        diagnostic.locations ?? [],
      ),
      entityIds: mergeStringArrays(existing.entityIds, diagnostic.entityIds),
    });
  }
}

function mergePluginRuns(
  target: PluginRunSummary[],
  incoming: PluginRunSummary[],
): void {
  const byId = new Map(target.map((entry) => [entry.pluginId, entry]));
  for (const run of incoming) {
    const existing = byId.get(run.pluginId);
    if (!existing) {
      target.push(run);
      byId.set(run.pluginId, run);
      continue;
    }
    Object.assign(existing, {
      ...existing,
      ...run,
      confidence: Math.max(existing.confidence ?? 0, run.confidence ?? 0),
      diagnostics: mergeDiagnosticArrays(
        existing.diagnostics ?? [],
        run.diagnostics ?? [],
      ),
    });
  }
}

function mergeDiagnosticArrays(
  existing: SemanticDiagnostic[],
  incoming: SemanticDiagnostic[],
): SemanticDiagnostic[] {
  const out = [...existing];
  mergeDiagnostics(out, incoming);
  return out.toSorted(compareById);
}

function mergeLocations(
  existing: SourceLocation[],
  incoming: SourceLocation[],
): SourceLocation[] {
  const byKey = new Map<string, SourceLocation>();
  for (const location of [...existing, ...incoming]) {
    byKey.set(locationKey(location), location);
  }
  return [...byKey.values()].toSorted((a, b) =>
    a.file.localeCompare(b.file) ||
    a.startLine - b.startLine ||
    a.startColumn - b.startColumn
  );
}

function mergeStringArrays(
  existing: string[] | undefined,
  incoming: string[] | undefined,
): string[] | undefined {
  if (!existing?.length && !incoming?.length) return undefined;
  return [...new Set([...(existing ?? []), ...(incoming ?? [])])].toSorted();
}

function cloneGraph(graph: CodebaseGraph): CodebaseGraph {
  return structuredClone(graph);
}

function sortGraph(graph: CodebaseGraph): void {
  graph.plugins.sort((a, b) => a.pluginId.localeCompare(b.pluginId));
  for (const collection of ENTITY_COLLECTIONS) {
    (graph[collection] as EntityWithMetadata[]).sort(compareById);
  }
  graph.edges.sort(compareById);
  graph.diagnostics.sort(compareById);
}

function compareById(a: { id: string }, b: { id: string }): number {
  return a.id.localeCompare(b.id);
}

function locationKey(location: SourceLocation): string {
  return [
    location.file,
    location.startLine,
    location.startColumn,
    location.endLine ?? "",
    location.endColumn ?? "",
  ].join(":");
}

function normalizePathKey(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\/+/, "");
}

function sanitizeIdPart(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9._~:/#\[\] >-]+/g, "-")
    .replace(/\s+/g, " ");
}

function validateConfidence(
  entityId: string,
  confidence: number,
  issues: GraphValidationIssue[],
): void {
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    issues.push({
      severity: "error",
      code: "INVALID_CONFIDENCE",
      message: `Entity "${entityId}" has invalid confidence ${confidence}.`,
      entityId,
    });
  }
}

function validateLocations(
  entityId: string,
  locations: SourceLocation[],
  issues: GraphValidationIssue[],
): void {
  for (const location of locations) {
    if (location.startLine < 1 || location.startColumn < 1) {
      issues.push({
        severity: "error",
        code: "INVALID_LOCATION",
        message: `Entity "${entityId}" has an invalid source location.`,
        entityId,
        location,
      });
    }
  }
}
