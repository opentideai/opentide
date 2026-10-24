// Tests for the §8 cache-composition instrument. The instrument must (a) split a
// request into the five categories over the WIRE shape, (b) report only genuinely
// new content as new, (c) flag a prefix mutation instead of miscounting it, and
// (d) stay off by default.

import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import {
  CACHE_TRACE_METHOD,
  cacheBreakpointPlan,
  CacheCompositionTracer,
  composeCacheBuckets,
} from "./cache-composition.ts";
import { CACHE_COMPOSITION_TRACE_FILE, getKernelSettings } from "./config.ts";
import type {
  NeutralMessage,
  NeutralTool,
  TurnRequest,
} from "./model-provider.ts";
import { estimateRequestTokens, neutralToolChars } from "./context-window.ts";

const TOOLS: NeutralTool[] = [
  {
    name: "list_handlers",
    description: "list them",
    inputSchema: { type: "object" },
  },
  {
    name: "write_handler",
    description: "write one",
    inputSchema: { type: "object" },
  },
];

function request(messages: NeutralMessage[]): TurnRequest {
  return {
    model: "claude-opus-5",
    system: "s".repeat(400),
    messages,
    tools: TOOLS,
  };
}

Deno.test("composeCacheBuckets splits a request into the five categories", () => {
  const messages: NeutralMessage[] = [
    { role: "user", content: [{ type: "text", text: "u".repeat(40) }] },
    {
      role: "assistant",
      content: [
        { type: "reasoning", provider: "anthropic", data: "r".repeat(80) },
        { type: "text", text: "a".repeat(20) },
        {
          type: "tool_use",
          id: "c1",
          name: "list_handlers",
          input: { module: "x" },
        },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool_result",
          toolCallId: "c1",
          output: { rows: "z".repeat(200) },
        },
      ],
    },
  ];
  const buckets = composeCacheBuckets(request(messages));

  const toolChars = TOOLS.reduce((n, t) => n + neutralToolChars(t), 0);
  assertEquals(buckets.systemTokens, 100);
  assertEquals(buckets.toolSchemaTokens, Math.ceil(toolChars / 4));
  assertEquals(buckets.staticPrefixTokens, Math.ceil((400 + toolChars) / 4));
  assertEquals(buckets.visibleTextTokens, Math.ceil((40 + 20) / 4));
  // reasoning is JSON.stringify'd → the 80 r's plus two quotes.
  assertEquals(buckets.reasoningTokens, Math.ceil(82 / 4));
  assert(buckets.toolResultTokens > 50);
  assert(buckets.toolCallInputTokens > 0);
  assertEquals(buckets.attachmentBlocks, 0);
});

Deno.test("composeCacheBuckets totals match the context meter's own estimate", () => {
  const messages: NeutralMessage[] = [
    { role: "user", content: [{ type: "text", text: "hello there" }] },
    {
      role: "assistant",
      content: [{
        type: "tool_use",
        id: "c1",
        name: "list_handlers",
        input: {},
      }],
    },
    {
      role: "tool",
      content: [{
        type: "tool_result",
        toolCallId: "c1",
        output: { ok: true },
      }],
    },
  ];
  const req = request(messages);
  // The instrument must be comparable to the meter, not merely close to it.
  assertEquals(
    composeCacheBuckets(req).estimatedTotalTokens,
    estimateRequestTokens(req),
  );
});

Deno.test("composeCacheBuckets measures tool results in WIRE shape", () => {
  // _changeset / _images are stripped by wireVisibleToolOutput before send, so the
  // instrument must not bill them (the trap that over-read changeset verbs 3-4x).
  const wire: NeutralMessage[] = [{
    role: "tool",
    content: [{ type: "tool_result", toolCallId: "c1", output: { ok: true } }],
  }];
  const fat: NeutralMessage[] = [{
    role: "tool",
    content: [{
      type: "tool_result",
      toolCallId: "c1",
      output: { ok: true, _changeset: { huge: "x".repeat(5000) } },
    }],
  }];
  assertEquals(
    composeCacheBuckets(request(fat)).toolResultTokens,
    composeCacheBuckets(request(wire)).toolResultTokens,
  );
});

Deno.test("composeCacheBuckets counts attachments as blocks, not tokens", () => {
  const messages: NeutralMessage[] = [{
    role: "user",
    content: [
      { type: "text", text: "look" },
      { type: "image", mediaType: "image/png", data: "b".repeat(10_000) },
    ],
  }];
  const buckets = composeCacheBuckets(request(messages));
  assertEquals(buckets.attachmentBlocks, 1);
  assertEquals(buckets.visibleTextTokens, 1);
});

Deno.test("cacheBreakpointPlan mirrors three breakpoints, one per single message", () => {
  const two: NeutralMessage[] = [
    { role: "user", content: [{ type: "text", text: "one" }] },
    { role: "assistant", content: [{ type: "text", text: "two" }] },
  ];
  const plan = cacheBreakpointPlan(request(two), true);
  assertEquals(plan.map((p) => p.kind), [
    "tools",
    "first_message",
    "last_message",
  ]);
  assert(plan[2]!.prefixTokens >= plan[1]!.prefixTokens);

  const one: NeutralMessage[] = [{
    role: "user",
    content: [{ type: "text", text: "one" }],
  }];
  assertEquals(
    cacheBreakpointPlan(request(one), true).map((p) => p.kind),
    ["tools", "first_message"],
  );
});

Deno.test("cacheBreakpointPlan emits nothing for a non-caching provider", () => {
  const messages: NeutralMessage[] = [{
    role: "user",
    content: [{ type: "text", text: "x" }],
  }];
  assertEquals(cacheBreakpointPlan(request(messages), false), []);
});

function tracerDir(): string {
  return Deno.makeTempDirSync({ prefix: "cache-trace-" });
}

function readTrace(dir: string): Array<Record<string, unknown>> {
  return Deno.readTextFileSync(`${dir}/${CACHE_COMPOSITION_TRACE_FILE}`)
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

Deno.test("tracer counts only appended content as new, across requests in a turn", () => {
  const dir = tracerDir();
  try {
    const tracer = new CacheCompositionTracer(dir);
    tracer.beginTurn();
    const messages: NeutralMessage[] = [
      { role: "user", content: [{ type: "text", text: "a".repeat(400) }] },
    ];
    const first = tracer.snapshot({
      request: request(messages),
      turnId: "turn_1",
      sessionId: "sess_1",
      supportsCaching: true,
      at: new Date(0),
    });
    tracer.commit(first, {
      turnId: "turn_1",
      sessionId: "sess_1",
      model: "claude-opus-5",
      startedAt: "",
      endedAt: "",
      durationMs: 0,
      inputTokens: 10,
      outputTokens: 5,
      cacheCreationInputTokens: 100,
      cacheReadInputTokens: 0,
      toolCallsCount: 0,
      costUsd: 0,
      provider: "anthropic",
    });

    messages.push({
      role: "tool",
      content: [{
        type: "tool_result",
        toolCallId: "c1",
        output: { rows: "z".repeat(400) },
      }],
    });
    const second = tracer.snapshot({
      request: request(messages),
      turnId: "turn_1",
      sessionId: "sess_1",
      supportsCaching: true,
      at: new Date(0),
    });
    tracer.commit(second, null);

    const lines = readTrace(dir);
    assertEquals(lines.length, 2);
    assertEquals(lines[0]!.requestIndex, 0);
    assertEquals(lines[1]!.requestIndex, 1);
    assertEquals(lines[0]!.method, CACHE_TRACE_METHOD);

    const firstDelta = lines[0]!.delta as Record<string, number | boolean>;
    assertEquals(firstDelta.newMessages, 1);
    assertEquals(firstDelta.prefixMutated, false);

    const secondDelta = lines[1]!.delta as Record<string, number | boolean>;
    // Only the appended tool message is new — the retained user message is not.
    assertEquals(secondDelta.newMessages, 1);
    assertEquals(secondDelta.prefixMutated, false);
    assert((secondDelta.newTokens as number) > 90);
    assert((secondDelta.newTokens as number) < 120);

    // Usage rides on the first line and is absent (not zeroed) on the second.
    const usage = lines[0]!.usage as Record<string, number>;
    assertEquals(usage.cacheCreationInputTokens, 100);
    assertEquals(lines[1]!.usage, null);
    assertEquals(lines[1]!.estimateRatio, null);
    assertAlmostEquals(
      lines[0]!.estimateRatio as number,
      (lines[0]!.buckets as { estimatedTotalTokens: number })
        .estimatedTotalTokens / 110,
      1e-9,
    );
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test("tracer flags a rewritten prefix rather than counting it as new", () => {
  const dir = tracerDir();
  try {
    const tracer = new CacheCompositionTracer(dir);
    tracer.beginTurn();
    const messages: NeutralMessage[] = [
      { role: "user", content: [{ type: "text", text: "hello" }] },
      {
        role: "tool",
        content: [{
          type: "tool_result",
          toolCallId: "c1",
          output: { rows: "z".repeat(4000) },
        }],
      },
    ];
    tracer.commit(
      tracer.snapshot({
        request: request(messages),
        turnId: "t",
        sessionId: null,
        supportsCaching: true,
        at: new Date(0),
      }),
      null,
    );
    // An in-turn prune (§4.7) stubs an older result IN PLACE — the cached prefix
    // is invalidated, which is not the same thing as new content arriving.
    messages[1] = {
      role: "tool",
      content: [{
        type: "tool_result",
        toolCallId: "c1",
        output: { pruned: true },
      }],
    };
    tracer.commit(
      tracer.snapshot({
        request: request(messages),
        turnId: "t",
        sessionId: null,
        supportsCaching: true,
        at: new Date(0),
      }),
      null,
    );
    const lines = readTrace(dir);
    const delta = lines[1]!.delta as Record<string, number | boolean>;
    assertEquals(delta.prefixMutated, true);
    assertEquals(delta.newTokens, 0);
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test("cacheCompositionTrace resolves through the env cascade", () => {
  // The instrument is a kernel setting with a OPENTIDE_CACHE_TRACE override, so the
  // default-off guarantee is testable without depending on the developer's own
  // config file (which a real trace run flips on).
  const before = Deno.env.get("OPENTIDE_CACHE_TRACE");
  try {
    Deno.env.set("OPENTIDE_CACHE_TRACE", "0");
    assertEquals(getKernelSettings().cacheCompositionTrace, false);
    Deno.env.set("OPENTIDE_CACHE_TRACE", "1");
    assertEquals(getKernelSettings().cacheCompositionTrace, true);
  } finally {
    if (before === undefined) Deno.env.delete("OPENTIDE_CACHE_TRACE");
    else Deno.env.set("OPENTIDE_CACHE_TRACE", before);
  }
});
