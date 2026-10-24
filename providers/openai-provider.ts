// @layer providers — the concrete OpenAI ModelProvider (multi-model harness,
// docs/multi-model-harness-plan.md §5 Stage 4). This is the SECOND transport behind
// the ModelProvider seam (core/model-provider.ts) — the executable proof the harness
// is real: the SAME agentic loop runs on a non-Anthropic provider with a byte-identical
// ChatEvent contract. It drives @ai-sdk/openai via streamText().fullStream and reuses
// the provider-neutral request/stream mapping in ai-sdk-shared.ts wholesale; only the
// OpenAI specifics live here.
//
// LAYER: open L2, sibling of anthropic-provider.ts. It imports core (down — the L1
// ModelProvider contract, config) and the Vercel AI SDK, and is injected by the
// composition roots (cli/assembly.ts) via the routing provider. It must NEVER import
// agent-loop/ or agent/ — the loop stays SDK-free.
//
// OpenAI vs. Anthropic specifics normalized here:
//   - supportsCaching = false. OpenAI caches prompt prefixes automatically server-side,
//     so the shared mappers emit NO ephemeral cache_control breakpoints; cache read/write
//     counts still surface through the neutral usage fields when the API reports them.
//   - No temperature/top_p sent (parity with Anthropic; the loop never tunes sampling).
//   - Tools transfer as non-strict function calls (jsonSchema() → verbatim JSON Schema),
//     same as Anthropic. OpenAI caps a request at OPENAI_MAX_FUNCTIONS tools; we assert
//     headroom rather than silently truncating past it.
//   - Reasoning (o-series) surfaces live as thinking_* events and is captured tagged
//     provider "openai" for same-model replay; the shared mapper drops any foreign
//     provider's reasoning, so a cross-provider replay never re-sends internals OpenAI
//     can't sign.

import { type LanguageModel, streamText } from "ai";
import { openAiModelFor } from "./openai-client.ts";
import type {
  ModelProvider,
  ProviderEvent,
  TurnRequest,
} from "../core/model-provider.ts";
import type { ModelProviderId } from "../core/config.ts";
import { getOpenaiApiKey, getProviderKey } from "../core/config.ts";
import { maxOutputTokensFor } from "../core/context-window.ts";
import {
  streamProviderEvents,
  toModelMessages,
  toSdkTools,
} from "./ai-sdk-shared.ts";

// This provider's stable identity. It tags the NeutralReasoningBlocks it emits so a
// different provider replaying a foreign message drops them (NeutralReasoningBlock
// contract). "openai" is a member of core's MODEL_PROVIDER_IDS union — a typed const.
const OPENAI_PROVIDER_ID: ModelProviderId = "openai";

// OpenAI's per-request function-calling ceiling. The projected tool surface (~100 today)
// sits under it, but rather than silently dropping tools past the limit — which would
// hide capabilities from the model — we surface a clear error ProviderEvent so the gap is
// visible. Named (CLAUDE.md — no magic numbers).
const OPENAI_MAX_FUNCTIONS = 128;

export interface OpenAiModelProviderOptions {
  providerId?: ModelProviderId;
  // How the provider sources the API key at request time. Defaults to getOpenaiApiKey
  // (config → OPENAI_API_KEY env), read lazily per streamTurn so a key added mid session
  // is picked up without reconstructing the provider.
  getApiKey?: () => string | undefined;
  // Test seam: build the SDK LanguageModel from a resolved model id. Defaults to
  // openAiModelFor(modelId, apiKey) (providers/openai-client.ts — key + configurable
  // base URL). Unit tests inject a MockLanguageModelV4 so the whole pipeline runs with
  // no network (the SDK's own test path).
  modelFactory?: (modelId: string) => LanguageModel;
  // Per-request output-token ceiling. Defaults to per-model resolution
  // (maxOutputTokensFor), parity with the Anthropic provider. Pass a number to pin
  // one ceiling for every model.
  maxOutputTokens?: number;
}

export class OpenAiModelProvider implements ModelProvider {
  readonly id: string;
  // OpenAI caches automatically server-side — no explicit breakpoints to place.
  readonly supportsCaching = false;

  private readonly getApiKey: () => string | undefined;
  private readonly modelFactory: ((modelId: string) => LanguageModel) | null;
  private readonly maxOutputTokens: number | null;

  constructor(opts: OpenAiModelProviderOptions = {}) {
    this.id = opts.providerId ?? OPENAI_PROVIDER_ID;
    this.getApiKey = opts.getApiKey ??
      (() =>
        this.id === OPENAI_PROVIDER_ID
          ? getOpenaiApiKey()
          : getProviderKey(this.id));
    this.modelFactory = opts.modelFactory ?? null;
    this.maxOutputTokens = opts.maxOutputTokens ?? null;
  }

  // Resolve the SDK LanguageModel for a request. Null when unconfigured (keyless and no
  // injected factory) — streamTurn surfaces that as an error ProviderEvent rather than
  // shipping a dead call (D9), mirroring the Anthropic provider.
  private resolveModel(modelId: string): LanguageModel | null {
    if (this.modelFactory) return this.modelFactory(modelId);
    const apiKey = this.getApiKey();
    if (!apiKey) return null;
    return openAiModelFor(modelId, apiKey, this.id);
  }

  async *streamTurn(
    req: TurnRequest,
    signal: AbortSignal,
  ): AsyncIterable<ProviderEvent> {
    // Validate request shape (tool-count ceiling) before resolving the model — a
    // malformed request fails fast, independent of whether a key is configured.
    if (req.tools.length > OPENAI_MAX_FUNCTIONS) {
      yield {
        type: "error",
        error: {
          code: "TOOL_LIMIT_EXCEEDED",
          message:
            `OpenAI accepts at most ${OPENAI_MAX_FUNCTIONS} functions per request, ` +
            `but ${req.tools.length} tools were provided.`,
        },
      };
      return;
    }

    const model = this.resolveModel(req.model);
    if (!model) {
      const providerLabel = this.id === OPENAI_PROVIDER_ID ? "OpenAI" : this.id;
      yield {
        type: "error",
        error: {
          code: "MODEL_UNCONFIGURED",
          message:
            `No ${providerLabel} API key is configured; cannot stream a turn. Add a key in Settings or the provider's environment variable.`,
        },
      };
      return;
    }

    const startedAt = new Date();
    const result = streamText({
      model,
      system: req.system,
      // supportsCaching=false → the shared mapper emits no cache_control breakpoints.
      messages: toModelMessages(req.messages, this.id, this.supportsCaching),
      tools: toSdkTools(req.tools, this.supportsCaching),
      maxOutputTokens: this.maxOutputTokens ??
        maxOutputTokensFor(req.model),
      abortSignal: signal,
      // No temperature/top_p (parity with Anthropic) and no reasoning-forcing
      // providerOptions: reasoning surfaces only when the model itself emits it, and is
      // captured tagged "openai" for same-model replay by the shared driver.
    });

    // The fullStream drain + terminal usage/reasoning mapping is provider-agnostic.
    yield* streamProviderEvents(result, {
      startedAt,
      model: req.model,
      providerId: this.id,
      signal,
    });
  }
}
