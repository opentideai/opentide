// Unit tests for the AI-SDK-backed Anthropic ModelProvider (multi-model harness,
// Stage 3b). Two levels, both network-free:
//   1. Stream mapping — feed a MockLanguageModelV4 whose doStream emits canned
//      low-level parts, run the whole pipeline through REAL streamText().fullStream, and
//      assert the exact ProviderEvent sequence (text, thinking, tool-call, usage with
//      cache tokens, each finishReason, error, abort).
//   2. Request mapping — call the pure toModelMessages/toSdkTools/extractReasoning
//      helpers directly and assert the CoreMessage[]/ToolSet round-trips (toolCallId
//      pairing, reasoning replay, cache_control breakpoints).

import { assert, assertEquals } from "@std/assert";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import type { LanguageModel } from "ai";
import { AnthropicModelProvider } from "./anthropic-provider.ts";
// The provider-neutral request/stream mapping helpers were extracted to
// ai-sdk-shared.ts (Stage 4 DRY step); importing them from there and keeping this
// whole suite green proves the extraction is behavior-preserving.
import {
  extractReasoning,
  mapFinishReason,
  toModelMessages,
  toSdkTools,
  toTurnUsage,
} from "./ai-sdk-shared.ts";
import type {
  NeutralMessage,
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

function makeProvider(chunks: V4Part[]): AnthropicModelProvider {
  return new AnthropicModelProvider({
    modelFactory: () => mockModel(chunks),
    // Keep outgoing providerOptions minimal; the mock ignores them anyway.
    thinking: { type: "disabled" },
  });
}

const REQ: TurnRequest = {
  model: "claude-opus-4-8",
  system: "You are a test agent.",
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  tools: [],
};

async function collect(
  provider: AnthropicModelProvider,
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

// --- 1. Stream mapping ------------------------------------------------------

Deno.test("streamTurn maps text deltas → text_delta and ends end_turn", async () => {
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
  // No reasoning produced → the field is absent.
  assertEquals(complete.reasoning, undefined);
});

Deno.test("streamTurn maps reasoning → thinking_* and captures it for replay", async () => {
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
  const thinking = events
    .filter((e): e is Extract<ProviderEvent, { type: "thinking_delta" }> =>
      e.type === "thinking_delta"
    )
    .map((e) => e.text)
    .join("");
  assertEquals(thinking, "Let me think about it.");

  // The terminal message_complete carries the reasoning block(s) for same-model replay.
  const complete = events.find((e) => e.type === "message_complete");
  assert(complete && complete.type === "message_complete");
  assert(complete.reasoning && complete.reasoning.length === 1);
  assertEquals(complete.reasoning[0]?.type, "reasoning");
  assertEquals(complete.reasoning[0]?.provider, "anthropic");
});

Deno.test("streamTurn surfaces a finalized tool-call and stops requires_action", async () => {
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

Deno.test("streamTurn emits model_request_usage + turn_usage with cache tokens", async () => {
  const events = await collect(makeProvider([
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "t0" },
    { type: "text-delta", id: "t0", delta: "ok" },
    { type: "text-end", id: "t0" },
    // 100 raw input (50 uncached, 30 cache-read, 20 cache-write), 40 output.
    v4Finish("stop", v4Usage(100, 40, 30, 20)),
  ]));

  const reqUsage = events.find((e) => e.type === "model_request_usage");
  assert(reqUsage && reqUsage.type === "model_request_usage");
  assertEquals(reqUsage.provider, "anthropic");
  assertEquals(reqUsage.usage.inputTokens, 50);
  assertEquals(reqUsage.usage.outputTokens, 40);
  assertEquals(reqUsage.usage.cacheReadInputTokens, 30);
  assertEquals(reqUsage.usage.cacheCreationInputTokens, 20);
  assertEquals(reqUsage.usage.model, "claude-opus-4-8");

  const turnUsage = events.find((e) => e.type === "turn_usage");
  assert(turnUsage && turnUsage.type === "turn_usage");
  assertEquals(turnUsage.provider, "anthropic");
  assertEquals(turnUsage.usage.inputTokens, 50);
  assertEquals(turnUsage.usage.cacheReadInputTokens, 30);
  assertEquals(turnUsage.usage.cacheCreationInputTokens, 20);
  // turn_usage precedes message_complete so the loop captures it before breaking.
  const usageIdx = events.findIndex((e) => e.type === "turn_usage");
  const completeIdx = events.findIndex((e) => e.type === "message_complete");
  assert(usageIdx < completeIdx);
});

Deno.test("streamTurn maps each finishReason via the stop table", async () => {
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

Deno.test("streamTurn surfaces a stream error part as an error event", async () => {
  const events = await collect(makeProvider([
    { type: "stream-start", warnings: [] },
    { type: "error", error: new Error("boom") },
  ]));
  const err = events.find((e) => e.type === "error");
  assert(err && err.type === "error");
  assert(err.error.message.includes("boom"));
  // On error we stop — no message_complete.
  assertEquals(events.some((e) => e.type === "message_complete"), false);
});

Deno.test("streamTurn honors an aborted signal without surfacing an error", async () => {
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
  // A cancel is clean: no error event is emitted.
  assertEquals(events.some((e) => e.type === "error"), false);
});

Deno.test("streamTurn errors cleanly when unconfigured (no key, no factory)", async () => {
  const provider = new AnthropicModelProvider({ getApiKey: () => undefined });
  const events = await collect(provider);
  assertEquals(types(events), ["error"]);
  const err = events[0];
  assert(err && err.type === "error");
  assertEquals(err.error.code, "MODEL_UNCONFIGURED");
});

// --- 2. Request mapping (pure helpers) --------------------------------------

Deno.test("toModelMessages round-trips a tool_use/tool_result pair by toolCallId", () => {
  const messages: NeutralMessage[] = [
    { role: "user", content: [{ type: "text", text: "read it" }] },
    {
      role: "assistant",
      content: [
        { type: "text", text: "calling" },
        {
          type: "tool_use",
          id: "call_9",
          name: "read_file",
          input: { path: "a" },
        },
      ],
    },
    {
      role: "tool",
      content: [{
        type: "tool_result",
        toolCallId: "call_9",
        output: { ok: true },
      }],
    },
  ];

  const out = toModelMessages(messages, "anthropic", false);
  assertEquals(out.length, 3);

  const assistant = out[1];
  assert(assistant && assistant.role === "assistant");
  const toolCall = (assistant.content as Array<{ type: string }>).find((p) =>
    p.type === "tool-call"
  ) as unknown as { toolCallId: string; toolName: string; input: unknown };
  assertEquals(toolCall.toolCallId, "call_9");
  assertEquals(toolCall.toolName, "read_file");
  assertEquals(toolCall.input, { path: "a" });

  const toolMsg = out[2];
  assert(toolMsg && toolMsg.role === "tool");
  const result = (toolMsg.content as Array<
    { type: string; toolCallId: string; toolName: string; output: unknown }
  >)[0];
  assert(result);
  assertEquals(result.toolCallId, "call_9");
  // toolName is recovered from the preceding assistant tool_use, which the neutral
  // tool_result block does not itself carry.
  assertEquals(result.toolName, "read_file");
  assertEquals(result.output, { type: "json", value: { ok: true } });
});

Deno.test("toModelMessages replays our reasoning verbatim and drops foreign", () => {
  const ourReasoning = [{
    type: "reasoning",
    text: "mine",
    providerOptions: {},
  }];
  const messages: NeutralMessage[] = [
    {
      role: "assistant",
      content: [
        { type: "reasoning", provider: "anthropic", data: ourReasoning },
        {
          type: "reasoning",
          provider: "openai",
          data: [{ type: "reasoning", text: "theirs" }],
        },
        { type: "text", text: "answer" },
      ],
    },
  ];
  const out = toModelMessages(messages, "anthropic", false);
  const assistant = out[0];
  assert(assistant && assistant.role === "assistant");
  const parts = assistant.content as Array<{ type: string; text?: string }>;
  const reasoningParts = parts.filter((p) => p.type === "reasoning");
  // Only our own reasoning is replayed; the foreign block is dropped.
  assertEquals(reasoningParts.length, 1);
  assertEquals(reasoningParts[0]?.text, "mine");
  // Reasoning leads, text follows.
  assertEquals(parts[0]?.type, "reasoning");
  assertEquals(parts[parts.length - 1]?.type, "text");
});

Deno.test("toModelMessages hangs cache_control on first+last messages when caching on", () => {
  const messages: NeutralMessage[] = [
    { role: "user", content: [{ type: "text", text: "one" }] },
    { role: "assistant", content: [{ type: "text", text: "two" }] },
    { role: "user", content: [{ type: "text", text: "three" }] },
  ];

  const cached = toModelMessages(messages, "anthropic", true);
  const lastPart = (msg: typeof cached[number]) =>
    (msg.content as Array<{ providerOptions?: unknown }>).at(-1);
  assert(lastPart(cached[0]!)?.providerOptions);
  assert(lastPart(cached[2]!)?.providerOptions);
  // The middle message carries no breakpoint.
  assertEquals(lastPart(cached[1]!)?.providerOptions, undefined);

  // With caching off, no breakpoints at all.
  const plain = toModelMessages(messages, "anthropic", false);
  assertEquals(lastPart(plain[0]!)?.providerOptions, undefined);
  assertEquals(lastPart(plain[2]!)?.providerOptions, undefined);
});

Deno.test("toSdkTools hangs cache_control on the last tool only", () => {
  const tools: NeutralTool[] = [
    { name: "a", description: "A", inputSchema: { type: "object" } },
    { name: "b", description: "B", inputSchema: { type: "object" } },
  ];
  const set = toSdkTools(tools, true) as Record<
    string,
    { providerOptions?: unknown }
  >;
  assertEquals(set.a?.providerOptions, undefined);
  assert(set.b?.providerOptions);

  const plain = toSdkTools(tools, false) as Record<
    string,
    { providerOptions?: unknown }
  >;
  assertEquals(plain.b?.providerOptions, undefined);
});

Deno.test("toModelMessages maps image/document blocks to file parts", () => {
  const messages: NeutralMessage[] = [{
    role: "user",
    content: [
      { type: "image", mediaType: "image/png", data: "aW1n" },
      {
        type: "document",
        mediaType: "application/pdf",
        data: "cGRm",
        title: "doc.pdf",
      },
    ],
  }];
  const out = toModelMessages(messages, "anthropic", false);
  const parts = out[0]!.content as Array<
    { type: string; mediaType?: string; filename?: string; data?: unknown }
  >;
  assertEquals(parts[0]?.type, "file");
  assertEquals(parts[0]?.mediaType, "image/png");
  assertEquals(parts[1]?.type, "file");
  assertEquals(parts[1]?.mediaType, "application/pdf");
  assertEquals(parts[1]?.filename, "doc.pdf");
});

Deno.test("mapFinishReason covers the stop table incl. null", () => {
  assertEquals(mapFinishReason("stop"), "end_turn");
  assertEquals(mapFinishReason("tool-calls"), "requires_action");
  assertEquals(mapFinishReason("length"), "max_tokens");
  assertEquals(mapFinishReason("content-filter"), "error");
  assertEquals(mapFinishReason("error"), "error");
  assertEquals(mapFinishReason("other"), "end_turn");
  assertEquals(mapFinishReason(null), "end_turn");
});

Deno.test("toTurnUsage maps neutral usage incl. cache token details", () => {
  const usage = {
    inputTokens: 200,
    inputTokenDetails: {
      noCacheTokens: 150,
      cacheReadTokens: 30,
      cacheWriteTokens: 20,
    },
    outputTokens: 80,
    outputTokenDetails: { textTokens: 80, reasoningTokens: 0 },
    totalTokens: 280,
  };
  const started = new Date("2026-08-02T00:00:00.000Z");
  const ended = new Date("2026-08-02T00:00:01.500Z");
  const turn = toTurnUsage(usage, "claude-opus-4-8", started, ended);
  assertEquals(turn.inputTokens, 150);
  assertEquals(turn.outputTokens, 80);
  assertEquals(turn.cacheReadInputTokens, 30);
  assertEquals(turn.cacheCreationInputTokens, 20);
  assertEquals(turn.durationMs, 1500);
  assertEquals(turn.model, "claude-opus-4-8");
  assertEquals(turn.toolCallsCount, 0);
  assertEquals(turn.pricingStatus, "priced");
  assert(turn.costUsd >= 0);
});

Deno.test("extractReasoning bundles assistant reasoning parts, [] when none", () => {
  const withReasoning = extractReasoning(
    [
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "step 1" },
          { type: "text", text: "answer" },
          { type: "reasoning", text: "step 2" },
        ],
        // deno-lint-ignore no-explicit-any
      } as any,
    ],
    "anthropic",
  );
  assertEquals(withReasoning.length, 1);
  assertEquals(withReasoning[0]?.provider, "anthropic");
  assertEquals((withReasoning[0]?.data as unknown[]).length, 2);

  const none = extractReasoning(
    // deno-lint-ignore no-explicit-any
    [{ role: "assistant", content: [{ type: "text", text: "hi" }] } as any],
    "anthropic",
  );
  assertEquals(none, []);
});
