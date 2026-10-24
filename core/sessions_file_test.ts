import { assertEquals, assertExists } from "@std/assert";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { SessionManager } from "./sessions.ts";
import type { TurnUsage } from "./types.ts";

async function withFileSessions(
  fn: (mgr: SessionManager, historyDir: string) => Promise<void>,
): Promise<void> {
  const historyDir = await Deno.makeTempDir({
    dir: "/private/tmp",
    prefix: "tideide-history-",
  });
  const mgr = new SessionManager(historyDir);
  try {
    await fn(mgr, historyDir);
  } finally {
    rmSync(historyDir, { recursive: true, force: true });
  }
}

Deno.test("file sessions persist sessions and messages across reload", async () => {
  await withFileSessions(async (mgr, historyDir) => {
    const session = await mgr.createSession("Build auth");
    assertEquals(/^session_[0-9a-z]+_[0-9a-f-]{36}$/.test(session.id), true);
    const user = await mgr.addMessage({
      sessionId: session.id,
      role: "user",
      content: "please build auth",
      turnId: "turn_1",
    });
    assertEquals(user.id > Date.now() * 1000 - 1_000_000, true);
    await mgr.addMessage({
      sessionId: session.id,
      role: "assistant",
      content: "implemented",
      toolCalls: [{ name: "edit", input: { file: "auth.ts" } }],
      turnId: "turn_1",
    });
    await mgr.pinMessage(user.id);
    await mgr.updateSummaryMetadata(session.id, "Auth summary", "{}");

    const reloaded = new SessionManager(historyDir);
    const fetched = await reloaded.getSession(session.id);
    assertEquals(fetched?.summary, "Auth summary");

    const messages = await reloaded.getMessages(session.id);
    assertEquals(messages.length, 2);
    assertEquals(messages[0]!.pinned, true);
    assertEquals(
      messages[1]!.toolCalls,
      JSON.stringify([
        { name: "edit", input: { file: "auth.ts" } },
      ]),
    );

    const ids = await reloaded.getUserMessageIdsByTurnIds(["turn_1"]);
    assertEquals(ids.get("turn_1"), user.id);
    assertEquals((await reloaded.getPinnedMessages(session.id)).length, 1);
  });
});

Deno.test("file sessions append messages as JSONL", async () => {
  await withFileSessions(async (mgr, historyDir) => {
    const session = await mgr.createSession("JSONL");
    await mgr.addMessage({ sessionId: session.id, role: "user", content: "a" });
    await mgr.addMessage({
      sessionId: session.id,
      role: "assistant",
      content: "b",
    });

    const messagesPath = join(
      historyDir,
      "messages",
      `${encodeURIComponent(session.id)}.jsonl`,
    );
    assertEquals(existsSync(messagesPath), true);
    const lines = readFileSync(messagesPath, "utf-8").trim().split("\n");
    assertEquals(lines.length, 2);
    assertEquals(JSON.parse(lines[0]!).content, "a");
  });
});

Deno.test("file sessions reuse empty session without rewriting it", async () => {
  await withFileSessions(async (mgr, historyDir) => {
    const session = await mgr.createSession();
    const sessionPath = join(
      historyDir,
      "sessions",
      `${encodeURIComponent(session.id)}.json`,
    );
    const before = readFileSync(sessionPath, "utf-8");

    const reused = await mgr.createSession();

    assertEquals(reused.id, session.id);
    assertEquals(readFileSync(sessionPath, "utf-8"), before);
  });
});

Deno.test("file sessions do not reuse ended empty sessions", async () => {
  await withFileSessions(async (mgr) => {
    const ended = await mgr.createSession();
    await mgr.endSession(ended.id);

    const next = await mgr.createSession();

    assertEquals(next.id === ended.id, false);
    assertEquals(next.endedAt, null);
  });
});

Deno.test("file message ids stay monotonic across manager instances", async () => {
  await withFileSessions(async (mgr, historyDir) => {
    const session = await mgr.createSession("Mono");
    const a = await mgr.addMessage({
      sessionId: session.id,
      role: "user",
      content: "a",
    });
    const b = await mgr.addMessage({
      sessionId: session.id,
      role: "assistant",
      content: "b",
    });
    assertEquals(b.id > a.id, true);

    // A fresh manager must seed its id counter from disk, not collide.
    const reopened = new SessionManager(historyDir);
    const c = await reopened.addMessage({
      sessionId: session.id,
      role: "user",
      content: "c",
    });
    assertEquals(c.id > b.id, true);
  });
});

Deno.test("file sessions search, context, and usage work", async () => {
  await withFileSessions(async (mgr) => {
    const session = await mgr.createSession("Usage");
    await mgr.addMessage({
      sessionId: session.id,
      role: "user",
      content: "find the special token",
    });
    await mgr.addMessage({
      sessionId: session.id,
      role: "assistant",
      content: "done",
    });

    const usage: TurnUsage = {
      turnId: "turn_usage",
      sessionId: session.id,
      model: "model",
      startedAt: "2026-01-01T00:00:00.000Z",
      endedAt: "2026-01-01T00:00:01.000Z",
      durationMs: 1000,
      inputTokens: 10,
      outputTokens: 20,
      cacheCreationInputTokens: 1,
      cacheReadInputTokens: 2,
      toolCallsCount: 3,
      costUsd: 0.04,
    };
    await mgr.recordTurnUsage(usage);

    const search = await mgr.searchMessages("special", {
      sessionId: session.id,
    });
    assertEquals(search.length, 1);
    assertEquals(search[0]!.role, "user");

    const context = await mgr.getContextInfo(session.id);
    assertEquals(context.messageCount, 2);
    assertEquals(context.usage.totalInputTokens, 10);

    assertEquals((await mgr.getTurnUsage("turn_usage"))?.outputTokens, 20);
    assertEquals((await mgr.getSessionUsage(session.id)).totalToolCalls, 3);
    assertEquals((await mgr.getProjectUsage()).totalCostUsd, 0.04);
    assertExists((await mgr.getTurnUsagesForSession(session.id))[0]);
  });
});
