// @layer core — the neutral model-provider transport seam (multi-model harness,
// docs/multi-model-harness-plan.md §4, Stage 1).
//
// This is the transport sibling of core/chat-intelligence.ts's ChatIntelligence:
// where the brain seam swaps *intelligence*, ModelProvider swaps the *provider /
// transport* under the agentic loop. The open loop (agent-loop/) drives a
// ModelProvider; the composition root (cli/assembly.ts) injects a concrete impl
// (Vercel-AI-SDK-backed by default). Keeping the contract here in core (L1),
// free of any provider SDK import, is what makes the backing library reversible
// and keeps agent-loop/ layer-clean.
//
// LANDS DARK: nothing imports this yet (Stage 1 is purely additive). It gets
// wired into chat.ts in Stage 3.
//
// ---------------------------------------------------------------------------
// ProviderEvent → ChatEvent mapping (the living spec; source: spike/FINDINGS.md
// §2, proven against the AI SDK `fullStream` on Anthropic + OpenAI).
//
// A concrete ModelProvider translates its backing library's stream into the
// ProviderEvent union below; the loop then translates ProviderEvent → ChatEvent
// (core/chat-contract.ts) 1:1. The AI SDK `fullStream` parts a provider impl
// will typically consume, and where they land:
//
//   AI SDK fullStream part   ProviderEvent            ChatEvent target
//   ----------------------   -------------            ----------------
//   start                    — (loop bookkeeping)     —
//   start-step               — (reset usage accum)    —
//   text-start               — (opening marker)       —
//   text-delta (.text)       text_delta               text_delta (text)
//   text-end                 — (closing marker)       —
//   reasoning-start          thinking_start           thinking_start
//   reasoning-delta          thinking_delta           (buffered; no ChatEvent
//                                                      today — see note below)
//   reasoning-end            thinking_end             thinking_end
//   tool-input-start         (optional) tool_use_start tool_use_start (toolName)
//   tool-input-delta         — (partial JSON args)    —
//   tool-input-end           — (args complete)        —
//   tool-call (.toolName,    tool_use_start           tool_use_start (toolName,
//     .input)                                          toolInput)
//   (dispatchTool returns)   tool_use_end             tool_use_end (toolResult)
//   finish-step              model_request_usage      model_request_usage
//   finish                   message_complete         message_complete
//                            + turn_usage             + turn_usage
//   error                    error                    error
//
// NOTE on reasoning replay: streamed reasoning surfaces live as thinking_* events,
// but the opaque thinking+signature blocks a same-model replay needs are carried on
// the terminal message_complete (its optional `reasoning` field), not a per-delta
// event — the loop folds them into the assistant NeutralMessage. See
// ProviderMessageComplete + NeutralReasoningBlock below.
//
// NOTE on thinking_delta: the ChatEvent contract has no `thinking_delta` today
// (thinking is start/end only). thinking_delta is carried in the ProviderEvent
// union so a provider impl can surface streamed reasoning text; the loop buffers
// it between thinking_start/thinking_end rather than forwarding a per-delta
// ChatEvent. It is documented as buffered, not dropped — if the contract later
// gains a live thinking_delta, the mapping changes here only.
//
// Stop-reason mapping (provider finishReason → ProviderStopReason, which mirrors
// today's requires_action/end_turn semantics at chat.ts stop handling):
//   stop            → end_turn
//   tool-calls      → requires_action   (the turn paused on tool_use)
//   length          → max_tokens
//   content-filter  → error
//   error / other   → error
// ---------------------------------------------------------------------------

import type { ModelId, ModelProviderId } from "./config.ts";
import type { ChatEvent } from "./chat-contract.ts";
import type { TurnUsage } from "./types.ts";

// Tool results can carry loop-private side channels that are useful to the runtime
// but must not be replayed to the model. `_images` holds raw screenshot bytes; sending
// it as JSON turns a PNG into hundreds of thousands of numeric object entries.
export function modelVisibleToolOutput(output: unknown): unknown {
  if (!output || typeof output !== "object" || Array.isArray(output)) {
    return output;
  }
  const { _images: _omitted, ...visible } = output as Record<string, unknown>;
  void _omitted;
  return visible;
}

// Loop-private side channels that reach the IDE but must never reach the model.
// `_changeset` duplicates `data` verbatim — 19.5% of every tool-result byte in a
// measured corpus was this second copy (docs/agent-cost-reduction.md §2.2) — and
// `_changesetEvent` is a loop routing tag the model has no use for. Used by the wire
// (chat.ts resultBlocks, ai-sdk-shared toJsonValue) and by the context-window estimator
// so the estimate measures what is actually sent. The key list is deliberately fixed:
// a filter whose output depended on payload size would make token estimation
// non-deterministic w.r.t. the request it is estimating.
export function wireVisibleToolOutput(output: unknown): unknown {
  if (!output || typeof output !== "object" || Array.isArray(output)) {
    return output;
  }
  const {
    _images: _omittedImages,
    _changeset: _omittedChangeset,
    _changesetEvent: _omittedChangesetEvent,
    ...visible
  } = output as Record<string, unknown>;
  void _omittedImages;
  void _omittedChangeset;
  void _omittedChangesetEvent;
  return visible;
}

// --- Neutral tool shape -----------------------------------------------------

// A tool as handed to a provider. `inputSchema` is the raw JSON Schema body,
// identical to CustomToolDef.input_schema (core/tools/definitions.ts) — Stage 0
// proved it transfers verbatim to the AI SDK via jsonSchema(). We deliberately
// reuse the same JSON-Schema representation (Record<string, unknown>) rather
// than inventing a new schema type.
export interface NeutralTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

// --- Neutral message content blocks -----------------------------------------

export interface NeutralTextBlock {
  type: "text";
  text: string;
}

export interface NeutralToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}

export interface NeutralToolResultBlock {
  type: "tool_result";
  toolCallId: string;
  output: unknown;
}

// Base64 image content (mirrors chat.ts buildUserContentBlocks image blocks).
export interface NeutralImageBlock {
  type: "image";
  mediaType: string;
  data: string;
}

// Base64 document content, e.g. a PDF (mirrors the loop's document blocks).
export interface NeutralDocumentBlock {
  type: "document";
  mediaType: string;
  data: string;
  title?: string;
}

// Opaque provider-internal thinking/signature data, carried VERBATIM for
// same-model replay. The Stage 0 spike proved replay works by re-appending the
// provider's own assistant message unchanged (the SDK preserves reasoning +
// signature blocks; Anthropic requires them passed back unchanged on the same
// model). `provider` tags which impl produced `data` so a mismatched provider
// can drop it instead of replaying foreign internals; `data` is never inspected
// by the loop — only round-tripped.
export interface NeutralReasoningBlock {
  type: "reasoning";
  provider: string;
  data: unknown;
}

export type NeutralContentBlock =
  | NeutralTextBlock
  | NeutralToolUseBlock
  | NeutralToolResultBlock
  | NeutralImageBlock
  | NeutralDocumentBlock
  | NeutralReasoningBlock;

export type NeutralRole = "user" | "assistant" | "tool";

// One message in the client-side conversation array (Stage 3 holds a
// NeutralMessage[] locally instead of a server-side session).
export interface NeutralMessage {
  role: NeutralRole;
  content: NeutralContentBlock[];
}

// --- Turn request -----------------------------------------------------------

// Everything a provider needs to stream one turn. `system` is a top-level
// string (NOT a system message) — Stage 0 found v7 rejects role:"system" inside
// messages[]; prompt-compose.ts output is handed in here.
export interface TurnRequest {
  model: ModelId;
  system: string;
  messages: NeutralMessage[];
  tools: NeutralTool[];
}

// --- Provider events --------------------------------------------------------

// How a turn ended, normalized across providers. Mirrors today's
// requires_action/end_turn stop handling; see the stop-reason table above.
export type ProviderStopReason =
  | "end_turn"
  | "requires_action"
  | "max_tokens"
  | "error";

// Cache read/write token counts are provider-neutral (Stage 0: in AI SDK v7 they
// land on the neutral usage.inputTokenDetails, not a provider-specific field), so
// they already live on TurnUsage (cacheReadInputTokens / cacheCreationInputTokens)
// — ProviderEvent needs no provider-specific cache field.
export interface ProviderTextDelta {
  type: "text_delta";
  text: string;
}

export interface ProviderThinkingStart {
  type: "thinking_start";
}

export interface ProviderThinkingDelta {
  type: "thinking_delta";
  text: string;
}

export interface ProviderThinkingEnd {
  type: "thinking_end";
}

export interface ProviderToolUseStart {
  type: "tool_use_start";
  toolName: string;
  // Absent when emitted early (from tool-input-start, before args finalize);
  // present on the finalized tool-call.
  toolInput?: unknown;
  // Provider-assigned id for the call, so the loop can pair the eventual
  // tool_result block (NeutralToolResultBlock.toolCallId) back to it.
  toolCallId?: string;
}

export interface ProviderToolUseEnd {
  type: "tool_use_end";
  toolResult: unknown;
  toolCallId?: string;
}

export interface ProviderMessageComplete {
  type: "message_complete";
  stopReason: ProviderStopReason;
  // Same-model reasoning blocks captured from THIS request, carried VERBATIM for
  // replay on the next request (Stage 3b). A concrete provider that produced
  // reasoning surfaces its opaque thinking+signature blocks here as
  // NeutralReasoningBlock[] (tagged with the provider `id`); the loop accumulates
  // them into the assistant NeutralMessage so the next streamTurn can round-trip
  // them unchanged (Anthropic requires thinking blocks passed back verbatim on the
  // same model). Absent when no reasoning was produced. This rides on
  // message_complete rather than a new event so the 1:1 PROVIDER_EVENT_CHAT_TARGET
  // mapping is unchanged — the loop consumes it internally, not as a ChatEvent.
  reasoning?: NeutralReasoningBlock[];
}

// Per-provider-request usage progress (maps to ChatEvent "model_request_usage").
export interface ProviderModelRequestUsage {
  type: "model_request_usage";
  provider?: ModelProviderId;
  usage: TurnUsage;
}

export interface ProviderTurnUsage {
  type: "turn_usage";
  provider?: ModelProviderId;
  usage: TurnUsage;
}

export interface ProviderError {
  type: "error";
  error: { code: string; message: string };
}

// Semantic provider-error codes (context-hardening plan, Slice 5). The classifier in
// providers/ai-sdk-shared.ts (toProviderError) maps a raw provider error onto one of
// these; the loop (agent-loop/chat.ts) compares against CONTEXT_LENGTH_EXCEEDED to
// decide whether to auto-compact-then-retry. They live HERE in L1 — the shared home of
// ProviderError, imported by both providers/ AND agent-loop/ — because agent-loop must
// never import from providers/ (lint:layers). No magic strings on either
// side: both the classifier and the recovery check read them from this one table.
export const PROVIDER_ERROR_CODES = {
  // The prefix overflowed the model's real context window (Anthropic "prompt is too
  // long" / invalid_request_error length signature; OpenAI context_length_exceeded).
  CONTEXT_LENGTH_EXCEEDED: "CONTEXT_LENGTH_EXCEEDED",
  // HTTP 429 / "rate limit".
  RATE_LIMITED: "RATE_LIMITED",
  // 5xx / "overloaded" / "service unavailable" — retriable server-side condition.
  TRANSIENT: "TRANSIENT",
  // The unchanged default for anything unmatched.
  PROVIDER_ERROR: "PROVIDER_ERROR",
} as const;

export type ProviderErrorCode =
  (typeof PROVIDER_ERROR_CODES)[keyof typeof PROVIDER_ERROR_CODES];

// The normalized event union. Maps 1:1 onto ChatEvent (core/chat-contract.ts);
// see the header table for the per-type target.
export type ProviderEvent =
  | ProviderTextDelta
  | ProviderThinkingStart
  | ProviderThinkingDelta
  | ProviderThinkingEnd
  | ProviderToolUseStart
  | ProviderToolUseEnd
  | ProviderMessageComplete
  | ProviderModelRequestUsage
  | ProviderTurnUsage
  | ProviderError;

export type ProviderEventType = ProviderEvent["type"];

// The documented ChatEvent target for each ProviderEvent type — the living,
// machine-checkable form of the header mapping table. `Record<ProviderEventType,
// ...>` forces exhaustiveness at compile time: adding a ProviderEvent variant
// without a mapping entry breaks `deno check`. A target is either a concrete
// ChatEvent["type"] or the "buffered" sentinel (thinking_delta has no ChatEvent
// today — it is buffered between thinking_start/thinking_end, not dropped). The
// unit test guards this against silent drift.
export const BUFFERED_NO_CHAT_EVENT = "buffered" as const;

export type ChatEventTarget = ChatEvent["type"] | typeof BUFFERED_NO_CHAT_EVENT;

export const PROVIDER_EVENT_CHAT_TARGET: Record<
  ProviderEventType,
  ChatEventTarget
> = {
  text_delta: "text_delta",
  thinking_start: "thinking_start",
  thinking_delta: BUFFERED_NO_CHAT_EVENT,
  thinking_end: "thinking_end",
  tool_use_start: "tool_use_start",
  tool_use_end: "tool_use_end",
  message_complete: "message_complete",
  model_request_usage: "model_request_usage",
  turn_usage: "turn_usage",
  error: "error",
};

// --- The seam ---------------------------------------------------------------

// The transport contract the loop drives. A concrete impl (e.g. an
// AI-SDK-backed Anthropic provider) lives behind this in agent/ or a providers/
// subtree, injected by the composition root — agent-loop/ never imports it
// directly (layer rules).
export interface ModelProvider {
  readonly id: string;
  readonly supportsCaching: boolean;
  streamTurn(
    req: TurnRequest,
    signal: AbortSignal,
  ): AsyncIterable<ProviderEvent>;
}
