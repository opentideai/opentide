// @layer providers — the provider-neutral AI-SDK mapping helpers shared by every
// concrete ModelProvider that speaks the Vercel AI SDK (multi-model harness,
// docs/multi-model-harness-plan.md §5 Stage 4). Both anthropic-provider.ts and
// openai-provider.ts drive `streamText().fullStream`; the request mapping (neutral
// TurnRequest → SDK call params) and the stream mapping (SDK parts → neutral
// ProviderEvent pieces) are identical across them, so they live here once and each
// impl keeps only its provider-specific bits (SDK factory, providerOptions,
// supportsCaching, reasoning replay policy).
//
// LAYER: open L2, sibling of anthropic-provider.ts / openai-provider.ts. It imports
// core (down — the neutral ModelProvider contract, usage, util) and the Vercel AI
// SDK. It must NEVER import agent-loop/ or agent/ (the loop stays SDK-free).
//
// Caching is gated on the `supportsCaching` flag every helper takes: a caching
// provider (Anthropic) hangs ephemeral cache_control breakpoints on the tool block
// and the first+last message; a non-caching provider (OpenAI, which caches
// server-side automatically) passes `false` and the mappers emit no breakpoints at
// all. The neutral usage fields still carry cache read/write counts either way.

import {
  type AssistantContent,
  type FilePart,
  type FinishReason,
  type ImagePart,
  jsonSchema,
  type JSONValue,
  type LanguageModelUsage,
  type ModelMessage,
  type streamText,
  type TextPart,
  tool,
  type ToolCallPart,
  type ToolResultPart,
  type ToolSet,
  type UserContent,
} from "ai";
import type {
  NeutralContentBlock,
  NeutralMessage,
  NeutralReasoningBlock,
  NeutralTool,
  ProviderEvent,
  ProviderStopReason,
} from "../core/model-provider.ts";
import type { ModelProviderId } from "../core/config.ts";
import {
  PROVIDER_ERROR_CODES,
  wireVisibleToolOutput,
} from "../core/model-provider.ts";
import type { TurnUsage } from "../core/types.ts";
import {
  type CacheTtl,
  computeCostUsdWithStatus,
  computeProviderModelCost,
} from "../core/usage.ts";
import { errorMessage } from "../core/util.ts";

// The SDK's reasoning content part, derived from AssistantContent (the `ai` package
// imports ReasoningPart internally but does not re-export it). This is the opaque
// thinking+signature block we round-trip verbatim for same-model replay.
export type ReasoningPart = Extract<
  Exclude<AssistantContent, string>[number],
  { type: "reasoning" }
>;

function tokenCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, value)
    : 0;
}

export function usageTokenBreakdown(usage: LanguageModelUsage): {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
} {
  const rawInputTokens = tokenCount(usage.inputTokens);
  const details = usage.inputTokenDetails as
    | (NonNullable<LanguageModelUsage["inputTokenDetails"]> & {
      noCacheTokens?: number;
    })
    | undefined;
  const cacheReadInputTokens = tokenCount(details?.cacheReadTokens);
  const cacheCreationInputTokens = tokenCount(details?.cacheWriteTokens);
  const inputTokens = details &&
      typeof details.noCacheTokens === "number" &&
      Number.isFinite(details.noCacheTokens)
    ? tokenCount(details.noCacheTokens)
    : details
    ? Math.max(
      rawInputTokens - cacheReadInputTokens - cacheCreationInputTokens,
      0,
    )
    : rawInputTokens;
  return {
    inputTokens,
    outputTokens: tokenCount(usage.outputTokens),
    cacheCreationInputTokens,
    cacheReadInputTokens,
  };
}

// The Anthropic cache_control breakpoint, in the AI-SDK providerOptions form Stage 0
// proved (spike/FINDINGS.md §3): an ephemeral marker on a content block / tool caches
// the whole prefix ahead of it (tools → system → messages). Kept as one shared literal
// so every breakpoint is byte-identical. It rides under the `anthropic` providerOptions
// namespace, but is only ever applied when a provider passes supportsCaching=true (only
// Anthropic does today) — so it is inert for a non-caching provider (OpenAI).
const CACHE_BREAKPOINT = {
  anthropic: { cacheControl: { type: "ephemeral" } },
} as const;

// --- Request mapping: TurnRequest → streamText params -----------------------

// NeutralTool[] → the AI SDK ToolSet. The JSON Schema body transfers VERBATIM via
// jsonSchema() (spike/FINDINGS.md §4.1); no `execute` so the SDK stops at the call. When
// caching is on, the LAST tool carries a cache breakpoint so the whole tool-def block is
// cached (Anthropic renders tools → system → messages, so this segment is the stable,
// reused prefix). Non-caching providers pass supportsCaching=false → no breakpoint.
export function toSdkTools(
  tools: NeutralTool[],
  supportsCaching: boolean,
): ToolSet {
  const set: ToolSet = {};
  tools.forEach((t, index) => {
    const isLast = index === tools.length - 1;
    set[t.name] = tool({
      description: t.description,
      inputSchema: jsonSchema(t.inputSchema),
      ...(supportsCaching && isLast
        ? { providerOptions: CACHE_BREAKPOINT }
        : {}),
    });
  });
  return set;
}

// NeutralMessage[] → the AI SDK CoreMessage[]. text→text, tool_use→assistant tool-call
// parts, tool_result→tool parts paired by toolCallId, image/document→file parts, and
// reasoning→replayed verbatim (same-model thinking + signature round-trip). When caching
// is on, cache breakpoints hang on the last content block of the first AND last message:
// the first pins a stable tools+system+first-message prefix across the whole session,
// the last extends the cached prefix as the conversation grows — so consecutive requests
// within a turn (a tool round-trip) reuse the cached prefix (the Stage 0 cost linchpin).
export function toModelMessages(
  messages: NeutralMessage[],
  providerId: string,
  supportsCaching: boolean,
): ModelMessage[] {
  // Pair tool results back to their call's name: NeutralToolResultBlock carries only the
  // toolCallId, but the SDK ToolResultPart needs the toolName. Assistant tool_use blocks
  // always precede their results, so one pass over the whole array resolves every name.
  const toolNames = new Map<string, string>();
  for (const msg of messages) {
    for (const block of msg.content) {
      if (block.type === "tool_use") toolNames.set(block.id, block.name);
    }
  }

  const out: ModelMessage[] = [];
  for (const msg of messages) {
    if (msg.role === "user") {
      out.push({ role: "user", content: toUserContent(msg.content) });
    } else if (msg.role === "assistant") {
      out.push({
        role: "assistant",
        content: toAssistantContent(msg.content, providerId),
      });
    } else {
      out.push({
        role: "tool",
        content: toToolContent(msg.content, toolNames),
      });
    }
  }

  if (supportsCaching && out.length > 0) {
    const first = out[0];
    const last = out[out.length - 1];
    if (first) applyCacheBreakpoint(first);
    if (last) applyCacheBreakpoint(last);
  }
  return out;
}

function toUserContent(blocks: NeutralContentBlock[]): UserContent {
  const parts: Array<TextPart | ImagePart | FilePart> = [];
  for (const block of blocks) {
    if (block.type === "text") {
      parts.push({ type: "text", text: block.text });
    } else if (block.type === "image") {
      parts.push({
        type: "file",
        data: block.data,
        mediaType: block.mediaType,
      });
    } else if (block.type === "document") {
      parts.push({
        type: "file",
        data: block.data,
        mediaType: block.mediaType,
        ...(block.title ? { filename: block.title } : {}),
      });
    }
  }
  return parts;
}

function toAssistantContent(
  blocks: NeutralContentBlock[],
  providerId: string,
): AssistantContent {
  const parts: Array<TextPart | ReasoningPart | ToolCallPart> = [];
  for (const block of blocks) {
    if (block.type === "reasoning") {
      // Replay VERBATIM only our own reasoning; a foreign provider's opaque internals
      // are dropped (the NeutralReasoningBlock contract). `data` is the ReasoningPart[]
      // we stashed on capture — spread it back unchanged (thinking blocks go first).
      if (block.provider === providerId) {
        for (const part of block.data as ReasoningPart[]) parts.push(part);
      }
    } else if (block.type === "text") {
      parts.push({ type: "text", text: block.text });
    } else if (block.type === "tool_use") {
      parts.push({
        type: "tool-call",
        toolCallId: block.id,
        toolName: block.name,
        input: block.input,
      });
    }
  }
  return parts;
}

function toToolContent(
  blocks: NeutralContentBlock[],
  toolNames: Map<string, string>,
): ToolResultPart[] {
  const parts: ToolResultPart[] = [];
  for (const block of blocks) {
    if (block.type !== "tool_result") continue;
    parts.push({
      type: "tool-result",
      toolCallId: block.toolCallId,
      toolName: toolNames.get(block.toolCallId) ?? block.toolCallId,
      output: { type: "json", value: toJsonValue(block.output) },
    });
  }
  return parts;
}

// Hang a cache breakpoint on the last content part of a message. Content is always an
// array here (every builder above produces one), so a string content — which cannot
// carry providerOptions — never occurs.
function applyCacheBreakpoint(message: ModelMessage): void {
  const content = message.content;
  if (typeof content === "string" || content.length === 0) return;
  const last = content[content.length - 1];
  // providerOptions is optional on every part we build; the cast covers the one or two
  // union members (tool-approval parts) that lack it and which we never construct.
  if (last) {
    (last as { providerOptions?: unknown }).providerOptions = {
      ...CACHE_BREAKPOINT,
    };
  }
}

// Coerce an arbitrary tool-dispatch result into a valid JSONValue for the SDK: a
// defensive round-trip strips undefined/functions/cycles that would make the request
// unserializable. Dispatch results are already JSON objects, so this is normally a
// no-op-shaped clone.
function toJsonValue(value: unknown): JSONValue {
  try {
    return JSON.parse(
      JSON.stringify(wireVisibleToolOutput(value) ?? null),
    ) as JSONValue;
  } catch {
    return { error: "unserializable tool result" };
  }
}

// --- Stream mapping helpers -------------------------------------------------

// LanguageModelUsage → TurnUsage. Cache counts are provider-neutral in v7 — they land on
// usage.inputTokenDetails (spike/FINDINGS.md §3), so no provider branch. turnId/sessionId
// are left blank: the loop stamps the durable turn_usage with its own identity, and the
// live model_request_usage counter does not need them. costUsd is computed here from the
// resolved model + tier pricing, mirroring the Managed path.
export function toTurnUsage(
  usage: LanguageModelUsage,
  model: string,
  startedAt: Date,
  endedAt: Date,
  providerId?: string,
  // TTL this request's cache breakpoints wrote at. The streaming path uses the
  // default 5m breakpoint and passes nothing; a caller that writes at "1h" must
  // say so or the write is priced at 1.25x instead of 2x input (§4.9).
  cacheTtl?: CacheTtl,
): TurnUsage {
  const {
    inputTokens,
    outputTokens,
    cacheCreationInputTokens,
    cacheReadInputTokens,
  } = usageTokenBreakdown(usage);
  const provider = toKnownProviderId(providerId);
  const cost = provider
    ? computeProviderModelCost({
      provider,
      model,
      inputTokens,
      outputTokens,
      cacheCreationInputTokens,
      cacheReadInputTokens,
      asOf: endedAt,
      ...(cacheTtl !== undefined ? { cacheTtl } : {}),
    })
    : computeCostUsdWithStatus(
      model,
      inputTokens,
      outputTokens,
      cacheCreationInputTokens,
      cacheReadInputTokens,
      endedAt,
      cacheTtl,
    );
  return {
    turnId: "",
    sessionId: "",
    model,
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    durationMs: Math.max(0, endedAt.getTime() - startedAt.getTime()),
    inputTokens,
    outputTokens,
    cacheCreationInputTokens,
    cacheReadInputTokens,
    toolCallsCount: 0,
    pricingStatus: cost.pricingStatus,
    costUsd: cost.costUsd ?? 0,
  };
}

function toKnownProviderId(
  providerId: string | undefined,
): ModelProviderId | undefined {
  const normalized = providerId?.trim();
  return normalized ? normalized : undefined;
}

// AI SDK FinishReason → ProviderStopReason (the stop table in the model-provider.ts
// header). The AI SDK normalizes finishReason across providers, so this one table serves
// every impl. A missing finish (stream ended without a finish part) settles as end_turn.
export function mapFinishReason(
  finishReason: FinishReason | null,
): ProviderStopReason {
  switch (finishReason) {
    case "tool-calls":
      return "requires_action";
    case "length":
      return "max_tokens";
    case "content-filter":
    case "error":
      return "error";
    case "stop":
    case "other":
    case null:
    default:
      return "end_turn";
  }
}

// Probe an unknown error for the structured status + string signals the AI SDK may
// expose, WITHOUT coupling to an SDK-internal error class (an APICallError carries
// statusCode; a raw provider payload carries code/type/message). Reads a handful of
// conventional fields defensively — a safe property probe on `unknown`, never an
// instanceof against an SDK-private class — so the classifier stays robust to SDK
// version drift AND to a plain-object payload whose `.message` errorMessage() (which
// only unwraps real Error instances) would otherwise render as "[object Object]".
// Returns a numeric HTTP status plus every candidate string lowercased for substring
// matching.
function errorSignals(
  error: unknown,
): { status: number | null; haystack: string } {
  const texts: string[] = [errorMessage(error)];
  let status: number | null = null;
  if (error && typeof error === "object") {
    const e = error as Record<string, unknown>;
    const statusish = e.statusCode ?? e.status;
    if (typeof statusish === "number") status = statusish;
    for (const key of ["message", "code", "type", "name"]) {
      const v = e[key];
      if (typeof v === "string") texts.push(v);
    }
    // A nested provider payload: { error: { code, type, message } } or { data: {…} }.
    const nested = e.error ?? e.data;
    if (nested && typeof nested === "object") {
      const n = nested as Record<string, unknown>;
      for (const key of ["message", "code", "type"]) {
        const v = n[key];
        if (typeof v === "string") texts.push(v);
      }
    }
  }
  return { status, haystack: texts.join(" ").toLowerCase() };
}

// Classify a raw provider error into a semantic ProviderError code (context-hardening
// plan, Slice 5). The loop reacts to CONTEXT_LENGTH_EXCEEDED (auto-compact + retry
// once); the rest are informational today but carry a real code instead of an opaque
// PROVIDER_ERROR. Matches case-insensitively over the message AND any structured
// code/type the AI-SDK error exposes (errorSignals), plus the numeric HTTP status:
//   • CONTEXT_LENGTH_EXCEEDED — Anthropic "prompt is too long" / invalid_request_error
//     length signature; OpenAI context_length_exceeded / "maximum context length".
//   • RATE_LIMITED — HTTP 429 / "rate limit".
//   • TRANSIENT — 5xx / "overloaded" / "service unavailable".
//   • PROVIDER_ERROR — the unchanged default for anything unmatched.
export function toProviderError(
  error: unknown,
): { code: string; message: string } {
  const message = errorMessage(error);
  const { status, haystack } = errorSignals(error);

  if (
    haystack.includes("context_length_exceeded") ||
    haystack.includes("maximum context length") ||
    haystack.includes("prompt is too long") ||
    haystack.includes("too many tokens") ||
    (haystack.includes("context") &&
      (haystack.includes("exceed") || haystack.includes("too long")) &&
      (haystack.includes("token") || haystack.includes("length") ||
        haystack.includes("window")))
  ) {
    return { code: PROVIDER_ERROR_CODES.CONTEXT_LENGTH_EXCEEDED, message };
  }

  if (status === 429 || haystack.includes("rate limit")) {
    return { code: PROVIDER_ERROR_CODES.RATE_LIMITED, message };
  }

  if (
    (status !== null && status >= 500 && status <= 599) ||
    haystack.includes("overloaded") ||
    haystack.includes("service unavailable")
  ) {
    return { code: PROVIDER_ERROR_CODES.TRANSIENT, message };
  }

  return { code: PROVIDER_ERROR_CODES.PROVIDER_ERROR, message };
}

// Pull the model's reasoning parts out of the accumulated response messages and bundle
// them into ONE NeutralReasoningBlock (data = the ReasoningPart[]), tagged with this
// provider so replay only re-sends our own. Returns [] when there was no reasoning.
export function extractReasoning(
  messages: ModelMessage[],
  providerId: string,
): NeutralReasoningBlock[] {
  const parts: ReasoningPart[] = [];
  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    const content = msg.content;
    if (typeof content === "string") continue;
    for (const part of content) {
      if (part.type === "reasoning") parts.push(part);
    }
  }
  return parts.length > 0
    ? [{ type: "reasoning", provider: providerId, data: parts }]
    : [];
}

// --- Shared fullStream driver -----------------------------------------------

// The value streamText() returns — the same shape for every AI-SDK provider (both
// impls pass a ToolSet from toSdkTools and no experimental_output), so one driver
// consumes it for all of them.
type AiSdkStreamResult = ReturnType<typeof streamText>;

// What a concrete provider must hand the driver: the started-at stamp (captured
// before streamText so latency is measured from the call), the resolved model id,
// the provider's own id (tags captured reasoning for same-model replay), and the
// abort signal (an aborted stream throws — that is a clean cancel, not an error).
export interface StreamContext {
  startedAt: Date;
  model: string;
  providerId: string;
  signal: AbortSignal;
}

// Drain streamText().fullStream and translate its parts into the neutral
// ProviderEvent union, then emit the terminal turn_usage + message_complete (with any
// captured reasoning). This is the whole provider-agnostic streaming loop: a concrete
// provider only builds the streamText() call with its own model + providerOptions and
// delegates the drain here, so Anthropic and OpenAI share one mapping. The loop passes
// NO `execute` to its tools, so the SDK stops at a tool call (finishReason
// "tool-calls" → requires_action) and we surface it rather than run it.
export async function* streamProviderEvents(
  result: AiSdkStreamResult,
  ctx: StreamContext,
): AsyncIterable<ProviderEvent> {
  let finishReason: FinishReason | null = null;
  let totalUsage: LanguageModelUsage | null = null;

  try {
    for await (const part of result.fullStream) {
      switch (part.type) {
        case "text-delta": {
          if (part.text) yield { type: "text_delta", text: part.text };
          break;
        }
        case "reasoning-start": {
          yield { type: "thinking_start" };
          break;
        }
        case "reasoning-delta": {
          if (part.text) yield { type: "thinking_delta", text: part.text };
          break;
        }
        case "reasoning-end": {
          yield { type: "thinking_end" };
          break;
        }
        case "tool-call": {
          // Finalized call: name + input + a stable id the loop pairs the eventual
          // tool_result back to. We pass no `execute`, so the SDK stops here.
          yield {
            type: "tool_use_start",
            toolName: part.toolName,
            toolInput: part.input,
            toolCallId: part.toolCallId,
          };
          break;
        }
        case "finish-step": {
          yield {
            type: "model_request_usage",
            provider: toKnownProviderId(ctx.providerId),
            usage: toTurnUsage(
              part.usage,
              ctx.model,
              ctx.startedAt,
              new Date(),
              ctx.providerId,
            ),
          };
          break;
        }
        case "finish": {
          finishReason = part.finishReason;
          totalUsage = part.totalUsage;
          break;
        }
        case "abort": {
          return;
        }
        case "error": {
          yield { type: "error", error: toProviderError(part.error) };
          return;
        }
      }
    }
  } catch (err) {
    // An aborted stream throws — that's a clean cancel, not an error to surface.
    if (ctx.signal.aborted) return;
    // Classify the throw too (Slice 5): a context-length error that arrives as a thrown
    // exception rather than a fullStream "error" part must still map to
    // CONTEXT_LENGTH_EXCEEDED so the loop can recover.
    yield { type: "error", error: toProviderError(err) };
    return;
  }

  // Capture the model's reasoning blocks VERBATIM for same-model replay next turn.
  // responseMessages is already resolved (the stream fully drained above). Tagged with
  // ctx.providerId so a different provider replaying this message drops them.
  let reasoning: NeutralReasoningBlock[] = [];
  try {
    reasoning = extractReasoning(await result.responseMessages, ctx.providerId);
  } catch {
    // A reasoning-capture failure must not sink a completed turn — replay just
    // degrades (the next request omits the thinking blocks).
    reasoning = [];
  }

  const endedAt = new Date();
  if (totalUsage) {
    yield {
      type: "turn_usage",
      provider: toKnownProviderId(ctx.providerId),
      usage: toTurnUsage(
        totalUsage,
        ctx.model,
        ctx.startedAt,
        endedAt,
        ctx.providerId,
      ),
    };
  }
  yield {
    type: "message_complete",
    stopReason: mapFinishReason(finishReason),
    ...(reasoning.length > 0 ? { reasoning } : {}),
  };
}
