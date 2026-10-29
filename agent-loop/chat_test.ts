import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  buildUserContentBlocks,
  type ChatEvent,
  ChatOrchestrator,
  formatProjectHistoryForContext,
  formatRecentMessagesForContext,
  hasMultipleSteps,
  hasSessionContextToReload,
  resolveDocumentMentions,
  resolveMessageAttachments,
} from "./chat.ts";
import { inProcessChatBackend } from "./chat-backend.ts";
import { ATTACHMENT_DOCUMENT_SOURCE } from "../core/documents.ts";
import { encodeBase64 } from "../core/util.ts";
import { composePrompt } from "./prompt-compose.ts";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatIntelligence } from "../core/chat-intelligence.ts";
import type { CurrentUser } from "../core/auth.ts";
import type { TurnGroup } from "../core/changelog.ts";
import type { Changeset } from "../verification/changesets.ts";
import { Database } from "../core/db.ts";
import { MCPManager } from "../core/mcp.ts";
import { Kernel } from "../core/registries.ts";
import type { Session, StoredMessage, TurnUsage } from "../core/types.ts";
import { FakeModelProvider } from "../core/model-provider-fake.ts";
import type { ProviderEvent } from "../core/model-provider.ts";
import type { PlanStep } from "./step-orchestrator.ts";
import { gitInit, gitStatus } from "../core/git.ts";
import { rmSync } from "node:fs";
import { testStoreComposition } from "../verification/test-stores.ts";
import { testComposition } from "../cli/test-composition.ts";
import {
  MODEL_UNCONFIGURED_MESSAGE,
  setKernelSettings,
  setRecommendedModels,
} from "../core/config.ts";
import { TEST_TMP_DIR } from "../core/test-home_test.ts";

Deno.test("buildUserContentBlocks surfaces image attachments as visual context", () => {
  const blocks = buildUserContentBlocks("What is happening on screen?", [{
    name: "screenshot.png",
    type: "image/png",
    data: "iVBORw0KGgo=",
  }]) as unknown as Array<Record<string, unknown>>;

  assertEquals(blocks.length, 3);
  assertEquals(blocks[0]?.type, "text");
  assert(String(blocks[0]?.text).includes("screenshot.png (image/png)"));
  assert(String(blocks[0]?.text).includes("inspect the visual content"));

  assertEquals(blocks[1]?.type, "image");
  assertEquals(
    (blocks[1]?.source as Record<string, unknown>)?.media_type,
    "image/png",
  );

  assertEquals(blocks[2], {
    type: "text",
    text: "What is happening on screen?",
  });
});

Deno.test("buildUserContentBlocks decodes text attachments as UTF-8", () => {
  const source =
    "// Layer toggle checkboxes — includes the new 'indicators' toggle";
  const blocks = buildUserContentBlocks("Review this file", [{
    name: "overlay.ts",
    type: "text/typescript",
    data: encodeBase64Utf8(source),
  }]) as unknown as Array<Record<string, unknown>>;

  assert(String(blocks[1]?.text).includes(source));
  assert(!String(blocks[1]?.text).includes("â"));
});

Deno.test("formatRecentMessagesForContext keeps recent turns without attachment metadata", () => {
  const messages: StoredMessage[] = [
    message(1, "user", "Earlier"),
    message(
      2,
      "assistant",
      "Would you like me to add pressure, wave, and rain overlays?",
    ),
    message(
      3,
      "user",
      'yes, let\'s add all the info\n\n<attachments>[{"name":"screen.png","type":"image/png","src":"data:image/png;base64,abc"}]</attachments>',
    ),
  ];

  const context = formatRecentMessagesForContext(messages, 2);

  assert(!context.includes("Earlier"));
  assert(context.includes("Would you like me to add pressure"));
  assert(context.includes("yes, let's add all the info"));
  assert(!context.includes("<attachments>"));
  assert(!context.includes("base64"));
});

Deno.test("formatRecentMessagesForContext includes shell transcripts", () => {
  const messages: StoredMessage[] = [
    message(1, "user", "run tests"),
    message(2, "system", "$ deno test\nexit: 0", "shell"),
  ];

  const context = formatRecentMessagesForContext(messages, 4);

  assert(context.includes("#2 shell:"));
  assert(context.includes("$ deno test"));
});

Deno.test("formatProjectHistoryForContext summarizes turns and changesets", () => {
  const context = formatProjectHistoryForContext({
    changesets: [changeset({
      id: "cs_recent",
      status: "completed",
      title: "Add saved filters",
      plan: {
        summary:
          "Persist filters so returning users keep their dashboard state.",
        steps: [
          {
            id: "step_0",
            description: "Create filters table and update dashboard handlers.",
            status: "done",
          },
        ],
      },
    })],
    turns: [turn({
      turnId: "turn_recent",
      userMessage: "Add saved dashboard filters",
      changesetId: "cs_recent",
      changes: [{
        id: 42,
        category: "handler",
        key: "saveFilters",
        action: "update",
        beforeSnapshot: { source: "old" },
        afterSnapshot: { source: "new" },
        context: null,
        createdAt: "2026-06-19T00:00:00.000Z",
        undoable: true,
        turnId: "turn_recent",
        changesetId: "cs_recent",
        rationale: "Keep dashboard filter state across visits.",
        implementation: null,
        workMessageId: null,
      }],
    })],
  });

  assert(context.includes("recent changesets:"));
  assert(context.includes("cs_recent [completed] Add saved filters"));
  assert(context.includes("recent turns:"));
  assert(context.includes("update handler:saveFilters (#42)"));
  assert(context.includes("History is evidence"));
  assert(!context.includes("beforeSnapshot"));
  assert(!context.includes("afterSnapshot"));
});

// A minimal stand-in brain: the lifecycle tests below never reach the model, so the
// loop's injected intelligence can be an inert stub. (The tuned brain's own behavior is
// covered in brain_test.ts.) Typed against the core contract so this test carries no
// dependency on any concrete brain implementation.
const stubBrain: ChatIntelligence = {
  baseSystemPrompt: () => "test system prompt",
  resolveModel: (configured) => configured,
  isApprovalMessage: () => false,
  stepPrompt: (step) => step.description,
  handoffInstruction: () => "HANDOFF:",
  repairPrompt: (step, _ctx, diagnostics) =>
    `repair ${step.description}: ${diagnostics}`,
  finalReadinessRepairPrompt: (_changeset, readiness) =>
    `repair final readiness: ${readiness.errors.length} errors`,
};

// The private surface these behavior tests reach into to drive one whole client-side turn
// directly (below the public sendMessage, which resolves the changeset/@-mention setup the
// runner itself does not need). runTurn stores the user message, fires first-turn auto-name,
// persists attachments, and records usage — the behaviors asserted below.
interface TurnInternals {
  currentSessionId: string;
  autoNameEligibleSessionIds: Set<string>;
  runTurn: (opts: {
    content: string;
    storedContent?: string;
    onEvent?: (event: ChatEvent) => void;
    approvalStarted: boolean;
    activeWorkCs: Changeset | null;
    system: string;
    tools: never[];
    model: string;
    modelRole: "agent" | "planning";
    attachments?: Array<{ name: string; type: string; data: string }>;
  }) => Promise<{ turnId: string }>;
}

// Build an orchestrator over a scripted FakeModelProvider and expose its private turn
// surface. The provider replays `script` (one ProviderEvent[] per model request) regardless
// of the request, so a turn runs network-free and deterministically.
function localTurnHarness(
  kernel: Kernel,
  script: ProviderEvent[][],
  opts: {
    brain?: ChatIntelligence;
    nameGen?: ConstructorParameters<typeof ChatOrchestrator>[4];
  } = {},
): {
  chat: ChatOrchestrator;
  provider: FakeModelProvider;
  internals: TurnInternals;
} {
  const provider = new FakeModelProvider(script);
  const chat = new ChatOrchestrator(
    inProcessChatBackend(kernel, () => {}),
    new MCPManager(),
    opts.brain ?? stubBrain,
    provider,
    opts.nameGen,
  );
  return { chat, provider, internals: chat as unknown as TurnInternals };
}

// The minimal LocalTurnOptions a direct runTurn call needs: an empty base system prompt +
// no tools, plus a priced model so recorded usage carries a real cost. `model` is passed to
// runTurn directly (the brain's resolveModel runs earlier, in sendMessage).
const TURN_MODEL = "claude-sonnet-5";
function baseTurnOpts(content: string) {
  return {
    content,
    approvalStarted: false,
    activeWorkCs: null,
    system: "sys",
    tools: [] as never[],
    model: TURN_MODEL,
    modelRole: "agent" as const,
  };
}

async function withIsolatedHome(fn: () => Promise<void>): Promise<void> {
  const prevHome = Deno.env.get("HOME");
  const tmpHome = await Deno.makeTempDir({ prefix: "chat-model-role-home-" });
  Deno.env.set("HOME", tmpHome);
  try {
    await fn();
  } finally {
    if (prevHome) Deno.env.set("HOME", prevHome);
    else Deno.env.delete("HOME");
    await Deno.remove(tmpHome, { recursive: true });
  }
}

function configuredRoleBrain(
  approval: (content: string) => boolean | Promise<boolean> = () => false,
): ChatIntelligence {
  return {
    ...stubBrain,
    resolveModel: (configured) => configured,
    isApprovalMessage: (content) => approval(content),
  };
}

function usageTurn(
  over: Partial<TurnUsage> = {},
): ProviderEvent[] {
  return [
    { type: "turn_usage", usage: usageEvent({ inputTokens: 10, ...over }) },
    { type: "text_delta", text: "ok" },
    { type: "message_complete", stopReason: "end_turn" },
  ];
}

Deno.test("sendMessage routes planning changeset revision turns to the planning role", async () => {
  await withIsolatedHome(async () => {
    setRecommendedModels({
      agent: "agent-model",
      planning: "planning-model",
    });
    const db = await Database.create({ driver: "pglite" });
    try {
      const kernel = new Kernel(db, { composition: testStoreComposition() });
      const session = await kernel.sessions.createSession("Planning Role");
      const cs = await kernel.changesets.create({
        sessionId: session.id,
        title: "Revise plan",
        plan: {
          summary: "Revise the existing plan.",
          steps: [{
            id: "s1",
            description: "Update the plan",
            status: "pending",
          }],
          acceptanceCriteria: [{
            id: "claim_0",
            text: "The plan is clearer.",
            source: "agent",
            priority: "must",
          }],
          verificationPlan: [{
            id: "v1",
            claimIds: ["claim_0"],
            kind: "unit",
            description: "Check the revised plan.",
          }],
        },
      });
      const provider = new FakeModelProvider([usageTurn()]);
      const chat = new ChatOrchestrator(
        inProcessChatBackend(kernel, () => {}),
        new MCPManager(),
        configuredRoleBrain(),
        provider,
      );
      (chat as unknown as { currentSessionId: string }).currentSessionId =
        session.id;

      const events: ChatEvent[] = [];
      await chat.sendMessage(
        "tighten the plan scope",
        (event) => events.push(event),
      );

      assertEquals(provider.requests[0]?.model, "planning-model");
      const turnId = events.find((event) => event.type === "turn_usage")?.usage
        ?.turnId;
      assert(turnId, "expected recorded turn usage");
      const modelUsage = await kernel.sessions.getModelUsagesForTurn(turnId);
      assertEquals(modelUsage[0]?.role, "planning");
      assertEquals(modelUsage[0]?.model, "planning-model");
      assertEquals((await kernel.changesets.get(cs.id))?.status, "planning");
    } finally {
      await db.close();
    }
  });
});

Deno.test("sendMessage routes approval turns that start work to the agent role", async () => {
  await withIsolatedHome(async () => {
    setRecommendedModels({
      agent: "agent-model",
      planning: "planning-model",
    });
    setKernelSettings({ perStepExecution: false });
    const db = await Database.create({ driver: "pglite" });
    try {
      const kernel = new Kernel(db, { composition: testStoreComposition() });
      const session = await kernel.sessions.createSession("Approval Role");
      const cs = await kernel.changesets.create({
        sessionId: session.id,
        title: "Approved plan",
        plan: {
          summary: "Do approved work.",
          steps: [{
            id: "s1",
            description: "Build it",
            status: "pending",
          }],
          acceptanceCriteria: [{
            id: "claim_0",
            text: "The work is complete.",
            source: "agent",
            priority: "must",
          }],
          verificationPlan: [{
            id: "v1",
            claimIds: ["claim_0"],
            kind: "unit",
            description: "Check the work.",
          }],
        },
      });
      const provider = new FakeModelProvider([usageTurn()]);
      const chat = new ChatOrchestrator(
        inProcessChatBackend(kernel, () => {}),
        new MCPManager(),
        configuredRoleBrain((content) => content === "approve"),
        provider,
      );
      (chat as unknown as { currentSessionId: string }).currentSessionId =
        session.id;

      const events: ChatEvent[] = [];
      await chat.sendMessage("approve", (event) => events.push(event));

      assertEquals(provider.requests[0]?.model, "agent-model");
      const active = await kernel.changesets.get(cs.id);
      assertEquals(active?.status, "in_progress");
      const turnId = events.find((event) => event.type === "turn_usage")?.usage
        ?.turnId;
      assert(turnId, "expected recorded turn usage");
      const modelUsage = await kernel.sessions.getModelUsagesForTurn(
        turnId,
      );
      assertEquals(modelUsage[0]?.role, "agent");
      assertEquals(modelUsage[0]?.model, "agent-model");
    } finally {
      setKernelSettings({ perStepExecution: true });
      await db.close();
    }
  });
});

Deno.test("runStepTurn keeps per-step execution on the agent role", async () => {
  await withIsolatedHome(async () => {
    setRecommendedModels({
      agent: "agent-model",
      planning: "planning-model",
    });
    const db = await Database.create({ driver: "pglite" });
    try {
      const kernel = new Kernel(db, { composition: testStoreComposition() });
      const session = await kernel.sessions.createSession("Step Role");
      const provider = new FakeModelProvider([usageTurn()]);
      const chat = new ChatOrchestrator(
        inProcessChatBackend(kernel, () => {}),
        new MCPManager(),
        configuredRoleBrain(),
        provider,
      );
      const inner = chat as unknown as {
        currentSessionId: string;
        runStepTurn: (opts: {
          content: string;
          contentBlocks: ReturnType<typeof buildUserContentBlocks>;
          approvalStarted: boolean;
          activeWorkCs: Changeset | null;
        }) => Promise<{ turnId: string }>;
      };
      inner.currentSessionId = session.id;

      const result = await inner.runStepTurn({
        content: "implement step",
        contentBlocks: buildUserContentBlocks("implement step"),
        approvalStarted: false,
        activeWorkCs: null,
      });

      assertEquals(provider.requests[0]?.model, "agent-model");
      const modelUsage = await kernel.sessions.getModelUsagesForTurn(
        result.turnId,
      );
      assertEquals(modelUsage[0]?.role, "agent");
      assertEquals(modelUsage[0]?.model, "agent-model");
    } finally {
      await db.close();
    }
  });
});

Deno.test("sendMessage surfaces the standard unconfigured message when planning role has no recommendation", async () => {
  await withIsolatedHome(async () => {
    setRecommendedModels({ agent: "agent-model" });
    const db = await Database.create({ driver: "pglite" });
    try {
      const kernel = new Kernel(db, { composition: testStoreComposition() });
      const session = await kernel.sessions.createSession(
        "Missing Planning Role",
      );
      await kernel.changesets.create({
        sessionId: session.id,
        title: "Unconfigured planning",
        plan: {
          summary: "Need planning model.",
          steps: [{
            id: "s1",
            description: "Revise",
            status: "pending",
          }],
          acceptanceCriteria: [{
            id: "claim_0",
            text: "The plan is revised.",
            source: "agent",
            priority: "must",
          }],
          verificationPlan: [{
            id: "v1",
            claimIds: ["claim_0"],
            kind: "unit",
            description: "Check the plan.",
          }],
        },
      });
      const provider = new FakeModelProvider([usageTurn()]);
      const chat = new ChatOrchestrator(
        inProcessChatBackend(kernel, () => {}),
        new MCPManager(),
        configuredRoleBrain(),
        provider,
      );
      (chat as unknown as { currentSessionId: string }).currentSessionId =
        session.id;

      await assertRejects(
        () => chat.sendMessage("revise the plan"),
        Error,
        MODEL_UNCONFIGURED_MESSAGE,
      );
      assertEquals(provider.requests.length, 0);
    } finally {
      await db.close();
    }
  });
});

Deno.test("ChatOrchestrator starts planning changeset when brain classifies compound approval", async () => {
  const db = await Database.create({ driver: "pglite" });
  const kernel = new Kernel(db, { composition: testStoreComposition() });
  const session = await kernel.sessions.createSession("Approval Session");
  const cs = await kernel.changesets.create({
    sessionId: session.id,
    title: "Correct the claim",
    plan: {
      summary: "Correct the disputed claim.",
      acceptanceCriteria: [{
        id: "claim_approval",
        text: "Compound approval starts work.",
        source: "agent",
        priority: "must",
      }],
      verificationPlan: [{
        id: "check_approval",
        claimIds: ["claim_approval"],
        kind: "unit",
        description: "Exercise compound approval classification.",
      }],
      steps: [],
    },
  });
  const approvalCalls: string[] = [];
  const brain: ChatIntelligence = {
    ...stubBrain,
    isApprovalMessage: (content, ctx) => {
      approvalCalls.push(`${ctx?.changeset.id}:${content}`);
      return Promise.resolve(content === "ok, i approve, correct the claim");
    },
  };
  const chat = new ChatOrchestrator(
    inProcessChatBackend(kernel, () => {}),
    new MCPManager(),
    brain,
    new FakeModelProvider([]),
  );

  try {
    const prepared = await (chat as unknown as {
      prepareChangesetForTurn: (
        content: string,
        cs: Changeset | null,
      ) => Promise<{ changeset: Changeset | null; approvalStarted: boolean }>;
    }).prepareChangesetForTurn("ok, i approve, correct the claim", cs);

    assertEquals(prepared.approvalStarted, true);
    assertEquals(prepared.changeset?.status, "in_progress");
    assertEquals((await kernel.changesets.get(cs.id))?.status, "in_progress");
    assertEquals(approvalCalls, [
      `${cs.id}:ok, i approve, correct the claim`,
    ]);
  } finally {
    await db.close();
  }
});

Deno.test("ChatOrchestrator rejects unreadable direct lifecycle operations", async () => {
  const db = await Database.create({ driver: "pglite" });
  const kernel = new Kernel(db);
  const chat = new ChatOrchestrator(
    inProcessChatBackend(kernel, () => {}),
    new MCPManager(),
    stubBrain,
    new FakeModelProvider([]),
  );
  const privateSession = await kernel.sessions.createSession("Private", {
    ownerUserId: "account_owner",
    visibility: "private",
  });
  const other: CurrentUser = {
    id: "account_other",
    accountId: "other",
    displayName: "Other",
    email: null,
    avatarUrl: null,
  };

  try {
    (chat as unknown as { currentSessionId: string }).currentSessionId =
      privateSession.id;

    await assertRejects(
      () => chat.compactSession("summary", other),
      Error,
      "Forbidden",
    );
    await assertRejects(
      () => chat.resumeSession(privateSession.id, other),
      Error,
      "Forbidden",
    );
  } finally {
    await db.close();
  }
});

function gitAvailable(): boolean {
  try {
    return new Deno.Command("git", {
      args: ["--version"],
      stdout: "null",
      stderr: "null",
    }).outputSync().success;
  } catch {
    return false;
  }
}

function configureGitIdentity(dir: string): void {
  const identity: ReadonlyArray<[string, string]> = [
    ["user.email", "tide-test@example.com"],
    ["user.name", "Tide Test"],
  ];
  for (const [key, value] of identity) {
    new Deno.Command("git", {
      args: ["config", key, value],
      cwd: dir,
      stdout: "null",
      stderr: "null",
    }).outputSync();
  }
}

// Stage 5 binding — exercises the real git side of the per-step checkpoint (commitStep):
// a step with a file delta lands a real "step N: <desc>" commit, and a second step whose
// flush produces no change commits nothing without breaking the loop.
// The flush inside commitStep persists the kernel's project state to disk before staging,
// so an unchanged kernel flushed twice yields an identical tree — the deterministic way to
// reach the no-delta branch through the real gitCommit path.
Deno.test("commitStep lands a real step checkpoint and skips a step with no delta", async () => {
  if (!gitAvailable()) return;
  const db = await Database.create({ driver: "pglite" });
  const kernel = new Kernel(db);
  const dir = await Deno.makeTempDir({
    dir: TEST_TMP_DIR,
    prefix: "tideide-checkpoint-test-",
  });
  try {
    gitInit(dir);
    configureGitIdentity(dir);
    writeFileSync(join(dir, "opentide.json"), JSON.stringify({ name: "cp" }));
    kernel.projectDir = dir;
    const chat = new ChatOrchestrator(
      inProcessChatBackend(kernel, () => {}),
      new MCPManager(),
      stubBrain,
      new FakeModelProvider([]),
    );
    const commit = (step: PlanStep, i: number): Promise<void> =>
      (chat as unknown as {
        commitStep: (s: PlanStep, i: number, cs: string) => Promise<void>;
      }).commitStep(step, i, "cs_checkpoint");

    const step1: PlanStep = {
      id: "s1",
      description: "Scaffold the project",
      status: "in_progress",
    };
    // First step: flush writes the kernel's project state into the repo → a real commit.
    await commit(step1, 0);
    const afterFirst = gitStatus(dir);
    assertEquals(
      afterFirst.latestCommit?.subject,
      "step 1: Scaffold the project",
    );

    // Second step: the kernel is unchanged, so the flush rewrites an identical tree and
    // there is nothing to commit. The call must resolve
    // (never reject) and leave the prior commit as the last checkpoint — no new commit.
    const step2: PlanStep = {
      id: "s2",
      description: "Adjust the schema",
      status: "in_progress",
    };
    await commit(step2, 1);
    const afterSecond = gitStatus(dir);
    assertEquals(
      afterSecond.latestCommit?.subject,
      "step 1: Scaffold the project",
    );
  } finally {
    kernel.projectDir = null;
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

Deno.test("commitStep is a no-op when no project directory is loaded", async () => {
  const db = await Database.create({ driver: "pglite" });
  const kernel = new Kernel(db);
  try {
    // projectDir stays null (a BYO-key / no-project run) → commitStep resolves without
    // touching git. It must not throw.
    const chat = new ChatOrchestrator(
      inProcessChatBackend(kernel, () => {}),
      new MCPManager(),
      stubBrain,
      new FakeModelProvider([]),
    );
    const step: PlanStep = {
      id: "s1",
      description: "Anything",
      status: "in_progress",
    };
    await (chat as unknown as {
      commitStep: (s: PlanStep, i: number, cs: string) => Promise<void>;
    }).commitStep(step, 0, "cs_checkpoint");
  } finally {
    await db.close();
  }
});

function usageEvent(over: Partial<TurnUsage>): TurnUsage {
  return {
    turnId: "",
    sessionId: "",
    model: TURN_MODEL,
    startedAt: "2026-07-30T10:00:00.000Z",
    endedAt: "2026-07-30T10:00:01.250Z",
    durationMs: 1250,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    toolCallsCount: 0,
    costUsd: 0.01,
    ...over,
  };
}

Deno.test("runTurn emits model_request_usage before final turn_usage and records it", async () => {
  const db = await Database.create({ driver: "pglite" });
  const kernel = new Kernel(db, { composition: testStoreComposition() });
  const session = await kernel.sessions.createSession("Usage Session");
  const usage = usageEvent({
    inputTokens: 100,
    outputTokens: 20,
    cacheCreationInputTokens: 30,
    cacheReadInputTokens: 40,
  });
  const { internals } = localTurnHarness(kernel, [[
    { type: "model_request_usage", usage },
    { type: "turn_usage", usage },
    { type: "text_delta", text: "done" },
    { type: "message_complete", stopReason: "end_turn" },
  ]]);

  try {
    internals.currentSessionId = session.id;
    const events: ChatEvent[] = [];
    const result = await internals.runTurn({
      ...baseTurnOpts("hello"),
      onEvent: (event) => events.push(event),
    });

    const requestIndex = events.findIndex((e) =>
      e.type === "model_request_usage"
    );
    const turnIndex = events.findIndex((e) => e.type === "turn_usage");
    assert(requestIndex >= 0);
    assert(turnIndex > requestIndex);

    const requestUsage = events[requestIndex]!.usage;
    assert(requestUsage);
    assertEquals(requestUsage.turnId, result.turnId);
    assertEquals(requestUsage.sessionId, session.id);
    assertEquals(requestUsage.inputTokens, 100);
    assertEquals(requestUsage.outputTokens, 20);
    assertEquals(requestUsage.cacheCreationInputTokens, 30);
    assertEquals(requestUsage.cacheReadInputTokens, 40);
    assertEquals(requestUsage.toolCallsCount, 0);
    assert(requestUsage.costUsd > 0);

    const turnUsage = events[turnIndex]!.usage;
    assert(turnUsage);
    assertEquals(turnUsage.turnId, result.turnId);
    assertEquals(turnUsage.inputTokens, 100);
    assertEquals(turnUsage.outputTokens, 20);
    assertEquals(turnUsage.cacheCreationInputTokens, 30);
    assertEquals(turnUsage.cacheReadInputTokens, 40);
    assert(turnUsage.costUsd > 0);
    assertEquals(
      (await kernel.sessions.getTurnUsage(result.turnId))?.inputTokens,
      100,
    );
    const modelUsage = await kernel.sessions.getModelUsagesForTurn(
      result.turnId,
    );
    assertEquals(modelUsage.length, 1);
    assertEquals(modelUsage[0]!.sessionId, session.id);
    assertEquals(modelUsage[0]!.provider, "anthropic");
    assertEquals(modelUsage[0]!.model, TURN_MODEL);
    assertEquals(modelUsage[0]!.role, "agent");
    assertEquals(modelUsage[0]!.caller, "chat_turn");
    assertEquals(modelUsage[0]!.inputTokens, 100);
    assertEquals(modelUsage[0]!.outputTokens, 20);
    assertEquals(modelUsage[0]!.cacheCreationInputTokens, 30);
    assertEquals(modelUsage[0]!.cacheReadInputTokens, 40);
    assert(modelUsage[0]!.costUsd !== null);
    assertEquals(modelUsage[0]!.pricingStatus, "priced");
  } finally {
    await db.close();
  }
});

Deno.test("runTurn records model usage with provider observed from provider events", async () => {
  const db = await Database.create({ driver: "pglite" });
  const kernel = new Kernel(db, { composition: testStoreComposition() });
  const session = await kernel.sessions.createSession("Runtime Provider");
  const usage = usageEvent({
    inputTokens: 100,
    outputTokens: 20,
  });
  const { internals } = localTurnHarness(kernel, [[
    { type: "turn_usage", provider: "openai", usage },
    { type: "text_delta", text: "done" },
    { type: "message_complete", stopReason: "end_turn" },
  ]]);

  try {
    internals.currentSessionId = session.id;
    const result = await internals.runTurn(baseTurnOpts("hello"));

    const modelUsage = await kernel.sessions.getModelUsagesForTurn(
      result.turnId,
    );
    assertEquals(modelUsage.length, 1);
    assertEquals(modelUsage[0]!.provider, "openai");
    assertEquals(modelUsage[0]!.model, TURN_MODEL);
    assertEquals(modelUsage[0]!.costUsd, null);
    assertEquals(modelUsage[0]!.pricingStatus, "unpriced");
  } finally {
    await db.close();
  }
});

Deno.test("runTurn sums turn_usage tokens across multiple provider requests", async () => {
  const db = await Database.create({ driver: "pglite" });
  const kernel = new Kernel(db, { composition: testStoreComposition() });
  const session = await kernel.sessions.createSession("Multi-request Usage");
  // A tool round-trip forces a SECOND provider request; the durable turn_usage must cover
  // the WHOLE turn (the sum), not just the last request (the Stage 3c accounting fix).
  const { internals } = localTurnHarness(kernel, [
    [
      {
        type: "tool_use_start",
        toolName: "list_modules",
        toolInput: {},
        toolCallId: "call_1",
      },
      {
        type: "turn_usage",
        usage: usageEvent({ inputTokens: 10, outputTokens: 2 }),
      },
      { type: "message_complete", stopReason: "requires_action" },
    ],
    [
      {
        type: "turn_usage",
        usage: usageEvent({ inputTokens: 5, outputTokens: 1 }),
      },
      { type: "text_delta", text: "done" },
      { type: "message_complete", stopReason: "end_turn" },
    ],
  ]);

  try {
    internals.currentSessionId = session.id;
    const result = await internals.runTurn(baseTurnOpts("go"));
    const recorded = await kernel.sessions.getTurnUsage(result.turnId);
    assertEquals(recorded?.inputTokens, 15);
    assertEquals(recorded?.outputTokens, 3);
  } finally {
    await db.close();
  }
});

Deno.test("runTurn persists changeset token usage after complete_changeset tool call", async () => {
  const db = await Database.create({ driver: "pglite" });
  const kernel = new Kernel(db, { composition: testComposition() });
  const session = await kernel.sessions.createSession("Changeset Usage Tail");
  const cs = await kernel.changesets.create({
    sessionId: session.id,
    title: "Complete during turn",
    plan: {
      summary: "Complete in the agent turn.",
      steps: [{ id: "s1", description: "Implement feature", status: "done" }],
      acceptanceCriteria: [{
        id: "claim_0",
        text: "The feature behavior is present.",
        source: "user",
        priority: "should",
      }],
      verificationPlan: [{
        id: "check_tests",
        claimIds: ["claim_0"],
        kind: "unit",
        description: "Run targeted unit test.",
      }],
    },
  });
  await kernel.changesets.approve(cs.id);
  const active = await kernel.changesets.startWork(cs.id);
  await kernel.changesets.recordVerificationRun(cs.id, {
    status: "passed",
    summary: "Verified with targeted unit test.",
    evidence: [{
      id: "evidence_tests",
      kind: "test_result",
      status: "passed",
      summary: "testFeature passed.",
      checkId: "check_tests",
      createdAt: "2026-09-11T10:00:02.000Z",
    }],
    claimResults: [{
      claimId: "claim_0",
      status: "passed",
      evidenceIds: ["evidence_tests"],
    }],
    residualRisks: [],
  });
  const { internals } = localTurnHarness(kernel, [
    [
      {
        type: "tool_use_start",
        toolName: "complete_changeset",
        toolInput: { changeset_id: cs.id },
        toolCallId: "call_complete",
      },
      {
        type: "turn_usage",
        usage: usageEvent({ inputTokens: 100, outputTokens: 20 }),
      },
      { type: "message_complete", stopReason: "requires_action" },
    ],
    [
      {
        type: "turn_usage",
        usage: usageEvent({ inputTokens: 40, outputTokens: 10 }),
      },
      { type: "text_delta", text: "done" },
      { type: "message_complete", stopReason: "end_turn" },
    ],
  ]);

  try {
    internals.currentSessionId = session.id;
    const events: ChatEvent[] = [];
    await internals.runTurn({
      ...baseTurnOpts("finish it"),
      activeWorkCs: active,
      onEvent: (event) => events.push(event),
    });

    const toolResult = events.find((event) =>
      event.type === "tool_use_end" && event.toolName === "complete_changeset"
    )?.toolResult as
      | { ok?: boolean; error?: { code?: string; message?: string } }
      | undefined;
    assertEquals(toolResult?.ok, true, JSON.stringify(toolResult?.error));
    const stored = await kernel.changesets.get(cs.id);
    assertEquals(stored?.status, "completed");
    assertEquals(stored?.tokenUsage?.inputTokens, 140);
    assertEquals(stored?.tokenUsage?.outputTokens, 30);
    assert((stored?.tokenUsage?.durationMs ?? 0) > 0);
    const completedEvents = events.filter((event) =>
      event.type === "changeset_completed"
    );
    assert(completedEvents.length >= 1);
    const finalEventChangeset = completedEvents.at(-1)?.changeset as
      | Changeset
      | undefined;
    assertEquals(
      finalEventChangeset?.tokenUsage?.inputTokens,
      140,
    );
  } finally {
    await db.close();
  }
});

Deno.test("runTurn starts first-turn auto-name and renames the session", async () => {
  const db = await Database.create({ driver: "pglite" });
  const kernel = new Kernel(db, { composition: testStoreComposition() });
  const session = await kernel.sessions.createSession();
  let resolveName!: (name: string) => void;
  const namePromise = new Promise<string>((resolve) => {
    resolveName = resolve;
  });
  let namingStarted = false;
  const { internals } = localTurnHarness(
    kernel,
    [[
      { type: "text_delta", text: "ok" },
      { type: "message_complete", stopReason: "end_turn" },
    ]],
    {
      nameGen: () => {
        namingStarted = true;
        return namePromise;
      },
    },
  );

  try {
    internals.currentSessionId = session.id;
    internals.autoNameEligibleSessionIds.add(session.id);
    const events: ChatEvent[] = [];
    await internals.runTurn({
      ...baseTurnOpts("name this session"),
      onEvent: (event) => events.push(event),
    });

    // The user message was stored and auto-name kicked off during the turn.
    assert(
      events.some((e) => e.type === "message_stored" && e.role === "user"),
    );
    assert(namingStarted);
    // Not renamed until the generator resolves.
    assertEquals(
      (await kernel.sessions.getSession(session.id))?.name,
      "New Session",
    );

    resolveName("Named Immediately");
    await new Promise((resolve) => setTimeout(resolve, 0));

    assertEquals(
      (await kernel.sessions.getSession(session.id))?.name,
      "Named Immediately",
    );
    assert(events.some((e) =>
      e.type === "session_renamed" &&
      e.sessionId === session.id &&
      e.sessionName === "Named Immediately"
    ));
  } finally {
    await db.close();
  }
});

Deno.test("runTurn first-turn auto-name does not overwrite a manual rename", async () => {
  const db = await Database.create({ driver: "pglite" });
  const kernel = new Kernel(db, { composition: testStoreComposition() });
  const session = await kernel.sessions.createSession();
  let resolveName!: (name: string) => void;
  const namePromise = new Promise<string>((resolve) => {
    resolveName = resolve;
  });
  const { internals } = localTurnHarness(
    kernel,
    [[
      { type: "text_delta", text: "ok" },
      { type: "message_complete", stopReason: "end_turn" },
    ]],
    { nameGen: () => namePromise },
  );

  try {
    internals.currentSessionId = session.id;
    internals.autoNameEligibleSessionIds.add(session.id);
    const events: ChatEvent[] = [];
    await internals.runTurn({
      ...baseTurnOpts("name this session"),
      onEvent: (event) => events.push(event),
    });

    await kernel.sessions.renameSession(session.id, "Manual Name");
    resolveName("Generated Name");
    await new Promise((resolve) => setTimeout(resolve, 0));

    assertEquals(
      (await kernel.sessions.getSession(session.id))?.name,
      "Manual Name",
    );
    assert(!events.some((e) => e.type === "session_renamed"));
  } finally {
    await db.close();
  }
});

Deno.test("hasSessionContextToReload stays quiet for empty new sessions", () => {
  assertEquals(hasSessionContextToReload(null, []), false);
  assertEquals(hasSessionContextToReload(session(), []), false);
  assertEquals(
    hasSessionContextToReload(session(), [
      message(1, "system", "Agent context cleared."),
    ]),
    false,
  );
});

Deno.test("hasSessionContextToReload detects persisted context", () => {
  assertEquals(
    hasSessionContextToReload(session({ summary: "Important state" }), []),
    true,
  );
  assertEquals(
    hasSessionContextToReload(session({ focus: "Fix weather overlay" }), []),
    true,
  );
  assertEquals(
    hasSessionContextToReload(session(), [message(1, "user", "Continue")]),
    true,
  );
  assertEquals(
    hasSessionContextToReload(session(), [
      {
        ...message(1, "assistant", ""),
        toolCalls: JSON.stringify([{ name: "exec_command" }]),
      },
    ]),
    true,
  );
});

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: "session_test",
    name: "New Session",
    startedAt: "2026-06-19T00:00:00.000Z",
    endedAt: null,
    summary: null,
    focus: null,
    metadata: null,
    archived: false,
    ...overrides,
  };
}

function message(
  id: number,
  role: StoredMessage["role"],
  content: string,
  kind: StoredMessage["kind"] = "chat",
): StoredMessage {
  return {
    id,
    sessionId: "session_test",
    role,
    kind,
    content,
    toolCalls: null,
    pinned: false,
    turnId: null,
    createdAt: "2026-06-19T00:00:00.000Z",
  };
}

function changeset(overrides: Partial<Changeset> = {}): Changeset {
  return {
    id: "cs_test",
    sessionId: "session_test",
    title: "Test changeset",
    description: null,
    status: "planning",
    plan: { summary: "Test plan", steps: [] },
    planMessageIds: [],
    approvalMessageId: null,
    workMessageIds: [],
    toolCalls: null,
    reasoning: null,
    tokenUsage: null,
    createdAt: "2026-06-19T00:00:00.000Z",
    updatedAt: "2026-06-19T00:00:00.000Z",
    completedAt: null,
    ...overrides,
  };
}

function turn(overrides: Partial<TurnGroup> = {}): TurnGroup {
  return {
    turnId: "turn_test",
    userMessage: "Test turn",
    turnIndex: 0,
    createdAt: "2026-06-19T00:00:00.000Z",
    changes: [],
    changesetId: null,
    ...overrides,
  };
}

function encodeBase64Utf8(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

// --- Phase 2: document context tiers (docs/document-store-plan.md §5, §7) ---

// A brain that frames its base prompt through the real composePrompt seam, so the
// getPromptOpts → composePrompt → residentDocuments path is exercised end-to-end
// (the stubBrain returns a fixed string and would hide the section).
const composingBrain: ChatIntelligence = {
  ...stubBrain,
  baseSystemPrompt: (opts) => composePrompt("BASE PROMPT", opts),
};

async function pinnedDocFixture(): Promise<{
  db: Database;
  kernel: Kernel;
  chat: ChatOrchestrator;
  projectDir: string;
  sessionId: string;
  docId: string;
  cleanup: () => Promise<void>;
}> {
  const db = await Database.create({ driver: "pglite" });
  const kernel = new Kernel(db, { composition: testStoreComposition() });
  const projectDir = mkdtempSync(join(tmpdir(), "genie-chat-docs-"));
  kernel.projectDir = projectDir;
  const session = await kernel.sessions.createSession("Docs");
  const doc = await kernel.documents.create({
    name: "Resident plan",
    kind: "text/markdown",
    content: "RESIDENT-DOC-MARKER: implement the tiers.",
    scope: "session",
    sessionId: session.id,
  });
  if (!doc.ok) throw new Error("fixture doc create failed");
  const chat = new ChatOrchestrator(
    inProcessChatBackend(kernel, () => {}),
    new MCPManager(),
    composingBrain,
    new FakeModelProvider([]),
  );
  (chat as unknown as { currentSessionId: string }).currentSessionId =
    session.id;
  return {
    db,
    kernel,
    chat,
    projectDir,
    sessionId: session.id,
    docId: doc.data.id,
    cleanup: async () => {
      await db.close();
      rmSync(projectDir, { recursive: true, force: true });
    },
  };
}

Deno.test("pinned doc enters the system prompt; unpin removes it", async () => {
  const f = await pinnedDocFixture();
  // The client-side loop composes its system prompt fresh each turn via
  // baseSystemPrompt(getPromptOpts); buildSystemPrompt exercises that same base, so a pinned
  // resident doc reaching it is the doc reaching every turn's prompt.
  const chat = f.chat as unknown as {
    buildSystemPrompt: (o: { sessionId: string }) => Promise<string>;
  };
  try {
    await f.kernel.documents.setPinned(f.docId, true, f.sessionId);

    const sys = await chat.buildSystemPrompt({ sessionId: f.sessionId });
    assert(sys.includes("## Resident documents"));
    assert(sys.includes("RESIDENT-DOC-MARKER"));

    // Unpin: the document disappears from the prompt.
    await f.kernel.documents.setPinned(f.docId, false, f.sessionId);
    const sys2 = await chat.buildSystemPrompt({ sessionId: f.sessionId });
    assert(!sys2.includes("RESIDENT-DOC-MARKER"));
  } finally {
    await f.cleanup();
  }
});

Deno.test("resolveDocumentMentions maps each kind to the right block + cites the version", async () => {
  const db = await Database.create({ driver: "pglite" });
  const kernel = new Kernel(db, { composition: testStoreComposition() });
  const projectDir = mkdtempSync(join(tmpdir(), "genie-chat-mentions-"));
  kernel.projectDir = projectDir;
  try {
    const md = await kernel.documents.create({
      name: "notes.md",
      kind: "text/markdown",
      content: "<b>HTML-ish</b> source not rendered",
      scope: "session",
      sessionId: "sess_m",
    });
    const png = await kernel.documents.create({
      name: "pixel.png",
      kind: "image/png",
      content: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      scope: "session",
      sessionId: "sess_m",
    });
    const pdf = await kernel.documents.create({
      name: "doc.pdf",
      kind: "application/pdf",
      content: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
      scope: "session",
      sessionId: "sess_m",
    });
    assert(md.ok && png.ok && pdf.ok);

    const { blocks, resolved } = await resolveDocumentMentions(
      kernel.documents,
      [
        { id: md.data.id },
        { id: png.data.id },
        { id: pdf.data.id },
        { id: "doc_missing" }, // unresolvable refs are skipped, not fatal
      ],
    ) as unknown as {
      blocks: Array<Record<string, unknown>>;
      resolved: Array<{ documentId: string; versionHash: string }>;
    };

    assertEquals(blocks.length, 3);
    // Markdown/HTML/text → text block fed as SOURCE (not rendered — §12).
    assertEquals(blocks[0]?.type, "text");
    assert(
      String(blocks[0]?.text).includes("<b>HTML-ish</b> source not rendered"),
    );
    assert(String(blocks[0]?.text).includes(md.data.currentVersionHash));
    // image/* → image block; application/pdf → document block.
    assertEquals(blocks[1]?.type, "image");
    assertEquals(blocks[2]?.type, "document");

    // Each resolved entry cites the exact version shown to the agent (provenance).
    assertEquals(resolved.map((r) => r.documentId), [
      md.data.id,
      png.data.id,
      pdf.data.id,
    ]);
    assertEquals(resolved[0]?.versionHash, md.data.currentVersionHash);
  } finally {
    await db.close();
    rmSync(projectDir, { recursive: true, force: true });
  }
});

Deno.test("recorded mention refs point at the message and cite the version", async () => {
  // Proves the resolver + DocumentStore.recordRef contract the turn wiring uses:
  // one message-role mention ref per resolved doc, versioned to the cited bytes.
  const db = await Database.create({ driver: "pglite" });
  const kernel = new Kernel(db, { composition: testStoreComposition() });
  const projectDir = mkdtempSync(join(tmpdir(), "genie-chat-refrec-"));
  kernel.projectDir = projectDir;
  try {
    const doc = await kernel.documents.create({
      name: "spec.md",
      kind: "text/markdown",
      content: "the spec",
      scope: "session",
      sessionId: "sess_r",
    });
    assert(doc.ok);
    const { resolved } = await resolveDocumentMentions(kernel.documents, [
      { id: doc.data.id },
    ]);
    for (const r of resolved) {
      const ref = await kernel.documents.recordRef({
        documentId: r.documentId,
        refType: "message",
        refId: "1001",
        role: "mention",
        versionHash: r.versionHash,
        sessionId: "sess_r",
      });
      assert(ref.ok);
    }
    const refs = await kernel.documents.listRefs(doc.data.id);
    assertEquals(refs.length, 1);
    assertEquals(refs[0]!.refType, "message");
    assertEquals(refs[0]!.role, "mention");
    assertEquals(refs[0]!.refId, "1001");
    assertEquals(refs[0]!.versionHash, doc.data.currentVersionHash);
  } finally {
    await db.close();
    rmSync(projectDir, { recursive: true, force: true });
  }
});

// A provider script that yields one assistant message then completes — enough to drive a
// turn to completion so the attachment-persistence tail runs.
const idleTurnScript: ProviderEvent[][] = [[
  { type: "text_delta", text: "ok" },
  { type: "message_complete", stopReason: "end_turn" },
]];

Deno.test("runTurn persists attachments as documents + attachment refs citing the head version, and recovers bytes", async () => {
  const db = await Database.create({ driver: "pglite" });
  const kernel = new Kernel(db, { composition: testStoreComposition() });
  const projectDir = mkdtempSync(join(tmpdir(), "genie-chat-attach-"));
  kernel.projectDir = projectDir;
  const session = await kernel.sessions.createSession("Attach");
  const { internals } = localTurnHarness(kernel, idleTurnScript);
  try {
    internals.currentSessionId = session.id;

    const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]); // %PDF-
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const textBody = "plain text attachment body — durable across reload";
    const attachments = [
      {
        name: "notes.txt",
        type: "text/plain",
        data: encodeBase64(new TextEncoder().encode(textBody)),
      },
      {
        name: "spec.pdf",
        type: "application/pdf",
        data: encodeBase64(pdfBytes),
      },
      { name: "pixel.png", type: "image/png", data: encodeBase64(pngBytes) },
    ];

    await internals.runTurn({
      ...baseTurnOpts("review these"),
      attachments,
    });

    const messages = await kernel.sessions.getMessages(session.id);
    const userMsg = messages.find((m) => m.role === "user");
    assert(userMsg, "the user message was stored");

    // Each attachment is its own session-scoped, attachment-sourced, user-created doc.
    const docs = await kernel.documents.list({
      scope: "session",
      sessionId: session.id,
    });
    assert(docs.ok);
    assertEquals(docs.data.length, 3);
    assert(
      docs.data.every((d) => d.metadata.source === ATTACHMENT_DOCUMENT_SOURCE),
    );
    assert(docs.data.every((d) => d.createdBy === "user"));

    // Each carries a message/attachment ref against the stored user message, citing head.
    const refs = await kernel.documents.listRefsByTarget(
      "message",
      String(userMsg.id),
      "attachment",
    );
    assertEquals(refs.length, 3);
    for (const ref of refs) {
      assertEquals(ref.refType, "message");
      assertEquals(ref.role, "attachment");
      assertEquals(ref.refId, String(userMsg.id));
      const doc = docs.data.find((d) => d.id === ref.documentId);
      assert(doc, "ref points at a real document");
      assertEquals(ref.versionHash, doc.currentVersionHash);
    }

    // The §1 dropped-bytes bug is fixed at the store level: the PDF bytes (dropped on
    // reload today) recover byte-exact via the ref → readContentBytes.
    const pdfDoc = docs.data.find((d) => d.kind === "application/pdf")!;
    const recovered = await kernel.documents.readContentBytes(
      pdfDoc.id,
      pdfDoc.currentVersionHash,
    );
    assert(recovered.ok);
    assertEquals(recovered.data.bytes, pdfBytes);

    // Reload half: the message's attachment refs resolve back into the right block
    // types for the agent (text → text source, image → image, pdf → document).
    const { blocks } = await resolveMessageAttachments(
      kernel.documents,
      userMsg.id,
    ) as unknown as { blocks: Array<{ type: string; text?: string }> };
    assertEquals(blocks.length, 3);
    const kinds = blocks.map((b) => b.type).sort();
    assertEquals(kinds, ["document", "image", "text"]);
    const textBlock = blocks.find((b) => b.type === "text");
    assert(String(textBlock?.text).includes(textBody));
  } finally {
    await db.close();
    rmSync(projectDir, { recursive: true, force: true });
  }
});

Deno.test("runTurn degrades to today's behavior when an attachment cannot be persisted (no project)", async () => {
  const db = await Database.create({ driver: "pglite" });
  const kernel = new Kernel(db, { composition: testStoreComposition() });
  // No projectDir: a session-scoped create() returns PROJECT_REQUIRED, which must be
  // swallowed — the turn still completes and the attachment still reaches the model live.
  const session = await kernel.sessions.createSession("NoProject");
  const { internals } = localTurnHarness(kernel, idleTurnScript);
  try {
    internals.currentSessionId = session.id;

    const attachments = [
      {
        name: "notes.txt",
        type: "text/plain",
        data: encodeBase64(new TextEncoder().encode("body")),
      },
    ];
    const result = await internals.runTurn({
      ...baseTurnOpts("review this"),
      attachments,
    });
    // The turn ran to completion; the user message was still stored.
    assert(result.turnId);
    const messages = await kernel.sessions.getMessages(session.id);
    assert(messages.some((m) => m.role === "user"));

    // No document was persisted (nothing throws; we simply fell back to today's behavior).
    const docs = await kernel.documents.list({});
    assert(docs.ok);
    assertEquals(docs.data.length, 0);
  } finally {
    await db.close();
  }
});

Deno.test("hasMultipleSteps gates per-step execution on there being >1 step left to run", () => {
  const cs = (statuses: Array<PlanStep["status"]>) =>
    ({
      plan: {
        steps: statuses.map((status, i) => ({
          id: `step_${i}`,
          description: `Step ${i}`,
          status,
        })),
      },
    }) as unknown as Changeset;

  // A single-step plan runs inline: a fresh per-step session would re-send the whole
  // system prompt + tool schemas to execute the one step the approval turn could do.
  assertEquals(hasMultipleSteps(cs(["pending"])), false);
  assertEquals(hasMultipleSteps(cs([])), false);
  // Two or more pending steps is what per-step execution exists for.
  assertEquals(hasMultipleSteps(cs(["pending", "pending"])), true);
  assertEquals(hasMultipleSteps(cs(["in_progress", "pending"])), true);
  // Only steps still to run count — a resumed plan with one step left runs inline.
  assertEquals(hasMultipleSteps(cs(["done", "done", "pending"])), false);
  assertEquals(
    hasMultipleSteps(cs(["done", "skipped", "pending", "pending"])),
    true,
  );
  assertEquals(hasMultipleSteps(cs(["done", "skipped"])), false);
});
