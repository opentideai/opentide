// The pricing workflow's open half: the status report, and refresh behaviour
// that does not depend on the closed research agent (a stubbed runner, or none
// at all). Refreshes driven by the real research agent are tested in
// agent/pricing-workflow_test.ts.
import { assert, assertEquals } from "@std/assert";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  __setPricingResearchForTests,
  getPricingStatusReport,
  refreshPricingReport,
} from "./pricing-workflow.ts";
import {
  getProviderModelPricingOverrides,
  setProviderModelPricing,
} from "./config.ts";
import { setProviderModelPricingTableProvider } from "./usage.ts";

function seedModelCache(
  home: string,
  models: Array<{ id: string; provider: "anthropic" | "openai" }>,
): void {
  const dir = join(home, ".config", "opentide");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "models-cache.json"),
    JSON.stringify({
      models: models.map((model) => ({
        id: model.id,
        label: model.id,
        provider: model.provider,
      })),
      cachedAt: new Date().toISOString(),
    }),
  );
}

async function withTempHome(
  prefix: string,
  fn: (home: string) => Promise<void> | void,
): Promise<void> {
  const home = await Deno.makeTempDir({ prefix });
  const oldHome = Deno.env.get("HOME");
  // No research runner: the open stack installs none, so a refresh reports
  // research-not-configured unless a test stubs one itself.
  let restorePricingResearch: (() => void) | null = null;
  try {
    Deno.env.set("HOME", home);
    setProviderModelPricingTableProvider(getProviderModelPricingOverrides);
    restorePricingResearch = __setPricingResearchForTests(null);
    await fn(home);
  } finally {
    restorePricingResearch?.();
    setProviderModelPricingTableProvider(() => []);
    if (oldHome === undefined) Deno.env.delete("HOME");
    else Deno.env.set("HOME", oldHome);
    rmSync(home, { recursive: true, force: true });
  }
}

Deno.test("pricing status report includes priced/unpriced rows and provider counts", async () => {
  await withTempHome("genie-pricing-status-", (home) => {
    seedModelCache(home, [
      { id: "claude-sonnet-5", provider: "anthropic" },
      { id: "gpt-5", provider: "openai" },
      { id: "gpt-5-mini", provider: "openai" },
    ]);
    setProviderModelPricing({
      provider: "openai",
      model: "gpt-5",
      input: 1,
      output: 8,
      unit: "MTok",
      currency: "USD",
      source: "manual",
      verifiedAt: "2026-09-10T00:00:00.000Z",
      sourceUrl: "https://example.test/openai",
    });

    const report = getPricingStatusReport(new Date("2026-09-11T00:00:00.000Z"));
    assertEquals(report.counts.priced, 2);
    assertEquals(report.counts.unpriced, 1);
    assertEquals(report.counts.byProvider.anthropic?.priced, 1);
    assertEquals(report.counts.byProvider.openai?.priced, 1);
    assertEquals(report.counts.byProvider.openai?.unpriced, 1);
    assertEquals(
      report.models.find((row) => row.model === "gpt-5")?.source,
      "manual",
    );
    assertEquals(
      report.models.find((row) => row.model === "gpt-5-mini")?.priced,
      false,
    );
  });
});

Deno.test("pricing refresh returns structured errors when research throws", async () => {
  await withTempHome("genie-pricing-refresh-error-", async (home) => {
    seedModelCache(home, [{ id: "gpt-5-mini", provider: "openai" }]);
    const restore = __setPricingResearchForTests(() => {
      throw new Error("openai API key is required for pricing research.");
    });
    try {
      const res = await refreshPricingReport({ provider: "openai" });

      assert(res.ok);
      assertEquals(res.data.apply, false);
      assertEquals(res.data.applied, false);
      assertEquals(res.data.errors, [
        "openai API key is required for pricing research.",
      ]);
      assertEquals(res.data.missing, [{
        provider: "openai",
        model: "gpt-5-mini",
        reason: "research-failed",
      }]);
      assertEquals(res.data.written, []);
    } finally {
      restore();
    }
  });
});

Deno.test("pricing refresh without a research runner reports it is not configured", async () => {
  await withTempHome("genie-pricing-refresh-unconfigured-", async (home) => {
    seedModelCache(home, [{ id: "gpt-5-mini", provider: "openai" }]);
    const res = await refreshPricingReport({ provider: "openai" });

    assert(res.ok);
    assertEquals(res.data.applied, false);
    assertEquals(res.data.errors, [
      "Pricing research runner is not configured.",
    ]);
    assertEquals(res.data.written, []);
  });
});
