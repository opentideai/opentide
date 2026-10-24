// @layer core — Feature E2: the pure parse + diff library behind the pricing
// drift check. No I/O — the caller (scripts/refresh-pricing.ts) fetches the docs
// markdown and feeds it in; everything here is deterministic and unit-tested.
//
// STATUS (Stage 2B Slice 3, D10): this rigid transposed-matrix scrape is NO LONGER
// the source of truth for pricing. The agent research + verification gate
// (agent/pricing-research-agent.ts + core/pricing-verify.ts) is; parsePricingTable
// is repurposed as ONE corroborating agreement voter feeding that gate (its match
// raises a tier's agreement count; a reshaped page it can't parse simply doesn't
// vote). pricing:check (scripts/refresh-pricing.ts) remains as a deterministic
// drift DIAGNOSTIC. This library still NEVER writes PRICING — the gated write lives
// in the agent flow (setVerifiedPricing), not here.
import {
  CACHE_CREATION_1H_MULTIPLIER,
  CACHE_CREATION_MULTIPLIER,
  CACHE_READ_MULTIPLIER,
  deriveCacheRates,
  getPricingTable,
  type ModelPricing,
  type PricingTier,
  resolvePricingTier,
} from "./usage.ts";
import type { Result } from "./types.ts";

// The cache-rate invariant + its derivation live in usage.ts (the base) so cost
// calc and this drift check share one definition. Re-exported here to keep E2's
// original public import path (tests, callers) stable.
export { CACHE_CREATION_MULTIPLIER, CACHE_READ_MULTIPLIER, deriveCacheRates };

// The two published docs pages that carry pricing. overview.md's transposed
// "Claude API ID" + "Pricing" matrix carries base input/output keyed by API id.
// pricing.md carries the FOUR-column per-model table (base input, 5m cache write,
// 1h cache write, cache hits) keyed by display NAME — parsed since Slice 11, so the
// three cache columns stop being invented numbers nothing diffs. Both are parsed;
// docs.claude.com redirects to these.
export const PRICING_OVERVIEW_DOC_URL =
  "https://platform.claude.com/docs/en/about-claude/models/overview.md";
export const PRICING_DETAIL_DOC_URL =
  "https://platform.claude.com/docs/en/about-claude/pricing.md";

// A single model row lifted from the docs table.
export type ParsedTier = { apiId: string; input: number; output: number };

// Why a matched tier drifted. "input"/"output": docs price ≠ PRICING price.
// "cache-invariant": PRICING's own cache rates break the 1.25× write / declared-read
// rule for its input — reported, never silently derived over. The read half honours
// the tier's cacheReadMultiplier override, so a legitimate exception (Fable 5.1's
// 0.025×) is not reported as a broken invariant; the published NUMBER is what the
// cache-column diff below checks.
export type DriftReason = "input" | "output" | "cache-invariant";

// The five published price columns. The docs table has all five per model; before
// Slice 11 the check read two and synthesized the other three, which is why a
// divergence in a synthesized one (Fable 5.1's cache reads, 4× over) could not be
// caught by construction.
export type PricingColumn =
  | "input"
  | "output"
  | "cacheWrite5m"
  | "cacheWrite1h"
  | "cacheRead";

export const ALL_PRICING_COLUMNS: readonly PricingColumn[] = [
  "input",
  "output",
  "cacheWrite5m",
  "cacheWrite1h",
  "cacheRead",
];

// Human labels for the report and the startup warning.
export const PRICING_COLUMN_LABELS: Record<PricingColumn, string> = {
  input: "base input",
  output: "output",
  cacheWrite5m: "5m cache write",
  cacheWrite1h: "1h cache write",
  cacheRead: "cache read",
};

export type ChangedTier = {
  tier: PricingTier;
  apiId: string;
  doc: { input: number; output: number };
  current: ModelPricing;
  reasons: DriftReason[];
};

// A doc id that resolved to a tier only via the family fallthrough (no explicit
// arm) — e.g. a freshly launched "claude-opus-6". A notice: prices may match, but
// the id should earn an explicit arm in resolvePricingTier.
export type UnmappedTier = {
  apiId: string;
  tier: PricingTier;
  input: number;
  output: number;
};

// One published price column that disagrees with what the effective table resolves
// for that tier — derived or overridden, the diff doesn't care which.
export type CacheDrift = {
  tier: PricingTier;
  docName: string;
  apiId: string;
  column: PricingColumn;
  doc: number;
  current: number;
};

// Something the cache-column parse could not read. NOT a failure and NOT a silent
// skip: parsing three of four columns and saying nothing is exactly how this class
// of bug survives, so every unread column/row surfaces by name.
export type PricingGap = {
  message: string;
  column?: PricingColumn;
  docName?: string;
};

export type DriftReport = {
  // Actionable: a human must edit PRICING (and bump PRICING_VERIFIED_AS_OF).
  changed: ChangedTier[];
  added: Array<ParsedTier>; // in docs, maps to no tier at all (new family)
  cacheChanged: CacheDrift[]; // a published cache column ≠ the effective table
  // Notices: surfaced, but not on their own a mispricing risk.
  removed: Array<{ tier: PricingTier; current: ModelPricing }>; // in PRICING, no doc row
  unmapped: UnmappedTier[]; // in-family, matched only by fallthrough
  gaps: PricingGap[]; // columns/rows the cache table parse could not read
  // Which columns this run actually compared. Two means the cache table was absent
  // or unparseable — the run is a PARTIAL check, and Part A's freshness record says
  // so rather than letting it read as "all clean".
  comparedColumns: PricingColumn[];
};

// Compare prices with a small epsilon to absorb float noise. Exported so the
// verification gate (core/pricing-verify.ts) reuses the SAME float-equality
// definition for its agreement compares — the scrape voter and the agent attempts
// can never disagree on what "equal" means.
export const EPSILON = 1e-6;
export function numbersEqual(a: number, b: number): boolean {
  return Math.abs(a - b) < EPSILON;
}

// Unwrap markdown links, keeping the visible text: "[Pricing](https://…)" →
// "Pricing", "`claude-opus-5`" is left to the backtick strip. The published
// overview.md links most of its row labels, which is what broke the label match
// (2026-09-13) — the matrix was there, the label just wasn't bare text any more.
function stripMarkdownLinks(cell: string): string {
  return cell.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
}

// Normalize a table cell label for matching: unwrap links, strip bold, backticks,
// trailing footnote digits, collapse whitespace, lowercase. "**Pricing**1" →
// "pricing"; "[Pricing](https://…/pricing)" → "pricing".
function normalizeLabel(cell: string): string {
  return stripMarkdownLinks(cell)
    .replace(/\*\*/g, "")
    .replace(/`/g, "")
    .replace(/\d+$/, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

// Split one markdown table row ("| a | b |") into trimmed cells, dropping the
// empty cells the leading/trailing pipes produce.
function splitRow(line: string): string[] {
  const trimmed = line.trim();
  const cells = trimmed.split("|").map((c) => c.trim());
  if (cells.length && cells[0] === "") cells.shift();
  if (cells.length && cells[cells.length - 1] === "") cells.pop();
  return cells;
}

// True for a markdown separator row like "| --- | :--: |".
function isSeparatorRow(cells: string[]): boolean {
  return cells.length > 0 && cells.every((c) => /^:?-{2,}:?$/.test(c));
}

// Collect maximal runs of consecutive table lines (trimmed, starting with "|").
function tableBlocks(markdown: string): string[][] {
  const blocks: string[][] = [];
  let current: string[] = [];
  for (const line of markdown.split("\n")) {
    if (line.trim().startsWith("|")) {
      current.push(line);
    } else if (current.length) {
      blocks.push(current);
      current = [];
    }
  }
  if (current.length) blocks.push(current);
  return blocks;
}

// Pull an input/output price out of a docs pricing cell like
// "$5 / input MTok $25 / output MTok". Trailing footnote digits after "MTok"
// don't interfere. Returns null if either half is missing.
function parsePriceCell(
  cell: string,
): { input: number; output: number } | null {
  const inMatch = cell.match(/\$\s*(\d+(?:\.\d+)?)\s*\/\s*input/i);
  const outMatch = cell.match(/\$\s*(\d+(?:\.\d+)?)\s*\/\s*output/i);
  if (!inMatch?.[1] || !outMatch?.[1]) return null;
  return { input: Number(inMatch[1]), output: Number(outMatch[1]) };
}

const API_ID_LABEL = "claude api id";
const PRICING_LABEL = "pricing";

// (a) Parse the transposed docs table(s) into { apiId, input, output } rows.
// The overview page lays models out as COLUMNS with feature ROWS, so we find the
// "Claude API ID" row and the "Pricing" row and pair them by column. Handles
// multiple matrices (the current table + the legacy-models accordion table). A
// structure we can't parse (no qualifying matrix, columns missing/renamed) is a
// Result error — never a silent empty.
export function parsePricingTable(markdown: string): Result<ParsedTier[]> {
  const rows: ParsedTier[] = [];
  let matricesFound = 0;

  for (const block of tableBlocks(markdown)) {
    const parsedRows = block.map(splitRow).filter((cells) =>
      !isSeparatorRow(cells)
    );
    if (parsedRows.length < 2) continue;

    const apiIdRow = parsedRows.find((cells) =>
      normalizeLabel(cells[0] ?? "") === API_ID_LABEL
    );
    const pricingRow = parsedRows.find((cells) =>
      normalizeLabel(cells[0] ?? "") === PRICING_LABEL
    );
    if (!apiIdRow || !pricingRow) continue; // not a model matrix — skip

    matricesFound++;
    // Column 0 is the feature label; columns 1.. are models.
    const columnCount = Math.max(apiIdRow.length, pricingRow.length);
    for (let col = 1; col < columnCount; col++) {
      // The published table wraps ids in backticks ("`claude-opus-5`"); a bare
      // .trim() left the backtick in place and the startsWith check never fired.
      const apiId = stripMarkdownLinks(apiIdRow[col] ?? "")
        .replace(/`/g, "")
        .trim();
      if (!apiId.startsWith("claude-")) continue;
      const price = parsePriceCell(pricingRow[col] ?? "");
      if (!price) continue;
      rows.push({ apiId, input: price.input, output: price.output });
    }
  }

  if (matricesFound === 0) {
    return {
      ok: false,
      error: {
        code: "PRICING_TABLE_NOT_FOUND",
        message:
          "No model matrix found: expected a table with a 'Claude API ID' " +
          "row and a 'Pricing' row. The docs format may have changed.",
        suggestion: "Re-check " + PRICING_OVERVIEW_DOC_URL +
          " and update parsePricingTable if the columns were renamed.",
      },
    };
  }
  if (rows.length === 0) {
    return {
      ok: false,
      error: {
        code: "PRICING_TABLE_EMPTY",
        message:
          "Found a model matrix but extracted no priced rows — the API-ID or " +
          "Pricing cell format may have changed.",
        suggestion: "Inspect the raw table at " + PRICING_OVERVIEW_DOC_URL +
          ".",
      },
    };
  }
  return { ok: true, data: rows };
}

// --- (b) The four-column cache table (pricing.md) ------------------------------
//
// A DIFFERENT shape from the overview matrix: a normal table, one model per ROW,
// keyed by DISPLAY NAME ("Claude Fable 5.1") rather than API id. So it needs its
// own parse and its own name→id normalization before resolvePricingTier can map it.

// One model row lifted from the four-column table. Every price is optional: a
// column the parser cannot read becomes a reported gap, never a zero and never a
// silent skip.
export type ParsedCacheRow = {
  docName: string; // as published, for the report
  apiId: string; // the probe id docName normalized to
  input?: number;
  output?: number;
  cacheWrite5m?: number;
  cacheWrite1h?: number;
  cacheRead?: number;
};

export type CachePricingParse = {
  rows: ParsedCacheRow[];
  gaps: PricingGap[];
};

// Column headers as published, normalized. A rename here means a reported gap for
// that column, not a dead check — the table still yields the columns it can find.
const CACHE_COLUMN_HEADERS: Record<PricingColumn, string> = {
  input: "base input tokens",
  output: "output tokens",
  cacheWrite5m: "5m cache writes",
  cacheWrite1h: "1h cache writes",
  cacheRead: "cache hits and refreshes",
};
const MODEL_LABEL = "model";

// Display names whose mechanical normalization lands on an id resolvePricingTier
// doesn't know. Both are pre-4.x naming ("Claude 3.5 Haiku" was published with the
// generation first) — the legacy rows, and precisely the ones a naive normalizer
// would silently mis-tier into the CURRENT tier and report as false drift.
const DOC_NAME_ID_OVERRIDES: Record<string, string> = {
  "claude-opus-4": "claude-opus-4-0",
  "claude-haiku-3-5": "claude-3-5-haiku",
  "claude-haiku-3": "claude-3-haiku",
};

// "Claude Fable 5.1 ([limited availability](https://…))" → "Claude Fable 5.1".
// Deliberately NOT normalizeLabel: that strips a trailing digit, which would turn
// "Claude Fable 5.1" into "claude fable 5." and lose the whole point.
function cleanModelName(cell: string): string {
  return stripMarkdownLinks(cell)
    .replace(/\*\*/g, "")
    .replace(/`/g, "")
    .replace(/\([^)]*\)/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// "Claude Fable 5.1" → "claude-fable-5-1", then the legacy overrides. A probe id,
// not a published one: it exists only to be fed to resolvePricingTier, which
// substring-matches.
export function docNameToApiId(name: string): string {
  const probe = cleanModelName(name)
    .toLowerCase()
    .replace(/[.\s]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return DOC_NAME_ID_OVERRIDES[probe] ?? probe;
}

// Pull the dollar amount out of a cell like "$12.50 / MTok" or "$0.25 / MTok1"
// (the trailing footnote digit is harmless). An em dash or blank cell yields null.
function parseMTokCell(cell: string): number | null {
  const match = cell.match(/\$\s*(\d+(?:\.\d+)?)/);
  return match?.[1] ? Number(match[1]) : null;
}

// (b) Parse pricing.md's per-model four-column table. A table we can't find at all
// is a Result error (same stance as parsePricingTable — never a silent empty); a
// column or cell we can't read inside a table we DID find is a gap on the returned
// parse, so three-of-four columns is reported as three-of-four.
export function parseCachePricingTable(
  markdown: string,
): Result<CachePricingParse> {
  for (const block of tableBlocks(markdown)) {
    const parsedRows = block.map(splitRow).filter((cells) =>
      !isSeparatorRow(cells)
    );
    const header = parsedRows[0];
    if (!header || parsedRows.length < 2) continue;
    const labels = header.map((c) => normalizeLabel(c));
    if (labels[0] !== MODEL_LABEL) continue;

    const gaps: PricingGap[] = [];
    const columnIndex = {} as Partial<Record<PricingColumn, number>>;
    for (const column of ALL_PRICING_COLUMNS) {
      const idx = labels.indexOf(CACHE_COLUMN_HEADERS[column]);
      if (idx < 0) {
        gaps.push({
          column,
          message:
            `Could not read the ${PRICING_COLUMN_LABELS[column]} column: no ` +
            `"${CACHE_COLUMN_HEADERS[column]}" header in the model pricing ` +
            `table. That column went unchecked.`,
        });
        continue;
      }
      columnIndex[column] = idx;
    }

    const rows: ParsedCacheRow[] = [];
    for (const cells of parsedRows.slice(1)) {
      const docName = cleanModelName(cells[0] ?? "");
      if (!docName) continue;
      const row: ParsedCacheRow = { docName, apiId: docNameToApiId(docName) };
      for (const column of ALL_PRICING_COLUMNS) {
        const idx = columnIndex[column];
        if (idx === undefined) continue;
        const price = parseMTokCell(cells[idx] ?? "");
        if (price === null) {
          gaps.push({
            column,
            docName,
            message: `Could not read the ${PRICING_COLUMN_LABELS[column]} ` +
              `price for "${docName}" (cell: "${cells[idx] ?? ""}").`,
          });
          continue;
        }
        row[column] = price;
      }
      rows.push(row);
    }

    if (rows.length === 0) continue; // a "Model"-headed table with no model rows
    return { ok: true, data: { rows, gaps } };
  }

  return {
    ok: false,
    error: {
      code: "CACHE_PRICING_TABLE_NOT_FOUND",
      message:
        "No per-model pricing table found: expected a table whose first column " +
        'is "Model" with per-model price rows. The docs format may have changed.',
      suggestion: "Re-check " + PRICING_DETAIL_DOC_URL +
        " and update parseCachePricingTable if the columns were renamed.",
    },
  };
}

// What the EFFECTIVE table says a column costs for a tier. The 1h write is the one
// value the table never stores — it is applied at cost-computation time by scaling
// the 5m rate (cacheCreationTtlFactor) — so it is scaled the same way here.
function currentColumnPrice(
  current: ModelPricing,
  column: PricingColumn,
): number {
  switch (column) {
    case "input":
      return current.input;
    case "output":
      return current.output;
    case "cacheWrite5m":
      return current.cacheCreation;
    case "cacheWrite1h":
      return round4(
        current.cacheCreation *
          (CACHE_CREATION_1H_MULTIPLIER / CACHE_CREATION_MULTIPLIER),
      );
    case "cacheRead":
      return current.cacheRead;
  }
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

// (c) Diff parsed docs rows against PRICING. Maps each doc API-id to a tier with
// resolvePricingTier — the SAME logic getModelPricing uses, so the diff can never
// disagree with what's actually charged. `current` defaults to the live EFFECTIVE
// table (config overlay applied, via getPricingTable) so the diff compares the docs
// against what's really billed; tests inject a variant to exercise a specific drift.
export function diffPricing(
  parsed: ParsedTier[],
  current: Readonly<Record<PricingTier, ModelPricing>> = getPricingTable(),
  cache?: CachePricingParse,
): DriftReport {
  const changed: ChangedTier[] = [];
  const added: ParsedTier[] = [];
  const unmapped: UnmappedTier[] = [];
  const matched = new Set<PricingTier>();

  for (const row of parsed) {
    const res = resolvePricingTier(row.apiId);
    if (!res) {
      added.push(row); // a family PRICING doesn't model at all
      continue;
    }
    if (res.unknown) {
      unmapped.push({
        apiId: row.apiId,
        tier: res.tier,
        input: row.input,
        output: row.output,
      });
    }
    matched.add(res.tier);

    const cur = current[res.tier];
    const reasons: DriftReason[] = [];
    if (!numbersEqual(row.input, cur.input)) reasons.push("input");
    if (!numbersEqual(row.output, cur.output)) reasons.push("output");

    // Assert the cache-rate invariant on the PRICING side: if this tier's stored
    // cache rates don't equal 1.25×/0.1× of its input, that's drift too.
    const derived = deriveCacheRates(cur.input, cur.cacheReadMultiplier);
    if (
      !numbersEqual(derived.cacheCreation, cur.cacheCreation) ||
      !numbersEqual(derived.cacheRead, cur.cacheRead)
    ) {
      reasons.push("cache-invariant");
    }

    if (reasons.length) {
      changed.push({
        tier: res.tier,
        apiId: row.apiId,
        doc: { input: row.input, output: row.output },
        current: cur,
        reasons,
      });
    }
  }

  const cacheDiff = diffCacheColumns(cache, current, changed);

  // A tier the overview matrix dropped but the four-column table still lists IS
  // covered — the overview page now carries only the four current models, so
  // without this every older tier reads as "verify this yourself" forever.
  for (const tier of cacheDiff.matchedTiers) matched.add(tier);
  const removed = (Object.keys(current) as PricingTier[])
    .filter((tier) => !matched.has(tier))
    .map((tier) => ({ tier, current: current[tier] }));

  return {
    changed,
    added,
    cacheChanged: cacheDiff.cacheChanged,
    removed,
    unmapped,
    gaps: cacheDiff.gaps,
    comparedColumns: cacheDiff.comparedColumns,
  };
}

// The cache-column half of the diff. Compares every published column against what
// the effective table RESOLVES for that tier — derived or overridden is none of the
// diff's business, which is the point: an override that is wrong still shows up.
// `tierChanged` is the base diff's output, used only to avoid reporting the same
// input/output divergence twice from two different doc pages.
function diffCacheColumns(
  cache: CachePricingParse | undefined,
  current: Readonly<Record<PricingTier, ModelPricing>>,
  tierChanged: ChangedTier[],
): {
  cacheChanged: CacheDrift[];
  gaps: PricingGap[];
  comparedColumns: PricingColumn[];
  matchedTiers: Set<PricingTier>;
} {
  // With no cache table the run compared base input/output only — and says so,
  // rather than reporting a clean four-column check it never ran.
  if (!cache) {
    return {
      cacheChanged: [],
      gaps: [{
        message:
          "The four-column model pricing table was not supplied or could not " +
          "be parsed: the 5m write, 1h write and cache read columns went " +
          "unchecked this run.",
      }],
      comparedColumns: ["input", "output"],
      matchedTiers: new Set(),
    };
  }

  const cacheChanged: CacheDrift[] = [];
  const gaps = [...cache.gaps];
  const matchedTiers = new Set<PricingTier>();
  const compared = new Set<PricingColumn>(["input", "output"]);
  const alreadyReported = new Set(
    tierChanged.flatMap((c) =>
      c.reasons
        .filter((r): r is "input" | "output" => r === "input" || r === "output")
        .map((r) => `${c.tier}\u0000${r}`)
    ),
  );

  for (const row of cache.rows) {
    const res = resolvePricingTier(row.apiId);
    if (!res) {
      gaps.push({
        docName: row.docName,
        message:
          `"${row.docName}" (read as "${row.apiId}") maps to no pricing ` +
          `tier, so its cache columns went unchecked.`,
      });
      continue;
    }
    if (res.unknown) {
      gaps.push({
        docName: row.docName,
        message: `"${row.docName}" (read as "${row.apiId}") matched tier ` +
          `${res.tier} only by family fallthrough; its cache columns were ` +
          `compared against that tier, which may be the wrong one.`,
      });
    }
    matchedTiers.add(res.tier);
    const cur = current[res.tier];
    for (const column of ALL_PRICING_COLUMNS) {
      const doc = row[column];
      if (doc === undefined) continue; // already a gap from the parse
      compared.add(column);
      const currentPrice = currentColumnPrice(cur, column);
      if (numbersEqual(doc, currentPrice)) continue;
      if (alreadyReported.has(`${res.tier}\u0000${column}`)) continue;
      cacheChanged.push({
        tier: res.tier,
        docName: row.docName,
        apiId: row.apiId,
        column,
        doc,
        current: currentPrice,
      });
    }
  }

  return {
    cacheChanged,
    gaps,
    comparedColumns: ALL_PRICING_COLUMNS.filter((c) => compared.has(c)),
    matchedTiers,
  };
}

// The gate predicate for CI / cron: only *actionable* drift (a price changed, a
// broken invariant, or a wholly new family) fails. `removed`/`unmapped` are
// notices — deep-legacy models drop out of the overview table without being
// mispriced, so they must not fail the check forever.
export function hasActionableDrift(report: DriftReport): boolean {
  return report.changed.length > 0 || report.added.length > 0 ||
    report.cacheChanged.length > 0;
}

// --- Part A: the drift check's own staleness -----------------------------------
//
// Both the Slice-8 and Slice-10 pricing bugs survived because the only component
// that reads ground truth is this check, and it had been exiting 2 unnoticed for an
// unknown period. A check that cannot run is invisible in exactly the same way as a
// check that does not exist — so the run itself is recorded, and its absence is as
// loud as a failure.

// How long a successful check stays fresh. Published prices move on the order of
// months, so a month is generous; past it, "we last looked in <month>" stops being
// a reassurance.
export const PRICING_CHECK_MAX_AGE_DAYS = 30;

// A record of one SUCCESSFUL drift-check run: it fetched the docs, parsed them, and
// compared. Drift FOUND still counts as successful — the failure mode this guards
// against is the check not running, not the check reporting something.
export type PricingCheckRecord = {
  checkedAt: string; // ISO timestamp of the run
  sources: string[]; // the doc URLs actually compared against
  tiersCompared: number;
  columnsCompared: PricingColumn[];
  gaps: number; // columns/rows the run could not read
};

export type PricingCheckFreshness = {
  // "never": no successful run on record — we have NOT been able to check.
  // "stale": the last successful run is older than PRICING_CHECK_MAX_AGE_DAYS.
  // "partial": recent, but it did not compare every published column.
  // "ok": recent and complete.
  level: "never" | "stale" | "partial" | "ok";
  message: string;
  ageDays?: number;
  missingColumns?: PricingColumn[];
};

function daysBetween(fromIso: string, asOf: Date): number | undefined {
  const then = Date.parse(fromIso);
  if (Number.isNaN(then)) return undefined;
  return Math.floor((asOf.getTime() - then) / 86_400_000);
}

// Pure: the caller reads the record from config and routes the message to its own
// logger. The four levels exist because "prices verified, no drift" and "we have
// not been able to check" are OPPOSITE states that, before this, looked identical
// — both were silence.
export function evaluatePricingCheckFreshness(
  record: PricingCheckRecord | undefined,
  asOf: Date,
): PricingCheckFreshness {
  if (!record?.checkedAt) {
    return {
      level: "never",
      message:
        "Pricing drift check has NEVER completed successfully on this machine " +
        "— published prices have not been verified against the docs at all. " +
        "This is not a clean result; it is no result. Run `deno task " +
        "pricing:check`.",
    };
  }

  const ageDays = daysBetween(record.checkedAt, asOf);
  if (ageDays === undefined) {
    return {
      level: "never",
      message: `Pricing drift check has an unreadable last-run timestamp ` +
        `("${record.checkedAt}"); treat it as never run. Run \`deno task ` +
        "pricing:check`.",
    };
  }
  if (ageDays > PRICING_CHECK_MAX_AGE_DAYS) {
    return {
      level: "stale",
      ageDays,
      message: `Pricing drift check last completed ${ageDays} days ago ` +
        `(${record.checkedAt}), past the ${PRICING_CHECK_MAX_AGE_DAYS}-day ` +
        `threshold — prices may have moved since. Run \`deno task ` +
        "pricing:check`.",
    };
  }

  const missingColumns = ALL_PRICING_COLUMNS.filter((c) =>
    !record.columnsCompared.includes(c)
  );
  if (missingColumns.length) {
    return {
      level: "partial",
      ageDays,
      missingColumns,
      message: `Pricing drift check ran ${ageDays} day(s) ago but could not ` +
        `compare every published column — unchecked: ` +
        `${missingColumns.map((c) => PRICING_COLUMN_LABELS[c]).join(", ")}. ` +
        "Those prices are unverified, not verified-clean.",
    };
  }

  return {
    level: "ok",
    ageDays,
    message: `Pricing verified against the published docs ${ageDays} day(s) ` +
      `ago (${record.checkedAt}), all ${ALL_PRICING_COLUMNS.length} columns.`,
  };
}

// E3 §3 decision — option (b): intro/promo prices are kept HAND-ENCODED and
// human-gated, NOT scraped. The drift check deliberately does not lift the intro
// from the docs: unlike the clean transposed price table, the promo lives in a
// footnote (overview.md footnote 4 / pricing.md #claude-sonnet-5-introductory-
// pricing), and footnote scraping is exactly the format-fragile move E2's stance
// rejects — a mis-parsed footnote would inject false drift. So diffPricing ignores
// intro overlays entirely (the standard cell still matches the base price → no
// false positive).
//
// The one thing we CAN check deterministically, with no scrape, is expiry: an
// intro whose `through` date has passed relative to the run time is stale and
// should be pruned. Reported as a NOTICE (never actionable drift) so it surfaces
// without failing the gate. `asOf` is threaded from the composition root (the
// script's real now), not buried here, mirroring computeCostUsd.
export type ExpiredIntro = {
  tier: PricingTier;
  through: string;
  intro: { input: number; output: number };
};

export function findExpiredIntros(
  asOf: Date,
  current: Readonly<Record<PricingTier, ModelPricing>> = getPricingTable(),
): ExpiredIntro[] {
  const asOfDay = asOf.toISOString().slice(0, 10); // YYYY-MM-DD (UTC), matches usage.ts
  const expired: ExpiredIntro[] = [];
  for (const tier of Object.keys(current) as PricingTier[]) {
    const intro = current[tier].intro;
    if (intro && asOfDay > intro.through) {
      expired.push({
        tier,
        through: intro.through,
        intro: { input: intro.input, output: intro.output },
      });
    }
  }
  return expired;
}
