import { assert, assertEquals } from "@std/assert";
import {
  DEFAULT_NATURAL_COMMUNICATION_PRINCIPLE,
  DEFAULT_NATURAL_GIT_STATE_REPORTING_PRINCIPLE,
  DEFAULT_STEP_RIGHT_SIZING_NUDGE,
  DEFAULT_SYSTEM_PROMPT,
  DefaultChatIntelligence,
} from "./default-brain.ts";
import { ChatOrchestrator } from "./chat.ts";
import { FakeModelProvider } from "../core/model-provider-fake.ts";
import { DEFAULT_MODEL_ID, getAgentModelForRequest } from "../core/config.ts";
import { Database } from "../core/db.ts";
import { MCPManager } from "../core/mcp.ts";
import { Kernel } from "../core/registries.ts";

Deno.test("DefaultChatIntelligence composes the generic prompt with project sections", () => {
  const brain = new DefaultChatIntelligence();
  const prompt = brain.baseSystemPrompt({
    skills: [{ name: "billing", prompt: "Handle invoices carefully." }],
    secrets: [{ key: "STRIPE_KEY", status: "set" }],
    customInstructions: "Prefer TypeScript.",
  });
  // The generic base is present, framed by the shared open composePrompt sections.
  assert(prompt.startsWith(DEFAULT_SYSTEM_PROMPT.slice(0, 40)));
  assert(prompt.includes("## Active Skills"));
  assert(prompt.includes("billing"));
  assert(prompt.includes("## Defined Secrets"));
  assert(prompt.includes("STRIPE_KEY"));
  assert(prompt.includes("## Custom Instructions"));
  assert(prompt.includes("Prefer TypeScript."));
  assert(prompt.includes(DEFAULT_NATURAL_COMMUNICATION_PRINCIPLE));
  assert(prompt.includes(DEFAULT_NATURAL_GIT_STATE_REPORTING_PRINCIPLE));
});

Deno.test("DefaultChatIntelligence delegates the sentinel and honors explicit pins (D9)", () => {
  const brain = new DefaultChatIntelligence();
  // The sentinel delegates to the agent role's catalog-driven recommendation — NO
  // hardcoded fallback id. If the role is unconfigured this is undefined, propagated
  // verbatim (never a fabricated default); if it's configured it equals the delegate.
  assertEquals(brain.resolveModel(DEFAULT_MODEL_ID), getAgentModelForRequest());
  // An explicit pin is always returned verbatim, regardless of catalog state.
  assertEquals(brain.resolveModel("claude-sonnet-4-6"), "claude-sonnet-4-6");
});

Deno.test("DefaultChatIntelligence surfaces an unconfigured role, never a fabricated default (D9)", () => {
  const brain = new DefaultChatIntelligence();
  // When the delegate is undefined (unconfigured), resolveModel must propagate
  // undefined — proving there is no hidden hardcoded fallback under the sentinel.
  if (getAgentModelForRequest() === undefined) {
    assertEquals(brain.resolveModel(DEFAULT_MODEL_ID), undefined);
  }
  // A pin never depends on the role being configured.
  assertEquals(brain.resolveModel("claude-opus-4-8"), "claude-opus-4-8");
});

Deno.test("DefaultChatIntelligence keeps offline approval fallback narrow", () => {
  const brain = new DefaultChatIntelligence();
  assertEquals(brain.isApprovalMessage("approve"), true);
  assertEquals(brain.isApprovalMessage("Yes."), true);
  assertEquals(brain.isApprovalMessage("go ahead"), true);
  assertEquals(
    brain.isApprovalMessage("ok, i approve, correct the claim"),
    false,
  );
  assertEquals(
    brain.isApprovalMessage("okay, approve it and fix the claim wording"),
    false,
  );
  assertEquals(brain.isApprovalMessage("yes, approved, go ahead"), false);
  assertEquals(
    brain.isApprovalMessage("ok so the app shows wrong wind"),
    false,
  );
  assertEquals(
    brain.isApprovalMessage("yes, but revise the plan first"),
    false,
  );
  assertEquals(brain.isApprovalMessage("continue refining the plan"), false);
  assertEquals(brain.isApprovalMessage("can you change the title?"), false);
  assertEquals(brain.isApprovalMessage("approve button is broken"), false);
});

Deno.test("DefaultChatIntelligence.stepPrompt scopes to one step and carries the handoff", () => {
  const brain = new DefaultChatIntelligence();
  const step = {
    id: "step_2",
    description: "Add the login route",
    status: "pending" as const,
  };
  const changeset = { id: "cs_1", plan: { steps: [step] } } as never;
  const prompt = brain.stepPrompt(step, {
    changeset,
    stepIndex: 2,
    totalSteps: 5,
    priorHandoff: "HANDOFF: created users table",
  });
  // "step N of M" framing is 1-based off the zero-based index.
  assert(prompt.includes("step 3 of 5"));
  assert(prompt.includes("Add the login route"));
  // The prior handoff is threaded in as orientation.
  assert(prompt.includes("HANDOFF: created users table"));
  // The inspect-before-implement directive and the handoff instruction are present.
  assert(prompt.toLowerCase().includes("inspect"));
  assert(prompt.includes(brain.handoffInstruction()));
});

Deno.test("DefaultChatIntelligence.stepPrompt omits the prior-handoff section on the first step", () => {
  const brain = new DefaultChatIntelligence();
  const step = {
    id: "step_0",
    description: "Create the schema",
    status: "pending" as const,
  };
  const changeset = { id: "cs_1", plan: { steps: [step] } } as never;
  const prompt = brain.stepPrompt(step, {
    changeset,
    stepIndex: 0,
    totalSteps: 3,
  });
  assert(prompt.includes("step 1 of 3"));
  assert(prompt.includes("Create the schema"));
  assert(!prompt.includes("previous step"));
});

Deno.test("DefaultChatIntelligence.handoffInstruction asks for a HANDOFF block", () => {
  const brain = new DefaultChatIntelligence();
  assert(brain.handoffInstruction().includes("HANDOFF:"));
});

Deno.test("DefaultChatIntelligence.baseSystemPrompt carries the planner right-sizing nudge", () => {
  const brain = new DefaultChatIntelligence();
  // Even the BYO-key default plan is nudged toward right-sized, per-turn steps.
  assert(brain.baseSystemPrompt({}).includes(DEFAULT_STEP_RIGHT_SIZING_NUDGE));
});

Deno.test("DefaultChatIntelligence.repairPrompt frames the step, carries diagnostics, and re-asks for a handoff", () => {
  const brain = new DefaultChatIntelligence();
  const step = {
    id: "step_1",
    description: "Add the login route",
    status: "pending" as const,
  };
  const changeset = { id: "cs_1", plan: { steps: [step] } } as never;
  const prompt = brain.repairPrompt(step, {
    changeset,
    stepIndex: 1,
    totalSteps: 4,
  }, "TS2304: Cannot find name 'foo'.");
  // The step and its position are named so the repair is scoped to it.
  assert(prompt.includes("Step 2 of 4"));
  assert(prompt.includes("Add the login route"));
  // The gate diagnostics are threaded in verbatim so the fix is targeted.
  assert(prompt.includes("TS2304: Cannot find name 'foo'."));
  // The repair turn is still asked to end with a handoff (it becomes the step's).
  assert(prompt.includes(brain.handoffInstruction()));
});

// The point of the split: the open loop runs on the open default brain with zero agent/
// code. Constructing the orchestrator here (this file imports only agent-loop + core)
// exercises the full injection path OpenTide-open uses.
Deno.test("ChatOrchestrator runs on the open DefaultChatIntelligence", async () => {
  const db = await Database.create({ driver: "pglite" });
  const kernel = new Kernel(db);
  const chat = new ChatOrchestrator(
    kernel,
    () => {},
    new MCPManager(),
    new DefaultChatIntelligence(),
    new FakeModelProvider([]),
  );
  try {
    // Constructible and operable without any tuned brain: no session, nothing in flight.
    assertEquals(chat.getCurrentSessionId(), null);
    assertEquals(chat.getInProgressState(), null);
  } finally {
    await db.close();
  }
});
