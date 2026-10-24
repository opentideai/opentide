// Golden-sequence tests for the client-side loop (multi-model harness). Drive
// ChatOrchestrator.runTurn / sendMessage with the deterministic, network-free
// FakeModelProvider and assert the EXACT emitted ChatEvent stream, the tool round-trip
// through the unchanged dispatchTool, and the approval pause=stop+retain (no rebuild).
// See docs/multi-model-harness-plan.md §5.
import { assert, assertEquals, assertRejects } from "@std/assert";
import { ChatOrchestrator, toNeutralContentBlocks } from "./chat.ts";
import type { ChatEvent } from "../core/chat-contract.ts";
import type { TurnResult } from "./chat.ts";
import { FakeModelProvider } from "../core/model-provider-fake.ts";
import type {
  ModelProvider,
  NeutralMessage,
  NeutralReasoningBlock,
  NeutralTool,
  NeutralToolResultBlock,
  ProviderEvent,
  TurnRequest,
} from "../core/model-provider.ts";
import type { LogEntry, TurnUsage } from "../core/types.ts";
import type { ChatIntelligence } from "../core/chat-intelligence.ts";
import { Database } from "../core/db.ts";
import { MCPManager } from "../core/mcp.ts";
import { Kernel } from "../core/registries.ts";
import {
  CACHE_COLD_PREFIX_IDLE_MS,
  CONTEXT_AUTOCOMPACT_RATIO,
  CONTEXT_LENGTH_HARD_FLOOR_MESSAGE,
  CONTEXT_NUDGE_RATIO,
  CONTEXT_PRUNE_NOTICE,
  CONTEXT_PRUNE_SAFETY_RATIO,
  CONTEXT_RETAIN_TOOL_RESULTS,
  CONTEXT_SAFETY_MARGIN,
  MAX_OUTPUT_TRUNCATED_MESSAGE,
  MAX_TURN_CONTINUATIONS,
  setKernelSettings,
  TOKEN_ESTIMATE_CHARS_PER_TOKEN,
  TURN_CONTINUATION_PROMPT,
} from "../core/config.ts";
import { PROVIDER_ERROR_CODES } from "../core/model-provider.ts";
import {
  effectiveInputBudget,
  estimateRequestTokens,
  maxOutputTokensFor,
  modelInputCapacity,
} from "../core/context-window.ts";
import { AGENT_TOOLS } from "../core/tools/definitions.ts";
import { toNeutralTools } from "../core/tools/schema-adapt.ts";
import { testStoreComposition } from "../verification/test-stores.ts";
import { defaultVerificationToolHandlers } from "../verification/verification-tool-handlers.ts";

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

// The private surface these tests reach into. The loop path is intentionally exercised
// below the public sendMessage in the translation tests (currentSessionId stays null, so
// the golden sequence is pure translation with no persistence/usage noise); the tool and
// approval tests go through the public path with a real session + changeset store.
interface LoopInternals {
  runTurn(opts: {
    content: string;
    storedContent?: string;
    onEvent?: (event: ChatEvent) => void;
    approvalStarted: boolean;
    activeWorkCs: null;
    system: string;
    tools: NeutralTool[];
    model: string;
    modelRole: "agent" | "planning";
  }): Promise<TurnResult>;
  localMessages: NeutralMessage[];
  // Replaced in the §4.7 prune tests so every tool call returns a fixed large payload
  // — the size and the ok flag are the subject, not any real tool's output.
  dispatchLocalTool(
    tu: { id: string; name: string; input: unknown },
  ): Promise<unknown>;
  provider: ModelProvider | null;
  currentSessionId: string | null;
  model: string;
  contextNudged: boolean;
  autoCompactIneffective: boolean;
  recoveredContext: string | null;
  // §4.8's cold-prefix clock: ms since epoch of the last completed provider request.
  // The tests set it directly rather than sleeping for five minutes.
  lastProviderRequestAt: number;
  lastProviderRequestModel: string | null;
}

function internals(chat: ChatOrchestrator): LoopInternals {
  return chat as unknown as LoopInternals;
}

function userMessage(text: string): NeutralMessage {
  return { role: "user", content: [{ type: "text", text }] };
}

function eventTypes(events: ChatEvent[]): string[] {
  return events.map((e) => e.type);
}

const fakeUsage: TurnUsage = {
  turnId: "provider-turn",
  sessionId: "provider-session",
  model: "fake-model",
  startedAt: "2026-08-02T00:00:00.000Z",
  endedAt: "2026-08-02T00:00:01.000Z",
  durationMs: 1000,
  inputTokens: 10,
  outputTokens: 20,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
  toolCallsCount: 0,
  costUsd: 0,
};

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

class BlockingAfterFirstDeltaProvider implements ModelProvider {
  readonly id = "blocking-fake";
  readonly supportsCaching = false;
  readonly requests: TurnRequest[] = [];
  readonly afterFirstDelta = deferred();
  readonly release = deferred();

  async *streamTurn(
    req: TurnRequest,
    signal: AbortSignal,
  ): AsyncIterable<ProviderEvent> {
    this.requests.push(req);
    if (signal.aborted) return;
    yield { type: "text_delta", text: "Visible partial." };
    this.afterFirstDelta.resolve(undefined);
    await this.release.promise;
    if (signal.aborted) return;
    yield { type: "message_complete", stopReason: "end_turn" };
  }
}

// Run a single scripted turn through runTurn with NO local session (pure
// translation: no message_stored / turn_usage / auto-name), returning the events + result.
async function runScript(
  script: ProviderEvent[][],
  seed: NeutralMessage[] = [userMessage("hi")],
): Promise<
  { events: ChatEvent[]; result: TurnResult; provider: FakeModelProvider }
> {
  const db = await Database.create({ driver: "pglite" });
  try {
    const kernel = new Kernel(db);
    const provider = new FakeModelProvider(script);
    const chat = new ChatOrchestrator(
      kernel,
      () => {},
      new MCPManager(),
      stubBrain,
      provider,
    );
    const inner = internals(chat);
    inner.localMessages = [...seed];
    const events: ChatEvent[] = [];
    const result = await inner.runTurn({
      content: "hi",
      onEvent: (e) => events.push(e),
      approvalStarted: false,
      activeWorkCs: null,
      system: "sys",
      tools: [],
      model: "fake-model",
      modelRole: "agent",
    });
    return { events, result, provider };
  } finally {
    await db.close();
  }
}

Deno.test("runTurn — text-only turn emits a byte-exact ChatEvent sequence", async () => {
  const { events, result } = await runScript([[
    { type: "text_delta", text: "Hello " },
    { type: "text_delta", text: "world" },
    { type: "message_complete", stopReason: "end_turn" },
  ]]);

  assertEquals(eventTypes(events), [
    "text_delta",
    "text_delta",
    "message_complete",
  ]);
  assertEquals(events[0]?.text, "Hello ");
  assertEquals(events[1]?.text, "world");
  assertEquals(result.stopReason, "end_turn");
  assertEquals(result.fullText, "Hello world");
});

Deno.test("sendMessage — in-progress state exposes the current streamed assistant segment", async () => {
  const db = await Database.create({ driver: "pglite" });
  try {
    const kernel = new Kernel(db, { composition: testStoreComposition() });
    const provider = new BlockingAfterFirstDeltaProvider();
    const chat = new ChatOrchestrator(
      kernel,
      () => {},
      new MCPManager(),
      stubBrain,
      provider,
    );
    internals(chat).model = "fake-model";

    const send = chat.sendMessage("hi");
    await provider.afterFirstDelta.promise;

    const state = chat.getInProgressState();
    assertEquals(state?.text, "Visible partial.");
    assertEquals(state?.segmentText, "Visible partial.");
    assertEquals(state?.toolCalls, []);
    assertEquals(state?.segmentToolCalls, []);

    provider.release.resolve(undefined);
    await send;
    assertEquals(chat.getInProgressState(), null);
  } finally {
    await db.close();
  }
});

Deno.test("getInProgressState returns compact tool results by default and full detail on request", async () => {
  const db = await Database.create({ driver: "pglite" });
  try {
    const kernel = new Kernel(db, { composition: testStoreComposition() });
    const chat = new ChatOrchestrator(
      kernel,
      () => {},
      new MCPManager(),
      stubBrain,
      new FakeModelProvider([]),
    );
    const inner = chat as unknown as {
      inProgressBusy: boolean;
      inProgressText: string;
      inProgressToolCalls: Array<
        { name: string; input: unknown; result?: unknown }
      >;
      inProgressSegmentText: string;
      inProgressSegmentToolCalls: Array<
        { name: string; input: unknown; result?: unknown }
      >;
    };
    const largeResult = {
      output: "x".repeat(10_000),
      metadata: { path: "big.log" },
    };
    inner.inProgressBusy = true;
    inner.inProgressText = "visible text";
    inner.inProgressSegmentText = "visible segment";
    inner.inProgressToolCalls = [{
      name: "read_file",
      input: { path: "big.log" },
      result: largeResult,
    }];
    inner.inProgressSegmentToolCalls = [...inner.inProgressToolCalls];

    const compact = chat.getInProgressState();
    assertEquals(compact?.text, "visible text");
    assertEquals(compact?.segmentText, "visible segment");
    assertEquals(compact?.toolCalls[0]?.result, {
      omitted: true,
      type: "object",
      keys: ["output", "metadata"],
      keyCount: 2,
    });
    assertEquals(compact?.segmentToolCalls?.[0]?.result, {
      omitted: true,
      type: "object",
      keys: ["output", "metadata"],
      keyCount: 2,
    });

    const full = chat.getInProgressState("full");
    assertEquals(full?.toolCalls[0]?.result, largeResult);
    assertEquals(full?.segmentToolCalls?.[0]?.result, largeResult);
  } finally {
    await db.close();
  }
});

Deno.test("runTurn — thinking_delta is buffered, flushed once at thinking_end", async () => {
  const { events } = await runScript([[
    { type: "thinking_start" },
    { type: "thinking_delta", text: "let me " },
    { type: "thinking_delta", text: "think" },
    { type: "thinking_end" },
    { type: "text_delta", text: "answer" },
    { type: "message_complete", stopReason: "end_turn" },
  ]]);

  // No per-delta ChatEvent (buffered); a single thinking_end carries the joined text.
  assertEquals(eventTypes(events), [
    "thinking_start",
    "thinking_end",
    "text_delta",
    "message_complete",
  ]);
  assertEquals(events[1]?.text, "let me think");
  assertEquals(events[2]?.text, "answer");
});

Deno.test("runTurn — model_request_usage passes through mid-stream", async () => {
  const { events } = await runScript([[
    { type: "model_request_usage", usage: fakeUsage },
    { type: "text_delta", text: "ok" },
    { type: "message_complete", stopReason: "end_turn" },
  ]]);

  assertEquals(eventTypes(events), [
    "model_request_usage",
    "text_delta",
    "message_complete",
  ]);
  assertEquals(events[0]?.usage?.inputTokens, 10);
});

Deno.test("runTurn — error event surfaces then the turn completes with stopReason error", async () => {
  const { events, result } = await runScript([[
    { type: "text_delta", text: "partial" },
    { type: "error", error: { code: "PROVIDER_ERROR", message: "boom" } },
  ]]);

  assertEquals(eventTypes(events), ["text_delta", "error", "message_complete"]);
  assertEquals(events[1]?.text, "boom");
  assertEquals(result.stopReason, "error");
});

Deno.test("runTurn — message_complete with stopReason error is terminal error", async () => {
  const { result, events } = await runScript([[
    { type: "message_complete", stopReason: "error" },
  ]]);

  assertEquals(eventTypes(events), ["message_complete"]);
  assertEquals(result.stopReason, "error");
});

Deno.test("runTurn — single tool round-trip dispatches, appends result, resumes the loop", async () => {
  const { events, result, provider } = await runScript([
    [
      {
        type: "tool_use_start",
        toolName: "list_modules",
        toolInput: {},
        toolCallId: "call_1",
      },
      { type: "message_complete", stopReason: "requires_action" },
    ],
    [
      { type: "text_delta", text: "done" },
      { type: "message_complete", stopReason: "end_turn" },
    ],
  ]);

  assertEquals(eventTypes(events), [
    "tool_use_start",
    "tool_use_end",
    "text_delta",
    "message_complete",
  ]);
  assertEquals(events[0]?.toolName, "list_modules");
  // dispatchTool ran and produced a result that was surfaced on tool_use_end.
  assert(events[1]?.toolResult !== undefined, "tool result should be appended");
  // The loop resumed: a SECOND provider request was made and produced the final text.
  assertEquals(provider.requests.length, 2);
  assertEquals(result.stopReason, "end_turn");
  assertEquals(result.fullText, "done");
  assertEquals(result.toolCalls.length, 1);
  assertEquals(result.toolCalls[0]?.name, "list_modules");
});

Deno.test("runTurn — retained array carries assistant tool_use + tool_result across the loop", async () => {
  const db = await Database.create({ driver: "pglite" });
  try {
    const kernel = new Kernel(db);
    const provider = new FakeModelProvider([
      [
        {
          type: "tool_use_start",
          toolName: "list_modules",
          toolInput: {},
          toolCallId: "call_1",
        },
        { type: "message_complete", stopReason: "requires_action" },
      ],
      [
        { type: "text_delta", text: "done" },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]);
    const chat = new ChatOrchestrator(
      kernel,
      () => {},
      new MCPManager(),
      stubBrain,
      provider,
    );
    const inner = internals(chat);
    inner.localMessages = [userMessage("run it")];

    await inner.runTurn({
      content: "run it",
      approvalStarted: false,
      activeWorkCs: null,
      system: "sys",
      tools: [],
      model: "fake-model",
      modelRole: "agent",
    });

    // user, assistant(tool_use), tool(tool_result), assistant(text)
    assertEquals(inner.localMessages.length, 4);
    assertEquals(inner.localMessages[1]?.role, "assistant");
    assertEquals(inner.localMessages[1]?.content[0]?.type, "tool_use");
    assertEquals(inner.localMessages[2]?.role, "tool");
    assertEquals(inner.localMessages[2]?.content[0]?.type, "tool_result");
    assertEquals(inner.localMessages[3]?.content[0]?.type, "text");
  } finally {
    await db.close();
  }
});

Deno.test("runTurn — multi-tool turn dispatches every call then resumes", async () => {
  const { events, result, provider } = await runScript([
    [
      {
        type: "tool_use_start",
        toolName: "list_modules",
        toolInput: {},
        toolCallId: "call_1",
      },
      {
        type: "tool_use_start",
        toolName: "list_modules",
        toolInput: {},
        toolCallId: "call_2",
      },
      { type: "message_complete", stopReason: "requires_action" },
    ],
    [
      { type: "text_delta", text: "both done" },
      { type: "message_complete", stopReason: "end_turn" },
    ],
  ]);

  assertEquals(eventTypes(events), [
    "tool_use_start",
    "tool_use_start",
    "tool_use_end",
    "tool_use_end",
    "text_delta",
    "message_complete",
  ]);
  assertEquals(result.toolCalls.length, 2);
  assertEquals(provider.requests.length, 2);
  assertEquals(result.fullText, "both done");
});

Deno.test("sendMessage — approval pause stops + retains the array, resume continues, no session rebuild", async () => {
  // This test exercises the SINGLE-TURN local resume (D2 pause=stop+retain). Since Stage 3d
  // the local loop honors perStepExecution (G7), so an approval would otherwise route to the
  // per-step driver; pin it off (with an isolated HOME so the config write is scoped) to keep
  // testing the single-turn path.
  const prevHome = Deno.env.get("HOME");
  const tmpHome = await Deno.makeTempDir({ prefix: "local-loop-home-" });
  Deno.env.set("HOME", tmpHome);
  setKernelSettings({ perStepExecution: false });
  const db = await Database.create({ driver: "pglite" });
  try {
    // The create_changeset TOOL runs the verification plan validator, so the
    // composition must carry the verification tool handlers (not just the stores).
    const kernel = new Kernel(db, {
      composition: {
        ...testStoreComposition(),
        verificationTools: defaultVerificationToolHandlers,
      },
    });
    const provider = new FakeModelProvider([
      // Turn A: propose a plan → create_changeset → pause for approval.
      [
        { type: "text_delta", text: "Here is my plan." },
        {
          type: "tool_use_start",
          toolName: "create_changeset",
          toolInput: {
            title: "Add a widget",
            plan: {
              summary: "Add a widget.",
              steps: ["build it"],
              acceptanceCriteria: [
                {
                  id: "c1",
                  text: "widget exists",
                  source: "agent",
                  priority: "must",
                },
              ],
              verificationPlan: [
                {
                  id: "v1",
                  claimIds: ["c1"],
                  kind: "unit",
                  description: "exercise the widget",
                },
              ],
            },
          },
          toolCallId: "call_cs",
        },
        { type: "message_complete", stopReason: "requires_action" },
      ],
      // Turn B: after approval, continue.
      [
        { type: "text_delta", text: "Done." },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]);
    const approvingBrain: ChatIntelligence = {
      ...stubBrain,
      isApprovalMessage: (content) => content.includes("approve"),
    };
    const chat = new ChatOrchestrator(
      kernel,
      () => {},
      new MCPManager(),
      approvingBrain,
      provider,
    );
    const inner = internals(chat);

    const eventsA: ChatEvent[] = [];
    await chat.sendMessage("please propose a plan", (e) => eventsA.push(e));

    // Pause: a changeset was created and the loop stopped for approval.
    assert(
      eventsA.some((e) => e.type === "changeset_created"),
      "expected a changeset_created event on the pause turn",
    );
    assert(
      eventsA.some((e) =>
        e.type === "text_delta" && (e.text ?? "").includes("approval")
      ),
      "expected the waiting-for-approval notice",
    );
    // The retained array holds the paused turn: user, assistant(tool_use), tool(result).
    const retainedLength = inner.localMessages.length;
    assertEquals(retainedLength, 3);
    assertEquals(
      inner.localMessages[1]?.content.some((b) => b.type === "tool_use"),
      true,
    );

    const activeAfterPause = await kernel.changesets.getActive(
      chat.getCurrentSessionId() ?? undefined,
    );
    assertEquals(activeAfterPause?.status, "planning");

    // Resume: approve → the loop continues from the SAME retained array.
    const eventsB: ChatEvent[] = [];
    const text = await chat.sendMessage(
      "yes, approve and continue",
      (e) => eventsB.push(e),
    );

    assertEquals(text, "Done.");
    assert(eventsB.some((e) => e.type === "text_delta" && e.text === "Done."));
    // Array retained and GREW (prior tool_use message still present at index 1).
    assert(
      inner.localMessages.length > retainedLength,
      "array should be retained and extended",
    );
    assertEquals(
      inner.localMessages[1]?.content.some((b) => b.type === "tool_use"),
      true,
    );
    // Two provider requests total: propose + continue.
    assertEquals(provider.requests.length, 2);
    // The changeset is now in progress (approval flipped it).
    const activeAfterResume = await kernel.changesets.getActive(
      chat.getCurrentSessionId() ?? undefined,
    );
    assertEquals(activeAfterResume?.status, "in_progress");
  } finally {
    await db.close();
    if (prevHome) Deno.env.set("HOME", prevHome);
    else Deno.env.delete("HOME");
    await Deno.remove(tmpHome, { recursive: true });
  }
});

Deno.test("sendMessage — changeset_created does not replace the preceding streamed assistant segment", async () => {
  const prevHome = Deno.env.get("HOME");
  const tmpHome = await Deno.makeTempDir({ prefix: "local-loop-home-" });
  Deno.env.set("HOME", tmpHome);
  setKernelSettings({ perStepExecution: false });
  const db = await Database.create({ driver: "pglite" });
  try {
    const kernel = new Kernel(db, {
      composition: {
        ...testStoreComposition(),
        verificationTools: defaultVerificationToolHandlers,
      },
    });
    const provider = new FakeModelProvider([[
      { type: "text_delta", text: "Here is my plan." },
      {
        type: "tool_use_start",
        toolName: "create_changeset",
        toolInput: {
          title: "Add a widget",
          plan: {
            summary: "Add a widget.",
            steps: ["build it"],
            acceptanceCriteria: [{
              id: "c1",
              text: "widget exists",
              source: "agent",
              priority: "must",
            }],
            verificationPlan: [{
              id: "v1",
              claimIds: ["c1"],
              kind: "unit",
              description: "exercise the widget",
            }],
          },
        },
        toolCallId: "call_cs",
      },
      { type: "message_complete", stopReason: "requires_action" },
    ]]);
    const chat = new ChatOrchestrator(
      kernel,
      () => {},
      new MCPManager(),
      stubBrain,
      provider,
    );
    internals(chat).model = "fake-model";

    const events: ChatEvent[] = [];
    await chat.sendMessage("please propose a plan", (e) => events.push(e));

    const assistantStoredIndex = events.findIndex((e) =>
      e.type === "message_stored" && e.role === "assistant"
    );
    const changesetCreatedIndex = events.findIndex((e) =>
      e.type === "changeset_created"
    );
    assert(assistantStoredIndex >= 0, "expected assistant message_stored");
    assert(changesetCreatedIndex > assistantStoredIndex);

    const assistantId = events[assistantStoredIndex]?.messageId;
    assert(assistantId, "expected stored assistant id");
    const sessionId = chat.getCurrentSessionId();
    assert(sessionId, "expected current session");
    const storedMessages = await kernel.sessions.getMessages(sessionId);
    const storedAssistant = storedMessages.find((m) => m.id === assistantId);
    assertEquals(storedAssistant?.content, "Here is my plan.");
    const storedToolCalls = JSON.parse(
      storedAssistant?.toolCalls ?? "[]",
    ) as Array<{ name?: string }>;
    assertEquals(storedToolCalls[0]?.name, "create_changeset");

    const created = events[changesetCreatedIndex]?.changeset as
      | { planMessageIds?: number[] }
      | undefined;
    assertEquals(created?.planMessageIds, [assistantId]);
    assert(
      events.some((e) =>
        e.type === "text_delta" &&
        (e.text ?? "").includes("Waiting for your approval")
      ),
      "approval notice should stream after the stored plan segment",
    );
  } finally {
    await db.close();
    if (prevHome) Deno.env.set("HOME", prevHome);
    else Deno.env.delete("HOME");
    await Deno.remove(tmpHome, { recursive: true });
  }
});

Deno.test("sendMessage discards archived current session and writes to a fresh session", async () => {
  const db = await Database.create({ driver: "pglite" });
  try {
    const kernel = new Kernel(db, { composition: testStoreComposition() });
    const archived = await kernel.sessions.createSession("Archived");
    await kernel.sessions.archiveSession(archived.id);
    const provider = new FakeModelProvider([
      [
        { type: "text_delta", text: "fresh" },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]);
    const chat = new ChatOrchestrator(
      kernel,
      () => {},
      new MCPManager(),
      stubBrain,
      provider,
    );
    const inner = internals(chat);
    inner.currentSessionId = archived.id;

    await chat.sendMessage("hello");

    const archivedMessages = await kernel.sessions.getMessages(archived.id);
    assertEquals(archivedMessages, []);
    const currentId = chat.getCurrentSessionId();
    assert(currentId);
    assert(currentId !== archived.id);
    const current = await kernel.sessions.getSession(currentId);
    assertEquals(current?.archived, false);
    const currentMessages = await kernel.sessions.getMessages(currentId);
    assertEquals(currentMessages.map((m) => [m.role, m.content]), [
      ["user", "hello"],
      ["assistant", "fresh"],
    ]);
  } finally {
    await db.close();
  }
});

Deno.test("resumeSession rejects archived sessions until they are unarchived", async () => {
  const db = await Database.create({ driver: "pglite" });
  try {
    const kernel = new Kernel(db, { composition: testStoreComposition() });
    const archived = await kernel.sessions.createSession("Archived");
    await kernel.sessions.archiveSession(archived.id);
    const chat = new ChatOrchestrator(
      kernel,
      () => {},
      new MCPManager(),
      stubBrain,
      new FakeModelProvider([]),
    );

    await assertRejects(
      () => chat.resumeSession(archived.id),
      Error,
      "Archived sessions must be unarchived before resuming",
    );
  } finally {
    await db.close();
  }
});

// A scripted per-request turn_usage event carrying known token counts, so a turn's
// occupancy/pressure math is deterministic (context-hardening plan, Slice 2).
function usageEvent(overrides: Partial<TurnUsage>): ProviderEvent {
  return { type: "turn_usage", usage: { ...fakeUsage, ...overrides } };
}

// Run one scripted turn through runTurn against a REAL session (unlike runScript,
// which keeps currentSessionId null): so the turn-tail persistence + context_pressure
// emit fire. Returns the emitted events plus the session's post-turn summary/metadata.
async function runSessionTurn(opts: {
  script: ProviderEvent[][];
  model?: string;
  preset?: (kernel: Kernel, sessionId: string) => Promise<void>;
}): Promise<
  { events: ChatEvent[]; metadata: string | null; summary: string | null }
> {
  const db = await Database.create({ driver: "pglite" });
  try {
    const kernel = new Kernel(db, { composition: testStoreComposition() });
    const session = await kernel.sessions.createSession("ctx");
    if (opts.preset) await opts.preset(kernel, session.id);
    const provider = new FakeModelProvider(opts.script);
    const chat = new ChatOrchestrator(
      kernel,
      () => {},
      new MCPManager(),
      stubBrain,
      provider,
    );
    const inner = internals(chat);
    inner.currentSessionId = session.id;
    inner.localMessages = [userMessage("hi")];
    const events: ChatEvent[] = [];
    await inner.runTurn({
      content: "hi",
      onEvent: (e) => events.push(e),
      approvalStarted: false,
      activeWorkCs: null,
      system: "sys",
      tools: [],
      model: opts.model ?? "fake-model",
      modelRole: "agent",
    });
    const after = await kernel.sessions.getSession(session.id);
    return {
      events,
      metadata: after?.metadata ?? null,
      summary: after?.summary ?? null,
    };
  } finally {
    await db.close();
  }
}

Deno.test("runTurn — context_pressure sums all three input categories against the model budget, right after turn_usage", async () => {
  const { events } = await runSessionTurn({
    model: "fake-model",
    script: [[
      usageEvent({
        inputTokens: 40_000,
        outputTokens: 500,
        cacheCreationInputTokens: 6_000,
        cacheReadInputTokens: 20_000,
      }),
      { type: "text_delta", text: "ok" },
      { type: "message_complete", stopReason: "end_turn" },
    ]],
  });

  const usageIdx = events.findIndex((e) => e.type === "turn_usage");
  const pressureIdx = events.findIndex((e) => e.type === "context_pressure");
  assert(usageIdx >= 0, "expected a turn_usage event");
  // Sibling emitted immediately after turn_usage.
  assertEquals(pressureIdx, usageIdx + 1);

  const occupancy = 40_000 + 20_000 + 6_000;
  const budget = effectiveInputBudget("fake-model");
  const cp = events[pressureIdx]?.contextPressure;
  assertEquals(cp?.occupancy, occupancy);
  assertEquals(cp?.budget, budget);
  assertEquals(cp?.pressure, occupancy / budget);
  assertEquals(cp?.model, "fake-model");
  assertEquals(cp?.outputReservation, maxOutputTokensFor("fake-model"));
  assertEquals(cp?.safetyMargin, CONTEXT_SAFETY_MARGIN);
  assertEquals(cp?.source, "provider");
});

Deno.test("runTurn — occupancy is the LAST request's context size, not the whole-turn sum (multi-request turn)", async () => {
  // A tool round-trip makes two provider requests in one turn; each re-sends the
  // (growing) context, so summing per-request input tokens would count the static
  // prefix twice and inflate occupancy. Occupancy must be the last request's three
  // input categories — the current context size. Cost (turn_usage) still sums.
  const db = await Database.create({ driver: "pglite" });
  try {
    const kernel = new Kernel(db);
    const session = await kernel.sessions.createSession("ctx");
    const provider = new FakeModelProvider([
      // Request 1: list_modules → requires_action. Carries this request's usage.
      [
        usageEvent({
          inputTokens: 40_000,
          cacheReadInputTokens: 10_000,
          cacheCreationInputTokens: 5_000,
        }),
        {
          type: "tool_use_start",
          toolName: "list_modules",
          toolInput: {},
          toolCallId: "call_1",
        },
        { type: "message_complete", stopReason: "requires_action" },
      ],
      // Request 2 (after the tool result): the LARGER, current context. end_turn.
      [
        usageEvent({
          inputTokens: 42_000,
          cacheReadInputTokens: 12_000,
          cacheCreationInputTokens: 0,
        }),
        { type: "text_delta", text: "done" },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]);
    const chat = new ChatOrchestrator(
      kernel,
      () => {},
      new MCPManager(),
      stubBrain,
      provider,
    );
    const inner = internals(chat);
    inner.currentSessionId = session.id;
    inner.localMessages = [userMessage("run it")];
    const events: ChatEvent[] = [];
    await inner.runTurn({
      content: "run it",
      onEvent: (e) => events.push(e),
      approvalStarted: false,
      activeWorkCs: null,
      system: "sys",
      tools: [],
      model: "fake-model",
      modelRole: "agent",
    });

    assertEquals(provider.requests.length, 2, "expected a two-request turn");

    // Occupancy = LAST request's categories, NOT the sum across both requests.
    const lastOccupancy = 42_000 + 12_000 + 0;
    const summedOccupancy = 40_000 + 10_000 + 5_000 + 42_000 + 12_000 + 0;
    const cp = events.find((e) => e.type === "context_pressure")
      ?.contextPressure;
    assertEquals(cp?.occupancy, lastOccupancy);
    assert(
      cp?.occupancy !== summedOccupancy,
      "occupancy must not be the whole-turn sum (the old over-counting bug)",
    );
    assertEquals(
      cp?.pressure,
      lastOccupancy / effectiveInputBudget("fake-model"),
    );

    // Cost (turn_usage) still sums every request's input tokens.
    const usage = events.find((e) => e.type === "turn_usage")?.usage;
    assertEquals(usage?.inputTokens, 40_000 + 42_000);
  } finally {
    await db.close();
  }
});

Deno.test("runTurn — persists lastContextTokens/lastContextPressure without clobbering existing metadata or summary", async () => {
  const occupancy = 30_000 + 10_000;
  const budget = effectiveInputBudget("fake-model");
  const { metadata, summary } = await runSessionTurn({
    model: "fake-model",
    preset: (kernel, id) =>
      kernel.sessions.updateSummaryMetadata(
        id,
        "prior summary",
        JSON.stringify({ summaryKind: "auto" }),
      ),
    script: [[
      usageEvent({
        inputTokens: 30_000,
        cacheReadInputTokens: 10_000,
        cacheCreationInputTokens: 0,
      }),
      { type: "text_delta", text: "ok" },
      { type: "message_complete", stopReason: "end_turn" },
    ]],
  });

  assert(metadata, "expected metadata to be written");
  const parsed = JSON.parse(metadata) as Record<string, unknown>;
  assertEquals(parsed.lastContextTokens, occupancy);
  assertEquals(parsed.lastContextOccupancyTokens, occupancy);
  assertEquals(parsed.lastContextBudget, budget);
  assertEquals(parsed.lastContextPressure, occupancy / budget);
  assertEquals(parsed.lastContextModel, "fake-model");
  assertEquals(typeof parsed.lastContextMeasuredAt, "string");
  assertEquals(
    parsed.lastContextOutputReservation,
    maxOutputTokensFor("fake-model"),
  );
  assertEquals(parsed.lastContextSafetyMargin, CONTEXT_SAFETY_MARGIN);
  assertEquals(parsed.lastContextSource, "provider");
  // The pre-existing metadata key and the summary both survive the read-modify-write.
  assertEquals(parsed.summaryKind, "auto");
  assertEquals(summary, "prior summary");
});

Deno.test("runTurn — preserves null summary while writing context metadata", async () => {
  const { metadata, summary } = await runSessionTurn({
    script: [[
      usageEvent({ inputTokens: 12_000 }),
      { type: "text_delta", text: "ok" },
      { type: "message_complete", stopReason: "end_turn" },
    ]],
  });

  assert(metadata, "expected metadata to be written");
  assertEquals(summary, null);
});

Deno.test("runTurn — no context_pressure event when there is no session", async () => {
  const { events } = await runScript([[
    usageEvent({ inputTokens: 40_000 }),
    { type: "text_delta", text: "ok" },
    { type: "message_complete", stopReason: "end_turn" },
  ]]);

  assert(!events.some((e) => e.type === "context_pressure"));
  // The whole tail is gated on currentSessionId, so turn_usage is suppressed too.
  assert(!events.some((e) => e.type === "turn_usage"));
});

Deno.test("runTurn — no context_pressure event or metadata write when the turn reports no usage", async () => {
  const { events, metadata } = await runSessionTurn({
    preset: (kernel, id) =>
      kernel.sessions.updateSummaryMetadata(
        id,
        "",
        JSON.stringify({ summaryKind: "auto" }),
      ),
    script: [[
      { type: "text_delta", text: "ok" },
      { type: "message_complete", stopReason: "end_turn" },
    ]],
  });

  assert(!events.some((e) => e.type === "context_pressure"));
  const parsed = JSON.parse(metadata ?? "{}") as Record<string, unknown>;
  assert(
    !("lastContextTokens" in parsed),
    "no usage → no context keys written",
  );
  assertEquals(parsed.summaryKind, "auto");
});

// Multi-turn variant of runSessionTurn (Slice 3): runs each scripted turn on the
// SAME orchestrator + session, so cross-turn arm-once state is exercised. The script
// array is grown lazily per runTurn call — FakeModelProvider reads its script by index
// at streamTurn time, so pushing the next turn just before each call is visible. The
// callback can act on the chat between turns (e.g. compactSession) to test re-arming.
async function withCtxSession(
  fn: (h: {
    kernel: Kernel;
    chat: ChatOrchestrator;
    runTurn: (turn: ProviderEvent[], model?: string) => Promise<ChatEvent[]>;
  }) => Promise<void>,
): Promise<void> {
  const db = await Database.create({ driver: "pglite" });
  try {
    const kernel = new Kernel(db, { composition: testStoreComposition() });
    const session = await kernel.sessions.createSession("ctx");
    const script: ProviderEvent[][] = [];
    const provider = new FakeModelProvider(script);
    const chat = new ChatOrchestrator(
      kernel,
      () => {},
      new MCPManager(),
      stubBrain,
      provider,
    );
    const inner = internals(chat);
    inner.currentSessionId = session.id;
    const runTurn = async (turn: ProviderEvent[], model = "fake-model") => {
      script.push(turn);
      inner.localMessages = [userMessage("hi")];
      const events: ChatEvent[] = [];
      await inner.runTurn({
        content: "hi",
        onEvent: (e) => events.push(e),
        approvalStarted: false,
        activeWorkCs: null,
        system: "sys",
        tools: [],
        model,
        modelRole: "agent",
      });
      return events;
    };
    await fn({ kernel, chat, runTurn });
  } finally {
    await db.close();
  }
}

// Above/below the CONTEXT_NUDGE_RATIO (0.80) crossing for "fake-model" — budget is
// effectiveInputBudget("fake-model") = 92_000, so 80_000 ≈ 0.87 crosses and 40_000
// ≈ 0.43 does not (occupancy = inputTokens; cache categories default to 0).
function turnWithInput(inputTokens: number): ProviderEvent[] {
  return [
    usageEvent({ inputTokens }),
    { type: "text_delta", text: "ok" },
    { type: "message_complete", stopReason: "end_turn" },
  ];
}
const ABOVE_NUDGE_INPUT = 80_000;
const BELOW_NUDGE_INPUT = 40_000;

Deno.test("runTurn — a turn crossing the nudge ratio emits exactly one context_warning, payload matching context_pressure", async () => {
  await withCtxSession(async ({ runTurn }) => {
    const events = await runTurn(turnWithInput(ABOVE_NUDGE_INPUT));

    const warnings = events.filter((e) => e.type === "context_warning");
    assertEquals(warnings.length, 1);

    const pressure = events.find((e) => e.type === "context_pressure");
    const warning = warnings[0];
    // The warning reuses the exact pressure payload Slice 2 computed, plus copy.
    assertEquals(warning?.contextPressure, pressure?.contextPressure);
    assert((warning?.contextPressure?.pressure ?? 0) >= 0.80);
    assert(
      typeof warning?.text === "string" && warning.text.length > 0,
      "context_warning carries human copy",
    );
  });
});

Deno.test("runTurn — a turn below the nudge ratio emits no context_warning", async () => {
  await withCtxSession(async ({ runTurn }) => {
    const events = await runTurn(turnWithInput(BELOW_NUDGE_INPUT));
    assert(events.some((e) => e.type === "context_pressure"));
    assert(!events.some((e) => e.type === "context_warning"));
  });
});

Deno.test("runTurn — two consecutive above-threshold turns warn only once (arm-once holds)", async () => {
  await withCtxSession(async ({ runTurn }) => {
    const first = await runTurn(turnWithInput(ABOVE_NUDGE_INPUT));
    const second = await runTurn(turnWithInput(ABOVE_NUDGE_INPUT));
    assertEquals(first.filter((e) => e.type === "context_warning").length, 1);
    assertEquals(second.filter((e) => e.type === "context_warning").length, 0);
  });
});

Deno.test("runTurn — compaction re-arms the nudge for the next crossing", async () => {
  await withCtxSession(async ({ chat, runTurn }) => {
    const first = await runTurn(turnWithInput(ABOVE_NUDGE_INPUT));
    assertEquals(first.filter((e) => e.type === "context_warning").length, 1);

    // compactSession resets localMessages in place → resetContextNudge.
    await chat.compactSession("summary");

    const afterCompact = await runTurn(turnWithInput(ABOVE_NUDGE_INPUT));
    assertEquals(
      afterCompact.filter((e) => e.type === "context_warning").length,
      1,
      "compaction re-arms the nudge",
    );
  });
});

Deno.test("runTurn — a turn dropping below the ratio re-arms the next crossing", async () => {
  await withCtxSession(async ({ runTurn }) => {
    const first = await runTurn(turnWithInput(ABOVE_NUDGE_INPUT));
    assertEquals(first.filter((e) => e.type === "context_warning").length, 1);

    // A turn that reports pressure back under the ratio re-arms without a compaction.
    const dropped = await runTurn(turnWithInput(BELOW_NUDGE_INPUT));
    assertEquals(dropped.filter((e) => e.type === "context_warning").length, 0);

    const third = await runTurn(turnWithInput(ABOVE_NUDGE_INPUT));
    assertEquals(
      third.filter((e) => e.type === "context_warning").length,
      1,
      "dropping under the ratio re-arms the next crossing",
    );
  });
});

// --- Slice 4: 95% pre-turn auto-compaction ---------------------------------

// Drive the PUBLIC sendMessage path (the pre-turn auto-compact guard runs there, not
// in runTurn) under an ISOLATED HOME so getKernelSettings / getAnthropicApiKey read a
// fresh default config: no ambient API key (self-generated summary falls back to the
// deterministic builder — no network) and autoCompactEnabled defaults on. The model is
// forced to "fake-model" so effectiveInputBudget = 92_000 is deterministic. `configure`
// runs after HOME is isolated so a setKernelSettings write is scoped and restored.
async function withSendMessage(
  opts: {
    script: ProviderEvent[][];
    content?: string;
    seedMessages?: NeutralMessage[];
    brain?: ChatIntelligence;
    preset?: (kernel: Kernel, sessionId: string) => Promise<void>;
    configure?: () => void;
    // Extra sendMessage calls after the first, on the SAME orchestrator — the only
    // way to observe across-turn state (e.g. the compaction-loop brake). Their
    // events land in `eventBatches[1..]`; `events` stays the first send's, so every
    // single-send test above is untouched.
    followUps?: Array<
      string | ((h: { chat: ChatOrchestrator }) => Promise<string>)
    >;
  },
  fn: (h: {
    events: ChatEvent[];
    eventBatches: ChatEvent[][];
    startSessionId: string;
    endSessionId: string | null;
    chat: ChatOrchestrator;
    inner: LoopInternals;
    kernel: Kernel;
    provider: FakeModelProvider;
  }) => Promise<void>,
): Promise<void> {
  const prevHome = Deno.env.get("HOME");
  const tmpHome = await Deno.makeTempDir({ prefix: "slice4-home-" });
  Deno.env.set("HOME", tmpHome);
  const db = await Database.create({ driver: "pglite" });
  try {
    opts.configure?.();
    const kernel = new Kernel(db, { composition: testStoreComposition() });
    const session = await kernel.sessions.createSession("ctx");
    if (opts.preset) await opts.preset(kernel, session.id);
    const provider = new FakeModelProvider(opts.script);
    const chat = new ChatOrchestrator(
      kernel,
      () => {},
      new MCPManager(),
      opts.brain ?? stubBrain,
      provider,
    );
    const inner = internals(chat);
    inner.currentSessionId = session.id;
    inner.model = "fake-model";
    if (opts.seedMessages) inner.localMessages = opts.seedMessages;
    const events: ChatEvent[] = [];
    await chat.sendMessage(opts.content ?? "hi", (e) => events.push(e));
    const eventBatches: ChatEvent[][] = [events];
    for (const followUp of opts.followUps ?? []) {
      const content = typeof followUp === "string"
        ? followUp
        : await followUp({ chat });
      const batch: ChatEvent[] = [];
      await chat.sendMessage(content, (e) => batch.push(e));
      eventBatches.push(batch);
    }
    await fn({
      events,
      eventBatches,
      startSessionId: session.id,
      endSessionId: chat.getCurrentSessionId(),
      chat,
      inner,
      kernel,
      provider,
    });
  } finally {
    await db.close();
    if (prevHome) Deno.env.set("HOME", prevHome);
    else Deno.env.delete("HOME");
    await Deno.remove(tmpHome, { recursive: true });
  }
}

// A scripted post-compaction turn: a small, sub-threshold turn so the fresh window
// reads low (the compaction re-arm holds) and the turn completes cleanly.
const SMALL_TURN: ProviderEvent[] = [
  usageEvent({ inputTokens: 100 }),
  { type: "text_delta", text: "ok" },
  { type: "message_complete", stopReason: "end_turn" },
];

// Seed a session's persisted context pressure (Slice 2's metadata write) so the
// reactive gate has a value to read, optionally with a focus + a pinned message so a
// compaction's carry-over can be asserted.
async function presetPressure(
  kernel: Kernel,
  sessionId: string,
  pressure: number,
  opts?: { focus?: string; pin?: string; model?: string; legacy?: boolean },
): Promise<void> {
  const model = opts?.model ?? "fake-model";
  const budget = effectiveInputBudget(model);
  await kernel.sessions.updateSummaryMetadata(
    sessionId,
    "prior summary",
    JSON.stringify(
      opts?.legacy ? { lastContextPressure: pressure } : {
        lastContextPressure: pressure,
        lastContextOccupancyTokens: Math.round(pressure * budget),
        lastContextBudget: budget,
        lastContextModel: model,
        lastContextMeasuredAt: "2026-08-08T00:00:00.000Z",
      },
    ),
  );
  if (opts?.focus) await kernel.sessions.updateFocus(sessionId, opts.focus);
  if (opts?.pin) {
    const msg = await kernel.sessions.addMessage({
      sessionId,
      role: "user",
      content: opts.pin,
    });
    await kernel.sessions.pinMessage(msg.id);
  }
}

Deno.test("sendMessage — reactive gate: persisted pressure ≥ 0.95 auto-compacts before the turn", async () => {
  await withSendMessage(
    {
      script: [SMALL_TURN],
      content: "hi",
      preset: (kernel, id) =>
        presetPressure(kernel, id, 0.97, { focus: "ship it", pin: "keep me" }),
    },
    async ({ events, startSessionId, endSessionId, kernel, inner }) => {
      // Compacted IN PLACE before the turn — same session, not a new one.
      assert(endSessionId, "expected a current session after the turn");
      assertEquals(
        endSessionId,
        startSessionId,
        "reactive gate compacts in place (no session switch)",
      );

      // Exactly one session_compacted event, pointing at the SAME session.
      const compacted = events.filter((e) => e.type === "session_compacted");
      assertEquals(compacted.length, 1);
      assertEquals(compacted[0]?.sessionId, startSessionId);
      assert(
        typeof compacted[0]?.text === "string" &&
          (compacted[0]?.text?.length ?? 0) > 0,
        "session_compacted carries inline copy",
      );

      // Focus + pin still present in the same (untouched) session.
      const fresh = await kernel.sessions.getSession(startSessionId!);
      assertEquals(fresh?.focus, "ship it");
      const pins = await kernel.sessions.getPinnedMessages(startSessionId!);
      assert(
        pins.some((m) => m.content === "keep me"),
        "pinned message survives the in-place compaction",
      );

      // The scripted turn still ran, on the fresh (post-compaction) array.
      assert(
        events.some((e) => e.type === "text_delta" && e.text === "ok"),
        "the turn ran after compaction",
      );

      // The nudge re-armed (a fresh window) and the fresh turn was sub-threshold.
      assertEquals(inner.contextNudged, false);
    },
  );
});

Deno.test("sendMessage — reactive gate ignores legacy pressure-only metadata", async () => {
  await withSendMessage(
    {
      script: [SMALL_TURN],
      content: "hi",
      preset: (kernel, id) =>
        presetPressure(kernel, id, 0.99, { legacy: true }),
    },
    async ({ events, startSessionId, endSessionId }) => {
      assertEquals(endSessionId, startSessionId);
      assert(!events.some((e) => e.type === "session_compacted"));
      assert(events.some((e) => e.type === "text_delta" && e.text === "ok"));
    },
  );
});

Deno.test("sendMessage — reactive gate ignores metadata from a different model", async () => {
  await withSendMessage(
    {
      script: [SMALL_TURN],
      content: "hi",
      preset: (kernel, id) =>
        presetPressure(kernel, id, 0.99, { model: "other-model" }),
    },
    async ({ events, startSessionId, endSessionId }) => {
      assertEquals(endSessionId, startSessionId);
      assert(!events.some((e) => e.type === "session_compacted"));
      assert(events.some((e) => e.type === "text_delta" && e.text === "ok"));
    },
  );
});

// A system prompt that, with the tool schemas, fills the request to halfway
// between the auto-compact threshold and the hard floor, whatever the tool
// surface weighs today.
function systemPromptBetweenThresholdAndFloor(): string {
  const toolTokens = estimateRequestTokens({
    system: "",
    messages: [],
    tools: toNeutralTools(AGENT_TOOLS),
  });
  const target = Math.floor(
    effectiveInputBudget("fake-model") * (CONTEXT_AUTOCOMPACT_RATIO + 1) / 2,
  );
  return "s".repeat((target - toolTokens) * TOKEN_ESTIMATE_CHARS_PER_TOKEN);
}

Deno.test("sendMessage — proactive estimate includes fixed system/tool request overhead", async () => {
  await withSendMessage(
    {
      script: [SMALL_TURN],
      content: "hi",
      brain: {
        ...stubBrain,
        baseSystemPrompt: systemPromptBetweenThresholdAndFloor,
      },
      preset: (kernel, id) => presetPressure(kernel, id, 0.10),
    },
    async ({ events, provider }) => {
      assertEquals(
        events.filter((e) => e.type === "session_compacted").length,
        1,
      );
      assertEquals(provider.requests.length, 1);
      assert(events.some((e) => e.type === "text_delta" && e.text === "ok"));
    },
  );
});

Deno.test("sendMessage — proactive estimate: a huge incoming message auto-compacts even when last pressure was low", async () => {
  // chars/4 over the full request (including system prompt + tools) must cross the
  // 95% threshold while staying below the hard floor after compaction. Last turn's
  // pressure is well under the ratio, so ONLY the proactive estimate can trip the guard.
  const huge = "x".repeat(280_000);
  await withSendMessage(
    {
      script: [SMALL_TURN],
      content: huge,
      preset: (kernel, id) => presetPressure(kernel, id, 0.10),
    },
    async ({ events, startSessionId, endSessionId }) => {
      assertEquals(
        endSessionId,
        startSessionId,
        "proactive estimate compacts in place (no session switch)",
      );
      assertEquals(
        events.filter((e) => e.type === "session_compacted").length,
        1,
      );
    },
  );
});

Deno.test("sendMessage — proactive hard floor does not send a doomed provider request after compaction", async () => {
  await withSendMessage(
    {
      script: [SMALL_TURN],
      content: "x".repeat(400_000),
      preset: (kernel, id) => presetPressure(kernel, id, 0.10),
    },
    async ({ events, provider }) => {
      assertEquals(
        events.filter((e) => e.type === "session_compacted").length,
        1,
      );
      assertEquals(provider.requests.length, 0);
      assert(
        events.some((e) =>
          e.type === "error" && e.text === CONTEXT_LENGTH_HARD_FLOOR_MESSAGE
        ),
      );
    },
  );
});

// §4.6 (agent cost reduction), the compaction-loop trap. With a 200k working budget
// the post-compaction floor — summary + pins + the re-seeded pending user message,
// none of which compaction can shrink — can itself sit above the auto-compact
// threshold. The old code re-fired the guard every turn: summarize, bill, no
// progress. The brake disarms after a compaction that failed to drop occupancy, and
// re-arms only when occupancy is genuinely back under the threshold.
//
// Driven with a lowered ratio and one huge message rather than four retained turns:
// retained turns are drawn from AFTER the compaction boundary (buildRecoveredContext)
// and so are near-empty right after a compaction — the content that actually survives
// a compaction is the unanswered user message, and that is what this pins.
Deno.test("sendMessage — a compaction that doesn't drop occupancy does not re-compact next turn", async () => {
  await withSendMessage(
    {
      script: [SMALL_TURN, SMALL_TURN, SMALL_TURN],
      // ~50k estimated tokens against fake-model's 92k budget: over the lowered
      // 0.50 ratio, under the 1.0 hard floor, and it survives compaction verbatim.
      content: "x".repeat(200_000),
      configure: () => setKernelSettings({ contextAutoCompactRatio: 0.50 }),
      preset: (kernel, id) => presetPressure(kernel, id, 0.10),
      followUps: [
        // Small follow-up: the huge turn-1 message is still in the retained array,
        // so the estimate is still over the ratio — the old code would compact again.
        "hi",
        // Drop the retained window entirely; occupancy falls under the ratio, which
        // is what re-arms the brake.
        async ({ chat }) => {
          await chat.clearContext();
          return "hi";
        },
      ],
    },
    async ({ eventBatches, inner, provider }) => {
      const compactions = eventBatches.map((batch) =>
        batch.filter((e) => e.type === "session_compacted").length
      );
      assertEquals(
        compactions,
        [1, 0, 0],
        "exactly one compaction: the second turn is braked, the third is under the ratio",
      );
      assertEquals(
        provider.requests.length,
        3,
        "every turn still reached the provider (the brake lets turns through)",
      );
      assertEquals(
        eventBatches.flat().filter((e) =>
          e.type === "error" && e.text === CONTEXT_LENGTH_HARD_FLOOR_MESSAGE
        ).length,
        0,
        "under the hard floor, a braked turn is not an error",
      );
      assertEquals(
        inner.autoCompactIneffective,
        false,
        "dropping back under the ratio re-arms the guard",
      );
    },
  );
});

Deno.test("sendMessage — below both thresholds: no compaction, same session", async () => {
  await withSendMessage(
    {
      script: [SMALL_TURN],
      content: "hi",
      preset: (kernel, id) => presetPressure(kernel, id, 0.10),
    },
    async ({ events, startSessionId, endSessionId }) => {
      assertEquals(
        endSessionId,
        startSessionId,
        "no compaction ⇒ the session id is unchanged",
      );
      assert(!events.some((e) => e.type === "session_compacted"));
      assert(events.some((e) => e.type === "text_delta" && e.text === "ok"));
    },
  );
});

Deno.test("sendMessage — gate off: never auto-compacts even at 0.99 pressure", async () => {
  await withSendMessage(
    {
      script: [SMALL_TURN],
      content: "hi",
      configure: () => setKernelSettings({ autoCompactEnabled: false }),
      preset: (kernel, id) => presetPressure(kernel, id, 0.99),
    },
    async ({ events, startSessionId, endSessionId }) => {
      assertEquals(
        endSessionId,
        startSessionId,
        "gate off ⇒ no compaction despite 0.99 pressure",
      );
      assert(!events.some((e) => e.type === "session_compacted"));
    },
  );
});

// --- Slice 6: the loop reads the RESOLVED ratios, not the bare constants -----

Deno.test("sendMessage — Slice 6: a low contextNudgeRatio override fires the nudge below the default 0.80", async () => {
  const nudgeTurn: ProviderEvent[] = [
    // 40_000 / 92_000 ≈ 0.43 pressure: clears a 0.30 override but not the 0.80 default.
    usageEvent({ inputTokens: BELOW_NUDGE_INPUT }),
    { type: "text_delta", text: "ok" },
    { type: "message_complete", stopReason: "end_turn" },
  ];
  await withSendMessage(
    {
      script: [nudgeTurn],
      content: "hi",
      // A nudge at 0.43 pressure can only fire if the loop reads contextNudgeRatio
      // (now 0.30) instead of the CONTEXT_NUDGE_RATIO constant (0.80).
      configure: () => setKernelSettings({ contextNudgeRatio: 0.30 }),
    },
    async ({ events }) => {
      const warnings = events.filter((e) => e.type === "context_warning");
      assertEquals(warnings.length, 1);
      assert(
        (warnings[0]?.contextPressure?.pressure ?? 0) < CONTEXT_NUDGE_RATIO,
        "the turn sat below the default nudge ratio — the override is what fired it",
      );
      // No auto-compaction: the auto-compact ratio is untouched and pressure is low.
      assert(!events.some((e) => e.type === "session_compacted"));
    },
  );
});

Deno.test("sendMessage — Slice 6: a low contextAutoCompactRatio override trips the reactive gate below the default 0.95", async () => {
  await withSendMessage(
    {
      script: [SMALL_TURN],
      content: "hi",
      // 0.60 preset pressure clears the 0.50 override but not the 0.95 default — a
      // compaction here proves the reactive gate reads contextAutoCompactRatio.
      configure: () => setKernelSettings({ contextAutoCompactRatio: 0.50 }),
      preset: (kernel, id) => presetPressure(kernel, id, 0.60),
    },
    async ({ events, startSessionId, endSessionId }) => {
      assertEquals(
        endSessionId,
        startSessionId,
        "the low auto-compact override compacts in place (no session switch)",
      );
      assertEquals(
        events.filter((e) => e.type === "session_compacted").length,
        1,
      );
      assert(events.some((e) => e.type === "text_delta" && e.text === "ok"));
    },
  );
});

// --- §4.7: in-turn tool-result pruning -------------------------------------
//
// Nothing above covers MID-turn behaviour: every context test so far measures at a
// turn boundary. These drive a single turn through many requires_action rounds with
// large tool results and assert what each request actually carried.

// A FakeModelProvider that snapshots each request's messages. §4.7 rewrites
// tool_result.output IN PLACE on the retained array, so the live references
// FakeModelProvider records all read as the FINAL state — a deep copy per request is
// the only way to know what request N sent.
class SnapshotProvider implements ModelProvider {
  readonly id = "snapshot-fake";
  readonly supportsCaching = false;
  readonly snapshots: NeutralMessage[][] = [];
  readonly #inner: FakeModelProvider;

  constructor(script: ProviderEvent[][]) {
    this.#inner = new FakeModelProvider(script);
  }

  streamTurn(
    req: TurnRequest,
    signal: AbortSignal,
  ): AsyncIterable<ProviderEvent> {
    this.snapshots.push(structuredClone(req.messages));
    return this.#inner.streamTurn(req, signal);
  }
}

// Comfortably over CONTEXT_PRUNE_MIN_RESULT_BYTES (2 KB), so the "don't bother"
// floor never silently decides these tests' outcome.
const PRUNE_RESULT_CHARS = 8_000;

// These tests are about the MECHANISM, not about where production sets the trigger, so
// the harness pins contextPruneRatio rather than tracking CONTEXT_PRUNE_RATIO (0.85 as
// of §8's re-measurement). Pinning it also keeps the numbers below readable.
const TEST_PRUNE_RATIO = 0.60;

// Provider-reported input tokens per request, against the 92_000 effective budget for
// "fake-model": 30_000 ≈ 0.33 pressure stays under TEST_PRUNE_RATIO, 60_000 ≈ 0.65
// crosses it (and still sits under the 0.80 nudge / 0.95 auto-compact ratios), and
// 80_000 ≈ 0.87 clears the 1.25x arm-once growth over a prune taken at 60_000.
const QUIET_INPUT = 30_000;
const PRUNE_INPUT = 60_000;
const REARM_INPUT = 80_000;

// The turn shape these tests lean on: 19 rounds that accumulate results without
// crossing the ratio, then the crossing. keepRecent is CONTEXT_RETAIN_TOOL_RESULTS
// (12), so the first prune has 8 old blocks to stub in one step — the "one big step,
// rarely" behaviour §4.7 is built around, rather than one block at a time.
const QUIET_ROUNDS = 19;
const FIRST_PRUNE_STUBS = 8;
// Rounds at the re-armed occupancy needed before a SECOND prune reclaims enough to
// clear CONTEXT_PRUNE_MAX_REWRITE_RATIO. Fewer than this and the cost gate refuses it
// — which is its own test below.
const SECOND_PRUNE_ROUNDS = 7;

function pruneTurnRounds(pressuredRounds = 3): number[] {
  return [
    ...Array(QUIET_ROUNDS).fill(QUIET_INPUT),
    ...Array(pressuredRounds).fill(PRUNE_INPUT),
  ];
}

function expectedStubIds(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `call_${i + 1}`);
}

function toolResultBlocks(
  messages: NeutralMessage[],
): NeutralToolResultBlock[] {
  return messages
    .filter((m) => m.role === "tool")
    .flatMap((m) =>
      m.content.filter((b): b is NeutralToolResultBlock =>
        b.type === "tool_result"
      )
    );
}

function outputRecord(output: unknown): Record<string, unknown> {
  return (output ?? {}) as Record<string, unknown>;
}

function prunedCallIds(messages: NeutralMessage[]): string[] {
  return toolResultBlocks(messages)
    .filter((b) => outputRecord(b.output).pruned === true)
    .map((b) => b.toolCallId);
}

interface PruneRun {
  snapshots: NeutralMessage[][];
  events: ChatEvent[];
  retained: NeutralMessage[];
  // Kernel log entries the turn wrote, read before the DB closes. The §8 safety tier
  // records its decision (and the residual-risk case) in metadata, and that diagnostic
  // is the only surface the "trim fired but could not reclaim enough" case has.
  logs: LogEntry[];
}

// One turn of `roundInputTokens.length` tool round-trips followed by a terminal text
// request, driven through runTurn (no pre-turn preflight in the way) against a real
// session. dispatchLocalTool is replaced so every call returns a fixed large payload:
// the point is the size and the ok flag, not any real tool's output.
async function runPruneTurn(opts: {
  roundInputTokens: number[];
  callsPerRound?: number;
  resultChars?: number;
  okFor?: (round: number) => boolean;
  configure?: () => void;
  // Messages already in the retained array when the turn starts — earlier, SETTLED
  // turns. The triggering user message is appended after them, so everything seeded
  // here sits before §4.8's live-turn boundary.
  seed?: NeutralMessage[];
  // Wall-clock of the last completed provider request, for the cold-prefix path.
  lastProviderRequestAt?: number;
  // The model that last request went to, for the model-change half of the cold check.
  lastProviderRequestModel?: string;
  // Reasoning the scripted provider reports on every message_complete, so the LIVE
  // turn's assistant messages carry blocks §4.8 must never touch.
  liveReasoning?: NeutralReasoningBlock[];
  // The model the turn runs on. Defaults to the unknown id "fake-model" (128K window
  // ⇒ 92_000 capacity). The §8 safety-tier tests below vary it, because the whole
  // point of that tier is that capacity and the working budget are different numbers
  // on some models and the same number on others.
  model?: string;
}): Promise<PruneRun> {
  const prevHome = Deno.env.get("HOME");
  const tmpHome = await Deno.makeTempDir({ prefix: "slice7-prune-home-" });
  Deno.env.set("HOME", tmpHome);
  const db = await Database.create({ driver: "pglite" });
  try {
    setKernelSettings({ contextPruneRatio: TEST_PRUNE_RATIO });
    opts.configure?.();
    const callsPerRound = opts.callsPerRound ?? 1;
    let nextCall = 0;
    const script: ProviderEvent[][] = opts.roundInputTokens.map(
      (inputTokens) => {
        const events: ProviderEvent[] = [usageEvent({ inputTokens })];
        for (let i = 0; i < callsPerRound; i++) {
          nextCall++;
          events.push({
            type: "tool_use_start",
            toolName: "list_functions",
            toolInput: { round: nextCall },
            toolCallId: `call_${nextCall}`,
          });
        }
        events.push({
          type: "message_complete",
          stopReason: "requires_action",
          ...(opts.liveReasoning ? { reasoning: opts.liveReasoning } : {}),
        });
        return events;
      },
    );
    script.push([
      usageEvent({ inputTokens: opts.roundInputTokens.at(-1) ?? 0 }),
      { type: "text_delta", text: "done" },
      {
        type: "message_complete",
        stopReason: "end_turn",
        ...(opts.liveReasoning ? { reasoning: opts.liveReasoning } : {}),
      },
    ]);

    const kernel = new Kernel(db, { composition: testStoreComposition() });
    const session = await kernel.sessions.createSession("prune");
    const provider = new SnapshotProvider(script);
    const chat = new ChatOrchestrator(
      kernel,
      () => {},
      new MCPManager(),
      stubBrain,
      provider,
    );
    const inner = internals(chat);
    const model = opts.model ?? "fake-model";
    inner.currentSessionId = session.id;
    inner.model = model;
    inner.localMessages = [...(opts.seed ?? []), userMessage("go")];
    if (opts.lastProviderRequestAt !== undefined) {
      inner.lastProviderRequestAt = opts.lastProviderRequestAt;
    }
    if (opts.lastProviderRequestModel !== undefined) {
      inner.lastProviderRequestModel = opts.lastProviderRequestModel;
    }
    inner.dispatchLocalTool = (tu) => {
      const round = Number(outputRecord(tu.input).round ?? 0);
      return Promise.resolve({
        ok: opts.okFor?.(round) ?? true,
        round,
        data: "x".repeat(opts.resultChars ?? PRUNE_RESULT_CHARS),
      });
    };
    const events: ChatEvent[] = [];
    await inner.runTurn({
      content: "go",
      onEvent: (e) => events.push(e),
      approvalStarted: false,
      activeWorkCs: null,
      system: "sys",
      tools: [],
      model,
      modelRole: "agent",
    });
    return {
      snapshots: provider.snapshots,
      events,
      retained: inner.localMessages,
      logs: kernel.log.query({ source: "agent", limit: 200 }),
    };
  } finally {
    await db.close();
    if (prevHome) Deno.env.set("HOME", prevHome);
    else Deno.env.delete("HOME");
    await Deno.remove(tmpHome, { recursive: true });
  }
}

// Write this one first: an unpaired tool_use is a provider 400 in production weeks
// later, not a test failure. Pruning must never delete a block or a message — only
// rewrite `output` — so every request stays paired.
Deno.test("runTurn — §4.7: pruning leaves no tool_use without a matching tool_result", async () => {
  const rounds = pruneTurnRounds();
  const { snapshots } = await runPruneTurn({ roundInputTokens: rounds });

  assertEquals(snapshots.length, rounds.length + 1);
  for (const [i, messages] of snapshots.entries()) {
    const toolUseIds = messages
      .filter((m) => m.role === "assistant")
      .flatMap((m) => m.content)
      .filter((b) => b.type === "tool_use")
      .map((b) => b.id);
    const resultIds = toolResultBlocks(messages).map((b) => b.toolCallId);
    assertEquals(
      resultIds.slice().sort(),
      toolUseIds.slice().sort(),
      `request ${i + 1}: tool_use ids and tool_result ids must match exactly`,
    );
  }
});

Deno.test("runTurn — §4.7: the last request carries stubs for the oldest tool results, with ok preserved", async () => {
  const rounds = pruneTurnRounds();
  const { snapshots, events } = await runPruneTurn({
    roundInputTokens: rounds,
  });

  const last = snapshots.at(-1)!;
  // 22 results, keepRecent 12 ⇒ the 8 oldest are stubbed in ONE step, nothing else.
  assertEquals(prunedCallIds(last), expectedStubIds(FIRST_PRUNE_STUBS));

  const stub = outputRecord(toolResultBlocks(last)[0]?.output);
  assertEquals(stub.ok, true, "ok survives a prune");
  assertEquals(stub.pruned, true);
  assertEquals(stub.omitted, true);
  assertEquals(stub.type, "object");
  assertEquals(stub.keys, ["ok", "round", "data"]);
  assertEquals(stub.keyCount, 3);
  assertEquals(
    stub.data,
    undefined,
    "the payload is what a prune reclaims — it must be gone",
  );

  // Everything newer is untouched, payload and all.
  const intact = toolResultBlocks(last).slice(FIRST_PRUNE_STUBS);
  assertEquals(intact.length, rounds.length - FIRST_PRUNE_STUBS);
  for (const block of intact) {
    assertEquals(
      String(outputRecord(block.output).data ?? "").length,
      PRUNE_RESULT_CHARS,
    );
  }

  // One inline notice, once per prune.
  assertEquals(
    events.filter((e) =>
      e.type === "text_delta" && e.text?.includes(CONTEXT_PRUNE_NOTICE)
    ).length,
    1,
  );
});

Deno.test("runTurn — §4.7: a failed result keeps ok:false through the stub", async () => {
  const { snapshots } = await runPruneTurn({
    roundInputTokens: pruneTurnRounds(),
    okFor: (round) => round !== 2,
  });

  const stubs = toolResultBlocks(snapshots.at(-1)!)
    .filter((b) => outputRecord(b.output).pruned === true)
    .map((b) => outputRecord(b.output).ok);
  assertEquals(
    stubs,
    [true, false, true, true, true, true, true, true],
    "ok is carried over verbatim, not defaulted",
  );
});

Deno.test("runTurn — §4.7: the last tool-role message is never stubbed, even when it alone exceeds keepRecent", async () => {
  // One request firing 20 parallel tools: 8 of its blocks fall outside keepRecent,
  // but they are the results the model is about to reason about, so the whole last
  // tool message is protected as a unit.
  const { snapshots } = await runPruneTurn({
    roundInputTokens: [PRUNE_INPUT],
    callsPerRound: 20,
  });

  const last = snapshots.at(-1)!;
  assertEquals(toolResultBlocks(last).length, 20);
  assertEquals(prunedCallIds(last), []);
});

Deno.test("runTurn — §4.7: a second prune waits for the arm-once growth threshold", async () => {
  // Flat occupancy: the first crossing arms the brake, and every later round wants to
  // stub one more block but never clears 1.25x the occupancy of that first prune.
  const flat = await runPruneTurn({ roundInputTokens: pruneTurnRounds() });
  assertEquals(
    prunedCallIds(flat.snapshots.at(-1)!),
    expectedStubIds(FIRST_PRUNE_STUBS),
  );
  assertEquals(
    flat.events.filter((e) =>
      e.type === "text_delta" && e.text?.includes(CONTEXT_PRUNE_NOTICE)
    ).length,
    1,
    "one prune per window until occupancy actually grows",
  );

  // Occupancy jumps past the re-arm threshold and STAYS there long enough for real
  // reclaim to accumulate: by round 27, blocks 9-15 have aged past keepRecent, which
  // is ~7x2k of reclaim against a ~25k rewrite — inside the 2.0 ceiling. One more
  // prune, and only one.
  const grown = await runPruneTurn({
    roundInputTokens: [
      ...Array(QUIET_ROUNDS).fill(QUIET_INPUT),
      PRUNE_INPUT,
      ...Array(SECOND_PRUNE_ROUNDS).fill(REARM_INPUT),
    ],
  });
  assertEquals(
    prunedCallIds(grown.snapshots.at(-1)!),
    expectedStubIds(
      QUIET_ROUNDS + SECOND_PRUNE_ROUNDS + 1 - CONTEXT_RETAIN_TOOL_RESULTS,
    ),
  );
  assertEquals(
    grown.events.filter((e) =>
      e.type === "text_delta" && e.text?.includes(CONTEXT_PRUNE_NOTICE)
    ).length,
    2,
  );
});

// The §8 correction: a prune's cost is its prefix rewrite, paid once; its saving is a
// smaller re-read, paid per remaining request. The loop cannot see how many requests
// remain, so CONTEXT_PRUNE_MAX_REWRITE_RATIO fixes the assumption and the gate refuses
// anything that rewrites more than that multiple of what it reclaims. On turn_mu0zfxi7
// this is the difference between prune 1 (1.69x, +$0.16) and prune 2 (2.76x, -$0.36).
Deno.test("runTurn — §8: a prune that rewrites more than it reclaims is declined on cost", async () => {
  // Occupancy clears both the ratio and the re-arm brake, so ONLY the cost gate is
  // left to stop it: two more rounds age exactly one 2k block past keepRecent, against
  // a tail of ~24k that the prune would force the provider to re-write.
  const { snapshots, events } = await runPruneTurn({
    roundInputTokens: [
      ...Array(QUIET_ROUNDS).fill(QUIET_INPUT),
      PRUNE_INPUT,
      REARM_INPUT,
      REARM_INPUT,
    ],
  });

  assertEquals(
    prunedCallIds(snapshots.at(-1)!),
    expectedStubIds(FIRST_PRUNE_STUBS),
    "the first prune stands; the marginal second one is refused",
  );
  assertEquals(
    events.filter((e) =>
      e.type === "text_delta" && e.text?.includes(CONTEXT_PRUNE_NOTICE)
    ).length,
    1,
  );
});

Deno.test("runTurn — §8: raising the rewrite ceiling lets the marginal prune through", async () => {
  // Same turn, same blocks, one setting different — proof the decline above is the
  // cost gate and not some other guard quietly declining for its own reasons.
  const { snapshots, events } = await runPruneTurn({
    roundInputTokens: [
      ...Array(QUIET_ROUNDS).fill(QUIET_INPUT),
      PRUNE_INPUT,
      REARM_INPUT,
      REARM_INPUT,
    ],
    configure: () => setKernelSettings({ contextPruneMaxRewriteRatio: 100 }),
  });

  assertEquals(
    prunedCallIds(snapshots.at(-1)!),
    expectedStubIds(FIRST_PRUNE_STUBS + 1),
  );
  assertEquals(
    events.filter((e) =>
      e.type === "text_delta" && e.text?.includes(CONTEXT_PRUNE_NOTICE)
    ).length,
    2,
  );
});

// --- §8: the safety tier -------------------------------------------------
//
// The cost tier above measures occupancy against effectiveInputBudget, and that
// number means two different things depending on the model. On claude-opus-5 the
// working budget (200_000) binds and there is 932_000 of real capacity behind it, so
// "pressure 1.6" is a spending signal. On claude-haiku-4-5 the WINDOW binds — budget
// and capacity are the same 132_000 — so the same ratio means the provider is about
// to reject the request. CONTEXT_PRUNE_SAFETY_RATIO is the second threshold, measured
// against capacity, and when it trips the trim is unconditional: neither the
// rewrite-ratio ceiling nor the arm-once brake gets a vote.

// Real capacities, asserted rather than hard-coded, so a change to any of the three
// inputs (window, output reservation, safety margin) shows up here as a failure in
// the numbers below rather than as a silently mis-aimed test.
const HAIKU_MODEL = "claude-haiku-4-5-20251001";
const OPUS_MODEL = "claude-opus-5";

// Per-request input tokens for the haiku scenarios, against its 132_000 capacity:
// 40_000 (~0.32) stays quiet, 90_000 (~0.70) crosses the cost tier but NOT the safety
// tier, 122_000 (~0.94) crosses both. Add ~2_000 for the results appended each round.
const HAIKU_QUIET = 40_000;
const HAIKU_PRUNE = 90_000;
const HAIKU_FORCED = 122_000;
// Past the wall outright: 198_000 (~200_000 of occupancy) against a 132_000 capacity,
// far enough over that a full trim cannot bring it back under. The residual-risk case.
const HAIKU_OVER_CAPACITY = 198_000;

// The same three points against "fake-model"'s 92_000 capacity — the unknown-id case,
// which under-reports to the 128K family floor by design and is therefore the MOST
// likely model to hit its window.
const UNKNOWN_FORCED = 86_000;

// claude-opus-5: 150_000 is pressure 0.75 against the 200_000 working budget, and
// 318_000 is pressure 1.60 — the figure turn_mu16zib8 actually reached, which finished
// fine. Against capacity those are 0.16 and 0.34, nowhere near the safety tier.
const OPUS_QUIET = 100_000;
const OPUS_PRUNE = 150_000;
const OPUS_REARM = 318_000;

// The turn shape both safety tests share: quiet rounds, then a tail. Identical to the
// cost-tier tests above so the ONLY difference is the occupancy and the model.
function safetyTurnRounds(quiet: number, tail: number[]): number[] {
  return [...Array(QUIET_ROUNDS).fill(quiet), ...tail];
}

function pruneNoticeCount(run: PruneRun): number {
  return run.events.filter((e) =>
    e.type === "text_delta" && e.text?.includes(CONTEXT_PRUNE_NOTICE)
  ).length;
}

// Every round past the first prune ages exactly one more result out of keepRecent, so
// an unconditional trim stubs one more block per round. Both tail rounds firing is the
// observable difference between "the wall is in charge" and "the cost gate is".
const FORCED_TAIL_ROUNDS = 2;

Deno.test("context capacity vs working budget: which term binds, per model", async () => {
  // Isolated HOME: both terms read the user's real config — the working budget from
  // kernel settings, the window from the discovered model cache — and a developer who
  // has fetched a provider catalog would otherwise be testing their cache, not this.
  const home = await Deno.makeTempDir({ prefix: "genie-capacity-" });
  const oldHome = Deno.env.get("HOME");
  try {
    Deno.env.set("HOME", home);
    // The table §8 corrects. Capacity is a pure function of the model; the budget is
    // Math.min(capacity, working budget), so it can only ever be the smaller.
    assertEquals(modelInputCapacity(OPUS_MODEL), 932_000);
    assertEquals(
      effectiveInputBudget(OPUS_MODEL),
      200_000,
      "the working budget binds — a cost ceiling with 932k of capacity behind it",
    );

    assertEquals(modelInputCapacity(HAIKU_MODEL), 132_000);
    assertEquals(
      effectiveInputBudget(HAIKU_MODEL),
      132_000,
      "the window binds — budget and capacity are the same wall",
    );

    assertEquals(modelInputCapacity("fake-model"), 92_000);
    assertEquals(
      effectiveInputBudget("fake-model"),
      92_000,
      "the window binds on an unknown id too",
    );
  } finally {
    if (oldHome === undefined) Deno.env.delete("HOME");
    else Deno.env.set("HOME", oldHome);
    await Deno.remove(home, { recursive: true });
  }
});

Deno.test("runTurn — §8: the safety tier bypasses the rewrite-cost ceiling on a window-bound model", async () => {
  const rounds = safetyTurnRounds(HAIKU_QUIET, [
    HAIKU_PRUNE,
    ...Array(FORCED_TAIL_ROUNDS).fill(HAIKU_FORCED),
  ]);

  // Control: the safety tier pinned to 1.0 is effectively off at 0.94 occupancy, so
  // this is the §8 cost-tier behaviour verbatim — the marginal trims are refused.
  const costOnly = await runPruneTurn({
    roundInputTokens: rounds,
    model: HAIKU_MODEL,
    configure: () => setKernelSettings({ contextPruneSafetyRatio: 1 }),
  });
  assertEquals(
    prunedCallIds(costOnly.snapshots.at(-1)!),
    expectedStubIds(FIRST_PRUNE_STUBS),
    "with the safety tier out of reach, cost refuses the marginal trims",
  );
  assertEquals(pruneNoticeCount(costOnly), 1);

  // Same turn, safety tier at its default: the tail rounds are past the wall, so the
  // ceiling stops applying and each of them trims.
  const forced = await runPruneTurn({
    roundInputTokens: rounds,
    model: HAIKU_MODEL,
    configure: () =>
      setKernelSettings({
        contextPruneSafetyRatio: CONTEXT_PRUNE_SAFETY_RATIO,
      }),
  });
  assertEquals(
    prunedCallIds(forced.snapshots.at(-1)!),
    expectedStubIds(FIRST_PRUNE_STUBS + FORCED_TAIL_ROUNDS),
  );
  assertEquals(pruneNoticeCount(forced), 1 + FORCED_TAIL_ROUNDS);

  // The diagnostic says which tier fired, and the numbers it was judged on.
  const trims = forced.logs.filter((l) =>
    l.message.startsWith("Trimmed context")
  );
  assertEquals(trims.length, 1 + FORCED_TAIL_ROUNDS);
  assertEquals(trims.map((l) => l.metadata?.forced), [false, true, true]);
  assertEquals(trims.at(-1)?.metadata?.capacity, 132_000);
});

Deno.test("runTurn — §8: the safety tier bypasses the arm-once brake", async () => {
  // Flat occupancy in the forced zone: after the first trim, growth is 1.0 against the
  // 1.25x the brake demands, so the brake is the only thing that could refuse rounds
  // 21 and 22 — and past the wall it doesn't get to.
  const rounds = safetyTurnRounds(
    HAIKU_QUIET,
    Array(1 + FORCED_TAIL_ROUNDS).fill(HAIKU_FORCED),
  );

  const braked = await runPruneTurn({
    roundInputTokens: rounds,
    model: HAIKU_MODEL,
    configure: () => setKernelSettings({ contextPruneSafetyRatio: 1 }),
  });
  assertEquals(
    prunedCallIds(braked.snapshots.at(-1)!),
    expectedStubIds(FIRST_PRUNE_STUBS),
    "one trim per window while the brake holds",
  );
  assertEquals(pruneNoticeCount(braked), 1);

  const forced = await runPruneTurn({
    roundInputTokens: rounds,
    model: HAIKU_MODEL,
    configure: () =>
      setKernelSettings({
        contextPruneSafetyRatio: CONTEXT_PRUNE_SAFETY_RATIO,
      }),
  });
  assertEquals(
    prunedCallIds(forced.snapshots.at(-1)!),
    expectedStubIds(FIRST_PRUNE_STUBS + FORCED_TAIL_ROUNDS),
    "at the wall, trim every request if you have to",
  );
  assertEquals(pruneNoticeCount(forced), 1 + FORCED_TAIL_ROUNDS);
});

Deno.test("runTurn — §8: the safety tier fires on an unknown model id too", async () => {
  // The 128K family floor is a deliberate under-report for ids the catalog doesn't
  // cover, which makes this the case most likely to meet a real window in production.
  const forced = await runPruneTurn({
    roundInputTokens: safetyTurnRounds(QUIET_INPUT, [
      PRUNE_INPUT,
      ...Array(FORCED_TAIL_ROUNDS).fill(UNKNOWN_FORCED),
    ]),
  });
  assertEquals(
    prunedCallIds(forced.snapshots.at(-1)!),
    expectedStubIds(FIRST_PRUNE_STUBS + FORCED_TAIL_ROUNDS),
  );
  assertEquals(pruneNoticeCount(forced), 1 + FORCED_TAIL_ROUNDS);
});

// The residual risk, named in §8 and deliberately not solved: a trim that fires at the
// wall can still fail to reclaim enough, and mid-turn compaction — the real answer —
// is out of scope. All this slice owes it is visibility, so the one thing worth
// testing is that the warn is not dead code.
Deno.test("runTurn — §8: a safety trim that cannot reclaim enough says so at warn", async () => {
  // 200_000 of occupancy against haiku's 132_000 capacity. The trim stubs its 8 old
  // blocks, reclaims ~16k, and is still ~52k over — which the next request will find
  // out the hard way.
  const run = await runPruneTurn({
    roundInputTokens: safetyTurnRounds(HAIKU_QUIET, [HAIKU_OVER_CAPACITY]),
    model: HAIKU_MODEL,
  });

  assertEquals(
    prunedCallIds(run.snapshots.at(-1)!),
    expectedStubIds(FIRST_PRUNE_STUBS),
  );
  const warnings = run.logs.filter((l) =>
    l.message.startsWith("Safety trim could not reclaim enough")
  );
  assertEquals(warnings.length, 1);
  assertEquals(warnings[0]?.level, "warn");
  assertEquals(warnings[0]?.metadata?.forced, true);
  assertEquals(warnings[0]?.metadata?.capacity, 132_000);
  assert(
    Number(warnings[0]?.metadata?.residualOccupancy) > 132_000,
    "the warn is only honest if the residual really is over capacity",
  );
});

// The regression guard, and the reason the tier is written against capacity rather
// than against the budget: on a 1M-window model it must stay ASLEEP. turn_mu16zib8 ran
// to pressure 1.60 on claude-opus-5 and finished fine — 320k against 932k of real
// capacity. If the safety tier ever wakes up there, every long opus turn starts paying
// for rewrites the cost gate had already priced and refused.
Deno.test("runTurn — §8: the safety tier stays dormant on claude-opus-5 at the measured pressures", async () => {
  const run = await runPruneTurn({
    roundInputTokens: safetyTurnRounds(OPUS_QUIET, [
      OPUS_PRUNE,
      OPUS_REARM,
      OPUS_REARM,
    ]),
    model: OPUS_MODEL,
  });

  // 320_000 against the 200_000 working budget — the measured 1.60 — and the cost gate
  // still gets the final word, exactly as it did before this tier existed.
  assertEquals(
    prunedCallIds(run.snapshots.at(-1)!),
    expectedStubIds(FIRST_PRUNE_STUBS),
  );
  assertEquals(pruneNoticeCount(run), 1);
  const trims = run.logs.filter((l) => l.message.startsWith("Trimmed context"));
  assertEquals(trims.map((l) => l.metadata?.forced), [false]);
  const declines = run.logs.filter((l) =>
    l.message.startsWith("Declined a mid-turn context trim")
  );
  assert(
    declines.length > 0,
    "the cost tier, not the safety tier, is in charge here",
  );
});

// --- §4.8: reasoning from settled turns -----------------------------------

// Big enough that a reclaim shows up against 2k tool results, and structured like the
// real thing: opaque provider internals the loop never reads, only carries.
const REASONING_CHARS = 6_000;

function reasoningBlock(
  id: string,
  chars = REASONING_CHARS,
): NeutralReasoningBlock {
  return {
    type: "reasoning",
    provider: "fake",
    data: { id, thinking: "r".repeat(chars) },
  };
}

// One turn that has already finished: a user message and the assistant answer that
// settled it, with the reasoning still attached. Anthropic requires thinking blocks to
// round-trip only within the assistant turn that owns the tool_use, so once a turn is
// behind us these are pure weight.
function settledTurn(id: string): NeutralMessage[] {
  return [
    userMessage(`earlier ${id}`),
    {
      role: "assistant",
      content: [
        reasoningBlock(id),
        { type: "text", text: `answer ${id}` },
      ],
    },
  ];
}

function reasoningIds(messages: NeutralMessage[]): string[] {
  return messages
    .flatMap((m) => m.content)
    .filter((b): b is NeutralReasoningBlock => b.type === "reasoning")
    .map((b) => String((b.data as { id?: unknown }).id ?? ""));
}

// Small on purpose. The live turn's reasoning only has to BE there for the "never
// touched" assertions; at full size, 22 rounds of it would dominate the tail and the
// cost gate would refuse the prune for reasons that have nothing to do with §4.8.
const LIVE_REASONING = [reasoningBlock("live", 400)];

Deno.test("runTurn — §4.8: a prune drops settled turns' reasoning in the same rewrite", async () => {
  // The rewrite is already being paid by the prune, so folding the reasoning drop into
  // it is free — and makes that rewrite smaller. The LIVE turn's blocks stay: dropping
  // those breaks the same-turn thinking round-trip the provider requires.
  const { snapshots } = await runPruneTurn({
    roundInputTokens: pruneTurnRounds(),
    seed: [...settledTurn("a"), ...settledTurn("b")],
    liveReasoning: LIVE_REASONING,
  });

  const first = snapshots[0]!;
  assertEquals(
    reasoningIds(first),
    ["a", "b"],
    "seeded reasoning starts present",
  );

  const last = snapshots.at(-1)!;
  assertEquals(
    prunedCallIds(last),
    expectedStubIds(FIRST_PRUNE_STUBS),
    "the tool-result half of the trim still fires",
  );
  assertEquals(
    reasoningIds(last).filter((id) => id === "a" || id === "b"),
    [],
    "settled turns' reasoning is gone",
  );
  assert(
    reasoningIds(last).every((id) => id === "live"),
    "every surviving reasoning block belongs to the live turn",
  );
  assert(
    reasoningIds(last).length > 0,
    "the live turn's reasoning is still round-tripping",
  );
});

Deno.test("runTurn — §4.8: settled reasoning goes at turn start once the cached prefix is cold", async () => {
  // No prune here — occupancy never crosses the ratio. The drop happens because the
  // provider's cache entry has expired, so the next request rewrites the prefix anyway
  // and removing dead weight first costs nothing.
  const { snapshots } = await runPruneTurn({
    roundInputTokens: [QUIET_INPUT],
    seed: [...settledTurn("a"), ...settledTurn("b")],
    lastProviderRequestAt: Date.now() - CACHE_COLD_PREFIX_IDLE_MS - 1_000,
  });

  assertEquals(
    reasoningIds(snapshots[0]!),
    [],
    "dropped before the first request",
  );
  assertEquals(
    prunedCallIds(snapshots.at(-1)!),
    [],
    "tool results are untouched",
  );
});

Deno.test("runTurn — §4.8: a warm prefix is left alone", async () => {
  // Mutating a live cache entry costs a full rewrite from message 1 on. Against ~3k of
  // reasoning that is a straight loss, so the drop waits for the entry to expire.
  const { snapshots } = await runPruneTurn({
    roundInputTokens: [QUIET_INPUT],
    seed: [...settledTurn("a"), ...settledTurn("b")],
    lastProviderRequestAt: Date.now(),
  });

  assertEquals(reasoningIds(snapshots[0]!), ["a", "b"]);
});

Deno.test("runTurn — §4.8: a model switch drops settled reasoning even on a warm clock", async () => {
  // Cache entries are per-model, so the switch already cost the prefix — and this is
  // the case where carrying the blocks forward is wrong as well as expensive: they
  // were captured under a different model. The wire-level replay filter in
  // ai-sdk-shared is provider-scoped, so it does not catch opus → sonnet by itself.
  const { snapshots } = await runPruneTurn({
    roundInputTokens: [QUIET_INPUT],
    seed: [...settledTurn("a"), ...settledTurn("b")],
    lastProviderRequestAt: Date.now(),
    lastProviderRequestModel: "some-other-model",
  });

  assertEquals(reasoningIds(snapshots[0]!), []);
});

Deno.test("runTurn — §4.8: autoCompactEnabled off keeps settled reasoning", async () => {
  const { snapshots } = await runPruneTurn({
    roundInputTokens: [QUIET_INPUT],
    seed: [...settledTurn("a"), ...settledTurn("b")],
    lastProviderRequestAt: Date.now() - CACHE_COLD_PREFIX_IDLE_MS - 1_000,
    configure: () => setKernelSettings({ autoCompactEnabled: false }),
  });

  assertEquals(reasoningIds(snapshots[0]!), ["a", "b"]);
});

Deno.test("runTurn — §4.7: results under the byte floor are left alone", async () => {
  // Stubbing a small result invalidates the cached prefix from that block onward and
  // reclaims nothing — strictly a loss. Same pressured turn, 200-byte results.
  const { snapshots, events } = await runPruneTurn({
    roundInputTokens: pruneTurnRounds(),
    resultChars: 200,
  });

  assertEquals(prunedCallIds(snapshots.at(-1)!), []);
  assert(
    !events.some((e) =>
      e.type === "text_delta" && e.text?.includes(CONTEXT_PRUNE_NOTICE)
    ),
  );
});

Deno.test("runTurn — §4.7: autoCompactEnabled off prunes nothing", async () => {
  const { snapshots, events } = await runPruneTurn({
    roundInputTokens: pruneTurnRounds(),
    configure: () => setKernelSettings({ autoCompactEnabled: false }),
  });

  assertEquals(prunedCallIds(snapshots.at(-1)!), []);
  assert(
    !events.some((e) =>
      e.type === "text_delta" && e.text?.includes(CONTEXT_PRUNE_NOTICE)
    ),
  );
});

// --- Slice 5: reactive context-length recovery -----------------------------

// A scripted provider error event with a semantic code (the classifier's output shape).
function errorEvent(code: string, message: string): ProviderEvent {
  return { type: "error", error: { code, message } };
}

// The recovered second turn: a small successful turn whose text proves the retry ran.
const RECOVERED_TURN: ProviderEvent[] = [
  { type: "text_delta", text: "recovered" },
  { type: "message_complete", stopReason: "end_turn" },
];

Deno.test("sendMessage — Slice 5: a CONTEXT_LENGTH_EXCEEDED error auto-compacts then retries once and succeeds", async () => {
  await withSendMessage(
    {
      script: [
        [errorEvent(
          PROVIDER_ERROR_CODES.CONTEXT_LENGTH_EXCEEDED,
          "prompt is too long",
        )],
        RECOVERED_TURN,
      ],
      content: "do the thing",
    },
    async ({ events, startSessionId, endSessionId, provider }) => {
      // Exactly two provider requests: the overflowing first, the recovered retry.
      assertEquals(
        provider.requests.length,
        2,
        "one recovery retry ⇒ exactly two provider requests",
      );

      // A compaction happened in place (Slice-4 session_compacted event, same session).
      const compacted = events.filter((e) => e.type === "session_compacted");
      assertEquals(compacted.length, 1, "exactly one compaction on recovery");
      assertEquals(
        endSessionId,
        startSessionId,
        "recovery compacts in place (no session switch)",
      );
      assertEquals(compacted[0]?.sessionId, startSessionId);

      // The retry produced the final answer, and NO user-facing terminal error fired.
      assert(
        events.some((e) => e.type === "text_delta" && e.text === "recovered"),
        "the recovered turn's text streamed",
      );
      assert(
        !events.some((e) => e.type === "error"),
        "a recovered overflow never surfaces a terminal error",
      );

      // Guards step 3: the retry re-seeded the triggering user message rather than
      // sending the empty post-compaction array (a naive retry would send []).
      const retry = provider.requests[1];
      assert(retry, "expected a second provider request");
      const reseeded = retry.messages.some((m) =>
        m.role === "user" &&
        m.content.some((b) =>
          b.type === "text" && b.text.includes("do the thing")
        )
      );
      assert(reseeded, "the retry re-seeded the triggering user message");
    },
  );
});

Deno.test("sendMessage — Slice 5: a second CONTEXT_LENGTH_EXCEEDED hits the hard-floor and terminates at one attempt", async () => {
  await withSendMessage(
    {
      script: [
        [errorEvent(
          PROVIDER_ERROR_CODES.CONTEXT_LENGTH_EXCEEDED,
          "prompt is too long",
        )],
        [errorEvent(
          PROVIDER_ERROR_CODES.CONTEXT_LENGTH_EXCEEDED,
          "prompt is too long",
        )],
      ],
      content: "do the thing",
    },
    async ({ events, provider }) => {
      // One recovery attempt, then stop — no infinite compaction loop.
      assertEquals(
        provider.requests.length,
        2,
        "hard-floor caps recovery at one retry ⇒ exactly two requests",
      );
      // Exactly one compaction (the single recovery attempt).
      assertEquals(
        events.filter((e) => e.type === "session_compacted").length,
        1,
      );
      // The terminal error carries the specific, actionable hard-floor copy.
      const errors = events.filter((e) => e.type === "error");
      assertEquals(errors.length, 1, "one terminal error at the hard-floor");
      assertEquals(errors[0]?.text, CONTEXT_LENGTH_HARD_FLOOR_MESSAGE);
    },
  );
});

Deno.test("sendMessage — Slice 5: a non-context-length error passes through unchanged (no recovery)", async () => {
  await withSendMessage(
    {
      script: [[errorEvent(PROVIDER_ERROR_CODES.RATE_LIMITED, "slow down")]],
      content: "do the thing",
    },
    async ({ events, startSessionId, endSessionId, provider }) => {
      // No recovery: exactly one request, no compaction, same session.
      assertEquals(provider.requests.length, 1);
      assert(!events.some((e) => e.type === "session_compacted"));
      assertEquals(endSessionId, startSessionId);
      // Today's behavior: the error surfaces with its original message.
      const errors = events.filter((e) => e.type === "error");
      assertEquals(errors.length, 1);
      assertEquals(errors[0]?.text, "slow down");
    },
  );
});

Deno.test("sendMessage — Slice 5: with autoCompactEnabled off a context-length error surfaces as an error (no recovery)", async () => {
  await withSendMessage(
    {
      script: [[errorEvent(
        PROVIDER_ERROR_CODES.CONTEXT_LENGTH_EXCEEDED,
        "prompt is too long",
      )]],
      content: "do the thing",
      configure: () => setKernelSettings({ autoCompactEnabled: false }),
    },
    async ({ events, startSessionId, endSessionId, provider }) => {
      assertEquals(provider.requests.length, 1, "gate off ⇒ no retry");
      assert(!events.some((e) => e.type === "session_compacted"));
      assertEquals(endSessionId, startSessionId);
      const errors = events.filter((e) => e.type === "error");
      assertEquals(errors.length, 1, "the overflow surfaces as an error");
      assertEquals(errors[0]?.text, "prompt is too long");
    },
  );
});

Deno.test("compactSession — compacts IN PLACE: same session, keeps focus/pins/transcript, records boundary", async () => {
  const db = await Database.create({ driver: "pglite" });
  try {
    const kernel = new Kernel(db, { composition: testStoreComposition() });
    const session = await kernel.sessions.createSession("work");
    await kernel.sessions.updateFocus(session.id, "the focus");
    const pinnedMsg = await kernel.sessions.addMessage({
      sessionId: session.id,
      role: "user",
      content: "pinned content",
    });
    await kernel.sessions.pinMessage(pinnedMsg.id);
    const historyMsg = await kernel.sessions.addMessage({
      sessionId: session.id,
      role: "assistant",
      content: "earlier reply",
    });

    const chat = new ChatOrchestrator(
      kernel,
      () => {},
      new MCPManager(),
      stubBrain,
      new FakeModelProvider([]),
    );
    const inner = internals(chat);
    inner.currentSessionId = session.id;

    const { sessionId } = await chat.compactSession("manual summary");
    // No new session — the id is unchanged and the name never gains "(compacted)".
    assertEquals(sessionId, session.id);

    const fresh = await kernel.sessions.getSession(session.id);
    assertEquals(fresh?.name, "work");
    assertEquals(fresh?.focus, "the focus");
    assertEquals(fresh?.summary, "manual summary");
    // The prior transcript is retained (pin + history + the new summary marker).
    const msgs = await kernel.sessions.getMessages(session.id);
    assert(msgs.some((m) => m.content === "pinned content"));
    assert(msgs.some((m) => m.content === "earlier reply"));
    assert(
      msgs.some((m) =>
        m.role === "system" &&
        m.content.startsWith("[Compacted session summary]:")
      ),
      "a compaction marker is appended to the same session",
    );
    // Pin survives (never re-copied — it was already in this session).
    const pins = await kernel.sessions.getPinnedMessages(session.id);
    assert(pins.some((m) => m.content === "pinned content"));

    // Boundary recorded at the last pre-compaction message; stale pressure cleared.
    const meta = JSON.parse(fresh?.metadata ?? "{}") as Record<string, unknown>;
    assertEquals(meta.summarizedThroughMessageId, historyMsg.id);
    assertEquals("lastContextPressure" in meta, false);
    assertEquals("lastContextTokens" in meta, false);

    // The retained array is reset and the nudge re-armed.
    assertEquals(inner.localMessages.length, 0);
    assertEquals(inner.contextNudged, false);
  } finally {
    await db.close();
  }
});

Deno.test("compactSession — re-seeds a trailing unanswered user question onto the fresh array", async () => {
  const db = await Database.create({ driver: "pglite" });
  try {
    const kernel = new Kernel(db, { composition: testStoreComposition() });
    const session = await kernel.sessions.createSession("work");
    const chat = new ChatOrchestrator(
      kernel,
      () => {},
      new MCPManager(),
      stubBrain,
      new FakeModelProvider([]),
    );
    const inner = internals(chat);
    inner.currentSessionId = session.id;
    // History: one answered turn (user → assistant), then a NEW question with no reply.
    inner.localMessages = [
      userMessage("first question"),
      { role: "assistant", content: [{ type: "text", text: "first answer" }] },
      userMessage("what is the token count?"),
    ];

    await chat.compactSession("manual summary");

    // Manual /compact carries NO recent turns, yet the pending question survives
    // verbatim so the model still answers it (previously it was dropped entirely).
    assertEquals(inner.localMessages.length, 1);
    assertEquals(inner.localMessages[0]?.role, "user");
    const block = inner.localMessages[0]?.content[0];
    assertEquals(block?.type, "text");
    assertEquals(
      (block as { type: "text"; text: string }).text,
      "what is the token count?",
    );
  } finally {
    await db.close();
  }
});

Deno.test("compactSession — an answered tail (assistant last) re-seeds nothing", async () => {
  const db = await Database.create({ driver: "pglite" });
  try {
    const kernel = new Kernel(db, { composition: testStoreComposition() });
    const session = await kernel.sessions.createSession("work");
    const chat = new ChatOrchestrator(
      kernel,
      () => {},
      new MCPManager(),
      stubBrain,
      new FakeModelProvider([]),
    );
    const inner = internals(chat);
    inner.currentSessionId = session.id;
    inner.localMessages = [
      userMessage("a question"),
      { role: "assistant", content: [{ type: "text", text: "an answer" }] },
    ];

    await chat.compactSession("manual summary");
    // The last turn was answered → no pending question → the array resets empty.
    assertEquals(inner.localMessages.length, 0);
  } finally {
    await db.close();
  }
});

Deno.test("toNeutralContentBlocks maps text/image/document verbatim", () => {
  const blocks = [
    { type: "text", text: "hi" },
    {
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "aaa" },
    },
    {
      type: "document",
      source: { type: "base64", media_type: "application/pdf", data: "bbb" },
      title: "doc.pdf",
    },
  ] as unknown as Parameters<typeof toNeutralContentBlocks>[0];
  const neutral = toNeutralContentBlocks(blocks);

  assertEquals(neutral, [
    { type: "text", text: "hi" },
    { type: "image", mediaType: "image/png", data: "aaa" },
    {
      type: "document",
      mediaType: "application/pdf",
      data: "bbb",
      title: "doc.pdf",
    },
  ]);
});

Deno.test("agent-loop/chat.ts imports no provider impl or SDK (layer rule)", async () => {
  const src = await Deno.readTextFile(new URL("./chat.ts", import.meta.url));
  assert(
    !src.includes("model-provider-fake"),
    "chat.ts must not import the fake provider impl",
  );
  assert(!/from ["']npm:ai/.test(src), "chat.ts must not import the AI SDK");
  assert(!src.includes("@ai-sdk"), "chat.ts must not import @ai-sdk providers");
  // The one model-provider.ts import is type-only (the L1 contract, a downward import).
  assert(
    /import type \{[\s\S]*?\} from "\.\.\/core\/model-provider\.ts"/.test(src),
    "the model-provider.ts import must be type-only",
  );
});

// ── Output-ceiling truncation (max_tokens) ────────────────────────────────────
// A turn cut off at the model's output ceiling is INCOMPLETE. Before this, the
// provider's "max_tokens" stop collapsed into "end_turn" and the loop settled the
// turn as finished — the failure that made big single-file rewrites stop silently
// mid-write. These pin the three halves of the fix: resume, bound, and surface.

function truncatedTurn(text: string): ProviderEvent[] {
  return [
    { type: "text_delta", text },
    { type: "message_complete", stopReason: "max_tokens" },
  ];
}

Deno.test("runTurn — a max_tokens stop resumes the turn instead of settling it", async () => {
  const { events, result, provider } = await runScript([
    truncatedTurn("export function editor() {"),
    [
      { type: "text_delta", text: " return null; }" },
      { type: "message_complete", stopReason: "end_turn" },
    ],
  ]);

  // Two provider requests: the truncated one and its continuation.
  assertEquals(provider.requests.length, 2);
  assertEquals(result.stopReason, "end_turn");
  assertEquals(result.fullText, "export function editor() { return null; }");
  // The continuation is a USER turn carrying the resume nudge, sent after the partial
  // assistant message — the retained messages must not end on the assistant role
  // (trailing-assistant prefills are rejected on current Claude models), and the
  // partial text is retained ahead of the nudge so the model resumes rather than
  // restarting. Indexed rather than tail-checked: the loop passes its live
  // localMessages array, so the recorded request keeps growing after the call.
  const resumed = provider.requests[1]?.messages ?? [];
  const nudgeIdx = resumed.findIndex((m) =>
    m.role === "user" &&
    m.content.some((b) =>
      b.type === "text" && b.text === TURN_CONTINUATION_PROMPT
    )
  );
  assert(nudgeIdx > 0, "expected a continuation user message");
  assertEquals(resumed[nudgeIdx - 1]?.role, "assistant");
  assertEquals(
    resumed[nudgeIdx - 1]?.content.some((b) =>
      b.type === "text" && b.text === "export function editor() {"
    ),
    true,
  );
  // A resumed turn is not a failure: no error event reaches the client.
  assertEquals(events.some((e) => e.type === "error"), false);
});

Deno.test("runTurn — truncation past the continuation budget settles as max_tokens and says so", async () => {
  // Every scripted turn truncates, so the loop spends its whole budget and gives up.
  const script = Array.from(
    { length: MAX_TURN_CONTINUATIONS + 1 },
    (_, i) => truncatedTurn(`chunk${i}`),
  );
  const { events, result, provider } = await runScript(script);

  // The original request plus exactly MAX_TURN_CONTINUATIONS resumes — bounded, so a
  // model that truncates forever cannot spin the loop.
  assertEquals(provider.requests.length, MAX_TURN_CONTINUATIONS + 1);
  assertEquals(result.stopReason, "max_tokens");
  // Surfaced, not silent: the client is told the answer is still cut off.
  const errors = events.filter((e) => e.type === "error");
  assertEquals(errors.length, 1);
  assertEquals(errors[0]?.text, MAX_OUTPUT_TRUNCATED_MESSAGE);
});

Deno.test("runTurn — a max_tokens stop alongside tool calls dispatches them as usual", async () => {
  // Truncation only hijacks the terminal no-tool-calls path. A turn that did finalize
  // a tool call still round-trips it, so the continuation logic can't strand tool work.
  const { result, provider } = await runScript([
    [
      { type: "text_delta", text: "listing" },
      {
        type: "tool_use_start",
        toolName: "list_routes",
        toolInput: {},
        toolCallId: "call-1",
      },
      { type: "message_complete", stopReason: "max_tokens" },
    ],
    [
      { type: "text_delta", text: "done" },
      { type: "message_complete", stopReason: "end_turn" },
    ],
  ]);

  assertEquals(provider.requests.length, 2);
  assertEquals(result.stopReason, "end_turn");
  assertEquals(result.toolCalls.length, 1);
  assertEquals(result.toolCalls[0]?.name, "list_routes");
  // The second request resumes from tool RESULTS, not a continuation nudge.
  const afterTool = provider.requests[1]?.messages ?? [];
  assertEquals(afterTool.some((m) => m.role === "tool"), true);
  assertEquals(
    afterTool.some((m) =>
      m.content.some((b) =>
        b.type === "text" && b.text === TURN_CONTINUATION_PROMPT
      )
    ),
    false,
  );
});

Deno.test("sendMessage — a light-lane changeset auto-approves and continues in the same turn", async () => {
  // The whole point of the light lane: a margin tweak should not cost a human
  // round-trip. The kernel approves it because the dispatch gate has narrowed what
  // this changeset may touch — not because the model asked nicely.
  const prevHome = Deno.env.get("HOME");
  const tmpHome = await Deno.makeTempDir({ prefix: "local-loop-home-" });
  Deno.env.set("HOME", tmpHome);
  const db = await Database.create({ driver: "pglite" });
  try {
    const kernel = new Kernel(db, {
      composition: {
        ...testStoreComposition(),
        verificationTools: defaultVerificationToolHandlers,
      },
    });
    const provider = new FakeModelProvider([
      // One turn: propose a light changeset, then keep working — no pause between.
      [
        { type: "text_delta", text: "Small tweak." },
        {
          type: "tool_use_start",
          toolName: "create_changeset",
          toolInput: {
            title: "Remove the 76px header margin",
            change_class: "light",
            plan: {
              summary: "Remove the 76px margin from the header.",
              steps: ["Edit the stylesheet"],
            },
          },
          toolCallId: "call_cs",
        },
        { type: "message_complete", stopReason: "requires_action" },
      ],
      [
        { type: "text_delta", text: "Margin removed." },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]);
    const chat = new ChatOrchestrator(
      kernel,
      () => {},
      new MCPManager(),
      stubBrain,
      provider,
    );

    const events: ChatEvent[] = [];
    const text = await chat.sendMessage(
      "drop the 76px margin",
      (e) => events.push(e),
    );

    // No pause: BOTH assistant segments belong to one turn. Without the light lane
    // the turn would have ended at "Small tweak." with a waiting-for-approval notice.
    assertEquals(text, "Small tweak.Margin removed.");
    assertEquals(
      events.some((e) =>
        e.type === "text_delta" && (e.text ?? "").includes("approval")
      ),
      false,
      "a light-lane changeset must not stop for approval",
    );
    assertEquals(provider.requests.length, 2);

    const active = await kernel.changesets.getActive(
      chat.getCurrentSessionId() ?? undefined,
    );
    assertEquals(active?.status, "in_progress");
    assertEquals(active?.plan.changeClass?.effective, "light");
    assertEquals(active?.plan.changeClass?.autoApproved, true);
    // A kernel auto-approval is never recorded as a human one.
    assertEquals(active?.approvalMessageId, null);
  } finally {
    await db.close();
    if (prevHome) Deno.env.set("HOME", prevHome);
    else Deno.env.delete("HOME");
    await Deno.remove(tmpHome, { recursive: true });
  }
});

Deno.test('sendMessage — proportionalVerification "never" restores the approval pause', async () => {
  const prevHome = Deno.env.get("HOME");
  const tmpHome = await Deno.makeTempDir({ prefix: "local-loop-home-" });
  Deno.env.set("HOME", tmpHome);
  setKernelSettings({ proportionalVerification: "never" });
  const db = await Database.create({ driver: "pglite" });
  try {
    const kernel = new Kernel(db, {
      composition: {
        ...testStoreComposition(),
        verificationTools: defaultVerificationToolHandlers,
      },
    });
    const provider = new FakeModelProvider([
      [
        { type: "text_delta", text: "Small tweak." },
        {
          type: "tool_use_start",
          toolName: "create_changeset",
          toolInput: {
            title: "Remove the 76px header margin",
            change_class: "light",
            plan: {
              summary: "Remove the 76px margin from the header.",
              steps: ["Edit the stylesheet"],
              // Under "never" the kernel synthesizes nothing, so the plan must
              // carry its own ceremony or validateChangesetPlan rejects it.
              acceptanceCriteria: ["The header margin is gone."],
              verificationPlan: [{
                id: "v1",
                claimIds: ["claim_0"],
                kind: "screenshot",
                description: "Screenshot the header.",
              }],
            },
          },
          toolCallId: "call_cs",
        },
        { type: "message_complete", stopReason: "requires_action" },
      ],
    ]);
    const chat = new ChatOrchestrator(
      kernel,
      () => {},
      new MCPManager(),
      stubBrain,
      provider,
    );

    const events: ChatEvent[] = [];
    await chat.sendMessage("drop the 76px margin", (e) => events.push(e));

    assert(
      events.some((e) =>
        e.type === "text_delta" && (e.text ?? "").includes("approval")
      ),
      "with the lane off, the changeset must stop for approval",
    );
    const active = await kernel.changesets.getActive(
      chat.getCurrentSessionId() ?? undefined,
    );
    assertEquals(active?.status, "planning");
    assertEquals(active?.plan.changeClass?.effective, "standard");
  } finally {
    setKernelSettings({ proportionalVerification: "auto" });
    await db.close();
    if (prevHome) Deno.env.set("HOME", prevHome);
    else Deno.env.delete("HOME");
    await Deno.remove(tmpHome, { recursive: true });
  }
});

// Cost fix (docs/agent-cost-reduction.md §4.1): a changeset mutation returns the whole
// changeset twice — once as `data`, once as `_changeset` — plus a `_changesetEvent`
// routing tag. The IDE needs both side channels; the model needs neither, and the
// duplicate was 19.5% of every tool-result byte in the measured corpus.
Deno.test("runTurn — tool_result on the wire drops _changeset/_changesetEvent, tool_use_end keeps them", async () => {
  const db = await Database.create({ driver: "pglite" });
  try {
    const kernel = new Kernel(db, { composition: testStoreComposition() });
    const cs = await kernel.changesets.create({
      title: "Wire payload",
      plan: {
        summary: "Ship the wire filter.",
        steps: [
          { id: "step_0", description: "build it", status: "pending" },
        ],
        acceptanceCriteria: [
          {
            id: "c1",
            text: "the wire carries one changeset",
            source: "agent",
            priority: "must",
          },
        ],
        verificationPlan: [
          {
            id: "v1",
            claimIds: ["c1"],
            kind: "unit",
            description: "assert the tool_result payload",
          },
        ],
      },
    });
    await kernel.changesets.approve(cs.id);
    await kernel.changesets.startWork(cs.id);

    const provider = new FakeModelProvider([
      [
        {
          type: "tool_use_start",
          toolName: "update_changeset_step",
          toolInput: {
            changeset_id: cs.id,
            step_id: "step_0",
            status: "done",
          },
          toolCallId: "call_step",
        },
        { type: "message_complete", stopReason: "requires_action" },
      ],
      [
        { type: "text_delta", text: "done" },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]);
    const chat = new ChatOrchestrator(
      kernel,
      () => {},
      new MCPManager(),
      stubBrain,
      provider,
    );
    const inner = internals(chat);
    inner.localMessages = [userMessage("mark step 0 done")];

    const events: ChatEvent[] = [];
    await inner.runTurn({
      content: "mark step 0 done",
      onEvent: (e) => events.push(e),
      approvalStarted: false,
      activeWorkCs: null,
      system: "sys",
      tools: [],
      model: "fake-model",
      modelRole: "agent",
    });

    // The IDE-facing event still carries both side channels.
    const end = events.find((e) => e.type === "tool_use_end");
    const eventResult = end?.toolResult as Record<string, unknown> | undefined;
    assertEquals(eventResult?.ok, true);
    assertEquals(
      (eventResult?._changeset as { id?: string } | undefined)?.id,
      cs.id,
    );
    assertEquals(eventResult?._changesetEvent, "changeset_updated");

    // The wire payload carries the changeset exactly once, under `data`.
    const toolMessage = inner.localMessages.find((m) => m.role === "tool");
    const block = toolMessage?.content[0];
    assertEquals(block?.type, "tool_result");
    const output = (block as { output?: unknown }).output as
      | Record<string, unknown>
      | undefined;
    assertEquals(output?.ok, true);
    assertEquals((output?.data as { id?: string } | undefined)?.id, cs.id);
    assertEquals("_changeset" in (output ?? {}), false);
    assertEquals("_changesetEvent" in (output ?? {}), false);

    // Cost fix §4.3: `data` is now an acknowledgement, not the changeset. Slimming it
    // is safe ONLY because `_changeset` survives on the IDE-facing record — all three
    // IDE consumers resolve `_changeset ?? data ?? record` and then REQUIRE
    // `plan.steps` to be an array, returning null (a silently missing card, not an
    // error) when it is not. This pins the side channel that keeps them fed.
    const sideChannel = eventResult?._changeset as
      | { plan?: { steps?: unknown } }
      | undefined;
    assertEquals(Array.isArray(sideChannel?.plan?.steps), true);
    // And `data` no longer carries a plan to fall back to — which is the point.
    const slim = output?.data as Record<string, unknown> | undefined;
    assertEquals("plan" in (slim ?? {}), false);
    assertEquals(slim?.stepId, "step_0");
    // `status` is the CHANGESET's (still in_progress), not the step's — the step went
    // to `done`, and that lives in `steps` under `stepId`.
    assertEquals(slim?.status, "in_progress");
    assertEquals(slim?.allStepsSettled, true);
    assertEquals(slim?.steps, [
      { id: "step_0", status: "done", description: "build it" },
    ]);
  } finally {
    await db.close();
  }
});
