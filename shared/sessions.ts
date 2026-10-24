// @layer shared — L0, the OpenTide *open* wire contract for the session + agent-
// usage surface. Type-only; imports NOTHING. Consumed by the Deno backend
// (re-exported from core/types.ts) and the IDE (`$shared` alias). Sessions and
// usage tracking are core (served regardless of whether an agent is configured),
// so these shapes are open. See docs/opentide-separation-plan.md §5/§6.

// A chat/build session. The serialized shape `/api/sessions/:id` and
// `/api/sessions/current` return. ownerUserId/visibility are the multi-user authz
// fields (defaulted server-side); focus/metadata are per-session server state.
export interface Session {
  id: string;
  name: string;
  startedAt: string;
  endedAt: string | null;
  summary: string | null;
  focus: string | null;
  metadata: string | null;
  archived: boolean;
  ownerUserId?: string;
  visibility?: "private" | "project";
}

// The list shape `/api/sessions` serves — a Session plus its last-activity
// timestamp (used to sort the session list).
export interface SessionWithLastMessage extends Session {
  lastMessageAt: string | null;
  verification?: SessionVerificationSummary;
}

export interface SessionVerificationSummary {
  status: "verified" | "needs_verification" | "needs_attention" | null;
  label: string;
  changesetId?: string;
}

// Per-turn agent usage/cost, as recorded and served (e.g. attached to messages
// by `/api/sessions/:id/messages` and to turn groups by `/api/changelog/turns`).
export interface TurnUsage {
  turnId: string;
  sessionId: string;
  model: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  // Uncached input tokens only. Cache write/read tokens are reported separately
  // below and may be added back only for current-window occupancy.
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  toolCallsCount: number;
  pricingStatus?: "priced" | "unpriced" | "estimated_legacy";
  provider?: string;
  costUsd: number;
}

// Usage rolled up across a session or the whole project
// (`/api/sessions/:id/context`, project-usage endpoints).
export interface AggregatedUsage {
  turns: number;
  totalDurationMs: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheCreationInputTokens: number;
  totalCacheReadInputTokens: number;
  totalToolCalls: number;
  totalCostUsd: number;
  unpricedCalls: number;
  unpricedInputTokens: number;
  unpricedOutputTokens: number;
}
