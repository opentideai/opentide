import { assertEquals, assertRejects } from "@std/assert";
import type Anthropic from "@anthropic-ai/sdk";
import type { LanguageModelUsage } from "ai";
import {
  callOpenAiUtilityModelWith,
  callUtilityModelWith,
  makeRoutingUtilityModelCall,
  promptTextOf,
  toMessageParams,
  type UtilityMessagesClient,
} from "./utility-provider.ts";
import type {
  UtilityModelCall,
  UtilityModelRequest,
} from "../core/utility-model.ts";

// A minimal fake reply. Two text blocks prove the join; a non-text block proves
// it is filtered exactly as the former call sites did.
function fakeMessage(
  texts: string[],
  usage: Partial<Record<string, number>> = {},
): Anthropic.Message {
  return {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "test",
    stop_reason: "end_turn",
    stop_sequence: null,
    content: [
      ...texts.map((text) => ({ type: "text", text, citations: null })),
      { type: "thinking", thinking: "…", signature: "s" },
    ],
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      ...usage,
    },
  } as unknown as Anthropic.Message;
}

function clientReturning(msg: Anthropic.Message): {
  client: UtilityMessagesClient;
  calls: Anthropic.MessageCreateParamsNonStreaming[];
} {
  const calls: Anthropic.MessageCreateParamsNonStreaming[] = [];
  return {
    calls,
    client: {
      messages: {
        create(params) {
          calls.push(params);
          return Promise.resolve(msg);
        },
      },
    },
  };
}

Deno.test("toMessageParams sends system/temperature only when provided", () => {
  const bare = toMessageParams({ user: "u", model: "m", maxTokens: 12 });
  assertEquals(bare, {
    model: "m",
    stream: false,
    max_tokens: 12,
    messages: [{ role: "user", content: "u" }],
  });

  const full = toMessageParams({
    user: "u",
    model: "m",
    maxTokens: 12,
    system: "sys",
    temperature: 0,
  });
  assertEquals(full, {
    model: "m",
    stream: false,
    max_tokens: 12,
    temperature: 0,
    system: "sys",
    messages: [{ role: "user", content: "u" }],
  });
});

// docs/agent-cost-reduction.md §4.5: a cachePrefix splits the user turn into two
// text blocks with the cache breakpoint on the FIRST one only, so callers repeating
// the same bulk context (refutation's code block) read it back at 0.1x. Absent, the
// params must stay the plain string every other utility caller sends today.
Deno.test("toMessageParams caches the prefix block when one is supplied", () => {
  const absent = toMessageParams({ user: "u", model: "m", maxTokens: 12 });
  assertEquals(absent.messages, [{ role: "user", content: "u" }]);

  const present = toMessageParams({
    cachePrefix: "CODE",
    user: "u",
    model: "m",
    maxTokens: 12,
  });
  assertEquals(present.messages, [{
    role: "user",
    content: [
      {
        type: "text",
        text: "CODE",
        cache_control: { type: "ephemeral", ttl: "1h" },
      },
      // The separator rides on the second block, so the cached bytes are exactly
      // the prefix and the joined prompt matches the OpenAI path's string.
      { type: "text", text: "\n\nu" },
    ],
  }]);

  // An empty prefix is not a prefix — no breakpoint, no block split.
  const empty = toMessageParams({
    cachePrefix: "",
    user: "u",
    model: "m",
    maxTokens: 12,
  });
  assertEquals(empty.messages, [{ role: "user", content: "u" }]);
});

Deno.test("callUtilityModelWith stamps the 1h TTL only when it cached a prefix", async () => {
  const { client } = clientReturning(
    fakeMessage(["x"], { cache_creation_input_tokens: 9_000 }),
  );
  const cached = await callUtilityModelWith(client, {
    cachePrefix: "CODE",
    user: "hi",
    model: "m",
    maxTokens: 8,
  });
  assertEquals(cached.usage.cacheTtl, "1h");
  assertEquals(cached.usage.cacheCreationInputTokens, 9_000);

  const plain = await callUtilityModelWith(client, {
    user: "hi",
    model: "m",
    maxTokens: 8,
  });
  assertEquals(plain.usage.cacheTtl, undefined);
});

// Providers with no cache-breakpoint surface must still SEE the prefix — dropping
// it would silently shrink the prompt on the OpenAI path.
Deno.test("promptTextOf concatenates the prefix ahead of the varying part", () => {
  const req = { cachePrefix: "CODE", user: "u", model: "m", maxTokens: 1 };
  assertEquals(promptTextOf(req), "CODE\n\nu");
  assertEquals(promptTextOf({ user: "u", model: "m", maxTokens: 1 }), "u");

  // Both provider paths must present the SAME prompt: the Anthropic blocks joined
  // are byte-identical to the string the OpenAI path sends.
  const blocks = toMessageParams(req).messages[0]!.content;
  assertEquals(
    (blocks as { text: string }[]).map((b) => b.text).join(""),
    promptTextOf(req),
  );
});

Deno.test("callUtilityModelWith joins text blocks and maps usage", async () => {
  const { client, calls } = clientReturning(
    fakeMessage(["Hello", " world"], {
      cache_creation_input_tokens: 3,
      cache_read_input_tokens: 7,
    }),
  );
  const out = await callUtilityModelWith(client, {
    user: "hi",
    model: "m",
    maxTokens: 8,
  });
  assertEquals(out.text, "Hello world");
  assertEquals(out.usage, {
    inputTokens: 10,
    outputTokens: 5,
    cacheCreationInputTokens: 3,
    cacheReadInputTokens: 7,
  });
  assertEquals(out.provider, "anthropic");
  assertEquals(out.model, "test");
  assertEquals(calls.length, 1);
  assertEquals(calls[0]!.max_tokens, 8);
});

Deno.test("callUtilityModelWith defaults absent cache counts to 0", async () => {
  const { client } = clientReturning(fakeMessage(["x"]));
  const out = await callUtilityModelWith(client, {
    user: "hi",
    model: "m",
    maxTokens: 8,
  });
  assertEquals(out.usage.cacheCreationInputTokens, 0);
  assertEquals(out.usage.cacheReadInputTokens, 0);
});

Deno.test("callUtilityModelWith rejects with the caller's timeout message", async () => {
  const client: UtilityMessagesClient = {
    messages: {
      // Never resolves — the timeout must win.
      create: () => new Promise<Anthropic.Message>(() => {}),
    },
  };
  await assertRejects(
    () =>
      callUtilityModelWith(client, {
        user: "hi",
        model: "m",
        maxTokens: 8,
        timeoutMs: 1,
        timeoutMessage: "Audit timed out",
      }),
    Error,
    "Audit timed out",
  );
});

// --- OpenAI utility core (Stage 4) ------------------------------------------

function sdkUsage(over: Partial<LanguageModelUsage> = {}): LanguageModelUsage {
  return {
    inputTokens: 12,
    outputTokens: 7,
    totalTokens: 19,
    ...over,
  } as LanguageModelUsage;
}

Deno.test("callOpenAiUtilityModelWith maps text + neutral usage incl. cache details", async () => {
  const calls: UtilityModelRequest[] = [];
  const out = await callOpenAiUtilityModelWith((req) => {
    calls.push(req);
    return Promise.resolve({
      text: "hello from gpt",
      usage: sdkUsage({
        inputTokens: 100,
        outputTokens: 40,
        inputTokenDetails: { cacheReadTokens: 30, cacheWriteTokens: 0 },
      } as Partial<LanguageModelUsage>),
    });
  }, { user: "hi", model: "gpt-5", maxTokens: 8 });

  assertEquals(out.text, "hello from gpt");
  assertEquals(out.usage, {
    inputTokens: 70,
    outputTokens: 40,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 30,
  });
  assertEquals(out.provider, "openai");
  assertEquals(out.model, "gpt-5");
  assertEquals(calls.length, 1);
  assertEquals(calls[0]?.model, "gpt-5");
});

Deno.test("callOpenAiUtilityModelWith defaults absent cache counts to 0", async () => {
  const out = await callOpenAiUtilityModelWith(
    () => Promise.resolve({ text: "x", usage: sdkUsage() }),
    { user: "hi", model: "gpt-5", maxTokens: 8 },
  );
  assertEquals(out.usage.cacheCreationInputTokens, 0);
  assertEquals(out.usage.cacheReadInputTokens, 0);
});

Deno.test("callOpenAiUtilityModelWith rejects with the caller's timeout message", async () => {
  await assertRejects(
    () =>
      callOpenAiUtilityModelWith(
        // Never resolves — the timeout must win.
        () => new Promise(() => {}),
        {
          user: "hi",
          model: "gpt-5",
          maxTokens: 8,
          timeoutMs: 1,
          timeoutMessage: "Completion timed out",
        },
      ),
    Error,
    "Completion timed out",
  );
});

// --- Provider routing (Stage 4) ---------------------------------------------

// A fake utility call that records the requests it received and returns an id-tagged
// reply, so a test can tell which impl a routed call reached.
function recordingCall(id: string): {
  call: UtilityModelCall;
  seen: UtilityModelRequest[];
} {
  const seen: UtilityModelRequest[] = [];
  return {
    seen,
    call: (req) => {
      seen.push(req);
      return Promise.resolve({
        text: id,
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
        },
      });
    },
  };
}

function patternResolver(model: string): "anthropic" | "openai" {
  return model.startsWith("gpt-") ? "openai" : "anthropic";
}

Deno.test("routing utility call sends gpt-* to OpenAI and claude-* to Anthropic", async () => {
  const anthropic = recordingCall("anthropic");
  const openai = recordingCall("openai");
  const route = makeRoutingUtilityModelCall({
    anthropic: anthropic.call,
    openai: openai.call,
    resolveProvider: patternResolver,
  });

  const gpt = await route({ user: "u", model: "gpt-5", maxTokens: 4 });
  const claude = await route({
    user: "u",
    model: "claude-sonnet-5",
    maxTokens: 4,
  });

  assertEquals(gpt.text, "openai");
  assertEquals(claude.text, "anthropic");
  assertEquals(openai.seen.map((r) => r.model), ["gpt-5"]);
  assertEquals(anthropic.seen.map((r) => r.model), ["claude-sonnet-5"]);
});

Deno.test("routing utility call uses the real providerFor default (unknown → Anthropic)", async () => {
  // No model cache seeded → providerFor returns the default (anthropic) for any id.
  const anthropic = recordingCall("anthropic");
  const openai = recordingCall("openai");
  const route = makeRoutingUtilityModelCall({
    anthropic: anthropic.call,
    openai: openai.call,
    // resolveProvider omitted → the real providerFor.
  });

  const out = await route({ user: "u", model: "some-legacy-id", maxTokens: 4 });
  assertEquals(out.text, "anthropic");
  assertEquals(openai.seen.length, 0);
});
