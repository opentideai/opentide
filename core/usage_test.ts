import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import {
  CACHE_CREATION_1H_MULTIPLIER,
  CACHE_CREATION_MULTIPLIER,
  CACHE_READ_MULTIPLIER,
  cacheReadMultiplierForModel,
  computeCostUsd,
  computeCostUsdWithStatus,
  computeProviderModelCost,
  getEffectivePricing,
  getModelPricing,
  getPricingTable,
  getProviderModelPricing,
  type ModelPricing,
  type PricingTier,
  type ProviderModelPricing,
  setPricingTableProvider,
  setProviderModelPricingTableProvider,
} from "./usage.ts";
import {
  MODELS_DEV_ROW_MAX_AGE_DAYS,
  pricingRowsFromModelsDev,
} from "./models-dev.ts";
import { resolvePricingTier } from "./usage.ts";

// A neutral usage time for models with no intro overlay — its value can't affect
// their cost, but computeCostUsd requires the usage timestamp explicitly (no
// buried report-time default), so every call threads one.
const NEUTRAL_ASOF = new Date("2026-07-25T00:00:00Z");

Deno.test("getModelPricing prices Opus 5 at the current $5/$25 tier", () => {
  const p = getModelPricing("claude-opus-5");
  assertEquals(p?.input, 5);
  assertEquals(p?.output, 25);
});

Deno.test("getModelPricing defaults an unknown Opus to current, not legacy", () => {
  // A hypothetical future Opus id must NOT fall through to legacy $15/$75.
  const p = getModelPricing("claude-opus-6");
  assertEquals(p?.input, 5);
  assertEquals(p?.output, 25);
});

Deno.test("getModelPricing keeps legacy $15/$75 for Opus 4.1", () => {
  const p = getModelPricing("claude-opus-4-1");
  assertEquals(p?.input, 15);
  assertEquals(p?.output, 75);
});

Deno.test("computeCostUsd on Opus 5 matches hand math", () => {
  // 2M input @ $5, 0.5M output @ $25, 1M cacheCreation @ $6.25, 3M cacheRead @ $0.50
  // = 10 + 12.5 + 6.25 + 1.5 = 30.25
  assertEquals(
    computeCostUsd(
      "claude-opus-5",
      2_000_000,
      500_000,
      1_000_000,
      3_000_000,
      NEUTRAL_ASOF,
    ),
    30.25,
  );
});

Deno.test("computeCostUsd uses current Opus 4.6 standard pricing", () => {
  assertEquals(getModelPricing("claude-opus-4-6")?.fast, {
    input: 30,
    output: 150,
  });
  assertEquals(
    computeCostUsd(
      "claude-opus-4-6",
      1_000_000,
      1_000_000,
      1_000_000,
      1_000_000,
      NEUTRAL_ASOF,
    ),
    36.75,
  );
});

Deno.test("computeCostUsd keeps legacy Opus pricing for Opus 4.1", () => {
  assertEquals(
    computeCostUsd(
      "claude-opus-4-1-20250805",
      1_000_000,
      1_000_000,
      1_000_000,
      1_000_000,
      NEUTRAL_ASOF,
    ),
    110.25,
  );
});

Deno.test("computeCostUsd uses current Haiku 4.5 pricing", () => {
  assertEquals(
    computeCostUsd(
      "claude-haiku-4-5-20251001",
      1_000_000,
      1_000_000,
      1_000_000,
      1_000_000,
      NEUTRAL_ASOF,
    ),
    7.35,
  );
});

Deno.test("computeCostUsdWithStatus returns unpriced for OpenAI-like model ids", () => {
  assertEquals(getModelPricing("gpt-5"), undefined);
  assertEquals(
    computeCostUsdWithStatus(
      "gpt-5",
      1_000_000,
      1_000_000,
      1_000_000,
      1_000_000,
      NEUTRAL_ASOF,
    ),
    { costUsd: null, pricingStatus: "unpriced", pricing: null },
  );
});

Deno.test("computeCostUsd no longer prices unknown non-Claude models as Sonnet", () => {
  const oldSonnetFallbackCost = computeCostUsd(
    "claude-sonnet-5",
    1_000_000,
    1_000_000,
    1_000_000,
    1_000_000,
    NEUTRAL_ASOF,
  );
  assertEquals(oldSonnetFallbackCost, 14.7);
  assertEquals(
    computeCostUsd(
      "gpt-4o-mini",
      1_000_000,
      1_000_000,
      1_000_000,
      1_000_000,
      NEUTRAL_ASOF,
    ),
    0,
  );
});

// --- E3: dated intro/promo prices -----------------------------------------
//
// The mechanism, exercised against a FIXTURE tier. It used to run against the live
// Sonnet 5 intro; that promo became the standard price on 2026-09-13 (see
// core/usage.ts) and no shipped tier carries an `intro` any more. Pinning the
// mechanism to whatever promotion happens to be live is how these assertions came
// to depend on data that moved under them.
const SONNET_WITH_INTRO: ModelPricing = {
  input: 3,
  output: 15,
  cacheCreation: 3.75,
  cacheRead: 0.3,
  unit: "MTok",
  intro: { input: 2, output: 10, through: "2026-08-31" },
};

// Boundary semantics: the intro is INCLUSIVE of the whole `through` calendar day
// (UTC). 2026-08-31 is still intro; 2026-09-01 has reverted.
const WITHIN_INTRO = new Date("2026-08-15T12:00:00Z");
const BOUNDARY_DAY = new Date("2026-08-31T23:59:59Z"); // last intro instant
const AFTER_INTRO = new Date("2026-09-01T00:00:00Z"); // first standard instant

Deno.test("getModelPricing returns the STICKER price, intro-agnostic", () => {
  // The base resolver must keep returning $3/$15 regardless of date — labels and
  // the E2 drift table depend on the sticker price.
  withPricingOverride({ sonnet: SONNET_WITH_INTRO }, () => {
    const p = getModelPricing("claude-sonnet-5");
    assertEquals(p?.input, 3);
    assertEquals(p?.output, 15);
    assertEquals(p?.intro, { input: 2, output: 10, through: "2026-08-31" });
  });
});

Deno.test("getEffectivePricing applies the $2/$10 intro within the window", () => {
  withPricingOverride({ sonnet: SONNET_WITH_INTRO }, () => {
    const p = getEffectivePricing("claude-sonnet-5", WITHIN_INTRO);
    assertEquals(p?.input, 2);
    assertEquals(p?.output, 10);
    // Intro cache rates derive via the 1.25×/0.10× invariant — never hand-copied.
    assertEquals(p?.cacheCreation, 2 * CACHE_CREATION_MULTIPLIER); // 2.5
    assertEquals(p?.cacheRead, 2 * CACHE_READ_MULTIPLIER); // 0.2
  });
});

Deno.test("getEffectivePricing honors the intro through the whole boundary day", () => {
  withPricingOverride({ sonnet: SONNET_WITH_INTRO }, () => {
    const p = getEffectivePricing("claude-sonnet-5", BOUNDARY_DAY);
    assertEquals(p?.input, 2);
    assertEquals(p?.output, 10);
  });
});

Deno.test("getEffectivePricing reverts to the base after the through date", () => {
  withPricingOverride({ sonnet: SONNET_WITH_INTRO }, () => {
    const p = getEffectivePricing("claude-sonnet-5", AFTER_INTRO);
    assertEquals(p?.input, 3);
    assertEquals(p?.output, 15);
    assertEquals(p?.cacheCreation, 3.75);
    assertEquals(p?.cacheRead, 0.3);
  });
});

Deno.test("getEffectivePricing leaves intro-less models unchanged", () => {
  assertEquals(getEffectivePricing("claude-opus-5", WITHIN_INTRO)?.input, 5);
  assertEquals(getEffectivePricing("claude-opus-5", AFTER_INTRO)?.input, 5);
});

Deno.test("getEffectivePricing bills the base price for an invalid asOf", () => {
  // A bad/unparseable timestamp must fall back to the safe sticker price, never
  // wrongly apply the promo.
  withPricingOverride({ sonnet: SONNET_WITH_INTRO }, () => {
    const p = getEffectivePricing("claude-sonnet-5", new Date("not-a-date"));
    assertEquals(p?.input, 3);
    assertEquals(p?.output, 15);
  });
});

Deno.test("computeCostUsd: same usage costs $2/$10 in-window, $3/$15 after", () => {
  withPricingOverride({ sonnet: SONNET_WITH_INTRO }, () => {
    // 1M each of input/output/cacheCreation/cacheRead.
    // In-window: 2 + 10 + 2.5 + 0.2 = 14.70
    const within = computeCostUsd(
      "claude-sonnet-5",
      1_000_000,
      1_000_000,
      1_000_000,
      1_000_000,
      WITHIN_INTRO,
    );
    assertAlmostEquals(within, 14.7, 1e-9);
    // After: 3 + 15 + 3.75 + 0.3 = 22.05
    const after = computeCostUsd(
      "claude-sonnet-5",
      1_000_000,
      1_000_000,
      1_000_000,
      1_000_000,
      AFTER_INTRO,
    );
    assertAlmostEquals(after, 22.05, 1e-9);
    assert(within < after, "intro must be cheaper than the reverted base");
  });
});

// --- Stage 2B Slice 1: config-overlaid pricing table (empty config == today) ---

// Set the pricing overlay for the body of `fn`, then always restore the no-op
// default so the shared module singleton never leaks between tests.
function withPricingOverride(
  overrides: Partial<Record<PricingTier, ModelPricing>>,
  fn: () => void,
): void {
  setPricingTableProvider(() => overrides);
  try {
    fn();
  } finally {
    setPricingTableProvider(() => ({}));
  }
}

function withProviderPricingOverride(
  rows: ProviderModelPricing[],
  fn: () => void,
): void {
  setProviderModelPricingTableProvider(() => rows);
  try {
    fn();
  } finally {
    setProviderModelPricingTableProvider(() => []);
  }
}

// The exact seed prices, one id per resolver family plus a legacy and an
// unknown-in-family. Doubles as the empty-config regression snapshot: with no
// provider wired, getModelPricing must return these byte-for-byte.
const SEED_SNAPSHOT: ReadonlyArray<readonly [string, ModelPricing]> = [
  // 5.1 — same $10/$50 and the same cache WRITES as Fable 5, but reads at 0.025×.
  ["claude-fable-5-1", {
    input: 10,
    output: 50,
    cacheCreation: 12.5,
    cacheRead: 0.25,
    cacheReadMultiplier: 0.025,
    unit: "MTok",
  }],
  ["claude-fable-5", {
    input: 10,
    output: 50,
    cacheCreation: 12.5,
    cacheRead: 1,
    unit: "MTok",
  }],
  ["claude-opus-5", {
    input: 5,
    output: 25,
    cacheCreation: 6.25,
    cacheRead: 0.5,
    unit: "MTok",
  }],
  ["claude-opus-4-8", {
    input: 5,
    output: 25,
    cacheCreation: 6.25,
    cacheRead: 0.5,
    unit: "MTok",
    fast: { input: 10, output: 50 },
  }],
  ["claude-opus-4-6", {
    input: 5,
    output: 25,
    cacheCreation: 6.25,
    cacheRead: 0.5,
    unit: "MTok",
    fast: { input: 30, output: 150 },
  }],
  ["claude-sonnet-5", {
    input: 2,
    output: 10,
    cacheCreation: 2.5,
    cacheRead: 0.2,
    unit: "MTok",
  }],
  // Sonnet 4.x stayed at $3/$15 when Sonnet 5 landed under it — a separate tier
  // since 2026-09-13, and the reason one shared `sonnet` tier no longer works.
  ["claude-sonnet-4-6", {
    input: 3,
    output: 15,
    cacheCreation: 3.75,
    cacheRead: 0.3,
    unit: "MTok",
  }],
  ["claude-haiku-4-5-20251001", {
    input: 1,
    output: 5,
    cacheCreation: 1.25,
    cacheRead: 0.1,
    unit: "MTok",
  }],
  // Legacy id stays on the older, higher tier.
  ["claude-opus-4-1", {
    input: 15,
    output: 75,
    cacheCreation: 18.75,
    cacheRead: 1.5,
    unit: "MTok",
  }],
  // Unknown-in-family (a hypothetical future Opus) resolves to the CURRENT tier.
  ["claude-opus-6", {
    input: 5,
    output: 25,
    cacheCreation: 6.25,
    cacheRead: 0.5,
    unit: "MTok",
  }],
];

Deno.test("empty config: getModelPricing is byte-identical to the seed per family", () => {
  // No provider wired (module default returns {}), so every price is the seed.
  for (const [id, expected] of SEED_SNAPSHOT) {
    assertEquals(getModelPricing(id), expected, `seed mismatch for ${id}`);
  }
});

Deno.test("empty config: no shipped tier carries an intro, so effective == sticker", () => {
  // Sonnet 5's promo became the standard price on 2026-09-13 and the overlay was
  // pruned, so nothing in the seed is date-dependent. The intro MECHANISM is
  // covered above against a fixture tier; this pins the current data.
  for (const [id] of SEED_SNAPSHOT) {
    assertEquals(getModelPricing(id)?.intro, undefined, `${id} has no intro`);
    assertEquals(
      getEffectivePricing(id, BOUNDARY_DAY),
      getEffectivePricing(id, AFTER_INTRO),
      `${id} prices the same on both sides of a date`,
    );
  }
});

Deno.test("provider seam: a partial override replaces only its tier, others keep the seed", () => {
  const sonnetOverride: ModelPricing = {
    input: 4,
    output: 20,
    cacheCreation: 5,
    cacheRead: 0.4,
    unit: "MTok",
  };
  withPricingOverride({ sonnet: sonnetOverride }, () => {
    // Overridden tier returns the config value verbatim (sticker/base price).
    assertEquals(getModelPricing("claude-sonnet-5"), sonnetOverride);
    // A non-overridden tier still resolves to the seed.
    assertEquals(getModelPricing("claude-opus-5")?.input, 5);
    // getPricingTable reflects the effective (overlaid) table for the E2 diff.
    assertEquals(getPricingTable().sonnet, sonnetOverride);
    assertEquals(getPricingTable().opus5.input, 5);
  });
  // Restored: the override is gone, back to the seed.
  assertEquals(getModelPricing("claude-sonnet-5")?.input, 2);
});

Deno.test("provider seam: the cache/intro invariants still derive through an overlay", () => {
  // An override that carries its own intro — the derivation must key off the
  // OVERRIDE's intro.input, never a hand-copied cache number or the seed.
  const sonnetOverride: ModelPricing = {
    input: 4,
    output: 20,
    cacheCreation: 5,
    cacheRead: 0.4,
    unit: "MTok",
    intro: { input: 3, output: 12, through: "2026-08-31" },
  };
  withPricingOverride({ sonnet: sonnetOverride }, () => {
    const p = getEffectivePricing("claude-sonnet-5", WITHIN_INTRO);
    assertEquals(p?.input, 3);
    assertEquals(p?.output, 12);
    // Cache rates derive 1.25×/0.10× off the override's intro input (3), not 4
    // (deriveCacheRates rounds to 4dp — 3 × 0.1 lands on a clean 0.3).
    assertEquals(p?.cacheCreation, 3.75);
    assertEquals(p?.cacheRead, 0.3);
    // After the window, the override's own base ($4/$20) applies — not the seed.
    assertEquals(getEffectivePricing("claude-sonnet-5", AFTER_INTRO)?.input, 4);
    // computeCostUsd bills through the overlay too: 1M each = 3+12+3.75+0.3.
    assertAlmostEquals(
      computeCostUsd(
        "claude-sonnet-5",
        1_000_000,
        1_000_000,
        1_000_000,
        1_000_000,
        WITHIN_INTRO,
      ),
      19.05,
      1e-9,
    );
  });
});

Deno.test("provider-aware API resolves known Anthropic models through built-in rows", () => {
  const p = getProviderModelPricing("anthropic", "claude-opus-5", NEUTRAL_ASOF);
  assertEquals(p?.provider, "anthropic");
  assertEquals(p?.model, "claude-opus-5");
  assertEquals(p?.input, 5);
  assertEquals(p?.output, 25);
  assertEquals(p?.cacheCreation, 6.25);
  assertEquals(p?.cacheRead, 0.5);
  assertEquals(p?.currency, "USD");
  assertEquals(p?.source, "built_in");
});

Deno.test("provider-aware API applies Anthropic intro pricing by usage date", () => {
  withPricingOverride({ sonnet: SONNET_WITH_INTRO }, () => {
    const within = getProviderModelPricing(
      "anthropic",
      "claude-sonnet-5",
      WITHIN_INTRO,
    );
    assertEquals(within?.input, 2);
    assertEquals(within?.output, 10);
    assertEquals(within?.cacheCreation, 2.5);
    assertEquals(within?.cacheRead, 0.2);
    assertEquals(within?.effectiveThrough, "2026-08-31");

    const after = getProviderModelPricing(
      "anthropic",
      "claude-sonnet-5",
      AFTER_INTRO,
    );
    assertEquals(after?.input, 3);
    assertEquals(after?.output, 15);
    assertEquals(after?.effectiveThrough, undefined);
  });
});

Deno.test("provider-aware API leaves OpenAI models unpriced without an exact row", () => {
  assertEquals(
    getProviderModelPricing("openai", "gpt-5", NEUTRAL_ASOF),
    undefined,
  );
  assertEquals(
    computeProviderModelCost({
      provider: "openai",
      model: "gpt-5",
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      asOf: NEUTRAL_ASOF,
    }),
    { costUsd: null, pricingStatus: "unpriced", pricing: null },
  );
});

Deno.test("provider-aware override wins for exact provider/model rows", () => {
  const row: ProviderModelPricing = {
    provider: "openai",
    model: "gpt-5",
    input: 1.25,
    output: 10,
    unit: "MTok",
    currency: "USD",
    source: "manual",
    verifiedAt: "2026-09-10T00:00:00Z",
    sourceUrl: "https://example.invalid/pricing",
  };
  withProviderPricingOverride([row], () => {
    assertEquals(getProviderModelPricing("openai", "gpt-5", NEUTRAL_ASOF), row);
    assertEquals(
      computeProviderModelCost({
        provider: "openai",
        model: "gpt-5",
        inputTokens: 2_000_000,
        outputTokens: 500_000,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        asOf: NEUTRAL_ASOF,
      }).costUsd,
      7.5,
    );
  });
});

Deno.test("provider-aware lookup ignores untrusted non-Anthropic configured sources", () => {
  const row: ProviderModelPricing = {
    provider: "openai",
    model: "gpt-5",
    input: 1.25,
    output: 10,
    unit: "MTok",
    currency: "USD",
    source: "provider_metadata",
  };
  withProviderPricingOverride([row], () => {
    assertEquals(
      getProviderModelPricing("openai", "gpt-5", NEUTRAL_ASOF),
      undefined,
    );
  });
});

Deno.test("provider-aware lookup picks the latest active bounded row", () => {
  const older: ProviderModelPricing = {
    provider: "openai",
    model: "gpt-5",
    input: 1,
    output: 8,
    unit: "MTok",
    currency: "USD",
    source: "manual",
    effectiveFrom: "2026-01-01",
  };
  const newer: ProviderModelPricing = {
    provider: "openai",
    model: "gpt-5",
    input: 2,
    output: 16,
    unit: "MTok",
    currency: "USD",
    source: "manual",
    effectiveFrom: "2026-09-01",
    effectiveThrough: "2026-09-30",
  };
  const invalid: ProviderModelPricing = {
    provider: "openai",
    model: "gpt-5",
    input: 99,
    output: 99,
    unit: "MTok",
    currency: "USD",
    source: "manual",
    effectiveFrom: "2026-09-10T00:00:00Z",
  };
  withProviderPricingOverride([older, invalid, newer], () => {
    assertEquals(
      getProviderModelPricing(
        "openai",
        "gpt-5",
        new Date("2026-09-10T12:00:00Z"),
      ),
      newer,
    );
    assertEquals(
      getProviderModelPricing(
        "openai",
        "gpt-5",
        new Date("2026-10-01T00:00:00Z"),
      ),
      older,
    );
  });
});

Deno.test("legacy tier override still affects Anthropic provider-aware rows", () => {
  const sonnetOverride: ModelPricing = {
    input: 4,
    output: 20,
    cacheCreation: 5,
    cacheRead: 0.4,
    unit: "MTok",
  };
  withPricingOverride({ sonnet: sonnetOverride }, () => {
    const row = getProviderModelPricing(
      "anthropic",
      "claude-sonnet-5",
      AFTER_INTRO,
    );
    assertEquals(row?.input, 4);
    assertEquals(row?.output, 20);
    assertEquals(row?.cacheCreation, 5);
    assertEquals(row?.cacheRead, 0.4);
  });
});

// --- 1h cache-TTL pricing (docs/agent-cost-reduction.md §4.9) ---------------

// The table encodes the 5m relationship (cacheCreation = 1.25 × input) and an E2
// drift check asserts it, so the 1h rate (2 × input) is applied at cost-computation
// time by scaling. Opus 5 is $5 in / $6.25 cache-write 5m / $10 cache-write 1h.
Deno.test("computeProviderModelCost prices 1h cache writes at 2x input", () => {
  const base = {
    provider: "anthropic" as const,
    model: "claude-opus-5",
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 1_000_000,
    cacheReadInputTokens: 0,
    asOf: NEUTRAL_ASOF,
  };
  const fiveMinute = computeProviderModelCost(base);
  assertEquals(fiveMinute.costUsd, 6.25);
  // Omitting the TTL must stay byte-identical to explicitly asking for 5m.
  assertEquals(
    computeProviderModelCost({ ...base, cacheTtl: "5m" }).costUsd,
    fiveMinute.costUsd,
  );
  const hour = computeProviderModelCost({ ...base, cacheTtl: "1h" });
  assertEquals(hour.costUsd, 10);
  assertEquals(hour.pricingStatus, "priced");
  // The reported pricing row is the table's own 5m row, unscaled — the TTL is a
  // property of the request, not of the price list.
  assertEquals(hour.pricing?.cacheCreation, 6.25);
  assertAlmostEquals(
    (hour.costUsd ?? 0) / (fiveMinute.costUsd ?? 1),
    CACHE_CREATION_1H_MULTIPLIER / CACHE_CREATION_MULTIPLIER,
  );
});

Deno.test("1h TTL leaves input/output/cache-read buckets untouched", () => {
  const base = {
    provider: "anthropic" as const,
    model: "claude-opus-5",
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 1_000_000,
    asOf: NEUTRAL_ASOF,
  };
  assertEquals(
    computeProviderModelCost({ ...base, cacheTtl: "1h" }).costUsd,
    computeProviderModelCost(base).costUsd,
  );
});

Deno.test("computeCostUsdWithStatus threads the cache TTL through", () => {
  const fiveMinute = computeCostUsdWithStatus(
    "claude-opus-5",
    0,
    0,
    1_000_000,
    0,
    NEUTRAL_ASOF,
  );
  const hour = computeCostUsdWithStatus(
    "claude-opus-5",
    0,
    0,
    1_000_000,
    0,
    NEUTRAL_ASOF,
    "1h",
  );
  assertEquals(fiveMinute.costUsd, 6.25);
  assertEquals(hour.costUsd, 10);
  assertEquals(hour.pricingStatus, "priced");
});

// --- models.dev must not launder an expired promo (§4.10) ------------------
//
// The catalog is a snapshot with no sense of time. A row scraped while Sonnet 5's
// introductory $2/$10 was live carried no effectiveThrough and outranked
// built_in, so it went on billing the promo after 2026-08-31 while the table's
// own `intro` overlay expired correctly. These six pin the resolution order that
// stops it, and the three lines that must NOT move while it does.

const MODELS_DEV_SONNET_INTRO: ProviderModelPricing = {
  provider: "anthropic",
  model: "claude-sonnet-5",
  input: 2,
  output: 10,
  cacheRead: 0.25,
  unit: "MTok",
  currency: "USD",
  source: "models_dev",
  verifiedAt: "2026-08-20",
};

Deno.test("models.dev loses to the built-in table for a known Anthropic tier", () => {
  // The built-in side is the fixture tier, so the scrape and the table actually
  // DISAGREE after the through date — the shipped table now agrees with the
  // scrape at $2/$10, which would make this pass without testing anything.
  withPricingOverride({ sonnet: SONNET_WITH_INTRO }, () => {
    withProviderPricingOverride([MODELS_DEV_SONNET_INTRO], () => {
      const row = getProviderModelPricing(
        "anthropic",
        "claude-sonnet-5",
        AFTER_INTRO,
      );
      assertEquals(row?.source, "built_in");
      assertEquals(row?.input, 3);
      assertEquals(row?.output, 15);
    });
  });
});

Deno.test("an active intro comes from the gated built-in path, not the overlay", () => {
  withPricingOverride({ sonnet: SONNET_WITH_INTRO }, () => {
    withProviderPricingOverride([MODELS_DEV_SONNET_INTRO], () => {
      const row = getProviderModelPricing(
        "anthropic",
        "claude-sonnet-5",
        WITHIN_INTRO,
      );
      // Same $2/$10 the scrape would have given — but sourced from the table, so
      // it stops on 2026-08-31 instead of outliving the promotion.
      assertEquals(row?.input, 2);
      assertEquals(row?.output, 10);
      assertEquals(row?.source, "built_in");
      assertEquals(row?.effectiveThrough, "2026-08-31");
    });
  });
});

Deno.test("models.dev still wins for an Anthropic model the resolver only guesses", () => {
  const row: ProviderModelPricing = {
    ...MODELS_DEV_SONNET_INTRO,
    model: "claude-sonnet-9-20991231",
    input: 7,
    output: 35,
  };
  withProviderPricingOverride([row], () => {
    assertEquals(
      getProviderModelPricing(
        "anthropic",
        "claude-sonnet-9-20991231",
        AFTER_INTRO,
      ),
      row,
    );
  });
});

Deno.test("models.dev is untouched for non-Anthropic providers", () => {
  const row: ProviderModelPricing = {
    provider: "openai",
    model: "gpt-5",
    input: 1.25,
    output: 10,
    unit: "MTok",
    currency: "USD",
    source: "models_dev",
  };
  withProviderPricingOverride([row], () => {
    assertEquals(getProviderModelPricing("openai", "gpt-5", AFTER_INTRO), row);
  });
});

Deno.test("manual and verified Anthropic rows still beat the built-in table", () => {
  // The regression risk in shadowing models_dev: these are the deliberate human
  // override and must keep winning at the same prices they always did.
  for (const source of ["manual", "verified"] as const) {
    const row: ProviderModelPricing = {
      ...MODELS_DEV_SONNET_INTRO,
      source,
      input: 2.5,
      output: 12,
    };
    withProviderPricingOverride([MODELS_DEV_SONNET_INTRO, row], () => {
      assertEquals(
        getProviderModelPricing("anthropic", "claude-sonnet-5", AFTER_INTRO),
        row,
      );
    });
  }
});

Deno.test("a models.dev row past its TTL contributes nothing", () => {
  const fetchedAt = new Date("2026-06-01T00:00:00Z");
  const rows = pricingRowsFromModelsDev({
    fetchedAt: fetchedAt.toISOString(),
    providers: {
      openai: {
        id: "openai",
        name: "OpenAI",
        env: [],
        models: {
          "gpt-5": { id: "gpt-5", cost: { input: 1.25, output: 10 } },
        },
      },
    },
  });
  const expiry = new Date(
    fetchedAt.getTime() + MODELS_DEV_ROW_MAX_AGE_DAYS * 24 * 60 * 60 * 1000,
  );
  assertEquals(rows.length, 1);
  assertEquals(rows[0]?.effectiveThrough, expiry.toISOString().slice(0, 10));
  withProviderPricingOverride(rows, () => {
    // Inside the window the scrape prices, as it always did.
    assertEquals(
      getProviderModelPricing("openai", "gpt-5", fetchedAt)?.input,
      1.25,
    );
    // A day past it, the stale catalog is simply gone — OpenAI has no built-in
    // rows, so this degrades to explicitly unpriced rather than to a stale price.
    assertEquals(
      getProviderModelPricing(
        "openai",
        "gpt-5",
        new Date(expiry.getTime() + 24 * 60 * 60 * 1000),
      ),
      undefined,
    );
  });
});

Deno.test("an undateable models.dev catalog is dropped whole", () => {
  assertEquals(
    pricingRowsFromModelsDev({
      fetchedAt: "not-a-timestamp",
      providers: {
        openai: {
          id: "openai",
          name: "OpenAI",
          env: [],
          models: {
            "gpt-5": { id: "gpt-5", cost: { input: 1.25, output: 10 } },
          },
        },
      },
    }),
    [],
  );
});

// --- Slice 11: the 5.1 cache-read exception + the resolver ordering it depends on

// "claude-fable-5-1".includes("claude-fable-5") is TRUE, so a 5.1 arm placed after
// the 5 arm never fires and a 5.1 id silently inherits $1 cache reads — 4× over.
// These four pin the ordering, not just the prices.
Deno.test("resolvePricingTier: Fable 5.1 resolves to fable51, not fable5", () => {
  assertEquals(resolvePricingTier("claude-fable-5-1"), {
    tier: "fable51",
    unknown: false,
  });
});

Deno.test("resolvePricingTier: Mythos 5.1 routes to the same 5.1 tier", () => {
  assertEquals(resolvePricingTier("claude-mythos-5-1"), {
    tier: "fable51",
    unknown: false,
  });
});

Deno.test("resolvePricingTier: Fable/Mythos 5 still resolve to fable5", () => {
  assertEquals(resolvePricingTier("claude-fable-5"), {
    tier: "fable5",
    unknown: false,
  });
  assertEquals(resolvePricingTier("claude-mythos-5"), {
    tier: "fable5",
    unknown: false,
  });
});

Deno.test("fable51 prices cache reads at $0.25 and writes at 1.25×/2×", () => {
  const p = getModelPricing("claude-fable-5-1");
  assertEquals(p?.input, 10);
  assertEquals(p?.output, 50);
  // The exception: 0.025× base input, NOT the 0.1× rule.
  assertEquals(p?.cacheRead, 0.25);
  assertAlmostEquals(p!.cacheRead, p!.input * 0.025);
  // The write multipliers are unchanged and still hold for 5.1.
  assertAlmostEquals(p!.cacheCreation, p!.input * CACHE_CREATION_MULTIPLIER);
  assertAlmostEquals(
    p!.cacheCreation *
      (CACHE_CREATION_1H_MULTIPLIER / CACHE_CREATION_MULTIPLIER),
    p!.input * CACHE_CREATION_1H_MULTIPLIER,
  );
});

Deno.test("every tier but fable51 still reads at 0.1× of its input", () => {
  const table = getPricingTable();
  for (
    const [tier, pricing] of Object.entries(table) as [
      PricingTier,
      ModelPricing,
    ][]
  ) {
    const multiplier = tier === "fable51" ? 0.025 : CACHE_READ_MULTIPLIER;
    assertEquals(
      pricing.cacheReadMultiplier ?? CACHE_READ_MULTIPLIER,
      multiplier,
      `${tier} declares the wrong cache-read multiplier`,
    );
    assertAlmostEquals(
      pricing.cacheRead,
      pricing.input * multiplier,
      1e-9,
      `${tier} cache read is not ${multiplier}× its input`,
    );
    // The invariant that did NOT get an exception.
    assertAlmostEquals(
      pricing.cacheCreation,
      pricing.input * CACHE_CREATION_MULTIPLIER,
      1e-9,
      `${tier} cache write is not 1.25× its input`,
    );
  }
});

Deno.test("cacheReadMultiplierForModel: 0.025 for 5.1, 0.1 for everything else", () => {
  assertEquals(cacheReadMultiplierForModel("claude-fable-5-1"), 0.025);
  assertEquals(cacheReadMultiplierForModel("claude-mythos-5-1"), 0.025);
  assertEquals(
    cacheReadMultiplierForModel("claude-fable-5"),
    CACHE_READ_MULTIPLIER,
  );
  assertEquals(
    cacheReadMultiplierForModel("claude-opus-5"),
    CACHE_READ_MULTIPLIER,
  );
  // An id that resolves to no tier at all still answers with the rule.
  assertEquals(cacheReadMultiplierForModel("gpt-5"), CACHE_READ_MULTIPLIER);
});

Deno.test("computeCostUsd bills 5.1 cache reads at $0.25/MTok", () => {
  // 1M cache-read tokens: $0.25, not the $1 a 0.1× derivation would charge.
  const cost = computeCostUsd(
    "claude-fable-5-1",
    0,
    0,
    0,
    1_000_000,
    NEUTRAL_ASOF,
  );
  assertAlmostEquals(cost, 0.25, 1e-9);
});
