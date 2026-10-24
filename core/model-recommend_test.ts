import { assert, assertEquals } from "@std/assert";
import { MODEL_ROLES, type ModelOption } from "./config.ts";
import { recommendModelsFromCatalog } from "./model-recommend.ts";

// The synthetic "Default" entry getAvailableModels() prepends — recommendations
// must never pick it, and its bare presence must not disturb family matching.
const DEFAULT_ENTRY: ModelOption = {
  id: "default",
  label: "Default",
  family: "default",
};

Deno.test("recommend: every pick is a real catalog id", () => {
  const catalog: ModelOption[] = [
    DEFAULT_ENTRY,
    { id: "claude-opus-5", label: "Opus 5", family: "claude-opus" },
    { id: "claude-opus-4-8", label: "Opus 4.8", family: "claude-opus" },
    { id: "claude-sonnet-5", label: "Sonnet 5", family: "claude-sonnet" },
    {
      id: "claude-haiku-4-5-20251001",
      label: "Haiku 4.5",
      family: "claude-haiku",
    },
  ];
  const catalogIds = new Set(catalog.map((m) => m.id));
  const picks = recommendModelsFromCatalog(catalog);
  for (const role of MODEL_ROLES) {
    const pick = picks[role];
    assert(pick !== undefined, `${role} should have a pick`);
    assert(
      catalogIds.has(pick),
      `${role} pick ${pick} is not a catalog id`,
    );
  }
});

Deno.test("recommend: picks the newest model in each role's target family", () => {
  const catalog: ModelOption[] = [
    DEFAULT_ENTRY,
    { id: "claude-opus-4-7", label: "Opus 4.7", family: "claude-opus" },
    { id: "claude-opus-5", label: "Opus 5", family: "claude-opus" },
    { id: "claude-opus-4-8", label: "Opus 4.8", family: "claude-opus" },
    { id: "claude-sonnet-4-6", label: "Sonnet 4.6", family: "claude-sonnet" },
    { id: "claude-sonnet-5", label: "Sonnet 5", family: "claude-sonnet" },
    {
      id: "claude-haiku-4-5-20251001",
      label: "Haiku 4.5",
      family: "claude-haiku",
    },
  ];
  const picks = recommendModelsFromCatalog(catalog);
  assertEquals(picks.agent, "claude-opus-5");
  assertEquals(picks.planning, "claude-opus-5");
  assertEquals(picks.import, "claude-sonnet-5");
  assertEquals(picks.verification, "claude-sonnet-5");
  assertEquals(picks.utility, "claude-haiku-4-5-20251001");
});

Deno.test("recommend: a missing family yields an ABSENT role, not a seed (D9)", () => {
  // Only the opus family is present — import/verification (sonnet) and utility
  // (haiku) have no live match, so those roles are simply absent from the result
  // (total-but-partial).
  const catalog: ModelOption[] = [
    DEFAULT_ENTRY,
    { id: "claude-opus-5", label: "Opus 5", family: "claude-opus" },
  ];
  const picks = recommendModelsFromCatalog(catalog);
  assertEquals(picks.agent, "claude-opus-5");
  assertEquals(picks.planning, "claude-opus-5");
  assertEquals(picks.import, undefined);
  assertEquals(picks.utility, undefined);
  assertEquals(picks.verification, undefined);
  assertEquals("import" in picks, false);
  assertEquals("utility" in picks, false);
  assertEquals("verification" in picks, false);
});

Deno.test("recommend: a bare catalog yields the empty map (D9)", () => {
  const picks = recommendModelsFromCatalog([]);
  assertEquals(picks, {});
});

Deno.test("recommend: output price breaks a version-score tie", () => {
  // Two opus entries with identical version scores; the cheaper output wins.
  const pricing = (input: number, output: number) => ({
    input,
    output,
    cacheCreation: input,
    cacheRead: input,
    unit: "MTok" as const,
  });
  const catalog: ModelOption[] = [
    DEFAULT_ENTRY,
    {
      id: "claude-opus-5",
      label: "Opus 5 premium",
      family: "claude-opus",
      pricing: pricing(15, 75),
    },
    {
      id: "claude-opus-5-lite",
      label: "Opus 5 lite",
      family: "claude-opus",
      pricing: pricing(5, 25),
    },
  ];
  const picks = recommendModelsFromCatalog(catalog);
  // "claude-opus-5-lite" and "claude-opus-5" score [5] vs [5, ...]; -lite has no
  // extra numeric token so both score [5] → tie → cheaper output (25 < 75) wins.
  assertEquals(picks.agent, "claude-opus-5-lite");
  assertEquals(picks.planning, "claude-opus-5-lite");
});
