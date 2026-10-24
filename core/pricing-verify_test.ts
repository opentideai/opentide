import { assert, assertEquals } from "@std/assert";
import {
  adjudicatePricing,
  adjudicateProviderPricing,
  REASON_DISAGREEMENT,
  REASON_MODEL_MISMATCH,
  REASON_NO_PRIOR,
  REASON_NON_MTOK,
  REASON_NON_USD,
  REASON_OUT_OF_BOUNDS,
  REASON_OUTPUT_LT_INPUT,
  REASON_PROVIDER_MISMATCH,
} from "./pricing-verify.ts";
import {
  deriveCacheRates,
  type ModelPricing,
  type PricingTier,
  type ProviderModelPricing,
} from "./usage.ts";
import type { PricingCandidate } from "./types.ts";
import type { ParsedTier } from "./pricing-refresh.ts";

const SRC = "https://example.test/pricing.md";

// A fixed `current` so these pure tests never depend on the live overlay/provider.
// opus48 carries a `fast` arm; sonnet carries the E3 `intro` overlay — both must
// survive a write untouched.
const CURRENT: Partial<Record<PricingTier, ModelPricing>> = {
  opus48: {
    input: 5,
    output: 25,
    cacheCreation: 6.25,
    cacheRead: 0.5,
    unit: "MTok",
    fast: { input: 10, output: 50 },
  },
  sonnet: {
    input: 3,
    output: 15,
    cacheCreation: 3.75,
    cacheRead: 0.3,
    unit: "MTok",
    intro: { input: 2, output: 10, through: "2026-08-31" },
  },
};

const OPTS = {
  current: CURRENT,
  sourceUrl: SRC,
  extractedAt: "2026-08-02T00:00:00.000Z",
  model: "claude-haiku-4-5",
};

interface Row {
  apiId: string;
  provider?: "anthropic" | "openai";
  model?: string;
  tier?: PricingTier;
  input: number;
  output: number;
  currency?: string;
  unit?: string;
}

function attempt(rows: Row[]): PricingCandidate[] {
  return rows.map((r) => ({
    apiId: r.apiId,
    tier: r.tier,
    input: r.input,
    output: r.output,
    currency: r.currency ?? "USD",
    unit: r.unit ?? "MTok",
    source: SRC,
    ...(r.provider ? { provider: r.provider } : {}),
    ...(r.model ? { model: r.model } : {}),
  }));
}

const OPUS = { apiId: "claude-opus-4-8", tier: "opus48" as const };

Deno.test("adjudicatePricing: agreeing, in-bounds attempts → accepted with correct agreement + derived cache", () => {
  const attempts = [
    attempt([{ ...OPUS, input: 5, output: 25 }]),
    attempt([{ ...OPUS, input: 5, output: 25 }]),
  ];
  const report = adjudicatePricing(attempts, { ...OPTS, scrapeRows: null });

  assertEquals(report.rejected.length, 0);
  assertEquals(report.accepted.length, 1);
  const d = report.accepted[0];
  assert(d);
  assertEquals(d.tier, "opus48");
  assertEquals(d.accepted, true);
  assertEquals(d.reasons, []);
  // Two agent attempts, no scrape → agreement 2.
  assertEquals(d.agreement, 2);
  // Cache rates DERIVED, never taken from an attempt.
  const derived = deriveCacheRates(5);
  assertEquals(d.proposed.cacheCreation, derived.cacheCreation);
  assertEquals(d.proposed.cacheRead, derived.cacheRead);
  // Provenance stamped from the run + agreement.
  assertEquals(d.provenance.agreement, 2);
  assertEquals(d.provenance.model, "claude-haiku-4-5");
  assertEquals(d.provenance.sourceUrl, SRC);
});

Deno.test("adjudicatePricing: one attempt disagreeing → rejected 'disagreement', never written", () => {
  const attempts = [
    attempt([{ ...OPUS, input: 5, output: 25 }]),
    attempt([{ ...OPUS, input: 6, output: 25 }]),
  ];
  const report = adjudicatePricing(attempts, { ...OPTS, scrapeRows: null });
  assertEquals(report.accepted.length, 0);
  const d = report.rejected[0];
  assert(d);
  assert(d.reasons.includes(REASON_DISAGREEMENT));
  assertEquals(d.accepted, false);
});

Deno.test("adjudicatePricing: an order-of-magnitude (>10×) hallucinated rate → rejected 'out-of-bounds'", () => {
  // input 60 = 12× the current 5; output 300 = 12× the current 25.
  const attempts = [
    attempt([{ ...OPUS, input: 60, output: 300 }]),
    attempt([{ ...OPUS, input: 60, output: 300 }]),
  ];
  const report = adjudicatePricing(attempts, { ...OPTS, scrapeRows: null });
  assertEquals(report.accepted.length, 0);
  assert(report.rejected[0]?.reasons.includes(REASON_OUT_OF_BOUNDS));
});

Deno.test("adjudicatePricing: output < input → rejected 'output<input'", () => {
  // Both within the order-of-magnitude bounds, but output < input.
  const attempts = [
    attempt([{ ...OPUS, input: 25, output: 5 }]),
    attempt([{ ...OPUS, input: 25, output: 5 }]),
  ];
  const report = adjudicatePricing(attempts, { ...OPTS, scrapeRows: null });
  assertEquals(report.accepted.length, 0);
  assert(report.rejected[0]?.reasons.includes(REASON_OUTPUT_LT_INPUT));
});

Deno.test("adjudicatePricing: non-USD / non-MTok candidate → rejected 'non-usd' / 'non-mtok'", () => {
  const eur = adjudicatePricing([
    attempt([{ ...OPUS, input: 5, output: 25, currency: "EUR" }]),
  ], { ...OPTS, scrapeRows: null });
  assert(eur.rejected[0]?.reasons.includes(REASON_NON_USD));

  const perK = adjudicatePricing([
    attempt([{ ...OPUS, input: 5, output: 25, unit: "1k tokens" }]),
  ], { ...OPTS, scrapeRows: null });
  assert(perK.rejected[0]?.reasons.includes(REASON_NON_MTOK));
});

Deno.test("adjudicatePricing: a tier with no prior (new family) → 'no-prior', never auto-written", () => {
  // opus5 candidate, but `current` has no opus5 row → no bound → not written.
  const attempts = [
    attempt([{ apiId: "claude-opus-5", tier: "opus5", input: 5, output: 25 }]),
  ];
  const report = adjudicatePricing(attempts, {
    ...OPTS,
    current: { opus48: CURRENT.opus48 }, // deliberately omits opus5
    scrapeRows: null,
  });
  assertEquals(report.accepted.length, 0);
  assert(report.rejected[0]?.reasons.includes(REASON_NO_PRIOR));
});

Deno.test("adjudicatePricing: proposed PRESERVES the fast arm (opus48) and the intro overlay (sonnet)", () => {
  const report = adjudicatePricing([
    attempt([
      { ...OPUS, input: 5, output: 25 },
      { apiId: "claude-sonnet-5", tier: "sonnet", input: 3, output: 15 },
    ]),
  ], { ...OPTS, scrapeRows: null });

  const opus = report.accepted.find((d) => d.tier === "opus48");
  assert(opus);
  assertEquals(opus.proposed.fast, { input: 10, output: 50 });

  const sonnet = report.accepted.find((d) => d.tier === "sonnet");
  assert(sonnet);
  // The E3 intro overlay survives the write, and its cache stays derived from base.
  assertEquals(sonnet.proposed.intro, {
    input: 2,
    output: 10,
    through: "2026-08-31",
  });
  assertEquals(
    sonnet.proposed.cacheCreation,
    deriveCacheRates(3).cacheCreation,
  );
});

Deno.test("adjudicatePricing: a corroborating scrape row RAISES agreement; a null scrape still lets attempts carry a tier", () => {
  const attempts = [
    attempt([{ ...OPUS, input: 5, output: 25 }]),
    attempt([{ ...OPUS, input: 5, output: 25 }]),
  ];
  const scrapeRows: ParsedTier[] = [
    { apiId: "claude-opus-4-8", input: 5, output: 25 },
  ];
  const withScrape = adjudicatePricing(attempts, { ...OPTS, scrapeRows });
  assertEquals(withScrape.accepted[0]?.agreement, 3); // 2 attempts + 1 scrape

  // A reshaped page the scrape can't parse (null) still lets the 2 attempts carry it.
  const noScrape = adjudicatePricing(attempts, { ...OPTS, scrapeRows: null });
  assertEquals(noScrape.accepted.length, 1);
  assertEquals(noScrape.accepted[0]?.agreement, 2);
});

Deno.test("adjudicatePricing: untiered candidates flow to unmapped, never adjudicated", () => {
  const report = adjudicatePricing([
    attempt([
      { ...OPUS, input: 5, output: 25 },
      { apiId: "totally-unknown", input: 1, output: 2 }, // no tier
    ]),
  ], { ...OPTS, scrapeRows: null });
  assertEquals(report.unmapped, ["totally-unknown"]);
  assertEquals(report.decisions.length, 1); // only opus48 adjudicated
});

Deno.test("adjudicateProviderPricing: verified candidate writes only to matching provider/model", () => {
  const current: ProviderModelPricing[] = [{
    provider: "openai",
    model: "gpt-5-mini",
    input: 1,
    output: 8,
    unit: "MTok",
    currency: "USD",
    source: "manual",
  }];
  const report = adjudicateProviderPricing([
    attempt([{
      apiId: "gpt-5-mini",
      provider: "openai",
      model: "gpt-5-mini",
      input: 1.1,
      output: 8.5,
    }]),
    attempt([{
      apiId: "gpt-5-mini",
      provider: "openai",
      model: "gpt-5-mini",
      input: 1.1,
      output: 8.5,
    }]),
  ], {
    provider: "openai",
    sourceUrl: SRC,
    extractedAt: "2026-09-11T00:00:00.000Z",
    model: "claude-haiku-4-5",
    current,
  });

  assertEquals(report.rejected, []);
  const accepted = report.accepted[0];
  assert(accepted);
  assertEquals(accepted.provider, "openai");
  assertEquals(accepted.model, "gpt-5-mini");
  assertEquals(accepted.proposedProviderPricing?.provider, "openai");
  assertEquals(accepted.proposedProviderPricing?.model, "gpt-5-mini");
  assertEquals(accepted.provenance.provider, "openai");
  assertEquals(accepted.provenance.targetModel, "gpt-5-mini");
});

Deno.test("adjudicateProviderPricing: ambiguous cross-provider candidate is rejected", () => {
  const report = adjudicateProviderPricing([
    attempt([{
      apiId: "gpt-5-mini",
      provider: "anthropic",
      model: "gpt-5-mini",
      input: 1,
      output: 8,
    }]),
  ], {
    provider: "openai",
    sourceUrl: SRC,
    extractedAt: "2026-09-11T00:00:00.000Z",
    model: "claude-haiku-4-5",
    current: [{
      provider: "openai",
      model: "gpt-5-mini",
      input: 1,
      output: 8,
      unit: "MTok",
      currency: "USD",
      source: "manual",
    }],
  });

  assertEquals(report.accepted, []);
  assert(report.rejected[0]?.reasons.includes(REASON_PROVIDER_MISMATCH));
  assert(report.rejected[0]?.reasons.includes(REASON_NO_PRIOR));
});

Deno.test("adjudicateProviderPricing: explicit model/apiId mismatch is rejected", () => {
  const report = adjudicateProviderPricing([
    attempt([{
      apiId: "wrong-openai-model",
      provider: "openai",
      model: "gpt-5-mini",
      input: 1,
      output: 8,
    }]),
  ], {
    provider: "openai",
    sourceUrl: SRC,
    extractedAt: "2026-09-11T00:00:00.000Z",
    model: "claude-haiku-4-5",
    current: [{
      provider: "openai",
      model: "wrong-openai-model",
      input: 1,
      output: 8,
      unit: "MTok",
      currency: "USD",
      source: "manual",
    }],
  });

  assertEquals(report.accepted, []);
  assert(report.rejected[0]?.reasons.includes(REASON_MODEL_MISMATCH));
});
