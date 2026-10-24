// @layer providers — the concrete Anthropic utility-role model call (multi-model
// harness, docs/multi-model-harness-plan.md §5 Stage 5). This is the one-shot,
// non-streaming analogue of anthropic-provider.ts's streamTurn: it owns
// `new Anthropic()` + `messages.create` for the kernel's many small "ask once,
// parse the reply" jobs, so the SDK is imported in exactly one layer (providers/).
//
// LAYER: open L2, sibling of anthropic-provider.ts. It imports core (down — the
// neutral UtilityModel* contract + the lazy key accessor) and the Anthropic SDK,
// and is injected into the core seam by the composition roots (cli/assembly.ts)
// via installUtilityModelProvider. It must NEVER be imported by core/ (that would
// be an upward import) — core reaches it only through the installed seam.
import Anthropic from "@anthropic-ai/sdk";
import { generateText, type LanguageModelUsage } from "ai";
import { usageTokenBreakdown } from "./ai-sdk-shared.ts";
import { openAiModelFor } from "./openai-client.ts";
import type {
  UtilityModelCall,
  UtilityModelRequest,
  UtilityModelResult,
} from "../core/utility-model.ts";
import {
  getAnthropicApiKey,
  getOpenaiApiKey,
  getProviderKey,
  type ModelProviderId,
  providerFor,
} from "../core/config.ts";

// The minimal client surface the utility call needs: a single non-streaming
// messages.create. Anthropic satisfies it; a test supplies a fake so the request
// shaping, text/usage extraction, and timeout race run with no network.
export interface UtilityMessagesClient {
  messages: {
    create(
      params: Anthropic.MessageCreateParamsNonStreaming,
    ): Promise<Anthropic.Message>;
  };
}

// The concatenated text of a reply's text blocks. Every utility caller parses
// whitespace-tolerantly (JSON brace-slice, first-line, quote-strip, regex), and
// these one-shot no-tool replies carry a single text block, so the join is
// behavior-identical to the callers' former `content[0].text` / `.join("")`.
function textOf(response: Anthropic.Message): string {
  return response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
}

// The TTL the utility cache breakpoint writes at. A gate run is bursty with gaps
// between claims, and the write is paid once against 20+ reads, so the 1h rate (2x
// input vs 1.25x) is cheaper than re-writing the block every 5 minutes.
const CACHE_PREFIX_TTL = "1h" as const;

// What goes between the cached prefix and the varying part. Shared by both provider
// paths so the model sees the same prompt regardless of which one shaped it.
const CACHE_PREFIX_SEPARATOR = "\n\n";

function usageOf(
  response: Anthropic.Message,
  req: UtilityModelRequest,
): UtilityModelResult["usage"] {
  // cache_* counts are not on the SDK's typed Usage; read them off a numeric view
  // exactly as the former call sites did.
  const usage = response.usage as unknown as Record<string, number>;
  return {
    inputTokens: response.usage?.input_tokens ?? 0,
    outputTokens: response.usage?.output_tokens ?? 0,
    cacheCreationInputTokens: usage?.cache_creation_input_tokens ?? 0,
    cacheReadInputTokens: usage?.cache_read_input_tokens ?? 0,
    // Stamped only when this request actually asked for the extended TTL, so the
    // ledger prices those writes at 2x input; every other call stays byte-identical.
    ...(req.cachePrefix ? { cacheTtl: CACHE_PREFIX_TTL } : {}),
  };
}

// The non-streaming create params for a neutral request: a single user turn,
// with `system`/`temperature` set only when the caller provides them (an omitted
// field must not diverge from the former per-site call, which never sent it).
export function toMessageParams(
  req: UtilityModelRequest,
): Anthropic.MessageCreateParamsNonStreaming {
  return {
    model: req.model,
    stream: false,
    max_tokens: req.maxTokens,
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    ...(req.system !== undefined ? { system: req.system } : {}),
    messages: [{ role: "user", content: toUserContent(req) }],
  } as Anthropic.MessageCreateParamsNonStreaming;
}

// The user turn's content. Without a cachePrefix this stays the plain string the
// former per-site calls sent. With one, the prompt splits into two text blocks —
// prefix first, carrying the cache breakpoint, then the varying part — so every
// call that repeats the prefix reads it back at 0.1x instead of paying full input.
// The separator rides on the SECOND block so the cached bytes are exactly
// `cachePrefix`, and so the concatenated prompt is identical to what the
// no-breakpoint providers send via promptTextOf.
function toUserContent(
  req: UtilityModelRequest,
): string | Anthropic.TextBlockParam[] {
  if (!req.cachePrefix) return req.user;
  return [
    {
      type: "text",
      text: req.cachePrefix,
      cache_control: { type: "ephemeral", ttl: CACHE_PREFIX_TTL },
    },
    { type: "text", text: `${CACHE_PREFIX_SEPARATOR}${req.user}` },
  ];
}

// Race a pending request against a timeout, clearing the timer on either outcome
// so a won race never leaves a ~55s timer pending (matching the former sites).
async function withTimeout<T>(
  pending: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeoutId);
  }
}

// Apply the request's optional timeout to a pending call, preserving the caller's exact
// timeout message (default matching the former per-site wording). Shared by both provider
// paths so the timeout semantics are identical regardless of backing SDK.
function raceTimeout<T>(
  pending: Promise<T>,
  req: UtilityModelRequest,
): Promise<T> {
  return req.timeoutMs !== undefined
    ? withTimeout(
      pending,
      req.timeoutMs,
      req.timeoutMessage ?? "Utility model request timed out",
    )
    : pending;
}

// The transport-agnostic core: shape the request, race the optional timeout, and
// map the reply to the neutral result. Exercised directly by the provider test
// with a fake client; anthropicUtilityModelCall wraps it with the real SDK.
export async function callUtilityModelWith(
  client: UtilityMessagesClient,
  req: UtilityModelRequest,
): Promise<UtilityModelResult> {
  const response = await raceTimeout(
    client.messages.create(toMessageParams(req)),
    req,
  );
  return {
    text: textOf(response),
    usage: usageOf(response, req),
    provider: "anthropic",
    model: response.model ?? req.model,
  };
}

// The one-shot Anthropic call. Sources the key lazily (config → env) exactly as
// anthropic-provider.ts does, so a key added mid-session is picked up without
// reconstructing anything. A keyless client falls back to the SDK's own
// ANTHROPIC_API_KEY env read (the former ai-completions behavior); callers guard
// on a key upstream, so this is only reached when one is present.
export const anthropicUtilityModelCall: UtilityModelCall = (
  req: UtilityModelRequest,
): Promise<UtilityModelResult> => {
  const apiKey = getAnthropicApiKey();
  const client = new Anthropic(apiKey ? { apiKey } : {});
  return callUtilityModelWith(client, req);
};

// --- OpenAI utility call (Stage 4) ------------------------------------------

// The OpenAI one-shot analogue. Uses the AI SDK's non-streaming generateText (same
// library the streaming OpenAI provider drives) rather than the raw openai package, so
// providers/ owns exactly one OpenAI dependency. Neutral usage is mapped off the SDK's
// LanguageModelUsage (cache counts land on inputTokenDetails, provider-neutral in v7).
function usageFromSdk(usage: LanguageModelUsage): UtilityModelResult["usage"] {
  return usageTokenBreakdown(usage);
}

// The single prompt string for providers with no explicit cache-breakpoint surface:
// the cachePrefix concatenated ahead of the varying part, so the model sees the same
// prompt the Anthropic two-block path sends. No caching, but no silently dropped
// context either.
export function promptTextOf(req: UtilityModelRequest): string {
  return req.cachePrefix
    ? `${req.cachePrefix}${CACHE_PREFIX_SEPARATOR}${req.user}`
    : req.user;
}

// The generate function the OpenAI core races: a single non-streaming completion returning
// the reply text + neutral SDK usage. The real impl wraps generateText; a test supplies a
// fake so request shaping, usage mapping, and the timeout race run with no network.
export type UtilityGenerate = (
  req: UtilityModelRequest,
) => Promise<{ text: string; usage: LanguageModelUsage }>;

// The transport-agnostic OpenAI core: race the optional timeout and map to the neutral
// result. Exercised directly by the provider test with a fake generate; the real call
// wraps it with generateText.
export async function callOpenAiUtilityModelWith(
  generate: UtilityGenerate,
  req: UtilityModelRequest,
): Promise<UtilityModelResult> {
  const { text, usage } = await raceTimeout(generate(req), req);
  return {
    text,
    usage: usageFromSdk(usage),
    provider: "openai",
    model: req.model,
  };
}

// The one-shot OpenAI call. Sources the key lazily (config → OPENAI_API_KEY) exactly as
// the streaming OpenAI provider does. A keyless client falls back to the SDK's own env
// read; callers guard on a key upstream, so this is only reached when one is present.
// `system` is sent only when provided; no temperature unless the caller sets one — parity
// with the Anthropic path's omit-when-absent shaping.
export const openAiUtilityModelCall: UtilityModelCall = (
  req: UtilityModelRequest,
): Promise<UtilityModelResult> => {
  return makeOpenAiCompatibleUtilityModelCall("openai")(req);
};

export function makeOpenAiCompatibleUtilityModelCall(
  providerId: ModelProviderId,
): UtilityModelCall {
  return (req: UtilityModelRequest): Promise<UtilityModelResult> => {
    const apiKey = providerId === "openai"
      ? getOpenaiApiKey()
      : getProviderKey(providerId);
    const model = openAiModelFor(req.model, apiKey, providerId);
    return callOpenAiUtilityModelWith(
      (r) =>
        generateText({
          model,
          prompt: promptTextOf(r),
          maxOutputTokens: r.maxTokens,
          ...(r.system !== undefined ? { system: r.system } : {}),
          ...(r.temperature !== undefined
            ? { temperature: r.temperature }
            : {}),
        }),
      req,
    ).then((result) => ({
      ...result,
      provider: providerId,
    }));
  };
}

// --- Provider-routing utility call (Stage 4) --------------------------------

// Pick the utility impl by the resolved model's provider tag, mirroring the streaming
// RoutingModelProvider. Without this, an OpenAI-only stack would break every utility job
// (session naming, commit subjects, audits) that runs on an OpenAI model. The impls and
// the resolver are injectable so routing is unit-testable without seeding the model cache;
// the composition roots install the default (real providerFor + real impls).
export function makeRoutingUtilityModelCall(opts?: {
  anthropic?: UtilityModelCall;
  openai?: UtilityModelCall;
  openAiCompatible?: (providerId: ModelProviderId) => UtilityModelCall;
  resolveProvider?: (model: string) => ModelProviderId;
}): UtilityModelCall {
  const anthropic = opts?.anthropic ?? anthropicUtilityModelCall;
  const openai = opts?.openai ?? openAiUtilityModelCall;
  const openAiCompatible = opts?.openAiCompatible ??
    makeOpenAiCompatibleUtilityModelCall;
  const resolve = opts?.resolveProvider ?? providerFor;
  return async (req) => {
    const provider = resolve(req.model);
    const call = provider === "anthropic"
      ? anthropic
      : provider === "openai"
      ? openai
      : openAiCompatible(provider);
    const result = await call(req);
    return {
      ...result,
      provider: result.provider ?? provider,
      model: result.model ?? req.model,
    };
  };
}

// The default routing call the composition roots install. setUtilityModelCallForTest
// still wins over it (core/utility-model.ts dispatches the test override first).
export const routingUtilityModelCall: UtilityModelCall =
  makeRoutingUtilityModelCall();
