// Unit tests for the provider-error classifier (context-hardening plan, Slice 5).
// toProviderError inspects a raw provider error and maps context-length / rate-limit /
// server-error signatures onto the semantic PROVIDER_ERROR_CODES the loop reacts to.
// Pure, network-free: we feed crafted Errors and plain objects carrying each known
// Anthropic + OpenAI signature and assert the resolved code. The other providers/*_test.ts
// are the pattern (mapping helpers exercised directly).

import { assertAlmostEquals, assertEquals } from "@std/assert";
import type { LanguageModelUsage } from "ai";
import {
  toModelMessages,
  toProviderError,
  toTurnUsage,
} from "./ai-sdk-shared.ts";
import { PROVIDER_ERROR_CODES } from "../core/model-provider.ts";
import {
  type ProviderModelPricing,
  setProviderModelPricingTableProvider,
} from "../core/usage.ts";

const started = new Date("2026-08-02T00:00:00.000Z");
const ended = new Date("2026-08-02T00:00:01.500Z");

Deno.test("toTurnUsage prefers noCacheTokens and keeps cache read separate", () => {
  const usage = {
    inputTokens: 13_233,
    inputTokenDetails: {
      noCacheTokens: 2,
      cacheReadTokens: 13_231,
      cacheWriteTokens: 0,
    },
    outputTokens: 80,
    totalTokens: 13_313,
  } as unknown as LanguageModelUsage;
  const turn = toTurnUsage(usage, "claude-opus-4-8", started, ended);
  assertEquals(turn.inputTokens, 2);
  assertEquals(turn.cacheReadInputTokens, 13_231);
  assertEquals(turn.cacheCreationInputTokens, 0);
});

Deno.test("toTurnUsage derives uncached input from raw input when cache details omit noCacheTokens", () => {
  const usage = {
    inputTokens: 1_000,
    inputTokenDetails: {
      cacheReadTokens: 300,
      cacheWriteTokens: 200,
    },
    outputTokens: 40,
    totalTokens: 1_040,
  } as unknown as LanguageModelUsage;
  const turn = toTurnUsage(usage, "gpt-5", started, ended);
  assertEquals(turn.inputTokens, 500);
  assertEquals(turn.cacheReadInputTokens, 300);
  assertEquals(turn.cacheCreationInputTokens, 200);
  assertEquals(turn.pricingStatus, "unpriced");
  assertEquals(turn.costUsd, 0);
});

Deno.test("toTurnUsage preserves raw input when no cache details are present", () => {
  const usage = {
    inputTokens: 123,
    outputTokens: 45,
    totalTokens: 168,
  } as unknown as LanguageModelUsage;
  const turn = toTurnUsage(usage, "gpt-5", started, ended);
  assertEquals(turn.inputTokens, 123);
  assertEquals(turn.outputTokens, 45);
  assertEquals(turn.cacheReadInputTokens, 0);
  assertEquals(turn.cacheCreationInputTokens, 0);
  assertEquals(turn.pricingStatus, "unpriced");
  assertEquals(turn.costUsd, 0);
});

Deno.test("toTurnUsage uses provider-aware pricing when provider id is supplied", () => {
  const row: ProviderModelPricing = {
    provider: "openai",
    model: "gpt-5",
    input: 1.25,
    output: 10,
    unit: "MTok",
    currency: "USD",
    source: "manual",
  };
  setProviderModelPricingTableProvider(() => [row]);
  try {
    const usage = {
      inputTokens: 2_000_000,
      outputTokens: 500_000,
      totalTokens: 2_500_000,
    } as unknown as LanguageModelUsage;
    const turn = toTurnUsage(usage, "gpt-5", started, ended, "openai");
    assertEquals(turn.pricingStatus, "priced");
    assertEquals(turn.costUsd, 7.5);
  } finally {
    setProviderModelPricingTableProvider(() => []);
  }
});

Deno.test("toTurnUsage preserves custom provider ids for provider-aware pricing", () => {
  const row: ProviderModelPricing = {
    provider: "zai",
    model: "glm-4.5",
    input: 0.6,
    output: 2.2,
    cacheCreation: 0.75,
    cacheRead: 0.06,
    unit: "MTok",
    currency: "USD",
    source: "models_dev",
  };
  setProviderModelPricingTableProvider(() => [row]);
  try {
    const usage = {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      totalTokens: 2_000_000,
    } as unknown as LanguageModelUsage;
    const turn = toTurnUsage(usage, "glm-4.5", started, ended, "zai");
    assertEquals(turn.pricingStatus, "priced");
    assertAlmostEquals(turn.costUsd, 2.8);
  } finally {
    setProviderModelPricingTableProvider(() => []);
  }
});

// docs/agent-cost-reduction.md §4.9: a 1h cache write bills at 2x input, not the
// table's 5m 1.25x. Opus 5 is $5 in / $6.25 cache-write 5m / $10 cache-write 1h.
Deno.test("toTurnUsage prices cache writes by the TTL the provider used", () => {
  const usage = {
    inputTokens: 1_000_000,
    inputTokenDetails: {
      noCacheTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 1_000_000,
    },
    outputTokens: 0,
    totalTokens: 1_000_000,
  } as unknown as LanguageModelUsage;

  const dflt = toTurnUsage(usage, "claude-opus-5", started, ended, "anthropic");
  assertEquals(dflt.cacheCreationInputTokens, 1_000_000);
  assertEquals(dflt.costUsd, 6.25);

  // Omitting the TTL and asking for 5m must agree — the streaming path passes
  // nothing and must stay byte-identical.
  assertEquals(
    toTurnUsage(usage, "claude-opus-5", started, ended, "anthropic", "5m")
      .costUsd,
    6.25,
  );
  assertEquals(
    toTurnUsage(usage, "claude-opus-5", started, ended, "anthropic", "1h")
      .costUsd,
    10,
  );
  // The legacy Anthropic-only path (no provider id) must scale identically.
  assertEquals(
    toTurnUsage(usage, "claude-opus-5", started, ended, undefined, "1h")
      .costUsd,
    10,
  );
});

Deno.test("toModelMessages strips private loop side-channels from tool results", () => {
  const messages = toModelMessages(
    [
      {
        role: "assistant",
        content: [{
          type: "tool_use",
          id: "call_1",
          name: "test_app",
          input: {},
        }],
      },
      {
        role: "tool",
        content: [{
          type: "tool_result",
          toolCallId: "call_1",
          output: {
            ok: true,
            data: { id: "cs_1", steps: [{ id: "s1", status: "done" }] },
            _images: [{ png: new Uint8Array([1, 2, 3]) }],
            // The duplicate copy of `data` (docs/agent-cost-reduction.md §2.2) and the
            // loop's routing tag: both are IDE-facing and must never reach the model.
            _changeset: { id: "cs_1", steps: [{ id: "s1", status: "done" }] },
            _changesetEvent: { type: "changeset_updated" },
          },
        }],
      },
    ],
    "anthropic",
    false,
  );

  const toolMessage = messages[1];
  assertEquals(toolMessage?.role, "tool");
  const content = Array.isArray(toolMessage?.content)
    ? toolMessage.content
    : [];
  const part = content[0] as { type?: string; output?: unknown } | undefined;
  assertEquals(part?.type, "tool-result");
  assertEquals(part?.output, {
    type: "json",
    value: {
      ok: true,
      data: { id: "cs_1", steps: [{ id: "s1", status: "done" }] },
    },
  });
});

Deno.test("toProviderError — Anthropic 'prompt is too long' → CONTEXT_LENGTH_EXCEEDED", () => {
  const err = new Error(
    "prompt is too long: 210000 tokens > 200000 maximum",
  );
  assertEquals(
    toProviderError(err).code,
    PROVIDER_ERROR_CODES.CONTEXT_LENGTH_EXCEEDED,
  );
});

Deno.test("toProviderError — Anthropic invalid_request_error length signature via structured type → CONTEXT_LENGTH_EXCEEDED", () => {
  // The message alone carries the length signature; the nested provider type mirrors
  // Anthropic's invalid_request_error envelope.
  const err = {
    statusCode: 400,
    error: { type: "invalid_request_error" },
    message:
      "input length and max_tokens exceed context limit: too many tokens",
  };
  assertEquals(
    toProviderError(err).code,
    PROVIDER_ERROR_CODES.CONTEXT_LENGTH_EXCEEDED,
  );
});

Deno.test("toProviderError — OpenAI structured code context_length_exceeded → CONTEXT_LENGTH_EXCEEDED", () => {
  const err = {
    statusCode: 400,
    code: "context_length_exceeded",
    message: "This model's maximum context length is 128000 tokens.",
  };
  assertEquals(
    toProviderError(err).code,
    PROVIDER_ERROR_CODES.CONTEXT_LENGTH_EXCEEDED,
  );
});

Deno.test("toProviderError — OpenAI 'maximum context length' message → CONTEXT_LENGTH_EXCEEDED", () => {
  const err = new Error(
    "This model's maximum context length is 128000 tokens, however you requested 130000.",
  );
  assertEquals(
    toProviderError(err).code,
    PROVIDER_ERROR_CODES.CONTEXT_LENGTH_EXCEEDED,
  );
});

Deno.test("toProviderError — case-insensitive match on the message", () => {
  const err = new Error("PROMPT IS TOO LONG");
  assertEquals(
    toProviderError(err).code,
    PROVIDER_ERROR_CODES.CONTEXT_LENGTH_EXCEEDED,
  );
});

Deno.test("toProviderError — HTTP 429 statusCode → RATE_LIMITED", () => {
  const err = { statusCode: 429, message: "Too Many Requests" };
  assertEquals(
    toProviderError(err).code,
    PROVIDER_ERROR_CODES.RATE_LIMITED,
  );
});

Deno.test("toProviderError — 'rate limit' message → RATE_LIMITED", () => {
  const err = new Error("Rate limit reached for requests");
  assertEquals(
    toProviderError(err).code,
    PROVIDER_ERROR_CODES.RATE_LIMITED,
  );
});

Deno.test("toProviderError — HTTP 503 statusCode → TRANSIENT", () => {
  const err = { statusCode: 503, message: "Service temporarily unavailable" };
  assertEquals(
    toProviderError(err).code,
    PROVIDER_ERROR_CODES.TRANSIENT,
  );
});

Deno.test("toProviderError — Anthropic 'Overloaded' → TRANSIENT", () => {
  const err = {
    error: { type: "overloaded_error" },
    message: "Overloaded",
  };
  assertEquals(
    toProviderError(err).code,
    PROVIDER_ERROR_CODES.TRANSIENT,
  );
});

Deno.test("toProviderError — arbitrary error → PROVIDER_ERROR (unchanged default)", () => {
  const err = new Error("something unexpected happened");
  const result = toProviderError(err);
  assertEquals(result.code, PROVIDER_ERROR_CODES.PROVIDER_ERROR);
  // The message is preserved verbatim regardless of the classified code.
  assertEquals(result.message, "something unexpected happened");
});

Deno.test("toProviderError — a non-Error plain value classifies without throwing", () => {
  assertEquals(
    toProviderError("plain string error").code,
    PROVIDER_ERROR_CODES.PROVIDER_ERROR,
  );
  assertEquals(
    toProviderError(null).code,
    PROVIDER_ERROR_CODES.PROVIDER_ERROR,
  );
});
