import {
  getAvailableModels,
  getPricingProvenance,
  type ModelOption,
  type ModelProviderId,
  providerFor,
  setProviderModelPricing,
} from "./config.ts";
import {
  getProviderModelPricing,
  PRICING_VERIFIED_AS_OF,
  type ProviderModelPricing,
  resolvePricingTier,
} from "./usage.ts";
import {
  adjudicateProviderPricing,
  REASON_NO_PRIOR,
} from "./pricing-verify.ts";
import type {
  ModelUsageRecord,
  PricingDecision,
  PricingExtraction,
  PricingGateReport,
  RecordModelUsageInput,
  Result,
  RunPricingResearchOpts,
} from "./types.ts";

export type PricingResearchRunner = (
  opts?: RunPricingResearchOpts,
) => Promise<Result<PricingExtraction>>;

let pricingResearchRunner: PricingResearchRunner | null = null;

export function installPricingResearchRunner(
  runner: PricingResearchRunner,
): void {
  pricingResearchRunner = runner;
}

export function __setPricingResearchForTests(
  runner: PricingResearchRunner | null,
): () => void {
  const previous = pricingResearchRunner;
  pricingResearchRunner = runner;
  return () => {
    pricingResearchRunner = previous;
  };
}

export const PRICING_STALE_AFTER_MS = 90 * 24 * 60 * 60 * 1000;

export interface PricingStatusRow {
  provider: ModelProviderId;
  model: string;
  priced: boolean;
  source?: ProviderModelPricing["source"];
  provenance?: {
    verifiedAt?: string;
    sourceUrl?: string;
    extractedAt?: string;
    model?: string;
    agreement?: number;
  };
  verifiedAt?: string;
  sourceUrl?: string;
  stale: boolean;
}

export interface ProviderPricingCounts {
  priced: number;
  unpriced: number;
  stale: number;
}

export interface PricingStatusReport {
  staleAfterMs: number;
  generatedAt: string;
  counts: {
    priced: number;
    unpriced: number;
    stale: number;
    byProvider: Partial<Record<ModelProviderId, ProviderPricingCounts>>;
  };
  models: PricingStatusRow[];
}

export interface PricingRefreshReport {
  provider?: ModelProviderId;
  apply: boolean;
  applied: boolean;
  sourceUrl?: string;
  extractedAt?: string;
  updated: PricingDecision[];
  unchanged: PricingDecision[];
  missing: Array<{ provider: ModelProviderId; model: string; reason: string }>;
  rejected: PricingDecision[];
  errors: string[];
  written: Array<{ provider: ModelProviderId; model: string }>;
  gate?: PricingGateReport;
}

function concreteAvailableModels(provider?: ModelProviderId): ModelOption[] {
  return getAvailableModels()
    .filter((model) => model.id !== "default")
    .filter((model) => !provider || providerFor(model.id) === provider);
}

function pricingTimestamp(row: ProviderModelPricing): string | undefined {
  return row.verifiedAt ?? row.effectiveFrom;
}

function staleFrom(value: string | undefined, now: Date): boolean {
  if (!value) return false;
  const ts = Date.parse(value);
  if (Number.isNaN(ts)) return false;
  return now.getTime() - ts > PRICING_STALE_AFTER_MS;
}

function rowStatus(model: ModelOption, now: Date): PricingStatusRow {
  const provider = model.provider ?? providerFor(model.id);
  const pricing = getProviderModelPricing(provider, model.id, now);
  const tier = provider === "anthropic"
    ? resolvePricingTier(model.id)?.tier
    : undefined;
  const tierProvenance = tier ? getPricingProvenance()[tier] : undefined;
  const verifiedAt = (pricing ? pricingTimestamp(pricing) : undefined) ??
    tierProvenance?.extractedAt ??
    (pricing?.source === "built_in" ? PRICING_VERIFIED_AS_OF : undefined);
  const sourceUrl = pricing?.sourceUrl ?? tierProvenance?.sourceUrl;
  return {
    provider,
    model: model.id,
    priced: pricing !== undefined,
    ...(pricing?.source ? { source: pricing.source } : {}),
    ...(tierProvenance || pricing?.verifiedAt || pricing?.sourceUrl
      ? {
        provenance: {
          ...(verifiedAt ? { verifiedAt } : {}),
          ...(sourceUrl ? { sourceUrl } : {}),
          ...(tierProvenance?.extractedAt
            ? { extractedAt: tierProvenance.extractedAt }
            : {}),
          ...(tierProvenance?.model ? { model: tierProvenance.model } : {}),
          ...(tierProvenance?.agreement
            ? { agreement: tierProvenance.agreement }
            : {}),
        },
      }
      : {}),
    ...(verifiedAt ? { verifiedAt } : {}),
    ...(sourceUrl ? { sourceUrl } : {}),
    stale: staleFrom(verifiedAt, now),
  };
}

function addProviderCount(
  counts: PricingStatusReport["counts"],
  provider: ModelProviderId,
  row: PricingStatusRow,
): void {
  const current = counts.byProvider[provider] ?? {
    priced: 0,
    unpriced: 0,
    stale: 0,
  };
  if (row.priced) current.priced++;
  else current.unpriced++;
  if (row.stale) current.stale++;
  counts.byProvider[provider] = current;
}

export function getPricingStatusReport(now = new Date()): PricingStatusReport {
  const rows = concreteAvailableModels().map((model) => rowStatus(model, now));
  const counts: PricingStatusReport["counts"] = {
    priced: 0,
    unpriced: 0,
    stale: 0,
    byProvider: {},
  };
  for (const row of rows) {
    if (row.priced) counts.priced++;
    else counts.unpriced++;
    if (row.stale) counts.stale++;
    addProviderCount(counts, row.provider, row);
  }
  return {
    staleAfterMs: PRICING_STALE_AFTER_MS,
    generatedAt: now.toISOString(),
    counts,
    models: rows,
  };
}

function sameProviderPrice(
  a: ProviderModelPricing,
  b: ProviderModelPricing,
): boolean {
  return a.input === b.input &&
    a.output === b.output &&
    a.cacheCreation === b.cacheCreation &&
    a.cacheRead === b.cacheRead &&
    a.unit === b.unit &&
    a.currency === b.currency;
}

function currentProviderRows(asOf: Date): ProviderModelPricing[] {
  return concreteAvailableModels().flatMap((model) => {
    const provider = model.provider ?? providerFor(model.id);
    const pricing = getProviderModelPricing(provider, model.id, asOf);
    return pricing ? [pricing] : [];
  });
}

function missingRows(
  provider: ModelProviderId | undefined,
  accepted: PricingDecision[],
  rejected: PricingDecision[],
): Array<{ provider: ModelProviderId; model: string; reason: string }> {
  const reported = new Set<string>();
  for (const decision of [...accepted, ...rejected]) {
    if (decision.provider && decision.model) {
      reported.add(`${decision.provider}\u0000${decision.model}`);
    }
  }
  const missing: Array<
    { provider: ModelProviderId; model: string; reason: string }
  > = [];
  for (const model of concreteAvailableModels(provider)) {
    const p = model.provider ?? providerFor(model.id);
    const key = `${p}\u0000${model.id}`;
    const pricing = getProviderModelPricing(p, model.id);
    const noPriorRejected = rejected.some((decision) =>
      decision.provider === p &&
      decision.model === model.id &&
      decision.reasons.includes(REASON_NO_PRIOR)
    );
    if (!pricing || noPriorRejected || !reported.has(key)) {
      missing.push({
        provider: p,
        model: model.id,
        reason: pricing ? "not-found-in-source" : "unpriced",
      });
    }
  }
  return missing;
}

function researchFailedReport(
  provider: ModelProviderId,
  apply: boolean,
  reason: string,
  message: string,
): PricingRefreshReport {
  return {
    provider,
    apply,
    applied: false,
    updated: [],
    unchanged: [],
    missing: concreteAvailableModels(provider).map((model) => ({
      provider: model.provider ?? providerFor(model.id),
      model: model.id,
      reason,
    })),
    rejected: [],
    errors: [message],
    written: [],
  };
}

export async function refreshPricingReport(
  opts: {
    provider?: ModelProviderId;
    apply?: boolean;
    research?: RunPricingResearchOpts;
    recordUsage?: (
      input: RecordModelUsageInput,
    ) => Promise<ModelUsageRecord>;
  } = {},
): Promise<Result<PricingRefreshReport>> {
  if (opts.provider === undefined) {
    const providers = [
      ...new Set(
        concreteAvailableModels().map((model) =>
          model.provider ?? providerFor(model.id)
        ),
      ),
    ];
    const reports: PricingRefreshReport[] = [];
    for (const provider of providers) {
      const res = await refreshPricingReport({ ...opts, provider });
      if (!res.ok) return res;
      reports.push(res.data);
    }
    return {
      ok: true,
      data: {
        apply: opts.apply === true,
        applied: opts.apply === true,
        updated: reports.flatMap((report) => report.updated),
        unchanged: reports.flatMap((report) => report.unchanged),
        missing: reports.flatMap((report) => report.missing),
        rejected: reports.flatMap((report) => report.rejected),
        errors: reports.flatMap((report) => report.errors),
        written: reports.flatMap((report) => report.written),
      },
    };
  }

  const provider = opts.provider;
  const apply = opts.apply === true;
  const refreshedAt = new Date();
  const researchRunner = pricingResearchRunner;
  if (!researchRunner) {
    return {
      ok: true,
      data: researchFailedReport(
        provider,
        apply,
        "research-not-configured",
        "Pricing research runner is not configured.",
      ),
    };
  }
  const research = await Promise.resolve().then(() =>
    researchRunner({
      provider,
      recordUsage: opts.recordUsage,
      ...(opts.research ?? {}),
    })
  ).catch((err) => ({
    ok: false as const,
    error: {
      code: "PRICING_RESEARCH_FAILED",
      message: err instanceof Error ? err.message : String(err),
    },
  }));
  if (!research.ok) {
    return {
      ok: true,
      data: researchFailedReport(
        provider,
        apply,
        "research-failed",
        research.error.message,
      ),
    };
  }

  const extraction = research.data;
  const gate = adjudicateProviderPricing(extraction.attempts, {
    provider,
    sourceUrl: extraction.sourceUrl,
    extractedAt: extraction.extractedAt,
    model: extraction.model,
    current: currentProviderRows(refreshedAt),
  });

  const updated: PricingDecision[] = [];
  const unchanged: PricingDecision[] = [];
  const written: Array<{ provider: ModelProviderId; model: string }> = [];
  for (const decision of gate.accepted) {
    const proposed = decision.proposedProviderPricing;
    if (!decision.provider || !decision.model || !proposed) continue;
    const current = getProviderModelPricing(decision.provider, decision.model);
    if (current && sameProviderPrice(current, proposed)) {
      unchanged.push(decision);
    } else {
      updated.push(decision);
    }
    if (apply) {
      setProviderModelPricing(proposed, { replaceProviderModel: true });
      written.push({ provider: decision.provider, model: decision.model });
    }
  }

  return {
    ok: true,
    data: {
      provider,
      apply,
      applied: apply,
      sourceUrl: extraction.sourceUrl,
      extractedAt: extraction.extractedAt,
      updated,
      unchanged,
      missing: missingRows(provider, gate.accepted, gate.rejected),
      rejected: gate.rejected,
      errors: [],
      written,
      gate,
    },
  };
}
