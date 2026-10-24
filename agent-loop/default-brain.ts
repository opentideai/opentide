// @layer agent-loop — the OPEN default chat intelligence. This is what makes OpenTide
// runnable end-to-end without the closed agent/ brain: a generic system
// prompt, a sensible model default, and a minimal approval fallback. Tide swaps in
// TunedChatIntelligence (agent/brain.ts) for the production prompt + model-backed audits;
// the composition root chooses which brain to inject (cli/assembly.ts). Both brains share
// the open composePrompt framing — they differ only in the base prompt string.
import type {
  ApprovalDecisionContext,
  ChatIntelligence,
  PromptOpts,
  StepExecutionContext,
} from "../core/chat-intelligence.ts";
import type {
  Changeset,
  ChangesetReadiness,
  ChangesetStep,
} from "../core/types.ts";
import {
  DEFAULT_MODEL_ID,
  getAgentModelForRequest,
  HANDOFF_MARKER,
} from "../core/config.ts";
import { composePrompt } from "./prompt-compose.ts";

// The open equivalent of the tuned brain's planner nudge (per-step-execution plan,
// Stage 6): keep BYO-key plans right-sized too, since each step runs as its own bounded
// turn under per-step execution. Named const so the prompt carries no magic string and
// the default brain's unit test can assert the exact phrase.
export const DEFAULT_STEP_RIGHT_SIZING_NUDGE =
  "Make each plan step a right-sized, independently testable unit — one coherent " +
  "change per step, since each step runs as its own bounded turn.";

export const DEFAULT_NATURAL_COMMUNICATION_PRINCIPLE =
  "Write to the user in natural, direct technical English. Be terse, specific, " +
  "and focused on what changed, what matters, and what remains. Avoid AI-like " +
  'lingo, canned transitions, narrative suspense, and phrases such as "here is ' +
  'the unexpected part". Use technical terms when they are precise, but prefer ' +
  "plain words over jargon.";

export const DEFAULT_NATURAL_GIT_STATE_REPORTING_PRINCIPLE =
  "Treat OpenTide's own post-commit and post-push state serialization as normal app " +
  "flow. If a commit or push causes generated/session/history files under " +
  "`.opentide/state` or other OpenTide metadata to be re-emitted, do not call that " +
  "out as a new dirty-worktree concern and do not ask for a housekeeping commit. " +
  "Only mention repository dirtiness when it includes user-requested app changes, " +
  "affects the task, or the user explicitly asks about git status.";

// A short, generic base prompt: enough to drive the kernel's tools correctly (inspect,
// build via changesets) without any of the tuned intelligence. Deliberately generic —
// specialize by injecting a tuned ChatIntelligence instead of editing this.
export const DEFAULT_SYSTEM_PROMPT =
  `You are an AI assistant that builds web applications by modifying a running Deno kernel. The application exists entirely in memory — there are no files. You build features by calling tools that create handlers, register routes, define database schemas, and manage configuration.

## Working with the kernel
- Inspect before you change: list routes, handlers, functions, and schemas to understand the current app.
- Build with the provided tools, not files — there is no filesystem.
- Every change to code, schemas, routes, or assets must go through a changeset: call \`create_changeset\` first and wait for approval before modifying anything. If an in-progress changeset exists and the user asks for extra modifying work outside its approved plan, call \`amend_changeset_plan\` and stop until the user approves again. Modification tools reject calls without an active approved changeset. ${DEFAULT_STEP_RIGHT_SIZING_NUDGE}
- Use the query builder for database access and validate inputs at route boundaries.

## Style
- Build completely: address every requirement in the user's request.
- Keep handlers logic-only — put HTML in templates and CSS/JS in assets.
- ${DEFAULT_NATURAL_COMMUNICATION_PRINCIPLE}
- ${DEFAULT_NATURAL_GIT_STATE_REPORTING_PRINCIPLE}

This is the generic OpenTide system prompt. Inject a tuned ChatIntelligence to specialize the agent.`;

// OpenTide's offline fallback stays intentionally narrow; Tide's tuned brain uses
// the model-backed approval classifier for compound natural-language messages.
const DEFAULT_APPROVALS = new Set([
  "approve",
  "approved",
  "yes",
  "proceed",
  "continue",
  "go ahead",
  "ok",
  "okay",
  "lgtm",
]);

function normalizeDefaultApproval(content: string): string {
  let text = content.trim().toLowerCase();
  while (
    text.endsWith(".") || text.endsWith("!") || text.endsWith("?")
  ) {
    text = text.slice(0, -1).trimEnd();
  }

  let normalized = "";
  let pendingSpace = false;
  for (const ch of text) {
    if (ch === " " || ch === "\n" || ch === "\r" || ch === "\t") {
      pendingSpace = normalized.length > 0;
      continue;
    }
    if (pendingSpace) normalized += " ";
    normalized += ch;
    pendingSpace = false;
  }
  return normalized;
}

// The generic handoff directive: registries are the durable truth, the handoff
// block is orientation for the next step. Tide's tuned brain carries a richer
// framing; this keeps OpenTide-open functional.
const DEFAULT_HANDOFF_INSTRUCTION =
  `When you finish this step, end your turn with a \`${HANDOFF_MARKER}\` block that lists ` +
  "the entities you created (name → signature), any decisions you made, and any " +
  "deviations from the step description. Keep it compact — it orients the next step.";

export class DefaultChatIntelligence implements ChatIntelligence {
  baseSystemPrompt(opts: PromptOpts): string {
    return composePrompt(DEFAULT_SYSTEM_PROMPT, opts);
  }

  // Delegate the DEFAULT_MODEL_ID sentinel to the agent role's catalog-driven
  // recommendation (D9) — no hardcoded id here; honor an explicit pin verbatim.
  // Propagates `undefined` when the role is unconfigured so the loop surfaces it.
  resolveModel(configured: string): string | undefined {
    return configured === DEFAULT_MODEL_ID
      ? getAgentModelForRequest()
      : configured;
  }

  isApprovalMessage(
    content: string,
    _ctx?: ApprovalDecisionContext,
  ): boolean {
    return DEFAULT_APPROVALS.has(normalizeDefaultApproval(content));
  }

  stepPrompt(step: ChangesetStep, ctx: StepExecutionContext): string {
    const header = `Implement step ${
      ctx.stepIndex + 1
    } of ${ctx.totalSteps}: ${step.description}`;
    const prior = ctx.priorHandoff?.trim()
      ? `\n\nContext from the previous step:\n${ctx.priorHandoff.trim()}`
      : "";
    const inspect =
      "\n\nBefore implementing, inspect the current app (list routes, handlers, " +
      "functions, schemas) to confirm the real names and signatures of anything " +
      "created so far — treat any summary as a hint and the registries as truth. " +
      "Implement only this step.";
    return `${header}${prior}${inspect}\n\n${DEFAULT_HANDOFF_INSTRUCTION}`;
  }

  handoffInstruction(): string {
    return DEFAULT_HANDOFF_INSTRUCTION;
  }

  repairPrompt(
    step: ChangesetStep,
    ctx: StepExecutionContext,
    diagnostics: string,
  ): string {
    const header = `Step ${
      ctx.stepIndex + 1
    } of ${ctx.totalSteps} (${step.description}) did not pass its validation check. Fix exactly what the diagnostics report — do not start new work.`;
    const failure = `\n\nDiagnostics:\n${diagnostics.trim()}`;
    const guidance =
      "\n\nInspect the current app to confirm the real state, correct the reported " +
      "problem, and change nothing beyond what the fix requires.";
    return `${header}${failure}${guidance}\n\n${DEFAULT_HANDOFF_INSTRUCTION}`;
  }

  finalReadinessRepairPrompt(
    changeset: Changeset,
    readiness: ChangesetReadiness,
  ): string {
    const issues = readiness.errors
      .map((issue) =>
        `${issue.severity.toUpperCase()} ${issue.code}: ${issue.message}\nAction: ${issue.action}`
      )
      .join("\n\n");
    return `The approved changeset "${changeset.title}" finished its steps but did not pass final readiness. Fix only the blocking readiness errors below, then run check_changeset_readiness once.\n\n${issues}`;
  }
}
