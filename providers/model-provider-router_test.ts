// Unit tests for the routing ModelProvider (multi-model harness, Stage 4). Network-free:
// inject fake per-provider impls and a deterministic resolver, then assert streamTurn
// dispatches to the right impl and forwards the request + abort signal unchanged. One
// test exercises the REAL default resolver (providerFor) to prove an unknown/legacy id
// falls back to the default provider.

import { assert, assertEquals } from "@std/assert";
import { RoutingModelProvider } from "./model-provider-router.ts";
import type {
  ModelProvider,
  ProviderEvent,
  TurnRequest,
} from "../core/model-provider.ts";
import { DEFAULT_MODEL_PROVIDER } from "../core/config.ts";

// A fake concrete provider that records every request/signal it was handed and yields one
// scripted, identifiable event so the caller can tell which impl ran.
class RecordingProvider implements ModelProvider {
  readonly supportsCaching = false;
  readonly requests: TurnRequest[] = [];
  readonly signals: AbortSignal[] = [];

  constructor(readonly id: string) {}

  async *streamTurn(
    req: TurnRequest,
    signal: AbortSignal,
  ): AsyncIterable<ProviderEvent> {
    this.requests.push(req);
    this.signals.push(signal);
    yield { type: "text_delta", text: this.id };
    yield { type: "message_complete", stopReason: "end_turn" };
  }
}

class UsageProvider implements ModelProvider {
  readonly supportsCaching = false;

  constructor(
    readonly id: string,
    private readonly eventProvider?: "anthropic" | "openai",
  ) {}

  async *streamTurn(): AsyncIterable<ProviderEvent> {
    yield {
      type: "turn_usage",
      provider: this.eventProvider,
      usage: {
        turnId: "",
        sessionId: "",
        model: "gpt-5",
        startedAt: "2026-09-01T00:00:00.000Z",
        endedAt: "2026-09-01T00:00:01.000Z",
        durationMs: 1000,
        inputTokens: 10,
        outputTokens: 2,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        toolCallsCount: 0,
        costUsd: 0,
      },
    };
  }
}

function reqFor(model: string): TurnRequest {
  return {
    model,
    system: "sys",
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    tools: [],
  };
}

async function drain(
  it: AsyncIterable<ProviderEvent>,
): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = [];
  for await (const ev of it) out.push(ev);
  return out;
}

// A resolver mirroring the id conventions: gpt-* → openai, claude-* → anthropic.
function patternResolver(model: string): "anthropic" | "openai" {
  return model.startsWith("gpt-") ? "openai" : "anthropic";
}

Deno.test("router dispatches gpt-* to the OpenAI impl, claude-* to the Anthropic impl", async () => {
  const anthropic = new RecordingProvider("anthropic");
  const openai = new RecordingProvider("openai");
  const router = new RoutingModelProvider({
    factories: { anthropic: () => anthropic, openai: () => openai },
    resolveProvider: patternResolver,
  });

  const gptEvents = await drain(
    router.streamTurn(reqFor("gpt-5"), new AbortController().signal),
  );
  const claudeEvents = await drain(
    router.streamTurn(reqFor("claude-opus-4-8"), new AbortController().signal),
  );

  // The first text_delta carries the impl's id — proving which one ran.
  assertEquals((gptEvents[0] as { text: string }).text, "openai");
  assertEquals((claudeEvents[0] as { text: string }).text, "anthropic");
  // Each impl saw exactly its own request; neither saw the other's.
  assertEquals(openai.requests.map((r) => r.model), ["gpt-5"]);
  assertEquals(anthropic.requests.map((r) => r.model), ["claude-opus-4-8"]);
});

Deno.test("router forwards the exact request object and abort signal to the delegate", async () => {
  const openai = new RecordingProvider("openai");
  const router = new RoutingModelProvider({
    factories: { openai: () => openai },
    resolveProvider: patternResolver,
  });

  const req = reqFor("gpt-5");
  const signal = new AbortController().signal;
  await drain(router.streamTurn(req, signal));

  // Same references, not copies — the router is a passthrough.
  assert(openai.requests[0] === req);
  assert(openai.signals[0] === signal);
});

Deno.test("router annotates usage events with the selected provider", async () => {
  const router = new RoutingModelProvider({
    factories: { openai: () => new UsageProvider("openai") },
    resolveProvider: patternResolver,
  });

  const events = await drain(
    router.streamTurn(reqFor("gpt-5"), new AbortController().signal),
  );

  assertEquals(events[0]?.type, "turn_usage");
  assertEquals(
    events[0]?.type === "turn_usage" ? events[0].provider : undefined,
    "openai",
  );
});

Deno.test("router preserves provider already attached by the delegate", async () => {
  const router = new RoutingModelProvider({
    factories: {
      openai: () => new UsageProvider("openai", "anthropic"),
    },
    resolveProvider: patternResolver,
  });

  const events = await drain(
    router.streamTurn(reqFor("gpt-5"), new AbortController().signal),
  );

  assertEquals(events[0]?.type, "turn_usage");
  assertEquals(
    events[0]?.type === "turn_usage" ? events[0].provider : undefined,
    "anthropic",
  );
});

Deno.test("router lazily constructs each impl once and reuses it across turns", async () => {
  let anthropicBuilds = 0;
  let openaiBuilds = 0;
  const router = new RoutingModelProvider({
    factories: {
      anthropic: () => {
        anthropicBuilds++;
        return new RecordingProvider("anthropic");
      },
      openai: () => {
        openaiBuilds++;
        return new RecordingProvider("openai");
      },
    },
    resolveProvider: patternResolver,
  });

  const sig = new AbortController().signal;
  await drain(router.streamTurn(reqFor("gpt-5"), sig));
  await drain(router.streamTurn(reqFor("gpt-4o"), sig));
  await drain(router.streamTurn(reqFor("claude-sonnet-5"), sig));

  // OpenAI built once despite two gpt turns; Anthropic built once; never eagerly.
  assertEquals(openaiBuilds, 1);
  assertEquals(anthropicBuilds, 1);
});

Deno.test("router with the real providerFor resolver falls back to the default provider for an unknown id", async () => {
  // No model cache is seeded, so the real providerFor returns DEFAULT_MODEL_PROVIDER for
  // any id — the unknown/legacy fallback. Assert the request lands on the default impl.
  const byId: Record<string, RecordingProvider> = {
    anthropic: new RecordingProvider("anthropic"),
    openai: new RecordingProvider("openai"),
  };
  const router = new RoutingModelProvider({
    factories: {
      anthropic: () => byId.anthropic!,
      openai: () => byId.openai!,
    },
    // resolveProvider omitted → defaults to the real providerFor.
  });

  await drain(
    router.streamTurn(
      reqFor("some-unknown-legacy-model"),
      new AbortController().signal,
    ),
  );

  const defaultImpl = byId[DEFAULT_MODEL_PROVIDER]!;
  assertEquals(defaultImpl.requests.length, 1);
  assertEquals(defaultImpl.requests[0]?.model, "some-unknown-legacy-model");
});
