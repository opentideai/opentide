import { assertEquals } from "@std/assert";
import { isDeepLegacyModel, resolveClaudeTier } from "./claude-tiers.ts";

Deno.test("resolveClaudeTier: 5.1 resolves before 5", () => {
  // "claude-fable-5-1" contains "claude-fable-5"; the order is the mapping.
  assertEquals(resolveClaudeTier("claude-fable-5-1"), {
    tier: "fable51",
    unknown: false,
  });
  assertEquals(resolveClaudeTier("claude-mythos-5-1")?.tier, "fable51");
  assertEquals(resolveClaudeTier("claude-fable-5")?.tier, "fable5");
  assertEquals(resolveClaudeTier("claude-mythos-5")?.tier, "fable5");
});

Deno.test("resolveClaudeTier: Opus generations", () => {
  assertEquals(resolveClaudeTier("claude-opus-5-5")?.tier, "opus5");
  assertEquals(resolveClaudeTier("claude-opus-5")?.tier, "opus5");
  assertEquals(resolveClaudeTier("claude-opus-4-8")?.tier, "opus48");
  assertEquals(resolveClaudeTier("claude-opus-4-7")?.tier, "opus46Or47");
  assertEquals(resolveClaudeTier("claude-opus-4-6")?.tier, "opus46Or47");
  assertEquals(resolveClaudeTier("claude-opus-4-5")?.tier, "opus45");
  assertEquals(resolveClaudeTier("claude-opus-4-1")?.tier, "opusLegacy");
  assertEquals(resolveClaudeTier("claude-3-opus-20240229")?.tier, "opusLegacy");
});

Deno.test("resolveClaudeTier: an unknown in-family id gets the current tier, flagged", () => {
  assertEquals(resolveClaudeTier("claude-opus-9"), {
    tier: "opus5",
    unknown: true,
  });
  assertEquals(resolveClaudeTier("claude-haiku-9"), {
    tier: "haiku45",
    unknown: true,
  });
  assertEquals(resolveClaudeTier("claude-sonnet-9"), {
    tier: "sonnet",
    unknown: true,
  });
});

Deno.test("resolveClaudeTier: Sonnet 5 and 4.x are separate tiers", () => {
  assertEquals(resolveClaudeTier("claude-sonnet-5-5")?.tier, "sonnet");
  assertEquals(resolveClaudeTier("claude-sonnet-5")?.tier, "sonnet");
  assertEquals(resolveClaudeTier("claude-sonnet-4-6")?.tier, "sonnet4x");
});

Deno.test("resolveClaudeTier: non-Claude ids resolve to nothing", () => {
  assertEquals(resolveClaudeTier("gpt-5"), undefined);
  assertEquals(resolveClaudeTier("glm-4.5"), undefined);
});

Deno.test("isDeepLegacyModel: legacy tiers and pre-tier lines, never current ones", () => {
  assertEquals(isDeepLegacyModel("claude-opus-4-1"), true);
  assertEquals(isDeepLegacyModel("claude-3-haiku-20240307"), true);
  assertEquals(isDeepLegacyModel("claude-3-5-sonnet-20241022"), true);
  assertEquals(isDeepLegacyModel("claude-2.1"), true);
  assertEquals(isDeepLegacyModel("claude-opus-5-5"), false);
  assertEquals(isDeepLegacyModel("claude-opus-9"), false);
  assertEquals(isDeepLegacyModel("gpt-5"), false);
});
