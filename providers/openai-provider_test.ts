// Unit tests for the AI-SDK-backed OpenAI ModelProvider (multi-model harness, Stage 4).
// Network-free, mirroring anthropic-provider_test.ts: feed a MockLanguageModelV4 whose
// doStream emits canned low-level parts, run the whole pipeline through REAL
// streamText().fullStream, and assert the exact ProviderEvent sequence. The
// request/stream MAPPING is the shared ai-sdk-shared.ts code (already covered by the
// Anthropic suite); this suite asserts the OpenAI provider's OWN behavior — its wiring of
// the shared driver, supportsCaching=false, the keyless + tool-limit error paths, and
// that captured reasoning is tagged "openai" (so cross-provider replay is dropped).

import { assert, assertEquals } from "@std/assert";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import type { LanguageModel } from "ai";
import { OpenAiModelProvider } from "./openai-provider.ts";
import type {
  NeutralTool,
  ProviderEvent,
  TurnRequest,
} from "../core/model-provider.ts";

// --- Low-level V4 stream-part builders (what a real provider's doStream emits) ---

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

type UnifiedFinish =
  | "stop"
  | "length"
  | "content-filter"
  | "tool-calls"
  | "error"
  | "other";

function v4Finish(
  unified: UnifiedFinish,
  usage: V4Part = v4Usage(10, 5),
): V4Part {
  return {
    type: "finish",
    usage,
    finishReason: { unified, raw: unified },
  };
}

function mockModel(chunks: V4Part[]): LanguageModel {
  return new MockLanguageModelV4({
    doStream: () =>
      Promise.resolve({
        stream: simulateReadableStream({ chunks }),
      }),
  }) as unknown as LanguageModel;
}

function makeProvider(chunks: V4Part[]): OpenAiModelProvider {
  return new OpenAiModelProvider({ modelFactory: () => mockModel(chunks) });
}

const REQ: TurnRequest = {
  model: "gpt-5",
  system: "You are a test agent.",
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  tools: [],
};

async function collect(
  provider: OpenAiModelProvider,
  req: TurnRequest = REQ,
  signal: AbortSignal = new AbortController().signal,
): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = [];
  for await (const ev of provider.streamTurn(req, signal)) events.push(ev);
  return events;
}

function types(events: ProviderEvent[]): string[] {
  return events.map((e) => e.type);
}

// --- Stream mapping (through the shared driver) -----------------------------

Deno.test("openai streamTurn maps text deltas → text_delta and ends end_turn", async () => {
  const events = await collect(makeProvider([
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "t0" },
    { type: "text-delta", id: "t0", delta: "Hello, " },
    { type: "text-delta", id: "t0", delta: "world" },
    { type: "text-end", id: "t0" },
    v4Finish("stop"),
  ]));

  const text = events
    .filter((e): e is Extract<ProviderEvent, { type: "text_delta" }> =>
      e.type === "text_delta"
    )
    .map((e) => e.text)
    .join("");
  assertEquals(text, "Hello, world");

  const complete = events.find((e) => e.type === "message_complete");
  assert(complete && complete.type === "message_complete");
  assertEquals(complete.stopReason, "end_turn");
  assertEquals(complete.reasoning, undefined);
});

Deno.test("openai streamTurn maps reasoning → thinking_* and tags capture 'openai'", async () => {
  const events = await collect(makeProvider([
    { type: "stream-start", warnings: [] },
    { type: "reasoning-start", id: "r0" },
    { type: "reasoning-delta", id: "r0", delta: "Let me think" },
    { type: "reasoning-delta", id: "r0", delta: " about it." },
    { type: "reasoning-end", id: "r0" },
    { type: "text-start", id: "t0" },
    { type: "text-delta", id: "t0", delta: "Answer." },
    { type: "text-end", id: "t0" },
    v4Finish("stop"),
  ]));

  assertEquals(
    types(events).filter((t) => t.startsWith("thinking")),
    ["thinking_start", "thinking_delta", "thinking_delta", "thinking_end"],
  );

  // The terminal message_complete carries the reasoning block tagged with THIS provider,
  // so a later Anthropic turn drops it (the cross-provider replay guard).
  const complete = events.find((e) => e.type === "message_complete");
  assert(complete && complete.type === "message_complete");
  assert(complete.reasoning && complete.reasoning.length === 1);
  assertEquals(complete.reasoning[0]?.provider, "openai");
});

Deno.test("openai streamTurn surfaces a finalized tool-call and stops requires_action", async () => {
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
  const req: TurnRequest = { ...REQ, tools };
  const provider = makeProvider([
    { type: "stream-start", warnings: [] },
    {
      type: "tool-call",
      toolCallId: "call_1",
      toolName: "read_file",
      input: JSON.stringify({ path: "main.ts" }),
    },
    v4Finish("tool-calls"),
  ]);

  const events = await collect(provider, req);
  const start = events.find((e) => e.type === "tool_use_start");
  assert(start && start.type === "tool_use_start");
  assertEquals(start.toolName, "read_file");
  assertEquals(start.toolCallId, "call_1");
  assertEquals(start.toolInput, { path: "main.ts" });

  const complete = events.find((e) => e.type === "message_complete");
  assert(complete && complete.type === "message_complete");
  assertEquals(complete.stopReason, "requires_action");
});

Deno.test("openai streamTurn emits model_request_usage + turn_usage with cache tokens", async () => {
  const events = await collect(makeProvider([
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "t0" },
    { type: "text-delta", id: "t0", delta: "ok" },
    { type: "text-end", id: "t0" },
    // OpenAI caches server-side; when the API reports cache reads they still surface
    // separately from uncached input tokens (70 uncached + 30 cache-read here).
    v4Finish("stop", v4Usage(100, 40, 30, 0)),
  ]));

  const reqUsage = events.find((e) => e.type === "model_request_usage");
  assert(reqUsage && reqUsage.type === "model_request_usage");
  assertEquals(reqUsage.provider, "openai");
  assertEquals(reqUsage.usage.inputTokens, 70);
  assertEquals(reqUsage.usage.outputTokens, 40);
  assertEquals(reqUsage.usage.cacheReadInputTokens, 30);
  assertEquals(reqUsage.usage.model, "gpt-5");
  assertEquals(reqUsage.usage.pricingStatus, "unpriced");
  assertEquals(reqUsage.usage.costUsd, 0);

  const turnUsage = events.find((e) => e.type === "turn_usage");
  assert(turnUsage && turnUsage.type === "turn_usage");
  assertEquals(turnUsage.provider, "openai");
  assertEquals(turnUsage.usage.cacheReadInputTokens, 30);
  assertEquals(turnUsage.usage.pricingStatus, "unpriced");
  assertEquals(turnUsage.usage.costUsd, 0);
  // turn_usage precedes message_complete so the loop captures it before breaking.
  const usageIdx = events.findIndex((e) => e.type === "turn_usage");
  const completeIdx = events.findIndex((e) => e.type === "message_complete");
  assert(usageIdx < completeIdx);
});

Deno.test("openai streamTurn maps each finishReason via the shared stop table", async () => {
  const cases: Array<[UnifiedFinish, string]> = [
    ["stop", "end_turn"],
    ["tool-calls", "requires_action"],
    ["length", "max_tokens"],
    ["content-filter", "error"],
    ["error", "error"],
    ["other", "end_turn"],
  ];
  for (const [unified, expected] of cases) {
    const events = await collect(makeProvider([
      { type: "stream-start", warnings: [] },
      v4Finish(unified),
    ]));
    const complete = events.find((e) => e.type === "message_complete");
    assert(complete && complete.type === "message_complete");
    assertEquals(complete.stopReason, expected, `finishReason ${unified}`);
  }
});

Deno.test("openai streamTurn surfaces a stream error part as an error event", async () => {
  const events = await collect(makeProvider([
    { type: "stream-start", warnings: [] },
    { type: "error", error: new Error("boom") },
  ]));
  const err = events.find((e) => e.type === "error");
  assert(err && err.type === "error");
  assert(err.error.message.includes("boom"));
  assertEquals(events.some((e) => e.type === "message_complete"), false);
});

Deno.test("openai streamTurn honors an aborted signal without surfacing an error", async () => {
  const ac = new AbortController();
  ac.abort();
  const events = await collect(
    makeProvider([
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "t0" },
      { type: "text-delta", id: "t0", delta: "should not matter" },
      { type: "text-end", id: "t0" },
      v4Finish("stop"),
    ]),
    REQ,
    ac.signal,
  );
  assertEquals(events.some((e) => e.type === "error"), false);
});

// --- OpenAI-specific behavior -----------------------------------------------

Deno.test("openai streamTurn errors cleanly when unconfigured (no key, no factory)", async () => {
  const provider = new OpenAiModelProvider({ getApiKey: () => undefined });
  const events = await collect(provider);
  assertEquals(types(events), ["error"]);
  const err = events[0];
  assert(err && err.type === "error");
  assertEquals(err.error.code, "MODEL_UNCONFIGURED");
  assert(err.error.message.includes("OpenAI"));
});

Deno.test("openai supportsCaching is false (server-side caching, no breakpoints)", () => {
  const provider = new OpenAiModelProvider({ getApiKey: () => undefined });
  assertEquals(provider.supportsCaching, false);
  assertEquals(provider.id, "openai");
});

Deno.test("openai streamTurn refuses a request exceeding the 128-function ceiling", async () => {
  // 129 tools — one past the ceiling. The provider surfaces a clear error rather than
  // silently truncating (which would hide capabilities from the model).
  const tools: NeutralTool[] = Array.from({ length: 129 }, (_, i) => ({
    name: `tool_${i}`,
    description: "x",
    inputSchema: { type: "object" },
  }));
  // A model factory that must never be reached — the limit check fires first.
  const provider = new OpenAiModelProvider({
    modelFactory: () => {
      throw new Error("model should not be resolved past the tool limit");
    },
  });
  const events = await collect(provider, { ...REQ, tools });
  assertEquals(types(events), ["error"]);
  const err = events[0];
  assert(err && err.type === "error");
  assertEquals(err.error.code, "TOOL_LIMIT_EXCEEDED");
  assert(err.error.message.includes("129"));
});

Deno.test("openai streamTurn accepts exactly 128 functions (headroom boundary)", async () => {
  const tools: NeutralTool[] = Array.from({ length: 128 }, (_, i) => ({
    name: `tool_${i}`,
    description: "x",
    inputSchema: { type: "object" },
  }));
  const events = await collect(
    makeProvider([{ type: "stream-start", warnings: [] }, v4Finish("stop")]),
    { ...REQ, tools },
  );
  // No tool-limit error at the boundary; the turn completes normally.
  assertEquals(events.some((e) => e.type === "error"), false);
  assert(events.some((e) => e.type === "message_complete"));
});
