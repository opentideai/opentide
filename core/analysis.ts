import type { Kernel } from "./registries.ts";
import { APP_AUTH_GATE_CONFIG } from "./config.ts";
import { sortRoutes } from "./types.ts";

export interface CallGraphNode {
  id: string;
  type: "route" | "handler" | "function" | "config" | "template" | "schema";
  name: string;
  label: string;
  metadata: Record<string, unknown>;
}

export interface CallGraphEdge {
  source: string;
  target: string;
  type: "routes" | "calls" | "reads" | "writes" | "renders" | "queries";
}

export interface CallGraph {
  nodes: CallGraphNode[];
  edges: CallGraphEdge[];
}

function nodeId(type: string, name: string): string {
  return `${type}:${name}`;
}

function extractStringMatches(source: string, re: RegExp): string[] {
  const results: string[] = [];
  const seen = new Set<string>();
  for (const m of source.matchAll(re)) {
    const name = m[1]!;
    if (!seen.has(name)) {
      seen.add(name);
      results.push(name);
    }
  }
  return results;
}

const DB_SQL_RE = /db\s*\.\s*(?:query|execute)\s*\(\s*["'`]([^"'`]*)["'`]/g;
const SQL_TABLE_RE =
  /(?:FROM|INTO|UPDATE|JOIN|TABLE)\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?["'`]?(\w+)["'`]?/gi;
const DB_TABLES_DOT_RE = /db\s*\.\s*tables\s*\.\s*(\w+)/g;
const DB_TABLES_DESTRUCTURE_RE =
  /(?:const|let|var)\s*\{([^}]+)\}\s*=\s*db\s*\.\s*tables/g;

function extractTableNames(source: string): string[] {
  const tables = new Set<string>();

  // Raw SQL in db.query() / db.execute()
  for (const m of source.matchAll(DB_SQL_RE)) {
    const sql = m[1]!;
    for (const tm of sql.matchAll(SQL_TABLE_RE)) {
      const name = tm[1]!.toLowerCase();
      if (name !== "if" && name !== "not" && name !== "exists") {
        tables.add(name);
      }
    }
  }

  // Drizzle ORM: db.tables.tableName
  for (const m of source.matchAll(DB_TABLES_DOT_RE)) {
    tables.add(m[1]!.toLowerCase());
  }

  // Drizzle ORM: const { table1, table2 } = db.tables
  for (const m of source.matchAll(DB_TABLES_DESTRUCTURE_RE)) {
    for (const part of m[1]!.split(",")) {
      const name = part.split(":")[0]!.trim();
      if (name) tables.add(name.toLowerCase());
    }
  }

  return [...tables];
}

// One out-edge a source string implies: the target call-graph node it references
// and the edge kind. The single home for the regex vocabulary — both graph building
// (analyzeSource) and per-entity out-edge diffing (extractOutEdges) derive from here,
// so the two can never drift (DRY).
interface SourceOutEdge {
  targetId: string;
  targetType: CallGraphNode["type"];
  targetName: string;
  kind: CallGraphEdge["type"];
}

function extractSourceOutEdges(source: string): SourceOutEdge[] {
  const out: SourceOutEdge[] = [];
  const fn = (name: string, kind: CallGraphEdge["type"]): void => {
    out.push({
      targetId: nodeId("function", name),
      targetType: "function",
      targetName: name,
      kind,
    });
  };

  for (
    const name of extractStringMatches(
      source,
      /functions\s*\.\s*call\s*\(\s*["'`]([^"'`]+)["'`]/g,
    )
  ) {
    fn(name, "calls");
  }
  for (
    const name of extractStringMatches(
      source,
      /functions\s*\.\s*get\s*\(\s*["'`]([^"'`]+)["'`]/g,
    )
  ) {
    fn(name, "calls");
  }
  for (
    const key of extractStringMatches(
      source,
      /config\s*\.\s*get\s*\(\s*["'`]([^"'`]+)["'`]/g,
    )
  ) {
    if (key.startsWith("_genie_")) continue;
    out.push({
      targetId: nodeId("config", key),
      targetType: "config",
      targetName: key,
      kind: "reads",
    });
  }
  for (
    const key of extractStringMatches(
      source,
      /config\s*\.\s*(?:set|delete)\s*\(\s*["'`]([^"'`]+)["'`]/g,
    )
  ) {
    if (key.startsWith("_genie_")) continue;
    out.push({
      targetId: nodeId("config", key),
      targetType: "config",
      targetName: key,
      kind: "writes",
    });
  }
  for (
    const tpl of extractStringMatches(
      source,
      /templates\s*\.\s*get\s*\(\s*["'`]([^"'`]+)["'`]/g,
    )
  ) {
    out.push({
      targetId: nodeId("template", tpl),
      targetType: "template",
      targetName: tpl,
      kind: "renders",
    });
  }
  for (const table of extractTableNames(source)) {
    out.push({
      targetId: nodeId("schema", table),
      targetType: "schema",
      targetName: table,
      kind: "queries",
    });
  }
  return out;
}

// The DISTINCT set of `type:name` target ids a source references — the entity's
// out-edge fingerprint. Used by B1b to compute an episode's `edgeDelta` as the
// symmetric difference between the before- and after-source fingerprints. Pure over
// a single source string: no kernel, no graph, so it is honest even for entities
// that are not call-graph nodes (e.g. tests). Distinct because a caller that both
// `calls` and `reads` a target still depends on it once.
export function extractOutEdges(source: string): Set<string> {
  return new Set(extractSourceOutEdges(source).map((e) => e.targetId));
}

function analyzeSource(
  source: string,
  sourceId: string,
  nodes: Map<string, CallGraphNode>,
  edges: CallGraphEdge[],
): void {
  for (const e of extractSourceOutEdges(source)) {
    if (!nodes.has(e.targetId)) {
      nodes.set(e.targetId, {
        id: e.targetId,
        type: e.targetType,
        name: e.targetName,
        label: e.targetName,
        metadata: e.targetType === "function" ? { external: true } : {},
      });
    }
    edges.push({ source: sourceId, target: e.targetId, type: e.kind });
  }
}

export interface DeadCodeItem {
  type: "handler" | "function" | "config" | "template" | "schema";
  name: string;
  reason: string;
}

// Who still references this function, as `kind:name` labels. The removal verbs
// use this to refuse a delete that would strand a caller, so it deliberately
// covers tests as well as handlers and functions: a test is a call site the call
// graph has no node for, and deleting a function out from under one is exactly
// the mistake the dead-code report used to invite.
export function findFunctionCallers(kernel: Kernel, name: string): string[] {
  const callers: string[] = [];
  const references = (source: string): boolean =>
    extractSourceOutEdges(source).some((edge) =>
      edge.targetType === "function" && edge.targetName === name
    );

  for (const handler of kernel.handlers.list()) {
    if (references(handler.source)) callers.push(`handler:${handler.name}`);
  }
  for (const fn of kernel.functions.list()) {
    // A function calling itself is recursion, not a dependency that survives it.
    if (fn.name === name) continue;
    if (references(fn.source)) callers.push(`function:${fn.name}`);
  }
  for (const test of kernel.tests.list()) {
    if (references(test.source)) callers.push(`test:${test.name}`);
  }
  return callers;
}

export function findDeadCode(kernel: Kernel): DeadCodeItem[] {
  const graph = extractCallGraph(kernel);
  const inbound = new Set<string>();
  for (const edge of graph.edges) {
    inbound.add(edge.target);
  }

  // Tests are call sites too. They are deliberately NOT nodes in the call graph —
  // nothing routes to a test, so giving them nodes would report every test as
  // dead — but a function a test exercises is emphatically not dead, and saying
  // so invites a cleanup that takes the test down with it. Counting their
  // out-edges as inbound references fixes the report without changing the graph
  // every other consumer reads.
  for (const test of kernel.tests.list()) {
    for (const edge of extractSourceOutEdges(test.source)) {
      inbound.add(edge.targetId);
    }
  }

  // The auth gate is called by the kernel, not by a route, and its config is read by
  // the kernel, not by app code. Both are live while the config names a handler.
  const gate = kernel.configs.get(APP_AUTH_GATE_CONFIG);
  if (typeof gate === "string" && gate !== "") {
    inbound.add(nodeId("config", APP_AUTH_GATE_CONFIG));
    inbound.add(nodeId("handler", gate));
  }

  const dead: DeadCodeItem[] = [];

  for (const node of graph.nodes) {
    if (node.type === "route") continue;
    if (inbound.has(node.id)) continue;
    if (node.type === "handler") {
      dead.push({
        type: "handler",
        name: node.name,
        reason: "No route points to this handler",
      });
    } else if (node.type === "function") {
      dead.push({
        type: "function",
        name: node.name,
        reason: "No handler or function calls this function",
      });
    } else if (node.type === "config") {
      dead.push({
        type: "config",
        name: node.name,
        reason: "No handler or function reads this config",
      });
    } else if (node.type === "template") {
      dead.push({
        type: "template",
        name: node.name,
        reason: "No handler or function renders this template",
      });
    } else if (node.type === "schema") {
      dead.push({
        type: "schema",
        name: node.name,
        reason: "No handler or function queries this table",
      });
    }
  }

  return dead;
}

export function extractCallGraph(kernel: Kernel): CallGraph {
  const nodes = new Map<string, CallGraphNode>();
  const edges: CallGraphEdge[] = [];

  for (const route of sortRoutes(kernel.routes.list())) {
    const routeId = nodeId("route", `${route.method} ${route.path}`);
    nodes.set(routeId, {
      id: routeId,
      type: "route",
      name: `${route.method} ${route.path}`,
      label: `${route.method} ${route.path}`,
      metadata: {
        method: route.method,
        path: route.path,
        ...(route.module ? { module: route.module } : {}),
      },
    });

    const handlerId = nodeId("handler", route.handlerName);
    if (!nodes.has(handlerId)) {
      const h = kernel.handlers.get(route.handlerName);
      nodes.set(handlerId, {
        id: handlerId,
        type: "handler",
        name: route.handlerName,
        label: route.handlerName,
        metadata: {
          hasSource: !!h,
          ...(h?.module ? { module: h.module } : {}),
        },
      });
    }
    edges.push({ source: routeId, target: handlerId, type: "routes" });
  }

  for (const h of kernel.handlers.list()) {
    const hId = nodeId("handler", h.name);
    if (!nodes.has(hId)) {
      nodes.set(hId, {
        id: hId,
        type: "handler",
        name: h.name,
        label: h.name,
        metadata: { ...(h.module ? { module: h.module } : {}) },
      });
    }
    analyzeSource(h.source, hId, nodes, edges);
  }

  for (const f of kernel.functions.list()) {
    const fId = nodeId("function", f.name);
    if (!nodes.has(fId)) {
      nodes.set(fId, {
        id: fId,
        type: "function",
        name: f.name,
        label: f.name,
        metadata: { ...(f.module ? { module: f.module } : {}) },
      });
    } else {
      const existing = nodes.get(fId)!;
      delete existing.metadata.external;
    }
    analyzeSource(f.source, fId, nodes, edges);
  }

  for (const c of kernel.configs.list()) {
    if (c.name.startsWith("_genie_")) continue;
    const cId = nodeId("config", c.name);
    const existing = nodes.get(cId);
    if (existing) {
      existing.metadata.type = c.type;
      if (c.module) existing.metadata.module = c.module;
    } else {
      nodes.set(cId, {
        id: cId,
        type: "config",
        name: c.name,
        label: c.name,
        metadata: { type: c.type, ...(c.module ? { module: c.module } : {}) },
      });
    }
  }

  for (const t of kernel.templates.list()) {
    const tId = nodeId("template", t.name);
    if (!nodes.has(tId)) {
      nodes.set(tId, {
        id: tId,
        type: "template",
        name: t.name,
        label: t.name,
        metadata: { ...(t.module ? { module: t.module } : {}) },
      });
    }
  }

  const seen = new Set<string>();
  const uniqueEdges = edges.filter((e) => {
    const key = `${e.source}|${e.target}|${e.type}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return { nodes: [...nodes.values()], edges: uniqueEdges };
}
