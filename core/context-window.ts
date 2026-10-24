// Per-model context-window source (Slice 1, docs/context-hardening-plan.md).
//
// The client-side loop caps OUTPUT tokens (LOCAL_LOOP_MAX_OUTPUT_TOKENS) but has
// no INPUT-side ceiling: the retained NeutralMessage[] grows until the model's own
// window rejects the request. Later slices add 80%-nudge / 95%-auto-compact
// thresholds; they all measure against the window this module resolves.
//
// No per-model window is enumerated in code (MODELS is empty, D7). We resolve one
// family-first with a conservative default, and prefer a live per-model window
// discovered from the provider's catalog when present. Pure helpers, no throwing —
// these are internal, not public route APIs.

import {
  CONTEXT_SAFETY_MARGIN,
  CONTEXT_WINDOW_BY_FAMILY,
  CONTEXT_WINDOW_DEFAULT,
  type ContextWindowFamily,
  getCachedContextWindow,
  LOCAL_LOOP_MAX_OUTPUT_TOKENS,
  MAX_OUTPUT_TOKENS_DEFAULT,
  resolvedWorkingBudget,
  TOKEN_ESTIMATE_CHARS_PER_TOKEN,
} from "./config.ts";
import { type PricingTier, resolvePricingTier } from "./usage.ts";
import type {
  NeutralContentBlock,
  NeutralMessage,
  NeutralTool,
  TurnRequest,
} from "./model-provider.ts";
import { wireVisibleToolOutput } from "./model-provider.ts";

// OpenAI model ids the family table should treat as a 128K-window GPT family. The
// catalog is discovered, not enumerated, so match by shape rather than a fixed
// list: the GPT lines plus the o-series reasoning models and ChatGPT snapshots.
const OPENAI_MODEL_ID = /(^|[-_/])(gpt|o[1-9]|chatgpt)/i;

function isOpenAiModel(model: string): boolean {
  return OPENAI_MODEL_ID.test(model);
}

// The coarse family a model id belongs to for window sizing. Reuses the pricing
// tier resolver (usage.ts) as the Anthropic signal — every Claude tier carries a
// 200K window — so the two can't disagree about which ids are Claude. A pre-tier
// (deep-legacy) Claude id resolves to no tier and falls through to the
// conservative default rather than being assumed 200K, which fails safe.
function contextWindowFamily(model: string): ContextWindowFamily | undefined {
  if (resolvePricingTier(model) !== undefined) return "anthropic";
  if (isOpenAiModel(model)) return "openai";
  return undefined;
}

// Curated per-tier context windows for Anthropic models — the accurate floor when
// live discovery hasn't populated a per-model window (first run, offline, or a
// provider whose /v1/models omits it). Keyed by the SAME pricing tier resolver used
// for cost, so windows are maintained alongside pricing and the two can't disagree
// about which id is which tier. Tiers omitted here fall through to the coarser
// CONTEXT_WINDOW_BY_FAMILY (200K) — a deliberate fail-safe: when unsure, under-report
// so the loop compacts early rather than hitting a hard context-length error. A live
// discovered window always wins over this map.
const CONTEXT_WINDOW_BY_TIER: Partial<Record<PricingTier, number>> = {
  fable51: 1_000_000,
  fable5: 1_000_000,
  opus5: 1_000_000,
  opus48: 1_000_000,
  opus46Or47: 1_000_000,
  sonnet: 1_000_000,
  haiku45: 200_000,
};

// Curated OpenAI windows by id substring — OpenAI's /v1/models omits the window, so
// there is no live source for it. Only high-confidence entries; everything else falls
// to the 128K family floor (fail-safe). Matched like isOpenAiModel (word-boundary).
const OPENAI_WINDOW_BY_ID: ReadonlyArray<readonly [RegExp, number]> = [
  [/(^|[-_/])gpt-5[._-]?6/i, 1_050_000],
  [/(^|[-_/])gpt-5/i, 400_000],
];

// The curated window for a model, or undefined to fall through to the family table.
function curatedContextWindow(model: string): number | undefined {
  const tier = resolvePricingTier(model);
  if (tier) {
    const byTier = CONTEXT_WINDOW_BY_TIER[tier.tier];
    if (byTier !== undefined) return byTier;
  }
  for (const [pattern, window] of OPENAI_WINDOW_BY_ID) {
    if (pattern.test(model)) return window;
  }
  return undefined;
}

// The context window for a model. Resolution order:
//   1. the live per-model window discovered from the provider catalog, if any;
//   2. the curated per-tier / per-id map (Claude tiers → real windows, e.g. 1M);
//   3. the coarse family table (Anthropic → 200K, OpenAI → 128K);
//   4. CONTEXT_WINDOW_DEFAULT for an unknown/garbage id.
// The tables are the floor, so a never-fetched model is always given a safe window.
export function contextWindowFor(model: string): number {
  const live = getCachedContextWindow(model);
  if (live !== undefined) return live;
  const curated = curatedContextWindow(model);
  if (curated !== undefined) return curated;
  const family = contextWindowFamily(model);
  return family ? CONTEXT_WINDOW_BY_FAMILY[family] : CONTEXT_WINDOW_DEFAULT;
}

// Curated per-tier OUTPUT ceilings — what each Anthropic tier actually accepts as
// max output tokens, keyed by the SAME pricing tier resolver used for cost and for
// CONTEXT_WINDOW_BY_TIER, so the three can't disagree about which id is which tier.
// A tier omitted here falls through to MAX_OUTPUT_TOKENS_DEFAULT: an unknown model
// keeps the conservative pre-hardening ceiling rather than being handed a limit its
// API may reject.
const MAX_OUTPUT_BY_TIER: Partial<Record<PricingTier, number>> = {
  fable51: 128_000,
  fable5: 128_000,
  opus5: 128_000,
  opus48: 128_000,
  opus46Or47: 128_000,
  sonnet: 128_000,
  haiku45: 64_000,
};

// Curated OpenAI output ceilings by id substring, matched like isOpenAiModel.
// Only high-confidence entries; everything else falls to the conservative default.
const OPENAI_MAX_OUTPUT_BY_ID: ReadonlyArray<readonly [RegExp, number]> = [
  [/(^|[-_/])gpt-5/i, 128_000],
];

// The model's own output ceiling, or undefined to fall through to the default.
function curatedMaxOutputTokens(model: string): number | undefined {
  const tier = resolvePricingTier(model);
  if (tier) {
    const byTier = MAX_OUTPUT_BY_TIER[tier.tier];
    if (byTier !== undefined) return byTier;
  }
  for (const [pattern, max] of OPENAI_MAX_OUTPUT_BY_ID) {
    if (pattern.test(model)) return max;
  }
  return undefined;
}

// The per-request output ceiling to send for `model`: the loop's desired ceiling
// (LOCAL_LOOP_MAX_OUTPUT_TOKENS), clamped to what the model actually accepts. Both
// directions matter — the clamp keeps a small-cap model from receiving an
// over-limit request (a hard API error), while the desired ceiling keeps a
// 128K-output model from being handed its whole cap as the reservation below.
export function maxOutputTokensFor(model: string): number {
  const modelMax = curatedMaxOutputTokens(model) ?? MAX_OUTPUT_TOKENS_DEFAULT;
  return Math.min(LOCAL_LOOP_MAX_OUTPUT_TOKENS, modelMax);
}

// The usable INPUT-token budget for a model: its context window minus the output
// reservation and the safety margin (system prompt + tool-schema drift the turn
// accumulators don't see), then capped by the cost-driven working budget. This is
// the number the threshold checks divide by. The reservation is per-model
// (maxOutputTokensFor) so the budget matches the ceiling the request will actually
// carry.
//
// The Math.min is the whole safety argument for the working budget (agent cost
// reduction, §4.6): it can only ever LOWER the budget, so on a 128K model — where
// the model budget is already under the working budget — it is a no-op and no
// small-window model is ever handed a budget larger than it has. On a 1M-window
// model it is what stops the loop from accumulating 800k of context that gets
// re-read, and billed, on every tool round-trip.
//
// NOT a pure function of `model` any more: resolvedWorkingBudget() reads the
// resolved kernel settings (file → env → constant), so a test that pins the
// arithmetic must also pin the setting.
export function effectiveInputBudget(model: string): number {
  return Math.min(modelInputCapacity(model), resolvedWorkingBudget());
}

// The model's REAL input capacity: everything effectiveInputBudget measures before
// the working budget gets a vote. This is the wall a request actually hits — exceed
// it and the provider rejects the turn — whereas the working budget is a cost
// ceiling that happens to coincide with it on small-window models.
//
// The distinction is the whole point (agent cost reduction, §8): on claude-opus-5
// capacity is 932_000 against a 200_000 budget, so "pressure 1.6" is a spending
// signal and nothing is in danger; on claude-haiku-4-5 capacity IS the budget
// (132_000), so the same ratio means the request is already dead. Anything that
// needs to reason about survival rather than cost divides by this.
//
// Unlike effectiveInputBudget this IS a pure function of `model` — no settings are
// read — so a test can pin it without pinning the kernel settings.
export function modelInputCapacity(model: string): number {
  return contextWindowFor(model) - maxOutputTokensFor(model) -
    CONTEXT_SAFETY_MARGIN;
}

export type ContextPressureSource = "provider" | "estimate";

export interface ContextPressure {
  occupancy: number;
  budget: number;
  pressure: number;
  model: string;
  contextWindow: number;
  outputReservation: number;
  safetyMargin: number;
  source: ContextPressureSource;
}

// The character count a single content block contributes to the cheap token
// estimate. Only textual content is measured — an image/document block's base64
// `data` is bytes, not tokens (a screenshot's token cost is a function of its
// dimensions, not its byte length), so counting it would wildly overestimate and
// auto-compact on every attachment. Tool-use inputs / tool-result outputs and
// reasoning payloads are stringified so a large tool round-trip still registers.
export function neutralBlockChars(block: NeutralContentBlock): number {
  switch (block.type) {
    case "text":
      return block.text.length;
    case "tool_use":
      return block.name.length + JSON.stringify(block.input ?? "").length;
    case "tool_result":
      return JSON.stringify(wireVisibleToolOutput(block.output) ?? "").length;
    case "reasoning":
      return JSON.stringify(block.data ?? "").length;
    default:
      // image / document — base64 data deliberately excluded (see above).
      return 0;
  }
}

// Cheap pre-turn token estimate (context-hardening plan, Slice 4): the standard
// chars/4 approximation over a NeutralMessage[], no bundled tokenizer (a plan
// non-goal — provider-reported actuals drive the reactive path; this only needs to
// catch a big single message before it is sent). Used by the loop's pre-turn guard
// to compact when this turn's projected input would blow the effective budget.
export function estimateTokens(messages: NeutralMessage[]): number {
  let chars = 0;
  for (const message of messages) {
    for (const block of message.content) {
      chars += neutralBlockChars(block);
    }
  }
  return Math.ceil(chars / TOKEN_ESTIMATE_CHARS_PER_TOKEN);
}

function jsonChars(value: unknown): number {
  try {
    return JSON.stringify(value ?? "")?.length ?? 0;
  } catch {
    return 0;
  }
}

export function neutralToolChars(tool: NeutralTool): number {
  return tool.name.length + tool.description.length +
    jsonChars(tool.inputSchema);
}

export function estimateRequestTokens(
  request: Pick<TurnRequest, "system" | "messages" | "tools">,
): number {
  let chars = request.system.length;
  for (const message of request.messages) {
    chars += message.role.length;
    for (const block of message.content) {
      chars += neutralBlockChars(block);
    }
  }
  for (const tool of request.tools) {
    chars += neutralToolChars(tool);
  }
  return Math.ceil(chars / TOKEN_ESTIMATE_CHARS_PER_TOKEN);
}

export function estimatedContextPressure(
  request: Pick<TurnRequest, "model" | "system" | "messages" | "tools">,
): ContextPressure {
  const occupancy = estimateRequestTokens(request);
  const contextWindow = contextWindowFor(request.model);
  const budget = effectiveInputBudget(request.model);
  const pressure = budget > 0 ? occupancy / budget : 1;
  return {
    occupancy,
    budget,
    pressure,
    model: request.model,
    contextWindow,
    outputReservation: LOCAL_LOOP_MAX_OUTPUT_TOKENS,
    safetyMargin: CONTEXT_SAFETY_MARGIN,
    source: "estimate",
  };
}
