// @layer providers — the routing ModelProvider (multi-model harness,
// docs/multi-model-harness-plan.md §5 Stage 4). This is the single ModelProvider the
// composition roots inject into the loop; per streamTurn it reads which provider backs
// the requested model (providerFor) and delegates to the matching concrete impl
// (Anthropic or OpenAI), constructed lazily and reused across turns. This is what lets
// one running kernel drive different providers turn-to-turn purely by the resolved
// model's provider tag — no re-composition, no loop change.
//
// LAYER: open L2, sibling of anthropic-provider.ts / openai-provider.ts. It imports core
// (down — the ModelProvider contract + providerFor) and the concrete providers (same
// layer). It must NEVER import agent-loop/ or agent/.
//
// Routing happens at streamTurn, so each concrete impl applies its OWN caching (its
// supportsCaching governs the shared mappers). The router's own supportsCaching is
// therefore only informational — the loop never reads it (it calls streamTurn and the
// delegate decides). It advertises `true` as a safe superset so no downstream consumer
// that might gate on it disables a caching-capable path.

import type {
  ModelProvider,
  ProviderEvent,
  TurnRequest,
} from "../core/model-provider.ts";
import { type ModelProviderId, providerFor } from "../core/config.ts";
import { AnthropicModelProvider } from "./anthropic-provider.ts";
import { OpenAiModelProvider } from "./openai-provider.ts";

export interface RoutingModelProviderOptions {
  // Per-provider factories. Defaults construct the real impls; tests inject fakes to
  // assert dispatch without a network. A partial override replaces only the given ids.
  factories?: Partial<Record<string, () => ModelProvider>>;
  // How a model id resolves to a provider id. Defaults to the config-driven providerFor
  // (reads the discovered catalog's `provider` tag; unknown/legacy ids fall back to
  // DEFAULT_MODEL_PROVIDER). Injectable so a unit test can drive routing deterministically
  // without seeding the model cache.
  resolveProvider?: (model: string) => ModelProviderId;
}

export class RoutingModelProvider implements ModelProvider {
  readonly id = "router";
  readonly supportsCaching = true;

  readonly #factories: Record<string, () => ModelProvider>;
  readonly #resolveProvider: (model: string) => ModelProviderId;
  readonly #instances = new Map<ModelProviderId, ModelProvider>();

  constructor(opts: RoutingModelProviderOptions = {}) {
    this.#factories = {
      anthropic: opts.factories?.anthropic ??
        (() => new AnthropicModelProvider()),
      openai: opts.factories?.openai ?? (() => new OpenAiModelProvider()),
    };
    this.#resolveProvider = opts.resolveProvider ?? providerFor;
  }

  // The concrete impl for a provider id, constructed once and cached. `#factories` is a
  // total Record over ModelProviderId, so every id providerFor can return has a factory.
  #providerFor(id: ModelProviderId): ModelProvider {
    let instance = this.#instances.get(id);
    if (!instance) {
      instance = (this.#factories[id] ??
        (() => new OpenAiModelProvider({ providerId: id })))();
      this.#instances.set(id, instance);
    }
    return instance;
  }

  async *streamTurn(
    req: TurnRequest,
    signal: AbortSignal,
  ): AsyncIterable<ProviderEvent> {
    const providerId = this.#resolveProvider(req.model);
    // The delegate owns transport and signal handling; the router only annotates usage
    // events with the concrete provider it selected for durable accounting.
    for await (
      const event of this.#providerFor(providerId).streamTurn(req, signal)
    ) {
      if (event.type === "model_request_usage" || event.type === "turn_usage") {
        yield { ...event, provider: event.provider ?? providerId };
      } else {
        yield event;
      }
    }
  }
}
