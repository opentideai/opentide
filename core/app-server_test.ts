import {
  assert,
  assertEquals,
  assertNotEquals,
  assertStringIncludes,
} from "@std/assert";
import { Kernel } from "./registries.ts";
import { Database } from "./db.ts";
import { createAppServer } from "./app-server.ts";
import { APP_PORT_AUTO } from "./config.ts";
import type { RouteSchema } from "./types.ts";

// The app-preview server must not crash a second stack that shares its port:
// binding an already-taken port falls back to an OS-assigned free one, and the
// IDE reads the actual bound port back from the kernel. See core/app-server.ts.

const testOpts = { sanitizeResources: false, sanitizeOps: false };

async function kernelWithRoute(): Promise<{ kernel: Kernel; db: Database }> {
  const db = await Database.create({ driver: "pglite" });
  const kernel = new Kernel(db);
  // A single route is enough to make the app server actually bind (the bind
  // guard is `routes.length > 0`); we never call the handler here.
  kernel.routes.register("GET", "/ping", "ping");
  return { kernel, db };
}

Deno.test({
  ...testOpts,
  name: "createAppServer: APP_PORT_AUTO binds an OS-assigned free port",
  fn: async () => {
    const { kernel, db } = await kernelWithRoute();
    const server = createAppServer(kernel, APP_PORT_AUTO);
    try {
      server.rebuild();
      assert(server.listening, "app server should be listening");
      assert(server.port > 0, "auto port should resolve to a real port");
    } finally {
      await server.shutdown();
      await db.close();
    }
  },
});

Deno.test({
  ...testOpts,
  name:
    "createAppServer: a taken port falls back to a free one instead of crashing",
  fn: async () => {
    const { kernel, db } = await kernelWithRoute();
    // Grab a definitely-in-use port by binding one auto-assigned server first.
    const occupier = createAppServer(kernel, APP_PORT_AUTO);
    occupier.rebuild();
    const takenPort = occupier.port;
    assert(takenPort > 0);

    // A second server asked for the same port must not throw — it falls back.
    const second = createAppServer(kernel, takenPort);
    try {
      second.rebuild();
      assert(second.listening, "second server should still come up");
      assert(second.port > 0);
      assertNotEquals(
        second.port,
        takenPort,
        "second server should bind a different (free) port",
      );
    } finally {
      await second.shutdown();
      await occupier.shutdown();
      await db.close();
    }
  },
});

Deno.test({
  ...testOpts,
  name: "createAppServer: an explicit free port is honored as-is",
  fn: async () => {
    const { kernel, db } = await kernelWithRoute();
    // Find a free port via an auto server, release it, then ask for it back.
    const probe = createAppServer(kernel, APP_PORT_AUTO);
    probe.rebuild();
    const freePort = probe.port;
    await probe.shutdown();

    const server = createAppServer(kernel, freePort);
    try {
      server.rebuild();
      assertEquals(
        server.port,
        freePort,
        "a free explicit port is bound as-is",
      );
    } finally {
      await server.shutdown();
      await db.close();
    }
  },
});

// Reserve a currently-free port by binding an auto server, reading its port,
// then releasing it — the OS won't immediately hand the same number to another
// bind, so it's a safe "known free" target for a fixed rebind.
async function freePortVia(kernel: Kernel): Promise<number> {
  const probe = createAppServer(kernel, APP_PORT_AUTO);
  probe.rebuild();
  const p = probe.port;
  await probe.shutdown();
  return p;
}

// Confirm the app handler survives a rebind: the built app still routes, so a
// request to the bound port returns the ping handler's response, not a socket
// error. Proves only the listener was recycled, not the app/kernel.
async function assertServes(port: number): Promise<void> {
  const resp = await fetch(`http://127.0.0.1:${port}/ping`);
  // The route is registered but its handler is not — the app answers with the
  // framework's "handler not found" 500, which still proves the listener + app
  // are live and routing on the new port.
  await resp.body?.cancel();
  assert(resp.status > 0, "a live server must answer on the rebound port");
}

Deno.test({
  ...testOpts,
  name: "rebind: auto → fixed binds the requested free port and tracks it",
  fn: async () => {
    const { kernel, db } = await kernelWithRoute();
    const server = createAppServer(kernel, APP_PORT_AUTO);
    try {
      server.rebuild();
      assert(server.port > 0);
      const target = await freePortVia(kernel);

      const bound = await server.rebind(target);
      assertEquals(bound, target, "a free fixed port is bound as requested");
      assertEquals(server.port, target, "self.port reflects the rebound port");
      assertEquals(
        kernel.appPort,
        target,
        "kernel.appPort tracks the live port",
      );
      assert(server.listening);
      await assertServes(target);
    } finally {
      await server.shutdown();
      await db.close();
    }
  },
});

Deno.test({
  ...testOpts,
  name: "rebind: fixed → fixed moves between two free ports",
  fn: async () => {
    const { kernel, db } = await kernelWithRoute();
    const first = await freePortVia(kernel);
    const server = createAppServer(kernel, first);
    try {
      server.rebuild();
      assertEquals(server.port, first);

      const second = await freePortVia(kernel);
      assertNotEquals(second, first);
      const bound = await server.rebind(second);
      assertEquals(bound, second, "rebind lands on the second free port");
      assertEquals(server.port, second);
      assertEquals(kernel.appPort, second);
      await assertServes(second);
    } finally {
      await server.shutdown();
      await db.close();
    }
  },
});

Deno.test({
  ...testOpts,
  name: "rebind: onto a taken port falls back to a free one",
  fn: async () => {
    const { kernel, db } = await kernelWithRoute();
    const server = createAppServer(kernel, APP_PORT_AUTO);
    // Occupy a port with a throwaway server, then rebind onto it.
    const occupier = createAppServer(kernel, APP_PORT_AUTO);
    try {
      server.rebuild();
      occupier.rebuild();
      const takenPort = occupier.port;
      assert(takenPort > 0);

      const bound = await server.rebind(takenPort);
      assertNotEquals(
        bound,
        takenPort,
        "rebind onto a taken port must fall back to a free one",
      );
      assertEquals(server.port, bound, "self.port reflects the fallback port");
      assertEquals(kernel.appPort, bound, "kernel.appPort tracks the fallback");
      await assertServes(bound);
    } finally {
      await server.shutdown();
      await occupier.shutdown();
      await db.close();
    }
  },
});

Deno.test({
  ...testOpts,
  name: "rebind: while not yet listening still binds and starts serving",
  fn: async () => {
    const { kernel, db } = await kernelWithRoute();
    // Never call rebuild() — the server has no listener yet.
    const server = createAppServer(kernel, APP_PORT_AUTO);
    try {
      assert(!server.listening, "no listener before rebind");
      const target = await freePortVia(kernel);

      const bound = await server.rebind(target);
      assertEquals(bound, target, "rebind binds even without a prior listener");
      assert(server.listening, "rebind starts listening from cold");
      assertEquals(kernel.appPort, target);
      await assertServes(target);
    } finally {
      await server.shutdown();
      await db.close();
    }
  },
});

Deno.test({
  ...testOpts,
  name:
    "setProxy: injects the console-capture script into proxied HTML, passes other assets through",
  fn: async () => {
    const { kernel, db } = await kernelWithRoute();
    // A stand-in "imported dev server": HTML on /, plus a JSON and a JS asset that
    // must proxy through byte-for-byte (only text/html is rewritten).
    const child = Deno.serve({ port: 0, onListen: () => {} }, (req) => {
      const path = new URL(req.url).pathname;
      if (path === "/data.json") {
        return new Response('{"x":1}', {
          headers: { "content-type": "application/json" },
        });
      }
      if (path === "/app.js") {
        return new Response("console.log(1)", {
          headers: { "content-type": "application/javascript" },
        });
      }
      return new Response("<html><head></head><body>hi</body></html>", {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    });
    const appServer = createAppServer(kernel, APP_PORT_AUTO);
    try {
      appServer.setProxy(child.addr.port);
      const base = `http://127.0.0.1:${appServer.port}`;

      // HTML gets the intercept script, and its Content-Length matches the rewritten
      // body (a stale length would truncate it in the browser). No stale encoding.
      const htmlRes = await fetch(`${base}/`);
      const html = await htmlRes.text();
      assertStringIncludes(html, "data-genie-console");
      assertStringIncludes(html, "genie:console");
      assertStringIncludes(html, "genie:preview-location");
      assertEquals(htmlRes.headers.get("content-encoding"), null);
      const cl = htmlRes.headers.get("content-length");
      if (cl !== null) {
        assertEquals(Number(cl), new TextEncoder().encode(html).byteLength);
      }

      // Non-HTML assets stream through untouched.
      const jsonRes = await fetch(`${base}/data.json`);
      assertEquals(await jsonRes.text(), '{"x":1}');
      const jsRes = await fetch(`${base}/app.js`);
      assertEquals(await jsRes.text(), "console.log(1)");
    } finally {
      await appServer.shutdown();
      await child.shutdown();
      await db.close();
    }
  },
});

// The gateway validates a request body by reading it through Hono, which caches
// by consuming the underlying Request. Handlers now receive that Request directly
// (core/types.ts HandlerFn), so without a clone taken before validation every
// body-schema route would hand the handler an already-drained body. Nothing else
// in the suite covers it: routes without a body schema never hit the path, and
// legacy handlers read through the shim's own copy.
Deno.test({
  ...testOpts,
  name: "createAppServer: a validated body is still readable by the handler",
  fn: async () => {
    const db = await Database.create({ driver: "pglite" });
    const kernel = new Kernel(db);
    const schema: RouteSchema = {
      summary: "Echo a validated body",
      body: {
        type: "object",
        properties: { title: { type: "string" } },
        required: ["title"],
      },
      responses: { "200": { description: "ok" } },
    };
    kernel.handlers.register(
      "echoTitle",
      "async function echoTitle(req, ctx) {}",
      async (req: Request) => {
        const body = await req.json() as { title: string };
        return Response.json({ echoed: body.title });
      },
      schema,
    );
    kernel.routes.register("POST", "/echo", "echoTitle", schema);

    const server = createAppServer(kernel, APP_PORT_AUTO);
    try {
      server.rebuild();
      const base = `http://127.0.0.1:${server.port}`;

      const ok = await fetch(`${base}/echo`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "hello" }),
      });
      assertEquals(ok.status, 200);
      assertEquals(await ok.json(), { echoed: "hello" });

      // The clone must not cost the validation it was added around.
      const bad = await fetch(`${base}/echo`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ notTitle: 1 }),
      });
      assertEquals(bad.status, 400);
      assertStringIncludes(await bad.text(), "Validation failed");
    } finally {
      await server.shutdown();
      await db.close();
    }
  },
});

/* A repeated query key validates on its FIRST value. `c.req.query()` returned the first;
   Object.fromEntries(searchParams) — the obvious replacement — returns the last, so
   `?limit=5&limit=nope` would have flipped from valid to a 400. Nothing covered it. */
Deno.test({
  ...testOpts,
  name: "createAppServer: a repeated query key validates on its first value",
  fn: async () => {
    const db = await Database.create({ driver: "pglite" });
    const kernel = new Kernel(db);
    const schema: RouteSchema = {
      summary: "A numeric limit",
      query: { limit: { type: "integer", required: true } },
      responses: { "200": { description: "ok" } },
    };
    kernel.handlers.register(
      "limited",
      "function limited(req) {}",
      (req: Request) =>
        Response.json({
          limit: new URL(req.url).searchParams.get("limit"),
        }),
      schema,
    );
    kernel.routes.register("GET", "/limited", "limited", schema);

    const server = createAppServer(kernel, APP_PORT_AUTO);
    try {
      server.rebuild();
      const base = `http://127.0.0.1:${server.port}`;

      // First value is the integer, so it validates — even though the second is not.
      const ok = await fetch(`${base}/limited?limit=5&limit=nope`);
      assertEquals(ok.status, 200);

      // And first value bad is a 400 whatever follows it.
      const bad = await fetch(`${base}/limited?limit=nope&limit=5`);
      assertEquals(bad.status, 400);
      assertStringIncludes(await bad.text(), "Validation failed");
    } finally {
      await server.shutdown();
      await db.close();
    }
  },
});

/* A path param declared `{ type: "number" }` still reaches the handler as a STRING.
   HandlerContext.params is Record<string, string> and nothing in the ABI says otherwise,
   but ajv runs with coerceTypes and mutates its input in place — so validating the
   params object the handler is about to receive would quietly turn "42" into 42. The
   Hono shell never noticed: c.req.param() minted a fresh object per call, so the
   validated copy and the handler's copy were different objects by accident. */
Deno.test({
  ...testOpts,
  name:
    "createAppServer: a validated numeric param reaches the handler as a string",
  fn: async () => {
    const db = await Database.create({ driver: "pglite" });
    const kernel = new Kernel(db);
    const schema: RouteSchema = {
      summary: "A numeric id",
      params: { id: { type: "number" } },
      responses: { "200": { description: "ok" } },
    };
    kernel.handlers.register(
      "typedId",
      "function typedId(req, ctx) {}",
      (_req: Request, ctx: { params: Readonly<Record<string, string>> }) =>
        Response.json({ id: ctx.params.id, type: typeof ctx.params.id }),
      schema,
    );
    kernel.routes.register("GET", "/typed/:id", "typedId", schema);

    const server = createAppServer(kernel, APP_PORT_AUTO);
    try {
      server.rebuild();
      const res = await fetch(`http://127.0.0.1:${server.port}/typed/42`);
      assertEquals(res.status, 200);
      assertEquals(await res.json(), { id: "42", type: "string" });
    } finally {
      await server.shutdown();
      await db.close();
    }
  },
});

Deno.test({
  ...testOpts,
  name: "createAppServer: handlers receive route params via HandlerContext",
  fn: async () => {
    const db = await Database.create({ driver: "pglite" });
    const kernel = new Kernel(db);
    kernel.handlers.register(
      "showTodo",
      "async function showTodo(req, ctx) {}",
      (req: Request, ctx: { params: Readonly<Record<string, string>> }) =>
        Response.json({
          id: ctx.params.id,
          method: req.method,
          q: new URL(req.url).searchParams.get("q"),
        }),
    );
    kernel.routes.register("GET", "/todos/:id", "showTodo");

    const server = createAppServer(kernel, APP_PORT_AUTO);
    try {
      server.rebuild();
      const res = await fetch(
        `http://127.0.0.1:${server.port}/todos/42?q=hi`,
      );
      assertEquals(res.status, 200);
      assertEquals(await res.json(), { id: "42", method: "GET", q: "hi" });
    } finally {
      await server.shutdown();
      await db.close();
    }
  },
});

/* The preview's OWN surfaces — the ones no other test touches, and the ones
   core/preview-export-parity_test.ts deliberately leaves alone because an export does
   not have them (or has them at another path).

   Written against the Hono implementation and expected to survive the shell being
   rewritten under them, which is the only reason they are worth having. The
   `app.all("*")` 501 answer for a runtime with no shared gateway contract is NOT here:
   no registered adapter declares executionMode "proxy" (core/runtime.ts), so that
   branch is unreachable in this build and a probe for it would have to fake the runtime
   registry — a known way to leak state into later tests. */
Deno.test({
  ...testOpts,
  name: "createAppServer: the preview's platform surfaces",
  fn: async () => {
    const db = await Database.create({ driver: "pglite" });
    const kernel = new Kernel(db);
    kernel.handlers.register(
      "page",
      "function page(req) {}",
      () =>
        new Response("<html><head></head><body>hi</body></html>", {
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
      { summary: "A page", responses: { "200": { description: "ok" } } },
    );
    kernel.routes.register("GET", "/page", "page");
    kernel.assets.register(
      "logo.svg",
      new TextEncoder().encode("<svg/>"),
      "image/svg+xml",
    );

    const server = createAppServer(kernel, APP_PORT_AUTO);
    try {
      server.rebuild();
      const base = `http://127.0.0.1:${server.port}`;

      // The generated OpenAPI spec, at the preview's own path. An export serves the
      // same document at /openapi.json — a different path, hence not comparable.
      const spec = await fetch(`${base}/_api/openapi.json`);
      assertEquals(spec.status, 200);
      assertStringIncludes(
        spec.headers.get("content-type") ?? "",
        "application/json",
      );
      const doc = await spec.json() as {
        openapi: string;
        paths: Record<string, unknown>;
      };
      assertEquals(doc.openapi, "3.0.3");
      assert("/page" in doc.paths);

      // Swagger UI. Preview-only; an export ships no docs page.
      const docs = await fetch(`${base}/_api/docs`);
      assertEquals(docs.status, 200);
      assertStringIncludes(docs.headers.get("content-type") ?? "", "text/html");
      assertStringIncludes(await docs.text(), "SwaggerUIBundle");

      // A registered asset, with the ETag the 304 below turns on.
      const asset = await fetch(`${base}/_assets/logo.svg`);
      assertEquals(asset.status, 200);
      assertEquals(asset.headers.get("content-type"), "image/svg+xml");
      assertEquals(asset.headers.get("cache-control"), "no-cache");
      const etag = asset.headers.get("etag");
      assert(etag !== null && etag.startsWith('"'), `etag: ${etag}`);
      assertEquals(await asset.text(), "<svg/>");

      const revalidated = await fetch(`${base}/_assets/logo.svg`, {
        headers: { "If-None-Match": etag },
      });
      assertEquals(revalidated.status, 304);
      assertEquals(revalidated.headers.get("etag"), etag);
      assertEquals(await revalidated.text(), "");

      // An asset miss is plain text, NOT the JSON route-miss envelope: the envelope is
      // for a route miss, and this path matched a route that then found nothing.
      const missing = await fetch(`${base}/_assets/nope.svg`);
      assertEquals(missing.status, 404);
      assertStringIncludes(
        missing.headers.get("content-type") ?? "",
        "text/plain",
      );
      assertEquals(await missing.text(), "Not found");

      // The console-capture script is spliced into any text/html a handler returns, and
      // content-length has to describe the SPLICED body or a browser truncates it.
      const page = await fetch(`${base}/page`);
      assertEquals(page.status, 200);
      const html = await page.text();
      assertStringIncludes(html, "data-genie-console");
      assertStringIncludes(html, "genie:preview-location");
      const length = page.headers.get("content-length");
      if (length !== null) {
        assertEquals(Number(length), new TextEncoder().encode(html).byteLength);
      }

      // A HEAD on an HTML route keeps the GET's headers. It does NOT prove the body was
      // stripped server-side — an HTTP client drops a HEAD body whatever the server
      // sends, so nothing over the wire can. injectConsoleIntoHtml refuses a bodiless
      // response for that reason, rather than depending on the order it is called in.
      const headPage = await fetch(`${base}/page`, { method: "HEAD" });
      assertEquals(headPage.status, 200);
      assertStringIncludes(
        headPage.headers.get("content-type") ?? "",
        "text/html",
      );
      assertEquals(await headPage.text(), "");
    } finally {
      await server.shutdown();
      await db.close();
    }
  },
});
