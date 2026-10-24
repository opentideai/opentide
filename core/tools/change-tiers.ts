// @layer core — PROPERTIES of the mutation surface, not policy. This module answers
// "what kind of surface does this verb / this change touch?"; it never answers "what
// should the governance gate do about it" — that decision lives one layer up, in
// verification/change-class.ts, exactly as save-risk.ts owns the LSP-save decision.
//
// The split matters mechanically, not just aesthetically: the changeset gate in
// dispatch.ts runs for EVERY mutation verb, and must not reach through a composition
// seam (verificationTools() throws in a core-only assembly). Keeping the property maps
// here lets that hot path stay a plain Set lookup with no seam and no throw risk.
//
// Sibling of MODIFICATION_TOOLS / isDestructiveTool in dispatch.ts — the same kind of
// knowledge, kept in the same layer for the same reason.
import type {
  ChangeAction,
  ChangeCategory,
  ChangeRecord,
} from "../changelog.ts";
import type { VerificationTier } from "../types.ts";

// Every change category, mapped to the ceremony tier a change to it demands. The
// `satisfies` gives compile-time totality: adding a ChangeCategory without deciding
// its tier is a type error, not a silent default.
//
// `light` is for surfaces that are recoverable and locally scoped. `standard` is for
// structural or irreversible ones — schema/sql (data migrations), route (URL topology
// other code depends on), secret/env_var (credentials), package (supply chain),
// branch/snapshot (project-wide state). The line is blast radius, not "is it code":
// handlers and functions ARE light-eligible, because a bad handler is caught by the
// tests and typecheck that still run for them and is one undo away.
export const CHANGE_CATEGORY_TIERS = {
  handler: "light",
  function: "light",
  template: "light",
  asset: "light",
  test: "light",
  type: "light",
  config: "light",
  dev_view: "light",
  dev_tool: "light",
  module: "light",
  route: "standard",
  schema: "standard",
  sql: "standard",
  secret: "standard",
  env_var: "standard",
  package: "standard",
  branch: "standard",
  snapshot: "standard",
  audit: "standard",
} as const satisfies Record<ChangeCategory, VerificationTier>;

// Categories whose DELETION is structural even though editing them is not. Removing a
// handler or function breaks every caller and every route bound to it, which is not
// the kind of change the light lane's synthesized single criterion can honestly cover.
const DELETE_IS_STANDARD: ReadonlySet<ChangeCategory> = new Set<ChangeCategory>(
  [
    "handler",
    "function",
    "type",
  ],
);

// Mutation verbs whose target is a light-tier surface. Derived from the same category
// mapping above, but keyed by TOOL NAME so the dispatch gate can decide before the
// change record exists (the gate runs before the mutation, which is the whole point —
// a declared-light changeset must be stopped at its first out-of-budget call, not
// audited afterwards).
//
// Delegating verbs are absent by design and handled by DELEGATING_TOOLS below.
export const LIGHT_TIER_TOOLS: ReadonlySet<string> = new Set([
  "define_handler",
  "define_function",
  "define_template",
  "delete_template",
  "define_test",
  "remove_test",
  "upload_asset",
  "upload_text_asset",
  "delete_asset",
  "define_type",
  "define_dev_view",
  "remove_dev_view",
  "define_dev_tool",
  "remove_dev_tool",
  "set_config",
  "delete_config",
  "apply_project_file",
  "write_project_file",
  "generate_project_docs",
  "document_write",
]);

// Verbs that do not mutate anything themselves — they resolve their target and then
// re-enter dispatch under the delegate's own name, which re-runs the whole gate. The
// INNER call is therefore the authoritative one, and classifying the outer call would
// be worse than useless: it would refuse `edit_entity_text` on a template inside a
// light changeset even though `define_template` (what it actually calls) is squarely
// in the lane. `isTierExempt` makes the gate defer instead of guess.
const DELEGATING_TOOLS: ReadonlySet<string> = new Set([
  "remove_entity",
  "edit_entity_text",
]);

export function isTierExempt(name: string): boolean {
  return DELEGATING_TOOLS.has(name);
}

// The tier a mutation verb demands. Unknown verbs are `standard` — an unmapped verb is
// one nobody has classified, and the safe reading of "unclassified" is "full ceremony".
// Delegating verbs answer `standard` too, but callers must consult isTierExempt first:
// their real answer is "ask the delegate".
export function mutationToolTier(name: string): VerificationTier {
  return LIGHT_TIER_TOOLS.has(name) ? "light" : "standard";
}

// The tier a recorded change demands, folding in the action: a delete of a code entity
// is standard even though editing it is light.
export function changeRecordTier(
  record: Pick<ChangeRecord, "category" | "action">,
): VerificationTier {
  if (record.action === "delete" && DELETE_IS_STANDARD.has(record.category)) {
    return "standard";
  }
  return CHANGE_CATEGORY_TIERS[record.category];
}

// The stricter of two tiers. Escalation is a fold over this: a changeset is only as
// light as its heaviest change.
export function maxTier(
  a: VerificationTier,
  b: VerificationTier,
): VerificationTier {
  return a === "standard" || b === "standard" ? "standard" : "light";
}

// The "category:key" scope string used to name an entity in readiness messages,
// refutation context and attestation scopes. One spelling, one place.
export function changeScope(
  record: Pick<ChangeRecord, "category" | "key">,
): string {
  return `${record.category}:${record.key}`;
}

// Re-exported so callers that classify records do not need a second import just for
// the action/category vocabulary.
export type { ChangeAction, ChangeCategory };
