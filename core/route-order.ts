// @layer core — the canonical order a user app's route table resolves in.
//
// Both hosts that serve a user app resolve FIRST MATCH WINS (core/route-matcher.ts, and
// Hono before it), so the order of the table decides which handler an overlapping path
// reaches. Registries hand entries back in insertion order, which is whatever order the
// agent happened to write them in — stable for nobody and identical to nothing.
//
// The export has always sorted, because a reproducible build needs byte-identical
// output from identical kernel state. That sort is now the canonical one and the live
// preview adopts it, so a request reaches the same handler in the preview as it will in
// production. core/preview-export-parity_test.ts is the gate.
//
// NOTE what this order is NOT: specificity. `:` sorts below `n`, so `/items/:id` wins
// over `/items/new` however they were registered. That is the export's long-standing
// behaviour and changing it is a separate decision with its own blast radius — see
// docs/framework-free-handler-abi-plan.md. What this buys is that both hosts get it
// wrong in the same way, which is the difference between a bug a user can see in the
// preview and one that only appears after they ship.

/** Codepoint comparison, deliberately not localeCompare: locale-independent, so the
 * ordering is identical on every machine — the whole point of a reproducible build.
 * Route paths and entity names are ASCII, so this also matches A–Z. */
export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Method, then path, then handler — the last only to break a genuine tie. */
export function compareRouteKeys(
  a: { method: string; path: string; handlerName: string },
  b: { method: string; path: string; handlerName: string },
): number {
  return compareStrings(a.method, b.method) ||
    compareStrings(a.path, b.path) ||
    compareStrings(a.handlerName, b.handlerName);
}
