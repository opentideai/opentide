// The §8 cache-composition instrument, wired into the local loop. What matters
// here is what the ledger could never tell anyone: ONE LINE PER PROVIDER REQUEST,
// with that request's own usage, not the turn's sum. Plus: off by default, and
// absent entirely when no project dir is loaded.

import { assert, assertEquals } from "@std/assert";
import { ChatOrchestrator } from "./chat.ts";
import { inProcessChatBackend } from "./chat-backend.ts";
import { FakeModelProvider } from "../core/model-provider-fake.ts";
import type {
  NeutralMessage,
  NeutralTool,
  ProviderEvent,
} from "../core/model-provider.ts";
import type { TurnUsage } from "../core/types.ts";
import type { ChatIntelligence } from "../core/chat-intelligence.ts";
import { Database } from "../core/db.ts";
import { MCPManager } from "../core/mcp.ts";
import { Kernel } from "../core/registries.ts";
import {
  CACHE_COMPOSITION_TRACE_FILE,
  OPENTIDE_CACHE_TRACE_ENABLED_ENV,
} from "../core/config.ts";
import { getProjectPaths } from "../core/project-manager.ts";

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

interface LoopInternals {
  runTurn(opts: {
    content: string;
    approvalStarted: boolean;
    activeWorkCs: null;
    system: string;
    tools: NeutralTool[];
    model: string;
    modelRole: "agent" | "planning";
  }): Promise<unknown>;
  localMessages: NeutralMessage[];
  currentSessionId: string | null;
}

const baseUsage: TurnUsage = {
  turnId: "provider-turn",
  sessionId: "provider-session",
  model: "fake-model",
  startedAt: "2026-09-14T00:00:00.000Z",
  endedAt: "2026-09-14T00:00:01.000Z",
  durationMs: 1000,
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
  toolCallsCount: 0,
  costUsd: 0,
};

function usageEvent(overrides: Partial<TurnUsage>): ProviderEvent {
  return { type: "turn_usage", usage: { ...baseUsage, ...overrides } };
}

// Two provider requests in one turn: a tool round-trip, each request reporting its
// OWN usage — the shape the turn-level ledger flattens away.
const TWO_REQUEST_TURN: ProviderEvent[][] = [
  [
    usageEvent({
      inputTokens: 100,
      outputTokens: 10,
      cacheCreationInputTokens: 40_000,
      cacheReadInputTokens: 0,
    }),
    {
      type: "tool_use_start",
      toolName: "list_modules",
      toolInput: {},
      toolCallId: "call_1",
    },
    { type: "message_complete", stopReason: "requires_action" },
  ],
  [
    usageEvent({
      inputTokens: 120,
      outputTokens: 20,
      cacheCreationInputTokens: 900,
      cacheReadInputTokens: 40_000,
    }),
    { type: "text_delta", text: "done" },
    { type: "message_complete", stopReason: "end_turn" },
  ],
];

async function runTracedTurn(opts: {
  traceEnv: string | null;
  withProjectDir: boolean;
}): Promise<{ dir: string; lines: Array<Record<string, unknown>> }> {
  const dir = Deno.makeTempDirSync({ prefix: "chat-cache-trace-" });
  const before = Deno.env.get(OPENTIDE_CACHE_TRACE_ENABLED_ENV);
  if (opts.traceEnv === null) Deno.env.delete(OPENTIDE_CACHE_TRACE_ENABLED_ENV);
  else Deno.env.set(OPENTIDE_CACHE_TRACE_ENABLED_ENV, opts.traceEnv);
  const db = await Database.create({ driver: "pglite" });
  try {
    const kernel = new Kernel(db);
    if (opts.withProjectDir) kernel.projectDir = dir;
    const chat = new ChatOrchestrator(
      inProcessChatBackend(kernel, () => {}),
      new MCPManager(),
      stubBrain,
      new FakeModelProvider(TWO_REQUEST_TURN),
    );
    const inner = chat as unknown as LoopInternals;
    inner.localMessages = [{
      role: "user",
      content: [{ type: "text", text: "run it" }],
    }];
    await inner.runTurn({
      content: "run it",
      approvalStarted: false,
      activeWorkCs: null,
      system: "a system prompt",
      tools: [],
      model: "fake-model",
      modelRole: "agent",
    });
  } finally {
    await db.close();
    if (before === undefined) Deno.env.delete(OPENTIDE_CACHE_TRACE_ENABLED_ENV);
    else Deno.env.set(OPENTIDE_CACHE_TRACE_ENABLED_ENV, before);
  }
  const path = `${
    getProjectPaths(dir).historyDir
  }/${CACHE_COMPOSITION_TRACE_FILE}`;
  let lines: Array<Record<string, unknown>> = [];
  try {
    lines = Deno.readTextFileSync(path).trim().split("\n").map((l) =>
      JSON.parse(l) as Record<string, unknown>
    );
  } catch {
    lines = [];
  }
  return { dir, lines };
}

Deno.test("local loop writes one trace line per provider request when tracing is on", async () => {
  const { dir, lines } = await runTracedTurn({
    traceEnv: "1",
    withProjectDir: true,
  });
  try {
    assertEquals(lines.length, 2);
    assertEquals(lines.map((l) => l.requestIndex), [0, 1]);

    // Each line carries THAT request's usage, not the turn's 40,900-token sum.
    const first = lines[0]!.usage as Record<string, number>;
    const second = lines[1]!.usage as Record<string, number>;
    assertEquals(first.cacheCreationInputTokens, 40_000);
    assertEquals(first.cacheReadInputTokens, 0);
    assertEquals(second.cacheCreationInputTokens, 900);
    assertEquals(second.cacheReadInputTokens, 40_000);

    // The second request is bigger: the tool round-trip appended an assistant
    // tool_use and its result, and only those count as new.
    type Buckets = { toolResultTokens: number; estimatedTotalTokens: number };
    const b0 = lines[0]!.buckets as Buckets;
    const b1 = lines[1]!.buckets as Buckets;
    assertEquals(b0.toolResultTokens, 0);
    assert(b1.toolResultTokens > 0);
    assert(b1.estimatedTotalTokens > b0.estimatedTotalTokens);

    const d1 = lines[1]!.delta as Record<string, number | boolean>;
    assertEquals(d1.prefixMutated, false);
    assert((d1.newTokens as number) > 0);

    // The fake provider does not cache, so no breakpoints are claimed.
    assertEquals(lines[0]!.supportsCaching, false);
    assertEquals((lines[0]!.breakpoints as unknown[]).length, 0);
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test("local loop writes no trace when the instrument is off", async () => {
  const { dir, lines } = await runTracedTurn({
    traceEnv: "0",
    withProjectDir: true,
  });
  try {
    assertEquals(lines, []);
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test("local loop writes no trace when no project is loaded", async () => {
  const { dir, lines } = await runTracedTurn({
    traceEnv: "1",
    withProjectDir: false,
  });
  try {
    assertEquals(lines, []);
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});
