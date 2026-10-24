import { assertEquals, assertNotEquals, assertThrows } from "@std/assert";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  getModelPricing,
  getProviderModelPricing,
  type ModelPricing,
  type ProviderModelPricing,
  resolvePricingTier,
  setPricingTableProvider,
  setProviderModelPricingTableProvider,
} from "./usage.ts";
import {
  APP_HOST_ENV,
  appPreviewUrl,
  DEV_SERVER_HOST,
  getAppServerDialHost,
  getAppServerHost,
} from "./config.ts";

// A future in-family model the live API might return that is NOT in MODELS and is
// NOT deep-legacy — proves hygiene is not a pure allowlist (a new tier still shows).
const FUTURE_OPUS_ID = "claude-opus-9";
// A retired deep-legacy id the live API still lists (the E4 "confusing wall").
const DEEP_LEGACY_OPUS_ID = "claude-opus-4-1";

// A cache seed entry: a bare id (untagged) or an id carrying a provider tag, so a
// test can drive both the untagged-legacy and the provider-tagged discovery cases.
type SeedEntry = string | { id: string; provider?: string; pricing?: unknown };

// Seed a models-cache.json under the given HOME exactly as refreshAvailableModels
// would, so getAvailableModels reads it as the "live catalog" half of the union.
// A provider-tagged entry persists its `provider` so providerFor can read it back.
function seedModelCache(home: string, entries: SeedEntry[]): void {
  const dir = join(home, ".config", "opentide");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "models-cache.json"),
    JSON.stringify({
      models: entries.map((e) =>
        typeof e === "string"
          ? { id: e, label: e }
          : { id: e.id, label: e.id, provider: e.provider, pricing: e.pricing }
      ),
      cachedAt: new Date().toISOString(),
    }),
  );
}

function seedModelsDevCache(
  home: string,
  catalog: unknown,
  cachedAt: string = new Date().toISOString(),
): void {
  const dir = join(home, ".config", "opentide");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "models-dev-cache.json"),
    JSON.stringify({
      cachedAt,
      catalog,
    }),
  );
}

async function withFreshConfigCache(
  prefix: string,
  entries: SeedEntry[],
  fn: (config: typeof import("./config.ts")) => Promise<void> | void,
): Promise<void> {
  const home = await Deno.makeTempDir({ prefix });
  const oldHome = Deno.env.get("HOME");
  try {
    Deno.env.set("HOME", home);
    seedModelCache(home, entries);
    const config = await import(`./config.ts?test=${crypto.randomUUID()}`);
    await fn(config);
  } finally {
    if (oldHome === undefined) Deno.env.delete("HOME");
    else Deno.env.set("HOME", oldHome);
    await Deno.remove(home, { recursive: true });
  }
}

Deno.test("default model selection resolves via recommendation, else unconfigured (D9)", async () => {
  // With the seed floor gone (D9), a "default" role resolves ONLY through a stored
  // recommendation over the discovered catalog. Seed the cache the way discovery
  // would (pricing is still stamped from the PRICING table, not the cache) and write
  // a recommendation so the "default" role has something to resolve to.
  await withFreshConfigCache(
    "genie-config-test-",
    ["claude-opus-4-6"],
    (config) => {
      assertEquals(config.getAgentModel(), config.DEFAULT_MODEL_ID);
      assertEquals(config.getPlanningModel(), config.DEFAULT_MODEL_ID);
      assertEquals(config.getImportModel(), config.DEFAULT_MODEL_ID);
      assertEquals(config.getCodeModel(), config.DEFAULT_MODEL_ID);
      // No recommendation written yet → the "default" role is UNCONFIGURED (undefined),
      // never a hardcoded id.
      assertEquals(config.getAgentModelForRequest(), undefined);
      assertEquals(config.getPlanningModelForRequest(), undefined);
      assertEquals(config.getImportModelForRequest(), undefined);
      assertEquals(config.getCodeModelForRequest(), undefined);

      const models = config.getAvailableModels();
      const opus = models.find((m: (typeof models)[number]) =>
        m.id === "claude-opus-4-6"
      );
      assertEquals(opus?.pricing?.input, 5);
      assertEquals(opus?.pricing?.output, 25);
      assertEquals(opus?.pricing?.fast, { input: 30, output: 150 });

      // A written recommendation is what a "default" role resolves to now.
      config.setRecommendedModels({
        agent: "claude-opus-4-6",
        planning: "claude-opus-4-6",
        import: "claude-opus-4-6",
        utility: "claude-opus-4-6",
      });
      config.setAgentModel(config.DEFAULT_MODEL_ID);
      config.setPlanningModel(config.DEFAULT_MODEL_ID);
      config.setImportModel(config.DEFAULT_MODEL_ID);
      config.setCodeModel(config.DEFAULT_MODEL_ID);
      assertEquals(config.getAgentModelForRequest(), "claude-opus-4-6");
      assertEquals(config.getPlanningModelForRequest(), "claude-opus-4-6");
      assertEquals(config.getImportModelForRequest(), "claude-opus-4-6");
      assertEquals(config.getCodeModelForRequest(), "claude-opus-4-6");
    },
  );
});

// Each test re-imports config.ts under a fresh HOME so config.json is isolated.
async function withFreshConfig(
  prefix: string,
  fn: (config: typeof import("./config.ts")) => Promise<void> | void,
): Promise<void> {
  const home = await Deno.makeTempDir({ prefix });
  const oldHome = Deno.env.get("HOME");
  try {
    Deno.env.set("HOME", home);
    const config = await import(`./config.ts?test=${crypto.randomUUID()}`);
    await fn(config);
  } finally {
    if (oldHome === undefined) {
      Deno.env.delete("HOME");
    } else {
      Deno.env.set("HOME", oldHome);
    }
    await Deno.remove(home, { recursive: true });
  }
}

Deno.test("model roles: 'default' resolves to each role's recommendation, else undefined (D9)", async () => {
  await withFreshConfig("genie-config-roles-", (config) => {
    // Unset → every role is on the "default" pointer out of the box.
    assertEquals(config.MODEL_ROLES, [
      "agent",
      "planning",
      "import",
      "utility",
      "verification",
    ]);
    assertEquals(config.getAgentModel(), config.DEFAULT_MODEL_ID);
    assertEquals(config.getPlanningModel(), config.DEFAULT_MODEL_ID);
    assertEquals(config.getImportModel(), config.DEFAULT_MODEL_ID);
    assertEquals(config.getUtilityModel(), config.DEFAULT_MODEL_ID);
    assertEquals(config.getVerificationModel(), config.DEFAULT_MODEL_ID);

    // No recommendation written (keyless / empty catalog) → every "default" role is
    // UNCONFIGURED (undefined), never a hardcoded seed id (D9).
    assertEquals(config.getAgentModelForRequest(), undefined);
    assertEquals(config.getPlanningModelForRequest(), undefined);
    assertEquals(config.getImportModelForRequest(), undefined);
    assertEquals(config.getUtilityModelForRequest(), undefined);
    assertEquals(config.getVerificationModelForRequest(), undefined);

    // Once a recommendation is written, each "default" role follows it.
    config.setRecommendedModels({
      agent: "claude-opus-5",
      planning: "claude-opus-5",
      import: "claude-sonnet-5",
      utility: "claude-haiku-4-5-20251001",
      verification: "claude-sonnet-5",
    });
    assertEquals(config.getAgentModelForRequest(), "claude-opus-5");
    assertEquals(config.getPlanningModelForRequest(), "claude-opus-5");
    assertEquals(config.getImportModelForRequest(), "claude-sonnet-5");
    assertEquals(
      config.getUtilityModelForRequest(),
      "claude-haiku-4-5-20251001",
    );
    assertEquals(config.getVerificationModelForRequest(), "claude-sonnet-5");
  });
});

Deno.test("model roles: an explicit pin overrides 'default' and is returned verbatim", async () => {
  await withFreshConfig("genie-config-pin-", (config) => {
    config.setPlanningModel("claude-opus-5");
    config.setImportModel("claude-sonnet-5");
    config.setVerificationModel("claude-opus-5");
    assertEquals(config.getPlanningModel(), "claude-opus-5");
    assertEquals(config.getPlanningModelForRequest(), "claude-opus-5");
    assertEquals(config.getImportModel(), "claude-sonnet-5");
    assertEquals(config.getImportModelForRequest(), "claude-sonnet-5");
    assertEquals(config.getVerificationModel(), "claude-opus-5");
    assertEquals(config.getVerificationModelForRequest(), "claude-opus-5");
  });
});

Deno.test("model roles: updating a recommendation moves a 'default' role but never a pin", async () => {
  await withFreshConfig("genie-config-recommend-", (config) => {
    // Pin agent; leave verification on "default".
    config.setAgentModel("claude-opus-4-8");
    assertEquals(config.getVerificationModel(), config.DEFAULT_MODEL_ID);

    config.setRecommendedModels({
      agent: "claude-sonnet-5",
      planning: "claude-opus-5",
      import: "claude-sonnet-5",
      verification: "claude-opus-5",
    });

    // The "default" verification role follows the new recommendation...
    assertEquals(config.getPlanningModelForRequest(), "claude-opus-5");
    assertEquals(config.getImportModelForRequest(), "claude-sonnet-5");
    assertEquals(config.getVerificationModelForRequest(), "claude-opus-5");
    assertEquals(config.getRecommendedModels().planning, "claude-opus-5");
    assertEquals(config.getRecommendedModels().import, "claude-sonnet-5");
    assertEquals(config.getRecommendedModels().verification, "claude-opus-5");
    // ...but the explicitly-pinned agent role is untouched (G5 "never clobber a pin").
    assertEquals(config.getAgentModelForRequest(), "claude-opus-4-8");
  });
});

Deno.test("model roles: replacing recommendations clears roles absent from the fresh map", async () => {
  await withFreshConfig("genie-config-recommend-clear-", (config) => {
    config.setRecommendedModels({
      agent: "claude-opus-old",
      planning: "claude-opus-old",
      import: "claude-sonnet-old",
      utility: "claude-haiku-old",
      verification: "claude-sonnet-old",
    });

    config.setRecommendedModels({
      agent: "claude-opus-5",
      planning: "claude-opus-5",
    });

    assertEquals(config.getRecommendedModels(), {
      agent: "claude-opus-5",
      planning: "claude-opus-5",
    });
    assertEquals(config.getAgentModelForRequest(), "claude-opus-5");
    assertEquals(config.getPlanningModelForRequest(), "claude-opus-5");
    assertEquals(config.getImportModelForRequest(), undefined);
    assertEquals(config.getUtilityModelForRequest(), undefined);
    assertEquals(config.getVerificationModelForRequest(), undefined);
  });
});

Deno.test("model roles: legacy codeModel migrates into utility as a verbatim pin (D9)", async () => {
  await withFreshConfig("genie-config-legacy-", (config) => {
    // Seed a legacy single-role config exactly as a pre-G1 install would have.
    config.setCodeModel("claude-haiku-4-5-20251001");

    // The legacy pin surfaces as the utility role and resolves verbatim (a pin is
    // returned regardless of catalog / recommendation).
    assertEquals(config.getUtilityModel(), "claude-haiku-4-5-20251001");
    assertEquals(
      config.getUtilityModelForRequest(),
      "claude-haiku-4-5-20251001",
    );
    // ...while verification is on "default" with no recommendation → UNCONFIGURED (D9).
    assertEquals(config.getPlanningModel(), config.DEFAULT_MODEL_ID);
    assertEquals(config.getPlanningModelForRequest(), undefined);
    assertEquals(config.getImportModel(), config.DEFAULT_MODEL_ID);
    assertEquals(config.getImportModelForRequest(), undefined);
    assertEquals(config.getVerificationModel(), config.DEFAULT_MODEL_ID);
    assertEquals(config.getVerificationModelForRequest(), undefined);
  });
});

Deno.test("providerFor: a cache-tagged Claude id resolves to 'anthropic' from the tag", async () => {
  await withFreshConfigCache(
    "genie-config-provider-anthropic-",
    [{ id: "claude-opus-5", provider: "anthropic" }],
    (config) => {
      // D8: providerFor now reads the persisted tag from the cache, not a curated map.
      assertEquals(config.providerFor("claude-opus-5"), "anthropic");
    },
  );
});

Deno.test("providerFor: a cache-tagged OpenAI id resolves to 'openai' from the tag", async () => {
  await withFreshConfigCache(
    "genie-config-provider-openai-",
    [{ id: "gpt-4o-mini", provider: "openai" }],
    (config) => {
      // The tag is what routes the model — the id namespace is provider-agnostic.
      assertEquals(config.providerFor("gpt-4o-mini"), "openai");
    },
  );
});

Deno.test("providerFor: an untagged/unknown id falls back to the documented 'anthropic' default", async () => {
  await withFreshConfigCache(
    "genie-config-provider-unknown-",
    // An untagged cache entry (no provider) must fall back, not resolve to a guess.
    ["claude-legacy-untagged"],
    (config) => {
      assertEquals(config.providerFor("claude-legacy-untagged"), "anthropic");
      // A wholly unknown id is total-resolved to the documented default, not thrown.
      assertEquals(
        config.providerFor("some-model-that-does-not-exist"),
        config.DEFAULT_MODEL_PROVIDER,
      );
      assertEquals(
        config.providerFor("some-model-that-does-not-exist"),
        "anthropic",
      );
    },
  );
});

Deno.test("provider drift guard: MODEL_PROVIDER_IDS and PROVIDER_DESCRIPTORS are 1:1", async () => {
  await withFreshConfig("genie-config-provider-drift-", (config) => {
    const descriptorIds = config.PROVIDER_DESCRIPTORS.map((d) => d.id);
    // Every descriptor id is a known provider, and each appears exactly once.
    assertEquals(
      new Set(descriptorIds).size,
      descriptorIds.length,
      "a provider descriptor is duplicated",
    );
    for (const provider of config.MODEL_PROVIDER_IDS) {
      assertEquals(
        descriptorIds.filter((id) => id === provider).length,
        1,
        `expected exactly one descriptor for provider="${provider}"`,
      );
    }
    // ...and no descriptor names a provider outside the union (vice-versa).
    for (const id of descriptorIds) {
      assertEquals(
        config.MODEL_PROVIDER_IDS.includes(id),
        true,
        `descriptor names unknown provider="${id}"`,
      );
    }
  });
});

Deno.test("provider tag round-trips through the cache; an invalid tag drops to undefined", async () => {
  await withFreshConfigCache(
    "genie-config-provider-roundtrip-",
    [
      { id: "gpt-4o-mini", provider: "openai" },
      { id: "claude-opus-5", provider: "anthropic" },
      // An invalid provider string must be dropped on read (→ undefined → default).
      { id: "weird-model", provider: "not-a-provider" },
    ],
    (config) => {
      const byId = new Map(
        config.getAvailableModels().map((m) => [m.id, m]),
      );
      // Valid tags survive the write → read → dedupe → union round-trip.
      assertEquals(byId.get("gpt-4o-mini")?.provider, "openai");
      assertEquals(byId.get("claude-opus-5")?.provider, "anthropic");
      // The invalid tag was normalized away, so providerFor uses the default.
      assertEquals(byId.get("weird-model")?.provider, undefined);
      assertEquals(config.providerFor("weird-model"), "anthropic");
    },
  );
});

Deno.test("hasAnyProviderKey: false with no keys, true for either provider (config or env)", async () => {
  const prevAnthropic = Deno.env.get("ANTHROPIC_API_KEY");
  const prevOpenai = Deno.env.get("OPENAI_API_KEY");
  try {
    // No config key and no env key anywhere → no provider is usable.
    Deno.env.delete("ANTHROPIC_API_KEY");
    Deno.env.delete("OPENAI_API_KEY");
    await withFreshConfig("genie-config-haskey-none-", (config) => {
      assertEquals(config.hasAnyProviderKey(), false);
    });

    // A config-file OpenAI key alone flips it true (an OpenAI-only install refreshes).
    await withFreshConfig("genie-config-haskey-openai-", (config) => {
      config.setOpenaiApiKey("sk-openai-test");
      assertEquals(config.hasAnyProviderKey(), true);
      assertEquals(config.getOpenaiApiKey(), "sk-openai-test");
      config.clearOpenaiApiKey();
      assertEquals(config.getOpenaiApiKey(), undefined);
      assertEquals(config.hasAnyProviderKey(), false);
    });

    // A config-file Anthropic key alone also flips it true.
    await withFreshConfig("genie-config-haskey-anthropic-", (config) => {
      config.setAnthropicApiKey("sk-ant-test");
      assertEquals(config.hasAnyProviderKey(), true);
    });

    // The OPENAI_API_KEY env fallback flips it true with no config key written.
    await withFreshConfig("genie-config-haskey-env-", (config) => {
      Deno.env.set("OPENAI_API_KEY", "sk-openai-env");
      assertEquals(config.hasAnyProviderKey(), true);
      assertEquals(config.getOpenaiApiKey(), "sk-openai-env");
      Deno.env.delete("OPENAI_API_KEY");
      assertEquals(config.hasAnyProviderKey(), false);
    });
  } finally {
    if (prevAnthropic === undefined) Deno.env.delete("ANTHROPIC_API_KEY");
    else Deno.env.set("ANTHROPIC_API_KEY", prevAnthropic);
    if (prevOpenai === undefined) Deno.env.delete("OPENAI_API_KEY");
    else Deno.env.set("OPENAI_API_KEY", prevOpenai);
  }
});

Deno.test("setProviderKey/clearProviderKey round-trip per provider, preserving 0o600 perms", async () => {
  const prevAnthropic = Deno.env.get("ANTHROPIC_API_KEY");
  const prevOpenai = Deno.env.get("OPENAI_API_KEY");
  try {
    Deno.env.delete("ANTHROPIC_API_KEY");
    Deno.env.delete("OPENAI_API_KEY");
    await withFreshConfig("genie-config-set-provider-key-", (config) => {
      const path = join(config.getUserConfigDir(), "config.json");
      for (const id of config.MODEL_PROVIDER_IDS) {
        // Write through the dispatcher; read back through the per-provider accessor.
        config.setProviderKey(id, `sk-${id}-round-trip`);
        const read = id === "anthropic"
          ? config.getAnthropicApiKey()
          : config.getOpenaiApiKey();
        assertEquals(read, `sk-${id}-round-trip`);
        // The atomic writeConfig path keeps the secret file at 0o600.
        assertEquals((Deno.statSync(path).mode ?? 0) & 0o777, 0o600);
        // And the clearer removes it.
        config.clearProviderKey(id);
        const cleared = id === "anthropic"
          ? config.getAnthropicApiKey()
          : config.getOpenaiApiKey();
        assertEquals(cleared, undefined);
      }
    });
  } finally {
    if (prevAnthropic === undefined) Deno.env.delete("ANTHROPIC_API_KEY");
    else Deno.env.set("ANTHROPIC_API_KEY", prevAnthropic);
    if (prevOpenai === undefined) Deno.env.delete("OPENAI_API_KEY");
    else Deno.env.set("OPENAI_API_KEY", prevOpenai);
  }
});

Deno.test("OpenAI base URL: config → OPENAI_BASE_URL env → undefined cascade, 0o600 preserved", async () => {
  const prevBaseUrl = Deno.env.get("OPENAI_BASE_URL");
  try {
    Deno.env.delete("OPENAI_BASE_URL");
    await withFreshConfig("genie-config-openai-base-url-", (config) => {
      const path = join(config.getUserConfigDir(), "config.json");
      // Unset everywhere ⇒ undefined (the api.openai.com default is applied downstream).
      assertEquals(config.getOpenaiBaseUrl(), undefined);

      // A written value wins and the secret file stays 0o600.
      config.setOpenaiBaseUrl("https://openrouter.ai/api/v1");
      assertEquals(config.getOpenaiBaseUrl(), "https://openrouter.ai/api/v1");
      assertEquals((Deno.statSync(path).mode ?? 0) & 0o777, 0o600);

      // The clearer falls back to the env var when present…
      config.clearOpenaiBaseUrl();
      Deno.env.set("OPENAI_BASE_URL", "http://localhost:1234/v1");
      assertEquals(config.getOpenaiBaseUrl(), "http://localhost:1234/v1");
      // …and a config value still overrides the env var.
      config.setOpenaiBaseUrl("https://api.together.xyz/v1");
      assertEquals(config.getOpenaiBaseUrl(), "https://api.together.xyz/v1");
    });
  } finally {
    if (prevBaseUrl === undefined) Deno.env.delete("OPENAI_BASE_URL");
    else Deno.env.set("OPENAI_BASE_URL", prevBaseUrl);
  }
});

Deno.test("openaiModelsUrl: hardcoded default when unset, derived `${base}/models` when set (trailing slash trimmed)", async () => {
  const prevBaseUrl = Deno.env.get("OPENAI_BASE_URL");
  try {
    Deno.env.delete("OPENAI_BASE_URL");
    await withFreshConfig("genie-config-openai-models-url-", (config) => {
      // Unset ⇒ the api.openai.com discovery endpoint, unchanged from before this field.
      assertEquals(
        config.openaiModelsUrl(),
        "https://api.openai.com/v1/models",
      );

      config.setOpenaiBaseUrl("https://openrouter.ai/api/v1");
      assertEquals(
        config.openaiModelsUrl(),
        "https://openrouter.ai/api/v1/models",
      );

      // A trailing slash on the base URL must not double up before /models.
      config.setOpenaiBaseUrl("http://localhost:1234/v1/");
      assertEquals(config.openaiModelsUrl(), "http://localhost:1234/v1/models");
    });
  } finally {
    if (prevBaseUrl === undefined) Deno.env.delete("OPENAI_BASE_URL");
    else Deno.env.set("OPENAI_BASE_URL", prevBaseUrl);
  }
});

Deno.test("getProviderKeyStatuses reflects set/unset and obfuscates, never leaking the raw key", async () => {
  const prevAnthropic = Deno.env.get("ANTHROPIC_API_KEY");
  const prevOpenai = Deno.env.get("OPENAI_API_KEY");
  try {
    Deno.env.delete("ANTHROPIC_API_KEY");
    Deno.env.delete("OPENAI_API_KEY");
    await withFreshConfig("genie-config-provider-statuses-", (config) => {
      // One row per descriptor, in MODEL_PROVIDER_IDS order, all unset initially.
      const initial = config.getProviderKeyStatuses();
      assertEquals(initial.map((s) => s.id), [...config.MODEL_PROVIDER_IDS]);
      for (const s of initial) {
        assertEquals(s.set, false);
        assertEquals(s.display, null);
      }

      const rawKey = "sk-anthropic-supersecret-value-1234567";
      config.setProviderKey("anthropic", rawKey);
      const byId = new Map(
        config.getProviderKeyStatuses().map((s) => [s.id, s]),
      );
      const anthropic = byId.get("anthropic");
      assertEquals(anthropic?.set, true);
      // Display is the obfuscated form — the raw key must never appear.
      assertEquals(anthropic?.display, config.obfuscateKey(rawKey));
      assertNotEquals(anthropic?.display, rawKey);
      // OpenAI stays unset.
      assertEquals(byId.get("openai")?.set, false);
      assertEquals(byId.get("openai")?.display, null);
    });
  } finally {
    if (prevAnthropic === undefined) Deno.env.delete("ANTHROPIC_API_KEY");
    else Deno.env.set("ANTHROPIC_API_KEY", prevAnthropic);
    if (prevOpenai === undefined) Deno.env.delete("OPENAI_API_KEY");
    else Deno.env.set("OPENAI_API_KEY", prevOpenai);
  }
});

Deno.test("discovery is keyless-safe: no keys → no network, catalog is just 'default'", async () => {
  const prevAnthropic = Deno.env.get("ANTHROPIC_API_KEY");
  const prevOpenai = Deno.env.get("OPENAI_API_KEY");
  const realFetch = globalThis.fetch;
  try {
    Deno.env.delete("ANTHROPIC_API_KEY");
    Deno.env.delete("OPENAI_API_KEY");
    globalThis.fetch = (() =>
      Promise.resolve(new Response("", { status: 404 }))) as typeof fetch;
    await withFreshConfig("genie-config-keyless-discovery-", async (config) => {
      // refreshAvailableModels may refresh models.dev metadata, but no keyed
      // provider endpoint is hit; with the curated list emptied (D7), the only
      // picker entry is "default".
      const models = await config.refreshAvailableModels();
      assertEquals(models.length, 1);
      assertEquals(models[0]?.id, config.DEFAULT_MODEL_ID);
      // And getAvailableModels agrees — the empty D7 keyless state.
      const available = config.getAvailableModels();
      assertEquals(available.length, 1);
      assertEquals(available[0]?.id, config.DEFAULT_MODEL_ID);
    });
  } finally {
    globalThis.fetch = realFetch;
    if (prevAnthropic === undefined) Deno.env.delete("ANTHROPIC_API_KEY");
    else Deno.env.set("ANTHROPIC_API_KEY", prevAnthropic);
    if (prevOpenai === undefined) Deno.env.delete("OPENAI_API_KEY");
    else Deno.env.set("OPENAI_API_KEY", prevOpenai);
  }
});

Deno.test("discovery reads max_input_tokens as the per-model context window", async () => {
  // Anthropic's /v1/models exposes the window as `max_input_tokens` (not the
  // gateway-style `context_length`); the parser must persist it as contextWindow so
  // getCachedContextWindow wins over the curated/family fallback.
  const prevAnthropic = Deno.env.get("ANTHROPIC_API_KEY");
  const prevOpenai = Deno.env.get("OPENAI_API_KEY");
  const realFetch = globalThis.fetch;
  try {
    Deno.env.set("ANTHROPIC_API_KEY", "sk-ant-test");
    Deno.env.delete("OPENAI_API_KEY");
    // Stub only the Anthropic models endpoint; anything else returns not-ok so the
    // per-provider loop contributes nothing for it.
    globalThis.fetch = ((input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("api.anthropic.com/v1/models")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              data: [{
                id: "claude-opus-4-8",
                display_name: "Claude Opus 4.8",
                max_input_tokens: 1_000_000,
              }],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        );
      }
      return Promise.resolve(new Response("", { status: 404 }));
    }) as typeof fetch;

    await withFreshConfig("genie-config-max-input-tokens-", async (config) => {
      const models = await config.refreshAvailableModels();
      const opus = models.find((m: (typeof models)[number]) =>
        m.id === "claude-opus-4-8"
      );
      assertEquals(opus?.contextWindow, 1_000_000);
      // Persisted to the cache, so the live value is readable back.
      assertEquals(config.getCachedContextWindow("claude-opus-4-8"), 1_000_000);
    });
  } finally {
    globalThis.fetch = realFetch;
    if (prevAnthropic === undefined) Deno.env.delete("ANTHROPIC_API_KEY");
    else Deno.env.set("ANTHROPIC_API_KEY", prevAnthropic);
    if (prevOpenai === undefined) Deno.env.delete("OPENAI_API_KEY");
    else Deno.env.set("OPENAI_API_KEY", prevOpenai);
  }
});

Deno.test("D9: keyless/empty catalog → every role resolver is unconfigured (undefined)", async () => {
  const prevAnthropic = Deno.env.get("ANTHROPIC_API_KEY");
  const prevOpenai = Deno.env.get("OPENAI_API_KEY");
  try {
    // With the seed floor gone, a keyless install (no recommendation, empty catalog)
    // resolves every role to the explicit UNCONFIGURED signal — undefined, never a
    // stale hardcoded id.
    Deno.env.delete("ANTHROPIC_API_KEY");
    Deno.env.delete("OPENAI_API_KEY");
    await withFreshConfig("genie-config-provider-regression-", (config) => {
      assertEquals(config.getAgentModelForRequest(), undefined);
      assertEquals(config.getUtilityModelForRequest(), undefined);
      assertEquals(config.getVerificationModelForRequest(), undefined);
    });
  } finally {
    if (prevAnthropic === undefined) Deno.env.delete("ANTHROPIC_API_KEY");
    else Deno.env.set("ANTHROPIC_API_KEY", prevAnthropic);
    if (prevOpenai === undefined) Deno.env.delete("OPENAI_API_KEY");
    else Deno.env.set("OPENAI_API_KEY", prevOpenai);
  }
});

Deno.test("D9: a populated recommendation resolves each role; a pin wins over catalog", async () => {
  await withFreshConfig("genie-config-d9-resolve-", (config) => {
    // (b) A written recommendation is what a "default" role resolves to.
    config.setRecommendedModels({
      agent: "claude-opus-5",
      utility: "claude-haiku-4-5-20251001",
      verification: "claude-sonnet-5",
    });
    assertEquals(config.getAgentModelForRequest(), "claude-opus-5");
    assertEquals(
      config.getUtilityModelForRequest(),
      "claude-haiku-4-5-20251001",
    );
    assertEquals(config.getVerificationModelForRequest(), "claude-sonnet-5");
    assertEquals(
      config.providerFor(config.getAgentModelForRequest()!),
      "anthropic",
    );

    // (c) An explicit pin is returned verbatim regardless of catalog / recommendation
    // (it overrides the sonnet recommendation above).
    config.setVerificationModel("claude-opus-4-8");
    assertEquals(config.getVerificationModelForRequest(), "claude-opus-4-8");
  });
});

Deno.test("E4 hygiene: deep-legacy ids hidden, current + new-tier live ids surfaced", async () => {
  await withFreshConfigCache(
    "genie-config-e4-surface-",
    [
      DEEP_LEGACY_OPUS_ID, // Opus 4.1 — deep-legacy, must be hidden
      "claude-3-opus", // Claude 3 Opus — deep-legacy, hidden
      "claude-2.1", // Claude 2.x — deep-legacy, hidden
      "claude-3-5-sonnet-20241022", // pre-4 Sonnet — deep-legacy, hidden
      FUTURE_OPUS_ID, // NOT in MODELS, NOT deep-legacy — must surface
      "claude-opus-5", // current tier (also in MODELS) — surfaced
    ],
    (config) => {
      const ids = config.getAvailableModels().map((m) => m.id);

      // Deep-legacy dropped from the picker...
      for (
        const legacy of [
          DEEP_LEGACY_OPUS_ID,
          "claude-3-opus",
          "claude-2.1",
          "claude-3-5-sonnet-20241022",
        ]
      ) {
        assertEquals(ids.includes(legacy), false, `${legacy} should be hidden`);
      }

      // ...current-tier and freshly-launched (non-allowlisted) live ids surface.
      // The latter proves this is not a pure allowlist.
      assertEquals(ids.includes("claude-opus-5"), true);
      assertEquals(ids.includes(FUTURE_OPUS_ID), true);
    },
  );
});

Deno.test("E4 hygiene: a role pinned to a deep-legacy id keeps it visible and flags it deprecated", async () => {
  await withFreshConfigCache(
    "genie-config-e4-pin-",
    [DEEP_LEGACY_OPUS_ID, "claude-opus-5"],
    (config) => {
      // Before pinning, the deep-legacy id is hidden.
      assertEquals(
        config.getAvailableModels().some((m) => m.id === DEEP_LEGACY_OPUS_ID),
        false,
      );

      // Pin the agent role to the deep-legacy id — hygiene must not hide what runs.
      config.setAgentModel(DEEP_LEGACY_OPUS_ID);
      const pinned = config.getAvailableModels().find((m) =>
        m.id === DEEP_LEGACY_OPUS_ID
      );
      assertNotEquals(pinned, undefined);
      // ...and it is flagged so the UI can render it muted/last, not as a peer.
      assertEquals(pinned?.deprecated, true);
    },
  );
});

Deno.test("E4 hygiene: the 'default' sentinel is preserved exactly once and stays first", async () => {
  await withFreshConfigCache(
    "genie-config-e4-sentinel-",
    [DEEP_LEGACY_OPUS_ID, "claude-opus-5"],
    (config) => {
      const models = config.getAvailableModels();
      assertEquals(models[0]?.id, config.DEFAULT_MODEL_ID);
      assertEquals(
        models.filter((m) => m.id === config.DEFAULT_MODEL_ID).length,
        1,
      );
    },
  );
});

Deno.test("E4 hygiene is display-only: hiding a model never changes its pricing or tier", async () => {
  await withFreshConfigCache(
    "genie-config-e4-pricing-",
    [DEEP_LEGACY_OPUS_ID],
    (config) => {
      // Opus 4.1 is hidden from the picker...
      assertEquals(
        config.getAvailableModels().some((m) => m.id === DEEP_LEGACY_OPUS_ID),
        false,
      );
      // ...but still prices + resolves exactly as before (legacy $15/$75).
      assertEquals(resolvePricingTier(DEEP_LEGACY_OPUS_ID)?.tier, "opusLegacy");
      const pricing = getModelPricing(DEEP_LEGACY_OPUS_ID);
      assertEquals(pricing?.input, 15);
      assertEquals(pricing?.output, 75);
    },
  );
});

// --- A5 (Stream A): telemetry consent + installation-id minting ---
//
// The core privacy contract: a never-consented install is inert and anonymous —
// no installation_id on disk, no consent stamped — and reading settings never
// mints anything. Minting happens exactly once, at consent grant. Revoke halts
// egress but keeps identity; a version bump re-prompts.

function readRawTelemetry(
  home: string,
): { installationId?: string; consentVersion?: number; consent?: unknown } {
  const path = join(home, ".config", "opentide", "config.json");
  try {
    const cfg = JSON.parse(Deno.readTextFileSync(path)) as {
      telemetry?: {
        installationId?: string;
        consentVersion?: number;
        consent?: unknown;
      };
    };
    return cfg.telemetry ?? {};
  } catch {
    return {};
  }
}

Deno.test("A5: a fresh install is inert — no installation_id, no consent, and a read never mints", async () => {
  await withFreshConfig("genie-a5-fresh-", (config) => {
    const home = Deno.env.get("HOME")!;

    // A pure read returns no id and no consent...
    const s = config.getTelemetrySettings();
    assertEquals(s.installationId, "");
    assertEquals(s.consentVersion, 0);
    assertEquals(s.consent, { telemetry: false, feedback: false });

    // ...and, crucially, writes nothing to disk (no config.json, or one with no
    // telemetry id). Read it again to prove reading is not a hidden mint point.
    config.getTelemetrySettings();
    const raw = readRawTelemetry(home);
    assertEquals(raw.installationId, undefined);
    assertEquals(raw.consentVersion, undefined);
  });
});

Deno.test("A5: consent grant is the mint point — stamps version + timestamp, mints exactly one id", async () => {
  await withFreshConfig("genie-a5-grant-", (config) => {
    const home = Deno.env.get("HOME")!;

    const granted = config.setTelemetrySettings({
      consent: { telemetry: true, feedback: true },
    });
    assertEquals(granted.consentVersion, config.CONSENT_VERSION);
    assertNotEquals(granted.consentGrantedAt, "");
    assertNotEquals(granted.installationId, "");
    // Now the id is actually persisted (the mint wrote it).
    assertEquals(readRawTelemetry(home).installationId, granted.installationId);

    // A second grant does NOT re-mint or re-stamp the first-grant timestamp.
    const again = config.setTelemetrySettings({
      consent: { telemetry: true, feedback: true },
    });
    assertEquals(again.installationId, granted.installationId);
    assertEquals(again.consentGrantedAt, granted.consentGrantedAt);
  });
});

Deno.test("A5: decline stamps the version (no re-prompt) but mints nothing", async () => {
  await withFreshConfig("genie-a5-decline-", (config) => {
    const declined = config.setTelemetrySettings({
      consent: { telemetry: false, feedback: false },
    });
    // The user answered → version recorded so the first-run prompt won't return...
    assertEquals(declined.consentVersion, config.CONSENT_VERSION);
    // ...but declining is anonymous: no id, no grant timestamp.
    assertEquals(declined.installationId, "");
    assertEquals(declined.consentGrantedAt, "");
  });
});

Deno.test("A5: revoke halts egress but keeps the id (re-consent does not re-mint)", async () => {
  await withFreshConfig("genie-a5-revoke-", (config) => {
    const granted = config.setTelemetrySettings({
      consent: { telemetry: true, feedback: true },
    });
    const id = granted.installationId;
    assertNotEquals(id, "");

    const revoked = config.setTelemetrySettings({
      consent: { telemetry: false, feedback: false },
    });
    assertEquals(revoked.consent, { telemetry: false, feedback: false });
    // Identity is retained across revoke...
    assertEquals(revoked.installationId, id);

    // ...so re-consent reuses the same id rather than minting a new one.
    const reGranted = config.setTelemetrySettings({
      consent: { telemetry: true, feedback: true },
    });
    assertEquals(reGranted.installationId, id);
  });
});

Deno.test("A5: a non-consent settings write never mints an id", async () => {
  await withFreshConfig("genie-a5-nonconsent-write-", (config) => {
    // Changing an unrelated setting (endpoint) must not create identity.
    const s = config.setTelemetrySettings({ endpoint: "https://x.example" });
    assertEquals(s.installationId, "");
    assertEquals(s.consentVersion, 0);
  });
});

// getAppServerHost gates the app-preview bind host on OPENTIDE_APP_HOST: loopback
// by default (local dev never exposes the user's app), the env value when set (a
// trusted-network box opts into 0.0.0.0 so the IDE-origin preview URL resolves).
Deno.test("getAppServerHost: defaults to loopback, honors OPENTIDE_APP_HOST", () => {
  const prev = Deno.env.get(APP_HOST_ENV);
  try {
    Deno.env.delete(APP_HOST_ENV);
    assertEquals(getAppServerHost(), DEV_SERVER_HOST);

    Deno.env.set(APP_HOST_ENV, "0.0.0.0");
    assertEquals(getAppServerHost(), "0.0.0.0");

    // An empty value is treated as unset (falls back to loopback).
    Deno.env.set(APP_HOST_ENV, "");
    assertEquals(getAppServerHost(), DEV_SERVER_HOST);
  } finally {
    if (prev === undefined) Deno.env.delete(APP_HOST_ENV);
    else Deno.env.set(APP_HOST_ENV, prev);
  }
});

Deno.test("appPreviewUrl dials the reachable preview host", () => {
  const prev = Deno.env.get(APP_HOST_ENV);
  try {
    Deno.env.delete(APP_HOST_ENV);
    assertEquals(getAppServerDialHost(), DEV_SERVER_HOST);
    assertEquals(
      appPreviewUrl(3001, "health"),
      `http://${DEV_SERVER_HOST}:3001/health`,
    );

    Deno.env.set(APP_HOST_ENV, "100.64.0.1");
    assertEquals(getAppServerDialHost(), "100.64.0.1");
    assertEquals(appPreviewUrl(37021, "/"), "http://100.64.0.1:37021/");

    Deno.env.set(APP_HOST_ENV, "0.0.0.0");
    assertEquals(getAppServerDialHost(), "localhost");
    assertEquals(appPreviewUrl(3001, "/x"), "http://localhost:3001/x");
  } finally {
    if (prev === undefined) Deno.env.delete(APP_HOST_ENV);
    else Deno.env.set(APP_HOST_ENV, prev);
  }
});

Deno.test("kernel settings: readinessEnforcement defaults to advisory and round-trips", async () => {
  const home = await Deno.makeTempDir({ prefix: "genie-config-enforce-" });
  const oldHome = Deno.env.get("HOME");
  try {
    Deno.env.set("HOME", home);
    const config = await import(`./config.ts?test=${crypto.randomUUID()}`);

    assertEquals(config.getKernelSettings().readinessEnforcement, "advisory");

    config.setKernelSettings({ readinessEnforcement: "strict" });
    assertEquals(config.getKernelSettings().readinessEnforcement, "strict");

    config.setKernelSettings({ readinessEnforcement: "graduated" });
    assertEquals(config.getKernelSettings().readinessEnforcement, "graduated");

    // Unknown values normalize back to advisory on read.
    config.setKernelSettings({ readinessEnforcement: "bogus" as never });
    assertEquals(config.getKernelSettings().readinessEnforcement, "advisory");
  } finally {
    if (oldHome === undefined) {
      Deno.env.delete("HOME");
    } else {
      Deno.env.set("HOME", oldHome);
    }
    await Deno.remove(home, { recursive: true });
  }
});

Deno.test("kernel settings: proportionalVerification defaults to auto and normalizes", async () => {
  const home = await Deno.makeTempDir({ prefix: "genie-config-proportional-" });
  const oldHome = Deno.env.get("HOME");
  try {
    Deno.env.set("HOME", home);
    const config = await import(`./config.ts?test=${crypto.randomUUID()}`);

    // "auto" is the default: the agent classifies each task and the kernel verifies.
    assertEquals(config.getKernelSettings().proportionalVerification, "auto");

    for (const mode of ["always", "never", "auto"] as const) {
      config.setKernelSettings({ proportionalVerification: mode });
      assertEquals(config.getKernelSettings().proportionalVerification, mode);
    }

    // A hand-edited config with a bogus value reads as the default rather than
    // bricking the gate — same forgiving normalization as readinessEnforcement.
    config.setKernelSettings(
      { proportionalVerification: "aggressive" } as unknown as Record<
        string,
        unknown
      >,
    );
    assertEquals(config.getKernelSettings().proportionalVerification, "auto");

    // The light-lane budget has a stable home in config.
    assertEquals(config.LIGHT_TIER_MAX_ENTITIES, 3);
    assertEquals(config.LIGHT_TIER_MAX_STEPS, 2);
  } finally {
    if (oldHome === undefined) {
      Deno.env.delete("HOME");
    } else {
      Deno.env.set("HOME", oldHome);
    }
    await Deno.remove(home, { recursive: true });
  }
});

Deno.test("kernel settings: perStepExecution defaults to true and round-trips", async () => {
  const home = await Deno.makeTempDir({ prefix: "genie-config-perstep-" });
  const oldHome = Deno.env.get("HOME");
  try {
    Deno.env.set("HOME", home);
    const config = await import(`./config.ts?test=${crypto.randomUUID()}`);

    // On by default (Stage 7 rollout) — per-step execution is the runtime behavior;
    // the single-turn path stays as an explicit opt-out via the flag.
    assertEquals(config.getKernelSettings().perStepExecution, true);

    config.setKernelSettings({ perStepExecution: false });
    assertEquals(config.getKernelSettings().perStepExecution, false);

    config.setKernelSettings({ perStepExecution: true });
    assertEquals(config.getKernelSettings().perStepExecution, true);

    // The bounded-repair cap has a stable home in config.
    assertEquals(config.MAX_STEP_REPAIRS, 2);
  } finally {
    if (oldHome === undefined) {
      Deno.env.delete("HOME");
    } else {
      Deno.env.set("HOME", oldHome);
    }
    await Deno.remove(home, { recursive: true });
  }
});

Deno.test("kernel settings: test and browser action timeouts default, round-trip, and normalize", async () => {
  const home = await Deno.makeTempDir({ prefix: "genie-config-timeouts-" });
  const oldHome = Deno.env.get("HOME");
  try {
    Deno.env.set("HOME", home);
    const config = await import(`./config.ts?test=${crypto.randomUUID()}`);

    assertEquals(
      config.getKernelSettings().testTimeoutMs,
      config.TEST_TIMEOUT_DEFAULT_MS,
    );
    assertEquals(
      config.getKernelSettings().browserActionTimeoutMs,
      config.BROWSER_ACTION_TIMEOUT_DEFAULT_MS,
    );

    config.setKernelSettings({
      testTimeoutMs: 120_000,
      browserActionTimeoutMs: 20_000,
    });
    assertEquals(config.getKernelSettings().testTimeoutMs, 120_000);
    assertEquals(config.getKernelSettings().browserActionTimeoutMs, 20_000);

    config.setKernelSettings({
      testTimeoutMs: config.KERNEL_TIMEOUT_MIN_MS,
      browserActionTimeoutMs: config.KERNEL_TIMEOUT_MAX_MS,
    });
    assertEquals(
      config.getKernelSettings().testTimeoutMs,
      config.KERNEL_TIMEOUT_MIN_MS,
    );
    assertEquals(
      config.getKernelSettings().browserActionTimeoutMs,
      config.KERNEL_TIMEOUT_MAX_MS,
    );

    config.setKernelSettings({ testTimeoutMs: 999 });
    assertEquals(
      config.getKernelSettings().testTimeoutMs,
      config.TEST_TIMEOUT_DEFAULT_MS,
    );

    config.setKernelSettings({ browserActionTimeoutMs: 300_001 });
    assertEquals(
      config.getKernelSettings().browserActionTimeoutMs,
      config.BROWSER_ACTION_TIMEOUT_DEFAULT_MS,
    );

    config.setKernelSettings(
      { testTimeoutMs: Number.NaN } as unknown as Record<string, unknown>,
    );
    assertEquals(
      config.getKernelSettings().testTimeoutMs,
      config.TEST_TIMEOUT_DEFAULT_MS,
    );

    assertEquals(config.formatKernelTimeoutMs(60_000), "60s");
    assertEquals(config.formatKernelTimeoutMs(1_500), "1500ms");
  } finally {
    if (oldHome === undefined) {
      Deno.env.delete("HOME");
    } else {
      Deno.env.set("HOME", oldHome);
    }
    await Deno.remove(home, { recursive: true });
  }
});

// Slice 6 (context-hardening plan) + §4.7/§8 (agent cost reduction): the four occupancy
// ratios resolve through the file → env → constant cascade, clamped to (0, 1], with
// invalid inputs falling back rather than being clamped into range. Same isolated-HOME
// + env set/restore shape as the readinessEnforcement/perStepExecution kernel-settings
// tests above.
for (
  const knob of [
    {
      field: "contextNudgeRatio",
      envVar: "OPENTIDE_CONTEXT_NUDGE_RATIO",
      constant: "CONTEXT_NUDGE_RATIO",
    },
    {
      field: "contextAutoCompactRatio",
      envVar: "OPENTIDE_CONTEXT_AUTOCOMPACT_RATIO",
      constant: "CONTEXT_AUTOCOMPACT_RATIO",
    },
    {
      field: "contextPruneRatio",
      envVar: "OPENTIDE_CONTEXT_PRUNE_RATIO",
      constant: "CONTEXT_PRUNE_RATIO",
    },
    {
      field: "contextPruneSafetyRatio",
      envVar: "OPENTIDE_CONTEXT_PRUNE_SAFETY_RATIO",
      constant: "CONTEXT_PRUNE_SAFETY_RATIO",
    },
  ] as const
) {
  Deno.test(
    `kernel settings: ${knob.field} resolves file → env → constant, invalid falls back`,
    async () => {
      const home = await Deno.makeTempDir({
        prefix: `genie-config-${knob.field}-`,
      });
      const oldHome = Deno.env.get("HOME");
      const oldEnv = Deno.env.get(knob.envVar);
      try {
        Deno.env.set("HOME", home);
        Deno.env.delete(knob.envVar);
        const config = await import(`./config.ts?test=${crypto.randomUUID()}`);
        const CONSTANT = config[knob.constant];

        // Unset file + env → the constant default.
        assertEquals(config.getKernelSettings()[knob.field], CONSTANT);

        // A valid file value in (0, 1] wins over the constant.
        config.setKernelSettings({ [knob.field]: 0.5 });
        assertEquals(config.getKernelSettings()[knob.field], 0.5);

        // A valid env var overrides the file value (precedence: env > file).
        Deno.env.set(knob.envVar, "0.3");
        assertEquals(config.getKernelSettings()[knob.field], 0.3);

        // An invalid env value (unparseable, or out of range) falls back to the
        // file value (0.5) — never to the constant while the file value is valid.
        Deno.env.set(knob.envVar, "not-a-number");
        assertEquals(config.getKernelSettings()[knob.field], 0.5);
        Deno.env.set(knob.envVar, "1.5");
        assertEquals(config.getKernelSettings()[knob.field], 0.5);
        Deno.env.delete(knob.envVar);

        // An invalid file value (0, > 1, NaN → JSON null) falls back to the constant.
        config.setKernelSettings({ [knob.field]: 0 });
        assertEquals(config.getKernelSettings()[knob.field], CONSTANT);
        config.setKernelSettings({ [knob.field]: 2 });
        assertEquals(config.getKernelSettings()[knob.field], CONSTANT);
        config.setKernelSettings({ [knob.field]: NaN });
        assertEquals(config.getKernelSettings()[knob.field], CONSTANT);

        // 1.0 is the inclusive upper bound — a full-window ratio is valid.
        Deno.env.set(knob.envVar, "1");
        assertEquals(config.getKernelSettings()[knob.field], 1);
      } finally {
        if (oldEnv === undefined) Deno.env.delete(knob.envVar);
        else Deno.env.set(knob.envVar, oldEnv);
        if (oldHome === undefined) Deno.env.delete("HOME");
        else Deno.env.set("HOME", oldHome);
        await Deno.remove(home, { recursive: true });
      }
    },
  );
}

// §8 (agent cost reduction): contextPruneMaxRewriteRatio shares the cascade but NOT
// the (0, 1] clamp — rewritten/reclaimed is a cost ratio and is routinely above 1, so
// the ratio normalizer would reject every sane value. Only "finite and positive" is
// enforced, and invalid input still falls back rather than clamping.
Deno.test("kernel settings: contextPruneMaxRewriteRatio resolves file → env → constant, invalid falls back", async () => {
  const home = await Deno.makeTempDir({ prefix: "genie-config-rewriteratio-" });
  const oldHome = Deno.env.get("HOME");
  const envVar = "OPENTIDE_CONTEXT_PRUNE_MAX_REWRITE_RATIO";
  const oldEnv = Deno.env.get(envVar);
  try {
    Deno.env.set("HOME", home);
    Deno.env.delete(envVar);
    const config = await import(`./config.ts?test=${crypto.randomUUID()}`);
    const CONSTANT = config.CONTEXT_PRUNE_MAX_REWRITE_RATIO;

    assertEquals(
      config.getKernelSettings().contextPruneMaxRewriteRatio,
      CONSTANT,
    );

    // A value above 1 is VALID here — that is the whole difference from the ratios.
    config.setKernelSettings({ contextPruneMaxRewriteRatio: 3.5 });
    assertEquals(config.getKernelSettings().contextPruneMaxRewriteRatio, 3.5);

    Deno.env.set(envVar, "1.2");
    assertEquals(config.getKernelSettings().contextPruneMaxRewriteRatio, 1.2);

    // Invalid env → the file value, never the constant while the file value stands.
    Deno.env.set(envVar, "not-a-number");
    assertEquals(config.getKernelSettings().contextPruneMaxRewriteRatio, 3.5);
    Deno.env.set(envVar, "0");
    assertEquals(config.getKernelSettings().contextPruneMaxRewriteRatio, 3.5);
    Deno.env.delete(envVar);

    // Invalid file value → the constant.
    config.setKernelSettings({ contextPruneMaxRewriteRatio: -1 });
    assertEquals(
      config.getKernelSettings().contextPruneMaxRewriteRatio,
      CONSTANT,
    );
    config.setKernelSettings({ contextPruneMaxRewriteRatio: NaN });
    assertEquals(
      config.getKernelSettings().contextPruneMaxRewriteRatio,
      CONSTANT,
    );
  } finally {
    if (oldEnv === undefined) Deno.env.delete(envVar);
    else Deno.env.set(envVar, oldEnv);
    if (oldHome === undefined) Deno.env.delete("HOME");
    else Deno.env.set("HOME", oldHome);
    await Deno.remove(home, { recursive: true });
  }
});

// §4.6 (agent cost reduction): contextWorkingBudgetTokens shares the same
// file → env → constant cascade, but it is a token COUNT, not a ratio — its
// normalizer requires a finite integer at or above CONTEXT_WORKING_BUDGET_MIN_TOKENS
// and skips (never clamps) anything else. Mirrors the ratio coverage above.
Deno.test("kernel settings: contextWorkingBudgetTokens resolves file → env → constant, invalid falls back", async () => {
  const home = await Deno.makeTempDir({ prefix: "genie-config-workbudget-" });
  const oldHome = Deno.env.get("HOME");
  const envVar = "OPENTIDE_CONTEXT_WORKING_BUDGET";
  const oldEnv = Deno.env.get(envVar);
  try {
    Deno.env.set("HOME", home);
    Deno.env.delete(envVar);
    const config = await import(`./config.ts?test=${crypto.randomUUID()}`);
    const CONSTANT = config.CONTEXT_WORKING_BUDGET_TOKENS;
    const FLOOR = config.CONTEXT_WORKING_BUDGET_MIN_TOKENS;

    // Unset file + env → the constant default.
    assertEquals(
      config.getKernelSettings().contextWorkingBudgetTokens,
      CONSTANT,
    );

    // A valid file value wins over the constant.
    config.setKernelSettings({ contextWorkingBudgetTokens: 400_000 });
    assertEquals(
      config.getKernelSettings().contextWorkingBudgetTokens,
      400_000,
    );

    // A valid env var overrides the file value (precedence: env > file).
    Deno.env.set(envVar, "150000");
    assertEquals(
      config.getKernelSettings().contextWorkingBudgetTokens,
      150_000,
    );

    // Invalid env values fall back to the file value (400_000) — never to the
    // constant while the file value is valid.
    for (const bad of ["not-a-number", "1000", "120000.5", ""]) {
      Deno.env.set(envVar, bad);
      assertEquals(
        config.getKernelSettings().contextWorkingBudgetTokens,
        400_000,
        `env "${bad}" should fall through to the file value`,
      );
    }
    Deno.env.delete(envVar);

    // Invalid file values fall back to the constant: below the floor, fractional,
    // zero/negative, NaN (JSON null on the way through the config file).
    for (const bad of [FLOOR - 1, 0, -1, 1_000, 200_000.5, NaN]) {
      config.setKernelSettings({ contextWorkingBudgetTokens: bad });
      assertEquals(
        config.getKernelSettings().contextWorkingBudgetTokens,
        CONSTANT,
        `file value ${bad} should fall back to the constant`,
      );
    }

    // The floor itself is valid — inclusive lower bound.
    config.setKernelSettings({ contextWorkingBudgetTokens: FLOOR });
    assertEquals(config.getKernelSettings().contextWorkingBudgetTokens, FLOOR);
  } finally {
    if (oldEnv === undefined) Deno.env.delete(envVar);
    else Deno.env.set(envVar, oldEnv);
    if (oldHome === undefined) Deno.env.delete("HOME");
    else Deno.env.set("HOME", oldHome);
    await Deno.remove(home, { recursive: true });
  }
});

// Slice 6: autoCompactEnabled shares the file → env → constant cascade. The
// OPENTIDE_AUTO_COMPACT_ENABLED env override takes "1"/"0"; any other value falls
// through to the merged file/constant boolean.
Deno.test("kernel settings: autoCompactEnabled env override + invalid fallback", async () => {
  const home = await Deno.makeTempDir({ prefix: "genie-config-autocompact-" });
  const oldHome = Deno.env.get("HOME");
  const oldEnv = Deno.env.get("OPENTIDE_AUTO_COMPACT_ENABLED");
  try {
    Deno.env.set("HOME", home);
    Deno.env.delete("OPENTIDE_AUTO_COMPACT_ENABLED");
    const config = await import(`./config.ts?test=${crypto.randomUUID()}`);

    // Default is AUTOCOMPACT_ENABLED_DEFAULT (true), unset file + env.
    assertEquals(config.getKernelSettings().autoCompactEnabled, true);
    assertEquals(config.AUTOCOMPACT_ENABLED_DEFAULT, true);

    // A file value wins over the constant.
    config.setKernelSettings({ autoCompactEnabled: false });
    assertEquals(config.getKernelSettings().autoCompactEnabled, false);

    // env "1" overrides the file value false → true.
    Deno.env.set("OPENTIDE_AUTO_COMPACT_ENABLED", "1");
    assertEquals(config.getKernelSettings().autoCompactEnabled, true);

    // env "0" overrides the file value true → false.
    config.setKernelSettings({ autoCompactEnabled: true });
    Deno.env.set("OPENTIDE_AUTO_COMPACT_ENABLED", "0");
    assertEquals(config.getKernelSettings().autoCompactEnabled, false);

    // An invalid env value falls through to the file value (still true here).
    Deno.env.set("OPENTIDE_AUTO_COMPACT_ENABLED", "yes");
    assertEquals(config.getKernelSettings().autoCompactEnabled, true);
  } finally {
    if (oldEnv === undefined) Deno.env.delete("OPENTIDE_AUTO_COMPACT_ENABLED");
    else Deno.env.set("OPENTIDE_AUTO_COMPACT_ENABLED", oldEnv);
    if (oldHome === undefined) Deno.env.delete("HOME");
    else Deno.env.set("HOME", oldHome);
    await Deno.remove(home, { recursive: true });
  }
});

// Stage 2B Slice 1: the writer + the config-reading provider seam, end-to-end. Wire
// usage.ts's provider to the fresh config's overrides (as project-loader.ts does at
// runtime), write one tier, and confirm getModelPricing reflects it while the rest
// stay on the seed. Always restore the no-op provider so the singleton never leaks.
Deno.test("setPricingTier: a written tier overrides getModelPricing; others keep the seed", async () => {
  await withFreshConfig("genie-config-pricing-", (config) => {
    setPricingTableProvider(config.getPricingTableOverrides);
    try {
      // Empty config ⇒ every price is the seed.
      assertEquals(config.getPricingTableOverrides(), {});
      assertEquals(getModelPricing("claude-sonnet-5")?.input, 2);

      const override: ModelPricing = {
        input: 4,
        output: 20,
        cacheCreation: 5,
        cacheRead: 0.4,
        unit: "MTok",
      };
      config.setPricingTier("sonnet", override);

      // The write is durable (round-trips through config.json) and the provider
      // reads it fresh, so getModelPricing returns the override...
      assertEquals(config.getPricingTableOverrides().sonnet, override);
      assertEquals(getModelPricing("claude-sonnet-5"), override);
      // ...while a tier that was never written still resolves to the seed.
      assertEquals(getModelPricing("claude-opus-5")?.input, 5);
    } finally {
      setPricingTableProvider(() => ({}));
    }
  });
});

Deno.test("setProviderModelPricing: provider-aware override round-trips through config", async () => {
  await withFreshConfig("genie-config-provider-pricing-", (config) => {
    setProviderModelPricingTableProvider(
      config.getProviderModelPricingOverrides,
    );
    try {
      assertEquals(config.getProviderModelPricingOverrides(), []);
      assertEquals(getProviderModelPricing("openai", "gpt-5"), undefined);

      const row: ProviderModelPricing = {
        provider: "openai",
        model: "gpt-5",
        input: 1.25,
        output: 10,
        unit: "MTok",
        currency: "USD",
        source: "manual",
        verifiedAt: "2026-09-10T00:00:00Z",
        sourceUrl: "https://example.invalid/openai-pricing",
        notes: "test row",
      };
      config.setProviderModelPricing(row);

      assertEquals(config.getProviderModelPricingOverrides(), [row]);
      assertEquals(getProviderModelPricing("openai", "gpt-5"), row);
    } finally {
      setProviderModelPricingTableProvider(() => []);
    }
  });
});

Deno.test("setProviderModelPricing: OpenAI rejects non-manual/non-verified row sources", async () => {
  await withFreshConfig("genie-config-provider-pricing-source-", (config) => {
    assertThrows(
      () =>
        config.setProviderModelPricing({
          provider: "openai",
          model: "gpt-5",
          input: 1,
          output: 8,
          unit: "MTok",
          currency: "USD",
          source: "provider_metadata",
        }),
      Error,
      "Invalid provider model pricing row.",
    );
    assertEquals(config.getProviderModelPricingOverrides(), []);
  });
});

Deno.test("model cache: provider-aware OpenAI row hydrates display pricing without cache rates", async () => {
  await withFreshConfigCache(
    "genie-config-display-provider-pricing-",
    [{ id: "gpt-5", provider: "openai" }],
    (config) => {
      setProviderModelPricingTableProvider(
        config.getProviderModelPricingOverrides,
      );
      try {
        config.setProviderModelPricing({
          provider: "openai",
          model: "gpt-5",
          input: 1.25,
          output: 10,
          unit: "MTok",
          currency: "USD",
          source: "manual",
        });
        const model = config.getAvailableModels().find((m) => m.id === "gpt-5");
        assertEquals(model?.pricing?.input, 1.25);
        assertEquals(model?.pricing?.output, 10);
      } finally {
        setProviderModelPricingTableProvider(() => []);
      }
    },
  );
});

Deno.test("model cache: stale provider-tagged pricing cannot price OpenAI without provider row", async () => {
  await withFreshConfigCache(
    "genie-config-stale-provider-pricing-",
    [{
      id: "gpt-5",
      provider: "openai",
      pricing: {
        input: 3,
        output: 15,
        cacheCreation: 3.75,
        cacheRead: 0.3,
        unit: "MTok",
      },
    }],
    (config) => {
      const model = config.getAvailableModels().find((m) => m.id === "gpt-5");
      assertEquals(model?.provider, "openai");
      assertEquals(model?.pricing, undefined);
    },
  );
});

Deno.test("models.dev enrichment hydrates exact provider/model metadata and pricing rows", async () => {
  await withFreshConfigCache(
    "genie-config-models-dev-enrich-",
    [{ id: "gpt-5", provider: "openai" }],
    (config) => {
      seedModelsDevCache(Deno.env.get("HOME")!, {
        openai: {
          id: "openai",
          name: "OpenAI",
          env: ["OPENAI_API_KEY"],
          npm: "@ai-sdk/openai",
          models: {
            "gpt-5": {
              id: "gpt-5",
              name: "GPT-5",
              family: "gpt-5",
              tool_call: true,
              structured_output: true,
              reasoning: true,
              last_updated: "2026-09-01",
              modalities: { input: ["text", "image"], output: ["text"] },
              limit: { context: 400000, output: 128000 },
              cost: {
                input: 1.25,
                output: 10,
                cache_read: 0.125,
                cache_write: 1.5625,
              },
            },
          },
        },
      });
      setProviderModelPricingTableProvider(config.getProviderModelPricingRows);
      try {
        const model = config.getAvailableModels().find((m) => m.id === "gpt-5");
        assertEquals(model?.label, "GPT-5");
        assertEquals(model?.family, "gpt-5");
        assertEquals(model?.contextWindow, 400000);
        assertEquals(model?.metadataSource, "models.dev");
        assertEquals(model?.capabilities?.toolCall, true);
        assertEquals(model?.modalities?.input, ["text", "image"]);
        assertEquals(model?.pricing?.input, 1.25);
        assertEquals(
          getProviderModelPricing("openai", "gpt-5")?.source,
          "models_dev",
        );
      } finally {
        setProviderModelPricingTableProvider(() => []);
      }
    },
  );
});

Deno.test("models.dev pricing is lower priority than manual provider pricing", async () => {
  await withFreshConfigCache(
    "genie-config-models-dev-precedence-",
    [{ id: "gpt-5", provider: "openai" }],
    (config) => {
      seedModelsDevCache(Deno.env.get("HOME")!, {
        openai: {
          id: "openai",
          name: "OpenAI",
          env: ["OPENAI_API_KEY"],
          npm: "@ai-sdk/openai",
          models: {
            "gpt-5": {
              id: "gpt-5",
              cost: { input: 1.25, output: 10 },
            },
          },
        },
      });
      const manual: ProviderModelPricing = {
        provider: "openai",
        model: "gpt-5",
        input: 9,
        output: 18,
        cacheCreation: 11.25,
        cacheRead: 0.9,
        unit: "MTok",
        currency: "USD",
        source: "manual",
      };
      config.setProviderModelPricing(manual);
      setProviderModelPricingTableProvider(config.getProviderModelPricingRows);
      try {
        assertEquals(getProviderModelPricing("openai", "gpt-5"), manual);
      } finally {
        setProviderModelPricingTableProvider(() => []);
      }
    },
  );
});

Deno.test("OpenAI picker curation shows mainstream GPT families and preserves pinned hidden models", async () => {
  await withFreshConfigCache(
    "genie-config-openai-curation-",
    [
      { id: "gpt-4o", provider: "openai" },
      { id: "gpt-4.1-mini", provider: "openai" },
      { id: "gpt-5", provider: "openai" },
      { id: "gpt-5.6-preview", provider: "openai" },
      { id: "gpt-4.1-2025-04-14", provider: "openai" },
      { id: "text-embedding-3-large", provider: "openai" },
      { id: "gpt-image-1", provider: "openai" },
    ],
    (config) => {
      config.setAgentModel("gpt-image-1");
      const ids = config.getAvailableModels().map((m) => m.id);
      assertEquals(ids.includes("gpt-4o"), true);
      assertEquals(ids.includes("gpt-4.1-mini"), true);
      assertEquals(ids.includes("gpt-5"), true);
      assertEquals(ids.includes("gpt-5.6-preview"), true);
      assertEquals(ids.includes("gpt-4.1-2025-04-14"), false);
      assertEquals(ids.includes("text-embedding-3-large"), false);
      assertEquals(ids.includes("gpt-image-1"), true);
    },
  );
});

Deno.test("models.dev OpenAI-compatible providers keep their own provider id and pricing namespace", async () => {
  const prev = Deno.env.get("ZHIPU_API_KEY");
  try {
    Deno.env.set("ZHIPU_API_KEY", "sk-zhipu-test");
    await withFreshConfigCache(
      "genie-config-models-dev-provider-",
      [{ id: "glm-4.5", provider: "zai" }],
      (config) => {
        seedModelsDevCache(Deno.env.get("HOME")!, {
          zai: {
            id: "zai",
            name: "Z.AI",
            env: ["ZHIPU_API_KEY"],
            npm: "@ai-sdk/openai-compatible",
            api: "https://api.z.ai/api/paas/v4",
            models: {
              "glm-4.5": {
                id: "glm-4.5",
                name: "GLM-4.5",
                family: "glm",
                limit: { context: 128000, output: 32000 },
                cost: { input: 0.6, output: 2.2 },
              },
            },
          },
        });
        setProviderModelPricingTableProvider(
          config.getProviderModelPricingRows,
        );
        try {
          assertEquals(config.providerFor("glm-4.5"), "zai");
          assertEquals(config.hasAnyProviderKey(), true);
          assertEquals(
            config.providerDescriptorFor("zai")?.modelsUrl(),
            "https://api.z.ai/api/paas/v4/models",
          );
          assertEquals(
            config.openAiCompatibleBaseUrlFor("zai"),
            "https://api.z.ai/api/paas/v4",
          );
          const pricing = getProviderModelPricing("zai", "glm-4.5");
          assertEquals(pricing?.input, 0.6);
          assertEquals(pricing?.cacheCreation, undefined);
          assertEquals(pricing?.cacheRead, undefined);
          assertEquals(getProviderModelPricing("openai", "glm-4.5"), undefined);
        } finally {
          setProviderModelPricingTableProvider(() => []);
        }
      },
    );
  } finally {
    if (prev === undefined) Deno.env.delete("ZHIPU_API_KEY");
    else Deno.env.set("ZHIPU_API_KEY", prev);
  }
});

Deno.test("models.dev OpenAI-compatible provider descriptors survive stale catalog cache", async () => {
  const prev = Deno.env.get("ZHIPU_API_KEY");
  try {
    Deno.env.set("ZHIPU_API_KEY", "sk-zhipu-stale-test");
    await withFreshConfigCache(
      "genie-config-models-dev-provider-stale-",
      [{ id: "glm-4.5", provider: "zai" }],
      (config) => {
        seedModelsDevCache(
          Deno.env.get("HOME")!,
          {
            zai: {
              id: "zai",
              name: "Z.AI",
              env: ["ZHIPU_API_KEY"],
              npm: "@ai-sdk/openai-compatible",
              api: "https://api.z.ai/api/paas/v4",
              models: {
                "glm-4.5": {
                  id: "glm-4.5",
                  name: "GLM-4.5",
                  cost: { input: 0.6, output: 2.2 },
                },
              },
            },
          },
          "2026-01-01T00:00:00.000Z",
        );

        assertEquals(config.providerFor("glm-4.5"), "zai");
        assertEquals(config.getProviderKey("zai"), "sk-zhipu-stale-test");
        assertEquals(
          config.openAiCompatibleBaseUrlFor("zai"),
          "https://api.z.ai/api/paas/v4",
        );
      },
    );
  } finally {
    if (prev === undefined) Deno.env.delete("ZHIPU_API_KEY");
    else Deno.env.set("ZHIPU_API_KEY", prev);
  }
});
