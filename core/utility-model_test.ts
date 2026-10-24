import { assertEquals, assertRejects } from "@std/assert";
import {
  callUtilityModel,
  installUtilityModelProvider,
  setUtilityModelCallForTest,
  setUtilityModelUsageRecorderForTest,
  UTILITY_MODEL_UNINSTALLED_MESSAGE,
  type UtilityModelCall,
  type UtilityModelResult,
} from "./utility-model.ts";
import type { ModelUsageRecord, RecordModelUsageInput } from "./types.ts";

function result(text: string): UtilityModelResult {
  return {
    text,
    usage: {
      inputTokens: 1,
      outputTokens: 2,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    },
  };
}

function usageRecord(input: RecordModelUsageInput): ModelUsageRecord {
  return {
    id: "mu_test",
    sessionId: input.sessionId ?? null,
    turnId: input.turnId ?? null,
    auditResultId: input.auditResultId ?? null,
    changesetId: input.changesetId ?? null,
    provider: input.provider,
    model: input.model,
    role: input.role,
    caller: input.caller,
    startedAt: input.startedAt instanceof Date
      ? input.startedAt.toISOString()
      : input.startedAt,
    endedAt: input.endedAt instanceof Date
      ? input.endedAt.toISOString()
      : input.endedAt,
    durationMs: 0,
    inputTokens: input.usage.inputTokens,
    outputTokens: input.usage.outputTokens,
    cacheCreationInputTokens: input.usage.cacheCreationInputTokens,
    cacheReadInputTokens: input.usage.cacheReadInputTokens,
    toolCallsCount: input.toolCallsCount ?? 0,
    costUsd: null,
    pricingStatus: "unpriced",
    pricingProvider: null,
    pricingModel: null,
    pricingVerifiedAt: null,
    pricingSource: null,
    metadata: input.metadata ?? {},
  };
}

// The module-level `installed`/`testOverride` are process globals; each test
// restores what it touched so ordering never leaks.
Deno.test("callUtilityModel rejects when no provider is installed", async () => {
  await assertRejects(
    () => callUtilityModel({ user: "hi", model: "m", maxTokens: 8 }),
    Error,
    UTILITY_MODEL_UNINSTALLED_MESSAGE,
  );
});

Deno.test("callUtilityModel dispatches to the installed provider", async () => {
  const seen: string[] = [];
  const impl: UtilityModelCall = (req) => {
    seen.push(req.user);
    return Promise.resolve(result("installed"));
  };
  installUtilityModelProvider(impl);
  try {
    const out = await callUtilityModel({
      user: "ping",
      model: "m",
      maxTokens: 8,
    });
    assertEquals(out.text, "installed");
    assertEquals(seen, ["ping"]);
  } finally {
    // Reset the process global so later tests see the uninstalled state.
    installUtilityModelProvider(
      () => Promise.reject(new Error(UTILITY_MODEL_UNINSTALLED_MESSAGE)),
    );
  }
});

Deno.test("the test override wins over the installed provider and restores", async () => {
  installUtilityModelProvider(() => Promise.resolve(result("installed")));
  const restore = setUtilityModelCallForTest(() =>
    Promise.resolve(result("override"))
  );
  try {
    const out = await callUtilityModel({ user: "x", model: "m", maxTokens: 8 });
    assertEquals(out.text, "override");
  } finally {
    restore();
  }
  // After restore the override is gone and the installed provider answers again.
  const out = await callUtilityModel({ user: "x", model: "m", maxTokens: 8 });
  assertEquals(out.text, "installed");
  installUtilityModelProvider(
    () => Promise.reject(new Error(UTILITY_MODEL_UNINSTALLED_MESSAGE)),
  );
});

Deno.test("callUtilityModel records accounting metadata when supplied", async () => {
  const seen: RecordModelUsageInput[] = [];
  installUtilityModelProvider(() =>
    Promise.resolve({
      ...result("accounted"),
      provider: "openai",
      model: "gpt-unpriced-for-test",
    })
  );
  const restoreRecorder = setUtilityModelUsageRecorderForTest((input) => {
    seen.push(input);
    return Promise.resolve(
      usageRecord(input),
    );
  });
  try {
    const out = await callUtilityModel({
      user: "price me",
      model: "gpt-unpriced-for-test",
      maxTokens: 8,
      accounting: {
        role: "pricing",
        caller: "pricing_research",
        sessionId: "s1",
        metadata: { sourceUrl: "https://example.test/pricing" },
      },
    });

    assertEquals(out.modelUsage?.pricingStatus, "unpriced");
    assertEquals(seen.length, 1);
    assertEquals(seen[0]!.provider, "openai");
    assertEquals(seen[0]!.model, "gpt-unpriced-for-test");
    assertEquals(seen[0]!.role, "pricing");
    assertEquals(seen[0]!.caller, "pricing_research");
    assertEquals(seen[0]!.sessionId, "s1");
  } finally {
    restoreRecorder();
    installUtilityModelProvider(
      () => Promise.reject(new Error(UTILITY_MODEL_UNINSTALLED_MESSAGE)),
    );
  }
});

Deno.test("callUtilityModel prefers per-call recorder over global recorder", async () => {
  const globalSeen: RecordModelUsageInput[] = [];
  const scopedSeen: RecordModelUsageInput[] = [];
  installUtilityModelProvider(() =>
    Promise.resolve({
      ...result("accounted"),
      provider: "openai",
      model: "gpt-unpriced-for-test",
    })
  );
  const restoreRecorder = setUtilityModelUsageRecorderForTest((input) => {
    globalSeen.push(input);
    return Promise.resolve(usageRecord(input));
  });
  try {
    const out = await callUtilityModel({
      user: "price me",
      model: "gpt-unpriced-for-test",
      maxTokens: 8,
      accounting: {
        role: "utility",
        caller: "session_name",
        sessionId: "s_scoped",
        recordUsage: (input) => {
          scopedSeen.push(input);
          return Promise.resolve({ ...usageRecord(input), id: "mu_scoped" });
        },
      },
    });

    assertEquals(out.modelUsage?.id, "mu_scoped");
    assertEquals(globalSeen.length, 0);
    assertEquals(scopedSeen.length, 1);
    assertEquals(scopedSeen[0]!.sessionId, "s_scoped");
  } finally {
    restoreRecorder();
    installUtilityModelProvider(
      () => Promise.reject(new Error(UTILITY_MODEL_UNINSTALLED_MESSAGE)),
    );
  }
});
