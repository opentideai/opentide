// The agent against a stand-in serve: the agent decides who is signed in, the
// project comes from serve's REST API, the turn goes over its /mcp with the
// project's token, and the conversation lands in serve's history.
import { assert, assertEquals } from "@std/assert";
import { ChatOrchestrator } from "./chat.ts";
import type { AuthProvider } from "../core/auth-provider.ts";
import { localUser } from "../core/auth.ts";
import { serveAgentHost } from "./agent-host.ts";
import { createAgentServer } from "./agent-server.ts";
import type { ChatIntelligence } from "../core/chat-intelligence.ts";
import { FakeModelProvider } from "../core/model-provider-fake.ts";
import type { ProviderEvent } from "../core/model-provider.ts";
import { Database } from "../core/db.ts";
import { Kernel } from "../core/registries.ts";
import { MCP_HTTP_PATH } from "../core/config.ts";
import { createProject, getProjectPaths } from "../core/project-manager.ts";
import { writeServerToken } from "../core/server-token.ts";
import { isolateHome, TEST_TMP_DIR } from "../core/test-home_test.ts";
import { createMcpHttpHandler, rejectBadToken } from "../mcp/mcp-http.ts";
import { testStoreComposition } from "../verification/test-stores.ts";

isolateHome();

const testOpts = { sanitizeResources: false, sanitizeOps: false };

const COOKIE = "genie_session=signed-in";
const OWNER = {
  id: "acct_owner",
  accountId: "acct_owner",
  displayName: "Owner",
  email: null,
  avatarUrl: null,
};

const brain: ChatIntelligence = {
  baseSystemPrompt: () => "test system prompt",
  resolveModel: (configured) => configured,
  isApprovalMessage: () => false,
  stepPrompt: (step) => step.description,
  handoffInstruction: () => "HANDOFF:",
  repairPrompt: (step) => `repair ${step.description}`,
  finalReadinessRepairPrompt: () => "repair final readiness",
};

function reply(text: string): ProviderEvent[] {
  return [
    { type: "text_delta", text },
    { type: "message_complete", stopReason: "end_turn" },
  ];
}

// The agent's login: the cookie is the owner's, anything else is no one.
const cookieAuth: AuthProvider = {
  accountEntitlementsSupported: false,
  resolveUser: (req) =>
    Promise.resolve(req.headers.get("cookie") === COOKIE ? OWNER : null),
};

interface FakeServe {
  url: URL;
  kernel: Kernel;
  dir: string;
  // What serve was asked, and with which cookie.
  seen: Array<{ path: string; cookie: string | null }>;
  close(): Promise<void>;
}

// /api/project and /mcp, as serve answers them for one project. Serve has no
// login.
async function fakeServe(): Promise<FakeServe> {
  const parent = await Deno.makeTempDir({
    dir: TEST_TMP_DIR,
    prefix: "agent-",
  });
  const dir = createProject(parent, "Agent host").path;
  const db = await Database.create({ driver: "pglite" });
  const kernel = new Kernel(db, {
    composition: testStoreComposition(),
    historyDir: getProjectPaths(dir).historyDir,
  });
  kernel.projectDir = dir;
  const token = crypto.randomUUID();
  const written = writeServerToken(dir, token);
  assert(written.ok);
  const mcp = createMcpHttpHandler(() => ({ kernel, rebuild: () => {} }));
  const seen: FakeServe["seen"] = [];
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen: () => {} },
    (req) => {
      const path = new URL(req.url).pathname;
      if (path === MCP_HTTP_PATH) {
        return rejectBadToken(req, token) ?? mcp.handle(req);
      }
      seen.push({ path, cookie: req.headers.get("cookie") });
      if (path === "/api/project") {
        return Response.json({ project: { path: dir, name: "Agent host" } });
      }
      return new Response("Not found", { status: 404 });
    },
  );
  return {
    url: new URL(`http://127.0.0.1:${server.addr.port}`),
    kernel,
    dir,
    seen,
    close: async () => {
      await mcp.closeAll();
      await server.shutdown();
      await db.close();
    },
  };
}

Deno.test({
  ...testOpts,
  name: "the agent decides who is signed in; serve never sees the cookie",
  fn: async () => {
    const serve = await fakeServe();
    try {
      const host = serveAgentHost({
        server: serve.url,
        auth: cookieAuth,
        chat: () => {
          throw new Error("not attached in this test");
        },
      });
      const signedIn = new Request("http://agent/api/chat/status", {
        headers: { cookie: COOKIE },
      });
      assertEquals(await host.user(signedIn), OWNER);
      assertEquals(await host.projectPath(signedIn), serve.dir);
      assertEquals(serve.seen, [{ path: "/api/project", cookie: null }]);

      const stranger = new Request("http://agent/api/chat/status");
      assertEquals(await host.user(stranger), null);

      const local = serveAgentHost({
        server: serve.url,
        chat: () => {
          throw new Error("not attached in this test");
        },
      });
      assertEquals((await local.user(stranger))?.id, localUser().id);
    } finally {
      await serve.close();
    }
  },
});

Deno.test({
  ...testOpts,
  name: "a turn through the agent lands in serve's history over MCP",
  fn: async () => {
    const serve = await fakeServe();
    const script: ProviderEvent[][] = [reply("Hello from the agent.")];
    const agent = createAgentServer(serveAgentHost({
      server: serve.url,
      auth: cookieAuth,
      chat: (backend, mcp) =>
        new ChatOrchestrator(
          backend,
          mcp,
          brain,
          new FakeModelProvider(script),
        ),
    }));
    const listener = Deno.serve(
      { hostname: "127.0.0.1", port: 0, onListen: () => {} },
      agent.app.fetch,
    );
    const base = `http://127.0.0.1:${listener.addr.port}`;
    try {
      // A socket can't carry a cookie from Deno; the REST face can. A new
      // session starts on the next message.
      const created = await (await fetch(`${base}/api/sessions/new`, {
        method: "POST",
        headers: { cookie: COOKIE },
      })).json();
      assertEquals(created, { newSessionId: null });
      assertEquals(agent.currentProject(), serve.dir);

      const ask = await fetch(`${base}/api/chat/ask`, {
        method: "POST",
        headers: { cookie: COOKIE },
        body: JSON.stringify({ question: "Say hello." }),
      });
      assertEquals(await ask.text(), "Hello from the agent.\r\n");

      const [session] = await serve.kernel.sessions.listSessions(10, 0);
      assert(session);
      assertEquals(session.ownerUserId, OWNER.id);
      const messages = await serve.kernel.sessions.getMessages(session.id);
      assertEquals(
        messages.map((m) => [m.role, m.content]),
        [["user", "Say hello."], ["assistant", "Hello from the agent."]],
      );

      // External MCP servers are the agent's; serve never hears of them.
      const added = await fetch(`${base}/api/mcp-servers`, {
        method: "POST",
        headers: { cookie: COOKIE },
        body: JSON.stringify({
          name: "docs",
          transport: "url",
          url: "http://127.0.0.1:1/mcp",
          enabled: false,
        }),
      });
      assertEquals(added.status, 201);
      await added.body?.cancel();
      const listed = await (await fetch(`${base}/api/mcp-servers`, {
        headers: { cookie: COOKIE },
      })).json() as Array<{ name: string; status: string }>;
      assertEquals(
        listed.map((s) => [s.name, s.status]),
        [["docs", "disconnected"]],
      );
      assert(!serve.seen.some((s) => s.path.startsWith("/api/mcp-servers")));
    } finally {
      await agent.close();
      await listener.shutdown();
      await serve.close();
    }
  },
});

Deno.test({
  ...testOpts,
  name: "a new token on serve makes the agent reattach",
  fn: async () => {
    const serve = await fakeServe();
    const attachments: string[] = [];
    const host = serveAgentHost({
      server: serve.url,
      chat: (backend, mcp) => {
        attachments.push("attached");
        return new ChatOrchestrator(
          backend,
          mcp,
          brain,
          new FakeModelProvider([]),
        );
      },
    });
    try {
      const project = await host.attach(serve.dir);
      assertEquals(project.stale?.(), false);
      writeServerToken(serve.dir, crypto.randomUUID());
      assertEquals(project.stale?.(), true);
      await project.close();
    } finally {
      await serve.close();
    }
    assertEquals(attachments, ["attached"]);
  },
});
