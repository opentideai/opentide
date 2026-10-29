// @layer agent-loop — the OPEN per-step execution orchestrator (per-step-execution
// plan, Stage 2). Drives an approved changeset one step at a time: each pending step
// becomes its own turn against a fresh managed session (bounded context), with the
// ORCHESTRATOR — not the model — advancing step status structurally. This is what makes
// the two reported bugs dissolve: usage is recorded per step (each step is a real turn),
// and step status flips pending→in_progress→done from the loop, never from the model
// self-reporting via update_changeset_step.
//
// Decoupled from ChatOrchestrator by design: runPlan reaches nothing on the loop object
// and imports no intelligence — everything it needs (the turn runner, the changeset
// store, the injected brain, cancellation, fresh-session minting) arrives in a plain
// deps object, so it is unit-testable with a fake runTurn against a real changesets
// store. Carries no agent-facing intelligence: per-step prompt framing comes from the
// injected ChatIntelligence brain (core/chat-intelligence.ts). Must not import agent/.
import type {
  ChatIntelligence,
  StepExecutionContext,
} from "../core/chat-intelligence.ts";
import type { ChatEventHandler } from "../core/chat-contract.ts";
import type { ChangesetClient } from "./chat-backend.ts";
import {
  type Changeset,
  type ChangesetReadiness,
  checkChangesetReadiness,
} from "../verification/changesets.ts";
import { HANDOFF_MARKER, MAX_STEP_REPAIRS } from "../core/config.ts";
import { isMutationTool } from "../core/tools/dispatch.ts";
import {
  buildUserContentBlocks,
  type RunTurnOptions,
  type TurnResult,
} from "./chat.ts";

// One plan step — the durable unit the orchestrator advances and (Stage 5) checkpoints.
export type PlanStep = Changeset["plan"]["steps"][number];

// The outcome of running one gate: whether the step passed and, on failure, the
// human-readable diagnostics that seed a repair sub-turn. `diagnostics` is empty
// when passed. Injected gate executors (bound in chat.ts from the kernel-side
// runExportTypeCheck / runKernelTests) return this shape; the orchestrator never
// imports those executors — see StepLoopDeps.gates.
export type GateOutcome = { passed: boolean; diagnostics: string };

// The gates this stage knows how to run, named by their tool identity
// (core/tools/definitions.ts). Every selected gate is blocking: failures go through
// the bounded-repair loop and halt the plan if they never clear. Browser capability is
// an agent requirement, so `test_app` is a hard gate like export checks and tests.
export type GateKind =
  | "check_export_types"
  | "run_tests"
  | "test_coverage"
  | "test_app";

// Everything the step loop needs, injected so runPlan never reaches into the
// ChatOrchestrator (and never imports the closed brain). `runTurn` is bound from the
// loop; `changesets` is the backend's changeset client;
// `brain` supplies the per-step prompt; `isCancelled`/`startFreshStepSession` are the
// loop's cancellation flag and fresh-provider-session primitive.
export interface StepLoopDeps {
  runTurn(opts: RunTurnOptions): Promise<TurnResult>;
  changesets: Pick<
    ChangesetClient,
    "get" | "updateStep" | "complete" | "aggregate"
  >;
  brain: ChatIntelligence;
  onEvent?: ChatEventHandler;
  isCancelled(): boolean;
  startFreshStepSession(): Promise<void>;
  // The deterministic gate executors, injected so the loop never imports the
  // kernel-side runExportTypeCheck / runKernelTests (they live in core/tools/ and
  // the orchestrator must stay import-free of that). A plain object of named thunks
  // keyed by gate so Stage 6 adds testCoverage/testApp as new entries, not a
  // refactor. Bound in chat.ts at the runPlan call site.
  gates: StepGates;
  // Stage 5 — durable per-step checkpoint. Called once, right after a step passes its
  // gate and is marked done, to commit the project's file state as "step N: <desc>" so
  // each passing step bounds a rollback and a mid-plan restart resumes from the first
  // pending step. Injected (not imported) so the loop never reaches core/git.ts, stays
  // git-type-agnostic, and is unit-testable with a plain recorder fake. Bound in chat.ts,
  // where it is fully guarded (no project dir → no-op; NOTHING_TO_COMMIT and any other
  // git error swallowed + logged); runPlan additionally wraps the call in its own
  // try/catch so git can never break execution — a checkpoint, never a step-breaker.
  commitStep(step: PlanStep, stepIndex: number): Promise<void>;
  checkReadiness?(
    changeset: Changeset,
  ): ChangesetReadiness | Promise<ChangesetReadiness>;
  // The reviews the completion gate reads (refutation, independent criteria),
  // run once every step is settled and before readiness is checked. Best
  // effort: one that can't run leaves its readiness finding in place.
  beforeCompletion?(changeset: Changeset): Promise<void>;
}

// The injected gate executors, one thunk per gate. Shaped to extend: adding a gate
// later is a new method here + a new GateKind + a new GATE_RUNNERS entry, all
// additive.
export interface StepGates {
  checkExportTypes(): Promise<GateOutcome>;
  runTests(): Promise<GateOutcome>;
  // Coverage gate (Stage 6): fails only if an entity THIS step created is untested.
  // Receives the step's created entity keys (handler:<name> / function:<name>) so it
  // scopes "untested" to the step's own work — no pre-existing-debt trap. Passes
  // trivially when the step created no testable code (empty keys).
  checkCoverage(createdEntities: string[]): Promise<GateOutcome>;
  // Browser smoke gate (Stage 6): loads the app once (with a bounded retry) and
  // reports page errors or browser infrastructure failures as blocking diagnostics.
  checkBrowser(): Promise<GateOutcome>;
}

// Per-step inputs a gate runner may need beyond the injected executors. Computed
// once per step from the turn's toolCalls and threaded to every runner (most ignore
// it). Keeps the runner signature uniform while letting the coverage gate scope to
// the step's own creations.
export interface GateContext {
  // Entity keys (computeCoverage's "handler:<name>" / "function:<name>" format) the
  // step created — the coverage gate's scope. Empty for non-code steps.
  createdEntities: string[];
}

// Bridges each GateKind to the StepGates thunk that runs it. The one place gate
// identity meets gate execution; a new gate is a new row.
const GATE_RUNNERS: Record<
  GateKind,
  (gates: StepGates, ctx: GateContext) => Promise<GateOutcome>
> = {
  check_export_types: (gates) => gates.checkExportTypes(),
  run_tests: (gates) => gates.runTests(),
  test_coverage: (gates, ctx) => gates.checkCoverage(ctx.createdEntities),
  test_app: (gates) => gates.checkBrowser(),
};

// Tool names (core/tools/definitions.ts) whose presence in a step's toolCalls marks
// it a "code" step — one that created or changed executable handler/route/function
// code, so run_tests must gate it. Schema/template/asset mutations are deliberately
// excluded: the plan calls forcing tests on schema/browser steps noise.
const CODE_MUTATION_TOOLS: ReadonlySet<string> = new Set([
  "define_handler",
  "register_route",
  "unregister_route",
  "define_function",
]);

// Tool names whose presence marks a step a "browser" step — one that exercised the
// running app through the CDP/browser path, so the hard test_app smoke gate runs for
// it. Mirrors CODE_MUTATION_TOOLS in spirit: step-kind detection from what the turn
// actually called.
const BROWSER_STEP_TOOLS: ReadonlySet<string> = new Set([
  "test_app",
  "screenshot_app",
]);

// Maps a code-mutation tool call to the coverage entity key (computeCoverage's
// "handler:<name>" / "function:<name>" format) it created, or null when the call
// creates nothing testable. Only handlers and functions carry unit tests — routes
// inherit coverage from their handler, so an untested route surfaces as its untested
// handler — so the coverage gate scopes to these two.
const COVERAGE_ENTITY_TOOLS: Readonly<Record<string, string>> = {
  define_handler: "handler",
  define_function: "function",
};

// The coverage-entity keys a step created, from its toolCalls — the coverage gate's
// scope (only this step's own new code, never pre-existing debt). Pure and exported
// for unit tests. A tool call with no string `name` input is skipped defensively.
export function createdEntityKeys(
  toolCalls: ReadonlyArray<{ name: string; input?: unknown }>,
): string[] {
  const keys: string[] = [];
  for (const call of toolCalls) {
    const category = COVERAGE_ENTITY_TOOLS[call.name];
    if (!category) continue;
    const input = call.input as { name?: unknown } | undefined;
    if (typeof input?.name === "string" && input.name) {
      keys.push(`${category}:${input.name}`);
    }
  }
  return keys;
}

// Mutation verbs whose target never reaches the TypeScript surface of an export.
// Templates are emitted as `.html` files and as JSON.stringify'd string literals
// (core/export.ts), and assets as binary files plus a Record<string,string> path
// map — `deno check main.ts` follows TS imports only, and a string literal is
// well-typed for any content. So a step whose ONLY mutations are these cannot
// produce a type diagnostic, and paying a full project export + disk write + cold
// `deno check` subprocess for it is pure overhead. Mirrors CODE_MUTATION_TOOLS in
// spirit: gate selection from what the turn actually called.
const NON_TYPED_SURFACE_TOOLS: ReadonlySet<string> = new Set([
  "define_template",
  "delete_template",
  "upload_text_asset",
  "upload_asset",
  "delete_asset",
]);

// Whether the export type check can be skipped for this step: it mutated something,
// and every mutation it made was off the typed surface. Deliberately conservative —
// a step with NO mutations keeps the gate (it may have been a repair turn whose
// edits landed by another path), and a single typed mutation (a schema, a test, a
// handler) anywhere in the step brings the gate back for the whole step.
function skipsExportCheck(
  toolCalls: ReadonlyArray<{ name: string }>,
): boolean {
  const mutations = toolCalls.filter((call) => isMutationTool(call.name));
  return mutations.length > 0 &&
    mutations.every((call) => NON_TYPED_SURFACE_TOOLS.has(call.name));
}

// Pure, adaptive gate selection for a step given the tools its turn called. Runs
// check_export_types (fast; kills the "Fix export type check" firefighting) unless
// the step touched nothing on the typed surface; adds run_tests + test_coverage when
// the step touched handler/route/function code (a code step must both pass its tests
// and have tests for what it created); adds the test_app gate when the step exercised
// the browser. Exported for unit tests.
export function selectGates(
  toolCalls: ReadonlyArray<{ name: string }>,
): GateKind[] {
  const gates: GateKind[] = skipsExportCheck(toolCalls)
    ? []
    : ["check_export_types"];
  if (toolCalls.some((call) => CODE_MUTATION_TOOLS.has(call.name))) {
    gates.push("run_tests", "test_coverage");
  }
  if (toolCalls.some((call) => BROWSER_STEP_TOOLS.has(call.name))) {
    gates.push("test_app");
  }
  return gates;
}

// The result of running a step's selected gates in order. On the first failure it
// carries which gate failed and its diagnostics (so a repair sub-turn is seeded with
// one gate at a time — export first, since it is the fast one). `passed` means every
// selected gate cleared.
type GateRunResult =
  | { passed: true }
  | { passed: false; failedGate: GateKind; diagnostics: string };

// Runs the given gates in order, short-circuiting on the first failure. Order
// matters: check_export_types precedes run_tests precedes test_coverage, so the cheap
// export check fails fast, tests are gated before coverage, and a repair is seeded
// with one gate's diagnostics at a time.
async function runGates(
  kinds: GateKind[],
  gates: StepGates,
  ctx: GateContext,
): Promise<GateRunResult> {
  for (const kind of kinds) {
    const outcome = await GATE_RUNNERS[kind](gates, ctx);
    if (!outcome.passed) {
      return {
        passed: false,
        failedGate: kind,
        diagnostics: outcome.diagnostics,
      };
    }
  }
  return { passed: true };
}

// Steps the loop still has to execute: anything not yet finished or explicitly skipped.
// Exported so the caller that decides whether per-step execution is worth entering at
// all (chat.ts) counts pending steps by exactly this definition.
export function isPendingStep(status: PlanStep["status"]): boolean {
  return status === "pending" || status === "in_progress";
}

// The per-step checkpoint commit message, "step N: <desc>" with N 1-based (§208 of the
// plan). Message format is mechanical, so this pure exported helper centralizes it (no
// inline string assembly at the binding — no-magic-strings) and lets both the chat.ts
// binding that builds the commit and this file's tests reference one definition.
export function stepCommitMessage(step: PlanStep, stepIndex: number): string {
  return `step ${stepIndex + 1}: ${step.description}`;
}

// Extract a step's handoff block from its turn text so the next step can orient off
// it. Purely extractive — the streamed/stored assistant text is never mutated here
// (display cleanup, if any, is Stage 6). Keys on HANDOFF_MARKER: the block is
// everything from the LAST marker to end of text (a step may quote the token earlier
// while explaining; the final one opens the real block), trimmed. Returns "" when the
// marker is absent — the safe empty-fallback, since registries are authoritative and a
// missing/garbled handoff must degrade to "no orientation", never corrupt the next step.
export function parseHandoff(fullText: string): string {
  const marker = fullText.lastIndexOf(HANDOFF_MARKER);
  if (marker < 0) return "";
  return fullText.slice(marker).trim();
}

// Runs an approved plan step by step. Returns the concatenated per-step reply text
// (the callers stream real output via events; the return mirrors the single-turn
// path's fullText). Leaves the changeset resumable on cancellation or a step error:
// the interrupted step stays in_progress and the loop stops, so a later run picks up
// from the first non-done step. Completion (readiness gate → complete → aggregate) is
// mirrored from chat.ts so per-step and single-turn completion semantics match.
export async function runPlan(
  changeset: Changeset,
  deps: StepLoopDeps,
): Promise<string> {
  const {
    changesets,
    brain,
    onEvent,
    runTurn,
    isCancelled,
    startFreshStepSession,
    gates,
    commitStep,
  } = deps;

  let cs = changeset;
  const totalSteps = cs.plan.steps.length;
  const replies: string[] = [];
  // Only the immediately prior step's handoff is carried (not an accumulation):
  // registries are authoritative, so the latest orientation suffices. Empty until the
  // first step lands one, and reset to "" whenever a step emits no parseable block.
  let priorHandoff = "";

  for (let stepIndex = 0; stepIndex < cs.plan.steps.length; stepIndex++) {
    const step = cs.plan.steps[stepIndex]!;
    if (!isPendingStep(step.status)) continue;
    if (isCancelled()) break;

    // Orchestrator-driven: mark the step in progress structurally and surface it.
    cs = await changesets.updateStep(cs.id, step.id, "in_progress");
    onEvent?.({ type: "changeset_updated", changeset: cs });
    // Explicit per-step progress signal (Stage 6): the step just went in_progress,
    // so the IDE can highlight it as the ACTIVE step and attribute stats to it. A
    // mechanical loop signal — no agent-facing intelligence. Emitted whether or not
    // the step later reaches done; a halt/cancel emits no matching step_completed.
    onEvent?.({
      type: "step_started",
      stepIndex,
      totalSteps,
      stepId: step.id,
      stepDescription: step.description,
      changeset: cs,
    });

    // Fresh managed session clears the model's context between steps (agent reused).
    await startFreshStepSession();

    const ctx: StepExecutionContext = {
      changeset: cs,
      stepIndex,
      totalSteps,
      // The prior step's parsed handoff (empty on the first step or after a
      // markerless turn) — orientation only; the brain re-verifies against registries.
      priorHandoff,
    };
    const prompt = brain.stepPrompt(step, ctx);
    // activeWorkCs is deliberately null: the changeset already exists and is
    // in_progress, so dispatch still tags this step's work with it, but runTurn's own
    // step-advance heuristic and completion tail (both guarded by an internal
    // changesetId) stay dormant — the orchestrator owns advancement and completion.
    const result = await runTurn({
      content: prompt,
      contentBlocks: buildUserContentBlocks(prompt),
      onEvent,
      approvalStarted: false,
      activeWorkCs: null,
    });
    if (result.fullText.trim()) replies.push(result.fullText.trim());

    // Cancelled mid-step: leave the step in_progress (resumable) and stop cleanly.
    if (result.stopReason === "cancelled") break;
    // Stream error: halt the loop, leaving the step in_progress. Bounded repair /
    // halt-and-surface is Stage 4; here we simply stop without cascading.
    if (result.stopReason === "error") break;
    // Truncated at the model's output ceiling even after the loop's continuations:
    // the step's work is half-written, so halt here rather than gating and advancing
    // on it. Same disposition as an error — step stays in_progress and resumable.
    if (result.stopReason === "max_tokens") break;

    // ── Deterministic per-step gate + bounded repair (Stage 4/6) ──
    // Select gates from what the turn actually did, then validate. All selected gates
    // are blocking, including browser checks. `gateCtx` scopes the coverage gate to
    // the entities this step created. On failure, run up to MAX_STEP_REPAIRS repair
    // sub-turns seeded with the failing gate's diagnostics (same session as the step —
    // the model keeps the context of what it just built), re-gating after each.
    // `lastText` tracks the turn whose handoff we carry forward: the original turn, or
    // the last repair turn once one runs.
    const selected = selectGates(result.toolCalls);
    const gateCtx: GateContext = {
      createdEntities: createdEntityKeys(result.toolCalls),
    };
    let gate = await runGates(selected, gates, gateCtx);
    let lastText = result.fullText;
    // Set when a repair turn is itself cancelled/errored: unlike an exhausted gate this
    // is not a halt-with-message — it mirrors the cancelled/error paths above (stop
    // quietly, step left in_progress and resumable).
    let aborted = false;
    for (
      let attempt = 0;
      !gate.passed && attempt < MAX_STEP_REPAIRS;
      attempt++
    ) {
      if (isCancelled()) {
        aborted = true;
        break;
      }
      const repairPrompt = brain.repairPrompt(step, ctx, gate.diagnostics);
      const repair = await runTurn({
        content: repairPrompt,
        contentBlocks: buildUserContentBlocks(repairPrompt),
        onEvent,
        approvalStarted: false,
        activeWorkCs: null,
      });
      if (repair.fullText.trim()) replies.push(repair.fullText.trim());
      if (
        repair.stopReason === "cancelled" || repair.stopReason === "error" ||
        repair.stopReason === "max_tokens"
      ) {
        aborted = true;
        break;
      }
      lastText = repair.fullText;
      gate = await runGates(selected, gates, gateCtx);
    }

    // Repair turn interrupted: stop quietly, step stays in_progress (resumable).
    if (aborted) break;
    // Repairs exhausted and the step still fails its gate: halt. Leave the step
    // in_progress, surface which step/gate failed and the diagnostics, and stop the
    // loop — no cascade to later steps. completeIfReady then no-ops (this step isn't
    // done), so the changeset stays in_progress and resumable.
    if (!gate.passed) {
      onEvent?.({
        type: "system_message",
        text:
          `Step ${
            stepIndex + 1
          } of ${totalSteps} ("${step.description}") did ` +
          `not pass the ${gate.failedGate} gate after ${MAX_STEP_REPAIRS} repair ` +
          `attempts, so execution stopped here. The step is left in progress and the ` +
          `changeset is resumable once the issue is addressed.\n\n${gate.diagnostics}`,
      });
      break;
    }

    // Carry this step's handoff to the next one. Extractive only — degrades to "" when
    // the step emitted no marker, so the next step falls back to inspect-state alone.
    // `lastText` is the repair turn's text when a repair ran, else the original turn's.
    priorHandoff = parseHandoff(lastText);

    // Structural, NOT self-reported: the step is done because its turn (and gate) landed.
    cs = await changesets.updateStep(cs.id, step.id, "done");
    onEvent?.({ type: "changeset_updated", changeset: cs });
    // Explicit per-step progress signal (Stage 6): the step reached done, so the IDE
    // can clear the active-step highlight (the next step_started re-sets it) and
    // finalize per-step stats. Emitted ONLY on the mark-done path — a halted or
    // cancelled step breaks before here, so it never emits step_completed and the UI
    // never shows a settled step that did not finish. Orthogonal to the checkpoint
    // commit below: the signal fires whether or not the commit lands.
    onEvent?.({
      type: "step_completed",
      stepIndex,
      totalSteps,
      stepId: step.id,
      stepDescription: step.description,
      changeset: cs,
    });

    // ── Durable per-step checkpoint (Stage 5) ──
    // Now that the step passed its gate and is marked done, commit the project's file
    // state as "step N: <desc>". This runs ONLY on the mark-done path: a halted step
    // (repairs exhausted) breaks above before reaching here, so it is never committed and
    // the prior passing step's commit stays the last good checkpoint that bounds any
    // rollback. Resume-from-pending needs no code here — the loop already skips non-pending
    // steps, so a restart mid-plan re-enters at the first pending step and commits only the
    // remainder. Wrapped in its own try/catch so git can never break execution (§7 risk #4):
    // the binding already tolerates NOTHING_TO_COMMIT and logs real git errors, and this
    // nested guard is the final backstop against any unexpected throw. The loop stays
    // git-type-agnostic — it hands (step, stepIndex) to the injected thunk and moves on.
    try {
      await commitStep(step, stepIndex);
    } catch {
      // A checkpoint, never a step-breaker: swallow anything so a passing, done step is
      // never undone by a git failure. The step remains done and the loop advances.
    }
  }

  await completeIfReady(cs.id, deps);
  return replies.join("\n\n");
}

// Mirror of chat.ts's completion tail: once every step is done or skipped and the
// readiness gate passes, complete the changeset, aggregate its usage, and emit
// changeset_completed. Best-effort — a not-yet-ready changeset simply stays
// in_progress (resumable), matching the single-turn path's guarded completion.
async function completeIfReady(id: string, deps: StepLoopDeps): Promise<void> {
  const {
    changesets,
    onEvent,
    runTurn,
    brain,
    isCancelled,
    startFreshStepSession,
  } = deps;
  try {
    let cs = await changesets.get(id);
    if (!cs || cs.status !== "in_progress") return;
    const allSettled = cs.plan.steps.every((s) =>
      s.status === "done" || s.status === "skipped"
    );
    if (!allSettled) return;

    if (deps.beforeCompletion) {
      await deps.beforeCompletion(cs);
      cs = await changesets.get(id) ?? cs;
    }
    let readiness = await finalReadiness(cs, deps);
    if (!readiness.passed && !deps.checkReadiness) return;
    for (
      let attempt = 0;
      !readiness.passed && hasRepairableReadinessBlocker(readiness) &&
      attempt < MAX_STEP_REPAIRS;
      attempt++
    ) {
      if (isCancelled()) return;
      await startFreshStepSession();
      const prompt = brain.finalReadinessRepairPrompt(cs, readiness);
      const repair = await runTurn({
        content: prompt,
        contentBlocks: buildUserContentBlocks(prompt),
        onEvent,
        approvalStarted: false,
        activeWorkCs: null,
      });
      if (
        repair.stopReason === "cancelled" || repair.stopReason === "error" ||
        repair.stopReason === "max_tokens"
      ) {
        return;
      }
      cs = await changesets.get(id) ?? cs;
      if (cs.status !== "in_progress") return;
      readiness = await finalReadiness(cs, deps);
    }

    if (!readiness.passed) {
      onEvent?.({
        type: "system_message",
        text:
          `Final readiness did not pass after ${MAX_STEP_REPAIRS} repair attempt(s), so the changeset remains in progress.\n\n${
            readinessDiagnostics(readiness)
          }`,
      });
      return;
    }

    const completed = await changesets.complete(cs.id);
    const aggregated = await changesets.aggregate(completed.id);
    onEvent?.({ type: "changeset_completed", changeset: aggregated });
  } catch {
    // Completion is best-effort; the changeset remains in_progress and resumable.
  }
}

function finalReadiness(
  changeset: Changeset,
  deps: StepLoopDeps,
): ChangesetReadiness | Promise<ChangesetReadiness> {
  return deps.checkReadiness
    ? deps.checkReadiness(changeset)
    : checkChangesetReadiness(changeset);
}

function hasRepairableReadinessBlocker(readiness: ChangesetReadiness): boolean {
  return readiness.errors.some((issue) =>
    issue.code !== "CHANGESET_NOT_IN_PROGRESS"
  );
}

function readinessDiagnostics(readiness: ChangesetReadiness): string {
  return [...readiness.errors, ...readiness.warnings]
    .map((issue) =>
      `${issue.severity.toUpperCase()} ${issue.code}: ${issue.message}\nAction: ${issue.action}`
    )
    .join("\n\n");
}
