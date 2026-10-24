// Cross-provider ProviderEvent parity (multi-model harness, Stage 4 acceptance). The
// Stage 4 gate is that BOTH providers present the exact same contract for the same turn.
// This suite feeds the SAME low-level AI-SDK V4 stream to the real AnthropicModelProvider
// AND the real OpenAiModelProvider (each over a MockLanguageModelV4, no network), through
// REAL streamText().fullStream, and asserts the emitted ProviderEvent sequences are
// byte-for-byte identical. Because the loop maps ProviderEvent → ChatEvent 1:1 and
// deterministically (chat-local-loop_test.ts asserts the ProviderEvent → ChatEvent
// mapping), identical ProviderEvents transitively guarantee an identical ChatEvent
// contract across providers.
//
// The one intentional per-provider difference is the reasoning-capture tag
// (NeutralReasoningBlock.provider), which MUST differ ("anthropic" vs "openai") so a
// cross-provider replay drops foreign internals — that case is asserted separately.

import { assert, assertEquals } from "@std/assert";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import type { LanguageModel } from "ai";
import { AnthropicModelProvider } from "./anthropic-provider.ts";
import { OpenAiModelProvider } from "./openai-provider.ts";
import type {
  ModelProvider,
  NeutralTool,
  ProviderEvent,
  TurnRequest,
} from "../core/model-provider.ts";

// deno-lint-ignore no-explicit-any
type V4Part = any;

function v4Usage(
  input: number,
  output: number,
  cacheRead = 0,
  cacheWrite = 0,
): V4Part {
  return {
    inputTokens: {
      total: input,
      noCache: input - cacheRead - cacheWrite,
      cacheRead,
      cacheWrite,
    },
    outputTokens: { total: output, text: output, reasoning: 0 },
  };
}

type UnifiedFinish = "stop" | "length" | "content-filter" | "tool-calls" | "error" | "other";

function v4Finish(unified: UnifiedFinish, usage: V4Part = v4Usage(10, 5)): V4Part {
  return { type: "finish", usage, finishReason: { unified, raw: unified } };
}

function mockModel(chunks: V4Part[]): LanguageModel {
  return new MockLanguageModelV4({
    doStream: () => Promise.resolve({ stream: simulateReadableStream({ chunks }) }),
  }) as unknown as LanguageModel;
}

function anthropicOver(chunks: V4Part[]): AnthropicModelProvider {
  return new AnthropicModelProvider({
    modelFactory: () => mockModel(chunks),
    thinking: { type: "disabled" },
  });
}

function openaiOver(chunks: V4Part[]): OpenAiModelProvider {
  return new OpenAiModelProvider({ modelFactory: () => mockModel(chunks) });
}

async function collect(
  provider: ModelProvider,
  req: TurnRequest,
): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = [];
  for await (const ev of provider.streamTurn(req, new AbortController().signal)) {
    events.push(ev);
  }
  return events;
}

// Normalize a stamped, non-deterministic field out of usage events so the comparison is
// over the CONTRACT (event types, order, token counts, stop reason), not wall-clock
// timestamps/durations/costs that legitimately differ by microseconds between the two runs.
function normalize(events: ProviderEvent[]): unknown[] {
  return events.map((e) => {
    if (e.type === "turn_usage" || e.type === "model_request_usage") {
      const u = e.usage;
      return {
        type: e.type,
        inputTokens: u.inputTokens,
        outputTokens: u.outputTokens,
        cacheReadInputTokens: u.cacheReadInputTokens,
        cacheCreationInputTokens: u.cacheCreationInputTokens,
        model: u.model,
      };
    }
    return e;
  });
}

const BASE_REQ = {
  system: "You are a test agent.",
  messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "hi" }] }],
  tools: [] as NeutralTool[],
};

// Each scenario is one scripted V4 stream fed to both providers. The model ids differ
// (claude-* vs gpt-*) but the emitted usage carries the request's own model, so the
// comparison substitutes a shared placeholder for the model field.
function assertProviderParity(chunks: V4Part[], req: Partial<TurnRequest> = {}) {
  const anthropicReq: TurnRequest = { model: "claude-opus-4-8", ...BASE_REQ, ...req };
  const openaiReq: TurnRequest = { model: "gpt-5", ...BASE_REQ, ...req };
  return Promise.all([
    collect(anthropicOver(chunks), anthropicReq),
    collect(openaiOver(chunks), openaiReq),
  ]).then(([a, o]) => {
    // The model field legitimately differs (each ran its own id); blank it before diffing.
    const blankModel = (xs: unknown[]) =>
      xs.map((x) => {
        const rec = x as Record<string, unknown>;
        return "model" in rec ? { ...rec, model: "M" } : rec;
      });
    assertEquals(blankModel(normalize(a)), blankModel(normalize(o)));
    return { a, o };
  });
}

Deno.test("parity — text turn: identical ProviderEvent contract on both providers", async () => {
  await assertProviderParity([
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "t0" },
    { type: "text-delta", id: "t0", delta: "Hello, " },
    { type: "text-delta", id: "t0", delta: "world" },
    { type: "text-end", id: "t0" },
    v4Finish("stop", v4Usage(100, 20, 40, 0)),
  ]);
});

Deno.test("parity — tool round-trip: identical ProviderEvent contract on both providers", async () => {
  const tools: NeutralTool[] = [{
    name: "read_file",
    description: "Read a file",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
  }];
  await assertProviderParity([
    { type: "stream-start", warnings: [] },
    {
      type: "tool-call",
      toolCallId: "call_1",
      toolName: "read_file",
      input: JSON.stringify({ path: "main.ts" }),
    },
    v4Finish("tool-calls", v4Usage(120, 8, 30, 0)),
  ], { tools });
});

Deno.test("parity — every finishReason maps identically on both providers", async () => {
  const cases: UnifiedFinish[] = ["stop", "length", "content-filter", "tool-calls", "error", "other"];
  for (const unified of cases) {
    await assertProviderParity([{ type: "stream-start", warnings: [] }, v4Finish(unified)]);
  }
});

Deno.test("parity — reasoning: same event stream, provider tag intentionally differs", async () => {
  const chunks: V4Part[] = [
    { type: "stream-start", warnings: [] },
    { type: "reasoning-start", id: "r0" },
    { type: "reasoning-delta", id: "r0", delta: "think" },
    { type: "reasoning-end", id: "r0" },
    { type: "text-start", id: "t0" },
    { type: "text-delta", id: "t0", delta: "Answer." },
    { type: "text-end", id: "t0" },
    v4Finish("stop"),
  ];
  const [a, o] = await Promise.all([
    collect(anthropicOver(chunks), { model: "claude-opus-4-8", ...BASE_REQ }),
    collect(openaiOver(chunks), { model: "gpt-5", ...BASE_REQ }),
  ]);

  // The live event TYPES match exactly (thinking_start/delta/end, text, usage, complete).
  assertEquals(a.map((e) => e.type), o.map((e) => e.type));

  // The captured reasoning is tagged with each provider's own id — the one intentional
  // difference, which is exactly what makes cross-provider replay drop foreign internals.
  const aComplete = a.find((e) => e.type === "message_complete");
  const oComplete = o.find((e) => e.type === "message_complete");
  assert(aComplete?.type === "message_complete" && oComplete?.type === "message_complete");
  assertEquals(aComplete.reasoning?.[0]?.provider, "anthropic");
  assertEquals(oComplete.reasoning?.[0]?.provider, "openai");
});
