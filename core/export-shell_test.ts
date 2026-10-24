import { assertEquals } from "@std/assert";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { testStoreComposition } from "../verification/test-stores.ts";
import { writeExportFiles } from "./build.ts";
import { Database } from "./db.ts";
import { exportProject } from "./export.ts";
import { Kernel } from "./registries.ts";

/* The emitted shell's RESPONSES, end to end over app.fetch.

   core/export-router_test.ts covers which handler a request reaches.
   This covers everything the Hono instance used to do around that: the CORS header,
   the 404 body and content-type, the 500 a throwing handler produces, HEAD's empty
   body, the preflight, and the three generated platform routes.

   Plus the one thing the Hono shell never did: reject a request that violates its
   route's schema. Those probes are the first body-carrying ones in this file. The
   preview↔export comparison of those same 400s is core/preview-export-parity_test.ts;
   here they only have to work.

   Every expectation below was measured against the previous Hono shell — the same
   project exported at the commit before the swap, driven through the same probes — so
   a change here is a change in what an already-exported app does. The three probes
   that deliberately DIVERGE from what Hono answered say so where they sit: the miss
   envelope and the two OPTIONS ones, both fixing defects the swap reproduced on
   purpose so a smoke failure would stay unambiguous. */

interface Probe {
  label: string;
  request: Request;
  status: number;
  headers: Record<string, string>;
  // Omitted when the body is not what the probe is about — openapi.json's is the
  // generated spec, whose shape is covered elsewhere.
  body?: string;
}

function url(path: string): string {
  return `http://localhost${path}`;
}

const TEXT_PLAIN = "text/plain; charset=UTF-8";
const JSON_CT = { "content-type": "application/json" };
const CORS = { "access-control-allow-origin": "*" };
const ALLOW_METHODS = "GET,HEAD,PUT,POST,DELETE,PATCH,QUERY";

function envelope(code: string, message: string): string {
  return JSON.stringify({ error: true, code, message });
}

const PROBES: Probe[] = [
  {
    label: "the generated health route",
    request: new Request(url("/_health")),
    status: 200,
    headers: { ...CORS, "content-type": "application/json" },
    body: '{"ok":true,"name":"Shell App","version":"9.9.9"}',
  },
  {
    // Hono dispatches HEAD as GET and returns the GET response with no body.
    label: "HEAD is served by the GET route, without its body",
    request: new Request(url("/_health"), { method: "HEAD" }),
    status: 200,
    headers: { ...CORS, "content-type": "application/json" },
    body: "",
  },
  {
    label: "the generated openapi route",
    request: new Request(url("/openapi.json")),
    status: 200,
    headers: { ...CORS, "content-type": "application/json; charset=utf-8" },
  },
  {
    label: "the generated asset route",
    request: new Request(url("/_assets/logo.svg")),
    status: 200,
    headers: { ...CORS, "content-type": "image/svg+xml" },
    body: "<svg/>",
  },
  {
    label: "an unknown asset",
    request: new Request(url("/_assets/nope.svg")),
    status: 404,
    headers: { ...CORS, "content-type": TEXT_PLAIN },
    body: "Not found",
  },
  {
    label: "a fetch-ABI handler reading its body and params",
    request: new Request(url("/echo/42"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: "hello" }),
    }),
    status: 200,
    headers: { ...CORS, "content-type": "application/json" },
    body: '{"echoed":"hello","id":"42"}',
  },
  {
    label: "a legacy-ABI handler through the emitted shim",
    request: new Request(url("/legacy/7")),
    status: 200,
    headers: { ...CORS, "content-type": "application/json" },
    body: '{"id":"7"}',
  },
  {
    // The shim's fresh path, whose content-type comes from the Response constructor
    // rather than from Hono's own constant — hence the missing space. Pinned in
    // core/handler-abi.ts so it does not differ between the Deno and Node artifacts.
    label: "a legacy handler's still-fresh c.text()",
    request: new Request(url("/legacy-text")),
    status: 200,
    headers: { ...CORS, "content-type": "text/plain;charset=UTF-8" },
    body: "plain",
  },
  {
    // DIVERGES from Hono, which answered a plain-text 404 with no Allow header. The
    // live preview has always answered this way (core/app-server.ts); the export
    // matches it now, down to the wording and the comma-space join.
    label: "a registered path under the wrong method is a 405, with Allow",
    request: new Request(url("/echo/42")),
    status: 405,
    headers: { ...CORS, ...JSON_CT, allow: "POST" },
    body: envelope(
      "METHOD_NOT_ALLOWED",
      "Method GET is not allowed for /echo/42.",
    ),
  },
  {
    label: "a path registered under two methods lists both, in export order",
    request: new Request(url("/multi"), { method: "DELETE" }),
    status: 405,
    headers: { ...CORS, ...JSON_CT, allow: "GET, POST" },
    body: envelope(
      "METHOD_NOT_ALLOWED",
      "Method DELETE is not allowed for /multi.",
    ),
  },
  {
    // DIVERGES from Hono's plain-text `404 Not Found`, same reason.
    label: "an unregistered path",
    request: new Request(url("/nope")),
    status: 404,
    headers: { ...CORS, ...JSON_CT },
    body: envelope("NOT_FOUND", "No route matches GET /nope."),
  },
  {
    label: "a trailing slash does not match",
    request: new Request(url("/legacy/7/")),
    status: 404,
    headers: { ...CORS, ...JSON_CT },
    body: envelope("NOT_FOUND", "No route matches GET /legacy/7/."),
  },
  {
    // A 405's body is dropped like any other GET response body would be.
    label: "HEAD on a wrong-method path keeps the 405 and drops the body",
    request: new Request(url("/echo/42"), { method: "HEAD" }),
    status: 405,
    headers: { ...CORS, ...JSON_CT, allow: "POST" },
    body: "",
  },
  {
    label: "a throwing handler",
    request: new Request(url("/boom")),
    status: 500,
    headers: { ...CORS, "content-type": TEXT_PLAIN },
    body: "Internal Server Error",
  },
  {
    // A path with routes but none under OPTIONS still preflights — that is where a
    // browser's preflight lands, and answering 405 there would break every CORS
    // request the exported app serves.
    label: "OPTIONS on a path with no OPTIONS route preflights, never 405s",
    request: new Request(url("/echo/42"), { method: "OPTIONS" }),
    status: 204,
    headers: { ...CORS, "access-control-allow-methods": ALLOW_METHODS },
    body: "",
  },
  {
    // DIVERGES from Hono + cors(), which answered 204 here and never reached the
    // handler. The route table now gets first refusal on OPTIONS.
    label: "an OPTIONS handler is reachable",
    request: new Request(url("/opt"), { method: "OPTIONS" }),
    status: 200,
    headers: { ...CORS, ...JSON_CT },
    body: '{"via":"options"}',
  },
  {
    // DIVERGES for the same reason: an ALL route accepts OPTIONS like any method.
    label: "an ALL route serves OPTIONS",
    request: new Request(url("/any"), { method: "OPTIONS" }),
    status: 200,
    headers: { ...CORS, ...JSON_CT },
    body: '{"via":"all"}',
  },
  {
    label: "an ALL route still serves the other methods",
    request: new Request(url("/any"), { method: "PATCH" }),
    status: 200,
    headers: { ...CORS, ...JSON_CT },
    body: '{"via":"all"}',
  },
  {
    label: "OPTIONS on an unregistered path, with requested headers echoed",
    request: new Request(url("/nope"), {
      method: "OPTIONS",
      headers: { "access-control-request-headers": "X-A, x-b" },
    }),
    status: 204,
    headers: {
      ...CORS,
      "access-control-allow-methods": ALLOW_METHODS,
      // Comma-joined WITHOUT spaces, and `vary` only when the request asked.
      "access-control-allow-headers": "X-A,x-b",
      "vary": "Access-Control-Request-Headers",
    },
    body: "",
  },
  // --- Schema validation ---------------------------------------------------------
  {
    label: "a request that satisfies the schema reaches the handler",
    request: new Request(url("/validated/42?limit=5"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: "hello" }),
    }),
    status: 200,
    headers: { ...CORS, ...JSON_CT },
    // The handler read the body, which means the clone taken before validation works.
    body: '{"echoed":"hello","id":"42"}',
  },
  {
    label: "a path param of the wrong type is a 400",
    request: new Request(url("/validated/abc?limit=5"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: "hello" }),
    }),
    status: 400,
    headers: { ...CORS, ...JSON_CT },
    body: JSON.stringify({
      error: "Validation failed",
      details: [{ in: "path", path: "/id", message: "must be integer" }],
    }),
  },
  {
    label: "a missing required query param is a 400",
    request: new Request(url("/validated/42"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: "hello" }),
    }),
    status: 400,
    headers: { ...CORS, ...JSON_CT },
    body: JSON.stringify({
      error: "Validation failed",
      details: [{
        in: "query",
        path: "/",
        message: "must have required property 'limit'",
      }],
    }),
  },
  {
    label: "a body violating the schema is a 400, with ajv's own message",
    request: new Request(url("/validated/42?limit=5"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: "x" }),
    }),
    status: 400,
    headers: { ...CORS, ...JSON_CT },
    body: JSON.stringify({
      error: "Validation failed",
      details: [{
        in: "body",
        path: "/value",
        message: "must NOT have fewer than 2 characters",
      }],
    }),
  },
  {
    label: "a body that is not JSON gets its own envelope",
    request: new Request(url("/validated/42?limit=5"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    }),
    status: 400,
    headers: { ...CORS, ...JSON_CT },
    body: JSON.stringify({ error: "Invalid JSON body" }),
  },
  {
    label: "the schemaless route sharing the handler is NOT validated",
    // Same handler, same shaped request, no schema on this route: it must reach the
    // handler untouched. A validators table keyed by handler name would 400 this.
    request: new Request(url("/echo/abc"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: "x" }),
    }),
    status: 200,
    headers: { ...CORS, ...JSON_CT },
    body: '{"echoed":"x","id":"abc"}',
  },
];

function populate(kernel: Kernel): void {
  kernel.handlers.register(
    "echo",
    `async function echo(req: Request, ctx: HandlerContext): Promise<Response> {
  const body = await req.json() as { value: string };
  return Response.json({ echoed: body.value, id: ctx.params.id });
}`,
    () => new Response(),
  );
  kernel.handlers.register(
    "legacyEcho",
    `function legacyEcho(c: any) { return c.json({ id: c.req.param("id") }); }`,
    () => new Response(),
  );
  kernel.handlers.register(
    "legacyText",
    `function legacyText(c: any) { return c.text("plain"); }`,
    () => new Response(),
  );
  kernel.handlers.register(
    "boom",
    `function boom(req: Request): Response { throw new Error("kaboom"); }`,
    () => new Response(),
  );
  kernel.handlers.register(
    "optionsProbe",
    `function optionsProbe(req: Request): Response {
  return Response.json({ via: "options" });
}`,
    () => new Response(),
  );
  kernel.handlers.register(
    "anyProbe",
    `function anyProbe(req: Request): Response {
  return Response.json({ via: "all" });
}`,
    () => new Response(),
  );
  kernel.routes.register("POST", "/echo/:id", "echo", { summary: "echo" });
  // The SAME handler as /echo/:id, with a schema. Two routes, one handler, different
  // validation — which is why the validators table is keyed by method and path. Keyed by
  // handler name, a request to /echo/42 would be validated against this schema.
  kernel.routes.register("POST", "/validated/:id", "echo", {
    params: { id: { type: "integer" } },
    query: { limit: { type: "integer", required: true } },
    body: {
      type: "object",
      properties: { value: { type: "string", minLength: 2 } },
      required: ["value"],
    },
  });
  kernel.routes.register("GET", "/legacy/:id", "legacyEcho");
  kernel.routes.register("GET", "/legacy-text", "legacyText");
  kernel.routes.register("GET", "/boom", "boom");
  kernel.routes.register("OPTIONS", "/opt", "optionsProbe");
  kernel.routes.register("ALL", "/any", "anyProbe");
  // Two methods on one path, for the Allow header a 405 carries.
  kernel.routes.register("GET", "/multi", "legacyText");
  kernel.routes.register("POST", "/multi", "legacyText");
  kernel.assets.register(
    "logo.svg",
    new TextEncoder().encode("<svg/>"),
    "image/svg+xml",
  );
}

Deno.test({
  name: "the emitted shell answers every probe the Hono shell answered",
  // The app boots PGlite, which the sanitizers see as outstanding ops.
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const db = await Database.create({ driver: "pglite" });
    const dir = Deno.makeTempDirSync({ prefix: "export-shell-" });
    const cwd = Deno.cwd();
    try {
      const kernel = new Kernel(db, { composition: testStoreComposition() });
      populate(kernel);
      const { files } = await exportProject(kernel, {
        projectName: "Shell App",
        projectVersion: "9.9.9",
      });
      writeExportFiles(dir, files);

      // The app's PGlite data directory is relative to the cwd, and openapi.json /
      // assets are read relative to the module, so run it from its own tree.
      Deno.chdir(dir);
      const mod = await import(pathToFileURL(join(dir, "main.ts")).href) as {
        createApp: () => Promise<{ fetch(req: Request): Promise<Response> }>;
      };
      const app = await mod.createApp();

      for (const probe of PROBES) {
        const res = await app.fetch(probe.request);
        const body = await res.text();
        assertEquals(
          {
            status: res.status,
            headers: Object.fromEntries([...res.headers].sort()),
            ...(probe.body === undefined ? {} : { body }),
          },
          {
            status: probe.status,
            headers: Object.fromEntries(
              Object.entries(probe.headers).sort(([a], [b]) => a < b ? -1 : 1),
            ),
            ...(probe.body === undefined ? {} : { body: probe.body }),
          },
          probe.label,
        );
      }
    } finally {
      Deno.chdir(cwd);
      await db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
});
