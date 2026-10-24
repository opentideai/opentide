import { assertEquals, assertStringIncludes } from "@std/assert";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildFallbackSummary,
  buildSessionSummaryStatus,
  normalizeSummaryKind,
  summarizeSession,
  type SummarySource,
} from "./session-summary.ts";
import { setRecommendedModels } from "./config.ts";
import { SessionManager } from "./sessions.ts";
import {
  setUtilityModelCallForTest,
  setUtilityModelUsageRecorderForTest,
} from "./utility-model.ts";
import type { Kernel } from "./registries.ts";

function seedModelCache(home: string, model: string, provider: string): void {
  const dir = join(home, ".config", "opentide");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "models-cache.json"),
    JSON.stringify({
      models: [{ id: model, label: model, provider }],
      cachedAt: new Date().toISOString(),
    }),
  );
}

Deno.test("normalizeSummaryKind defaults unknown values to handoff", () => {
  assertEquals(normalizeSummaryKind("brief"), "brief");
  assertEquals(normalizeSummaryKind("nonsense"), "handoff");
  assertEquals(normalizeSummaryKind(undefined), "handoff");
});

Deno.test("buildFallbackSummary produces a handoff with changed entities", () => {
  const source: SummarySource = {
    session: {
      id: "s1",
      name: "Planning Discussion",
      startedAt: "2026-05-30T00:00:00Z",
      endedAt: null,
      summary: null,
      focus: null,
      metadata: null,
      archived: false,
    },
    messages: [
      {
        id: 1,
        sessionId: "s1",
        role: "user",
        kind: "chat",
        content:
          "Let's decide that plans should be artifacts instead of special sessions.",
        toolCalls: null,
        pinned: false,
        turnId: "t1",
        createdAt: "2026-05-30T00:00:01Z",
      },
      {
        id: 2,
        sessionId: "s1",
        role: "assistant",
        kind: "chat",
        content: "Agreed. A project plan artifact fits better.",
        toolCalls: null,
        pinned: false,
        turnId: "t1",
        createdAt: "2026-05-30T00:00:02Z",
      },
    ],
    changesets: [
      {
        id: "cs_1",
        sessionId: "s1",
        title: "Add summarization",
        description: null,
        status: "completed",
        plan: {
          summary: "Build command and tool",
          steps: [{
            id: "step_0",
            description: "Add backend service",
            status: "done",
          }],
        },
        planMessageIds: [],
        approvalMessageId: null,
        workMessageIds: [],
        toolCalls: null,
        reasoning: null,
        tokenUsage: null,
        createdAt: "2026-05-30T00:00:03Z",
        updatedAt: "2026-05-30T00:00:04Z",
        completedAt: "2026-05-30T00:00:05Z",
      },
    ],
    changesByChangeset: new Map([[
      "cs_1",
      [{
        id: 10,
        category: "handler",
        key: "summarizeSession",
        action: "create",
        beforeSnapshot: null,
        afterSnapshot: null,
        context: { sessionId: "s1" },
        createdAt: "2026-05-30T00:00:04Z",
        undoable: true,
        turnId: "t1",
        changesetId: "cs_1",
        rationale: null,
        implementation: null,
        workMessageId: null,
      }],
    ]]),
    usage: {
      turns: 1,
      totalDurationMs: 100,
      totalInputTokens: 10,
      totalOutputTokens: 20,
      totalCacheCreationInputTokens: 0,
      totalCacheReadInputTokens: 0,
      totalToolCalls: 1,
      totalCostUsd: 0.01,
      unpricedCalls: 0,
      unpricedInputTokens: 0,
      unpricedOutputTokens: 0,
    },
  };

  const summary = buildFallbackSummary(source, "handoff");
  assertStringIncludes(summary, "**Objective**");
  assertStringIncludes(summary, "plans should be artifacts");
  assertStringIncludes(summary, "handler:summarizeSession");
});

Deno.test("buildSessionSummaryStatus reports freshness and newer messages", () => {
  const session = {
    id: "s1",
    name: "Summary Session",
    startedAt: "2026-05-30T00:00:00Z",
    endedAt: null,
    summary: "Stored summary",
    focus: null,
    metadata: JSON.stringify({
      summaryKind: "handoff",
      summaryGeneratedBy: "model",
      summarizedAt: "2026-05-30T00:00:03Z",
      summarizedThroughMessageId: 2,
    }),
    archived: false,
  };
  const messages = [1, 2, 3].map((id) => ({
    id,
    sessionId: "s1",
    role: "user" as const,
    kind: "chat" as const,
    content: `message ${id}`,
    toolCalls: null,
    pinned: false,
    turnId: null,
    createdAt: `2026-05-30T00:00:0${id}Z`,
  }));

  const status = buildSessionSummaryStatus(session, messages);
  assertEquals(status.hasSummary, true);
  assertEquals(status.kind, "handoff");
  assertEquals(status.generatedBy, "model");
  assertEquals(status.summarizedThroughMessageId, 2);
  assertEquals(status.latestMessageId, 3);
  assertEquals(status.newerMessageCount, 1);
  assertEquals(status.fresh, false);
});

Deno.test("summarizeSession records session_summary utility usage", async () => {
  const historyDir = await Deno.makeTempDir({ prefix: "genie-summary-" });
  const home = await Deno.makeTempDir({ prefix: "genie-summary-home-" });
  const oldHome = Deno.env.get("HOME");
  const oldAnthropic = Deno.env.get("ANTHROPIC_API_KEY");
  const oldOpenai = Deno.env.get("OPENAI_API_KEY");
  const sessions = new SessionManager(historyDir);
  const restore = setUtilityModelCallForTest((req) =>
    Promise.resolve({
      text: "**Objective**\nSummarized by model.",
      provider: "openai",
      model: req.model,
      usage: {
        inputTokens: 30,
        outputTokens: 9,
        cacheCreationInputTokens: 2,
        cacheReadInputTokens: 3,
      },
    })
  );
  const restoreRecorder = setUtilityModelUsageRecorderForTest((input) =>
    sessions.recordModelUsage(input)
  );
  try {
    Deno.env.set("HOME", home);
    Deno.env.delete("ANTHROPIC_API_KEY");
    Deno.env.set("OPENAI_API_KEY", "sk-openai-test");
    seedModelCache(home, "gpt-5-mini", "openai");
    setRecommendedModels({ utility: "gpt-5-mini" });
    const session = await sessions.createSession("Summary Ledger");
    await sessions.addMessage({
      sessionId: session.id,
      role: "user",
      content: "Summarize accounting.",
    });
    const kernel = {
      sessions,
      changesets: { list: () => Promise.resolve([]) },
      changelog: { listByChangeset: () => Promise.resolve([]) },
    } as unknown as Kernel;

    const result = await summarizeSession(kernel, {
      sessionId: session.id,
      store: false,
      requester: "user",
    });

    assertEquals(result?.generatedBy, "model");
    const rows = readFileSync(`${historyDir}/model-usage.jsonl`, "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assertEquals(rows.length, 1);
    assertEquals(rows[0].sessionId, session.id);
    assertEquals(rows[0].role, "utility");
    assertEquals(rows[0].caller, "session_summary");
    assertEquals(rows[0].inputTokens, 30);
    assertEquals(rows[0].outputTokens, 9);
    assertEquals(rows[0].provider, "openai");
    assertEquals(rows[0].pricingStatus, "unpriced");
    assertEquals(rows[0].costUsd, null);
  } finally {
    restore();
    restoreRecorder();
    if (oldHome === undefined) Deno.env.delete("HOME");
    else Deno.env.set("HOME", oldHome);
    if (oldAnthropic === undefined) Deno.env.delete("ANTHROPIC_API_KEY");
    else Deno.env.set("ANTHROPIC_API_KEY", oldAnthropic);
    if (oldOpenai === undefined) Deno.env.delete("OPENAI_API_KEY");
    else Deno.env.set("OPENAI_API_KEY", oldOpenai);
    rmSync(historyDir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
