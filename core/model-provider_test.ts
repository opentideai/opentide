import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  BUFFERED_NO_CHAT_EVENT,
  PROVIDER_EVENT_CHAT_TARGET,
  type ProviderEvent,
  type ProviderEventType,
  type TurnRequest,
} from "./model-provider.ts";
import { FakeModelProvider } from "./model-provider-fake.ts";
import type { TurnUsage } from "./types.ts";

// The ChatEvent["type"] values a ProviderEvent may map to. Mirrors the union in
// core/chat-contract.ts; kept here as the runtime source of truth for "is this a
// documented ChatEvent target" (the type itself has no runtime form). If a
// ProviderEvent gains a new mapping target, add it here too.
const KNOWN_CHAT_EVENT_TYPES: ReadonlySet<string> = new Set([
  "text_delta",
  "thinking_start",
  "thinking_end",
  "tool_use_start",
  "tool_use_end",
  "message_complete",
  "error",
  "system_message",
  "session_started",
  "message_stored",
  "work_item_created",
  "model_request_usage",
  "turn_usage",
  "changeset_created",
  "changeset_updated",
  "changeset_completed",
  "step_started",
  "step_completed",
]);

function makeUsage(): TurnUsage {
  return {
    turnId: "t1",
    sessionId: "s1",
    model: "claude-opus-4-8",
    startedAt: "2026-08-02T00:00:00.000Z",
    endedAt: "2026-08-02T00:00:01.000Z",
    durationMs: 1000,
    inputTokens: 10,
    outputTokens: 20,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    toolCallsCount: 1,
    costUsd: 0,
  };
}

function req(overrides: Partial<TurnRequest> = {}): TurnRequest {
  return {
    model: "claude-opus-4-8",
    system: "sys",
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    tools: [],
    ...overrides,
  };
}

// Drain an AsyncIterable of ProviderEvents into an array — the seed of
// golden-sequence assertions in Stage 3.
async function collect(
  iterable: AsyncIterable<ProviderEvent>,
): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = [];
  for await (const event of iterable) out.push(event);
  return out;
}

Deno.test("FakeModelProvider yields scripted events in order", async () => {
  const turn: ProviderEvent[] = [
    { type: "text_delta", text: "Hel" },
    { type: "text_delta", text: "lo" },
    { type: "message_complete", stopReason: "end_turn" },
  ];
  const provider = new FakeModelProvider([turn]);
  const events = await collect(
    provider.streamTurn(req(), new AbortController().signal),
  );
  assertEquals(events, turn);
});

Deno.test("FakeModelProvider advances across multiple turns", async () => {
  const turn1: ProviderEvent[] = [
    { type: "tool_use_start", toolName: "list_dir", toolInput: { path: "." } },
    { type: "message_complete", stopReason: "requires_action" },
  ];
  const turn2: ProviderEvent[] = [
    { type: "text_delta", text: "done" },
    { type: "message_complete", stopReason: "end_turn" },
  ];
  const provider = new FakeModelProvider([turn1, turn2]);
  const signal = new AbortController().signal;

  assertEquals(provider.turnsRemaining, 2);
  assertEquals(await collect(provider.streamTurn(req(), signal)), turn1);
  assertEquals(provider.turnsRemaining, 1);
  assertEquals(await collect(provider.streamTurn(req(), signal)), turn2);
  assertEquals(provider.turnsRemaining, 0);
});

Deno.test("FakeModelProvider records the requests it received", async () => {
  const provider = new FakeModelProvider([[], []]);
  const signal = new AbortController().signal;
  const a = req({ system: "first" });
  const b = req({
    system: "second",
    tools: [{
      name: "read_file",
      description: "read",
      inputSchema: { type: "object", properties: {}, required: [] },
    }],
  });

  await collect(provider.streamTurn(a, signal));
  await collect(provider.streamTurn(b, signal));

  assertEquals(provider.requests.length, 2);
  assertEquals(provider.requests[0]?.system, "first");
  assertEquals(provider.requests[1]?.system, "second");
  assertEquals(provider.requests[1]?.tools[0]?.name, "read_file");
});

Deno.test("FakeModelProvider abort mid-stream stops iteration", async () => {
  const controller = new AbortController();
  const turn: ProviderEvent[] = [
    { type: "text_delta", text: "one" },
    { type: "text_delta", text: "two" },
    { type: "text_delta", text: "three" },
  ];
  const provider = new FakeModelProvider([turn]);

  const seen: ProviderEvent[] = [];
  for await (const event of provider.streamTurn(req(), controller.signal)) {
    seen.push(event);
    controller.abort(); // abort after the first event
  }

  assertEquals(seen.length, 1);
  assertEquals(seen[0], turn[0]);
});

Deno.test("FakeModelProvider aborts before the first event", async () => {
  const controller = new AbortController();
  controller.abort();
  const provider = new FakeModelProvider([[{
    type: "text_delta",
    text: "never",
  }]]);
  const seen = await collect(provider.streamTurn(req(), controller.signal));
  assertEquals(seen.length, 0);
});

Deno.test("FakeModelProvider throws when the script is exhausted", async () => {
  const provider = new FakeModelProvider([[]]);
  const signal = new AbortController().signal;
  await collect(provider.streamTurn(req(), signal)); // consume the one turn
  await assertRejects(
    () => collect(provider.streamTurn(req(), signal)),
    Error,
    "no scripted turn",
  );
});

Deno.test("every ProviderEvent type maps to a documented ChatEvent target", () => {
  // One sample of every ProviderEvent variant. The compile-time
  // Record<ProviderEventType, ...> on PROVIDER_EVENT_CHAT_TARGET already forces
  // a mapping entry per union member; this asserts the runtime samples cover the
  // same set and that every target is a real ChatEvent type (or the documented
  // buffered sentinel) — so the mapping can't silently drift.
  const samples: ProviderEvent[] = [
    { type: "text_delta", text: "x" },
    { type: "thinking_start" },
    { type: "thinking_delta", text: "x" },
    { type: "thinking_end" },
    { type: "tool_use_start", toolName: "t" },
    { type: "tool_use_end", toolResult: null },
    { type: "message_complete", stopReason: "end_turn" },
    { type: "model_request_usage", usage: makeUsage() },
    { type: "turn_usage", usage: makeUsage() },
    { type: "error", error: { code: "E", message: "m" } },
  ];

  const sampleTypes = new Set<ProviderEventType>(samples.map((e) => e.type));
  const mappedTypes = new Set(
    Object.keys(PROVIDER_EVENT_CHAT_TARGET) as ProviderEventType[],
  );

  // Samples cover exactly the mapped union — catches a new variant added to the
  // map (compile-forced) but not sampled here, and vice versa.
  assertEquals(sampleTypes, mappedTypes);

  for (const t of mappedTypes) {
    const target = PROVIDER_EVENT_CHAT_TARGET[t];
    assert(
      target === BUFFERED_NO_CHAT_EVENT || KNOWN_CHAT_EVENT_TYPES.has(target),
      `ProviderEvent "${t}" maps to "${target}", which is neither a known ` +
        `ChatEvent type nor the buffered sentinel`,
    );
  }
});
