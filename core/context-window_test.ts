import { assertEquals } from "@std/assert";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CONTEXT_SAFETY_MARGIN,
  CONTEXT_WINDOW_BY_FAMILY,
  CONTEXT_WINDOW_DEFAULT,
  CONTEXT_WORKING_BUDGET_MIN_TOKENS,
  CONTEXT_WORKING_BUDGET_TOKENS,
  LOCAL_LOOP_MAX_OUTPUT_TOKENS,
  MAX_OUTPUT_TOKENS_DEFAULT,
  TOKEN_ESTIMATE_CHARS_PER_TOKEN,
} from "./config.ts";
import {
  contextWindowFor,
  effectiveInputBudget,
  estimateRequestTokens,
  estimateTokens,
  maxOutputTokensFor,
} from "./context-window.ts";
import { contextOccupancyTokens } from "./usage.ts";
import type { NeutralMessage } from "./model-provider.ts";

// Run `fn` under a throwaway HOME so getCachedContextWindow reads only the cache we
// seed (config resolves userConfigDir lazily off HOME per call). A raw entry lets a
// test drive both valid and deliberately-corrupt `contextWindow` values through the
// readModelCache normalizer.
type RawEntry = { id: string; contextWindow?: unknown };

async function withTempHome(
  entries: RawEntry[],
  fn: () => void,
  opts?: { workingBudgetTokens?: number },
): Promise<void> {
  const home = await Deno.makeTempDir({ prefix: "genie-ctxwin-test-" });
  const oldHome = Deno.env.get("HOME");
  try {
    Deno.env.set("HOME", home);
    // effectiveInputBudget now reads the resolved kernel settings (the cost-driven
    // working budget), so any test pinning the raw arithmetic must pin the setting
    // rather than inherit whatever the default is. Written into the isolated HOME's
    // config, so it is scoped and torn down with it.
    if (opts?.workingBudgetTokens !== undefined) {
      const dir = join(home, ".config", "opentide");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "config.json"),
        JSON.stringify({
          kernel: { contextWorkingBudgetTokens: opts.workingBudgetTokens },
        }),
      );
    }
    if (entries.length > 0) {
      const dir = join(home, ".config", "opentide");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "models-cache.json"),
        JSON.stringify({
          models: entries.map((e) => ({
            id: e.id,
            label: e.id,
            ...(e.contextWindow !== undefined
              ? { contextWindow: e.contextWindow }
              : {}),
          })),
          cachedAt: new Date().toISOString(),
        }),
      );
    }
    fn();
  } finally {
    if (oldHome === undefined) Deno.env.delete("HOME");
    else Deno.env.set("HOME", oldHome);
    await Deno.remove(home, { recursive: true });
  }
}

Deno.test("contextWindowFor: current Claude tiers resolve to their curated 1M window", async () => {
  await withTempHome([], () => {
    assertEquals(contextWindowFor("claude-opus-4-8"), 1_000_000);
    assertEquals(contextWindowFor("claude-sonnet-5"), 1_000_000);
    assertEquals(contextWindowFor("claude-fable-5"), 1_000_000);
  });
});

Deno.test("contextWindowFor: Haiku resolves to its curated 200K window", async () => {
  await withTempHome([], () => {
    assertEquals(contextWindowFor("claude-haiku-4-5"), 200_000);
  });
});

Deno.test("contextWindowFor: an Anthropic tier not in the curated map falls back to the 200K family window", async () => {
  // Legacy Opus (opusLegacy) is deliberately omitted from the curated map, so it
  // falls through to the coarse family table rather than being assumed 1M.
  await withTempHome([], () => {
    assertEquals(
      contextWindowFor("claude-opus-4-1"),
      CONTEXT_WINDOW_BY_FAMILY.anthropic,
    );
  });
});

Deno.test("contextWindowFor: GPT-5 resolves to its curated window; other GPT ids use the 128K family window", async () => {
  await withTempHome([], () => {
    assertEquals(contextWindowFor("gpt-5"), 400_000);
    assertEquals(contextWindowFor("gpt-5.6-sol"), 1_050_000);
    assertEquals(contextWindowFor("gpt-4o"), 128_000);
    assertEquals(
      contextWindowFor("o3-mini"),
      CONTEXT_WINDOW_BY_FAMILY.openai,
    );
  });
});

Deno.test("contextWindowFor: unknown/garbage id falls back to the default", async () => {
  await withTempHome([], () => {
    assertEquals(
      contextWindowFor("totally-made-up-model"),
      CONTEXT_WINDOW_DEFAULT,
    );
    assertEquals(contextWindowFor(""), CONTEXT_WINDOW_DEFAULT);
  });
});

Deno.test("contextWindowFor: a persisted live window overrides the curated map", async () => {
  // The live value (300K) wins over the curated tier entry (1M) for the same id.
  await withTempHome(
    [{ id: "claude-opus-4-8", contextWindow: 300_000 }],
    () => {
      assertEquals(contextWindowFor("claude-opus-4-8"), 300_000);
    },
  );
});

Deno.test("contextWindowFor: a persisted window is captured for an otherwise-unknown id", async () => {
  // An id the family table can't place still gets its discovered window (not the default).
  await withTempHome(
    [{ id: "mystery-model-x", contextWindow: 256_000 }],
    () => {
      assertEquals(contextWindowFor("mystery-model-x"), 256_000);
    },
  );
});

Deno.test("contextWindowFor: an invalid persisted window falls back to the curated map", async () => {
  // Zero, negative, fractional, and non-number all fail the positive-integer check,
  // so the id resolves via the curated tier map (1M for opus-4-8) instead of a
  // corrupt window.
  for (const bad of [0, -1, 12.5, "200000", null, {}]) {
    await withTempHome([{ id: "claude-opus-4-8", contextWindow: bad }], () => {
      assertEquals(contextWindowFor("claude-opus-4-8"), 1_000_000);
    });
  }
});

Deno.test("effectiveInputBudget: window minus output cap minus safety margin", async () => {
  // Pinned above every model budget so this case measures the raw arithmetic, not
  // the working-budget cap (which has its own cases below).
  await withTempHome([], () => {
    // A curated tier reserves the loop's full desired ceiling (its own cap is larger).
    assertEquals(
      effectiveInputBudget("claude-opus-4-8"),
      1_000_000 - LOCAL_LOOP_MAX_OUTPUT_TOKENS - CONTEXT_SAFETY_MARGIN,
    );
    // An uncurated id reserves only the conservative default, not the desired ceiling.
    assertEquals(
      effectiveInputBudget("gpt-4o"),
      128_000 - MAX_OUTPUT_TOKENS_DEFAULT - CONTEXT_SAFETY_MARGIN,
    );
  }, { workingBudgetTokens: 10_000_000 });
});

// §4.6: the working budget is a CEILING on the model budget, applied via Math.min.
Deno.test("effectiveInputBudget: the working budget caps a big-window model", async () => {
  await withTempHome([], () => {
    assertEquals(
      effectiveInputBudget("claude-opus-4-8"),
      CONTEXT_WORKING_BUDGET_TOKENS,
    );
  });
  // And it tracks the setting, not the constant.
  await withTempHome([], () => {
    assertEquals(effectiveInputBudget("claude-opus-4-8"), 300_000);
  }, { workingBudgetTokens: 300_000 });
});

// The Math.min guarantee: a small-window model is never handed a LARGER budget than
// it has, whatever the working budget says. On a 128K model the setting is a no-op.
Deno.test("effectiveInputBudget: a 128K model is unchanged by the working budget", async () => {
  const modelBudget = CONTEXT_WINDOW_DEFAULT - MAX_OUTPUT_TOKENS_DEFAULT -
    CONTEXT_SAFETY_MARGIN;
  for (
    const workingBudgetTokens of [
      CONTEXT_WORKING_BUDGET_TOKENS,
      1_000_000,
      CONTEXT_WORKING_BUDGET_MIN_TOKENS * 100,
    ]
  ) {
    await withTempHome([], () => {
      assertEquals(effectiveInputBudget("gpt-4o"), modelBudget);
      assertEquals(
        effectiveInputBudget("totally-made-up-model"),
        modelBudget,
      );
    }, { workingBudgetTokens });
  }
});

Deno.test("maxOutputTokensFor: clamps the desired ceiling to what the model accepts", async () => {
  await withTempHome([], () => {
    // Current Claude tiers cap far above the loop's ceiling, so the ceiling stands.
    for (
      const model of ["claude-opus-5", "claude-sonnet-5", "claude-fable-5"]
    ) {
      assertEquals(maxOutputTokensFor(model), LOCAL_LOOP_MAX_OUTPUT_TOKENS);
    }
    // Haiku's 64K cap coincides with the ceiling.
    assertEquals(maxOutputTokensFor("claude-haiku-4-5"), 64_000);
    // GPT-5 is curated; other GPT ids and garbage fall to the conservative default,
    // so an unrecognized model is never handed a limit its API may reject.
    assertEquals(maxOutputTokensFor("gpt-5"), LOCAL_LOOP_MAX_OUTPUT_TOKENS);
    assertEquals(maxOutputTokensFor("gpt-4o"), MAX_OUTPUT_TOKENS_DEFAULT);
    assertEquals(
      maxOutputTokensFor("totally-made-up-model"),
      MAX_OUTPUT_TOKENS_DEFAULT,
    );
  });
});

Deno.test("effectiveInputBudget: stays positive for the smallest supported window", async () => {
  await withTempHome([], () => {
    // The smallest window any resolution can yield is the conservative default.
    const smallest = CONTEXT_WINDOW_DEFAULT;
    const budget = smallest - MAX_OUTPUT_TOKENS_DEFAULT -
      CONTEXT_SAFETY_MARGIN;
    assertEquals(budget > 0, true);
    assertEquals(effectiveInputBudget("totally-made-up-model"), budget);
  }, { workingBudgetTokens: 10_000_000 });
});

Deno.test("estimateTokens: chars/4 over text content across messages", () => {
  const messages: NeutralMessage[] = [
    { role: "user", content: [{ type: "text", text: "a".repeat(40) }] },
    { role: "assistant", content: [{ type: "text", text: "b".repeat(40) }] },
  ];
  // 80 chars total / 4 = 20 tokens.
  assertEquals(estimateTokens(messages), 80 / TOKEN_ESTIMATE_CHARS_PER_TOKEN);
});

Deno.test("estimateTokens: rounds up a partial token and sums tool round-trips", () => {
  const messages: NeutralMessage[] = [
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "t1", name: "run", input: { a: 1 } }],
    },
    {
      role: "tool",
      content: [{ type: "tool_result", toolCallId: "t1", output: "done" }],
    },
    // A single stray char forces the ceil (non-zero remainder rounds to +1 token).
    { role: "user", content: [{ type: "text", text: "x" }] },
  ];
  const chars = "run".length + JSON.stringify({ a: 1 }).length +
    JSON.stringify("done").length + "x".length;
  assertEquals(
    estimateTokens(messages),
    Math.ceil(chars / TOKEN_ESTIMATE_CHARS_PER_TOKEN),
  );
});

Deno.test("estimateTokens: base64 image/document data is excluded (bytes are not tokens)", () => {
  const messages: NeutralMessage[] = [
    {
      role: "user",
      content: [
        { type: "text", text: "hi" },
        { type: "image", mediaType: "image/png", data: "A".repeat(100_000) },
        {
          type: "document",
          mediaType: "application/pdf",
          data: "B".repeat(100_000),
          title: "big.pdf",
        },
      ],
    },
  ];
  // Only the 2-char text counts; the 200K base64 chars are ignored.
  assertEquals(
    estimateTokens(messages),
    Math.ceil(2 / TOKEN_ESTIMATE_CHARS_PER_TOKEN),
  );
});

Deno.test("estimateTokens: private screenshot image side-channel is excluded from tool results", () => {
  const messages: NeutralMessage[] = [
    {
      role: "tool",
      content: [{
        type: "tool_result",
        toolCallId: "t1",
        output: {
          ok: true,
          _images: [{ png: new Uint8Array(100_000) }],
        },
      }],
    },
  ];
  assertEquals(
    estimateTokens(messages),
    Math.ceil(
      JSON.stringify({ ok: true }).length / TOKEN_ESTIMATE_CHARS_PER_TOKEN,
    ),
  );
});

Deno.test("estimateTokens: empty array is zero", () => {
  assertEquals(estimateTokens([]), 0);
});

Deno.test("estimateRequestTokens includes system prompt, messages, and tool schemas", () => {
  const messages: NeutralMessage[] = [
    { role: "user", content: [{ type: "text", text: "hello" }] },
  ];
  const chars = "system prompt".length + "user".length + "hello".length +
    "read_file".length + "Read a file".length +
    JSON.stringify({ type: "object", properties: { path: { type: "string" } } })
      .length;
  assertEquals(
    estimateRequestTokens({
      system: "system prompt",
      messages,
      tools: [{
        name: "read_file",
        description: "Read a file",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string" } },
        },
      }],
    }),
    Math.ceil(chars / TOKEN_ESTIMATE_CHARS_PER_TOKEN),
  );
});

Deno.test("contextOccupancyTokens sums uncached input plus cache read/write", () => {
  assertEquals(
    contextOccupancyTokens({
      inputTokens: 2,
      cacheCreationInputTokens: 20,
      cacheReadInputTokens: 13_231,
    }),
    13_253,
  );
});
