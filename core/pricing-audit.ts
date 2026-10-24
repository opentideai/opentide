// @layer core — Slice 10: the overlay audit.
//
// `pricing:check` (core/pricing-refresh.ts) diffs the published docs against
// getPricingTable() — the Anthropic *tier* table. That is the half that LOSES.
// getProviderModelPricing consults the provider/model overlay rows FIRST
// (config `providerPricingTable` + the models.dev cache) and only falls through
// to the tier table on a miss, so a wrong overlay row is invisible to every check
// built before this file. That blind spot is exactly where the §4.10 bug lived:
// a models.dev snapshot re-applied Claude Sonnet 5's expired introductory price
// over a date-gated table for twelve days and nothing said a word.
//
// This is deliberately NOT a drift check. For the overlay, disagreement is
// sometimes the whole point — a `manual` or `verified` row exists precisely to
// override the built-in table. So the job is to surface DISAGREEMENT, EXPIRY and
// LACK OF CORROBORATION, and to be honest about which of those is actionable.
//
// Pure: no network, no project, no ledger. Every input has a live default and a
// test-injectable override, mirroring diffPricing's `current` parameter.
import {
  builtInProviderModelPricing,
  getProviderModelPricing,
  getProviderModelPricingRowsView,
  type PricingSource,
  type ProviderModelPricing,
  rowActiveFor,
  shadowedByBuiltInAnthropicTier,
  trustedConfiguredSourceForProvider,
} from "./usage.ts";
import { numbersEqual } from "./pricing-refresh.ts";
import { MODEL_PROVIDER_IDS } from "./config.ts";

// How far ahead of `effectiveThrough` a row starts reading as "expiring soon".
// models.dev rows carry a MODELS_DEV_ROW_MAX_AGE_DAYS (30) window, so a week of
// warning is enough lead time to refresh the catalog before prices silently
// degrade back to the built-in table.
export const OVERLAY_EXPIRY_WARN_DAYS = 7;

// The models.dev catalog carries ~6,700 priced rows across every provider it
// knows about. All but a handful are inert here: the kernel can only bill through
// a provider it can route to. Auditing the whole catalog is both useless (pages of
// "uncorroborated" rows for models nobody can call) and quadratic, so the default
// scope is the routable providers plus every HAND-WRITTEN row whatever its
// provider — someone who typed a `manual` row for a third-party provider meant it,
// and it must never be silently skipped.
function inDefaultScope(
  row: ProviderModelPricing,
  providers: readonly string[],
): boolean {
  return providers.includes(row.provider) ||
    !SNAPSHOT_SOURCES.includes(row.source);
}

// Provenance that is a snapshot of somebody else's page rather than a human
// decision. A row from one of these outranking a curated built-in price is the
// §4.10 shape and the only thing this audit calls actionable.
const SNAPSHOT_SOURCES: readonly PricingSource[] = [
  "models_dev",
  "provider_metadata",
];

export type OverlayNote =
  // The row is present but the resolver never consults it.
  | "shadowed-by-built-in-tier" // §4.10 rule: Anthropic models_dev on a known tier
  | "untrusted-source" // non-Anthropic row whose source isn't manual/verified/models_dev
  | "inactive-date-window" // effectiveFrom in the future, or effectiveThrough passed
  // The row's date window.
  | "expired"
  | "expiring-soon"
  // What the row does to the price.
  | "deliberate-override" // manual/verified, disagrees with built-in — informational
  | "unverified-override" // snapshot source outranks a disagreeing built-in — ACTIONABLE
  | "uncorroborated" // wins, and no built-in table exists to check it against
  | "expired-row-still-pricing"; // resolver bug: an out-of-window row won anyway

export type OverlayRowAudit = {
  provider: string;
  model: string;
  row: ProviderModelPricing;
  // What the curated Anthropic tier table alone would charge. Undefined for every
  // non-Anthropic provider and for Anthropic ids no tier resolves — those are the
  // rows with nothing corroborating them.
  builtIn: ProviderModelPricing | undefined;
  // What actually prices this model today, straight from the real resolver.
  resolved: ProviderModelPricing | undefined;
  resolvedSource: PricingSource | "unpriced";
  wins: boolean; // is THIS row the one the resolver returned
  disagreesWithBuiltIn: boolean;
  notes: OverlayNote[];
  actionable: boolean;
};

export type OverlayAuditReport = {
  asOf: string; // YYYY-MM-DD (UTC), the day the verdicts were computed for
  rows: OverlayRowAudit[];
  actionable: OverlayRowAudit[];
  overrides: OverlayRowAudit[];
  uncorroborated: OverlayRowAudit[];
  expired: OverlayRowAudit[];
  expiringSoon: OverlayRowAudit[];
  ignored: OverlayRowAudit[]; // present in the overlay, never consulted
};

export type OverlayAuditOpts = {
  rows?: readonly ProviderModelPricing[];
  // Providers whose snapshot rows are in scope. Defaults to the providers the
  // kernel can actually route to (MODEL_PROVIDER_IDS); pass [] with an explicit
  // `rows` list to audit exactly what you hand in.
  providers?: readonly string[];
  asOf?: Date;
  expiryWarnDays?: number;
  // The real resolver and the real built-in fallback, injectable ONLY so a test
  // can pin the audit's behaviour against a resolution order the current code no
  // longer has (see the §4.10 regression test). Production always uses the
  // defaults — a check that re-derives "which table priced this" would drift away
  // from the code it is checking, which is the failure mode this whole file is
  // about.
  resolve?: (
    provider: string,
    model: string,
    asOf: Date,
  ) => ProviderModelPricing | undefined;
  builtIn?: (
    provider: string,
    model: string,
    asOf: Date,
  ) => ProviderModelPricing | undefined;
};

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

// Value identity for a pricing row. The overlay providers rebuild their rows on
// every call (config is re-read per lookup), so reference equality between "the
// row we are auditing" and "the row the resolver returned" is not available.
function sameRow(
  a: ProviderModelPricing,
  b: ProviderModelPricing | undefined,
): boolean {
  return b !== undefined &&
    a.provider === b.provider &&
    a.model === b.model &&
    a.source === b.source &&
    numbersEqual(a.input, b.input) &&
    numbersEqual(a.output, b.output) &&
    a.effectiveFrom === b.effectiveFrom &&
    a.effectiveThrough === b.effectiveThrough;
}

function pricesDisagree(
  a: ProviderModelPricing,
  b: ProviderModelPricing,
): boolean {
  return !numbersEqual(a.input, b.input) || !numbersEqual(a.output, b.output);
}

function auditRow(
  row: ProviderModelPricing,
  asOf: Date,
  expiryWarnDays: number,
  resolve: NonNullable<OverlayAuditOpts["resolve"]>,
  builtIn: NonNullable<OverlayAuditOpts["builtIn"]>,
): OverlayRowAudit {
  const notes: OverlayNote[] = [];

  const active = rowActiveFor(row, asOf);
  const day = isoDay(asOf);
  if (row.effectiveThrough) {
    if (day > row.effectiveThrough) notes.push("expired");
    else if (isoDay(addDays(asOf, expiryWarnDays)) > row.effectiveThrough) {
      notes.push("expiring-soon");
    }
  }
  if (!active) notes.push("inactive-date-window");
  if (!trustedConfiguredSourceForProvider(row)) notes.push("untrusted-source");
  if (shadowedByBuiltInAnthropicTier(row)) {
    notes.push("shadowed-by-built-in-tier");
  }

  const builtInRow = builtIn(row.provider, row.model, asOf);
  const resolved = resolve(row.provider, row.model, asOf);
  const wins = sameRow(row, resolved);
  const disagreesWithBuiltIn = builtInRow !== undefined &&
    pricesDisagree(row, builtInRow);

  if (wins) {
    if (!active) notes.push("expired-row-still-pricing");
    if (builtInRow === undefined) notes.push("uncorroborated");
    else if (disagreesWithBuiltIn) {
      notes.push(
        SNAPSHOT_SOURCES.includes(row.source)
          ? "unverified-override"
          : "deliberate-override",
      );
    }
  }

  return {
    provider: row.provider,
    model: row.model,
    row,
    builtIn: builtInRow,
    resolved,
    resolvedSource: resolved?.source ?? "unpriced",
    wins,
    disagreesWithBuiltIn,
    notes,
    actionable: notes.includes("unverified-override") ||
      notes.includes("expired-row-still-pricing"),
  };
}

// The core check. Needs no project, no ledger and no network: it is a pure
// function of the live overlay rows plus the built-in table.
export function auditOverlayPricing(
  opts: OverlayAuditOpts = {},
): OverlayAuditReport {
  const asOf = opts.asOf ?? new Date();
  const providers = opts.providers ?? MODEL_PROVIDER_IDS;
  const rows = (opts.rows ?? getProviderModelPricingRowsView())
    .filter((row) => inDefaultScope(row, providers));
  const expiryWarnDays = opts.expiryWarnDays ?? OVERLAY_EXPIRY_WARN_DAYS;
  const resolve = opts.resolve ??
    ((provider, model, at) => getProviderModelPricing(provider, model, at));
  const builtIn = opts.builtIn ??
    ((provider, model, at) => builtInProviderModelPricing(provider, model, at));

  const audited = rows.map((row) =>
    auditRow(row, asOf, expiryWarnDays, resolve, builtIn)
  );
  const withNote = (note: OverlayNote) =>
    audited.filter((r) => r.notes.includes(note));

  return {
    asOf: isoDay(asOf),
    rows: audited,
    actionable: audited.filter((r) => r.actionable),
    overrides: withNote("deliberate-override"),
    uncorroborated: withNote("uncorroborated"),
    expired: withNote("expired"),
    expiringSoon: withNote("expiring-soon"),
    ignored: audited.filter((r) =>
      !r.wins &&
      (r.notes.includes("shadowed-by-built-in-tier") ||
        r.notes.includes("untrusted-source") ||
        r.notes.includes("inactive-date-window"))
    ),
  };
}

// The gate predicate, mirroring hasActionableDrift. Expiry, overrides and
// uncorroborated rows are surfaced, never failed on — the only failures are a
// snapshot silently outranking curated data and a resolver honouring a row it
// should have dropped.
export function hasActionableOverlayFindings(
  report: OverlayAuditReport,
): boolean {
  return report.actionable.length > 0;
}

// --- optional: the ledger cross-check (`--project <path>`) ---
//
// The pure audit above is the one that has to exist. This narrows it to models a
// project actually billed, and asks the second question the ledger can answer and
// nothing else can: does `pricing_source` — the column added by 4.10, stamped at
// insert — still match what the resolver would pick today? A row whose source
// changed under it marks a window where the price may have moved, which is how
// you find the NEXT bad window instead of reconstructing it by dividing cost by
// tokens.

// The subset of ModelUsageRecord this needs. Structural so the runner can feed it
// raw JSONL lines without dragging the sessions layer into core's pure code.
export type LedgerPricingRecord = {
  pricingProvider: string | null;
  pricingModel: string | null;
  pricingSource: string | null;
  startedAt: string;
};

export type LedgerPricingCrossCheck = {
  provider: string;
  model: string;
  rows: number;
  firstAt: string;
  lastAt: string;
  // Distinct pricing_source values stamped on those rows. More than one means the
  // billing source changed mid-history; null means rows predating the column.
  recordedSources: Array<string | null>;
  currentSource: PricingSource | "unpriced";
  // True when today's resolver would price this model from a different table than
  // the ledger recorded. Not automatically wrong — a deliberate correction looks
  // exactly like this — but it is the boundary of a window worth reading.
  sourceChanged: boolean;
};

export function crossCheckLedgerPricing(
  records: readonly LedgerPricingRecord[],
  opts: {
    asOf?: Date;
    resolve?: NonNullable<OverlayAuditOpts["resolve"]>;
  } = {},
): LedgerPricingCrossCheck[] {
  const asOf = opts.asOf ?? new Date();
  const resolve = opts.resolve ??
    ((provider, model, at) => getProviderModelPricing(provider, model, at));

  const byKey = new Map<string, LedgerPricingRecord[]>();
  for (const r of records) {
    if (!r.pricingProvider || !r.pricingModel) continue;
    const key = `${r.pricingProvider} ${r.pricingModel}`;
    const list = byKey.get(key) ?? [];
    list.push(r);
    byKey.set(key, list);
  }

  const out: LedgerPricingCrossCheck[] = [];
  for (const list of byKey.values()) {
    const first = list[0];
    if (!first?.pricingProvider || !first.pricingModel) continue;
    const provider = first.pricingProvider;
    const model = first.pricingModel;
    const stamps = list.map((r) => r.startedAt).toSorted();
    const recordedSources = [
      ...new Set(list.map((r) => r.pricingSource)),
    ].toSorted((a, b) => (a ?? "").localeCompare(b ?? ""));
    const currentSource = resolve(provider, model, asOf)?.source ?? "unpriced";
    out.push({
      provider,
      model,
      rows: list.length,
      firstAt: stamps[0] ?? "",
      lastAt: stamps[stamps.length - 1] ?? "",
      recordedSources,
      currentSource,
      sourceChanged: recordedSources.some((s) =>
        s !== null && s !== currentSource
      ),
    });
  }
  return out.toSorted((a, b) =>
    a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model)
  );
}
