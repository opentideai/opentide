// @layer core — the pure verification gate behind agent-driven pricing (Stage 2B
// Slice 3, D10 write half). No I/O, no config reads/writes, no network — mirrors
// pricing-refresh.ts. Given the per-attempt tier-assigned candidate lists from the
// research agent (plus an optional corroborating scrape), it decides which tiers may
// be written: a tier is eligible ONLY when every attempt that reported it AGREES on
// input/output (within EPSILON) and the row passes deterministic SANITY BOUNDS. This
// is the "confidence layer instead of a human gate" (D10) — self-correcting when the
// pricing page moves, refusing to write a hallucinated or half-read rate.
//
// The one correctness trap: a written price must PRESERVE the tier's non-scraped
// fields — the `fast` arm (opus48/opus46Or47) and the `intro` overlay (sonnet, E3) —
// which are hand-encoded and never extracted. proposed starts from the current row
// and overlays only input/output + DERIVED cache rates, so fast/intro survive.
import {
  cacheReadMultiplierForModel,
  deriveCacheRates,
  getPricingTable,
  getProviderModelPricing,
  type ModelPricing,
  type PricingTier,
  type ProviderModelPricing,
  resolvePricingTier,
} from "./usage.ts";
import type { ModelProviderId } from "./config.ts";
import { EPSILON, numbersEqual, type ParsedTier } from "./pricing-refresh.ts";
import type {
  PricingCandidate,
  PricingDecision,
  PricingGateReport,
  PricingProvenance,
} from "./types.ts";

export { EPSILON };

// Sanity bounds. A proposed rate is rejected unless it stays within an order of
// magnitude of the current price for that tier (guards a hallucinated or
// misplaced-decimal rate), reads as USD, and reads as per-million-tokens.
const SANITY_LOWER_MULTIPLIER = 0.1; // proposed ≥ 0.1× current
const SANITY_UPPER_MULTIPLIER = 10; // proposed ≤ 10× current
const REQUIRED_CURRENCY = "USD";
const REQUIRED_UNIT = "MTok";

// The rejection reason strings (also the acceptance-explaining absence of them).
// Named so the runner and tests reference them without re-typing the literals.
export const REASON_DISAGREEMENT = "disagreement";
export const REASON_OUTPUT_LT_INPUT = "output<input";
export const REASON_OUT_OF_BOUNDS = "out-of-bounds";
export const REASON_NON_USD = "non-usd";
export const REASON_NON_MTOK = "non-mtok";
export const REASON_NO_PRIOR = "no-prior";
export const REASON_NEGATIVE_RATE = "negative-rate";
export const REASON_PROVIDER_MISMATCH = "provider-mismatch";
export const REASON_MODEL_MISMATCH = "model-mismatch";

export interface AdjudicateOpts {
  // The baseline the sanity bounds compare against AND the source of the fast/intro
  // fields proposed must preserve. Defaults to the live base table (getPricingTable
  // — config overlay applied, intro NOT applied). Typed Partial so a test can model
  // a "new family" tier with no prior by omitting it.
  current?: Readonly<Partial<Record<PricingTier, ModelPricing>>>;
  // The deterministic scrape's parsed rows, or null when it couldn't parse the page
  // (reshaped layout). A row mapping to a tier and matching the agent attempts counts
  // as one more agreeing voter (raising agreement); null simply doesn't vote.
  scrapeRows?: ParsedTier[] | null;
  // Provenance stamped onto every decision (the agent flow threads these from the
  // extraction). Pure — passed in, never read from config here.
  sourceUrl: string;
  extractedAt: string;
  model: string;
}

export interface ProviderAdjudicateOpts {
  provider: ModelProviderId;
  sourceUrl: string;
  extractedAt: string;
  model: string;
  current?: readonly ProviderModelPricing[];
}

// True when a proposed rate falls outside [0.1×, 10×] of the current one.
function outOfBounds(proposed: number, current: number): boolean {
  return proposed < current * SANITY_LOWER_MULTIPLIER ||
    proposed > current * SANITY_UPPER_MULTIPLIER;
}

function providerCandidateModel(c: PricingCandidate): string {
  return c.apiId.trim();
}

// Group the per-attempt candidate lists by tier; untiered rows flow to `unmapped`.
function groupByTier(
  attempts: PricingCandidate[][],
): { byTier: Map<PricingTier, PricingCandidate[]>; unmapped: string[] } {
  const byTier = new Map<PricingTier, PricingCandidate[]>();
  const unmapped = new Set<string>();
  for (const list of attempts) {
    for (const c of list) {
      if (!c.tier) {
        unmapped.add(c.apiId);
        continue;
      }
      const arr = byTier.get(c.tier) ?? [];
      arr.push(c);
      byTier.set(c.tier, arr);
    }
  }
  return { byTier, unmapped: [...unmapped] };
}

// One scrape row per tier (first mapping wins), skipping ids that resolve to no tier
// or only a flagged fallthrough — the same resolvePricingTier the agent maps through,
// so the two voters can never disagree about which tier a row is.
function scrapeByTier(rows: ParsedTier[] | null): Map<PricingTier, ParsedTier> {
  const map = new Map<PricingTier, ParsedTier>();
  if (!rows) return map;
  for (const row of rows) {
    const res = resolvePricingTier(row.apiId);
    if (!res || res.unknown) continue;
    if (!map.has(res.tier)) map.set(res.tier, row);
  }
  return map;
}

function adjudicateTier(
  tier: PricingTier,
  head: PricingCandidate,
  rest: PricingCandidate[],
  prior: ModelPricing | undefined,
  scrape: ParsedTier | undefined,
  opts: AdjudicateOpts,
): PricingDecision {
  const reasons: string[] = [];

  // Agreement across every attempt that reported this tier.
  const attemptsAgree = rest.every((c) =>
    numbersEqual(c.input, head.input) && numbersEqual(c.output, head.output)
  );
  if (!attemptsAgree) reasons.push(REASON_DISAGREEMENT);

  // The scrape votes only when it read the same rate the attempts did.
  const scrapeAgrees = !!scrape &&
    numbersEqual(scrape.input, head.input) &&
    numbersEqual(scrape.output, head.output);
  const agreement = 1 + rest.length + (scrapeAgrees ? 1 : 0);

  // Sanity bounds — only meaningful with a prior to bound against.
  if (!prior) {
    reasons.push(REASON_NO_PRIOR);
  } else {
    if (head.currency !== REQUIRED_CURRENCY) reasons.push(REASON_NON_USD);
    if (head.unit !== REQUIRED_UNIT) reasons.push(REASON_NON_MTOK);
    if (head.output < head.input) reasons.push(REASON_OUTPUT_LT_INPUT);
    if (
      outOfBounds(head.input, prior.input) ||
      outOfBounds(head.output, prior.output)
    ) {
      reasons.push(REASON_OUT_OF_BOUNDS);
    }
  }

  const proposed = buildProposed(head, prior);
  const provenance: PricingProvenance = {
    sourceUrl: head.source || opts.sourceUrl,
    extractedAt: opts.extractedAt,
    model: opts.model,
    agreement,
  };

  return {
    tier,
    apiId: head.apiId,
    proposed,
    accepted: reasons.length === 0,
    agreement,
    reasons,
    provenance,
  };
}

// Materialize the proposed row. WITH a prior we start from it and overlay ONLY
// input/output + derived cache — so `fast` and `intro` (and unit) survive untouched;
// this is the invariant the tests assert. WITHOUT a prior (no-prior; never written)
// we still build a bare row for the report. Cache rates ONLY ever come from
// deriveCacheRates — an extracted cache number can never enter the table.
function buildProposed(
  c: PricingCandidate,
  prior: ModelPricing | undefined,
): ModelPricing {
  // The prior row carries the tier's cache-read override (Slice 11); the spread
  // below preserves the field itself, and this keeps the derived rate consistent
  // with it. Without a prior there is no override to honour — 0.1×.
  const derived = deriveCacheRates(c.input, prior?.cacheReadMultiplier);
  if (!prior) {
    return {
      input: c.input,
      output: c.output,
      cacheCreation: derived.cacheCreation,
      cacheRead: derived.cacheRead,
      unit: REQUIRED_UNIT,
    };
  }
  return {
    ...prior, // preserves fast + intro + unit
    input: c.input,
    output: c.output,
    cacheCreation: derived.cacheCreation,
    cacheRead: derived.cacheRead,
  };
}

// The pure gate. Adjudicates each tier the attempts reported, returning a report
// partitioned into accepted (write-eligible) and rejected (surfaced with reasons)
// decisions plus the untiered `unmapped` ids. No I/O — the agent flow performs the
// actual write behind this, only for accepted decisions in apply mode.
export function adjudicatePricing(
  attempts: PricingCandidate[][],
  opts: AdjudicateOpts,
): PricingGateReport {
  const current = opts.current ?? getPricingTable();
  const { byTier, unmapped } = groupByTier(attempts);
  const scrape = scrapeByTier(opts.scrapeRows ?? null);

  const decisions: PricingDecision[] = [];
  for (const [tier, cands] of byTier) {
    const [head, ...rest] = cands;
    if (!head) continue; // unreachable: a tier is only present with ≥1 candidate
    decisions.push(
      adjudicateTier(tier, head, rest, current[tier], scrape.get(tier), opts),
    );
  }

  return {
    decisions,
    accepted: decisions.filter((d) => d.accepted),
    rejected: decisions.filter((d) => !d.accepted),
    unmapped,
  };
}

function providerPrior(
  provider: ModelProviderId,
  model: string,
  opts: ProviderAdjudicateOpts,
): ProviderModelPricing | undefined {
  if (opts.current) {
    return opts.current.find((row) =>
      row.provider === provider && row.model === model
    );
  }
  return getProviderModelPricing(provider, model);
}

function groupByProviderModel(
  attempts: PricingCandidate[][],
  opts: ProviderAdjudicateOpts,
): Map<string, PricingCandidate[]> {
  const byKey = new Map<string, PricingCandidate[]>();
  for (const list of attempts) {
    for (const c of list) {
      const provider = c.provider ?? opts.provider;
      const model = providerCandidateModel(c);
      if (!model) continue;
      const key = `${provider}\u0000${model}`;
      const arr = byKey.get(key) ?? [];
      arr.push(c);
      byKey.set(key, arr);
    }
  }
  return byKey;
}

function buildProviderProposed(
  c: PricingCandidate,
  provider: ModelProviderId,
  model: string,
  prior: ProviderModelPricing | undefined,
  opts: ProviderAdjudicateOpts,
): ProviderModelPricing {
  const anthroCache: { cacheCreation?: number; cacheRead?: number } =
    provider === "anthropic"
      ? deriveCacheRates(c.input, cacheReadMultiplierForModel(model))
      : {};
  return {
    provider,
    model,
    input: c.input,
    output: c.output,
    ...(prior?.cacheCreation !== undefined
      ? { cacheCreation: prior.cacheCreation }
      : anthroCache.cacheCreation !== undefined
      ? { cacheCreation: anthroCache.cacheCreation }
      : {}),
    ...(prior?.cacheRead !== undefined
      ? { cacheRead: prior.cacheRead }
      : anthroCache.cacheRead !== undefined
      ? { cacheRead: anthroCache.cacheRead }
      : {}),
    unit: "MTok",
    currency: "USD",
    source: "verified",
    verifiedAt: opts.extractedAt,
    sourceUrl: c.source || opts.sourceUrl,
    ...(prior?.notes ? { notes: prior.notes } : {}),
  };
}

function providerDecision(
  provider: ModelProviderId,
  model: string,
  head: PricingCandidate,
  rest: PricingCandidate[],
  opts: ProviderAdjudicateOpts,
): PricingDecision {
  const reasons: string[] = [];
  const prior = providerPrior(provider, model, opts);

  const attemptsAgree = rest.every((c) =>
    (c.provider ?? opts.provider) === provider &&
    providerCandidateModel(c) === model &&
    numbersEqual(c.input, head.input) &&
    numbersEqual(c.output, head.output) &&
    c.currency === head.currency &&
    c.unit === head.unit
  );
  if (!attemptsAgree) reasons.push(REASON_DISAGREEMENT);

  if ((head.provider ?? opts.provider) !== opts.provider) {
    reasons.push(REASON_PROVIDER_MISMATCH);
  }
  if (provider !== opts.provider) reasons.push(REASON_PROVIDER_MISMATCH);
  if (
    providerCandidateModel(head) !== model ||
    (head.model !== undefined && head.model !== head.apiId)
  ) {
    reasons.push(REASON_MODEL_MISMATCH);
  }
  if (rest.some((c) => c.model !== undefined && c.model !== c.apiId)) {
    reasons.push(REASON_MODEL_MISMATCH);
  }
  if (head.input < 0 || head.output < 0) reasons.push(REASON_NEGATIVE_RATE);
  if (head.currency !== REQUIRED_CURRENCY) reasons.push(REASON_NON_USD);
  if (head.unit !== REQUIRED_UNIT) reasons.push(REASON_NON_MTOK);
  if (head.output < head.input) reasons.push(REASON_OUTPUT_LT_INPUT);

  if (!prior) {
    reasons.push(REASON_NO_PRIOR);
  } else if (
    outOfBounds(head.input, prior.input) ||
    outOfBounds(head.output, prior.output)
  ) {
    reasons.push(REASON_OUT_OF_BOUNDS);
  }

  const proposedProviderPricing = buildProviderProposed(
    head,
    provider,
    model,
    prior,
    opts,
  );
  const cache = provider === "anthropic"
    ? deriveCacheRates(head.input, cacheReadMultiplierForModel(model))
    : {
      cacheCreation: prior?.cacheCreation ?? 0,
      cacheRead: prior?.cacheRead ?? 0,
    };
  const proposed: ModelPricing = {
    input: head.input,
    output: head.output,
    cacheCreation: cache.cacheCreation,
    cacheRead: cache.cacheRead,
    unit: "MTok",
  };
  const provenance: PricingProvenance = {
    sourceUrl: head.source || opts.sourceUrl,
    extractedAt: opts.extractedAt,
    model: opts.model,
    provider,
    targetModel: model,
    agreement: 1 + rest.length,
  };

  return {
    ...(head.tier ? { tier: head.tier } : {}),
    apiId: head.apiId,
    provider,
    model,
    proposed,
    proposedProviderPricing,
    accepted: reasons.length === 0,
    agreement: 1 + rest.length,
    reasons: [...new Set(reasons)],
    provenance,
  };
}

export function adjudicateProviderPricing(
  attempts: PricingCandidate[][],
  opts: ProviderAdjudicateOpts,
): PricingGateReport {
  const decisions: PricingDecision[] = [];
  for (const [key, cands] of groupByProviderModel(attempts, opts)) {
    const [provider, model] = key.split("\u0000") as [ModelProviderId, string];
    const [head, ...rest] = cands;
    if (!head || !model) continue;
    decisions.push(providerDecision(provider, model, head, rest, opts));
  }
  return {
    decisions,
    accepted: decisions.filter((d) => d.accepted),
    rejected: decisions.filter((d) => !d.accepted),
    unmapped: [],
  };
}
