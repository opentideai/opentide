import { assert, assertEquals } from "@std/assert";
import {
  CHANGE_CATEGORY_TIERS,
  changeRecordTier,
  changeScope,
  LIGHT_TIER_TOOLS,
  maxTier,
  mutationToolTier,
} from "./change-tiers.ts";
import { MODIFICATION_TOOLS } from "./dispatch.ts";
import type { ChangeCategory } from "../changelog.ts";

// Every category the changelog can emit must have a decided tier. The `satisfies`
// in change-tiers.ts already enforces this at compile time; this guards the runtime
// shape too, so a map rebuilt from data would still be caught.
Deno.test("CHANGE_CATEGORY_TIERS covers every ChangeCategory", () => {
  const categories: ChangeCategory[] = [
    "handler",
    "function",
    "route",
    "config",
    "schema",
    "sql",
    "snapshot",
    "dev_view",
    "dev_tool",
    "asset",
    "template",
    "branch",
    "package",
    "test",
    "secret",
    "env_var",
    "module",
    "audit",
    "type",
  ];
  for (const category of categories) {
    const tier = CHANGE_CATEGORY_TIERS[category];
    assert(
      tier === "light" || tier === "standard",
      `${category} has no tier`,
    );
  }
  assertEquals(Object.keys(CHANGE_CATEGORY_TIERS).length, categories.length);
});

// Drift guard: LIGHT_TIER_TOOLS names verbs, and dispatch's MODIFICATION_TOOLS is
// where verbs are added. A light-tier verb that no longer exists is dead policy.
Deno.test("LIGHT_TIER_TOOLS only names real mutation verbs", () => {
  for (const name of LIGHT_TIER_TOOLS) {
    assert(
      MODIFICATION_TOOLS.has(name),
      `${name} is in LIGHT_TIER_TOOLS but is not a mutation verb`,
    );
  }
});

// remove_entity delegates to a per-entity removal verb that re-enters the dispatch
// gate under its own name, so classifying it here would duplicate — and eventually
// contradict — the authoritative inner check.
Deno.test("remove_entity is deliberately unclassified", () => {
  assert(MODIFICATION_TOOLS.has("remove_entity"));
  assert(!LIGHT_TIER_TOOLS.has("remove_entity"));
  assertEquals(mutationToolTier("remove_entity"), "standard");
});

Deno.test("mutationToolTier defaults unknown verbs to standard", () => {
  assertEquals(mutationToolTier("define_template"), "light");
  assertEquals(mutationToolTier("define_handler"), "light");
  // Structural surfaces stay standard even though they are ordinary mutations.
  assertEquals(mutationToolTier("define_schema"), "standard");
  assertEquals(mutationToolTier("register_route"), "standard");
  assertEquals(mutationToolTier("install_package"), "standard");
  assertEquals(mutationToolTier("define_secret"), "standard");
  // An unmapped verb is unclassified, and unclassified reads as full ceremony.
  assertEquals(mutationToolTier("some_future_verb"), "standard");
});

Deno.test("changeRecordTier escalates deletion of a code entity", () => {
  assertEquals(
    changeRecordTier({ category: "handler", action: "update" }),
    "light",
  );
  // Removing a handler breaks every caller and route bound to it — not something a
  // single synthesized criterion can honestly cover.
  assertEquals(
    changeRecordTier({ category: "handler", action: "delete" }),
    "standard",
  );
  assertEquals(
    changeRecordTier({ category: "function", action: "delete" }),
    "standard",
  );
  // Deleting a template or asset is recoverable and locally scoped.
  assertEquals(
    changeRecordTier({ category: "template", action: "delete" }),
    "light",
  );
  assertEquals(
    changeRecordTier({ category: "asset", action: "delete" }),
    "light",
  );
  // A structural category is standard whatever the action.
  assertEquals(
    changeRecordTier({ category: "schema", action: "create" }),
    "standard",
  );
});

Deno.test("maxTier folds to the stricter tier", () => {
  assertEquals(maxTier("light", "light"), "light");
  assertEquals(maxTier("light", "standard"), "standard");
  assertEquals(maxTier("standard", "light"), "standard");
  assertEquals(maxTier("standard", "standard"), "standard");
});

Deno.test("changeScope spells an entity one way", () => {
  assertEquals(
    changeScope({ category: "template", key: "checkout-page" }),
    "template:checkout-page",
  );
});
