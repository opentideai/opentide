// @layer core — L1. Stream B / B1a: the entity-grain knowledge graph. A queryable
// view over the entity call/dependency topology, with a REVERSE index the raw
// extractor lacks — so "what depends on X" (blast radius) and per-entity degrees
// become O(1)-ish lookups instead of a fresh whole-project scan per question.
//
// This is a CONSOLIDATION, not new extraction (plan §1, §2 S2): it wraps the
// existing `extractCallGraph` (core/analysis.ts) — the same regex-derived call graph
// that already backs GET /api/analysis/call-graph and find_dead_code — and adds:
//   1. forward + REVERSE adjacency (the reverse index is the genuinely new capability),
//   2. entityUid keying (A2), so callers holding a uid can ask for its metrics,
//   3. transitive blast-radius (reverse reachability), cycle-safe.
//
// The graph is a DERIVED PROJECTION of current registry source — always re-derivable,
// never authored, so it cannot drift from the code (plan §2 S2). No persistence in
// B1 v1 (plan §2 S4): callers recompute per need; at these project sizes a build is
// cheap. Test→subject (`tested-by`) edges are a deferred B1a follow-up — tests are
// simply not graph nodes yet (additive, accrue-forward).
//
// Node category == the call-graph node type (route/handler/function/config/template/
// schema), which is 1:1 with ChangeCategory. Routes and schemas have no `entityUid`
// (A2 scope), so `metricsForUid` covers only uid-bearing entities; every node is
// still reachable by (category, name).

import { extractCallGraph } from "./analysis.ts";
import type { CallGraphNode } from "./analysis.ts";
import type { Kernel } from "./registries.ts";

export interface EntityGraphMetrics {
  inDegree: number; // distinct entities that reference this one (direct)
  outDegree: number; // distinct entities this one references (direct)
  dependentCount: number; // transitive reverse reach — the blast-radius size
}

export interface GraphNodeRef {
  category: string;
  name: string;
  entityUid: string | null; // null for routes/schemas and referenced-but-unregistered nodes
}

export interface KnowledgeGraph {
  readonly nodeCount: number;
  readonly edgeCount: number;
  metricsFor(category: string, name: string): EntityGraphMetrics | null;
  metricsForUid(entityUid: string): EntityGraphMetrics | null;
  dependentsOf(category: string, name: string): GraphNodeRef[]; // direct reverse edges
  blastRadius(category: string, name: string): GraphNodeRef[]; // transitive reverse closure
}

function nodeId(category: string, name: string): string {
  return `${category}:${name}`;
}

// B1c: the blast-radius projection the API route and the `blast_radius` agent tool
// both return — one shape, one source, so the two can never diverge. `direct` =
// entities that reference the target directly; `transitive` = the full reverse
// closure (everything that would be affected by changing it). Zero/unknown is a
// first-class answer: an unknown or non-graph-node entity yields empty arrays and
// zero counts (a leaf legitimately affects nothing) — never an error. Read-only:
// this only queries the derived graph, it never mutates.
export interface BlastRadiusReport {
  direct: GraphNodeRef[];
  transitive: GraphNodeRef[];
  counts: { direct: number; transitive: number };
}

export function blastRadiusReport(
  graph: KnowledgeGraph,
  category: string,
  name: string,
): BlastRadiusReport {
  const direct = graph.dependentsOf(category, name);
  const transitive = graph.blastRadius(category, name);
  return {
    direct,
    transitive,
    counts: { direct: direct.length, transitive: transitive.length },
  };
}

export function buildKnowledgeGraph(kernel: Kernel): KnowledgeGraph {
  const cg = extractCallGraph(kernel);

  const nodeById = new Map<string, CallGraphNode>();
  for (const n of cg.nodes) nodeById.set(n.id, n);

  // Distinct-neighbor adjacency: Sets so degrees count distinct related entities,
  // not parallel edges of different kinds (a caller that both `calls` and `reads`
  // another entity is one dependency, not two).
  const forward = new Map<string, Set<string>>();
  const reverse = new Map<string, Set<string>>();
  for (const id of nodeById.keys()) {
    forward.set(id, new Set());
    reverse.set(id, new Set());
  }
  for (const e of cg.edges) {
    forward.get(e.source)?.add(e.target);
    reverse.get(e.target)?.add(e.source);
  }

  // Resolve each node's entityUid once (A2). undefined ⇒ null (routes, schemas, and
  // referenced-but-unregistered externals have no uid — never guessed).
  const uidByNode = new Map<string, string | null>();
  const nodeByUid = new Map<string, string>();
  for (const n of cg.nodes) {
    const uid = kernel.entityUidFor(n.type, n.name) ?? null;
    uidByNode.set(n.id, uid);
    if (uid) nodeByUid.set(uid, n.id);
  }

  function refFor(id: string): GraphNodeRef {
    const n = nodeById.get(id)!;
    return {
      category: n.type,
      name: n.name,
      entityUid: uidByNode.get(id) ?? null,
    };
  }

  // Everything reachable UP the reverse edges from `startId` (its transitive
  // dependents), excluding itself. Cycle-safe via the visited set.
  function transitiveReverse(startId: string): Set<string> {
    const seen = new Set<string>();
    const stack = [...(reverse.get(startId) ?? [])];
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (id === startId || seen.has(id)) continue;
      seen.add(id);
      for (const up of reverse.get(id) ?? []) {
        if (up !== startId && !seen.has(up)) stack.push(up);
      }
    }
    return seen;
  }

  function metricsForId(id: string): EntityGraphMetrics | null {
    if (!nodeById.has(id)) return null;
    return {
      inDegree: reverse.get(id)?.size ?? 0,
      outDegree: forward.get(id)?.size ?? 0,
      dependentCount: transitiveReverse(id).size,
    };
  }

  return {
    nodeCount: nodeById.size,
    edgeCount: cg.edges.length,
    metricsFor(category, name) {
      return metricsForId(nodeId(category, name));
    },
    metricsForUid(entityUid) {
      const id = nodeByUid.get(entityUid);
      return id ? metricsForId(id) : null;
    },
    dependentsOf(category, name) {
      const id = nodeId(category, name);
      if (!nodeById.has(id)) return [];
      return [...(reverse.get(id) ?? [])].map(refFor);
    },
    blastRadius(category, name) {
      const id = nodeId(category, name);
      if (!nodeById.has(id)) return [];
      return [...transitiveReverse(id)].map(refFor);
    },
  };
}
