// The agent as the IDE's only origin, in front of a stand-in serve: what the
// agent doesn't serve reaches serve as it was sent, sockets included, behind
// the agent's loopback check and, under /api, its login.
import { assert, assertEquals } from "@std/assert";
import { createAgentServer } from "./agent-server.ts";
import { forwardTo } from "./front-door.ts";
import type { AgentHost } from "./agent-server.ts";

const testOpts = { sanitizeResources: false, sanitizeOps: false };

const COOKIE = "genie_session=signed-in";

const host: AgentHost = {
  user: (req) =>
    Promise.resolve(
      req.headers.get("cookie") === COOKIE
        ? {
          id: "acct_owner",
          accountId: "acct_owner",
          displayName: "Owner",
          email: null,
          avatarUrl: null,
        }
        : null,
    ),
  projectPath: () => Promise.resolve(null),
  attach: () => Promise.reject(new Error("no project in this test")),
};

interface Seen {
  method: string;
  path: string;
  host: string | null;
  origin: string | null;
  body: string;
}

// Answers every request with what it saw; /terminal echoes over a socket.
function fakeServe() {
  const seen: Seen[] = [];
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen: () => {} },
    async (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/terminal") {
        const { socket, response } = Deno.upgradeWebSocket(req);
        socket.onmessage = (evt) => socket.send(`echo ${evt.data}`);
        return response;
      }
      seen.push({
        method: req.method,
        path: `${url.pathname}${url.search}`,
        host: req.headers.get("host"),
        origin: req.headers.get("origin"),
        body: await req.text(),
      });
      if (url.pathname === "/moved") {
        return new Response(null, {
          status: 302,
          headers: { location: "/projects" },
        });
      }
      return Response.json({ from: "serve" });
    },
  );
  return {
    url: new URL(`http://127.0.0.1:${server.addr.port}`),
    seen,
    close: () => server.shutdown(),
  };
}

async function withFrontDoor(
  fn: (base: string, serve: ReturnType<typeof fakeServe>) => Promise<void>,
) {
  const serve = fakeServe();
  const agent = createAgentServer(host, { forward: forwardTo(serve.url) });
  const listener = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen: () => {} },
    agent.app.fetch,
  );
  try {
    await fn(`http://127.0.0.1:${listener.addr.port}`, serve);
  } finally {
    await agent.close();
    await listener.shutdown();
    await serve.close();
  }
}

Deno.test({
  ...testOpts,
  name: "the built IDE comes from serve, with no login",
  fn: () =>
    withFrontDoor(async (base, serve) => {
      const res = await fetch(`${base}/projects?x=1`);
      assertEquals(await res.json(), { from: "serve" });
      assertEquals(serve.seen[0]?.path, "/projects?x=1");
      assertEquals(serve.seen[0]?.host, serve.url.host);
    }),
});

Deno.test({
  ...testOpts,
  name: "serve's API is behind the agent's login",
  fn: () =>
    withFrontDoor(async (base, serve) => {
      const refused = await fetch(`${base}/api/project`);
      assertEquals(refused.status, 401);
      await refused.body?.cancel();
      assertEquals(serve.seen, []);

      const res = await fetch(`${base}/api/config/models`, {
        method: "PUT",
        headers: {
          cookie: COOKIE,
          origin: base,
          "content-type": "application/json",
        },
        body: JSON.stringify({ agent: "m" }),
      });
      assertEquals(await res.json(), { from: "serve" });
      assertEquals(serve.seen, [{
        method: "PUT",
        path: "/api/config/models",
        host: serve.url.host,
        origin: serve.url.origin,
        body: '{"agent":"m"}',
      }]);
    }),
});

Deno.test({
  ...testOpts,
  name: "the agent's own routes stay the agent's",
  fn: () =>
    withFrontDoor(async (base, serve) => {
      const res = await fetch(`${base}/api/auth/me`, {
        headers: { cookie: COOKIE },
      });
      const body = await res.json() as { user: { id: string } };
      assertEquals(body.user.id, "acct_owner");
      assertEquals(serve.seen, []);
    }),
});

Deno.test({
  ...testOpts,
  name: "serve's redirects reach the browser as serve sent them",
  fn: () =>
    withFrontDoor(async (base) => {
      const res = await fetch(`${base}/moved`, { redirect: "manual" });
      assertEquals(res.status, 302);
      assertEquals(res.headers.get("location"), "/projects");
      await res.body?.cancel();
    }),
});

Deno.test({
  ...testOpts,
  name: "a foreign Host is refused before serve sees it",
  fn: async () => {
    const serve = fakeServe();
    const agent = createAgentServer(host, { forward: forwardTo(serve.url) });
    try {
      const res = await agent.app.request("/projects", {
        headers: { host: "evil.example" },
      });
      assertEquals(res.status, 403);
      await res.body?.cancel();
      assertEquals(serve.seen, []);
    } finally {
      await agent.close();
      await serve.close();
    }
  },
});

Deno.test({
  ...testOpts,
  name: "serve's sockets pass through, including what's sent before it opens",
  fn: () =>
    withFrontDoor(async (base) => {
      const ws = new WebSocket(`${base.replace("http", "ws")}/terminal`);
      const replies: string[] = [];
      const done = new Promise<void>((resolve, reject) => {
        ws.onmessage = (evt) => {
          replies.push(String(evt.data));
          if (replies.length === 2) resolve();
        };
        ws.onerror = () => reject(new Error("socket failed"));
      });
      await new Promise((resolve) => ws.onopen = resolve);
      ws.send("one");
      ws.send("two");
      await done;
      assertEquals(replies, ["echo one", "echo two"]);
      const closed = new Promise((resolve) => ws.onclose = resolve);
      ws.close();
      await closed;
    }),
});

Deno.test({
  ...testOpts,
  name: "with serve gone, a request gets a 502",
  fn: async () => {
    const serve = fakeServe();
    const gone = serve.url;
    await serve.close();
    const agent = createAgentServer(host, { forward: forwardTo(gone) });
    const res = await agent.app.request("/projects", {
      headers: { host: "localhost" },
    });
    assertEquals(res.status, 502);
    assert((await res.json() as { error: string }).error);
  },
});
