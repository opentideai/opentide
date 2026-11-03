// @layer core — one-shot model calls by role, for code outside the kernel.
//
// Reviewers and other plugins ask for "the verification model" or "the utility
// model", not a model id. This resolves the role, checks the provider key,
// applies the audit timeout and prices the result, so a plugin needs nothing
// from config.ts or usage.ts. Calls go through callUtilityModel, so the
// installed provider and its test override both apply.
import type { ModelUsageRecord } from "./types.ts";
import {
  getKernelSettings,
  getModelForRoleRequest,
  getProviderKey,
  MODEL_UNCONFIGURED_MESSAGE,
  type ModelProviderId,
  type ModelRole,
  providerFor,
} from "./config.ts";
import { computeProviderModelCost, type PricingStatus } from "./usage.ts";
import {
  callUtilityModel,
  type UtilityModelRequest,
  type UtilityModelResult,
} from "./utility-model.ts";

export type { ModelRole };
export { MODEL_UNCONFIGURED_MESSAGE };

// The model a role runs on right now, or null when the role is unconfigured.
export function roleModel(role: ModelRole): string | null {
  return getModelForRoleRequest(role) ?? null;
}

export type RoleModelStatus =
  | { ok: true; model: string; provider: ModelProviderId }
  | {
    ok: false;
    code: "MODEL_UNCONFIGURED" | "API_KEY_REQUIRED";
    message: string;
    suggestion: string;
  };

// Whether a role can run: it has a model, and that model's provider has a key.
export function roleModelStatus(role: ModelRole): RoleModelStatus {
  const model = roleModel(role);
  if (!model) {
    return {
      ok: false,
      code: "MODEL_UNCONFIGURED",
      message: MODEL_UNCONFIGURED_MESSAGE,
      suggestion: `Configure a ${role} model in Settings.`,
    };
  }
  const provider = providerFor(model);
  if (!getProviderKey(provider)) {
    return {
      ok: false,
      code: "API_KEY_REQUIRED",
      message: `A ${provider} API key is required for the ${role} model.`,
      suggestion: `Add the ${provider} key in Settings.`,
    };
  }
  return { ok: true, model, provider };
}

export interface RoleModelRequest
  extends Omit<UtilityModelRequest, "timeoutMs"> {
  // Default: the kernel's audit timeout.
  timeoutMs?: number;
  // When set, the call is refused without a key for the model's provider, and
  // the error says what the key was needed for ("adversarial refutation").
  keyRequiredFor?: string;
}

export function callRoleModel(
  req: RoleModelRequest,
): Promise<UtilityModelResult> {
  const { keyRequiredFor, timeoutMs, ...rest } = req;
  if (keyRequiredFor !== undefined) {
    const provider = providerFor(req.model);
    if (!getProviderKey(provider)) {
      return Promise.reject(
        new Error(`${provider} API key is required for ${keyRequiredFor}.`),
      );
    }
  }
  return callUtilityModel({
    ...rest,
    timeoutMs: timeoutMs ?? getKernelSettings().auditTimeoutMs,
  });
}

// What a sequence of calls on one model consumed, as the callers report it.
export interface ModelCallTokens {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  // The ledger row, when usage was recorded. Its cost is authoritative.
  modelUsage?: ModelUsageRecord;
}

export interface ModelCallCost {
  provider: ModelProviderId;
  costUsd: number;
  pricingStatus: PricingStatus;
}

// The cost of `calls` on `model`. When every call was recorded and priced, the
// ledger's numbers win; otherwise the summed tokens are priced now.
export function modelCallCost(
  model: string,
  calls: readonly ModelCallTokens[],
): ModelCallCost {
  const provider = providerFor(model);
  const rows = calls.map((c) => c.modelUsage).filter((
    row,
  ): row is ModelUsageRecord => Boolean(row));
  const allPriced = rows.length === calls.length &&
    rows.every((row) => row.pricingStatus === "priced");
  if (allPriced) {
    return {
      provider,
      costUsd: rows.reduce((sum, row) => sum + (row.costUsd ?? 0), 0),
      pricingStatus: "priced",
    };
  }
  const sum = (pick: (c: ModelCallTokens) => number) =>
    calls.reduce((total, c) => total + pick(c), 0);
  const cost = computeProviderModelCost({
    provider,
    model,
    inputTokens: sum((c) => c.inputTokens),
    outputTokens: sum((c) => c.outputTokens),
    cacheCreationInputTokens: sum((c) => c.cacheCreationInputTokens),
    cacheReadInputTokens: sum((c) => c.cacheReadInputTokens),
  });
  return {
    provider,
    costUsd: cost.costUsd ?? 0,
    pricingStatus: cost.pricingStatus,
  };
}
