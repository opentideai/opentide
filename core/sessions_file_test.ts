import { assert, assertEquals, assertExists } from "@std/assert";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { SessionManager } from "./sessions.ts";
import type { TurnUsage } from "./types.ts";
import { TEST_TMP_DIR } from "./test-home_test.ts";
import { PRIVATE_HISTORY_DIR, PRIVATE_SESSION_MARKERS_DIR } from "./config.ts";

async function withFileSessions(
  fn: (mgr: SessionManager, historyDir: string) => Promise<void>,
): Promise<void> {
  const historyDir = await Deno.makeTempDir({
    dir: TEST_TMP_DIR,
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
    const session = await mgr.createSession("JSONL", {
      visibility: "project",
    });
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
      PRIVATE_HISTORY_DIR,
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

function sessionFile(dir: string, id: string): string {
  return join(dir, "sessions", `${encodeURIComponent(id)}.json`);
}

function messageFile(dir: string, id: string): string {
  return join(dir, "messages", `${encodeURIComponent(id)}.jsonl`);
}

Deno.test("file sessions are stored by visibility", async () => {
  await withFileSessions(async (mgr, historyDir) => {
    const privateDir = join(historyDir, PRIVATE_HISTORY_DIR);
    const mine = await mgr.createSession("Mine", { visibility: "private" });
    const shared = await mgr.createSession("Shared", { visibility: "project" });
    await mgr.addMessage({ sessionId: mine.id, role: "user", content: "a" });
    await mgr.addMessage({ sessionId: shared.id, role: "user", content: "b" });

    assertEquals(existsSync(sessionFile(privateDir, mine.id)), true);
    assertEquals(existsSync(messageFile(privateDir, mine.id)), true);
    assertEquals(existsSync(sessionFile(historyDir, mine.id)), false);
    assertEquals(existsSync(messageFile(historyDir, mine.id)), false);
    assertEquals(existsSync(sessionFile(historyDir, shared.id)), true);
    assertEquals(existsSync(messageFile(historyDir, shared.id)), true);
    assertEquals(
      readFileSync(join(privateDir, ".gitignore"), "utf-8").includes("*"),
      true,
    );

    const listed = (await mgr.listSessions()).map((s) => s.id).toSorted();
    assertEquals(listed, [mine.id, shared.id].toSorted());
    assertEquals((await mgr.getMessages(mine.id))[0]?.content, "a");
  });
});

Deno.test("changing visibility moves a session's files both ways", async () => {
  await withFileSessions(async (mgr, historyDir) => {
    const privateDir = join(historyDir, PRIVATE_HISTORY_DIR);
    const session = await mgr.createSession("Flip", { visibility: "private" });
    await mgr.addMessage({ sessionId: session.id, role: "user", content: "x" });

    await mgr.updateVisibility(session.id, "project");
    assertEquals(existsSync(sessionFile(privateDir, session.id)), false);
    assertEquals(existsSync(messageFile(privateDir, session.id)), false);
    assertEquals(existsSync(sessionFile(historyDir, session.id)), true);
    assertEquals(existsSync(messageFile(historyDir, session.id)), true);
    assertEquals((await mgr.getSession(session.id))?.visibility, "project");
    const marker = join(
      historyDir,
      PRIVATE_SESSION_MARKERS_DIR,
      `${encodeURIComponent(session.id)}.json`,
    );
    assertEquals(existsSync(marker), false);

    await mgr.updateVisibility(session.id, "private");
    assertEquals(existsSync(sessionFile(historyDir, session.id)), false);
    assertEquals(existsSync(messageFile(historyDir, session.id)), false);
    assertEquals((await mgr.getMessages(session.id)).map((m) => m.content), [
      "x",
    ]);
    assertEquals((await mgr.getSession(session.id))?.visibility, "private");
    assertEquals(existsSync(marker), true);
  });
});

Deno.test("private sessions stored with project history move out", async () => {
  await withFileSessions(async (_mgr, historyDir) => {
    // Written the way the store did before private/ existed: a private
    // session, and an older one with no visibility at all.
    const legacy = (id: string, visibility?: string) => {
      const session = {
        id,
        name: id,
        startedAt: "2026-10-01T00:00:00.000Z",
        endedAt: null,
        summary: null,
        focus: null,
        metadata: null,
        archived: false,
        ...(visibility ? { visibility } : {}),
      };
      Deno.writeTextFileSync(
        sessionFile(historyDir, id),
        JSON.stringify(session),
      );
      Deno.writeTextFileSync(
        messageFile(historyDir, id),
        JSON.stringify({ id: 1, sessionId: id, role: "user", content: id }) +
          "\n",
      );
    };
    legacy("session_old_private", "private");
    legacy("session_old_unset");
    legacy("session_old_project", "project");

    const mgr = new SessionManager(historyDir);
    assertEquals(await mgr.relocatePrivateSessions(), 2);
    assertEquals(await mgr.relocatePrivateSessions(), 0);

    const privateDir = join(historyDir, PRIVATE_HISTORY_DIR);
    for (const id of ["session_old_private", "session_old_unset"]) {
      assertEquals(existsSync(sessionFile(historyDir, id)), false);
      assertEquals(existsSync(messageFile(historyDir, id)), false);
      assertEquals(existsSync(messageFile(privateDir, id)), true);
      assertEquals((await mgr.getMessages(id))[0]?.content, id);
    }
    assertEquals(
      existsSync(sessionFile(historyDir, "session_old_project")),
      true,
    );
  });
});

Deno.test("a commit never picks up a private session", async () => {
  const repo = await Deno.makeTempDir({
    dir: TEST_TMP_DIR,
    prefix: "tideide-private-git-",
  });
  try {
    const git = (...args: string[]) => {
      const out = new Deno.Command("git", {
        args: ["-C", repo, ...args],
        stdout: "piped",
        stderr: "piped",
      }).outputSync();
      if (!out.success) throw new Error(new TextDecoder().decode(out.stderr));
      return new TextDecoder().decode(out.stdout);
    };
    git("init", "-q");
    // No project .gitignore: private/ has to keep itself out.
    const mgr = new SessionManager(join(repo, ".opentide", "history"));
    const mine = await mgr.createSession("Secret plans", {
      visibility: "private",
    });
    const shared = await mgr.createSession("Shared", { visibility: "project" });
    await mgr.addMessage({
      sessionId: mine.id,
      role: "user",
      content: "my private words",
    });
    await mgr.addMessage({ sessionId: shared.id, role: "user", content: "b" });
    git("add", "-A");
    git(
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "commit",
      "-q",
      "-m",
      "history",
    );

    const tracked = git("ls-files").trim().split("\n");
    assert(
      tracked.some((path) => path.includes(encodeURIComponent(shared.id))),
    );
    assertEquals(
      tracked.some((path) => path.includes(`/${PRIVATE_HISTORY_DIR}/`)),
      false,
    );
    // The private session's only trace is its marker, which says nothing.
    const traces = tracked.filter((path) =>
      path.includes(encodeURIComponent(mine.id))
    );
    assertEquals(traces, [
      `.opentide/history/${PRIVATE_SESSION_MARKERS_DIR}/${
        encodeURIComponent(mine.id)
      }.json`,
    ]);
    const committed = git("log", "-p");
    assertEquals(committed.includes("Secret plans"), false);
    assertEquals(committed.includes("my private words"), false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

Deno.test("file session reads follow every write, this manager's or another's", async () => {
  await withFileSessions(async (mgr, historyDir) => {
    const session = await mgr.createSession("Cached reads");
    const first = await mgr.addMessage({
      sessionId: session.id,
      role: "user",
      content: "first",
      turnId: "turn_1",
    });
    assertEquals(
      (await mgr.listSessions(5))[0]?.lastMessageAt,
      first.createdAt,
    );
    assertEquals(await mgr.getProjectPinnedMessages(), []);

    const other = new SessionManager(historyDir);
    const second = await other.addMessage({
      sessionId: session.id,
      role: "user",
      content: "second",
      turnId: "turn_2",
    });
    const ids = await mgr.getUserMessageIdsByTurnIds(["turn_1", "turn_2"]);
    assertEquals(ids.get("turn_2"), second.id);

    await mgr.pinMessage(first.id, "project");
    assertEquals(
      (await mgr.getProjectPinnedMessages()).map((m) => m.id),
      [first.id],
    );
    await other.unpinMessage(first.id, "project");
    assertEquals(await mgr.getProjectPinnedMessages(), []);
  });
});

Deno.test("a session's messages are read fresh after any write, and never shared", async () => {
  await withFileSessions(async (mgr, historyDir) => {
    const session = await mgr.createSession("Cached messages");
    await mgr.addMessage({ sessionId: session.id, role: "user", content: "a" });
    await mgr.getMessages(session.id);
    const first = await mgr.getMessages(session.id);
    first.push({ ...first[0]!, id: -1 });
    assertEquals((await mgr.getMessages(session.id)).length, 1);

    const other = new SessionManager(historyDir);
    await other.addMessage({
      sessionId: session.id,
      role: "user",
      content: "b",
    });
    assertEquals(
      (await mgr.getMessages(session.id)).map((m) => m.content),
      ["a", "b"],
    );
    const [a] = await mgr.getMessages(session.id);
    await other.pinMessage(a!.id);
    assertEquals((await mgr.getMessages(session.id))[0]!.pinned, true);
  });
});
