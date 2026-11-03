// Claude model id → generation tier. Drives the curated context windows and output
// ceilings (core/context-window.ts) and the picker's deep-legacy hiding
// (core/config.ts). Prices are not here: they come from models.dev
// (core/model-prices.ts).

export type ClaudeTier =
  | "fable51"
  | "fable5"
  | "opus5"
  | "opus48"
  | "opus46Or47"
  | "opus45"
  | "opusLegacy"
  | "sonnet"
  | "sonnet4x"
  | "haiku45"
  | "haikuLegacy";

// `unknown` marks an in-family id that matched only the family fallthrough: it
// gets the current tier, but nothing names it explicitly.
export type TierResolution = { tier: ClaudeTier; unknown: boolean };

const LEGACY_OPUS_IDS = [
  "claude-opus-4-1",
  "claude-opus-4-0",
  "claude-3-opus",
] as const;
const LEGACY_HAIKU_IDS = ["claude-3-5-haiku", "claude-3-haiku"] as const;
const KNOWN_SONNET_IDS = ["claude-sonnet-5", "claude-sonnet-4"] as const;

function includesAny(model: string, ids: readonly string[]): boolean {
  return ids.some((id) => model.includes(id));
}

// Order is the mapping: "claude-fable-5-1" contains "claude-fable-5", and
// "claude-opus-5-5" contains "claude-opus-5" (same limits, so same tier).
export function resolveClaudeTier(model: string): TierResolution | undefined {
  if (
    model.includes("claude-fable-5-1") || model.includes("claude-mythos-5-1")
  ) {
    return { tier: "fable51", unknown: false };
  }
  if (model.includes("claude-fable-5") || model.includes("claude-mythos-5")) {
    return { tier: "fable5", unknown: false };
  }

  if (model.includes("claude-opus-5")) return { tier: "opus5", unknown: false };
  if (model.includes("claude-opus-4-8")) {
    return { tier: "opus48", unknown: false };
  }
  if (model.includes("claude-opus-4-7") || model.includes("claude-opus-4-6")) {
    return { tier: "opus46Or47", unknown: false };
  }
  if (model.includes("claude-opus-4-5")) {
    return { tier: "opus45", unknown: false };
  }
  if (includesAny(model, LEGACY_OPUS_IDS)) {
    return { tier: "opusLegacy", unknown: false };
  }
  if (model.includes("claude-opus")) return { tier: "opus5", unknown: true };

  if (model.includes("claude-sonnet-5")) {
    return { tier: "sonnet", unknown: false };
  }
  if (model.includes("claude-sonnet-4")) {
    return { tier: "sonnet4x", unknown: false };
  }
  if (model.includes("claude-sonnet")) {
    return { tier: "sonnet", unknown: !includesAny(model, KNOWN_SONNET_IDS) };
  }

  if (model.includes("claude-haiku-4-5")) {
    return { tier: "haiku45", unknown: false };
  }
  if (includesAny(model, LEGACY_HAIKU_IDS)) {
    return { tier: "haikuLegacy", unknown: false };
  }
  if (model.includes("claude-haiku")) return { tier: "haiku45", unknown: true };

  return undefined;
}

const DEEP_LEGACY_TIERS: readonly ClaudeTier[] = ["opusLegacy", "haikuLegacy"];

// Claude lines older than every tier above (claude-2.x, Instant, pre-4 Sonnets).
const DEEP_LEGACY_MODEL_IDS = [
  "claude-2",
  "claude-instant",
  "claude-3-sonnet",
  "claude-3-5-sonnet",
  "claude-3-7-sonnet",
] as const;

// A retired model the picker hides. Display only.
export function isDeepLegacyModel(model: string): boolean {
  const tier = resolveClaudeTier(model)?.tier;
  if (tier && DEEP_LEGACY_TIERS.includes(tier)) return true;
  return includesAny(model, DEEP_LEGACY_MODEL_IDS);
}
