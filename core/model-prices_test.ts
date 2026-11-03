import { assertAlmostEquals, assertEquals } from "@std/assert";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { modelPrice } from "./model-prices.ts";
import { computeProviderModelCost } from "./usage.ts";

// Real models.dev shapes for the models in use (2026-11-02).
const CATALOG = {
  anthropic: {
    id: "anthropic",
    name: "Anthropic",
    models: {
      "claude-opus-5-5": {
        id: "claude-opus-5-5",
        cost: { input: 4, output: 20, cache_read: 0.2, cache_write: 5 },
      },
      "claude-opus-5": {
        id: "claude-opus-5",
        cost: { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
      },
      "claude-fable-5-1": {
        id: "claude-fable-5-1",
        cost: { input: 10, output: 50, cache_read: 0.25, cache_write: 12.5 },
      },
    },
  },
  openai: {
    id: "openai",
    name: "OpenAI",
    models: {
      "gpt-5.5": {
        id: "gpt-5.5",
        cost: { input: 5, output: 30, cache_read: 0.5 },
      },
    },
  },
};

// No project, no composition, no seam: just a models.dev cache under HOME. This
// is the agent process's situation, and it must still price.
async function withCatalogHome(fn: () => void): Promise<void> {
  const home = await Deno.makeTempDir({ prefix: "genie-model-prices-" });
  const oldHome = Deno.env.get("HOME");
  try {
    Deno.env.set("HOME", home);
    const dir = join(home, ".config", "opentide");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "models-dev-cache.json"),
      JSON.stringify({ cachedAt: new Date().toISOString(), catalog: CATALOG }),
    );
    fn();
  } finally {
    if (oldHome === undefined) Deno.env.delete("HOME");
    else Deno.env.set("HOME", oldHome);
    rmSync(home, { recursive: true, force: true });
  }
}

const MTOK = 1_000_000;

Deno.test("modelPrice: Opus 5.5 and Opus 5 are priced separately", async () => {
  await withCatalogHome(() => {
    const opus55 = modelPrice("anthropic", "claude-opus-5-5");
    assertEquals(
      [opus55?.input, opus55?.output, opus55?.cacheCreation, opus55?.cacheRead],
      [4, 20, 5, 0.2],
    );
    assertEquals(modelPrice("anthropic", "claude-opus-5")?.input, 5);
    assertEquals(modelPrice("anthropic", "claude-fable-5-1")?.cacheRead, 0.25);
  });
});

Deno.test("modelPrice: exact id only, and the provider is part of the key", async () => {
  await withCatalogHome(() => {
    assertEquals(modelPrice("anthropic", "claude-opus-5-5-preview"), undefined);
    assertEquals(modelPrice("openai", "claude-opus-5-5"), undefined);
    assertEquals(modelPrice("anthropic", "claude-opus-9"), undefined);
  });
});

Deno.test("computeProviderModelCost: Opus 5.5 at models.dev rates, no setup", async () => {
  await withCatalogHome(() => {
    const cost = computeProviderModelCost({
      provider: "anthropic",
      model: "claude-opus-5-5",
      inputTokens: MTOK,
      outputTokens: MTOK,
      cacheCreationInputTokens: MTOK,
      cacheReadInputTokens: MTOK,
    });
    assertEquals(cost.pricingStatus, "priced");
    assertAlmostEquals(cost.costUsd!, 4 + 20 + 5 + 0.2, 1e-9);
  });
});

Deno.test("computeProviderModelCost: a 1h cache write costs 2x input", async () => {
  await withCatalogHome(() => {
    const cost = computeProviderModelCost({
      provider: "anthropic",
      model: "claude-opus-5-5",
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: MTOK,
      cacheReadInputTokens: 0,
      cacheTtl: "1h",
    });
    assertAlmostEquals(cost.costUsd!, 8, 1e-9);
  });
});

Deno.test("computeProviderModelCost: unlisted model is unpriced, not $0", async () => {
  await withCatalogHome(() => {
    const cost = computeProviderModelCost({
      provider: "anthropic",
      model: "claude-opus-9",
      inputTokens: MTOK,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    });
    assertEquals(cost, { costUsd: null, pricingStatus: "unpriced" });
  });
});

Deno.test("computeProviderModelCost: cache writes on a model with no cache_write price are unpriced", async () => {
  await withCatalogHome(() => {
    const base = {
      provider: "openai",
      model: "gpt-5.5",
      inputTokens: MTOK,
      outputTokens: 0,
      cacheReadInputTokens: MTOK,
    };
    const reads = computeProviderModelCost({
      ...base,
      cacheCreationInputTokens: 0,
    });
    assertAlmostEquals(reads.costUsd!, 5.5, 1e-9);
    const writes = computeProviderModelCost({
      ...base,
      cacheCreationInputTokens: 1,
    });
    assertEquals(writes.pricingStatus, "unpriced");
  });
});

Deno.test("modelPrice: no cache file means nothing is priced", async () => {
  const home = await Deno.makeTempDir({ prefix: "genie-model-prices-empty-" });
  const oldHome = Deno.env.get("HOME");
  try {
    Deno.env.set("HOME", home);
    assertEquals(modelPrice("anthropic", "claude-opus-5-5"), undefined);
  } finally {
    if (oldHome === undefined) Deno.env.delete("HOME");
    else Deno.env.set("HOME", oldHome);
    rmSync(home, { recursive: true, force: true });
  }
});
