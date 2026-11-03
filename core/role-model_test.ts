// @layer core — role-model: resolve, key check, timeout default, cost.
import { assertEquals, assertRejects } from "@std/assert";
import { callRoleModel, modelCallCost, roleModelStatus } from "./role-model.ts";
import {
  DEFAULT_MODEL_ID,
  getKernelSettings,
  setProviderKey,
  setVerificationModel,
} from "./config.ts";
import {
  setUtilityModelCallForTest,
  type UtilityModelRequest,
} from "./utility-model.ts";
import type { ModelUsageRecord } from "./types.ts";
import { isolateHome } from "./test-home_test.ts";

isolateHome();

const KEY_ENVS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"] as const;

// The real environment may carry a key; these tests need it absent.
function withoutEnvKeys(fn: () => Promise<void> | void) {
  return async () => {
    const saved = KEY_ENVS.map((name) => [name, Deno.env.get(name)] as const);
    for (const name of KEY_ENVS) Deno.env.delete(name);
    try {
      await fn();
    } finally {
      for (const [name, value] of saved) {
        if (value !== undefined) Deno.env.set(name, value);
      }
    }
  };
}

const UNKNOWN_MODEL = "claude-role-model-test-unpriced";

function usageRow(costUsd: number): ModelUsageRecord {
  return { costUsd, pricingStatus: "priced" } as ModelUsageRecord;
}

const tokens = {
  inputTokens: 10,
  outputTokens: 5,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
};

Deno.test(
  "roleModelStatus: a role with no model and no recommendation is unconfigured",
  withoutEnvKeys(() => {
    setVerificationModel(DEFAULT_MODEL_ID);
    const status = roleModelStatus("verification");
    assertEquals(status.ok ? null : status.code, "MODEL_UNCONFIGURED");
  }),
);

Deno.test(
  "roleModelStatus: a pinned model without its provider's key can't run",
  withoutEnvKeys(() => {
    setVerificationModel(UNKNOWN_MODEL);
    const status = roleModelStatus("verification");
    assertEquals(status.ok ? null : status.code, "API_KEY_REQUIRED");
  }),
);

Deno.test(
  "roleModelStatus: a pinned model with a key is ready",
  withoutEnvKeys(() => {
    setProviderKey("anthropic", "sk-test-role-model");
    setVerificationModel(UNKNOWN_MODEL);
    const status = roleModelStatus("verification");
    assertEquals(status, {
      ok: true,
      model: UNKNOWN_MODEL,
      provider: "anthropic",
    });
    setProviderKey("anthropic", "");
  }),
);

Deno.test(
  "callRoleModel refuses without a key when one is required",
  withoutEnvKeys(async () => {
    setProviderKey("anthropic", "");
    const restore = setUtilityModelCallForTest(() => {
      throw new Error("the model must not be called");
    });
    try {
      await assertRejects(
        () =>
          callRoleModel({
            model: UNKNOWN_MODEL,
            user: "hi",
            maxTokens: 8,
            keyRequiredFor: "a test",
          }),
        Error,
        "anthropic API key is required for a test.",
      );
    } finally {
      restore();
    }
  }),
);

Deno.test("callRoleModel defaults the timeout to the audit timeout", async () => {
  let seen: UtilityModelRequest | null = null;
  const restore = setUtilityModelCallForTest((req) => {
    seen = req;
    return Promise.resolve({
      text: "ok",
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
      },
    });
  });
  try {
    const out = await callRoleModel({
      model: UNKNOWN_MODEL,
      user: "hi",
      maxTokens: 8,
    });
    assertEquals(out.text, "ok");
    assertEquals(
      (seen as UtilityModelRequest | null)?.timeoutMs,
      getKernelSettings().auditTimeoutMs,
    );
  } finally {
    restore();
  }
});

Deno.test("modelCallCost: recorded, priced rows win", () => {
  const cost = modelCallCost(UNKNOWN_MODEL, [
    { ...tokens, modelUsage: usageRow(0.25) },
    { ...tokens, modelUsage: usageRow(0.5) },
  ]);
  assertEquals(cost, {
    provider: "anthropic",
    costUsd: 0.75,
    pricingStatus: "priced",
  });
});

Deno.test("modelCallCost: an unrecorded call prices the tokens instead", () => {
  const cost = modelCallCost(UNKNOWN_MODEL, [
    { ...tokens, modelUsage: usageRow(0.25) },
    tokens,
  ]);
  // The test model has no price, so the token path reports unpriced.
  assertEquals(cost, {
    provider: "anthropic",
    costUsd: 0,
    pricingStatus: "unpriced",
  });
});
