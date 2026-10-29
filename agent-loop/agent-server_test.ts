import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { Database } from "../core/db.ts";
import { Kernel } from "../core/registries.ts";
import type { CurrentUser } from "../core/auth.ts";
import { localUser } from "../core/auth.ts";
import type {
  ChatEventHandler,
  InProgressDetail,
  InProgressState,
} from "../core/chat-contract.ts";
import { testStoreComposition } from "../verification/test-stores.ts";
import {
  type AgentChat,
  type AgentHost,
  type AgentProject,
  createAgentServer,
} from "./agent-server.ts";
import type { ToolResult } from "../core/tools/dispatch.ts";
import { inProcessHistoryClient } from "./chat-backend.ts";
import { projectMcpServers } from "./agent-mcp-servers.ts";

const testOpts = { sanitizeResources: false, sanitizeOps: false };

// A chat runtime that records what the server asks of it.
class RecordingChat implements AgentChat {
  readonly sentMessages: string[] = [];
  readonly audits: string[] = [];
  readonly commits: string[] = [];
  commitResult: ToolResult = { ok: true, data: { status: { clean: true } } };
  auditResult: ToolResult = { ok: true, data: { status: "complete" } };
  readonly sentSessionIds: Array<string | null> = [];
  readonly resumedSessionIds: string[] = [];
  readonly compactSummaries: string[] = [];
  readonly sentDocumentRefs: Array<
    Array<{ id: string; versionHash?: string }> | undefined
  > = [];
  readonly events: string[] = [];
  clearContextCount = 0;
  clearCurrentSessionCount = 0;
  abortCount = 0;
  closeCount = 0;
  reloadModelCount = 0;
  sendMessageBlocker: Promise<void> | null = null;
  inProgressState: InProgressState | null = null;
  inProgressFullState: InProgressState | null = null;
  // Text streamed per message, for the terminal's ask.
  reply = "";

  constructor(
    private readonly kernel: Kernel,
    private currentSessionId: string,
  ) {}

  setOnTurnComplete(_cb: () => void): void {}
  async initialize(): Promise<void> {}
  async reloadApiKey(): Promise<void> {}
  async reloadModel(): Promise<void> {
    this.reloadModelCount++;
  }
  getInProgressState(
    detail: InProgressDetail = "compact",
  ): InProgressState | null {
    return detail === "full"
      ? this.inProgressFullState ?? this.inProgressState
      : this.inProgressState;
  }
  abort(): void {
    this.abortCount++;
    this.events.push("chat.abort");
  }
  async clearContext(): Promise<void> {
    this.clearContextCount++;
  }
  clearCurrentSession(): void {
    this.clearCurrentSessionCount++;
    this.currentSessionId = "";
  }
  getCurrentSessionId(): string | null {
    return this.currentSessionId || null;
  }
  async clearSession(): Promise<{ newSessionId: string }> {
    const session = await this.kernel.sessions.createSession();
    this.currentSessionId = session.id;
    return { newSessionId: session.id };
  }
  async compactSession(summary: string): Promise<{ sessionId: string }> {
    this.compactSummaries.push(summary);
    return { sessionId: this.currentSessionId };
  }
  async resumeSession(
    targetSessionId: string,
  ): Promise<{ newSessionId: string }> {
    await this.kernel.sessions.reopenSession(targetSessionId);
    this.currentSessionId = targetSessionId;
    this.resumedSessionIds.push(targetSessionId);
    return { newSessionId: targetSessionId };
  }
  commit(message?: string): Promise<ToolResult> {
    this.commits.push(message ?? "");
    return Promise.resolve(this.commitResult);
  }

  runAudit(category: string): Promise<ToolResult> {
    this.audits.push(category);
    return Promise.resolve(this.auditResult);
  }

  async close(): Promise<void> {
    this.closeCount++;
    this.events.push("chat.close");
  }
  async sendMessage(
    content: string,
    onEvent?: ChatEventHandler,
    _attachments?: Array<{ name: string; type: string; data: string }>,
    _storedContent?: string,
    _changesetId?: string,
    _user?: unknown,
    documentRefs?: Array<{ id: string; versionHash?: string }>,
  ): Promise<string> {
    this.events.push("send.start");
    this.sentMessages.push(content);
    this.sentSessionIds.push(this.getCurrentSessionId());
    this.sentDocumentRefs.push(documentRefs);
    if (this.reply) onEvent?.({ type: "text_delta", text: this.reply });
    if (this.sendMessageBlocker) await this.sendMessageBlocker;
    onEvent?.({ type: "message_complete" });
    this.events.push("send.complete");
    return "";
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => resolve = res);
  return { promise, resolve };
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for condition");
}

async function openSocket(url: string): Promise<WebSocket> {
  const ws = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("WebSocket failed to open"));
  });
  return ws;
}

function nextError(ws: WebSocket): Promise<string> {
  return new Promise((resolve) => {
    ws.onmessage = (evt) => {
      const event = JSON.parse(String(evt.data)) as {
        type?: string;
        text?: string;
      };
      if (event.type === "error") resolve(event.text ?? "");
    };
  });
}

function user(id: string): CurrentUser {
  return {
    id,
    accountId: id,
    displayName: id,
    email: null,
    avatarUrl: null,
  };
}

interface Harness {
  kernel: Kernel;
  base: string;
  chatUrl: string;
  // The chat on each project path, made on first attach.
  chats: Map<string, RecordingChat>;
  chat: RecordingChat;
  // Who the host says is asking; null for nobody.
  as(next: CurrentUser | null): void;
  // The project the host says the IDE has open; null for none.
  open(path: string | null): void;
  attached: string[];
}

const PROJECT = "/projects/one";

async function withAgent(
  setup: (kernel: Kernel) => Promise<string>,
  fn: (h: Harness) => Promise<void>,
): Promise<void> {
  const db = await Database.create({ driver: "pglite" });
  const kernel = new Kernel(db, { composition: testStoreComposition() });
  const firstSession = await setup(kernel);
  let asking: CurrentUser | null = user("acct_owner");
  let openPath: string | null = PROJECT;
  const chats = new Map<string, RecordingChat>();
  const attached: string[] = [];
  const chatAt = (path: string) => {
    let chat = chats.get(path);
    if (!chat) {
      chat = new RecordingChat(kernel, firstSession);
      chats.set(path, chat);
    }
    return chat;
  };
  chatAt(PROJECT);
  const host: AgentHost = {
    user: () => Promise.resolve(asking),
    projectPath: () => Promise.resolve(openPath),
    attach: (path): Promise<AgentProject> => {
      attached.push(path);
      const chat = chatAt(path);
      return Promise.resolve({
        path,
        chat,
        history: inProcessHistoryClient(kernel),
        mcpServers: projectMcpServers(path),
        close: () => chat.close(),
      });
    },
  };
  const agent = createAgentServer(host);
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen: () => {} },
    agent.app.fetch,
  );
  const port = server.addr.port;
  try {
    await fn({
      kernel,
      base: `http://127.0.0.1:${port}`,
      chatUrl: `ws://127.0.0.1:${port}/chat`,
      chats,
      chat: chats.get(PROJECT)!,
      as: (next) => asking = next,
      open: (path) => openPath = path,
      attached,
    });
  } finally {
    await agent.close();
    await server.shutdown();
    await db.close();
  }
}

const ownedSession = (name: string) => async (kernel: Kernel) =>
  (await kernel.sessions.createSession(name, { ownerUserId: "acct_owner" }))
    .id;

Deno.test({
  ...testOpts,
  name: "chat status is compact by default and full on request",
  fn: async () => {
    let sessionId = "";
    await withAgent(async (kernel) => {
      sessionId = await ownedSession("Busy")(kernel);
      return sessionId;
    }, async (h) => {
      const blocker = deferred();
      h.chat.sendMessageBlocker = blocker.promise;
      const compactResult = { omitted: true, keys: ["output"] };
      const fullResult = { output: "x".repeat(10_000) };
      h.chat.inProgressState = {
        text: "visible",
        toolCalls: [{ name: "read_file", input: {}, result: compactResult }],
      };
      h.chat.inProgressFullState = {
        text: "visible",
        toolCalls: [{ name: "read_file", input: {}, result: fullResult }],
      };
      const ws = await openSocket(h.chatUrl);
      try {
        ws.send(JSON.stringify({
          type: "user_message",
          sessionId,
          content: "inspect a large file",
        }));
        await waitFor(() => h.chat.sentMessages.length === 1);

        const compact = await (await fetch(`${h.base}/api/chat/status`))
          .json();
        assertEquals(compact.busy, true);
        assertEquals(compact.currentSessionId, sessionId);
        assertEquals(compact.inProgress.toolCalls[0].result, compactResult);
        const full = await (await fetch(
          `${h.base}/api/chat/status?detail=full`,
        )).json();
        assertEquals(full.inProgress.toolCalls[0].result, fullResult);

        // A reconnect during the turn gets the compact state at once.
        const again = new WebSocket(h.chatUrl);
        const status = await new Promise<Record<string, unknown>>((
          resolve,
        ) => {
          again.onmessage = (evt) => resolve(JSON.parse(String(evt.data)));
        });
        assertEquals(status.type, "agent_status");
        assertEquals(status.busy, true);
        assertEquals(status.text, "visible");
        again.close();
      } finally {
        blocker.resolve();
        ws.close();
      }
    });
  },
});

Deno.test({
  ...testOpts,
  name: "a message realigns the chat to the session the IDE shows",
  fn: async () => {
    let visible = "";
    await withAgent(async (kernel) => {
      visible = await ownedSession("Visible")(kernel);
      return await ownedSession("Stale")(kernel);
    }, async (h) => {
      const ws = await openSocket(h.chatUrl);
      try {
        ws.send(JSON.stringify({
          type: "user_message",
          sessionId: visible,
          content: "yes",
        }));
        await waitFor(() => h.chat.sentMessages.length === 1);
        assertEquals(h.chat.resumedSessionIds, [visible]);
        assertEquals(h.chat.sentSessionIds, [visible]);
        // The model is read per turn: the IDE changes it on serve.
        assertEquals(h.chat.reloadModelCount, 1);
      } finally {
        ws.close();
      }
    });
  },
});

Deno.test({
  ...testOpts,
  name: "an archived session carried on is ended and dropped before a send",
  fn: async () => {
    let sessionId = "";
    await withAgent(async (kernel) => {
      sessionId = await ownedSession("Archived")(kernel);
      await kernel.sessions.archiveSession(sessionId);
      return sessionId;
    }, async (h) => {
      const ws = await openSocket(h.chatUrl);
      try {
        ws.send(JSON.stringify({
          type: "user_message",
          sessionId: null,
          content: "new thread",
        }));
        await waitFor(() => h.chat.sentMessages.length === 1);
        assertEquals(h.chat.clearCurrentSessionCount, 1);
        assertEquals(h.chat.clearContextCount, 1);
        assertEquals(h.chat.sentSessionIds, [null]);
        assert((await h.kernel.sessions.getSession(sessionId))?.endedAt);
      } finally {
        ws.close();
      }
    });
  },
});

Deno.test({
  ...testOpts,
  name: "a send to an archived session is refused",
  fn: async () => {
    let sessionId = "";
    await withAgent(async (kernel) => {
      sessionId = await ownedSession("Archived")(kernel);
      await kernel.sessions.archiveSession(sessionId);
      return sessionId;
    }, async (h) => {
      const ws = await openSocket(h.chatUrl);
      try {
        const error = nextError(ws);
        ws.send(JSON.stringify({
          type: "user_message",
          sessionId,
          content: "should not write",
        }));
        assertStringIncludes(
          await error,
          "Archived sessions must be unarchived",
        );
        assertEquals(h.chat.sentMessages, []);
        // The refusal doesn't leave the agent busy.
        const status = await (await fetch(`${h.base}/api/chat/status`)).json();
        assertEquals(status.busy, false);
      } finally {
        ws.close();
      }
    });
  },
});

Deno.test({
  ...testOpts,
  name: "someone else's private session isn't carried on into their send",
  fn: async () => {
    await withAgent(
      async (kernel) =>
        (await kernel.sessions.createSession("Private", {
          ownerUserId: "acct_owner",
          visibility: "private",
        })).id,
      async (h) => {
        h.as(user("acct_other"));
        const ws = await openSocket(h.chatUrl);
        try {
          ws.send(JSON.stringify({
            type: "user_message",
            content: "new user's message",
          }));
          await waitFor(() => h.chat.sentMessages.length === 1);
          assertEquals(h.chat.sentSessionIds, [null]);
        } finally {
          ws.close();
        }
      },
    );
  },
});

Deno.test({
  ...testOpts,
  name: "document refs reach the chat runtime",
  fn: async () => {
    let sessionId = "";
    await withAgent(async (kernel) => {
      sessionId = await ownedSession("Docs")(kernel);
      return sessionId;
    }, async (h) => {
      const ws = await openSocket(h.chatUrl);
      try {
        ws.send(JSON.stringify({
          type: "user_message",
          sessionId,
          content: "see @[document:doc_1]",
          documentRefs: [{ id: "doc_1" }],
        }));
        await waitFor(() => h.chat.sentMessages.length === 1);
        assertEquals(h.chat.sentDocumentRefs, [[{ id: "doc_1" }]]);
      } finally {
        ws.close();
      }
    });
  },
});

Deno.test({
  ...testOpts,
  name: "a compaction asked for mid-turn waits for the turn, once",
  fn: async () => {
    let sessionId = "";
    await withAgent(async (kernel) => {
      sessionId = await ownedSession("Busy")(kernel);
      await kernel.sessions.addMessage({
        sessionId,
        role: "user",
        content: "keep the active build context",
      });
      return sessionId;
    }, async (h) => {
      const blocker = deferred();
      h.chat.sendMessageBlocker = blocker.promise;
      const ws = await openSocket(h.chatUrl);
      try {
        ws.send(JSON.stringify({
          type: "user_message",
          sessionId,
          content: "continue building",
        }));
        await waitFor(() => h.chat.sentMessages.length === 1);
        const compact = () =>
          fetch(`${h.base}/api/sessions/compact`, {
            method: "POST",
            body: JSON.stringify({ defer: true }),
          });
        const first = await compact();
        const second = await compact();
        assertEquals(first.status, 202);
        assertEquals(await first.json(), {
          queued: true,
          sessionId,
          coalesced: false,
        });
        assertEquals((await second.json()).coalesced, true);
        assertEquals(h.chat.compactSummaries.length, 0);

        // Not deferred, it is refused while busy.
        const now = await fetch(`${h.base}/api/sessions/compact`, {
          method: "POST",
          body: JSON.stringify({ summary: "now" }),
        });
        assertEquals(now.status, 409);
        await now.body?.cancel();

        blocker.resolve();
        await waitFor(() => h.chat.compactSummaries.length === 1);
        assertStringIncludes(
          h.chat.compactSummaries[0]!,
          "keep the active build context",
        );
        await waitFor(async () =>
          !(await (await fetch(`${h.base}/api/chat/status`)).json()).busy
        );
        assertEquals(h.chat.compactSummaries.length, 1);
      } finally {
        blocker.resolve();
        ws.close();
      }
    });
  },
});

Deno.test({
  ...testOpts,
  name: "the current session, once archived, is ended and cleared",
  fn: async () => {
    let sessionId = "";
    await withAgent(async (kernel) => {
      sessionId = await ownedSession("Current")(kernel);
      return sessionId;
    }, async (h) => {
      const current = await fetch(`${h.base}/api/sessions/current`);
      assertEquals((await current.json()).id, sessionId);

      await h.kernel.sessions.archiveSession(sessionId);
      const archived = await fetch(`${h.base}/api/sessions/current`);
      assertEquals(archived.status, 404);
      await archived.body?.cancel();
      assertEquals(h.chat.getCurrentSessionId(), null);
      assertEquals(h.chat.clearContextCount, 1);
      assert((await h.kernel.sessions.getSession(sessionId))?.endedAt);
    });
  },
});

Deno.test({
  ...testOpts,
  name: "a project opens on the user's last session that has messages",
  fn: async () => {
    let mine = "";
    await withAgent(async (kernel) => {
      const said = async (id: string) =>
        await kernel.sessions.addMessage({
          sessionId: id,
          role: "user",
          content: "hi",
        });
      mine = await ownedSession("Mine")(kernel);
      await said(mine);
      // Newer, but empty, someone else's, or archived: none of them.
      await ownedSession("Empty")(kernel);
      const theirs = (await kernel.sessions.createSession("Theirs", {
        ownerUserId: "acct_other",
        visibility: "project",
      })).id;
      await said(theirs);
      const archived = await ownedSession("Archived")(kernel);
      await said(archived);
      await kernel.sessions.archiveSession(archived);
      return "";
    }, async (h) => {
      const current = await fetch(`${h.base}/api/sessions/current`);
      assertEquals((await current.json()).id, mine);
      assertEquals(h.chat.resumedSessionIds, [mine]);
    });
  },
});

Deno.test({
  ...testOpts,
  name: "the last session is reopened once, not after the user starts anew",
  fn: async () => {
    await withAgent(() => Promise.resolve(""), async (h) => {
      const none = await fetch(`${h.base}/api/sessions/current`);
      assertEquals(none.status, 404);
      await none.body?.cancel();

      const later = await ownedSession("Later")(h.kernel);
      await h.kernel.sessions.addMessage({
        sessionId: later,
        role: "user",
        content: "hi",
      });
      const still = await fetch(`${h.base}/api/sessions/current`);
      assertEquals(still.status, 404);
      await still.body?.cancel();
      assertEquals(h.chat.resumedSessionIds, []);
    });
  },
});

Deno.test({
  ...testOpts,
  name: "new, clear and resume act on the live chat",
  fn: async () => {
    let other = "";
    await withAgent(async (kernel) => {
      other = await ownedSession("Other")(kernel);
      return await ownedSession("First")(kernel);
    }, async (h) => {
      const created = await (await fetch(`${h.base}/api/sessions/new`, {
        method: "POST",
      })).json();
      assertEquals(created.newSessionId, h.chat.getCurrentSessionId());

      const cleared = await fetch(`${h.base}/api/sessions/clear`, {
        method: "POST",
      });
      assertEquals(await cleared.json(), { ok: true });
      assertEquals(h.chat.clearContextCount, 1);

      const resumed = await (await fetch(`${h.base}/api/sessions/resume`, {
        method: "POST",
        body: JSON.stringify({ sessionId: other }),
      })).json();
      assertEquals(resumed.newSessionId, other);
      assertEquals(resumed.session.id, other);
      assertEquals(h.chat.getCurrentSessionId(), other);

      const missing = await fetch(`${h.base}/api/sessions/resume`, {
        method: "POST",
        body: JSON.stringify({ sessionId: "nope" }),
      });
      assertEquals(missing.status, 404);
      await missing.body?.cancel();
    });
  },
});

Deno.test({
  ...testOpts,
  name: "switching projects aborts the turn, waits for it, then closes",
  fn: async () => {
    let sessionId = "";
    await withAgent(async (kernel) => {
      sessionId = await ownedSession("Busy")(kernel);
      return sessionId;
    }, async (h) => {
      const blocker = deferred();
      h.chat.sendMessageBlocker = blocker.promise;
      const ws = await openSocket(h.chatUrl);
      try {
        ws.send(JSON.stringify({
          type: "user_message",
          sessionId,
          content: "keep working",
        }));
        await waitFor(() => h.chat.sentMessages.length === 1);

        h.open("/projects/two");
        const switched = fetch(`${h.base}/api/chat/status`);
        await waitFor(() => h.chat.abortCount === 1);
        const early = await Promise.race([
          switched.then(() => true),
          new Promise<boolean>((resolve) =>
            setTimeout(() => resolve(false), 50)
          ),
        ]);
        assertEquals(early, false);
        assertEquals(h.chat.closeCount, 0);

        blocker.resolve();
        const status = await (await switched).json();
        assertEquals(status.busy, false);
        assertEquals(h.chat.events, [
          "send.start",
          "chat.abort",
          "send.complete",
          "chat.close",
        ]);
        assertEquals(h.attached, [PROJECT, "/projects/two"]);
      } finally {
        blocker.resolve();
        ws.close();
      }
    });
  },
});

Deno.test({
  ...testOpts,
  name: "the terminal's ask streams the reply, one turn at a time",
  fn: async () => {
    await withAgent(ownedSession("Terminal"), async (h) => {
      h.chat.reply = "hello from the agent";
      const blocker = deferred();
      h.chat.sendMessageBlocker = blocker.promise;
      const ask = fetch(`${h.base}/api/chat/ask`, {
        method: "POST",
        body: JSON.stringify({ question: "what's here?" }),
      });
      await waitFor(() => h.chat.sentMessages.length === 1);
      const busy = await fetch(`${h.base}/api/chat/ask`, {
        method: "POST",
        body: JSON.stringify({ question: "and now?" }),
      });
      assertEquals(busy.status, 409);
      await busy.body?.cancel();

      blocker.resolve();
      const text = await (await ask).text();
      assertEquals(text, "hello from the agent\r\n");
      assertEquals(h.chat.sentMessages, ["what's here?"]);
    });
  },
});

Deno.test({
  ...testOpts,
  name: "the agent refuses strangers, foreign pages and a missing project",
  fn: async () => {
    await withAgent(ownedSession("Any"), async (h) => {
      const foreign = await fetch(`${h.base}/api/chat/status`, {
        headers: { origin: "https://evil.example" },
      });
      assertEquals(foreign.status, 403);
      await foreign.body?.cancel();

      h.open(null);
      const none = await fetch(`${h.base}/api/chat/status`);
      assertEquals(none.status, 400);
      assertEquals(await none.json(), { error: "No project open" });

      h.as(null);
      const stranger = await fetch(`${h.base}/api/chat/status`);
      assertEquals(stranger.status, 401);
      await stranger.body?.cancel();
      const ws = new WebSocket(h.chatUrl);
      const closed = await new Promise<number>((resolve) => {
        ws.onclose = (evt) => resolve(evt.code);
      });
      assertEquals(closed, 1008);
    });
  },
});

Deno.test({
  ...testOpts,
  name: "the local user can read their own sessions",
  fn: async () => {
    await withAgent(
      async (kernel) => (await kernel.sessions.createSession("Local")).id,
      async (h) => {
        h.as(localUser());
        const current = await fetch(`${h.base}/api/sessions/current`);
        assertEquals(current.status, 200);
        await current.body?.cancel();
      },
    );
  },
});

Deno.test({
  ...testOpts,
  name: "the Audits panel's run goes to the agent's reviewer",
  fn: async () => {
    await withAgent(ownedSession("Audit"), async (h) => {
      const run = (body: unknown) =>
        fetch(`${h.base}/api/audits/run`, {
          method: "POST",
          body: JSON.stringify(body),
        });
      const ran = await run({ category: "security" });
      assertEquals(await ran.json(), { status: "complete" });
      assertEquals(h.chat.audits, ["security"]);

      h.chat.auditResult = {
        ok: false,
        error: { code: "INVALID_CATEGORY", message: "Unknown audit category" },
      };
      const unknown = await run({ category: "nope" });
      assertEquals(unknown.status, 400);
      assertEquals(await unknown.json(), { error: "Unknown audit category" });

      const missing = await run({});
      assertEquals(missing.status, 400);
      await missing.body?.cancel();
    });
  },
});

Deno.test({
  ...testOpts,
  name: "the commit button goes to the agent, errors in serve's git shape",
  fn: async () => {
    await withAgent(ownedSession("Commit"), async (h) => {
      const commit = (body: unknown) =>
        fetch(`${h.base}/api/git/commit`, {
          method: "POST",
          body: JSON.stringify(body),
        });
      const done = await commit({ message: "Fix" });
      assertEquals(await done.json(), { ok: true, status: { clean: true } });
      assertEquals(h.chat.commits, ["Fix"]);

      h.chat.commitResult = {
        ok: false,
        error: { code: "NOTHING_TO_COMMIT", message: "Nothing to commit." },
      };
      const nothing = await commit({});
      assertEquals(nothing.status, 400);
      assertEquals(await nothing.json(), {
        ok: false,
        code: "NOTHING_TO_COMMIT",
        error: "Nothing to commit.",
      });
      assertEquals(h.chat.commits, ["Fix", ""]);
    });
  },
});

Deno.test({
  ...testOpts,
  name: "the IDE's gate asks the agent, and login routes need no user",
  fn: async () => {
    let asking: CurrentUser | null = null;
    const agent = createAgentServer({
      user: () => Promise.resolve(asking),
      accountEntitlementsSupported: false,
      mountAuthRoutes: (app) =>
        app.get("/api/auth/login/start", (c) => c.text("to the provider")),
      projectPath: () => Promise.resolve(null),
      attach: () => Promise.reject(new Error("no project in this test")),
    });
    const get = (path: string) =>
      agent.app.request(path, { headers: { host: "localhost" } });

    assertEquals((await get("/api/auth/me")).status, 401);
    assertEquals(
      await (await get("/api/auth/login/start")).text(),
      "to the provider",
    );
    assertEquals((await get("/api/chat/status")).status, 401);

    asking = user("acct_owner");
    assertEquals(await (await get("/api/auth/me")).json(), {
      user: asking,
      accountEntitlementsSupported: false,
    });
    await agent.close();
  },
});
