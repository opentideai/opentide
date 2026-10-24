// @layer verification — pure Phase-8 cross-target route parity comparator for
// Milestone 4 (Slice 4.4). Given the per-route observations each target smoke gate
// retained (its RouteProbeResult[] from runRouteSmokeSubcheck), it asserts that
// every target answered each probed route the SAME way — the agreement check that
// turns the three independently-probed target gates into one parity gate.
//
// Why this exists on top of the per-target contract: each gate's
// checkRouteSmokeContract already validates its OWN boot (reachable → not-5xx →
// status equals the derived expectedStatus → JSON parses + sane content-type),
// but nothing compares a route's response ACROSS targets. A route that returns
// {"id":1} under Deno but {"id":"1"} under Node, or text/plain on one target and
// text/html on another, passes every per-target contract and ships green today.
//
// What parity actually contributes (and what is free):
//   - STATUS parity is implied for free — expectedStatus is derived from the ONE
//     shared plan (identical per target) and each target's contract already
//     asserts actualStatus === expectedStatus, so two passing targets trivially
//     agree on status. We assert it anyway: it is free and makes the guarantee
//     explicit against any future loosening of the per-target contract.
//   - CONTENT-TYPE parity is the first non-redundant contribution — the contract
//     only ever checks that a JSON-declared route's content-type CONTAINS
//     application/json, never equality, and never at all for non-JSON routes.
//   - BODY parity (deterministicBody routes) is the second — the contract only
//     checks the body parses, never compares body content across targets.
//
// It is a sibling of production-smoke.ts within the verification layer, so the
// RouteProbeResult import is intra-layer. checkOneRouteSmokeContract is reused so
// parity's comparable-route filter exactly matches the target route-smoke
// contract instead of drifting into a second definition.
import {
  checkOneRouteSmokeContract,
  type RouteProbeResult,
} from "./production-smoke.ts";

// One target's retained per-route observations: its identity (deno-source / node /
// binary) and the RouteProbeResult[] it produced. The comparator's first element
// is the BASELINE every other target is compared against — the orchestrator always
// inserts deno-source first (it always runs), so it is always the baseline.
export interface TargetRouteResults {
  target: string;
  results: readonly RouteProbeResult[];
}

// Normalize a content-type for comparison: lowercased + trimmed, null preserved.
// Cross-runtime header casing (e.g. `utf-8` vs `UTF-8`) is not semantic and is a
// known noise source, so parity compares the normalized form — the target is a
// payload/type divergence, not a casing one.
function normalizeContentType(contentType: string | null): string | null {
  return contentType === null ? null : contentType.trim().toLowerCase();
}

function routeKey(r: Pick<RouteProbeResult, "method" | "path">): string {
  return `${r.method} ${r.path}`;
}

function routePassed(r: RouteProbeResult): boolean {
  return checkOneRouteSmokeContract(r) === null;
}

// Keep only routes that were probed and passed the route-smoke contract on every
// participating target. Advisory route fixture failures and skipped routes are
// excluded from parity rather than being promoted into cross-target blockers.
export function comparableTargetRouteResults(
  observations: readonly TargetRouteResults[],
): TargetRouteResults[] {
  if (observations.length < 2) return observations.map((o) => ({ ...o }));

  const passedByTarget = observations.map((o) => {
    const passed = new Set<string>();
    for (const result of o.results) {
      if (routePassed(result)) passed.add(routeKey(result));
    }
    return passed;
  });
  const comparable = new Set(passedByTarget[0] ?? []);
  for (const passed of passedByTarget.slice(1)) {
    for (const key of [...comparable]) {
      if (!passed.has(key)) comparable.delete(key);
    }
  }

  return observations.map((o) => ({
    target: o.target,
    results: o.results.filter((r) => comparable.has(routeKey(r))),
  }));
}

// Compare every target's retained route observations against the baseline
// (observations[0]) and return the FIRST cross-target mismatch as an actionable
// message (naming the route, the field, and both target values), or null when
// every target agrees on every route. Pure, total, never throws, deterministic:
// routes are walked in the baseline's (plan-ordered) order and targets in the
// given order, so the same observations always yield the same first mismatch.
//
// Fewer than two targets → null (nothing to compare). Advisory-failed and skipped
// routes are filtered out first; for each remaining comparable baseline route and
// each non-baseline target, in order, it asserts agreement on:
//   (i)   actualStatus (free but explicit — see the module header),
//   (ii)  content-type, compared case-insensitively (normalizeContentType),
//   (iii) bodyHash, ONLY when non-null on both (i.e. a deterministicBody route
//         whose body was read on both targets) — a bare non-deterministic route
//         carries a null hash and is never body-compared.
export function compareTargetParity(
  observations: readonly TargetRouteResults[],
): string | null {
  if (observations.length < 2) return null;
  const comparable = comparableTargetRouteResults(observations);
  const baseline = comparable[0]!;
  const others = comparable.slice(1);

  for (const base of baseline.results) {
    const route = `${base.method} ${base.path}`;
    for (const other of others) {
      const match = other.results.find(
        (r) => r.method === base.method && r.path === base.path,
      );
      // (i) Presence.
      if (match === undefined) {
        return `${route} was probed on ${baseline.target} but not on ${other.target}.`;
      }
      // (ii) Status.
      if (match.actualStatus !== base.actualStatus) {
        return `${route} status differs: ${baseline.target} returned ${base.actualStatus}, ${other.target} returned ${match.actualStatus}.`;
      }
      // (iii) Content-type (case-insensitive).
      if (
        normalizeContentType(base.contentType) !==
          normalizeContentType(match.contentType)
      ) {
        return `${route} content-type differs: ${baseline.target} returned ${
          JSON.stringify(base.contentType)
        }, ${other.target} returned ${JSON.stringify(match.contentType)}.`;
      }
      // (iv) Body hash — only when both targets fingerprinted a body.
      if (
        base.bodyHash !== null && match.bodyHash !== null &&
        base.bodyHash !== match.bodyHash
      ) {
        return `${route} body differs (deterministicBody): ${baseline.target} vs ${other.target}.`;
      }
    }
  }
  return null;
}
