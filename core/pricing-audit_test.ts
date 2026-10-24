// Slice 10 — the overlay audit. The acceptance criterion is the first test: it
// reconstructs the 4.10 bug with its real shape and asserts the audit would have
// caught it on the code of 2026-09-11, not just described it on today's.
import { assert, assertEquals } from "@std/assert";
import {
  auditOverlayPricing,
  crossCheckLedgerPricing,
  hasActionableOverlayFindings,
  type OverlayAuditOpts,
} from "./pricing-audit.ts";
import {
  builtInProviderModelPricing,
  getProviderModelPricing,
  type ModelPricing,
  type PricingTier,
  type ProviderModelPricing,
  setPricingTableProvider,
  setProviderModelPricingTableProvider,
} from "./usage.ts";

const AFTER_INTRO = new Date("2026-09-12T22:46:19Z"); // the 4.10 bad window opens

function modelsDevRow(
  over: Partial<ProviderModelPricing> = {},
): ProviderModelPricing {
  return {
    provider: "anthropic",
    model: "claude-sonnet-5",
    input: 2,
    output: 10,
    unit: "MTok",
    currency: "USD",
    source: "models_dev",
    ...over,
  };
}

// The pre-4.10 tier table: Sonnet at the $3/$15 base with the introductory
// overlay that expired on 2026-08-31.
const PRE_FIX_SONNET: ModelPricing = {
  input: 3,
  output: 15,
  cacheCreation: 3.75,
  cacheRead: 0.30,
  unit: "MTok",
  intro: { input: 2, output: 10, through: "2026-08-31" },
};

// Run `fn` with the tier overlay and the provider/model overlay injected, then put
// the seams back — they are process-global and leak into later tests otherwise.
function withPricing(
  tiers: Partial<Record<PricingTier, ModelPricing>>,
  rows: readonly ProviderModelPricing[],
  fn: () => void,
): void {
  setPricingTableProvider(() => tiers);
  setProviderModelPricingTableProvider(() => rows);
  try {
    fn();
  } finally {
    setPricingTableProvider(() => ({}));
    setProviderModelPricingTableProvider(() => []);
  }
}

// Resolution as it behaved BEFORE shadowedByBuiltInAnthropicTier existed: any
// trusted, in-window Anthropic config row won outright, so the models.dev snapshot
// beat the date-gated tier table forever. Injected rather than reimplemented in
// the audit — the audit itself always calls the real resolver.
function preFixResolve(
  rows: readonly ProviderModelPricing[],
): NonNullable<OverlayAuditOpts["resolve"]> {
  return (provider, model, asOf) => {
    const hit = rows.find((r) => r.provider === provider && r.model === model);
    return hit ?? builtInProviderModelPricing(provider, model, asOf);
  };
}

Deno.test("ACCEPTANCE: the audit flags the 4.10 bug under pre-fix resolution", () => {
  const rows = [modelsDevRow()]; // no effectiveThrough — the immortal snapshot
  withPricing({ sonnet: PRE_FIX_SONNET }, rows, () => {
    const report = auditOverlayPricing({
      rows,
      asOf: AFTER_INTRO,
      resolve: preFixResolve(rows),
    });

    const [finding] = report.rows;
    assert(finding, "the overlay row must be audited");
    assert(finding.wins, "pre-fix, the snapshot row priced the model");
    // The intro had expired, so the built-in side is the $3/$15 base.
    assertEquals(finding.builtIn?.input, 3);
    assertEquals(finding.builtIn?.output, 15);
    assert(finding.disagreesWithBuiltIn);
    assert(finding.notes.includes("unverified-override"));
    assert(finding.actionable, "this is the bug; it must be actionable");
    assert(hasActionableOverlayFindings(report));
  });
});

Deno.test("ACCEPTANCE: post-fix the same row is shadowed, and the audit says so", () => {
  const rows = [modelsDevRow()];
  withPricing({ sonnet: PRE_FIX_SONNET }, rows, () => {
    const report = auditOverlayPricing({ rows, asOf: AFTER_INTRO });

    const [finding] = report.rows;
    assert(finding);
    assert(!finding.wins, "the real resolver drops this row");
    assert(finding.notes.includes("shadowed-by-built-in-tier"));
    assertEquals(finding.resolvedSource, "built_in");
    assertEquals(finding.resolved?.input, 3); // the curated base, intro expired
    assert(!finding.actionable);
    assert(!hasActionableOverlayFindings(report));
    assertEquals(report.ignored.length, 1);
  });
});

Deno.test("a manual Anthropic override disagreeing with the tier table is informational", () => {
  const rows = [modelsDevRow({ source: "manual", input: 7, output: 35 })];
  withPricing({ sonnet: PRE_FIX_SONNET }, rows, () => {
    const report = auditOverlayPricing({ rows, asOf: AFTER_INTRO });

    const [finding] = report.rows;
    assert(finding);
    assert(finding.wins, "manual outranks built_in — that is the point of it");
    assert(finding.disagreesWithBuiltIn);
    assert(finding.notes.includes("deliberate-override"));
    assert(!finding.notes.includes("unverified-override"));
    assert(!finding.actionable, "a deliberate override is not a failure");
    assertEquals(report.overrides.length, 1);
    assert(!hasActionableOverlayFindings(report));
  });
});

Deno.test("an overlay row past effectiveThrough is flagged as expired", () => {
  const rows = [
    modelsDevRow({
      provider: "openai",
      model: "gpt-5",
      source: "verified",
      input: 1.25,
      output: 10,
      effectiveThrough: "2026-09-01",
    }),
  ];
  withPricing({}, rows, () => {
    const report = auditOverlayPricing({ rows, asOf: AFTER_INTRO });

    const [finding] = report.rows;
    assert(finding);
    assert(finding.notes.includes("expired"));
    assert(finding.notes.includes("inactive-date-window"));
    assert(!finding.wins, "an out-of-window row must not price anything");
    assertEquals(finding.resolvedSource, "unpriced");
    assertEquals(report.expired.length, 1);
    // Expiry is a notice, not a failure: the price degrades to the layer behind.
    assert(!hasActionableOverlayFindings(report));
  });
});

Deno.test("a row inside the warning window is flagged as expiring soon", () => {
  const rows = [
    modelsDevRow({
      provider: "openai",
      model: "gpt-5",
      source: "verified",
      input: 1.25,
      output: 10,
      effectiveThrough: "2026-09-15",
    }),
  ];
  withPricing({}, rows, () => {
    const report = auditOverlayPricing({ rows, asOf: AFTER_INTRO });
    const [finding] = report.rows;
    assert(finding);
    assert(finding.notes.includes("expiring-soon"));
    assert(!finding.notes.includes("expired"));
    assertEquals(report.expiringSoon.length, 1);
  });
});

Deno.test("an unbacked non-Anthropic row is listed as uncorroborated", () => {
  const rows = [
    modelsDevRow({
      provider: "openai",
      model: "gpt-5",
      input: 1.25,
      output: 10,
      effectiveThrough: "2026-10-13",
    }),
  ];
  withPricing({}, rows, () => {
    const report = auditOverlayPricing({ rows, asOf: AFTER_INTRO });

    const [finding] = report.rows;
    assert(finding);
    assert(finding.wins, "models.dev is the only source OpenAI has");
    assertEquals(finding.builtIn, undefined);
    assert(finding.notes.includes("uncorroborated"));
    assertEquals(report.uncorroborated.length, 1);
    // Visible, never a failure: there is nothing to disagree with.
    assert(!finding.actionable);
  });
});

Deno.test("an empty overlay is a clean report", () => {
  withPricing({}, [], () => {
    const report = auditOverlayPricing({ rows: [], asOf: AFTER_INTRO });
    assertEquals(report.rows.length, 0);
    assertEquals(report.actionable.length, 0);
    assertEquals(report.expired.length, 0);
    assertEquals(report.uncorroborated.length, 0);
    assert(!hasActionableOverlayFindings(report));
  });
});

Deno.test("the audit's resolved source matches getProviderModelPricing for every row", () => {
  // The check that stops the audit drifting away from the resolver it audits: no
  // injected resolve, and every reported answer re-derived through the real one.
  const rows: ProviderModelPricing[] = [
    modelsDevRow(),
    modelsDevRow({ model: "claude-opus-5", input: 5, output: 25 }),
    modelsDevRow({ model: "claude-sonnet-4-5", input: 3, output: 15 }),
    modelsDevRow({
      source: "manual",
      model: "claude-haiku-4-5",
      input: 9,
      output: 9,
    }),
    modelsDevRow({
      provider: "openai",
      model: "gpt-5",
      input: 1.25,
      output: 10,
      effectiveThrough: "2026-10-13",
    }),
    modelsDevRow({
      provider: "openai",
      model: "gpt-4o",
      source: "verified",
      input: 2.5,
      output: 10,
      effectiveThrough: "2026-09-01", // expired
    }),
  ];
  withPricing({}, rows, () => {
    const report = auditOverlayPricing({ rows, asOf: AFTER_INTRO });
    assertEquals(report.rows.length, rows.length);
    for (const finding of report.rows) {
      const live = getProviderModelPricing(
        finding.provider,
        finding.model,
        AFTER_INTRO,
      );
      assertEquals(
        finding.resolvedSource,
        live?.source ?? "unpriced",
        `${finding.provider}/${finding.model}`,
      );
      assertEquals(finding.resolved?.input, live?.input);
      assertEquals(finding.resolved?.output, live?.output);
    }
  });
});

Deno.test("snapshot rows for providers the kernel cannot route to are out of scope", () => {
  const rows: ProviderModelPricing[] = [
    modelsDevRow({
      provider: "mistral",
      model: "mistral-large",
      input: 2,
      output: 6,
    }),
    // A hand-written row for the same provider is deliberate and stays in scope.
    modelsDevRow({
      provider: "mistral",
      model: "mistral-small",
      source: "manual",
      input: 1,
      output: 3,
    }),
  ];
  withPricing({}, rows, () => {
    const report = auditOverlayPricing({ rows, asOf: AFTER_INTRO });
    assertEquals(report.rows.length, 1);
    assertEquals(report.rows[0]?.model, "mistral-small");
  });
});

Deno.test("ledger cross-check reports a model whose pricing source moved", () => {
  const rows = [modelsDevRow()];
  withPricing({ sonnet: PRE_FIX_SONNET }, rows, () => {
    const checks = crossCheckLedgerPricing([
      {
        pricingProvider: "anthropic",
        pricingModel: "claude-sonnet-5",
        pricingSource: "models_dev",
        startedAt: "2026-09-12T22:46:19Z",
      },
      {
        pricingProvider: "anthropic",
        pricingModel: "claude-sonnet-5",
        pricingSource: "models_dev",
        startedAt: "2026-09-13T01:00:00Z",
      },
      // Predates the pricing_source column.
      {
        pricingProvider: "anthropic",
        pricingModel: "claude-opus-5",
        pricingSource: null,
        startedAt: "2026-09-01T00:00:00Z",
      },
      {
        pricingProvider: null,
        pricingModel: null,
        pricingSource: null,
        startedAt: "x",
      },
    ], { asOf: AFTER_INTRO });

    assertEquals(checks.length, 2);
    const sonnet = checks.find((c) => c.model === "claude-sonnet-5");
    assert(sonnet);
    assertEquals(sonnet.rows, 2);
    assertEquals(sonnet.currentSource, "built_in"); // shadowing moved it
    assert(sonnet.sourceChanged);

    const opus = checks.find((c) => c.model === "claude-opus-5");
    assert(opus);
    assertEquals(opus.recordedSources, [null]);
    assert(!opus.sourceChanged, "pre-column rows cannot have changed source");
  });
});
