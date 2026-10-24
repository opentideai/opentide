import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { userConfigDir } from "./user-config-dir.ts";
import type { ProviderModelPricing } from "./usage.ts";

export const MODELS_DEV_API_URL = "https://models.dev/api.json";
export const MODELS_DEV_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
export const MODELS_DEV_SOURCE_URL = MODELS_DEV_API_URL;

// How long a models.dev snapshot is allowed to go on pricing anything. The
// catalog carries no expiry of its own — every row is only "true as of the
// fetch" — so an unbounded row silently outlives whatever it recorded. That is
// the general shape of the Sonnet 5 intro-price bug (see usage.ts
// shadowedByBuiltInAnthropicTier); the tier-collision fix only covers models the
// built-in table already knows. Rows therefore get an effectiveThrough of
// fetch-date + this window, past which rowActiveFor drops them and pricing
// degrades to the built-in table — or to explicitly unpriced, for providers that
// have no built-in rows.
//
// Much longer than MODELS_DEV_CACHE_TTL_MS on purpose: that TTL decides when to
// re-fetch on a healthy machine, this one bounds a catalog nobody has refreshed
// in a month.
export const MODELS_DEV_ROW_MAX_AGE_DAYS = 30;

export interface ModelsDevModel {
  id: string;
  name?: string;
  family?: string;
  modalities?: { input?: string[]; output?: string[] };
  toolCall?: boolean;
  structuredOutput?: boolean;
  reasoning?: boolean;
  attachment?: boolean;
  lastUpdated?: string;
  releaseDate?: string;
  contextWindow?: number;
  outputLimit?: number;
  cost?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
}

export interface ModelsDevProvider {
  id: string;
  name: string;
  api?: string;
  npm?: string;
  env: string[];
  models: Record<string, ModelsDevModel>;
}

export interface ModelsDevCatalog {
  providers: Record<string, ModelsDevProvider>;
  fetchedAt: string;
}

interface ModelsDevCacheFile {
  cachedAt?: string;
  catalog?: unknown;
}

function modelsDevCachePath(): string {
  return join(userConfigDir(), "models-dev-cache.json");
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string =>
      typeof item === "string" && item.trim() !== ""
    )
    : [];
}

function normalizeModel(
  raw: unknown,
  fallbackId: string,
): ModelsDevModel | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const id = typeof row.id === "string" && row.id.trim()
    ? row.id.trim()
    : fallbackId.trim();
  if (!id) return null;
  const limit = row.limit && typeof row.limit === "object"
    ? row.limit as Record<string, unknown>
    : {};
  const cost = row.cost && typeof row.cost === "object"
    ? row.cost as Record<string, unknown>
    : {};
  const modalities = row.modalities && typeof row.modalities === "object"
    ? row.modalities as Record<string, unknown>
    : undefined;
  return {
    id,
    ...(typeof row.name === "string" && row.name.trim()
      ? { name: row.name.trim() }
      : {}),
    ...(typeof row.family === "string" && row.family.trim()
      ? { family: row.family.trim() }
      : {}),
    ...(modalities
      ? {
        modalities: {
          input: stringArray(modalities.input),
          output: stringArray(modalities.output),
        },
      }
      : {}),
    ...(typeof row.tool_call === "boolean" ? { toolCall: row.tool_call } : {}),
    ...(typeof row.structured_output === "boolean"
      ? { structuredOutput: row.structured_output }
      : {}),
    ...(typeof row.reasoning === "boolean" ? { reasoning: row.reasoning } : {}),
    ...(typeof row.attachment === "boolean"
      ? { attachment: row.attachment }
      : {}),
    ...(typeof row.last_updated === "string"
      ? { lastUpdated: row.last_updated }
      : {}),
    ...(typeof row.release_date === "string"
      ? { releaseDate: row.release_date }
      : {}),
    ...(positiveNumber(limit.context) !== undefined
      ? { contextWindow: positiveNumber(limit.context) }
      : {}),
    ...(positiveNumber(limit.output) !== undefined
      ? { outputLimit: positiveNumber(limit.output) }
      : {}),
    ...(positiveNumber(cost.input) !== undefined ||
        positiveNumber(cost.output) !== undefined ||
        positiveNumber(cost.cache_read) !== undefined ||
        positiveNumber(cost.cache_write) !== undefined
      ? {
        cost: {
          ...(positiveNumber(cost.input) !== undefined
            ? { input: positiveNumber(cost.input) }
            : {}),
          ...(positiveNumber(cost.output) !== undefined
            ? { output: positiveNumber(cost.output) }
            : {}),
          ...(positiveNumber(cost.cache_read) !== undefined
            ? { cacheRead: positiveNumber(cost.cache_read) }
            : {}),
          ...(positiveNumber(cost.cache_write) !== undefined
            ? { cacheWrite: positiveNumber(cost.cache_write) }
            : {}),
        },
      }
      : {}),
  };
}

export function parseModelsDevCatalog(
  raw: unknown,
  fetchedAt = new Date(),
): ModelsDevCatalog {
  const stableFetchedAt = Number.isNaN(fetchedAt.getTime())
    ? new Date().toISOString()
    : fetchedAt.toISOString();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { providers: {}, fetchedAt: stableFetchedAt };
  }
  const providers: Record<string, ModelsDevProvider> = {};
  for (const [fallbackId, value] of Object.entries(raw)) {
    if (!value || typeof value !== "object") continue;
    const row = value as Record<string, unknown>;
    const id = typeof row.id === "string" && row.id.trim()
      ? row.id.trim()
      : fallbackId.trim();
    if (!id) continue;
    const rawModels = row.models && typeof row.models === "object"
      ? row.models as Record<string, unknown>
      : {};
    const models: Record<string, ModelsDevModel> = {};
    for (const [modelId, model] of Object.entries(rawModels)) {
      const normalized = normalizeModel(model, modelId);
      if (normalized) models[normalized.id] = normalized;
    }
    providers[id] = {
      id,
      name: typeof row.name === "string" && row.name.trim()
        ? row.name.trim()
        : id,
      ...(typeof row.api === "string" && row.api.trim()
        ? { api: row.api.trim() }
        : {}),
      ...(typeof row.npm === "string" && row.npm.trim()
        ? { npm: row.npm.trim() }
        : {}),
      env: stringArray(row.env),
      models,
    };
  }
  return { providers, fetchedAt: stableFetchedAt };
}

// The cache file is megabytes of JSON and this sits on the hot path of EVERY price
// lookup: the kernel injects getProviderModelPricingRows as its overlay provider
// and that provider is re-read per lookup by design, so a write lands immediately.
// Re-parsing per lookup cost ~40ms of pure CPU and made the Slice-10 overlay audit
// (one resolver call per row) take minutes. Memoized on the file's identity —
// mtime + size — so writeModelsDevCache invalidates it for free and an in-memory
// copy can never outlive a write.
let modelsDevCacheMemo:
  | { key: string; catalog: ModelsDevCatalog | null }
  | undefined;

function modelsDevCacheKey(path: string): string | undefined {
  try {
    const stat = statSync(path);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return undefined;
  }
}

function readModelsDevCacheAnyAge(): ModelsDevCatalog | null {
  const path = modelsDevCachePath();
  if (!existsSync(path)) return null;
  const key = modelsDevCacheKey(path);
  if (key !== undefined && modelsDevCacheMemo?.key === key) {
    return modelsDevCacheMemo.catalog;
  }
  let catalog: ModelsDevCatalog | null = null;
  try {
    const cache = JSON.parse(readFileSync(path, "utf-8")) as ModelsDevCacheFile;
    const parsed = parseModelsDevCatalog(
      cache.catalog,
      cache.cachedAt ? new Date(cache.cachedAt) : new Date(),
    );
    catalog = {
      ...parsed,
      fetchedAt: String(cache.cachedAt ?? parsed.fetchedAt),
    };
  } catch {
    catalog = null;
  }
  if (key !== undefined) modelsDevCacheMemo = { key, catalog };
  return catalog;
}

export function readModelsDevCatalogCache(
  maxAgeMs = MODELS_DEV_CACHE_TTL_MS,
): ModelsDevCatalog | null {
  const catalog = readModelsDevCacheAnyAge();
  if (!catalog) return null;
  const ts = Date.parse(catalog.fetchedAt);
  if (Number.isNaN(ts) || Date.now() - ts >= maxAgeMs) return null;
  return catalog;
}

function writeModelsDevCache(raw: unknown, now: Date): void {
  mkdirSync(userConfigDir(), { recursive: true });
  writeFileSync(
    modelsDevCachePath(),
    JSON.stringify({ cachedAt: now.toISOString(), catalog: raw }, null, 2) +
      "\n",
    { mode: 0o600 },
  );
}

export async function refreshModelsDevCatalog(
  fetchImpl: typeof fetch = fetch,
): Promise<ModelsDevCatalog | null> {
  const cached = readModelsDevCatalogCache();
  if (cached) return cached;
  try {
    const now = new Date();
    const res = await fetchImpl(MODELS_DEV_API_URL);
    if (!res.ok) return readModelsDevCacheAnyAge();
    const raw = await res.json();
    writeModelsDevCache(raw, now);
    return parseModelsDevCatalog(raw, now);
  } catch {
    return readModelsDevCacheAnyAge();
  }
}

export function modelFromModelsDev(
  catalog: ModelsDevCatalog | null,
  provider: string,
  model: string,
): ModelsDevModel | undefined {
  return catalog?.providers[provider]?.models[model];
}

// The last calendar day (UTC) a snapshot taken at `fetchedAt` may price usage
// for. Undefined when the timestamp is unreadable — a catalog we cannot date is
// a catalog we cannot bound, so the caller drops it entirely rather than emit
// another immortal row.
function modelsDevRowEffectiveThrough(fetchedAt: string): string | undefined {
  const ms = Date.parse(fetchedAt);
  if (Number.isNaN(ms)) return undefined;
  const expiry = ms + MODELS_DEV_ROW_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  return new Date(expiry).toISOString().slice(0, 10);
}

// Same story as the cache parse: 6,000+ row objects rebuilt per price lookup.
// Keyed on catalog IDENTITY, which the memo above makes stable for an unchanged
// file; a caller passing its own catalog object gets its own memo slot.
let pricingRowsMemo:
  | { catalog: ModelsDevCatalog; rows: ProviderModelPricing[] }
  | undefined;

export function pricingRowsFromModelsDev(
  catalog: ModelsDevCatalog | null = readModelsDevCacheAnyAge(),
): ProviderModelPricing[] {
  if (!catalog) return [];
  if (pricingRowsMemo?.catalog === catalog) return pricingRowsMemo.rows;
  const effectiveThrough = modelsDevRowEffectiveThrough(catalog.fetchedAt);
  if (!effectiveThrough) return [];
  const rows: ProviderModelPricing[] = [];
  for (const provider of Object.values(catalog.providers)) {
    for (const model of Object.values(provider.models)) {
      const input = positiveNumber(model.cost?.input);
      const output = positiveNumber(model.cost?.output);
      if (input === undefined || output === undefined) continue;
      const cacheCreation = positiveNumber(model.cost?.cacheWrite);
      const cacheRead = positiveNumber(model.cost?.cacheRead);
      rows.push({
        provider: provider.id,
        model: model.id,
        input,
        output,
        ...(cacheCreation !== undefined ? { cacheCreation } : {}),
        ...(cacheRead !== undefined ? { cacheRead } : {}),
        unit: "MTok",
        currency: "USD",
        source: "models_dev",
        sourceUrl: MODELS_DEV_SOURCE_URL,
        effectiveThrough,
        ...(model.lastUpdated ? { verifiedAt: model.lastUpdated } : {}),
      });
    }
  }
  pricingRowsMemo = { catalog, rows };
  return rows;
}

export function isOpenAiCompatibleModelsDevProvider(
  provider: ModelsDevProvider,
): boolean {
  if (!provider.api) return false;
  return provider.npm === "@ai-sdk/openai-compatible" ||
    provider.npm === "@ai-sdk/openai";
}
