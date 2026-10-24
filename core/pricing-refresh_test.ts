import { assert, assertEquals, assertExists } from "@std/assert";
import {
  CACHE_CREATION_MULTIPLIER,
  CACHE_READ_MULTIPLIER,
  deriveCacheRates,
  diffPricing,
  docNameToApiId,
  evaluatePricingCheckFreshness,
  findExpiredIntros,
  hasActionableDrift,
  parseCachePricingTable,
  type ParsedTier,
  parsePricingTable,
  PRICING_CHECK_MAX_AGE_DAYS,
  type PricingCheckRecord,
} from "./pricing-refresh.ts";
import {
  getPricingTable,
  type ModelPricing,
  type PricingTier,
} from "./usage.ts";

// The effective pricing table snapshot for the diff assertions. With no provider
// wired in the test process, getPricingTable() returns the built-in seed — so this
// is byte-identical to the former PRICING_TABLE const it replaces.
const PRICING_TABLE = getPricingTable();

// A minimal transposed matrix in the real docs shape: models are columns,
// "Claude API ID" and "Pricing" are rows.
const HAPPY_MARKDOWN = `
## Latest models comparison

| Feature | Claude Opus 5 | Claude Sonnet 5 | Claude Haiku 4.5 |
| --- | --- | --- | --- |
| **Description** | For coding | Speed + intelligence | Fastest |
| **Claude API ID** | claude-opus-5 | claude-sonnet-5 | claude-haiku-4-5-20251001 |
| **Pricing**1 | $5 / input MTok $25 / output MTok | $3 / input MTok $15 / output MTok4 | $1 / input MTok $5 / output MTok |
| **Max output** | 128k tokens | 128k tokens | 64k tokens |
`;

Deno.test("parsePricingTable: happy path parses the transposed matrix", () => {
  const result = parsePricingTable(HAPPY_MARKDOWN);
  assert(result.ok, "expected ok");
  assertEquals(result.data, [
    { apiId: "claude-opus-5", input: 5, output: 25 },
    { apiId: "claude-sonnet-5", input: 3, output: 15 },
    { apiId: "claude-haiku-4-5-20251001", input: 1, output: 5 },
  ]);
});

Deno.test("parsePricingTable: parses multiple matrices (current + legacy)", () => {
  const md = HAPPY_MARKDOWN + `
| Feature | Claude Opus 4.1 (deprecated) |
| --- | --- |
| **Claude API ID** | claude-opus-4-1-20250805 |
| **Pricing** | $15 / input MTok $75 / output MTok |
`;
  const result = parsePricingTable(md);
  assert(result.ok);
  assertEquals(result.data.length, 4);
  assertEquals(result.data[3], {
    apiId: "claude-opus-4-1-20250805",
    input: 15,
    output: 75,
  });
});

// The shape the PUBLISHED overview.md actually has as of 2026-09-13: row labels
// are markdown links and API ids are backticked. Both broke the match — the label
// never equalled "pricing" and the id never started with "claude-" — and
// pricing:check exited 2 on main for an unknown length of time as a result.
Deno.test("parsePricingTable: linked labels and backticked ids parse", () => {
  const md = `
| Feature | Claude Opus 5 | Claude Sonnet 5 |
| :------ | :------------ | :-------------- |
| [Pricing](https://platform.claude.com/docs/en/about-claude/pricing) | $5 / input MTok, $25 / output MTok | $2 / input MTok, $10 / output MTok |
| Claude API ID | \`claude-opus-5\` | \`claude-sonnet-5\` |
`;
  const result = parsePricingTable(md);
  assert(result.ok);
  assertEquals(result.data, [
    { apiId: "claude-opus-5", input: 5, output: 25 },
    { apiId: "claude-sonnet-5", input: 2, output: 10 },
  ]);
});

Deno.test("parsePricingTable: malformed table (no Pricing row) is a Result error", () => {
  const md = `
| Feature | Claude Opus 5 |
| --- | --- |
| **Claude API ID** | claude-opus-5 |
| **Cost** | $5 / input MTok $25 / output MTok |
`;
  const result = parsePricingTable(md);
  assert(!result.ok, "expected error");
  assertEquals(result.error.code, "PRICING_TABLE_NOT_FOUND");
});

Deno.test("parsePricingTable: renamed API-ID column is a Result error, not silent empty", () => {
  const md = `
| Feature | Claude Opus 5 |
| --- | --- |
| **Model API Identifier** | claude-opus-5 |
| **Pricing** | $5 / input MTok $25 / output MTok |
`;
  const result = parsePricingTable(md);
  assert(!result.ok);
  assertEquals(result.error.code, "PRICING_TABLE_NOT_FOUND");
});

Deno.test("deriveCacheRates: applies the 1.25×/0.10× invariant, clean numbers", () => {
  assertEquals(deriveCacheRates(5), { cacheCreation: 6.25, cacheRead: 0.5 });
  assertEquals(deriveCacheRates(1), { cacheCreation: 1.25, cacheRead: 0.1 });
  // 0.10 × 0.80 is float-noisy without rounding — assert it lands on 0.08.
  assertEquals(deriveCacheRates(0.8), { cacheCreation: 1, cacheRead: 0.08 });
  assertEquals(CACHE_CREATION_MULTIPLIER, 1.25);
  assertEquals(CACHE_READ_MULTIPLIER, 0.1);
});

Deno.test("diffPricing: no drift when docs match PRICING", () => {
  const parsed: ParsedTier[] = [
    { apiId: "claude-opus-5", input: 5, output: 25 },
    { apiId: "claude-sonnet-5", input: 2, output: 10 },
    { apiId: "claude-haiku-4-5-20251001", input: 1, output: 5 },
  ];
  // Restrict `current` to only the tiers we supply so unrelated tiers don't
  // register as `removed` for this assertion.
  const current = {
    opus5: PRICING_TABLE.opus5,
    sonnet: PRICING_TABLE.sonnet,
    haiku45: PRICING_TABLE.haiku45,
  } as Record<PricingTier, ModelPricing>;
  const report = diffPricing(parsed, current);
  assertEquals(report.changed, []);
  assertEquals(report.added, []);
  assertEquals(report.removed, []);
  assert(!hasActionableDrift(report));
});

Deno.test("diffPricing: a changed price is reported as actionable drift", () => {
  const parsed: ParsedTier[] = [
    { apiId: "claude-opus-5", input: 7, output: 35 }, // docs now say $7/$35
  ];
  const current = {
    opus5: PRICING_TABLE.opus5,
  } as Record<PricingTier, ModelPricing>;
  const report = diffPricing(parsed, current);
  assertEquals(report.changed.length, 1);
  const changed = report.changed[0];
  assertExists(changed);
  assertEquals(changed.tier, "opus5");
  assertEquals(changed.doc, { input: 7, output: 35 });
  assertEquals(changed.reasons.sort(), ["input", "output"]);
  assert(hasActionableDrift(report));
});

Deno.test("diffPricing: an added tier (new family) is actionable", () => {
  const parsed: ParsedTier[] = [
    { apiId: "claude-zephyr-1", input: 2, output: 8 },
  ];
  const current = {
    opus5: PRICING_TABLE.opus5,
  } as Record<PricingTier, ModelPricing>;
  const report = diffPricing(parsed, current);
  assertEquals(report.added, [{
    apiId: "claude-zephyr-1",
    input: 2,
    output: 8,
  }]);
  assert(hasActionableDrift(report));
});

Deno.test("diffPricing: a removed tier (in PRICING, not in docs) is flagged, not actionable", () => {
  const parsed: ParsedTier[] = [
    { apiId: "claude-opus-5", input: 5, output: 25 },
  ];
  const current = {
    opus5: PRICING_TABLE.opus5,
    haikuLegacy: PRICING_TABLE.haikuLegacy,
  } as Record<PricingTier, ModelPricing>;
  const report = diffPricing(parsed, current);
  assertEquals(report.removed.length, 1);
  assertEquals(report.removed[0]?.tier, "haikuLegacy");
  // Removed alone is a notice — a deep-legacy model dropping out of the docs
  // isn't a mispricing risk.
  assert(!hasActionableDrift(report));
});

Deno.test("diffPricing: a broken cache-rate invariant is reported as drift", () => {
  const parsed: ParsedTier[] = [
    { apiId: "claude-opus-5", input: 5, output: 25 }, // input/output match
  ];
  // PRICING counterpart breaks 1.25×/0.10× (cacheRead should be 0.50, not 9).
  const current = {
    opus5: {
      input: 5,
      output: 25,
      cacheCreation: 6.25,
      cacheRead: 9,
      unit: "MTok",
    },
  } as Record<PricingTier, ModelPricing>;
  const report = diffPricing(parsed, current);
  assertEquals(report.changed.length, 1);
  assertEquals(report.changed[0]?.reasons, ["cache-invariant"]);
  assert(hasActionableDrift(report));
});

// --- E3 §3(b): intro overlays are hand-encoded (not scraped); the only
// deterministic check is expiry, reported as a notice for pruning. ---

// A tier carrying an intro overlay, supplied as a FIXTURE rather than read off the
// live table. No shipped tier has an intro since Sonnet 5's became the standard
// price (2026-09-13, core/usage.ts) — pinning these assertions to whatever promo
// happens to be live is how they came to assert nothing.
const TIER_WITH_INTRO = {
  sonnet: {
    input: 3,
    output: 15,
    cacheCreation: 3.75,
    cacheRead: 0.30,
    unit: "MTok",
    intro: { input: 2, output: 10, through: "2026-08-31" },
  },
} as Record<PricingTier, ModelPricing>;

Deno.test("diffPricing ignores the intro overlay — the standard cell still matches", () => {
  // The docs table carries the STANDARD price; an intro lives in a footnote we
  // deliberately don't scrape. So a tier with a live intro must not register as
  // drift against its standard price.
  const parsed: ParsedTier[] = [
    { apiId: "claude-sonnet-5", input: 3, output: 15 },
  ];
  const report = diffPricing(parsed, TIER_WITH_INTRO);
  assertEquals(report.changed, []);
  assert(!hasActionableDrift(report));
});

Deno.test("findExpiredIntros: none before the through date", () => {
  const expired = findExpiredIntros(
    new Date("2026-07-25T00:00:00Z"),
    TIER_WITH_INTRO,
  );
  assertEquals(expired, []);
});

Deno.test("findExpiredIntros: intro is still live through the whole boundary day", () => {
  const expired = findExpiredIntros(
    new Date("2026-08-31T23:59:59Z"),
    TIER_WITH_INTRO,
  );
  assertEquals(expired, []);
});

Deno.test("findExpiredIntros: reports an expired-but-encoded intro as a prune notice", () => {
  const expired = findExpiredIntros(
    new Date("2026-09-01T00:00:00Z"),
    TIER_WITH_INTRO,
  );
  assertEquals(expired.length, 1);
  assertEquals(expired[0]?.tier, "sonnet");
  assertEquals(expired[0]?.through, "2026-08-31");
  assertEquals(expired[0]?.intro, { input: 2, output: 10 });
});

Deno.test("findExpiredIntros: the shipped table carries no intro overlay today", () => {
  // Guards the claim the comment above makes. If a future promo lands, this fails
  // and whoever added it re-reads the expiry story instead of inheriting it.
  assertEquals(findExpiredIntros(new Date("2099-01-01T00:00:00Z")), []);
});

Deno.test("findExpiredIntros: a tier with no intro is never flagged", () => {
  const current = {
    opus5: PRICING_TABLE.opus5, // no intro
  } as Record<PricingTier, ModelPricing>;
  const expired = findExpiredIntros(new Date("2030-01-01T00:00:00Z"), current);
  assertEquals(expired, []);
});

Deno.test("diffPricing: an unrecognized in-family id is a notice (unmapped)", () => {
  // A hypothetical future Opus with the SAME price falls through to opus5.
  const parsed: ParsedTier[] = [
    { apiId: "claude-opus-6", input: 5, output: 25 },
  ];
  const current = {
    opus5: PRICING_TABLE.opus5,
  } as Record<PricingTier, ModelPricing>;
  const report = diffPricing(parsed, current);
  assertEquals(report.unmapped.length, 1);
  assertEquals(report.unmapped[0]?.tier, "opus5");
  assertEquals(report.changed, []); // price matches → no actionable drift
  assert(!hasActionableDrift(report));
});

// --- Slice 11 Part C: the four-column cache table (pricing.md) -----------------

// The PUBLISHED shape as of 2026-09-13: one model per row keyed by display NAME,
// five price columns, markdown-linked annotations in the name cell, and a footnote
// digit welded onto the Fable 5.1 cache-hit cell.
const CACHE_MARKDOWN = `
## Model pricing

| Model | Base input tokens | 5m cache writes | 1h cache writes | Cache hits and refreshes | Output tokens |
| --- | --- | --- | --- | --- | --- |
| Claude Fable 5.1 | $10 / MTok | $12.50 / MTok | $20 / MTok | $0.25 / MTok1 | $50 / MTok |
| Claude Mythos 5.1 ([limited availability](https://anthropic.com/glasswing)) | $10 / MTok | $12.50 / MTok | $20 / MTok | $0.25 / MTok1 | $50 / MTok |
| Claude Fable 5 | $10 / MTok | $12.50 / MTok | $20 / MTok | $1 / MTok | $50 / MTok |
| Claude Opus 5 | $5 / MTok | $6.25 / MTok | $10 / MTok | $0.50 / MTok | $25 / MTok |
| Claude Opus 4.1 ([retired, except on Bedrock and Google Cloud](https://platform.claude.com/docs/en/about-claude/model-deprecations)) | $15 / MTok | $18.75 / MTok | $30 / MTok | $1.50 / MTok | $75 / MTok |
| Claude Sonnet 5 | $2 / MTok | $2.50 / MTok | $4 / MTok | $0.20 / MTok | $10 / MTok |
| Claude Sonnet 4.6 | $3 / MTok | $3.75 / MTok | $6 / MTok | $0.30 / MTok | $15 / MTok |
| Claude Haiku 4.5 | $1 / MTok | $1.25 / MTok | $2 / MTok | $0.10 / MTok | $5 / MTok |
| Claude Haiku 3.5 ([retired](https://platform.claude.com/docs/en/about-claude/model-deprecations)) | $0.80 / MTok | $1 / MTok | $1.60 / MTok | $0.08 / MTok | $4 / MTok |

*1 Cache hits and refreshes on Claude Fable 5.1 and Claude Mythos 5.1 are priced at 0.025x the base input price.*
`;

Deno.test("parseCachePricingTable: reads all four price columns per model", () => {
  const result = parseCachePricingTable(CACHE_MARKDOWN);
  assert(result.ok, "expected ok");
  assertEquals(result.data.gaps, []);
  assertEquals(result.data.rows.length, 9);
  assertEquals(result.data.rows[0], {
    docName: "Claude Fable 5.1",
    apiId: "claude-fable-5-1",
    input: 10,
    output: 50,
    cacheWrite5m: 12.5,
    cacheWrite1h: 20,
    cacheRead: 0.25,
  });
  // The footnote digit on "$0.25 / MTok1" must not leak into the number, and the
  // linked "(limited availability)" must not break the name → id mapping.
  assertEquals(result.data.rows[1]?.apiId, "claude-mythos-5-1");
  assertEquals(result.data.rows[1]?.cacheRead, 0.25);
});

Deno.test("docNameToApiId maps display names onto ids the resolver knows", () => {
  assertEquals(docNameToApiId("Claude Fable 5.1"), "claude-fable-5-1");
  assertEquals(docNameToApiId("Claude Opus 4.5"), "claude-opus-4-5");
  // The legacy naming the mechanical rule gets wrong — mapped explicitly rather
  // than silently mis-tiered into the current (cheaper) tier.
  assertEquals(docNameToApiId("Claude Opus 4"), "claude-opus-4-0");
  assertEquals(docNameToApiId("Claude Haiku 3.5"), "claude-3-5-haiku");
});

Deno.test("parseCachePricingTable: a missing column is a REPORTED GAP", () => {
  // The 1h write column is gone — the parse still yields every other column, and
  // says out loud which one it could not read. Not a throw, not a silent skip.
  const md = `
| Model | Base input tokens | 5m cache writes | Cache hits and refreshes | Output tokens |
| --- | --- | --- | --- | --- |
| Claude Opus 5 | $5 / MTok | $6.25 / MTok | $0.50 / MTok | $25 / MTok |
`;
  const result = parseCachePricingTable(md);
  assert(result.ok, "a missing column must not fail the parse");
  assertEquals(result.data.rows.length, 1);
  assertEquals(result.data.rows[0]?.cacheWrite5m, 6.25);
  assertEquals(result.data.rows[0]?.cacheWrite1h, undefined);
  assertEquals(result.data.gaps.length, 1);
  assertEquals(result.data.gaps[0]?.column, "cacheWrite1h");
  assert(
    result.data.gaps[0]?.message.includes("1h cache write"),
    "the gap must name the column it could not read",
  );
});

Deno.test("parseCachePricingTable: an unreadable CELL is a per-row gap", () => {
  const md = `
| Model | Base input tokens | 5m cache writes | 1h cache writes | Cache hits and refreshes | Output tokens |
| --- | --- | --- | --- | --- | --- |
| Claude Opus 5 | $5 / MTok | $6.25 / MTok | — | $0.50 / MTok | $25 / MTok |
`;
  const result = parseCachePricingTable(md);
  assert(result.ok);
  assertEquals(result.data.rows[0]?.cacheWrite1h, undefined);
  assertEquals(result.data.gaps.length, 1);
  assertEquals(result.data.gaps[0]?.docName, "Claude Opus 5");
});

Deno.test("parseCachePricingTable: no model table at all is an error", () => {
  const result = parseCachePricingTable("# Pricing\n\nNothing tabular here.\n");
  assert(!result.ok);
  assertEquals(result.error.code, "CACHE_PRICING_TABLE_NOT_FOUND");
});

Deno.test("diffPricing: clean against the live table across all five columns", () => {
  const parsed = parsePricingTable(HAPPY_MARKDOWN);
  assert(parsed.ok);
  const cache = parseCachePricingTable(CACHE_MARKDOWN);
  assert(cache.ok);
  // Diff the CACHE table only (the happy overview fixture carries a stale $3
  // Sonnet on purpose), so pass an empty tier list.
  const report = diffPricing([], undefined, cache.data);
  assertEquals(report.cacheChanged, []);
  assertEquals(report.gaps, []);
  assertEquals(report.comparedColumns, [
    "input",
    "output",
    "cacheWrite5m",
    "cacheWrite1h",
    "cacheRead",
  ]);
});

// The acceptance test for Part C: run it against the table as it stood BEFORE
// Part B — fable51 deriving its read at 0.1× — and it must flag Fable 5.1. If it
// doesn't, Part C isn't doing its job.
Deno.test("diffPricing: flags the 5.1 cache-read divergence pre-Part-B", () => {
  const cache = parseCachePricingTable(CACHE_MARKDOWN);
  assert(cache.ok);
  const preSliceEleven: Record<PricingTier, ModelPricing> = {
    ...PRICING_TABLE,
    // What the table said before the override existed: $1, the 0.1× derivation.
    fable51: {
      input: 10,
      output: 50,
      cacheCreation: 12.5,
      cacheRead: 1,
      unit: "MTok",
    },
  };
  const report = diffPricing([], preSliceEleven, cache.data);
  const reads = report.cacheChanged.filter((c) => c.column === "cacheRead");
  assertEquals(reads.length, 2, "Fable 5.1 and Mythos 5.1 both diverge");
  assertEquals(reads[0]?.tier, "fable51");
  assertEquals(reads[0]?.doc, 0.25);
  assertEquals(reads[0]?.current, 1);
  assert(hasActionableDrift(report), "a wrong cache read must fail the check");
});

Deno.test("diffPricing: a wrong 1h write is caught too", () => {
  const cache = parseCachePricingTable(CACHE_MARKDOWN);
  assert(cache.ok);
  const wrongWrite: Record<PricingTier, ModelPricing> = {
    ...PRICING_TABLE,
    // A 5m write of $7 implies a $11.20 1h write; the docs say $10.
    opus5: { ...PRICING_TABLE.opus5, cacheCreation: 7 },
  };
  const report = diffPricing([], wrongWrite, cache.data);
  const columns = report.cacheChanged
    .filter((c) => c.tier === "opus5")
    .map((c) => c.column);
  assertEquals(columns, ["cacheWrite5m", "cacheWrite1h"]);
});

Deno.test("diffPricing: no cache table means a reported gap, not a clean pass", () => {
  const parsed = parsePricingTable(HAPPY_MARKDOWN);
  assert(parsed.ok);
  const report = diffPricing(parsed.data);
  assertEquals(report.comparedColumns, ["input", "output"]);
  assertEquals(report.gaps.length, 1);
  assert(report.gaps[0]?.message.includes("unchecked"));
});

// --- Slice 11 Part A: the check's own staleness --------------------------------

const NOW = new Date("2026-09-13T12:00:00Z");

function record(
  overrides: Partial<PricingCheckRecord> = {},
): PricingCheckRecord {
  return {
    checkedAt: "2026-09-13T09:00:00Z",
    sources: ["overview.md", "pricing.md"],
    tiersCompared: 4,
    columnsCompared: [
      "input",
      "output",
      "cacheWrite5m",
      "cacheWrite1h",
      "cacheRead",
    ],
    gaps: 0,
    ...overrides,
  };
}

Deno.test("freshness: no record at all warns that nothing has been checked", () => {
  const result = evaluatePricingCheckFreshness(undefined, NOW);
  assertEquals(result.level, "never");
  assert(
    result.message.includes("NEVER"),
    "the message must say the check never ran",
  );
  assert(
    !result.message.toLowerCase().includes("verified against the published"),
    "it must not read like a clean result",
  );
});

Deno.test("freshness: a stale record warns, and reads differently from clean", () => {
  const stale = record({ checkedAt: "2026-06-01T09:00:00Z" });
  const result = evaluatePricingCheckFreshness(stale, NOW);
  assertEquals(result.level, "stale");
  assert((result.ageDays ?? 0) > PRICING_CHECK_MAX_AGE_DAYS);
  const clean = evaluatePricingCheckFreshness(record(), NOW);
  assert(
    result.message !== clean.message,
    "stale and clean must not look the same",
  );
  assert(result.message.includes("pricing:check"));
});

Deno.test("freshness: an unreadable timestamp is treated as never run", () => {
  const result = evaluatePricingCheckFreshness(
    record({ checkedAt: "whenever" }),
    NOW,
  );
  assertEquals(result.level, "never");
});

Deno.test("freshness: a recent run missing columns is PARTIAL, not clean", () => {
  const partial = record({ columnsCompared: ["input", "output"] });
  const result = evaluatePricingCheckFreshness(partial, NOW);
  assertEquals(result.level, "partial");
  assertEquals(result.missingColumns, [
    "cacheWrite5m",
    "cacheWrite1h",
    "cacheRead",
  ]);
  assert(result.message.includes("unverified"));
});

Deno.test("freshness: a fresh complete run is ok (the startup path stays silent)", () => {
  const result = evaluatePricingCheckFreshness(record(), NOW);
  assertEquals(result.level, "ok");
  assertEquals(result.ageDays, 0);
});
