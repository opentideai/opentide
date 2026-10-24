// Network-free tests for the shared OpenAI client builder. createOpenAI is a pure
// factory (no network at construction), so we assert the seam wires a usable model —
// keyed, keyless, and with a configured base URL — without hitting any endpoint. The
// base-URL RESOLUTION cascade itself is covered in core/config_test.ts; here we prove
// openAiModelFor reads it and constructs cleanly through every branch.

import { assertEquals } from "@std/assert";
import { openAiModelFor } from "./openai-client.ts";

// The AI-SDK model exposes `modelId`; that's the observable proof construction wired
// the requested id through (network only happens on a generate/stream call, never here).
function modelIdOf(model: unknown): string {
  return (model as { modelId: string }).modelId;
}

function sdkProviderOf(model: unknown): string {
  return (model as { config: { provider: string } }).config.provider;
}

Deno.test("openAiModelFor builds a model for the requested id, keyed and keyless", () => {
  const prevBaseUrl = Deno.env.get("OPENAI_BASE_URL");
  try {
    Deno.env.delete("OPENAI_BASE_URL");
    // Keyed: the common path (a configured OpenAI key).
    assertEquals(modelIdOf(openAiModelFor("gpt-4o", "sk-test")), "gpt-4o");
    assertEquals(
      sdkProviderOf(openAiModelFor("gpt-4o", "sk-test")),
      "openai.responses",
    );
    // Keyless: the utility path passes undefined when no key is set; must not throw.
    assertEquals(
      modelIdOf(openAiModelFor("gpt-4o-mini", undefined)),
      "gpt-4o-mini",
    );
  } finally {
    if (prevBaseUrl === undefined) Deno.env.delete("OPENAI_BASE_URL");
    else Deno.env.set("OPENAI_BASE_URL", prevBaseUrl);
  }
});

Deno.test("openAiModelFor uses chat transport for catalog OpenAI-compatible providers", () => {
  const model = openAiModelFor("glm-4.5", "sk-zai", "zai");
  assertEquals(modelIdOf(model), "glm-4.5");
  assertEquals(sdkProviderOf(model), "openai.chat");
});

Deno.test("openAiModelFor threads a configured base URL without error (constructs through the baseURL branch)", () => {
  const prevBaseUrl = Deno.env.get("OPENAI_BASE_URL");
  try {
    // A custom base URL exercises the `baseURL ? { baseURL } : {}` branch; the model
    // still builds against the requested id (the gateway is only reached on a call).
    Deno.env.set("OPENAI_BASE_URL", "https://openrouter.ai/api/v1");
    assertEquals(
      modelIdOf(openAiModelFor("meta-llama/llama-3.1-70b-instruct", "sk-key")),
      "meta-llama/llama-3.1-70b-instruct",
    );
  } finally {
    if (prevBaseUrl === undefined) Deno.env.delete("OPENAI_BASE_URL");
    else Deno.env.set("OPENAI_BASE_URL", prevBaseUrl);
  }
});
