// The one price lookup: models.dev's catalog, read from the local cache
// (~/.config/opentide/models-dev-cache.json, refreshed daily). Exact
// provider + model id match. No built-in table, no overlay, no date window: a
// stale catalog beats no price, and a model it doesn't list is unpriced.
import { pricingRowsFromModelsDev } from "./models-dev.ts";
import type { ProviderModelPricing } from "./usage.ts";

let rowsForTest: readonly ProviderModelPricing[] | undefined;
let index:
  | {
    rows: readonly ProviderModelPricing[];
    byKey: Map<string, ProviderModelPricing>;
  }
  | undefined;

function key(provider: string, model: string): string {
  return `${provider}\u0000${model}`;
}

// pricingRowsFromModelsDev is memoized on the cache file's mtime + size, so
// the same array comes back until the file changes; the map is rebuilt only then.
function priceIndex(): Map<string, ProviderModelPricing> {
  const rows = rowsForTest ?? pricingRowsFromModelsDev();
  if (index?.rows === rows) return index.byKey;
  const byKey = new Map<string, ProviderModelPricing>();
  for (const row of rows) byKey.set(key(row.provider, row.model), row);
  index = { rows, byKey };
  return byKey;
}

export function modelPrice(
  provider: string,
  model: string,
): ProviderModelPricing | undefined {
  return priceIndex().get(key(provider, model));
}

// Tests price against fixed rows instead of the real cache. Pass undefined to
// restore.
export function setModelPriceRowsForTest(
  rows: readonly ProviderModelPricing[] | undefined,
): void {
  rowsForTest = rows;
}
