import { assert, assertEquals } from "@std/assert";
import {
  createdEntityKeys,
  type GateOutcome,
  parseHandoff,
  type PlanStep,
  runPlan,
  selectGates,
  stepCommitMessage,
  type StepGates,
  type StepLoopDeps,
} from "./step-orchestrator.ts";
import { inProcessChangesetClient } from "./chat-backend.ts";
import type { RunTurnOptions, TurnResult, TurnStopReason } from "./chat.ts";
import type { ChatEvent } from "../core/chat-contract.ts";
import type { ChatIntelligence } from "../core/chat-intelligence.ts";
import type { ChangesetPlan, TurnUsage } from "../core/types.ts";
import { Database } from "../core/db.ts";
import { Kernel } from "../core/registries.ts";
import { testStoreComposition } from "../verification/test-stores.ts";
import { checkChangesetReadiness } from "../verification/changesets.ts";

// The stub brain frames each step as just its description, so a recorded prompt
// identifies which step ran (mirrors the chat_test.ts inert brain).
const stubBrain: ChatIntelligence = {
  baseSystemPrompt: () => "test system prompt",
  resolveModel: (configured) => configured,
  isApprovalMessage: () => false,
  stepPrompt: (step) => step.description,
  handoffInstruction: () => "HANDOFF:",
  // Embeds the diagnostics so a recorded repair prompt is checkable end-to-end
  // (the diagnostics the gate produced actually reached the repair sub-turn).
  repairPrompt: (step, _ctx, diagnostics) =>
    `repair ${step.description}: ${diagnostics}`,
  finalReadinessRepairPrompt: (_changeset, readiness) =>
    `final repair: ${readiness.summary}`,
};

// A full set of gate executors that always pass — the default so the existing Stage
// 2/3 assertions hold unchanged (no gate ever fires a repair).
function passingGates(): StepGates {
  return {
    checkExportTypes: () => Promise.resolve({ passed: true, diagnostics: "" }),
    runTests: () => Promise.resolve({ passed: true, diagnostics: "" }),
    checkCoverage: () => Promise.resolve({ passed: true, diagnostics: "" }),
    checkBrowser: () => Promise.resolve({ passed: true, diagnostics: "" }),
  };
}

// A full StepGates with only the thunks a test cares about overridden — the rest
// default to passing. Keeps each test's gate wiring to the one or two gates it
// exercises without re-listing the others.
function gatesWith(over: Partial<StepGates>): StepGates {
  return { ...passingGates(), ...over };
}

// A single gate thunk whose pass/fail is driven by call count, so a test can make a
// gate fail the first N times then pass (repair-then-recover) or always fail (halt).
// Records how many times it ran for assertions.
function scriptedGate(
  passOnCall: (call: number) => boolean,
  diagnostics: string,
) {
  let calls = 0;
  const thunk = (): Promise<GateOutcome> => {
    const passed = passOnCall(calls++);
    return Promise.resolve({ passed, diagnostics: passed ? "" : diagnostics });
  };
  return {
    thunk,
    get calls() {
      return calls;
    },
  };
}

// A three-step plan carrying the acceptance-criteria + verification-plan a changeset
// needs to be creatable; steps start pending.
function plan(stepCount: number): ChangesetPlan {
  return {
    summary: "Build the feature",
    steps: Array.from({ length: stepCount }, (_, i) => ({
      id: `s${i + 1}`,
      description: `Step ${i + 1}`,
      status: "pending" as const,
    })),
    acceptanceCriteria: [{
      id: "claim_tests",
      text: "The feature behavior is implemented.",
      source: "agent",
      priority: "must",
    }],
    verificationPlan: [{
      id: "check_tests",
      claimIds: ["claim_tests"],
      kind: "unit",
      description: "Run the targeted changeset test.",
    }],
  } as ChangesetPlan;
}

function turnUsage(turnId: string): TurnUsage {
  return {
    turnId,
    sessionId: "session_test",
    model: "test-model",
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:00:01.000Z",
    durationMs: 1000,
    inputTokens: 100,
    outputTokens: 50,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    toolCallsCount: 0,
    costUsd: 0.01,
  };
}

// A fake runTurn standing in for the real streaming runner: it records each call,
// emits a turn_usage per invocation exactly as the real runTurn does (so per-step
// usage is observable without hitting the managed API), and returns a chosen stop
// reason. No managed-API calls, no tool dispatch.
function fakeRunner(opts?: {
  stopReasonFor?: (call: number) => TurnStopReason;
  fullTextFor?: (call: number, content: string) => string;
  toolCallsFor?: (call: number) => TurnResult["toolCalls"];
}) {
  const prompts: string[] = [];
  const usageEvents: TurnUsage[] = [];
  let calls = 0;
  const runTurn = (o: RunTurnOptions): Promise<TurnResult> => {
    const call = calls++;
    prompts.push(o.content);
    const usage = turnUsage(`turn_${call}`);
    o.onEvent?.({ type: "turn_usage", usage });
    usageEvents.push(usage);
    const stopReason = opts?.stopReasonFor?.(call) ?? "end_turn";
    return Promise.resolve({
      turnId: `turn_${call}`,
      stopReason,
      fullText: opts?.fullTextFor?.(call, o.content) ?? `did ${o.content}`,
      toolCalls: opts?.toolCallsFor?.(call) ?? [],
      usage,
    });
  };
  return {
    runTurn,
    prompts,
    usageEvents,
    // Recorded repair sub-turns: every prompt the stub brain framed with "repair ".
    get repairPrompts() {
      return prompts.filter((p) => p.startsWith("repair "));
    },
    get finalRepairPrompts() {
      return prompts.filter((p) => p.startsWith("final repair: "));
    },
    get calls() {
      return calls;
    },
  };
}

// Builds a real PGlite-backed changeset already approved and in progress, so runPlan
// drives it exactly as the wiring hands it an activeWorkCs.
async function inProgressChangeset(kernel: Kernel, stepCount: number) {
  const cs = await kernel.changesets.create({
    title: "Feature",
    sessionId: "session_test",
    plan: plan(stepCount),
  });
  await kernel.changesets.approve(cs.id, 1);
  return await kernel.changesets.startWork(cs.id);
}

function baseDeps(
  kernel: Kernel,
  runner: ReturnType<typeof fakeRunner>,
  over: Partial<StepLoopDeps> = {},
): StepLoopDeps {
  let freshSessions = 0;
  const deps: StepLoopDeps & { freshSessions: () => number } = {
    runTurn: runner.runTurn,
    changesets: inProcessChangesetClient(kernel),
    brain: stubBrain,
    isCancelled: () => false,
    startFreshStepSession: () => {
      freshSessions++;
      return Promise.resolve();
    },
    gates: passingGates(),
    // A default no-op checkpoint so the Stage 2/3/4 tests need not know about git; the
    // Stage 5 tests inject a recording commitStep to assert per-step checkpoint behavior.
    commitStep: () => Promise.resolve(),
    freshSessions: () => freshSessions,
    ...over,
  };
  return deps;
}

// Records every (stepIndex, message) the loop asks to checkpoint, so a test can assert
// one commit per passing step in order — the orchestrator-side analogue of the real
// git binding, without any kernel/git/filesystem. `throwOnCall`, when set, makes the
// thunk reject to prove the loop's nested guard swallows a commit failure.
function recordingCommitStep(throwOnCall?: (call: number) => boolean) {
  const commits: { stepIndex: number; message: string }[] = [];
  let calls = 0;
  const commitStep = (
    step: PlanStep,
    stepIndex: number,
  ): Promise<void> => {
    const call = calls++;
    commits.push({ stepIndex, message: stepCommitMessage(step, stepIndex) });
    if (throwOnCall?.(call)) {
      return Promise.reject(new Error("git exploded"));
    }
    return Promise.resolve();
  };
  return { commitStep, commits };
}

Deno.test("runPlan advances each step pending→in_progress→done structurally, one turn per step in order", async () => {
  const db = await Database.create({ driver: "pglite" });
  const kernel = new Kernel(db, { composition: testStoreComposition() });
  try {
    const cs = await inProgressChangeset(kernel, 3);
    const runner = fakeRunner();
    const events: ChatEvent[] = [];
    let freshSessions = 0;
    const deps = baseDeps(kernel, runner, {
      onEvent: (e) => events.push(e),
      startFreshStepSession: () => {
        freshSessions++;
        return Promise.resolve();
      },
    });

    await runPlan(cs, deps);

    // One turn per step, in plan order (stub prompt === step description).
    assertEquals(runner.calls, 3);
    assertEquals(runner.prompts, ["Step 1", "Step 2", "Step 3"]);
    // A fresh session was minted per step.
    assertEquals(freshSessions, 3);

    // Every step is done structurally — the fake never called update_changeset_step.
    const final = await kernel.changesets.get(cs.id);
    assertEquals(final!.plan.steps.map((s) => s.status), [
      "done",
      "done",
      "done",
    ]);

    // Each step surfaced an in_progress snapshot before its done snapshot.
    for (const stepId of ["s1", "s2", "s3"]) {
      const statuses = events
        .filter((e) => e.type === "changeset_updated")
        .map((e) =>
          (e.changeset as typeof final)!.plan.steps.find((s) =>
            s.id === stepId
          )!
            .status
        );
      const firstInProgress = statuses.indexOf("in_progress");
      const firstDone = statuses.indexOf("done");
      assert(firstInProgress >= 0, `${stepId} never went in_progress`);
      assert(firstDone > firstInProgress, `${stepId} done before in_progress`);
    }

    // Bug #1: usage is recorded per step (one turn_usage each), not once per plan.
    const usageEvents = events.filter((e) => e.type === "turn_usage");
    assertEquals(usageEvents.length, 3);
  } finally {
    await db.close();
  }
});

Deno.test("runPlan halts cleanly when cancelled between steps, leaving the changeset resumable", async () => {
  const db = await Database.create({ driver: "pglite" });
  const kernel = new Kernel(db, { composition: testStoreComposition() });
  try {
    const cs = await inProgressChangeset(kernel, 3);
    const runner = fakeRunner();
    // Cancel once the first step's turn has run.
    const deps = baseDeps(kernel, runner, {
      isCancelled: () => runner.calls >= 1,
    });

    await runPlan(cs, deps);

    // Only the first step ran; the rest are untouched and pending → resumable.
    assertEquals(runner.calls, 1);
    const final = await kernel.changesets.get(cs.id);
    assertEquals(final!.plan.steps.map((s) => s.status), [
      "done",
      "pending",
      "pending",
    ]);
    assertEquals(final!.status, "in_progress");
  } finally {
    await db.close();
  }
});

Deno.test("runPlan leaves the interrupted step in_progress when a step turn is cancelled", async () => {
  const db = await Database.create({ driver: "pglite" });
  const kernel = new Kernel(db, { composition: testStoreComposition() });
  try {
    const cs = await inProgressChangeset(kernel, 3);
    const runner = fakeRunner({
      stopReasonFor: (call) => (call === 0 ? "cancelled" : "end_turn"),
    });
    await runPlan(cs, baseDeps(kernel, runner));

    // The cancelled step stays in_progress (not marked done); the loop stopped.
    assertEquals(runner.calls, 1);
    const final = await kernel.changesets.get(cs.id);
    assertEquals(final!.plan.steps.map((s) => s.status), [
      "in_progress",
      "pending",
      "pending",
    ]);
    assertEquals(final!.status, "in_progress");
  } finally {
    await db.close();
  }
});

Deno.test("runPlan halts on a step error without cascading, leaving the changeset resumable", async () => {
  const db = await Database.create({ driver: "pglite" });
  const kernel = new Kernel(db, { composition: testStoreComposition() });
  try {
    const cs = await inProgressChangeset(kernel, 3);
    const runner = fakeRunner({
      stopReasonFor: (call) => (call === 1 ? "error" : "end_turn"),
    });
    await runPlan(cs, baseDeps(kernel, runner));

    // Step 1 done, step 2 halted in_progress, step 3 never started.
    assertEquals(runner.calls, 2);
    const final = await kernel.changesets.get(cs.id);
    assertEquals(final!.plan.steps.map((s) => s.status), [
      "done",
      "in_progress",
      "pending",
    ]);
    assertEquals(final!.status, "in_progress");
  } finally {
    await db.close();
  }
});

Deno.test("runPlan completes the changeset once every step is done and readiness passes", async () => {
  const db = await Database.create({ driver: "pglite" });
  const kernel = new Kernel(db, { composition: testStoreComposition() });
  try {
    const cs = await inProgressChangeset(kernel, 2);
    // A passing verification run so the readiness gate clears after the last step.
    await kernel.changesets.recordVerificationRun(cs.id, {
      id: "vr_tests",
      status: "passed",
      summary: "Verification passed.",
      evidence: [{
        id: "ev_tests",
        kind: "test_result",
        summary: "Tests passed.",
        status: "passed",
        createdAt: "2026-01-01T00:00:00.000Z",
      }],
      claimResults: [{
        claimId: "claim_tests",
        status: "passed",
        evidenceIds: ["ev_tests"],
      }],
      residualRisks: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:00:00.000Z",
    });

    const runner = fakeRunner();
    const events: ChatEvent[] = [];
    await runPlan(
      cs,
      baseDeps(kernel, runner, { onEvent: (e) => events.push(e) }),
    );

    const final = await kernel.changesets.get(cs.id);
    assertEquals(final!.status, "completed");
    const completed = events.filter((e) => e.type === "changeset_completed");
    assertEquals(completed.length, 1);
  } finally {
    await db.close();
  }
});

Deno.test("runPlan runs the owed reviews once every step is settled, before readiness", async () => {
  const db = await Database.create({ driver: "pglite" });
  const kernel = new Kernel(db, { composition: testStoreComposition() });
  try {
    const cs = await inProgressChangeset(kernel, 2);
    const runner = fakeRunner();
    const order: string[] = [];
    await runPlan(
      cs,
      baseDeps(kernel, runner, {
        beforeCompletion: (changeset) => {
          order.push(
            `reviews:${
              changeset.plan.steps.every((s) => s.status === "done")
                ? "settled"
                : "unsettled"
            }`,
          );
          return Promise.resolve();
        },
        checkReadiness: (changeset) => {
          order.push("readiness");
          return checkChangesetReadiness(changeset);
        },
      }),
    );
    assertEquals(order.slice(0, 2), ["reviews:settled", "readiness"]);
    assertEquals(order.filter((o) => o.startsWith("reviews")).length, 1);
  } finally {
    await db.close();
  }
});

Deno.test("runPlan attempts final readiness repair before leaving a completed plan open", async () => {
  const db = await Database.create({ driver: "pglite" });
  const kernel = new Kernel(db, { composition: testStoreComposition() });
  try {
    const cs = await inProgressChangeset(kernel, 1);
    const runner = fakeRunner();
    const deps = baseDeps(kernel, runner, {
      runTurn: async (o) => {
        const result = await runner.runTurn(o);
        if (o.content.startsWith("final repair: ")) {
          await kernel.changesets.recordVerificationRun(cs.id, {
            id: "vr_final_repair",
            status: "passed",
            summary: "Verification passed after final repair.",
            evidence: [{
              id: "ev_final_repair",
              kind: "test_result",
              summary: "Tests passed.",
              status: "passed",
              createdAt: "2026-01-01T00:00:00.000Z",
            }],
            claimResults: [{
              claimId: "claim_tests",
              status: "passed",
              evidenceIds: ["ev_final_repair"],
            }],
            residualRisks: [],
            createdAt: "2026-01-01T00:00:00.000Z",
            completedAt: "2026-01-01T00:00:00.000Z",
          });
        }
        return result;
      },
      checkReadiness: (changeset) => checkChangesetReadiness(changeset),
    });

    await runPlan(cs, deps);

    const final = await kernel.changesets.get(cs.id);
    assertEquals(runner.finalRepairPrompts.length, 1);
    assertEquals(final!.status, "completed");
  } finally {
    await db.close();
  }
});

// A brain that records the priorHandoff it was handed on each stepPrompt call, so the
// test can assert step N+1 received step N's handoff (the Stage-3 analogue of "step 3
// uses the entity named in step 1" without a live model).
function recordingBrain(): {
  brain: ChatIntelligence;
  priorHandoffs: (string | undefined)[];
} {
  const priorHandoffs: (string | undefined)[] = [];
  const brain: ChatIntelligence = {
    ...stubBrain,
    stepPrompt: (step, ctx) => {
      priorHandoffs.push(ctx.priorHandoff);
      return step.description;
    },
  };
  return { brain, priorHandoffs };
}

Deno.test("runPlan threads each step's emitted handoff into the next step's prompt context", async () => {
  const db = await Database.create({ driver: "pglite" });
  const kernel = new Kernel(db, { composition: testStoreComposition() });
  try {
    const cs = await inProgressChangeset(kernel, 3);
    // Each step's turn ends with a distinct HANDOFF block naming a step-specific entity.
    const runner = fakeRunner({
      fullTextFor: (call) =>
        `Implemented it.\n\nHANDOFF: created entity_${call} → sig_${call}`,
    });
    const { brain, priorHandoffs } = recordingBrain();
    await runPlan(cs, baseDeps(kernel, runner, { brain }));

    // Step 1 has no prior handoff; step 2 receives step 1's block; step 3 receives step 2's.
    assertEquals(priorHandoffs.length, 3);
    assertEquals(priorHandoffs[0], "");
    assertEquals(priorHandoffs[1], "HANDOFF: created entity_0 → sig_0");
    assertEquals(priorHandoffs[2], "HANDOFF: created entity_1 → sig_1");
  } finally {
    await db.close();
  }
});

Deno.test("runPlan degrades to an empty handoff when a step emits no marker", async () => {
  const db = await Database.create({ driver: "pglite" });
  const kernel = new Kernel(db, { composition: testStoreComposition() });
  try {
    const cs = await inProgressChangeset(kernel, 3);
    // Step 1 emits a handoff; step 2 emits none (no marker) → step 3 must get "",
    // never the stale step-1 block and never undefined-driven garbage.
    const runner = fakeRunner({
      fullTextFor: (call) =>
        call === 0
          ? "Done.\n\nHANDOFF: created entity_0 → sig_0"
          : "Done, but I forgot to hand off.",
    });
    const { brain, priorHandoffs } = recordingBrain();
    await runPlan(cs, baseDeps(kernel, runner, { brain }));

    assertEquals(priorHandoffs[0], "");
    assertEquals(priorHandoffs[1], "HANDOFF: created entity_0 → sig_0");
    assertEquals(priorHandoffs[2], "");
  } finally {
    await db.close();
  }
});

Deno.test("selectGates adds run_tests + test_coverage for a code step", () => {
  // A step that registered a handler + route is a code step → export, tests, coverage.
  assertEquals(
    selectGates([{ name: "define_handler" }, { name: "register_route" }]),
    ["check_export_types", "run_tests", "test_coverage"],
  );
  // A single function definition still counts as code.
  assertEquals(selectGates([{ name: "define_function" }]), [
    "check_export_types",
    "run_tests",
    "test_coverage",
  ]);
});

Deno.test("selectGates runs only check_export_types for a no-op or schema-only step", () => {
  // No tool calls at all → export check only.
  assertEquals(selectGates([]), ["check_export_types"]);
  // Schema/template mutations are deliberately not code steps (tests would be noise).
  assertEquals(
    selectGates([{ name: "define_schema" }, { name: "define_template" }]),
    ["check_export_types"],
  );
});

Deno.test("selectGates adds the hard test_app gate for a browser step", () => {
  // A step that drove the browser -> export check plus the browser gate.
  assertEquals(selectGates([{ name: "test_app" }]), [
    "check_export_types",
    "test_app",
  ]);
  assertEquals(selectGates([{ name: "screenshot_app" }]), [
    "check_export_types",
    "test_app",
  ]);
  // A code step that also drove the browser gets every applicable gate, in order.
  assertEquals(
    selectGates([{ name: "define_handler" }, { name: "test_app" }]),
    ["check_export_types", "run_tests", "test_coverage", "test_app"],
  );
});

Deno.test("selectGates drops check_export_types for a non-typed-surface-only step", () => {
  // Templates and assets never reach the TS surface of an export, so a step that
  // only touched them cannot produce a type diagnostic — no full export + deno check.
  assertEquals(selectGates([{ name: "define_template" }]), []);
  assertEquals(
    selectGates([{ name: "upload_text_asset" }, { name: "delete_asset" }]),
    [],
  );
  // A UI step that also screenshotted still gets the browser gate, just not the
  // export check.
  assertEquals(
    selectGates([{ name: "define_template" }, { name: "screenshot_app" }]),
    ["test_app"],
  );
  // Read-only calls alongside a template write do not bring the gate back.
  assertEquals(
    selectGates([{ name: "list_templates" }, { name: "define_template" }]),
    [],
  );
});

Deno.test("selectGates keeps check_export_types when any typed mutation is present", () => {
  // A single typed mutation anywhere in the step restores the gate for the step.
  assertEquals(
    selectGates([{ name: "define_template" }, { name: "define_schema" }]),
    ["check_export_types"],
  );
  // Tests are TypeScript, so define_test is typed surface.
  assertEquals(
    selectGates([{ name: "define_template" }, { name: "define_test" }]),
    ["check_export_types"],
  );
  // A handler alongside a template is still a code step, gate and all.
  assertEquals(
    selectGates([{ name: "upload_text_asset" }, { name: "define_handler" }]),
    ["check_export_types", "run_tests", "test_coverage"],
  );
  // A step that mutated nothing keeps the gate (conservative by design).
  assertEquals(selectGates([{ name: "screenshot_app" }]), [
    "check_export_types",
    "test_app",
  ]);
});

Deno.test("createdEntityKeys maps handler/function creations to coverage keys, ignoring the rest", () => {
  assertEquals(
    createdEntityKeys([
      { name: "define_handler", input: { name: "createUser" } },
      { name: "define_function", input: { name: "hashPassword" } },
      { name: "register_route", input: { method: "POST", path: "/users" } },
      { name: "define_schema", input: { name: "users" } },
    ]),
    ["handler:createUser", "function:hashPassword"],
  );
  // A creation tool with no usable name input is skipped, not crashed on.
  assertEquals(createdEntityKeys([{ name: "define_handler", input: {} }]), []);
  assertEquals(createdEntityKeys([]), []);
});

Deno.test("runPlan runs a bounded repair sub-turn and recovers when the gate then passes", async () => {
  const db = await Database.create({ driver: "pglite" });
  const kernel = new Kernel(db, { composition: testStoreComposition() });
  try {
    const cs = await inProgressChangeset(kernel, 2);
    const runner = fakeRunner();
    // The export gate fails the first time it runs (step 1's turn), passes thereafter.
    const gate = scriptedGate((call) => call > 0, "TS2304 name not found");
    const events: ChatEvent[] = [];
    await runPlan(
      cs,
      baseDeps(kernel, runner, {
        onEvent: (e) => events.push(e),
        gates: gatesWith({ checkExportTypes: gate.thunk }),
      }),
    );

    // Exactly one repair sub-turn ran, and its prompt carried the gate diagnostics.
    assertEquals(runner.repairPrompts.length, 1);
    assert(runner.repairPrompts[0]!.includes("TS2304 name not found"));
    // The gate ran twice for step 1 (fail → repair → pass), once for step 2.
    assertEquals(gate.calls, 3);

    // Both steps still end done and the loop continued past the repaired step.
    const final = await kernel.changesets.get(cs.id);
    assertEquals(final!.plan.steps.map((s) => s.status), ["done", "done"]);
    // No halt was surfaced.
    assertEquals(events.filter((e) => e.type === "system_message").length, 0);
  } finally {
    await db.close();
  }
});

Deno.test("runPlan halts cleanly after exhausting repairs on a persistently failing gate", async () => {
  const db = await Database.create({ driver: "pglite" });
  const kernel = new Kernel(db, { composition: testStoreComposition() });
  try {
    const cs = await inProgressChangeset(kernel, 3);
    const runner = fakeRunner();
    // The export gate never passes → step 1 can never clear.
    const gate = scriptedGate(() => false, "persistent type error");
    const events: ChatEvent[] = [];
    await runPlan(
      cs,
      baseDeps(kernel, runner, {
        onEvent: (e) => events.push(e),
        gates: gatesWith({ checkExportTypes: gate.thunk }),
      }),
    );

    // Exactly MAX_STEP_REPAIRS (2) repair sub-turns ran, then the loop halted.
    assertEquals(runner.repairPrompts.length, 2);
    // Step 1's initial turn + 2 repair turns = 3 runTurn calls; step 2 never started.
    assertEquals(runner.calls, 3);

    // The failing step is left in_progress (not done); later steps never ran.
    const final = await kernel.changesets.get(cs.id);
    assertEquals(final!.plan.steps.map((s) => s.status), [
      "in_progress",
      "pending",
      "pending",
    ]);
    // The changeset stays in_progress and resumable (completeIfReady no-oped).
    assertEquals(final!.status, "in_progress");

    // A single system_message surfaced the halt, naming the gate and diagnostics.
    const halts = events.filter((e) => e.type === "system_message");
    assertEquals(halts.length, 1);
    const text = (halts[0] as { text: string }).text;
    assert(text.includes("check_export_types"));
    assert(text.includes("persistent type error"));
  } finally {
    await db.close();
  }
});

Deno.test("runPlan runs the run_tests gate for a code step and fires no repair when it passes", async () => {
  const db = await Database.create({ driver: "pglite" });
  const kernel = new Kernel(db, { composition: testStoreComposition() });
  try {
    const cs = await inProgressChangeset(kernel, 1);
    // The step's turn touches a handler → selectGates adds run_tests.
    const runner = fakeRunner({
      toolCallsFor: () => [{ name: "define_handler", input: {} }],
    });
    let testGateRuns = 0;
    await runPlan(
      cs,
      baseDeps(kernel, runner, {
        gates: gatesWith({
          runTests: () => {
            testGateRuns++;
            return Promise.resolve({ passed: true, diagnostics: "" });
          },
        }),
      }),
    );

    // The tests gate ran (code step), no repair fired, the step completed.
    assertEquals(testGateRuns, 1);
    assertEquals(runner.repairPrompts.length, 0);
    const final = await kernel.changesets.get(cs.id);
    assertEquals(final!.plan.steps.map((s) => s.status), ["done"]);
  } finally {
    await db.close();
  }
});

Deno.test("runPlan checkpoints exactly one commit per passing step, in order, with 1-based step messages", async () => {
  const db = await Database.create({ driver: "pglite" });
  const kernel = new Kernel(db, { composition: testStoreComposition() });
  try {
    const cs = await inProgressChangeset(kernel, 3);
    const runner = fakeRunner();
    const { commitStep, commits } = recordingCommitStep();
    await runPlan(cs, baseDeps(kernel, runner, { commitStep }));

    // One checkpoint per step, in plan order, with N 1-based and the step description.
    assertEquals(commits, [
      { stepIndex: 0, message: "step 1: Step 1" },
      { stepIndex: 1, message: "step 2: Step 2" },
      { stepIndex: 2, message: "step 3: Step 3" },
    ]);
  } finally {
    await db.close();
  }
});

Deno.test("runPlan does not checkpoint a halted step or any step after it", async () => {
  const db = await Database.create({ driver: "pglite" });
  const kernel = new Kernel(db, { composition: testStoreComposition() });
  try {
    const cs = await inProgressChangeset(kernel, 3);
    const runner = fakeRunner();
    // Step 1's single export-gate call passes (call 0); every later call — step 2's
    // gate + its two repairs — fails, so step 2 halts after exhausting repairs and step 3
    // never runs. Only step 1 reached the mark-done + commit path.
    const gate = scriptedGate((call) => call === 0, "persistent error");
    const { commitStep, commits } = recordingCommitStep();
    await runPlan(
      cs,
      baseDeps(kernel, runner, {
        commitStep,
        gates: gatesWith({ checkExportTypes: gate.thunk }),
      }),
    );

    // Only step 1 produced a checkpoint; the halted step 2 (left in_progress) and the
    // never-run step 3 did not — the step-1 commit is the last good bounding checkpoint.
    assertEquals(commits, [{ stepIndex: 0, message: "step 1: Step 1" }]);
    const final = await kernel.changesets.get(cs.id);
    assertEquals(final!.plan.steps.map((s) => s.status), [
      "done",
      "in_progress",
      "pending",
    ]);
  } finally {
    await db.close();
  }
});

Deno.test("runPlan keeps advancing when a checkpoint commit throws — the step stays done", async () => {
  const db = await Database.create({ driver: "pglite" });
  const kernel = new Kernel(db, { composition: testStoreComposition() });
  try {
    const cs = await inProgressChangeset(kernel, 3);
    const runner = fakeRunner();
    // Every commit rejects — proves the loop's nested guard swallows a git failure so a
    // passing, done step is never undone and the plan still completes all steps.
    const { commitStep, commits } = recordingCommitStep(() => true);
    await runPlan(cs, baseDeps(kernel, runner, { commitStep }));

    // The loop attempted a checkpoint for each step and completed the whole plan despite
    // every commit throwing.
    assertEquals(commits.length, 3);
    assertEquals(runner.calls, 3);
    const final = await kernel.changesets.get(cs.id);
    assertEquals(final!.plan.steps.map((s) => s.status), [
      "done",
      "done",
      "done",
    ]);
  } finally {
    await db.close();
  }
});

Deno.test("runPlan resumes from the first pending step, checkpointing only the remainder", async () => {
  const db = await Database.create({ driver: "pglite" });
  const kernel = new Kernel(db, { composition: testStoreComposition() });
  try {
    const cs = await inProgressChangeset(kernel, 3);
    // Seed a partially-done plan: step 1 is already done (as a prior run would have left
    // it). runPlan must skip it and pick up at step 2 — resume falls out of the existing
    // isPendingStep skip, not new code.
    await kernel.changesets.updateStep(cs.id, "s1", "done");
    const resumed = await kernel.changesets.get(cs.id);

    const runner = fakeRunner();
    const { commitStep, commits } = recordingCommitStep();
    await runPlan(resumed!, baseDeps(kernel, runner, { commitStep }));

    // Only steps 2 and 3 ran and were checkpointed; step 1 was neither re-run nor
    // re-committed. The messages carry the true 1-based indices (2 and 3).
    assertEquals(runner.prompts, ["Step 2", "Step 3"]);
    assertEquals(commits, [
      { stepIndex: 1, message: "step 2: Step 2" },
      { stepIndex: 2, message: "step 3: Step 3" },
    ]);
    const final = await kernel.changesets.get(cs.id);
    assertEquals(final!.plan.steps.map((s) => s.status), [
      "done",
      "done",
      "done",
    ]);
  } finally {
    await db.close();
  }
});

Deno.test("runPlan brackets each passing step with step_started then step_completed, in order and identity", async () => {
  const db = await Database.create({ driver: "pglite" });
  const kernel = new Kernel(db, { composition: testStoreComposition() });
  try {
    const cs = await inProgressChangeset(kernel, 3);
    const runner = fakeRunner();
    const events: ChatEvent[] = [];
    await runPlan(
      cs,
      baseDeps(kernel, runner, { onEvent: (e) => events.push(e) }),
    );

    // Exactly one step_started then one step_completed per step, in plan order —
    // started always precedes that step's completed (Stage 6 progress bracketing).
    const progress = events
      .filter((e) => e.type === "step_started" || e.type === "step_completed")
      .map((e) => `${e.type}:${e.stepId}`);
    assertEquals(progress, [
      "step_started:s1",
      "step_completed:s1",
      "step_started:s2",
      "step_completed:s2",
      "step_started:s3",
      "step_completed:s3",
    ]);

    // Identity fields are populated from the loop's own state, not the model.
    const firstStarted = events.find((e) => e.type === "step_started")!;
    assertEquals(firstStarted.stepIndex, 0);
    assertEquals(firstStarted.totalSteps, 3);
    assertEquals(firstStarted.stepId, "s1");
    assertEquals(firstStarted.stepDescription, "Step 1");
    const lastCompleted = events.filter((e) => e.type === "step_completed").at(
      -1,
    )!;
    assertEquals(lastCompleted.stepIndex, 2);
    assertEquals(lastCompleted.stepId, "s3");
  } finally {
    await db.close();
  }
});

Deno.test("runPlan emits step_started but never step_completed for a halted step, and none after it", async () => {
  const db = await Database.create({ driver: "pglite" });
  const kernel = new Kernel(db, { composition: testStoreComposition() });
  try {
    const cs = await inProgressChangeset(kernel, 3);
    const runner = fakeRunner();
    // The export gate never passes → step 1 halts after exhausting repairs; steps 2/3
    // never start.
    const gate = scriptedGate(() => false, "persistent type error");
    const events: ChatEvent[] = [];
    await runPlan(
      cs,
      baseDeps(kernel, runner, {
        onEvent: (e) => events.push(e),
        gates: gatesWith({ checkExportTypes: gate.thunk }),
      }),
    );

    // Step 1 started; the halted step emitted no step_completed and no later step ran.
    assertEquals(
      events.filter((e) => e.type === "step_started").map((e) => e.stepId),
      ["s1"],
    );
    assertEquals(events.filter((e) => e.type === "step_completed").length, 0);
  } finally {
    await db.close();
  }
});

Deno.test("runPlan emits no step_completed for a step whose turn is cancelled", async () => {
  const db = await Database.create({ driver: "pglite" });
  const kernel = new Kernel(db, { composition: testStoreComposition() });
  try {
    const cs = await inProgressChangeset(kernel, 3);
    // Step 1's turn is cancelled → the step stays in_progress and the loop stops.
    const runner = fakeRunner({
      stopReasonFor: (call) => (call === 0 ? "cancelled" : "end_turn"),
    });
    const events: ChatEvent[] = [];
    await runPlan(
      cs,
      baseDeps(kernel, runner, { onEvent: (e) => events.push(e) }),
    );

    assertEquals(
      events.filter((e) => e.type === "step_started").map((e) => e.stepId),
      ["s1"],
    );
    assertEquals(events.filter((e) => e.type === "step_completed").length, 0);
  } finally {
    await db.close();
  }
});

Deno.test("runPlan emits step_started/step_completed only for the resumed remainder", async () => {
  const db = await Database.create({ driver: "pglite" });
  const kernel = new Kernel(db, { composition: testStoreComposition() });
  try {
    const cs = await inProgressChangeset(kernel, 3);
    // Step 1 already done (a prior run) — resume must bracket only steps 2 and 3.
    await kernel.changesets.updateStep(cs.id, "s1", "done");
    const resumed = await kernel.changesets.get(cs.id);
    const runner = fakeRunner();
    const events: ChatEvent[] = [];
    await runPlan(
      resumed!,
      baseDeps(kernel, runner, { onEvent: (e) => events.push(e) }),
    );

    assertEquals(
      events.filter((e) => e.type === "step_started").map((e) => e.stepId),
      ["s2", "s3"],
    );
    assertEquals(
      events.filter((e) => e.type === "step_completed").map((e) => e.stepId),
      ["s2", "s3"],
    );
    // The resumed step carries its true 0-based index (1), not a re-based 0.
    assertEquals(events.find((e) => e.type === "step_started")!.stepIndex, 1);
  } finally {
    await db.close();
  }
});

Deno.test("runPlan fails a code step whose created entity is untested, repairs, then recovers", async () => {
  const db = await Database.create({ driver: "pglite" });
  const kernel = new Kernel(db, { composition: testStoreComposition() });
  try {
    const cs = await inProgressChangeset(kernel, 1);
    // The step creates a handler → selectGates includes test_coverage; the coverage
    // gate sees createUser untested on the first run, then covered after the repair.
    const runner = fakeRunner({
      toolCallsFor:
        () => [{ name: "define_handler", input: { name: "createUser" } }],
    });
    const coverage = scriptedGate(
      (call) => call > 0,
      "handler:createUser has no test",
    );
    let receivedCreated: string[] = [];
    const events: ChatEvent[] = [];
    await runPlan(
      cs,
      baseDeps(kernel, runner, {
        onEvent: (e) => events.push(e),
        gates: gatesWith({
          checkCoverage: (created) => {
            receivedCreated = created;
            return coverage.thunk();
          },
        }),
      }),
    );

    // The gate was scoped to exactly the entity the step created (no debt trap).
    assertEquals(receivedCreated, ["handler:createUser"]);
    // One repair sub-turn ran, seeded with the coverage diagnostics.
    assertEquals(runner.repairPrompts.length, 1);
    assert(runner.repairPrompts[0]!.includes("handler:createUser has no test"));
    // Coverage ran twice (fail → repair → pass); the step completed; no halt surfaced.
    assertEquals(coverage.calls, 2);
    const final = await kernel.changesets.get(cs.id);
    assertEquals(final!.plan.steps.map((s) => s.status), ["done"]);
    assertEquals(events.filter((e) => e.type === "system_message").length, 0);
  } finally {
    await db.close();
  }
});

Deno.test("runPlan skips the coverage gate for a step that created no testable code", async () => {
  const db = await Database.create({ driver: "pglite" });
  const kernel = new Kernel(db, { composition: testStoreComposition() });
  try {
    const cs = await inProgressChangeset(kernel, 1);
    // A schema-only step: not a code step, so selectGates omits test_coverage entirely
    // and the coverage thunk is never consulted.
    const runner = fakeRunner({
      toolCallsFor: () => [{ name: "define_schema", input: { name: "users" } }],
    });
    let coverageRuns = 0;
    await runPlan(
      cs,
      baseDeps(kernel, runner, {
        gates: gatesWith({
          checkCoverage: () => {
            coverageRuns++;
            return Promise.resolve({ passed: true, diagnostics: "" });
          },
        }),
      }),
    );
    assertEquals(coverageRuns, 0);
    const final = await kernel.changesets.get(cs.id);
    assertEquals(final!.plan.steps.map((s) => s.status), ["done"]);
  } finally {
    await db.close();
  }
});

Deno.test("runPlan halts when the browser gate keeps failing", async () => {
  const db = await Database.create({ driver: "pglite" });
  const kernel = new Kernel(db, { composition: testStoreComposition() });
  try {
    const cs = await inProgressChangeset(kernel, 2);
    // The first step drives the browser, so test_app is a blocking gate.
    const runner = fakeRunner({
      toolCallsFor: () => [{ name: "test_app", input: {} }],
    });
    let browserRuns = 0;
    const events: ChatEvent[] = [];
    await runPlan(
      cs,
      baseDeps(kernel, runner, {
        onEvent: (e) => events.push(e),
        gates: gatesWith({
          // A persistent page-error report blocks the step after bounded repair.
          checkBrowser: () => {
            browserRuns++;
            return Promise.resolve({
              passed: false,
              diagnostics:
                "The app loaded but reported page errors:\nReferenceError",
            });
          },
        }),
      }),
    );

    // Initial gate plus two bounded repair re-checks.
    assertEquals(browserRuns, 3);
    assertEquals(runner.repairPrompts.length, 2);
    assert(runner.repairPrompts[0]!.includes("ReferenceError"));
    const final = await kernel.changesets.get(cs.id);
    assertEquals(final!.plan.steps.map((s) => s.status), [
      "in_progress",
      "pending",
    ]);
    const failures = events.filter((e) =>
      e.type === "system_message" &&
      (e as { text: string }).text.includes("did not pass the test_app gate")
    );
    assertEquals(failures.length, 1);
    assert((failures[0] as { text: string }).text.includes("ReferenceError"));
  } finally {
    await db.close();
  }
});

Deno.test("runPlan repairs and recovers when the browser gate later passes", async () => {
  const db = await Database.create({ driver: "pglite" });
  const kernel = new Kernel(db, { composition: testStoreComposition() });
  try {
    const cs = await inProgressChangeset(kernel, 1);
    const runner = fakeRunner({
      toolCallsFor: () => [{ name: "screenshot_app", input: {} }],
    });
    const events: ChatEvent[] = [];
    const browserGate = scriptedGate(
      (call) => call === 1,
      "Browser verification could not run:\nNo browser found",
    );
    await runPlan(
      cs,
      baseDeps(kernel, runner, {
        onEvent: (e) => events.push(e),
        gates: gatesWith({
          checkBrowser: browserGate.thunk,
        }),
      }),
    );
    assertEquals(browserGate.calls, 2);
    assertEquals(runner.repairPrompts.length, 1);
    assert(runner.repairPrompts[0]!.includes("No browser found"));
    assertEquals(events.filter((e) => e.type === "system_message").length, 0);
    const final = await kernel.changesets.get(cs.id);
    assertEquals(final!.plan.steps.map((s) => s.status), ["done"]);
  } finally {
    await db.close();
  }
});

Deno.test("stepCommitMessage formats a 1-based step N: <desc> message", () => {
  assertEquals(
    stepCommitMessage(
      { id: "s1", description: "Add the users table" } as PlanStep,
      0,
    ),
    "step 1: Add the users table",
  );
  assertEquals(
    stepCommitMessage(
      { id: "s5", description: "Wire the route" } as PlanStep,
      4,
    ),
    "step 5: Wire the route",
  );
});

Deno.test("parseHandoff extracts and trims a trailing block", () => {
  const text =
    "Implemented the users table.\n\nHANDOFF: users → (id, email)\n\n";
  assertEquals(parseHandoff(text), "HANDOFF: users → (id, email)");
});

Deno.test("parseHandoff returns empty string when the marker is absent", () => {
  assertEquals(parseHandoff("I built the thing but never handed off."), "");
  assertEquals(parseHandoff(""), "");
});

Deno.test("parseHandoff takes from the last marker to end when the marker appears mid-text", () => {
  const text = "Earlier I mentioned the HANDOFF: format we agreed on.\n\n" +
    "HANDOFF: prices → (id, cents)";
  assertEquals(parseHandoff(text), "HANDOFF: prices → (id, cents)");
});
