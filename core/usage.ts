// Token accounting: what a model call costs. Prices come from models.dev
// (core/model-prices.ts); a model it doesn't list is unpriced, never $0.
import { modelPrice } from "./model-prices.ts";

// Per-million-token price for one model, as the model picker shows it.
export type ModelPricing = {
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
  unit: "MTok";
};

export type ModelPricingKey = {
  provider: string;
  model: string;
};

// USD per million tokens. A missing cache rate means the catalog doesn't list
// one, not that it's free.
export type ProviderModelPricing = ModelPricingKey & {
  input: number;
  output: number;
  cacheCreation?: number;
  cacheRead?: number;
};

export type PricingStatus = "priced" | "unpriced";

export interface ProviderCostResult {
  costUsd: number | null;
  pricingStatus: PricingStatus;
}

// Current model-window occupancy for a provider request. `inputTokens` is the
// uncached input bucket; cache read/write tokens are billed separately but still
// occupy the request window, so pressure math uses all three categories.
export function contextOccupancyTokens(usage: {
  inputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}): number {
  return usage.inputTokens + usage.cacheCreationInputTokens +
    usage.cacheReadInputTokens;
}

// Anthropic cache writes: 1.25× input at the 5-minute TTL, 2× at 1 hour. A
// models.dev `cache_write` is the 5m rate, so a 1h write scales it by 2/1.25.
// Without this, the refute cache prefix (written at "1h") under-reports its cache
// writes by 37.5%.
const CACHE_CREATION_MULTIPLIER = 1.25;
const CACHE_CREATION_1H_MULTIPLIER = 2.0;

// Which cache TTL a request's cache writes were made at. Absent means "5m".
export type CacheTtl = "5m" | "1h";

function cacheCreationTtlFactor(ttl: CacheTtl | undefined): number {
  return ttl === "1h"
    ? CACHE_CREATION_1H_MULTIPLIER / CACHE_CREATION_MULTIPLIER
    : 1;
}

// Routes the unpriced-model warning into the kernel's structured log. No-op until
// a composition root installs it; never console.
type UnpricedModelWarn = (
  message: string,
  metadata: Record<string, unknown>,
) => void;

let unpricedModelWarn: UnpricedModelWarn | undefined;
const warnedUnpriced = new Set<string>();

export function setUnpricedModelWarnHandler(
  fn: UnpricedModelWarn | undefined,
): void {
  unpricedModelWarn = fn;
}

function warnUnpriced(provider: string, model: string, reason: string): void {
  const key = `${provider}:${model}:${reason}`;
  if (warnedUnpriced.has(key)) return;
  warnedUnpriced.add(key);
  unpricedModelWarn?.(
    `No models.dev price for ${provider} model "${model}" (${reason}); ` +
      `its usage is recorded unpriced.`,
    { provider, model, reason, pricingStatus: "unpriced" },
  );
}

const UNPRICED: ProviderCostResult = {
  costUsd: null,
  pricingStatus: "unpriced",
};

export function computeProviderModelCost(input: {
  provider: ModelPricingKey["provider"];
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  // TTL the cache writes were made at; omitted = 5m.
  cacheTtl?: CacheTtl;
}): ProviderCostResult {
  const pricing = modelPrice(input.provider, input.model);
  if (!pricing) {
    warnUnpriced(input.provider, input.model, "not-listed");
    return UNPRICED;
  }
  if (
    (input.cacheCreationInputTokens > 0 &&
      pricing.cacheCreation === undefined) ||
    (input.cacheReadInputTokens > 0 && pricing.cacheRead === undefined)
  ) {
    warnUnpriced(input.provider, input.model, "missing-cache-price");
    return UNPRICED;
  }
  const cacheCreationRate = (pricing.cacheCreation ?? 0) *
    cacheCreationTtlFactor(input.cacheTtl);
  return {
    costUsd: (input.inputTokens / 1_000_000) * pricing.input +
      (input.outputTokens / 1_000_000) * pricing.output +
      (input.cacheCreationInputTokens / 1_000_000) * cacheCreationRate +
      (input.cacheReadInputTokens / 1_000_000) * (pricing.cacheRead ?? 0),
    pricingStatus: "priced",
  };
}
