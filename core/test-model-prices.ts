// Fixed prices for tests that need a model priced. Without this they read the
// real models.dev cache under HOME, and pass or fail depending on the machine.
import { setModelPriceRowsForTest } from "./model-prices.ts";
import type { ProviderModelPricing } from "./usage.ts";

function anthropic(
  model: string,
  input: number,
  output: number,
): ProviderModelPricing {
  return {
    provider: "anthropic",
    model,
    input,
    output,
    cacheCreation: input * 1.25,
    cacheRead: input * 0.1,
  };
}

const TEST_MODEL_PRICES: readonly ProviderModelPricing[] = [
  anthropic("claude-sonnet-5", 2, 10),
  anthropic("claude-opus-5", 5, 25),
  anthropic("claude-opus-4-8", 5, 25),
  anthropic("claude-haiku-4-5-20251001", 1, 5),
];

export async function withTestModelPrices(
  fn: () => void | Promise<void>,
): Promise<void> {
  setModelPriceRowsForTest(TEST_MODEL_PRICES);
  try {
    await fn();
  } finally {
    setModelPriceRowsForTest(undefined);
  }
}
