// Per-million-token standard Claude API pricing.
export type ModelPricing = {
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
  unit: "MTok";
  // Per-tier override for the cache-READ multiplier only (Slice 11). Absent means
  // CACHE_READ_MULTIPLIER (0.1×) — the rule for every model but one. Claude Fable
  // 5.1 / Mythos 5.1 publish cache hits at 0.025× base input, and with the rate
  // derived rather than declared a divergence like that is unfalsifiable by
  // construction: nothing diffs an invented number. Encoding it as a field keeps
  // 0.1× the rule and makes 5.1 the stated exception. The 1.25×/2× WRITE
  // multipliers are unchanged and hold for 5.1 too, so there is deliberately no
  // override for them.
  cacheReadMultiplier?: number;
  fast?: {
    input: number;
    output: number;
  };
  // Time-boxed introductory price overlaying the standard price above (E3). The
  // standard `input`/`output` stay the base the price reverts to; `intro` applies
  // iff the *usage* timestamp is on or before `through` (inclusive, UTC day — see
  // getEffectivePricing). Intro cache rates are NOT stored: they derive from
  // `intro.input` via the same 1.25×/0.10× invariant (deriveCacheRates) so a promo
  // can never hand-copy a wrong cache number. `through` is DATA — the price
  // auto-reverts on that date; unlike PRICING_VERIFIED_AS_OF, no human bumps it.
  intro?: {
    input: number;
    output: number;
    through: string; // ISO calendar date, YYYY-MM-DD
  };
};

export type ModelPricingKey = {
  provider: string;
  model: string;
};

export type PricingSource =
  | "built_in"
  | "verified"
  | "manual"
  | "provider_metadata"
  | "models_dev";

export type ProviderModelPricing = ModelPricingKey & {
  input: number;
  output: number;
  cacheCreation?: number;
  cacheRead?: number;
  unit: "MTok";
  currency: "USD";
  source: PricingSource;
  verifiedAt?: string;
  sourceUrl?: string;
  notes?: string;
  effectiveFrom?: string;
  effectiveThrough?: string;
};

export type PricingStatus = "priced" | "unpriced";

export interface CostResult {
  costUsd: number | null;
  pricingStatus: PricingStatus;
  pricing: ModelPricing | null;
}

export interface ProviderCostResult {
  costUsd: number | null;
  pricingStatus: PricingStatus;
  pricing: ProviderModelPricing | null;
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

// The cache-rate invariant every PRICING row (and every intro overlay) satisfies:
// cacheCreation = 1.25 × input, cacheRead = 0.1 × input. Defined here — the base —
// so both cost calc and the E2 drift check derive rather than hand-copy; E2
// re-exports these from pricing-refresh.ts to keep its public import path stable.
export const CACHE_CREATION_MULTIPLIER = 1.25;
export const CACHE_READ_MULTIPLIER = 0.1;

// Anthropic's extended cache TTL writes at 2x input instead of the 5-minute
// ephemeral 1.25x. The PRICING rows (and deriveCacheRates below) encode the 5m
// relationship — an E2 drift check asserts it — so the 1h rate is applied at the
// point of COST COMPUTATION, by scaling the table's cacheCreation by
// CACHE_CREATION_1H_MULTIPLIER / CACHE_CREATION_MULTIPLIER. Without this, anything
// written at ttl "1h" (the refute cache prefix, docs/agent-cost-reduction.md §4.5)
// under-reports its cache writes by 37.5% in the model-usage ledger.
export const CACHE_CREATION_1H_MULTIPLIER = 2.0;

// Which cache TTL a request's cache writes were made at. Absent everywhere means
// "5m" — the default breakpoint and the rate the table encodes.
export type CacheTtl = "5m" | "1h";

// Factor to scale a 5m-based cacheCreation rate by for the given TTL.
export function cacheCreationTtlFactor(ttl: CacheTtl | undefined): number {
  return ttl === "1h"
    ? CACHE_CREATION_1H_MULTIPLIER / CACHE_CREATION_MULTIPLIER
    : 1;
}

// Round to 4 decimals so derived rates land on clean numbers (0.1 × 0.8 → 0.08)
// instead of float noise.
function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

// Derive cache rates from input via the invariant. The single place the
// 1.25×/0.10× rule is applied, so neither a table refresh nor an intro overlay
// hand-copies cache numbers. `cacheReadMultiplier` is the per-tier exception
// (ModelPricing.cacheReadMultiplier); omitted or undefined it is the 0.1× rule.
export function deriveCacheRates(
  input: number,
  cacheReadMultiplier: number = CACHE_READ_MULTIPLIER,
): { cacheCreation: number; cacheRead: number } {
  return {
    cacheCreation: round4(input * CACHE_CREATION_MULTIPLIER),
    cacheRead: round4(input * cacheReadMultiplier),
  };
}

// The published cache-read multiplier for Claude Fable 5.1 / Mythos 5.1: 0.025×
// base input ($0.25/MTok against $10 input), per pricing.md's footnote 1 and its
// prompt-caching multiplier table. Every other model is CACHE_READ_MULTIPLIER.
export const FABLE_51_CACHE_READ_MULTIPLIER = 0.025;

// ISO date a human last verified PRICING against the published docs table.
// Feature E2 (scripts/refresh-pricing.ts) *reports* drift vs the docs; it never
// rewrites PRICING. When a human confirms the table (or applies a reported
// change), they edit PRICING and bump this date by hand. Surfaced wherever
// prices are reported so consumers can see how fresh the numbers are.
export const PRICING_VERIFIED_AS_OF = "2026-09-13";

// The built-in seed pricing table (Stage 2B Slice 1). Once the code-only source of
// truth, now the *default* the config overlay falls back to per tier: an empty
// config resolves byte-identical to these values. A config entry for a tier
// overrides its row wholesale (see the provider seam + getPricingTable below); a
// tier absent from config keeps its seed. Slices 2/3 populate config via the
// research agent + verification gate — this slice only moves storage, no price
// changes.
const DEFAULT_PRICING = {
  // Claude Fable 5.1 / Mythos 5.1 — same $10/$50 and the same 1.25×/2× cache
  // writes as Fable 5, but cache READS at 0.025× ($0.25/MTok) instead of 0.1×.
  // A separate tier rather than a field on `fable5` because the resolver keys on
  // the id and the two generations genuinely price differently.
  fable51: {
    input: 10,
    output: 50,
    cacheCreation: 12.50,
    cacheRead: 0.25,
    cacheReadMultiplier: FABLE_51_CACHE_READ_MULTIPLIER,
    unit: "MTok",
  },
  fable5: {
    input: 10,
    output: 50,
    cacheCreation: 12.50,
    cacheRead: 1,
    unit: "MTok",
  },
  opus5: {
    input: 5,
    output: 25,
    cacheCreation: 6.25,
    cacheRead: 0.50,
    unit: "MTok",
  },
  opus48: {
    input: 5,
    output: 25,
    cacheCreation: 6.25,
    cacheRead: 0.50,
    unit: "MTok",
    fast: { input: 10, output: 50 },
  },
  opus46Or47: {
    input: 5,
    output: 25,
    cacheCreation: 6.25,
    cacheRead: 0.50,
    unit: "MTok",
    fast: { input: 30, output: 150 },
  },
  opus45: {
    input: 5,
    output: 25,
    cacheCreation: 6.25,
    cacheRead: 0.50,
    unit: "MTok",
  },
  opusLegacy: {
    input: 15,
    output: 75,
    cacheCreation: 18.75,
    cacheRead: 1.50,
    unit: "MTok",
  },
  // Sonnet 4.x (4, 4.5, 4.6) — $3/$15, which is where the whole Sonnet line sat
  // until Sonnet 5 came in under it. Split out of `sonnet` on 2026-09-13: one tier
  // can no longer cover both, and leaving them merged bills one generation or the
  // other 50% wrong whichever price the shared tier carries. Found by the overlay
  // audit (core/pricing-audit.ts), which flagged models.dev's $3/$15
  // claude-sonnet-4-5 / -4-6 rows being shadowed by a $2/$10 built-in tier.
  sonnet4x: {
    input: 3,
    output: 15,
    cacheCreation: 3.75,
    cacheRead: 0.30,
    unit: "MTok",
  },
  sonnet: {
    // $2/$10 is the STANDARD price, not a promo. It launched as introductory
    // pricing through 2026-08-31; on 2026-09-13 pricing.md
    // (#claude-sonnet-5-introductory-pricing) says the scheduled increase to
    // $3/$15 "will not occur" and $2/$10 "is now the standard price". So the
    // `intro` overlay that used to live here is gone — an expired overlay over a
    // $3/$15 base billed every Sonnet 5 call 50% HEAVY (see
    // docs/pricing-audit-slice10.md). No intro overlay is currently live for any
    // tier; the E3 mechanism stays, it just has no data.
    input: 2,
    output: 10,
    cacheCreation: 2.50,
    cacheRead: 0.20,
    unit: "MTok",
  },
  haiku45: {
    input: 1,
    output: 5,
    cacheCreation: 1.25,
    cacheRead: 0.10,
    unit: "MTok",
  },
  haikuLegacy: {
    input: 0.80,
    output: 4,
    cacheCreation: 1,
    cacheRead: 0.08,
    unit: "MTok",
  },
} satisfies Record<string, ModelPricing>;

// The concrete pricing tier keys. Exported so the E2 drift-check (which diffs the
// docs table against every tier) shares one source of truth with getModelPricing.
export type PricingTier = keyof typeof DEFAULT_PRICING;

// The config overlay seam (Stage 2B Slice 1). usage.ts is pure and must NOT import
// config.ts (config.ts already imports usage.ts — the reverse would cycle across
// the layer). Mirroring setPricingDriftWarnHandler below, the composition root
// (core/project-loader.ts) injects a provider that reads config.pricingTable; here
// the default is a no-op returning {}, so with nothing wired every price is the
// seed. A returned entry overrides DEFAULT_PRICING[tier] WHOLESALE (not a field
// merge); absent tiers fall back to the seed.
type PricingTableProvider = () => Partial<Record<PricingTier, ModelPricing>>;
type ProviderModelPricingTableProvider = () => readonly ProviderModelPricing[];
const TRUSTED_NON_ANTHROPIC_CONFIG_SOURCES: readonly PricingSource[] = [
  "verified",
  "manual",
  "models_dev",
];

let pricingTableProvider: PricingTableProvider = () => ({});
let providerModelPricingTableProvider: ProviderModelPricingTableProvider =
  () => [];

export function setPricingTableProvider(fn: PricingTableProvider): void {
  pricingTableProvider = fn;
}

export function setProviderModelPricingTableProvider(
  fn: ProviderModelPricingTableProvider,
): void {
  providerModelPricingTableProvider = fn;
}

// The effective price for one tier: the config override if present, else the seed.
// The single place the per-tier overlay is applied, so getModelPricing, the
// unresolvable-model fallback, and the E2 table view can never disagree.
function effectivePricingForTier(tier: PricingTier): ModelPricing {
  return pricingTableProvider()[tier] ?? DEFAULT_PRICING[tier];
}

// Is this row inside its own effective date window at `asOf`? Exported so the
// overlay audit reports the SAME active/inactive verdict the resolver acts on.
export function rowActiveFor(
  row: ProviderModelPricing,
  asOf: Date | undefined,
): boolean {
  if (
    (row.effectiveFrom && !isIsoCalendarDate(row.effectiveFrom)) ||
    (row.effectiveThrough && !isIsoCalendarDate(row.effectiveThrough))
  ) {
    return false;
  }
  const effectiveAsOf = asOf ?? new Date();
  const ms = effectiveAsOf.getTime();
  if (Number.isNaN(ms)) return true;
  const day = effectiveAsOf.toISOString().slice(0, 10);
  if (row.effectiveFrom && day < row.effectiveFrom) return false;
  if (row.effectiveThrough && day > row.effectiveThrough) return false;
  return true;
}

function providerPricingFromModelPricing(
  key: ModelPricingKey,
  pricing: ModelPricing,
  source: PricingSource,
  extra: Partial<ProviderModelPricing> = {},
): ProviderModelPricing {
  return {
    provider: key.provider,
    model: key.model,
    input: pricing.input,
    output: pricing.output,
    cacheCreation: pricing.cacheCreation,
    cacheRead: pricing.cacheRead,
    unit: pricing.unit,
    currency: "USD",
    source,
    ...extra,
  };
}

function isIsoCalendarDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

// Exported for the overlay audit: a row this returns false for is silently
// ignored by the resolver, and "present in config but never consulted" is exactly
// the kind of thing an audit exists to say out loud.
export function trustedConfiguredSourceForProvider(
  row: ProviderModelPricing,
): boolean {
  return row.provider === "anthropic" ||
    TRUSTED_NON_ANTHROPIC_CONFIG_SOURCES.includes(row.source);
}

// A models.dev row is a snapshot with no sense of time: pricingRowsFromModelsDev
// emits no effectiveFrom, so a price scraped while a promotion was live used to
// outrank the curated table forever. That is how Claude Sonnet 5's introductory
// $2/$10 kept billing after 2026-08-31 while this file's own `intro` overlay
// expired on schedule (docs/agent-cost-reduction.md §4.10).
//
// Where the Anthropic tier resolver RECOGNIZES the model, the built-in table
// wins: it is hand-maintained, date-gated, and stamped with
// PRICING_VERIFIED_AS_OF. The scrape still wins wherever it is the only source —
// every non-Anthropic provider, and Anthropic ids the resolver reaches only by
// family fallthrough (res.unknown), where a snapshot beats a guess.
//
// Deliberately NOT done by demoting models_dev in pricingSourceRank: that rank
// also orders `manual` and `verified`, and a global demotion would break the
// OpenAI path, where models.dev is all there is.
// Exported for the overlay audit — the §4.10 shadowing rule is the reason a
// models.dev Anthropic row can be present, well-formed, in-window and still not
// price anything, and the audit has to be able to say which.
export function shadowedByBuiltInAnthropicTier(
  row: ProviderModelPricing,
): boolean {
  if (row.provider !== "anthropic" || row.source !== "models_dev") return false;
  const res = resolvePricingTier(row.model);
  return res !== undefined && !res.unknown;
}

function pricingSourceRank(source: PricingSource): number {
  switch (source) {
    case "manual":
      return 4;
    case "verified":
      return 3;
    case "models_dev":
      return 2;
    case "built_in":
      return 1;
    case "provider_metadata":
      return 0;
  }
}

// Read-only view of the EFFECTIVE (config-overlaid) pricing table for the E2 diff.
// Reflects what's actually charged — the drift check compares the docs against real
// prices, not just the seed — so it re-reads the overlay on every call rather than
// snapshotting a const. Do NOT mutate the returned rows.
// Read-only view of the EFFECTIVE provider/model overlay rows — the second,
// higher-precedence table getPricingTable knows nothing about. The overlay twin of
// getPricingTable, and the input to the Slice-10 overlay audit
// (core/pricing-audit.ts): the audit must see exactly the rows the resolver
// consults, not a second independent read of config. Do NOT mutate the rows.
export function getProviderModelPricingRowsView(): readonly ProviderModelPricing[] {
  return providerModelPricingTableProvider();
}

export function getPricingTable(): Readonly<Record<PricingTier, ModelPricing>> {
  const table = {} as Record<PricingTier, ModelPricing>;
  for (const tier of Object.keys(DEFAULT_PRICING) as PricingTier[]) {
    table[tier] = effectivePricingForTier(tier);
  }
  return table;
}

// Explicitly-known legacy ids that stay on the older, higher price. Any other id
// in the same family defaults to the CURRENT tier (never silently to legacy).
const LEGACY_OPUS_IDS = [
  "claude-opus-4-1",
  "claude-opus-4-0",
  "claude-3-opus",
] as const;
const LEGACY_HAIKU_IDS = ["claude-3-5-haiku", "claude-3-haiku"] as const;
// Every Sonnet id the resolver has an explicit arm for. Anything else in the
// family still prices as the current tier, but flagged `unknown` so it earns one.
const KNOWN_SONNET_IDS = ["claude-sonnet-5", "claude-sonnet-4"] as const;

function includesAny(model: string, ids: readonly string[]): boolean {
  return ids.some((id) => model.includes(id));
}

// Seam so the composition root can route unknown-model warnings through the
// kernel's structured log (level "warn"). Defaults to no-op; never console.
type PricingDriftWarn = (
  message: string,
  metadata: Record<string, unknown>,
) => void;

let pricingDriftWarn: PricingDriftWarn | undefined;
const warnedModels = new Set<string>();
const warnedUnpricedModels = new Set<string>();

export function setPricingDriftWarnHandler(
  fn: PricingDriftWarn | undefined,
): void {
  pricingDriftWarn = fn;
}

function warnUnknownModel(
  model: string,
  family: string,
  appliedTier: string,
): void {
  if (warnedModels.has(model)) return; // warn once per id — this runs per cost calc
  warnedModels.add(model);
  pricingDriftWarn?.(
    `Unknown ${family} model "${model}"; applying current ${family} pricing ` +
      `(${appliedTier} tier). Update PRICING in core/usage.ts.`,
    { model, family, appliedTier },
  );
}

function warnUnpricedModel(model: string): void {
  if (warnedUnpricedModels.has(model)) return;
  warnedUnpricedModels.add(model);
  pricingDriftWarn?.(
    `No pricing found for model "${model}"; usage cost is unpriced.`,
    { model, pricingStatus: "unpriced" },
  );
}

function warnUnpricedProviderModel(
  provider: ModelPricingKey["provider"],
  model: string,
  reason = "missing-pricing-row",
): void {
  const key = `${provider}:${model}:${reason}`;
  if (warnedUnpricedModels.has(key)) return;
  warnedUnpricedModels.add(key);
  pricingDriftWarn?.(
    `No pricing found for ${provider} model "${model}"; usage cost is unpriced.`,
    { provider, model, reason, pricingStatus: "unpriced" },
  );
}

// The family a tier belongs to, used to phrase the unknown-model drift warning.
const TIER_FAMILY: Record<PricingTier, string> = {
  fable51: "fable",
  fable5: "fable",
  opus5: "opus",
  opus48: "opus",
  opus46Or47: "opus",
  opus45: "opus",
  opusLegacy: "opus",
  sonnet: "sonnet",
  sonnet4x: "sonnet",
  haiku45: "haiku",
  haikuLegacy: "haiku",
};

// Resolution of a model id to a PRICING tier. `unknown` marks an in-family id that
// matched only the family fallthrough (no explicit arm) — it still gets the current
// tier, but flags that the id ought to earn an explicit arm.
export type TierResolution = { tier: PricingTier; unknown: boolean };

// The single id→tier mapping. Pure (no side effects): getModelPricing wraps it to
// emit the runtime drift warning; the E2 diff wraps it to map doc API-ids to tiers.
// Both consumers share this, so they can never disagree about which tier an id is.
export function resolvePricingTier(model: string): TierResolution | undefined {
  // 5.1 MUST come first: "claude-fable-5-1".includes("claude-fable-5") is true,
  // so the order below is the whole mapping. Same shape as the
  // claude-sonnet-5 / claude-sonnet-4 arms further down.
  if (
    model.includes("claude-fable-5-1") || model.includes("claude-mythos-5-1")
  ) {
    return { tier: "fable51", unknown: false };
  }
  if (model.includes("claude-fable-5") || model.includes("claude-mythos-5")) {
    return { tier: "fable5", unknown: false };
  }

  // Opus — explicit current tiers, then known legacy, then a safe default.
  if (model.includes("claude-opus-5")) return { tier: "opus5", unknown: false };
  if (model.includes("claude-opus-4-8")) {
    return { tier: "opus48", unknown: false };
  }
  if (model.includes("claude-opus-4-7") || model.includes("claude-opus-4-6")) {
    return { tier: "opus46Or47", unknown: false };
  }
  if (model.includes("claude-opus-4-5")) {
    return { tier: "opus45", unknown: false };
  }
  if (includesAny(model, LEGACY_OPUS_IDS)) {
    return { tier: "opusLegacy", unknown: false };
  }
  if (model.includes("claude-opus")) return { tier: "opus5", unknown: true };

  // Sonnet — the 4.x generation stayed at $3/$15 when Sonnet 5 landed at $2/$10,
  // so the family needs two arms. An unrecognized id still gets the CURRENT tier
  // (never silently the cheaper or the dearer one) but is flagged.
  if (model.includes("claude-sonnet-5")) {
    return { tier: "sonnet", unknown: false };
  }
  if (model.includes("claude-sonnet-4")) {
    return { tier: "sonnet4x", unknown: false };
  }
  if (model.includes("claude-sonnet")) {
    return { tier: "sonnet", unknown: !includesAny(model, KNOWN_SONNET_IDS) };
  }

  // Haiku — current tier explicit, known legacy explicit, safe default otherwise.
  if (model.includes("claude-haiku-4-5")) {
    return { tier: "haiku45", unknown: false };
  }
  if (includesAny(model, LEGACY_HAIKU_IDS)) {
    return { tier: "haikuLegacy", unknown: false };
  }
  if (model.includes("claude-haiku")) return { tier: "haiku45", unknown: true };

  return undefined;
}

// The pricing tiers that mark a model as retired/deep-legacy: the older, higher
// Opus/Haiku prices no one should pick for new work. Reused by the E4 picker
// hygiene (config.ts) to hide these from the role dropdowns.
const DEEP_LEGACY_TIERS: readonly PricingTier[] = ["opusLegacy", "haikuLegacy"];

// Older Claude lines that predate the current family tiers and so resolve to no
// tier at all (claude-2.x, Claude Instant, the pre-4 Sonnet generations). Also
// deep-legacy for the picker. Substring-matched, like resolvePricingTier.
const DEEP_LEGACY_MODEL_IDS = [
  "claude-2",
  "claude-instant",
  "claude-3-sonnet",
  "claude-3-5-sonnet",
  "claude-3-7-sonnet",
] as const;

// Feature E4 — is this a retired/deep-legacy model that the picker should hide?
// DISPLAY-ONLY: this never touches pricing or role resolution — a deep-legacy id
// still prices via getModelPricing and resolves via resolvePricingTier exactly as
// before. Built on the same legacy signal the pricing table already encodes
// (opusLegacy/haikuLegacy tiers + the LEGACY_*_IDS lists), so the two can't
// diverge. A freshly launched in-family model is never deep-legacy.
export function isDeepLegacyModel(model: string): boolean {
  const tier = resolvePricingTier(model)?.tier;
  if (tier && DEEP_LEGACY_TIERS.includes(tier)) return true;
  return includesAny(model, DEEP_LEGACY_MODEL_IDS);
}

// Base/standard (sticker) price for a model, date-independent. Callers that want
// the price a promo reverts to — labels, the E2 drift table — use this. Cost
// calculation uses getEffectivePricing instead, so a live intro is actually
// billed.
export function getModelPricing(model: string): ModelPricing | undefined {
  const res = resolvePricingTier(model);
  if (!res) return undefined;
  if (res.unknown) {
    warnUnknownModel(model, TIER_FAMILY[res.tier], res.tier);
  }
  return effectivePricingForTier(res.tier);
}

// The cache-read multiplier in force for a model id: the tier's override if it
// declares one, else the 0.1× rule. Exported for the consumers that derive a cache
// rate from an id rather than from a ModelPricing row it already holds — the
// provider-row path in core/pricing-verify.ts. Keeping it here means the exception
// is looked up through the SAME resolver that prices the call, so the two cannot
// disagree about which ids are 5.1.
export function cacheReadMultiplierForModel(model: string): number {
  const res = resolvePricingTier(model);
  if (!res) return CACHE_READ_MULTIPLIER;
  return effectivePricingForTier(res.tier).cacheReadMultiplier ??
    CACHE_READ_MULTIPLIER;
}

// Whether an intro overlay is live for a given moment. Inclusive through the whole
// `through` calendar day, compared in UTC: ISO date strings sort lexicographically,
// so there is no time-of-day or DST ambiguity — the boundary is deterministic.
// An unparseable `asOf` (Invalid Date) is treated as "not active", so a bad
// timestamp bills the safe standard price rather than a wrongly-applied promo.
function isIntroActive(
  intro: NonNullable<ModelPricing["intro"]>,
  asOf: Date,
): boolean {
  const ms = asOf.getTime();
  if (Number.isNaN(ms)) return false;
  const asOfDay = asOf.toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
  return asOfDay <= intro.through;
}

// Date-aware price resolution: the introductory price iff `asOf` is on or before
// the intro's `through` date, otherwise the standard/base price. `asOf` is the
// timestamp of the *usage* being costed (not report-time now) — so a price that
// has since reverted still bills correctly for usage that happened inside the
// window, and backfilled/replayed usage is never mis-billed.
export function getEffectivePricing(
  model: string,
  asOf: Date,
): ModelPricing | undefined {
  const base = getModelPricing(model);
  if (!base?.intro || !isIntroActive(base.intro, asOf)) return base;
  const derived = deriveCacheRates(
    base.intro.input,
    base.cacheReadMultiplier,
  );
  return {
    ...base,
    input: base.intro.input,
    output: base.intro.output,
    cacheCreation: derived.cacheCreation,
    cacheRead: derived.cacheRead,
  };
}

function configuredProviderModelPricing(
  provider: ModelPricingKey["provider"],
  model: string,
  asOf?: Date,
): ProviderModelPricing | undefined {
  return providerModelPricingTableProvider()
    .filter((row) =>
      row.provider === provider &&
      row.model === model &&
      trustedConfiguredSourceForProvider(row) &&
      !shadowedByBuiltInAnthropicTier(row) &&
      rowActiveFor(row, asOf)
    )
    .toSorted((a, b) => {
      const rankCmp = pricingSourceRank(b.source) -
        pricingSourceRank(a.source);
      if (rankCmp !== 0) return rankCmp;
      const fromCmp = (b.effectiveFrom ?? "").localeCompare(
        a.effectiveFrom ?? "",
      );
      if (fromCmp !== 0) return fromCmp;
      return (b.effectiveThrough ?? "").localeCompare(a.effectiveThrough ?? "");
    })[0];
}

// Provider-aware sticker/effective price lookup. Exact config rows win first. For
// Anthropic, the existing Claude tier resolver seeds provider-aware rows from the
// same effective legacy table, including config tier overrides and unknown-family
// warnings. OpenAI has no built-in rows in this slice, so absent config means
// explicitly unpriced.
// The BUILT-IN half of getProviderModelPricing: what the curated Anthropic tier
// table alone would charge, with every configured overlay row ignored. Pure — the
// unknown-model warning deliberately stays in getProviderModelPricing so the
// overlay audit can ask this question without spraying drift warnings. Exported
// for core/pricing-audit.ts, which has to compare an overlay row against the same
// fallback the resolver would actually use, not a reimplementation of it.
export function builtInProviderModelPricing(
  provider: ModelPricingKey["provider"],
  model: string,
  asOf?: Date,
): ProviderModelPricing | undefined {
  if (provider !== "anthropic") return undefined;
  const res = resolvePricingTier(model);
  if (!res) return undefined;

  const base = effectivePricingForTier(res.tier);
  if (asOf && base.intro && isIntroActive(base.intro, asOf)) {
    const derived = deriveCacheRates(
      base.intro.input,
      base.cacheReadMultiplier,
    );
    return providerPricingFromModelPricing(
      { provider, model },
      {
        ...base,
        input: base.intro.input,
        output: base.intro.output,
        cacheCreation: derived.cacheCreation,
        cacheRead: derived.cacheRead,
      },
      "built_in",
      {
        effectiveThrough: base.intro.through,
        notes: "Introductory price active for usage timestamp.",
      },
    );
  }

  return providerPricingFromModelPricing({ provider, model }, base, "built_in");
}

export function getProviderModelPricing(
  provider: ModelPricingKey["provider"],
  model: string,
  asOf?: Date,
): ProviderModelPricing | undefined {
  const configured = configuredProviderModelPricing(provider, model, asOf);
  if (configured) return configured;
  if (provider !== "anthropic") return undefined;

  const res = resolvePricingTier(model);
  if (!res) return undefined;
  if (res.unknown) {
    warnUnknownModel(model, TIER_FAMILY[res.tier], res.tier);
  }
  return builtInProviderModelPricing(provider, model, asOf);
}

function providerModelPricingToModelPricing(
  pricing: ProviderModelPricing,
): ModelPricing | null {
  if (
    pricing.cacheCreation === undefined ||
    pricing.cacheRead === undefined
  ) {
    return null;
  }
  return {
    input: pricing.input,
    output: pricing.output,
    cacheCreation: pricing.cacheCreation,
    cacheRead: pricing.cacheRead,
    unit: pricing.unit,
  };
}

export function computeProviderModelCost(input: {
  provider: ModelPricingKey["provider"];
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  asOf: Date;
  // TTL the cache writes were made at; omitted = the 5m default the table encodes.
  cacheTtl?: CacheTtl;
}): ProviderCostResult {
  const pricing = getProviderModelPricing(
    input.provider,
    input.model,
    input.asOf,
  );
  if (!pricing) {
    warnUnpricedProviderModel(input.provider, input.model);
    return { costUsd: null, pricingStatus: "unpriced", pricing: null };
  }
  if (
    (input.cacheCreationInputTokens > 0 &&
      pricing.cacheCreation === undefined) ||
    (input.cacheReadInputTokens > 0 && pricing.cacheRead === undefined)
  ) {
    warnUnpricedProviderModel(
      input.provider,
      input.model,
      "missing-cache-pricing",
    );
    return { costUsd: null, pricingStatus: "unpriced", pricing: null };
  }
  // The table's cacheCreation is the 5m rate; a 1h write costs 2x input, not 1.25x.
  const cacheCreationRate = (pricing.cacheCreation ?? 0) *
    cacheCreationTtlFactor(input.cacheTtl);
  return {
    costUsd: (input.inputTokens / 1_000_000) * pricing.input +
      (input.outputTokens / 1_000_000) * pricing.output +
      (input.cacheCreationInputTokens / 1_000_000) * cacheCreationRate +
      (input.cacheReadInputTokens / 1_000_000) * (pricing.cacheRead ?? 0),
    pricingStatus: "priced",
    pricing,
  };
}

// Legacy Anthropic-only status-aware cost of already-recorded usage. Prefer
// computeProviderModelCost for new/runtime call sites so exact provider/model config
// rows can be applied.
export function computeCostUsdWithStatus(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheCreationInputTokens: number,
  cacheReadInputTokens: number,
  asOf: Date,
  cacheTtl?: CacheTtl,
): CostResult {
  const cost = computeProviderModelCost({
    provider: "anthropic",
    model,
    inputTokens,
    outputTokens,
    cacheCreationInputTokens,
    cacheReadInputTokens,
    asOf,
    ...(cacheTtl !== undefined ? { cacheTtl } : {}),
  });
  if (!cost.pricing) {
    warnUnpricedModel(model);
    return { costUsd: null, pricingStatus: "unpriced", pricing: null };
  }
  const pricing = providerModelPricingToModelPricing(cost.pricing);
  if (!pricing) {
    return { costUsd: null, pricingStatus: "unpriced", pricing: null };
  }
  return {
    costUsd: cost.costUsd,
    pricingStatus: cost.pricingStatus,
    pricing,
  };
}

// Cost of already-recorded usage. `asOf` is the usage's real timestamp, threaded
// from the caller — required, never a bare `new Date()` here, because these cost
// *past* usage and a report-time default would mis-bill anything backfilled or
// replayed against a since-expired intro price.
//
// Legacy numeric wrapper. Prefer computeProviderModelCost for new/runtime call sites
// so unpriced usage is not confused with a real $0 cost and provider-aware rows can
// be applied.
export function computeCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheCreationInputTokens: number,
  cacheReadInputTokens: number,
  asOf: Date,
): number {
  return computeCostUsdWithStatus(
    model,
    inputTokens,
    outputTokens,
    cacheCreationInputTokens,
    cacheReadInputTokens,
    asOf,
  ).costUsd ?? 0;
}
