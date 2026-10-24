import * as ts from "typescript";
import {
  edgeSemanticId,
  type FactSource,
  type HandlerAbiSemantic,
  type HandlerParamSemantic,
  type HandlerSemantic,
  type MiddlewareSemantic,
  type RouteSemantic,
  routeSemanticId,
  type SemanticContribution,
  type SemanticDiagnostic,
  type SemanticEdge,
  type SemanticFact,
  semanticId,
  type SourceLanguage,
  type SourceLocation,
  symbolSemanticId,
} from "./types.ts";
import type {
  DetectionContext,
  DetectionEvidence,
  DetectionResult,
  IndexContext,
  SemanticsPlugin,
} from "./plugins.ts";
import type { TsJsSourceFile } from "./source-index.ts";

/**
 * Slice 4 — the Hono plugin overlay.
 *
 * Maps source-backed Hono constructs (`new Hono()`, `app.get/post/…`,
 * `app.use`, `app.route`) into first-class RouteSemantic / HandlerSemantic /
 * MiddlewareSemantic nodes with edges. It runs *on top of* the generic symbol
 * graph (higher `suggestedPriority` than `generic-tsjs`), so its route-level
 * nodes win merges while the rest of the project stays browsable source.
 *
 * Scope guards (see docs/project-import-strategy.md, Slice 4):
 * - Graph nodes only — never touches kernel.routes / kernel.handlers.
 * - Best-effort, in-file analysis. Cross-file sub-apps are flagged as
 *   diagnostics, not silently dropped.
 * - index() never throws: per-file AST failures become diagnostics so a single
 *   bad file can't sink the whole contribution.
 */

export const HONO_PLUGIN_ID = "hono";
export const HONO_FRAMEWORK = "hono";
export const HONO_PLUGIN_LABEL = "Hono";
export const HONO_PLUGIN_VERSION = "0.1.0";

/** Path syntax tag stored on every emitted route (RouteSemantic.pathSyntax). */
const HONO_PATH_SYNTAX = "hono" as const;
/** The class imported from the `hono` module and instantiated as an app. */
const HONO_CLASS_NAME = "Hono";
/** The npm/JSR module specifier a Hono app is imported from. */
const HONO_MODULE_SPECIFIER = "hono";
/** Must beat the generic plugin (suggestedPriority -1000) so Hono nodes win. */
const HONO_PLUGIN_PRIORITY = 100;
/** Default name for the Hono context parameter when it can't be read. */
const DEFAULT_CONTEXT_PARAM = "c";
/** Response style every Hono handler exposes: it returns a Response. */
const HONO_RESPONSE_STYLE = "return-response" as const;

/** HTTP verbs Hono exposes as `app.<method>(path, ...handlers)`. */
const HONO_ROUTE_METHODS = new Set([
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "options",
  "all",
]);
/** `app.use(path?, ...middleware)` registers middleware. */
const HONO_USE_METHOD = "use";
/** `app.route(basePath, subApp)` mounts a sub-app. */
const HONO_MOUNT_METHOD = "route";

/** Confidence tiers — named so provenance stays honest across constructs. */
const CONFIDENCE = {
  detectDependency: 0.95,
  detectSource: 0.8,
  routeLiteral: 0.95,
  routeDynamic: 0.5,
  handler: 0.9,
  handlerInferred: 0.6,
  middleware: 0.9,
  middlewareInferred: 0.6,
  edge: 0.9,
  mount: 0.85,
  app: 0.95,
} as const;

const RULE = {
  route: "hono-route",
  handler: "hono-handler",
  middleware: "hono-middleware",
  mount: "hono-mount",
  app: "hono-app",
  routesTo: "hono-routes-to",
  usesMiddleware: "hono-uses-middleware",
  defines: "hono-defines",
} as const;

export function createHonoPlugin(): SemanticsPlugin {
  return {
    manifest: {
      id: HONO_PLUGIN_ID,
      label: HONO_PLUGIN_LABEL,
      version: HONO_PLUGIN_VERSION,
      languages: ["typescript", "tsx", "javascript", "jsx"],
      detects: [HONO_FRAMEWORK],
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
    detect: detectHono,
    index: indexHono,
  };
}

function detectHono(ctx: DetectionContext): DetectionResult {
  const evidence: DetectionEvidence[] = [];
  let confidence = 0;

  const dependencyHint = ctx.discovery?.frameworkHints.find((hint) =>
    hint.id === HONO_FRAMEWORK && hint.source === "dependency"
  );
  if (dependencyHint) {
    evidence.push({
      kind: "dependency",
      description: `Depends on the "${HONO_MODULE_SPECIFIER}" package.`,
      file: "package.json",
    });
    confidence = Math.max(confidence, CONFIDENCE.detectDependency);
  }

  const sourceHit = ctx.sourceIndex?.files.find(fileImportsHono);
  if (sourceHit) {
    evidence.push({
      kind: "source-pattern",
      description:
        `Imports and instantiates ${HONO_CLASS_NAME} from "${HONO_MODULE_SPECIFIER}".`,
      file: sourceHit.path,
    });
    confidence = Math.max(
      confidence,
      dependencyHint ? CONFIDENCE.detectDependency : CONFIDENCE.detectSource,
    );
  }

  if (evidence.length === 0) return { matched: false, confidence: 0, evidence };
  return {
    matched: true,
    confidence,
    suggestedPriority: HONO_PLUGIN_PRIORITY,
    evidence,
  };
}

/** Cheap textual pre-check used only by detect() — index() re-parses via AST. */
function fileImportsHono(file: TsJsSourceFile): boolean {
  return /from\s+["']hono["']/.test(file.content) ||
    /new\s+Hono\s*[<(]/.test(file.content);
}

// ---------------------------------------------------------------------------
// Indexing
// ---------------------------------------------------------------------------

interface HonoIndexState {
  routes: Map<string, RouteSemantic>;
  handlers: Map<string, HandlerSemantic>;
  middleware: Map<string, MiddlewareSemantic>;
  facts: Map<string, SemanticFact>;
  edges: Map<string, SemanticEdge>;
  diagnostics: Map<string, SemanticDiagnostic>;
}

/** A route call collected during the AST walk, before path composition. */
interface RawRoute {
  appKey: string;
  method: string;
  rawPath: string;
  pathIsLiteral: boolean;
  handlerArgs: ts.Expression[];
  location: SourceLocation;
}

interface RawMiddleware {
  appKey: string;
  /** Normalized path prefix ("" = matches every route on the app). */
  prefix: string;
  prefixIsLiteral: boolean;
  handlerArgs: ts.Expression[];
  location: SourceLocation;
}

interface RawMount {
  parentKey: string;
  base: string;
  childKey: string | null;
  location: SourceLocation;
}

interface HonoApp {
  key: string;
  name: string;
  location: SourceLocation;
}

function indexHono(ctx: IndexContext): SemanticContribution {
  const state: HonoIndexState = {
    routes: new Map(),
    handlers: new Map(),
    middleware: new Map(),
    facts: new Map(),
    edges: new Map(),
    diagnostics: new Map(),
  };

  for (const file of ctx.sourceIndex?.files ?? []) {
    try {
      indexFile(file, state);
    } catch (err) {
      addFileErrorDiagnostic(state, file, err);
    }
  }

  return {
    pluginId: HONO_PLUGIN_ID,
    routes: sortById([...state.routes.values()]),
    handlers: sortById([...state.handlers.values()]),
    middleware: sortById([...state.middleware.values()]),
    facts: sortById([...state.facts.values()]),
    edges: sortById([...state.edges.values()]),
    diagnostics: sortById([...state.diagnostics.values()]),
  };
}

function indexFile(file: TsJsSourceFile, state: HonoIndexState): void {
  const sourceFile = ts.createSourceFile(
    file.path,
    file.content,
    ts.ScriptTarget.Latest,
    true,
    scriptKindForLanguage(file.language),
  );

  const honoNames = collectHonoImportNames(sourceFile);
  if (honoNames.size === 0) return; // Not a Hono module — nothing to overlay.

  const apps = new Map<string, HonoApp>();
  const symbolNames = new Set<string>();
  const funcDecls = new Map<string, ts.SignatureDeclaration>();
  collectTopLevel(file, sourceFile, honoNames, apps, symbolNames, funcDecls);

  const rawRoutes: RawRoute[] = [];
  const rawMiddleware: RawMiddleware[] = [];
  const rawMounts: RawMount[] = [];
  const usedAppKeys = new Set<string>();

  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression)
    ) {
      const method = node.expression.name.text;
      const app = resolveAppRoot(node.expression.expression, honoNames, apps);
      if (app) {
        usedAppKeys.add(app.key);
        if (HONO_ROUTE_METHODS.has(method)) {
          rawRoutes.push(rawRouteFrom(file, sourceFile, node, method, app.key));
        } else if (method === HONO_USE_METHOD) {
          rawMiddleware.push(
            rawMiddlewareFrom(file, sourceFile, node, app.key),
          );
        } else if (method === HONO_MOUNT_METHOD) {
          const mount = rawMountFrom(file, sourceFile, node, app.key, apps);
          if (mount) {
            rawMounts.push(mount);
            if (mount.childKey) usedAppKeys.add(mount.childKey);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  const prefixes = composeMountPrefixes(rawMounts);
  emitApps(state, apps, usedAppKeys);
  emitMounts(state, file, apps, rawMounts);
  emitRoutes(
    state,
    file,
    sourceFile,
    rawRoutes,
    rawMiddleware,
    prefixes,
    symbolNames,
    funcDecls,
  );
}

// ---------------------------------------------------------------------------
// Collection helpers
// ---------------------------------------------------------------------------

/** Local names bound to the Hono class via `import ... from "hono"`. */
function collectHonoImportNames(sourceFile: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== HONO_MODULE_SPECIFIER
    ) {
      continue;
    }
    const clause = statement.importClause;
    if (!clause) continue;
    if (clause.name) names.add(clause.name.text); // default import
    const bindings = clause.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        const imported = element.propertyName?.text ?? element.name.text;
        if (imported === HONO_CLASS_NAME) names.add(element.name.text);
      }
    }
  }
  return names;
}

/**
 * One pass over top-level statements to gather: Hono app instances (named),
 * every top-level symbol name (so handler refs can link to the generic
 * plugin's CodeSymbols), and function-like declarations (so named handlers
 * expose a real ABI).
 */
function collectTopLevel(
  file: TsJsSourceFile,
  sourceFile: ts.SourceFile,
  honoNames: Set<string>,
  apps: Map<string, HonoApp>,
  symbolNames: Set<string>,
  funcDecls: Map<string, ts.SignatureDeclaration>,
): void {
  for (const statement of sourceFile.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const decl of statement.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name)) continue;
        const name = decl.name.text;
        symbolNames.add(name);
        if (decl.initializer && isArrowOrFunctionExpression(decl.initializer)) {
          funcDecls.set(name, decl.initializer);
        }
        if (decl.initializer && rootsAtHono(decl.initializer, honoNames)) {
          const location = locationOf(file, sourceFile, decl.name);
          apps.set(name, { key: name, name, location });
        }
      }
      continue;
    }
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      symbolNames.add(statement.name.text);
      funcDecls.set(statement.name.text, statement);
      continue;
    }
    if (ts.isClassDeclaration(statement) && statement.name) {
      symbolNames.add(statement.name.text);
    }
  }
}

/** True when `expr` is (a chain rooted at) `new Hono()`. */
function rootsAtHono(expr: ts.Expression, honoNames: Set<string>): boolean {
  const node = unwrapParen(expr);
  if (ts.isNewExpression(node)) {
    return ts.isIdentifier(node.expression) &&
      honoNames.has(node.expression.text);
  }
  if (
    ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
  ) {
    return rootsAtHono(node.expression.expression, honoNames);
  }
  if (ts.isPropertyAccessExpression(node)) {
    return rootsAtHono(node.expression, honoNames);
  }
  return false;
}

/**
 * Resolve the Hono app a method call is registered on, following chained calls
 * (`app.get(...).post(...)`). Named apps resolve by identifier; an inline
 * `new Hono().get(...)` resolves to a location-keyed anonymous app.
 */
function resolveAppRoot(
  expr: ts.Expression,
  honoNames: Set<string>,
  apps: Map<string, HonoApp>,
): HonoApp | null {
  const node = unwrapParen(expr);
  if (ts.isIdentifier(node)) return apps.get(node.text) ?? null;
  if (ts.isNewExpression(node)) {
    if (
      !ts.isIdentifier(node.expression) || !honoNames.has(node.expression.text)
    ) {
      return null;
    }
    const start = node.getStart();
    const key = `anon@${start}`;
    let app = apps.get(key);
    if (!app) {
      const sourceFile = node.getSourceFile();
      const pos = sourceFile.getLineAndCharacterOfPosition(start);
      app = {
        key,
        name: `${HONO_CLASS_NAME}()`,
        location: {
          file: sourceFile.fileName,
          startLine: pos.line + 1,
          startColumn: pos.character + 1,
        },
      };
      apps.set(key, app);
    }
    return app;
  }
  if (
    ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
  ) {
    return resolveAppRoot(node.expression.expression, honoNames, apps);
  }
  if (ts.isPropertyAccessExpression(node)) {
    return resolveAppRoot(node.expression, honoNames, apps);
  }
  return null;
}

function rawRouteFrom(
  file: TsJsSourceFile,
  sourceFile: ts.SourceFile,
  node: ts.CallExpression,
  method: string,
  appKey: string,
): RawRoute {
  const [pathArg, ...handlerArgs] = node.arguments;
  const path = literalString(pathArg);
  return {
    appKey,
    method: method.toUpperCase(),
    rawPath: path ?? (pathArg ? pathArg.getText(sourceFile) : "/"),
    pathIsLiteral: path !== null,
    handlerArgs,
    location: locationOf(file, sourceFile, node),
  };
}

function rawMiddlewareFrom(
  file: TsJsSourceFile,
  sourceFile: ts.SourceFile,
  node: ts.CallExpression,
  appKey: string,
): RawMiddleware {
  const first = node.arguments[0];
  const firstLiteral = literalString(first);
  // Hono's `use` takes an optional path prefix. If the first arg is a string
  // it's the prefix; otherwise every arg is middleware and it applies to all.
  if (firstLiteral !== null) {
    return {
      appKey,
      prefix: normalizePrefix(firstLiteral),
      prefixIsLiteral: true,
      handlerArgs: node.arguments.slice(1),
      location: locationOf(file, sourceFile, node),
    };
  }
  return {
    appKey,
    prefix: "",
    prefixIsLiteral: first === undefined || !isStringLike(first),
    handlerArgs: [...node.arguments],
    location: locationOf(file, sourceFile, node),
  };
}

function rawMountFrom(
  file: TsJsSourceFile,
  sourceFile: ts.SourceFile,
  node: ts.CallExpression,
  parentKey: string,
  apps: Map<string, HonoApp>,
): RawMount | null {
  const baseArg = node.arguments[0];
  const subArg = node.arguments[1];
  const base = literalString(baseArg);
  if (base === null || !subArg) return null;
  const childKey = ts.isIdentifier(subArg) && apps.has(subArg.text)
    ? subArg.text
    : null;
  return {
    parentKey,
    base: normalizeBase(base),
    childKey,
    location: locationOf(file, sourceFile, node),
  };
}

// ---------------------------------------------------------------------------
// Path composition
// ---------------------------------------------------------------------------

/**
 * Resolve the full mount prefix for each app by walking parent mounts
 * in-file (grandchildren compose too). Cycles are guarded.
 */
function composeMountPrefixes(mounts: RawMount[]): Map<string, string> {
  const parentOf = new Map<string, { base: string; parent: string }>();
  for (const mount of mounts) {
    if (mount.childKey) {
      parentOf.set(mount.childKey, {
        base: mount.base,
        parent: mount.parentKey,
      });
    }
  }
  const cache = new Map<string, string>();
  const resolve = (app: string, seen: Set<string>): string => {
    const cached = cache.get(app);
    if (cached !== undefined) return cached;
    const entry = parentOf.get(app);
    if (!entry || seen.has(app)) return "";
    seen.add(app);
    const prefix = joinPaths(resolve(entry.parent, seen), entry.base);
    cache.set(app, prefix);
    return prefix;
  };
  for (const child of parentOf.keys()) resolve(child, new Set());
  return cache;
}

// ---------------------------------------------------------------------------
// Emission
// ---------------------------------------------------------------------------

function emitApps(
  state: HonoIndexState,
  apps: Map<string, HonoApp>,
  usedAppKeys: Set<string>,
): void {
  for (const app of apps.values()) {
    if (!usedAppKeys.has(app.key)) continue;
    const id = appFactId(app.location.file, app.key);
    state.facts.set(id, {
      id,
      kind: "fact",
      name: `Hono app: ${app.name}`,
      factKind: "entrypoint",
      value: { framework: HONO_FRAMEWORK, identifier: app.name },
      source: factSource(RULE.app, false),
      confidence: CONFIDENCE.app,
      locations: [app.location],
    });
  }
}

function emitMounts(
  state: HonoIndexState,
  file: TsJsSourceFile,
  apps: Map<string, HonoApp>,
  mounts: RawMount[],
): void {
  for (const mount of mounts) {
    const parent = apps.get(mount.parentKey);
    if (!parent) continue;
    if (!mount.childKey) {
      addDiagnostic(state, {
        id: semanticId(
          "diagnostic",
          `${HONO_PLUGIN_ID}:mount-cross-file:${file.path}:${mount.location.startLine}`,
        ),
        severity: "info",
        message:
          `Hono sub-app mounted at "${mount.base}" is not resolvable in "${file.path}"; ` +
          `cross-file route composition is a follow-up.`,
        source: factSource(RULE.mount, true),
        locations: [mount.location],
      });
      continue;
    }
    const child = apps.get(mount.childKey);
    if (!child) continue;
    const parentId = appFactId(parent.location.file, parent.key);
    const childId = appFactId(child.location.file, child.key);
    addEdge(state, {
      id: edgeSemanticId("mounts", parentId, childId),
      type: "mounts",
      sourceId: parentId,
      targetId: childId,
      source: factSource(RULE.mount, false),
      confidence: CONFIDENCE.mount,
      label: mount.base,
      locations: [mount.location],
    });
  }
}

function emitRoutes(
  state: HonoIndexState,
  file: TsJsSourceFile,
  sourceFile: ts.SourceFile,
  rawRoutes: RawRoute[],
  rawMiddleware: RawMiddleware[],
  prefixes: Map<string, string>,
  symbolNames: Set<string>,
  funcDecls: Map<string, ts.SignatureDeclaration>,
): void {
  for (const raw of rawRoutes) {
    const prefix = prefixes.get(raw.appKey) ?? "";
    const finalPath = raw.pathIsLiteral
      ? joinPaths(prefix, raw.rawPath)
      : raw.rawPath;
    const mountPath = prefix !== "" ? prefix : undefined;
    const routeId = routeSemanticId(raw.method, finalPath);
    const appFact = appFactId(file.path, raw.appKey);

    const handlerIds: string[] = [];
    for (let i = 0; i < raw.handlerArgs.length; i++) {
      const arg = raw.handlerArgs[i];
      if (!arg) continue;
      const handler = upsertHandler(
        state,
        file,
        sourceFile,
        arg,
        routeId,
        `${raw.method}:${finalPath}:${i}`,
        symbolNames,
        funcDecls,
      );
      handlerIds.push(handler);
      addEdge(state, {
        id: edgeSemanticId("routes-to", routeId, handler),
        type: "routes-to",
        sourceId: routeId,
        targetId: handler,
        source: factSource(RULE.routesTo, false),
        confidence: CONFIDENCE.edge,
        locations: [raw.location],
      });
    }

    const middlewareIds: string[] = [];
    for (const mw of rawMiddleware) {
      if (mw.appKey !== raw.appKey) continue;
      if (!prefixMatches(mw.prefix, raw.rawPath)) continue;
      const mwId = upsertMiddleware(
        state,
        file,
        mw,
        routeId,
        symbolNames,
        funcDecls,
      );
      middlewareIds.push(mwId);
      addEdge(state, {
        id: edgeSemanticId("uses-middleware", routeId, mwId),
        type: "uses-middleware",
        sourceId: routeId,
        targetId: mwId,
        source: factSource(RULE.usesMiddleware, !mw.prefixIsLiteral),
        confidence: CONFIDENCE.edge,
        locations: [mw.location],
      });
    }

    if (!raw.pathIsLiteral) {
      addDiagnostic(state, {
        id: semanticId(
          "diagnostic",
          `${HONO_PLUGIN_ID}:dynamic-path:${file.path}:${raw.location.startLine}`,
        ),
        severity: "info",
        message:
          `Hono route ${raw.method} on a non-literal path in "${file.path}" ` +
          `was indexed with reduced confidence.`,
        source: factSource(RULE.route, true),
        locations: [raw.location],
      });
    }

    upsertRoute(state, {
      id: routeId,
      method: raw.method,
      path: finalPath,
      mountPath,
      handlerIds,
      middlewareIds,
      inferred: !raw.pathIsLiteral,
      location: raw.location,
      appFact,
    });
  }
}

interface RouteUpsert {
  id: string;
  method: string;
  path: string;
  mountPath: string | undefined;
  handlerIds: string[];
  middlewareIds: string[];
  inferred: boolean;
  location: SourceLocation;
  appFact: string;
}

function upsertRoute(state: HonoIndexState, spec: RouteUpsert): void {
  const existing = state.routes.get(spec.id);
  if (existing) {
    existing.handlerIds = unionSorted(existing.handlerIds, spec.handlerIds);
    existing.middlewareIds = unionSorted(
      existing.middlewareIds,
      spec.middlewareIds,
    );
    existing.locations = mergeLocations(existing.locations, [spec.location]);
    return;
  }
  const route: RouteSemantic = {
    id: spec.id,
    kind: "route",
    name: `${spec.method} ${spec.path}`,
    method: spec.method,
    path: spec.path,
    framework: HONO_FRAMEWORK,
    pathSyntax: HONO_PATH_SYNTAX,
    handlerIds: [...spec.handlerIds].toSorted(),
    middlewareIds: [...spec.middlewareIds].toSorted(),
    ...(spec.mountPath ? { mountPath: spec.mountPath } : {}),
    source: factSource(RULE.route, spec.inferred),
    confidence: spec.inferred
      ? CONFIDENCE.routeDynamic
      : CONFIDENCE.routeLiteral,
    locations: [spec.location],
  };
  state.routes.set(spec.id, route);
  addEdge(state, {
    id: edgeSemanticId("defines", spec.appFact, spec.id),
    type: "defines",
    sourceId: spec.appFact,
    targetId: spec.id,
    source: factSource(RULE.defines, false),
    confidence: CONFIDENCE.edge,
    locations: [spec.location],
  });
}

function upsertHandler(
  state: HonoIndexState,
  file: TsJsSourceFile,
  sourceFile: ts.SourceFile,
  arg: ts.Expression,
  routeId: string,
  inlineKey: string,
  symbolNames: Set<string>,
  funcDecls: Map<string, ts.SignatureDeclaration>,
): string {
  const expr = unwrapParen(arg);

  if (ts.isIdentifier(expr)) {
    const name = expr.text;
    const id = semanticId("handler", `${file.path}#${name}`);
    const resolvedInFile = symbolNames.has(name);
    const symbolId = resolvedInFile
      ? symbolSemanticId(file.path, name)
      : undefined;
    const abi = abiFrom(funcDecls.get(name), `${file.path}#${name}`);
    upsertHandlerNode(state, {
      id,
      name,
      language: file.language,
      abi,
      symbolId,
      routeId,
      inferred: !resolvedInFile,
      confidence: resolvedInFile
        ? CONFIDENCE.handler
        : CONFIDENCE.handlerInferred,
      location: locationOf(file, sourceFile, expr),
    });
    if (!resolvedInFile) {
      addDiagnostic(state, {
        id: semanticId(
          "diagnostic",
          `${HONO_PLUGIN_ID}:handler-unresolved:${file.path}#${name}`,
        ),
        severity: "info",
        message:
          `Hono handler "${name}" in "${file.path}" is not defined in-file ` +
          `(imported?); cross-file symbol linkage is a follow-up.`,
        source: factSource(RULE.handler, true),
        locations: [locationOf(file, sourceFile, expr)],
      });
    }
    return id;
  }

  if (isArrowOrFunctionExpression(expr)) {
    const location = locationOf(file, sourceFile, expr);
    const id = semanticId(
      "handler",
      `${file.path}@${location.startLine}:${location.startColumn}`,
    );
    upsertHandlerNode(state, {
      id,
      name: "inline handler",
      language: file.language,
      abi: abiFrom(expr, `${file.path}@${location.startLine}`),
      symbolId: undefined,
      routeId,
      inferred: false,
      confidence: CONFIDENCE.handler,
      location,
    });
    return id;
  }

  // Spread, call, or member-access handler expression — recognized but not
  // fully resolvable. Emit an inferred node + diagnostic rather than dropping.
  const location = locationOf(file, sourceFile, arg);
  const id = semanticId(
    "handler",
    `${file.path}@${location.startLine}:${location.startColumn}:${inlineKey}`,
  );
  upsertHandlerNode(state, {
    id,
    name: "inferred handler",
    language: file.language,
    abi: defaultAbi(`${file.path}@${location.startLine}:${inlineKey}`),
    symbolId: undefined,
    routeId,
    inferred: true,
    confidence: CONFIDENCE.handlerInferred,
    location,
  });
  addDiagnostic(state, {
    id: semanticId(
      "diagnostic",
      `${HONO_PLUGIN_ID}:handler-complex:${file.path}:${location.startLine}:${location.startColumn}`,
    ),
    severity: "info",
    message:
      `Hono handler argument in "${file.path}" (${ts.SyntaxKind[arg.kind]}) ` +
      `could not be fully resolved; indexed with reduced confidence.`,
    source: factSource(RULE.handler, true),
    locations: [location],
  });
  return id;
}

interface HandlerNodeSpec {
  id: string;
  name: string;
  language: SourceLanguage;
  abi: HandlerAbiSemantic;
  symbolId: string | undefined;
  routeId: string;
  inferred: boolean;
  confidence: number;
  location: SourceLocation;
}

function upsertHandlerNode(state: HonoIndexState, spec: HandlerNodeSpec): void {
  const existing = state.handlers.get(spec.id);
  if (existing) {
    existing.routeIds = unionSorted(existing.routeIds, [spec.routeId]);
    existing.confidence = Math.max(existing.confidence, spec.confidence);
    existing.locations = mergeLocations(existing.locations, [spec.location]);
    return;
  }
  state.handlers.set(spec.id, {
    id: spec.id,
    kind: "handler",
    name: spec.name,
    framework: HONO_FRAMEWORK,
    language: spec.language,
    abi: spec.abi,
    ...(spec.symbolId ? { symbolId: spec.symbolId } : {}),
    routeIds: [spec.routeId],
    source: factSource(RULE.handler, spec.inferred),
    confidence: spec.confidence,
    locations: [spec.location],
  });
}

function upsertMiddleware(
  state: HonoIndexState,
  file: TsJsSourceFile,
  mw: RawMiddleware,
  routeId: string,
  symbolNames: Set<string>,
  funcDecls: Map<string, ts.SignatureDeclaration>,
): string {
  // A single `app.use(...)` may register several middleware handlers; use the
  // first for the node identity and record the rest as extra locations.
  const primary = mw.handlerArgs[0];
  const expr = primary ? unwrapParen(primary) : undefined;

  if (expr && ts.isIdentifier(expr)) {
    const name = expr.text;
    const id = semanticId("middleware", `${file.path}#${name}`);
    const resolvedInFile = symbolNames.has(name);
    upsertMiddlewareNode(state, {
      id,
      name,
      language: file.language,
      abi: abiFrom(funcDecls.get(name), `${file.path}#${name}`),
      symbolId: resolvedInFile ? symbolSemanticId(file.path, name) : undefined,
      routeId,
      inferred: !resolvedInFile,
      confidence: resolvedInFile
        ? CONFIDENCE.middleware
        : CONFIDENCE.middlewareInferred,
      location: mw.location,
    });
    return id;
  }

  if (expr && isArrowOrFunctionExpression(expr)) {
    const id = semanticId(
      "middleware",
      `${file.path}@${mw.location.startLine}:${mw.location.startColumn}`,
    );
    upsertMiddlewareNode(state, {
      id,
      name: "inline middleware",
      language: file.language,
      abi: abiFrom(expr, `${file.path}@${mw.location.startLine}`),
      symbolId: undefined,
      routeId,
      inferred: false,
      confidence: CONFIDENCE.middleware,
      location: mw.location,
    });
    return id;
  }

  const id = semanticId(
    "middleware",
    `${file.path}@${mw.location.startLine}:${mw.location.startColumn}`,
  );
  upsertMiddlewareNode(state, {
    id,
    name: "inferred middleware",
    language: file.language,
    abi: defaultAbi(`${file.path}@${mw.location.startLine}:mw`),
    symbolId: undefined,
    routeId,
    inferred: true,
    confidence: CONFIDENCE.middlewareInferred,
    location: mw.location,
  });
  return id;
}

interface MiddlewareNodeSpec {
  id: string;
  name: string;
  language: SourceLanguage;
  abi: HandlerAbiSemantic;
  symbolId: string | undefined;
  routeId: string;
  inferred: boolean;
  confidence: number;
  location: SourceLocation;
}

function upsertMiddlewareNode(
  state: HonoIndexState,
  spec: MiddlewareNodeSpec,
): void {
  const existing = state.middleware.get(spec.id);
  if (existing) {
    existing.routeIds = unionSorted(existing.routeIds, [spec.routeId]);
    existing.confidence = Math.max(existing.confidence, spec.confidence);
    existing.locations = mergeLocations(existing.locations, [spec.location]);
    return;
  }
  state.middleware.set(spec.id, {
    id: spec.id,
    kind: "middleware",
    name: spec.name,
    framework: HONO_FRAMEWORK,
    language: spec.language,
    abi: spec.abi,
    ...(spec.symbolId ? { symbolId: spec.symbolId } : {}),
    routeIds: [spec.routeId],
    source: factSource(RULE.middleware, spec.inferred),
    confidence: spec.confidence,
    locations: [spec.location],
  });
}

// ---------------------------------------------------------------------------
// ABI extraction
// ---------------------------------------------------------------------------

function abiFrom(
  decl: ts.SignatureDeclaration | undefined,
  key: string,
): HandlerAbiSemantic {
  if (!decl) return defaultAbi(key);
  const first = decl.parameters[0];
  const name = first && ts.isIdentifier(first.name)
    ? first.name.text
    : DEFAULT_CONTEXT_PARAM;
  return {
    id: semanticId("abi", key),
    params: [contextParam(name)],
    responseStyle: HONO_RESPONSE_STYLE,
  };
}

function defaultAbi(key: string): HandlerAbiSemantic {
  return {
    id: semanticId("abi", key),
    params: [contextParam(DEFAULT_CONTEXT_PARAM)],
    responseStyle: HONO_RESPONSE_STYLE,
  };
}

function contextParam(name: string): HandlerParamSemantic {
  return { name, role: "context" };
}

// ---------------------------------------------------------------------------
// Path utilities
// ---------------------------------------------------------------------------

function joinPaths(base: string, sub: string): string {
  const left = base.replace(/\/+$/, "");
  const right = sub.startsWith("/") ? sub : `/${sub}`;
  const joined = `${left}${right}`.replace(/\/{2,}/g, "/");
  return joined === "" ? "/" : joined;
}

function normalizeBase(base: string): string {
  const trimmed = base.replace(/\/+$/, "");
  return trimmed === "" ? "/" : trimmed;
}

/**
 * Middleware match heuristic: a prefix P covers route path R (as registered on
 * the same app) when P is empty ("*"/no-path use → all routes), or R equals P,
 * or R sits under P (`R === P` / `R startsWith P + "/"`). Matching uses the
 * route's app-relative path, not its mount-composed path, mirroring how Hono
 * applies middleware relative to the app it's registered on.
 */
function prefixMatches(prefix: string, routePath: string): boolean {
  if (prefix === "") return true;
  if (routePath === prefix) return true;
  return routePath.startsWith(`${prefix}/`);
}

/** Turn a Hono `use` path pattern ("/api/*", "/api", "*") into a plain prefix. */
function normalizePrefix(pattern: string): string {
  const withoutWildcard = pattern.replace(/\/?\*+$/, "");
  const trimmed = withoutWildcard.replace(/\/+$/, "");
  return trimmed;
}

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

function unwrapParen(expr: ts.Expression): ts.Expression {
  let node = expr;
  while (ts.isParenthesizedExpression(node)) node = node.expression;
  return node;
}

function isArrowOrFunctionExpression(
  node: ts.Node,
): node is ts.ArrowFunction | ts.FunctionExpression {
  return ts.isArrowFunction(node) || ts.isFunctionExpression(node);
}

function literalString(node: ts.Expression | undefined): string | null {
  if (!node) return null;
  const expr = unwrapParen(node);
  if (ts.isStringLiteral(expr)) return expr.text;
  if (ts.isNoSubstitutionTemplateLiteral(expr)) return expr.text;
  return null;
}

function isStringLike(node: ts.Expression): boolean {
  const expr = unwrapParen(node);
  return ts.isStringLiteral(expr) ||
    ts.isNoSubstitutionTemplateLiteral(expr) ||
    ts.isTemplateExpression(expr);
}

function scriptKindForLanguage(language: SourceLanguage): ts.ScriptKind {
  switch (language) {
    case "tsx":
      return ts.ScriptKind.TSX;
    case "jsx":
      return ts.ScriptKind.JSX;
    case "javascript":
      return ts.ScriptKind.JS;
    case "typescript":
      return ts.ScriptKind.TS;
    default:
      return ts.ScriptKind.Unknown;
  }
}

function locationOf(
  file: TsJsSourceFile,
  sourceFile: ts.SourceFile,
  node: ts.Node,
): SourceLocation {
  const start = sourceFile.getLineAndCharacterOfPosition(
    node.getStart(sourceFile),
  );
  const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
  return {
    file: file.path,
    startLine: start.line + 1,
    startColumn: start.character + 1,
    endLine: end.line + 1,
    endColumn: end.character + 1,
  };
}

function appFactId(file: string, key: string): string {
  return semanticId("fact", `hono-app:${file}#${key}`);
}

function factSource(ruleId: string, inferred: boolean): FactSource {
  return { pluginId: HONO_PLUGIN_ID, ruleId, method: "ast", inferred };
}

function addEdge(state: HonoIndexState, edge: SemanticEdge): void {
  const existing = state.edges.get(edge.id);
  if (!existing) {
    state.edges.set(edge.id, edge);
    return;
  }
  existing.confidence = Math.max(existing.confidence, edge.confidence);
  existing.locations = mergeLocations(
    existing.locations ?? [],
    edge.locations ?? [],
  );
}

function addDiagnostic(
  state: HonoIndexState,
  diagnostic: SemanticDiagnostic,
): void {
  if (!state.diagnostics.has(diagnostic.id)) {
    state.diagnostics.set(diagnostic.id, diagnostic);
  }
}

function addFileErrorDiagnostic(
  state: HonoIndexState,
  file: TsJsSourceFile,
  err: unknown,
): void {
  const id = semanticId(
    "diagnostic",
    `${HONO_PLUGIN_ID}:file-error:${file.path}`,
  );
  addDiagnostic(state, {
    id,
    severity: "warning",
    message: `Hono plugin failed to index "${file.path}": ${
      err instanceof Error ? err.message : String(err)
    }`,
    source: factSource(RULE.route, false),
    locations: [{ file: file.path, startLine: 1, startColumn: 1 }],
  });
}

function unionSorted(a: string[], b: string[]): string[] {
  return [...new Set([...a, ...b])].toSorted();
}

function mergeLocations(
  a: SourceLocation[],
  b: SourceLocation[],
): SourceLocation[] {
  const byKey = new Map<string, SourceLocation>();
  for (const location of [...a, ...b]) {
    const key = [
      location.file,
      location.startLine,
      location.startColumn,
      location.endLine ?? "",
      location.endColumn ?? "",
    ].join(":");
    byKey.set(key, location);
  }
  return [...byKey.values()].toSorted((x, y) =>
    x.file.localeCompare(y.file) ||
    x.startLine - y.startLine ||
    x.startColumn - y.startColumn
  );
}

function sortById<T extends { id: string }>(items: T[]): T[] {
  return items.toSorted((a, b) => a.id.localeCompare(b.id));
}
