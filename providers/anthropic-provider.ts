// @layer providers — the concrete Anthropic ModelProvider (multi-model harness,
// docs/multi-model-harness-plan.md §5 Stage 3b, decisions D1/D3). This is the real
// AI-SDK-backed transport the whole ModelProvider seam (core/model-provider.ts) was
// built for: its streamTurn drives @ai-sdk/anthropic via streamText().fullStream and
// translates (a) a neutral TurnRequest into SDK call params and (b) the SDK fullStream
// parts into the neutral ProviderEvent union, exactly per the mapping tables in the
// core/model-provider.ts header (source: spike/FINDINGS.md §2 + §4).
//
// The provider-neutral request/stream mapping (toModelMessages, toSdkTools, toTurnUsage,
// mapFinishReason, extractReasoning, …) lives in the shared providers/ai-sdk-shared.ts —
// this file keeps only Anthropic's specifics: the createAnthropic factory, the
// thinking/sendReasoning providerOptions, supportsCaching=true (so the shared mappers hang
// cache_control breakpoints), and its provider id tag for reasoning replay.
//
// LAYER: open L2, sibling of agent-loop/. It imports core (down — the L1 ModelProvider
// contract, config, usage) and the Vercel AI SDK, and is injected by the composition
// roots (cli/assembly.ts). It must NEVER import agent-loop/ or agent/ — the loop stays
// SDK-free, and both stacks (closed brain + BYO-key open) construct it, so it cannot
// live in closed agent/.
//
// The loop dispatches tools and synthesizes tool_use_end itself, so the tools handed to
// streamText carry NO `execute`: the SDK stops at the tool call (finishReason
// "tool-calls" → requires_action) and we surface it, never run it.

import { type JSONValue, type LanguageModel, streamText } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import type {
  ModelProvider,
  ProviderEvent,
  TurnRequest,
} from "../core/model-provider.ts";
import type { ModelProviderId } from "../core/config.ts";
import { getAnthropicApiKey } from "../core/config.ts";
import { maxOutputTokensFor } from "../core/context-window.ts";
import {
  streamProviderEvents,
  toModelMessages,
  toSdkTools,
} from "./ai-sdk-shared.ts";

// This provider's stable identity. It tags the NeutralReasoningBlocks it emits so a
// different provider replaying a foreign message drops them instead of round-tripping
// internals it can't sign (NeutralReasoningBlock contract). "anthropic" is a member of
// core's MODEL_PROVIDER_IDS union — a typed const, not a magic string.
const ANTHROPIC_PROVIDER_ID: ModelProviderId = "anthropic";

// Extended-thinking configuration handed to the provider. Mirrors the @ai-sdk/anthropic
// `thinking` provider option; kept as a local neutral shape so the seam carries no SDK
// type. "adaptive" lets the model decide when to think (safe default — it never forces
// tokens); "enabled" always thinks within budgetTokens; "disabled" turns it off.
export type AnthropicThinkingConfig =
  | { type: "adaptive"; display?: "omitted" | "summarized" }
  | { type: "enabled"; budgetTokens?: number }
  | { type: "disabled" };

// Enable thinking by default: the local loop is the "shows its work" path, and the
// model spends thinking tokens only when the turn benefits ("adaptive"). Turn it off or
// pin a budget via the constructor.
const DEFAULT_THINKING: AnthropicThinkingConfig = { type: "adaptive" };

export interface AnthropicModelProviderOptions {
  // How the provider sources the API key at request time. Defaults to
  // getAnthropicApiKey (config → env), read lazily per streamTurn so a key added mid
  // session is picked up without reconstructing the provider.
  getApiKey?: () => string | undefined;
  // Test seam: build the SDK LanguageModel from a resolved model id. Defaults to
  // createAnthropic({ apiKey })(modelId). Unit tests inject a MockLanguageModelV4 so
  // the whole pipeline runs with no network (the SDK's own test path).
  modelFactory?: (modelId: string) => LanguageModel;
  // Extended thinking. Defaults to DEFAULT_THINKING; pass { type: "disabled" } to opt
  // out or { type: "enabled", budgetTokens } to force it.
  thinking?: AnthropicThinkingConfig;
  // Per-request output-token ceiling. Defaults to per-model resolution
  // (maxOutputTokensFor): the loop's desired ceiling clamped to what the resolved
  // model accepts. Pass a number to pin one ceiling for every model.
  maxOutputTokens?: number;
}

export class AnthropicModelProvider implements ModelProvider {
  readonly id: string = ANTHROPIC_PROVIDER_ID;
  readonly supportsCaching = true;

  private readonly getApiKey: () => string | undefined;
  private readonly modelFactory: ((modelId: string) => LanguageModel) | null;
  private readonly thinking: AnthropicThinkingConfig;
  private readonly maxOutputTokens: number | null;

  constructor(opts: AnthropicModelProviderOptions = {}) {
    this.getApiKey = opts.getApiKey ?? getAnthropicApiKey;
    this.modelFactory = opts.modelFactory ?? null;
    this.thinking = opts.thinking ?? DEFAULT_THINKING;
    this.maxOutputTokens = opts.maxOutputTokens ?? null;
  }

  // Resolve the SDK LanguageModel for a request. Null when unconfigured (keyless and no
  // injected factory) — streamTurn surfaces that as an error ProviderEvent rather than
  // shipping a dead call (D9). Never sets temperature/top_p — Opus 4.x 400s on those
  // (spike/FINDINGS.md §4.5).
  private resolveModel(modelId: string): LanguageModel | null {
    if (this.modelFactory) return this.modelFactory(modelId);
    const apiKey = this.getApiKey();
    if (!apiKey) return null;
    return createAnthropic({ apiKey })(modelId);
  }

  // The per-request anthropic providerOptions: extended thinking + sendReasoning so the
  // replayed reasoning blocks are re-sent on the same model. Undefined when thinking is
  // disabled and nothing else needs setting.
  private anthropicProviderOptions():
    | Record<string, Record<string, JSONValue>>
    | undefined {
    if (this.thinking.type === "disabled") return undefined;
    return {
      anthropic: {
        thinking: this.thinking as unknown as JSONValue as Record<
          string,
          JSONValue
        >,
        // Ensure reasoning parts (with their signatures) are sent back on replay.
        sendReasoning: true,
      },
    };
  }

  async *streamTurn(
    req: TurnRequest,
    signal: AbortSignal,
  ): AsyncIterable<ProviderEvent> {
    const model = this.resolveModel(req.model);
    if (!model) {
      yield {
        type: "error",
        error: {
          code: "MODEL_UNCONFIGURED",
          message:
            "No Anthropic API key is configured; cannot stream a turn. Add a key in Settings.",
        },
      };
      return;
    }

    const startedAt = new Date();
    const providerOptions = this.anthropicProviderOptions();
    const result = streamText({
      model,
      system: req.system,
      messages: toModelMessages(req.messages, this.id, this.supportsCaching),
      tools: toSdkTools(req.tools, this.supportsCaching),
      maxOutputTokens: this.maxOutputTokens ??
        maxOutputTokensFor(req.model),
      abortSignal: signal,
      ...(providerOptions ? { providerOptions } : {}),
    });

    // The fullStream drain + terminal usage/reasoning mapping is provider-agnostic —
    // the shared driver handles it (ai-sdk-shared.ts). Anthropic's only specifics are
    // above: the SDK factory, the thinking providerOptions, and supportsCaching.
    yield* streamProviderEvents(result, {
      startedAt,
      model: req.model,
      providerId: this.id,
      signal,
    });
  }
}
