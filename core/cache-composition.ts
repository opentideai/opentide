// Per-request cache-composition trace (agent cost reduction, §8 — the measuring
// slice). A MEASURING INSTRUMENT, not a feature: off by default, behind the
// `cacheCompositionTrace` kernel setting / OPENTIDE_CACHE_TRACE env override. It
// changes no loop behaviour, no breakpoint placement and no TTL.
//
// Why it exists: the loop makes one provider request per tool round-trip and each
// one re-sends the whole growing context. `agent-loop/chat.ts` sums every request's
// usage into whole-turn accumulators and throws the per-request detail away, so the
// ledger can say a turn wrote 595k cache tokens but not what those tokens WERE.
// This module splits an outbound TurnRequest into the five categories §8 asks
// for and pairs each split with that request's reported usage and the cache
// breakpoint positions the request will carry.
//
// LAYER: core (L1). Pure computation + an append-only JSONL sink; no provider
// import (core must not import providers/), so `cacheBreakpointPlan` MIRRORS the
// placement rule in providers/ai-sdk-shared.ts (toSdkTools / toModelMessages).
// providers/cache-breakpoint-parity_test.ts pins the mirror against the real
// mapper output so the two can't drift silently.
//
// Token counting uses the SAME chars/4 estimate the context meter uses
// (core/context-window.ts estimateRequestTokens, TOKEN_ESTIMATE_CHARS_PER_TOKEN),
// so a trace line is directly comparable to the occupancy number the IDE shows.
// It is an ESTIMATE, not a tokenizer: see CACHE_TRACE_METHOD and the error bars
// recorded on every line (estimatedTotalTokens vs the provider's own input total).

import { join } from "node:path";
import { appendJsonLine } from "./history-store.ts";
import {
  CACHE_COMPOSITION_TRACE_FILE,
  TOKEN_ESTIMATE_CHARS_PER_TOKEN,
} from "./config.ts";
import { neutralBlockChars, neutralToolChars } from "./context-window.ts";
import type { NeutralMessage, TurnRequest } from "./model-provider.ts";
import type { TurnUsage } from "./types.ts";

// How the numbers on a trace line were produced. Written onto every record so a
// reader never has to guess which counting method a figure came from.
export const CACHE_TRACE_METHOD =
  `chars/${TOKEN_ESTIMATE_CHARS_PER_TOKEN} (core/context-window.ts estimateRequestTokens)`;

function toTokens(chars: number): number {
  return Math.ceil(chars / TOKEN_ESTIMATE_CHARS_PER_TOKEN);
}

// The five-way split §8 asks for, plus the two sub-splits that make it
// actionable. Every field is TOKENS under CACHE_TRACE_METHOD except the
// attachment counts, which are blocks — an image/document's base64 bytes are not
// tokens and are deliberately excluded from the estimate (same rule as the
// context meter), so they are reported as a count, not a size.
export interface CacheCompositionBuckets {
  // 1. static prefix — system prompt + tool schemas. Constant across a session.
  systemTokens: number;
  toolSchemaTokens: number;
  staticPrefixTokens: number;
  // 2. accumulated tool traffic, in WIRE shape (wireVisibleToolOutput applied):
  //    results the model was sent, and the call arguments that asked for them.
  toolResultTokens: number;
  toolCallInputTokens: number;
  // 3. accumulated reasoning blocks — replayed verbatim, never pruned.
  reasoningTokens: number;
  // 4. accumulated visible text — user + assistant messages.
  visibleTextTokens: number;
  // Attachments: counted, not sized (see above).
  attachmentBlocks: number;
  // The whole request under the same estimate. NOT the sum of the buckets above:
  // each bucket rounds up independently, so the sum can exceed this by up to one
  // token per bucket. Compare against this, never against the sum.
  estimatedTotalTokens: number;
}

// What changed since the previous request of the same turn. `prefixMutated` is the
// one that matters for cache accounting: an in-turn prune (§4.7) rewrites blocks
// INSIDE the already-cached prefix, which invalidates it and forces a full rewrite
// — indistinguishable from a TTL expiry in the ledger, distinguishable here.
export interface CacheCompositionDelta {
  newMessages: number;
  newBlocks: number;
  newTokens: number;
  prefixMutated: boolean;
}

// How many messages at the HEAD of the array survive a mid-conversation mutation.
// Part of the same mirror as cacheBreakpointPlan below, and pinned by the same
// parity test: the breakpoints sit on the last tool, message 0, and the LAST
// message, with nothing in between. So mutating message 1 and mutating message 30
// cost exactly the same — everything from index 1 to the end is rewritten either
// way, and only the tools + system + message-0 entry survives. §8 measured this to
// the token: after the prune at request 1 the cache read fell to 52,149, the
// session's first write.
export const CACHE_STABLE_PREFIX_MESSAGES = 1;

export type CacheBreakpointKind = "tools" | "first_message" | "last_message";

// A cache_control breakpoint the outbound request will carry, and how much of the
// request sits in front of it. `prefixTokens` is what a write at this breakpoint
// would cost if nothing ahead of it were already cached.
export interface CacheBreakpointPosition {
  kind: CacheBreakpointKind;
  // Tool index for "tools", message index for the message breakpoints.
  index: number;
  prefixTokens: number;
}

export interface CacheCompositionRecord {
  at: string;
  turnId: string;
  sessionId: string | null;
  model: string;
  provider: string | null;
  // 0-based position of this request WITHIN the turn. The whole point: the ledger
  // only ever stored the turn-level sum of these.
  requestIndex: number;
  method: string;
  messageCount: number;
  blockCount: number;
  supportsCaching: boolean;
  buckets: CacheCompositionBuckets;
  delta: CacheCompositionDelta;
  breakpoints: CacheBreakpointPosition[];
  // The provider's own numbers for this request, attached on commit. Null if the
  // request errored or was cancelled before any usage arrived.
  usage:
    | {
      inputTokens: number;
      outputTokens: number;
      cacheCreationInputTokens: number;
      cacheReadInputTokens: number;
    }
    | null;
  // Error bar: our estimate over the provider's own total input (input + cache
  // read + cache write). 1.0 = exact; below 1 = the estimate under-counts. Null
  // when no usage arrived. This is the number that tells a reader how much to
  // trust the buckets.
  estimateRatio: number | null;
}

// The per-message/per-block shape of a request, kept so the NEXT request can be
// diffed against it. Token counts per block, not the content — a trace must never
// hold a second copy of the conversation.
interface RequestShape {
  blockTokens: number[][];
}

function shapeOf(messages: NeutralMessage[]): RequestShape {
  return {
    blockTokens: messages.map((m) =>
      m.content.map(neutralBlockChars).map(toTokens)
    ),
  };
}

// Split one outbound request into the five categories. Tool results go through the
// same wireVisibleToolOutput() the provider applies (neutralBlockChars does it), so
// this measures what is SENT, not what is persisted — the persisted form still
// carries _images/_changeset and over-reads changeset verbs 3-4x.
export function composeCacheBuckets(
  request: Pick<TurnRequest, "system" | "messages" | "tools">,
): CacheCompositionBuckets {
  let toolResultChars = 0;
  let toolCallInputChars = 0;
  let reasoningChars = 0;
  let visibleTextChars = 0;
  let attachmentBlocks = 0;
  let messageChars = 0;

  for (const message of request.messages) {
    messageChars += message.role.length;
    for (const block of message.content) {
      const chars = neutralBlockChars(block);
      messageChars += chars;
      switch (block.type) {
        case "tool_result":
          toolResultChars += chars;
          break;
        case "tool_use":
          toolCallInputChars += chars;
          break;
        case "reasoning":
          reasoningChars += chars;
          break;
        case "text":
          visibleTextChars += chars;
          break;
        default:
          attachmentBlocks += 1;
      }
    }
  }

  const toolSchemaChars = request.tools.reduce(
    (sum, tool) => sum + neutralToolChars(tool),
    0,
  );
  const systemChars = request.system.length;

  return {
    systemTokens: toTokens(systemChars),
    toolSchemaTokens: toTokens(toolSchemaChars),
    staticPrefixTokens: toTokens(systemChars + toolSchemaChars),
    toolResultTokens: toTokens(toolResultChars),
    toolCallInputTokens: toTokens(toolCallInputChars),
    reasoningTokens: toTokens(reasoningChars),
    visibleTextTokens: toTokens(visibleTextChars),
    attachmentBlocks,
    estimatedTotalTokens: toTokens(
      systemChars + toolSchemaChars + messageChars,
    ),
  };
}

// Where the cache breakpoints land. MIRRORS providers/ai-sdk-shared.ts: the last
// tool carries one (toSdkTools), and the first + last message each carry one on
// their final content block (toModelMessages → applyCacheBreakpoint). A single
// message is first AND last, so it yields ONE breakpoint, not two. A non-caching
// provider emits none. Pinned against the real mappers by
// providers/cache-breakpoint-parity_test.ts.
export function cacheBreakpointPlan(
  request: Pick<TurnRequest, "system" | "messages" | "tools">,
  supportsCaching: boolean,
): CacheBreakpointPosition[] {
  if (!supportsCaching) return [];
  const positions: CacheBreakpointPosition[] = [];
  const systemChars = request.system.length;
  const toolSchemaChars = request.tools.reduce(
    (sum, tool) => sum + neutralToolChars(tool),
    0,
  );
  if (request.tools.length > 0) {
    positions.push({
      kind: "tools",
      index: request.tools.length - 1,
      // Anthropic renders tools → system → messages, so a tools breakpoint caches
      // the tool block alone.
      prefixTokens: toTokens(toolSchemaChars),
    });
  }
  if (request.messages.length === 0) return positions;

  // Cumulative chars through each message, so a breakpoint's prefix is exact.
  const cumulative: number[] = [];
  let running = systemChars + toolSchemaChars;
  for (const message of request.messages) {
    running += message.role.length;
    for (const block of message.content) running += neutralBlockChars(block);
    cumulative.push(running);
  }

  const firstIndex = 0;
  const lastIndex = request.messages.length - 1;
  positions.push({
    kind: "first_message",
    index: firstIndex,
    prefixTokens: toTokens(cumulative[firstIndex] ?? 0),
  });
  if (lastIndex !== firstIndex) {
    positions.push({
      kind: "last_message",
      index: lastIndex,
      prefixTokens: toTokens(cumulative[lastIndex] ?? 0),
    });
  }
  return positions;
}

// Diff this request's shape against the previous one in the same turn. New content
// is everything past the previous shape's end — trailing messages, plus trailing
// blocks on a message that grew. A block whose token count CHANGED inside the old
// extent is a prefix mutation (a prune), reported rather than counted as new.
export function cacheCompositionDelta(
  current: RequestShape,
  previous: RequestShape | null,
): CacheCompositionDelta {
  if (!previous) {
    return {
      newMessages: current.blockTokens.length,
      newBlocks: current.blockTokens.reduce((n, b) => n + b.length, 0),
      newTokens: current.blockTokens.reduce(
        (n, b) => n + b.reduce((s, t) => s + t, 0),
        0,
      ),
      prefixMutated: false,
    };
  }
  let newMessages = 0;
  let newBlocks = 0;
  let newTokens = 0;
  let prefixMutated = current.blockTokens.length < previous.blockTokens.length;
  current.blockTokens.forEach((blocks, messageIndex) => {
    const before = previous.blockTokens[messageIndex];
    if (!before) {
      newMessages += 1;
      newBlocks += blocks.length;
      newTokens += blocks.reduce((s, t) => s + t, 0);
      return;
    }
    if (blocks.length < before.length) prefixMutated = true;
    blocks.forEach((tokens, blockIndex) => {
      const previousTokens = before[blockIndex];
      if (previousTokens === undefined) {
        newBlocks += 1;
        newTokens += tokens;
      } else if (previousTokens !== tokens) {
        prefixMutated = true;
      }
    });
  });
  return { newMessages, newBlocks, newTokens, prefixMutated };
}

// A request measured but not yet priced — the loop holds one of these from request
// construction until that request's usage arrives, then commits it.
export interface PendingCacheTrace {
  record: Omit<CacheCompositionRecord, "usage" | "estimateRatio">;
}

// The append-only sink. One instance per ChatOrchestrator; `beginTurn` resets the
// per-turn request counter and the previous-shape baseline. Every method is
// self-guarding — a trace failure must never sink a turn.
export class CacheCompositionTracer {
  private previous: RequestShape | null = null;
  private requestIndex = 0;

  constructor(private readonly historyDir: string) {}

  private path(): string {
    return join(this.historyDir, CACHE_COMPOSITION_TRACE_FILE);
  }

  beginTurn(): void {
    this.previous = null;
    this.requestIndex = 0;
  }

  // Measure an outbound request. Advances the baseline, so call it exactly once
  // per provider request, before streaming.
  snapshot(input: {
    request: Pick<TurnRequest, "model" | "system" | "messages" | "tools">;
    turnId: string;
    sessionId: string | null;
    supportsCaching: boolean;
    at: Date;
  }): PendingCacheTrace {
    const shape = shapeOf(input.request.messages);
    const delta = cacheCompositionDelta(shape, this.previous);
    this.previous = shape;
    const record = {
      at: input.at.toISOString(),
      turnId: input.turnId,
      sessionId: input.sessionId,
      model: input.request.model,
      provider: null as string | null,
      requestIndex: this.requestIndex++,
      method: CACHE_TRACE_METHOD,
      messageCount: input.request.messages.length,
      blockCount: shape.blockTokens.reduce((n, b) => n + b.length, 0),
      supportsCaching: input.supportsCaching,
      buckets: composeCacheBuckets(input.request),
      delta,
      breakpoints: cacheBreakpointPlan(input.request, input.supportsCaching),
    };
    return { record };
  }

  // Attach the provider's reported usage for that request and append the line.
  commit(pending: PendingCacheTrace, usage: TurnUsage | null): void {
    const totalInput = usage
      ? usage.inputTokens + usage.cacheReadInputTokens +
        usage.cacheCreationInputTokens
      : 0;
    const record: CacheCompositionRecord = {
      ...pending.record,
      provider: usage?.provider ?? pending.record.provider,
      usage: usage
        ? {
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cacheCreationInputTokens: usage.cacheCreationInputTokens,
          cacheReadInputTokens: usage.cacheReadInputTokens,
        }
        : null,
      estimateRatio: usage && totalInput > 0
        ? pending.record.buckets.estimatedTotalTokens / totalInput
        : null,
    };
    try {
      appendJsonLine(this.path(), record);
    } catch {
      // A measuring instrument never breaks the thing it measures.
    }
  }
}
