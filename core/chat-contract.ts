// @layer core — the chat provider contract (OpenTide §3.3 agent-provider hook).
//
// The integrated agent (kernel/chat.ts, L3) is an optional plug-in: the core
// control server talks to it only through these types, never by importing the
// agent. A composition root supplies an implementation via
// ControlServerOptions.chatFactory; when none is registered, /chat reports that
// no agent is configured. Keeping the contract in core lets both the control
// server (core) and ChatOrchestrator (agent) depend on it downward.
import type { CurrentUser } from "./auth.ts";
import type { ContextPressure } from "./context-window.ts";
import type { TurnUsage } from "./types.ts";
import type { WorkItemPayload } from "./work-items.ts";

// Non-durable per-provider-request usage progress. It mirrors TurnUsage so the UI
// can update live counters, but persisted accounting remains the final turn_usage.
export interface ModelRequestUsage extends TurnUsage {
  toolCallsCount: 0;
}

// A single streamed event emitted during a chat turn.
export interface ChatEvent {
  type:
    | "text_delta"
    | "thinking_start"
    | "thinking_end"
    | "tool_use_start"
    | "tool_use_end"
    | "message_complete"
    | "error"
    | "system_message"
    | "session_started"
    | "session_renamed"
    | "message_stored"
    | "work_item_created"
    | "model_request_usage"
    | "turn_usage"
    | "changeset_created"
    | "changeset_updated"
    | "changeset_completed"
    // Per-step execution progress (per-step-execution plan, Stage 6). Emitted by
    // the open step orchestrator as it advances an approved plan: step_started when
    // a step is marked in_progress, step_completed when it reaches done. Purely
    // mechanical loop signals (no agent-facing intelligence) so the IDE can
    // highlight the ACTIVE step and attribute per-step stats. A halted/cancelled
    // step emits step_started but never step_completed — the UI never shows a
    // settled step that did not finish.
    | "step_started"
    | "step_completed"
    // Transient context-pressure signal (context-hardening plan, Slice 2). Emitted
    // at the turn tail right after turn_usage: how full the model's context window
    // is after this turn. Purely a stream event for the IDE meter (Slice 3) — the
    // durable persisted contract stays TurnUsage/AggregatedUsage (shared/sessions.ts),
    // which this deliberately does NOT extend. The number is also persisted onto the
    // session metadata (lastContextTokens/lastContextPressure) so it survives reload.
    | "context_pressure"
    // One-shot non-blocking nudge (context-hardening plan, Slice 3). Emitted at most
    // once per session the first time a completed turn crosses CONTEXT_NUDGE_RATIO,
    // re-armed on session reset / compaction / a turn that drops back under the ratio.
    // Carries the same contextPressure payload as context_pressure (so the UI renders
    // the exact %) plus the human copy in `text`. Transient stream event only — like
    // context_pressure it does NOT extend the durable TurnUsage/AggregatedUsage shapes.
    | "context_warning"
    // Pre-turn auto-compaction notice (context-hardening plan, Slice 4). Emitted when
    // the 95% guard transparently compacts before a turn: the loop has already ended
    // the old session and switched to a fresh one carrying the summary + pins + focus.
    // Reuses sessionId/sessionName (the NEW session) so the IDE switches to it, plus
    // `text` for the inline "compacted" copy. A transient stream event only — it does
    // NOT extend the durable session/usage shapes.
    | "session_compacted";
  text?: string;
  toolName?: string;
  toolInput?: unknown;
  toolResult?: unknown;
  messageId?: number;
  role?: "user" | "assistant" | "system";
  sessionId?: string;
  sessionName?: string;
  workItem?: WorkItemPayload;
  usage?: TurnUsage;
  // Context-window occupancy after the turn (context_pressure event). occupancy sums
  // ALL three input categories (input + cacheRead + cacheCreation) — cached tokens
  // are billed cheap but still occupy the window; budget is effectiveInputBudget(model);
  // pressure = occupancy / budget (1 when the budget is non-positive, i.e. already over).
  // The diagnostics name the model/window math source without carrying prompt text,
  // message content, tool arguments, secrets, or document bodies.
  contextPressure?: ContextPressure;
  changeset?: unknown;
  // Per-step progress payload (step_started / step_completed). Mirrors the fields
  // the orchestrator already tracks in StepExecutionContext: zero-based index of
  // the step within the plan, the plan's total step count, and the step's id and
  // description so the client can pinpoint and label the active step.
  stepIndex?: number;
  totalSteps?: number;
  stepId?: string;
  stepDescription?: string;
}

export type ChatEventHandler = (event: ChatEvent) => void;

export type InProgressDetail = "compact" | "full";

export interface InProgressToolCall {
  name: string;
  input: unknown;
  result?: unknown;
}

export interface InProgressState {
  // Whole-turn compatibility fields for clients that predate segmented recovery.
  // These accumulate all assistant text/tool calls seen during the current turn.
  text: string;
  toolCalls: InProgressToolCall[];
  // Current-segment recovery fields. When present, clients should prefer these:
  // they contain only the unpersisted assistant segment since the last assistant
  // message_stored event, so reloading does not replay text already in the database.
  segmentText?: string;
  segmentToolCalls?: InProgressToolCall[];
}

// The agent-provider seam: everything the control server needs from a registered
// chat provider. ChatOrchestrator (agent) implements this; the core depends only
// on the interface.
export interface ChatRuntime {
  setOnTurnComplete(cb: () => void): void;
  initialize(): Promise<void>;
  reloadApiKey(): Promise<void>;
  reloadModel(): Promise<void>;
  getInProgressState(detail?: InProgressDetail): InProgressState | null;
  abort(): void;
  sendMessage(
    content: string,
    onEvent?: ChatEventHandler,
    attachments?: Array<{ name: string; type: string; data: string }>,
    storedContent?: string,
    changesetId?: string,
    user?: CurrentUser,
    // Structured document @-mentions to resolve into content blocks and record as
    // message/mention backlinks (document-store §7). Declared core-locally — this
    // is structurally identical to agent-loop's WireDocumentRef, but core (L1) must
    // not import from agent-loop (L2). ChatOrchestrator's WireDocumentRef[] param
    // stays assignable to this shape.
    documentRefs?: Array<{ id: string; versionHash?: string }>,
  ): Promise<string>;
  getCurrentSessionId(): string | null;
  clearCurrentSession(): void;
  clearContext(): Promise<void>;
  clearSession(user?: CurrentUser): Promise<{ newSessionId: string | null }>;
  // Compaction is in-place: the returned id is the SAME (unchanged) session, not a new
  // one. Kept as its own shape so callers don't mistake it for the resume/clear "new
  // session" contract.
  compactSession(
    summary: string,
    user?: CurrentUser,
  ): Promise<{ sessionId: string }>;
  resumeSession(
    targetSessionId: string,
    user?: CurrentUser,
  ): Promise<{ newSessionId: string }>;
  close(): Promise<void>;
}
