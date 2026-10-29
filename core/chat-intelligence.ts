// @layer core — the chat "brain" contract (OpenTide open-core seam).
//
// The open agentic loop (agent-loop/chat.ts, L2) is a *mechanism*: it streams turns,
// dispatches tools, and drives the changeset lifecycle — but it carries no agent-facing
// intelligence. Everything that IS the product's tuned intelligence — the base system
// prompt, the model choice, the approval decision — is supplied by a ChatIntelligence
// implementation injected at the composition root. OpenTide-open ships a generic
// DefaultChatIntelligence (agent-loop/default-brain.ts); Tide swaps in a
// TunedChatIntelligence (agent/brain.ts, closed).
//
// Keeping the contract in core lets both the L2 loop and the L3 brain depend on it
// downward — mirroring how core/chat-contract.ts's ChatRuntime is shared. It references
// only core-level shapes, so core never imports an upper layer.

import type {
  Changeset,
  ChangesetReadiness,
  ChangesetStep,
  ModelUsageRecord,
  RecordModelUsageInput,
} from "./types.ts";
import type { ReviewPacket, ReviewVerdict } from "./reviews.ts";

// The runtime inputs the loop gathers from the kernel (enabled skills, registered
// secrets, custom instructions) and hands to the brain to compose the system prompt.
// Matches the opts shape long consumed by the agent's prompt assembler.
export interface PromptOpts {
  customInstructions?: string;
  skills?: Array<{ name: string; prompt: string }>;
  secrets?: Array<{ key: string; description?: string; status: string }>;
  // Tier-2 working-set documents (docs/document-store-plan.md §5): the docs the agent
  // pinned via document_pin, injected into every turn's system prompt until unpinned.
  // Each carries the exact version hash cited so the prompt reflects a resolvable head.
  residentDocuments?: Array<{
    name: string;
    versionHash: string;
    content: string;
  }>;
}

// What the step orchestrator (agent-loop, a later stage) hands the brain so it can
// frame a single plan step as its own turn. Deliberately minimal and additive:
// core-level shapes only (the changeset being executed + a compact handoff block
// carried forward from the prior step), so core never imports an upper layer and
// the shape can grow without breaking the loop. `priorHandoff` is the previous
// step's emitted HANDOFF block (empty on the first step); `stepIndex`/`totalSteps`
// orient the step within the plan for the prompt framing.
export interface StepExecutionContext {
  // The changeset whose plan is being executed step by step.
  changeset: Changeset;
  // Zero-based index of this step within the plan's `steps` array.
  stepIndex: number;
  // Total number of steps in the plan (for "step N of M" framing).
  totalSteps: number;
  // The prior step's handoff block (entities created, decisions, deviations),
  // or empty when there is no prior step or it emitted none.
  priorHandoff?: string;
}

export interface ApprovalDecisionContext {
  changeset: Changeset;
  sessionId?: string | null;
  recordUsage?: (input: RecordModelUsageInput) => Promise<ModelUsageRecord>;
}

// What a reviewer gets besides the packet.
export interface ReviewRunContext {
  sessionId: string | null;
  changesetId: string | null;
  // Refute attempts per claim, when the caller asked for a number.
  attempts?: number;
  recordUsage?: (input: RecordModelUsageInput) => Promise<ModelUsageRecord>;
}

export type ReviewOutcome =
  | { status: "ok"; verdict: ReviewVerdict; reviewer: string }
  // No model or no key: nothing ran and nothing is owed to the caller but the
  // reason.
  | {
    status: "unavailable";
    code: string;
    message: string;
    suggestion?: string;
  }
  // The model ran and its answer was unusable. Nothing is submitted.
  | { status: "failed"; message: string };

// Runs review packets (core/reviews.ts) on the brain's own model, in a fresh
// context: refutation, the independent criteria review and audits.
export interface Reviewer {
  review(packet: ReviewPacket, ctx: ReviewRunContext): Promise<ReviewOutcome>;
}

// The injected intelligence the open loop needs from the closed (or default) brain.
export interface ChatIntelligence {
  // Runs review packets. With one, the loop offers refute_claims and run_audit
  // to its model, and runs the reviews a changeset owes before completing it.
  // Without one, the model gets request_review and submit_review like any MCP
  // client.
  reviewer?: Reviewer;
  // The base system prompt with the project sections (skills, secrets,
  // custom instructions) composed in. The loop wraps session context around this.
  baseSystemPrompt(opts: PromptOpts): string;
  // Resolve the effective request model from the user-configured value: an explicit
  // pin is returned verbatim; the DEFAULT_MODEL_ID sentinel delegates to the role's
  // catalog-driven recommendation. Returns `undefined` when the role is UNCONFIGURED
  // (keyless / empty catalog / no recommendation) — the loop must surface that state,
  // never fabricate a model (D9, docs/multi-model-harness-plan.md).
  resolveModel(configured: string): string | undefined;
  // Tuned NL decision: is this message approving the pending changeset now?
  isApprovalMessage(
    content: string,
    ctx?: ApprovalDecisionContext,
  ): boolean | Promise<boolean>;
  // The per-step user message: scopes the turn to a single plan step, carries the
  // prior step's handoff forward, and directs the agent to verify created entities
  // against the registries before implementing. Consumed by the step orchestrator
  // (per-step-execution plan, Stage 2/3); unused until then.
  stepPrompt(step: ChangesetStep, ctx: StepExecutionContext): string;
  // The trailing directive appended to a step prompt telling the agent to end its
  // turn by emitting a structured HANDOFF block (entities created, decisions,
  // deviations) that the orchestrator parses and feeds the next step.
  handoffInstruction(): string;
  // The per-step repair message: after a step's turn fails a deterministic gate
  // (check_export_types / run_tests), the orchestrator runs a bounded number of
  // repair sub-turns seeded with the gate's diagnostics. This frames one such
  // sub-turn — same step, same session — directing the agent to fix exactly the
  // reported failure and hand off again. Consumed by the step orchestrator's
  // bounded-repair loop (per-step-execution plan, Stage 4).
  repairPrompt(
    step: ChangesetStep,
    ctx: StepExecutionContext,
    diagnostics: string,
  ): string;
  finalReadinessRepairPrompt(
    changeset: Changeset,
    readiness: ChangesetReadiness,
  ): string;
}
