import { assert, assertEquals, assertRejects } from "@std/assert";
import { appFetchHandler, appFetchShim, type AppForward } from "./app-fetch.ts";
import {
  decodeResponse,
  encodeRequest,
  type WireResponse,
} from "./protocol.ts";

const testOpts = { sanitizeResources: false, sanitizeOps: false };

interface Served {
  origin: string;
  seen: string[];
  close(): Promise<void>;
}

// A stand-in for the app: answers by path and records what it was asked.
function serveApp(): Served {
  const seen: string[] = [];
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen: () => {} },
    async (req) => {
      const url = new URL(req.url);
      seen.push(`${req.method} ${url.pathname}${url.search}`);
      switch (url.pathname) {
        case "/a":
          return Response.redirect(new URL("/b", url), 302);
        case "/post":
          return new Response(null, {
            status: 303,
            headers: { location: "/b" },
          });
        case "/keep":
          return new Response(null, {
            status: 307,
            headers: { location: "/echo" },
          });
        case "/away":
          return Response.redirect("http://elsewhere.example/x", 302);
        case "/echo":
          return new Response(`${req.method} ${await req.text()}`);
        default:
          return new Response(`at ${url.pathname}${url.search}`);
      }
    },
  );
  return {
    origin: `http://127.0.0.1:${server.addr.port}`,
    seen,
    close: () => server.shutdown(),
  };
}

// The runner's hop to the kernel, made without a connection in between.
function directForward(origin: string): AppForward {
  const handler = appFetchHandler(() => origin);
  return async (request) => {
    const answer = await handler(await encodeRequest(request));
    assert(answer.ok, JSON.stringify(answer));
    return decodeResponse(answer.data as WireResponse);
  };
}

Deno.test({
  ...testOpts,
  name: "the kernel fetches only its own app, whatever host it's handed",
  fn: async () => {
    const app = serveApp();
    try {
      const handler = appFetchHandler(() => app.origin);
      const answer = await handler(
        await encodeRequest(new Request("http://evil.example:1/x?y=1")),
      );
      assert(answer.ok);
      const res = decodeResponse(answer.data as WireResponse);
      assertEquals(await res.text(), "at /x?y=1");
      assertEquals(app.seen, ["GET /x?y=1"]);
    } finally {
      await app.close();
    }
  },
});

Deno.test({
  ...testOpts,
  name: "the kernel hands a redirect back instead of following it",
  fn: async () => {
    const app = serveApp();
    try {
      const answer = await appFetchHandler(() => app.origin)(
        await encodeRequest(new Request(`${app.origin}/away`)),
      );
      assert(answer.ok);
      const res = answer.data as WireResponse;
      assertEquals(res.status, 302);
      assertEquals(app.seen, ["GET /away"]);
    } finally {
      await app.close();
    }
  },
});

Deno.test({
  ...testOpts,
  name: "the runner's fetch sends its app to the kernel and the rest out",
  fn: async () => {
    const app = serveApp();
    const outside: string[] = [];
    const realFetch: typeof fetch = (input) => {
      outside.push(input instanceof Request ? input.url : String(input));
      return Promise.resolve(new Response("outside"));
    };
    const shimmed = appFetchShim(
      realFetch,
      () => app.origin,
      directForward(app.origin),
    );
    try {
      assertEquals(
        await (await shimmed(`${app.origin}/p?q=1`)).text(),
        "at /p?q=1",
      );
      assertEquals(
        await (await shimmed("https://api.example/")).text(),
        "outside",
      );

      // Followed in the runner, the way fetch would.
      assertEquals(await (await shimmed(`${app.origin}/a`)).text(), "at /b");
      const posted = await shimmed(`${app.origin}/post`, {
        method: "POST",
        body: "x",
      });
      assertEquals(await posted.text(), "at /b");
      const kept = await shimmed(`${app.origin}/keep`, {
        method: "PUT",
        body: "kept",
      });
      assertEquals(await kept.text(), "PUT kept");

      // Off the app's origin, the redirect goes through the real fetch.
      assertEquals(
        await (await shimmed(`${app.origin}/away`)).text(),
        "outside",
      );
      assertEquals(outside, [
        "https://api.example/",
        "http://elsewhere.example/x",
      ]);

      const manual = await shimmed(`${app.origin}/a`, { redirect: "manual" });
      assertEquals(manual.status, 302);
      await manual.body?.cancel();
      await assertRejects(
        () => shimmed(`${app.origin}/a`, { redirect: "error" }),
        TypeError,
      );
      assertEquals(app.seen, [
        "GET /p?q=1",
        "GET /a",
        "GET /b",
        "POST /post",
        "GET /b",
        "PUT /keep",
        "PUT /echo",
        "GET /away",
        "GET /a",
        "GET /a",
      ]);
    } finally {
      await app.close();
    }
  },
});
