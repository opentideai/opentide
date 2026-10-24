import { assert, assertEquals, assertRejects } from "@std/assert";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { testStoreComposition } from "../verification/test-stores.ts";
import { createAppServer } from "./app-server.ts";
import { writeExportFiles } from "./build.ts";
import { compileHandler, initCompiler, stopCompiler } from "./compiler.ts";
import {
  APP_AUTH_GATE_CONFIG,
  APP_PORT_AUTO,
  CORS_ALLOW_METHODS,
} from "./config.ts";
import { Database } from "./db.ts";
import { exportProject } from "./export.ts";
import { Kernel } from "./registries.ts";
import type { RouteSchema } from "./types.ts";

/* Does a user's app answer the same in the preview as it does once exported?

   Two hosts serve a user app: the live preview (core/app-server.ts) and the app
   export's emitted shell. Until this file, NOTHING compared them —
   verification/route-parity.ts compares export TARGETS to each other (deno-source /
   node / binary) and has never looked at the preview. So an app could work in the
   preview and break in production, or the reverse, with nothing to say so.

   One route table, one set of handler sources, both hosts, one probe list.

   The handler FUNCTION the preview dispatches is compiled from the same source string
   the export emits (core/compiler.ts), so the two hosts cannot be running different
   handlers — only different shells.

   WHAT IS COMPARED. Status, body, and a NAMED SUBSET of headers. Not the full header
   set: the preview is probed over real TCP, so Deno adds content-length, date and
   friends, while the export is driven through app.fetch and carries only what the app
   set. Comparing everything would compare the transport.

   Schema validation USED to be on the excluded list, because the export did not do any.
   It does now — the same schemas, compiled by the same ajv to source at export time — so
   the 400s are compared here like everything else, bodies included, down to ajv's own
   message strings. core/export-validators_test.ts is what earns that: the differential
   showing a generated validator and a runtime-compiled one agree on the verdict, the
   errors and the coercion.

   DELIBERATELY NOT COMPARED, because the preview is a development surface and the
   difference is the point: the 503 handler timeout, the 500 body (the preview answers
   the error message and mints a forensic evidence document; the export answers plain-text
   "Internal Server Error"), and the platform routes, which are not even at the same
   paths — /_api/openapi.json and /_api/docs in the preview, /openapi.json in the export.

   DIVERGENCES. A probe carrying `exportDiffers` records a place the two hosts
   genuinely disagree today. Each says why and which slice closes it. An entry there is
   a defect written down, not a behaviour endorsed — when the count below reaches zero
   the two hosts agree on everything this file probes.

   The count is asserted, so a new divergence cannot be absorbed quietly and closing one
   has to be a deliberate edit rather than a green run. It is zero and has been since the
   last slice of stage 10 closed the fifth. One more was predicted and measured away: both
   hosts' envelopes carry a bare application/json, because Hono's c.json() did not append
   a charset either. */

// Lower this only by closing a divergence, never to make a run pass. Zero means the two
// hosts agree on everything below, which is the state this file exists to hold.
const OPEN_DIVERGENCES = 0;

// --- The fixture ---------------------------------------------------------------

interface HandlerSource {
  name: string;
  source: string;
}

const HANDLERS: HandlerSource[] = [
  {
    name: "byId",
    source:
      `function byId(req: Request, ctx: { params: Record<string, string> }): Response {
  return Response.json({ via: "byId", id: ctx.params.id ?? null });
}`,
  },
  {
    name: "staticNew",
    source: `function staticNew(req: Request): Response {
  return Response.json({ via: "staticNew" });
}`,
  },
  {
    name: "numeric",
    source:
      `function numeric(req: Request, ctx: { params: Record<string, string> }): Response {
  return Response.json({ via: "numeric", id: ctx.params.id ?? null });
}`,
  },
  {
    name: "midWild",
    source: `function midWild(req: Request): Response {
  return Response.json({ via: "midWild" });
}`,
  },
  {
    name: "files",
    source: `function files(req: Request): Response {
  return Response.json({ via: "files" });
}`,
  },
  {
    name: "optionsProbe",
    source: `function optionsProbe(req: Request): Response {
  return Response.json({ via: "options" });
}`,
  },
  {
    name: "multi",
    source: `function multi(req: Request): Response {
  return Response.json({ via: "multi" });
}`,
  },
  // The validation fixtures echo what they RECEIVED, not just that they ran. That makes a
  // 200 probe assert the two hosts hand the handler identical data — which is the failure
  // mode nothing would otherwise report, since a wrongly-coerced param produces a 200 on
  // both sides with different content.
  {
    name: "vParam",
    source:
      `function vParam(req: Request, ctx: { params: Record<string, string> }): Response {
  return Response.json({ via: "vParam", id: ctx.params.id, type: typeof ctx.params.id });
}`,
  },
  {
    name: "vQuery",
    source: `function vQuery(req: Request): Response {
  const u = new URL(req.url);
  return Response.json({
    via: "vQuery",
    limit: u.searchParams.get("limit"),
    kind: u.searchParams.get("kind"),
  });
}`,
  },
  {
    name: "vBody",
    source:
      `async function vBody(req: Request, ctx: { params: Record<string, string> }): Promise<Response> {
  const body = await req.json();
  return Response.json({ via: "vBody", got: body, id: ctx.params.id ?? null });
}`,
  },
];

// The body schema shared by the two vBody routes, so the probes below can be read
// against one declaration.
const BODY_SCHEMA: RouteSchema["body"] = {
  type: "object",
  properties: {
    value: { type: "string", minLength: 2 },
    n: { type: "integer" },
  },
  required: ["value"],
};

// Registration ORDER is load-bearing. `/items/new` is registered BEFORE `/items/:id`
// on purpose: the preview resolves in this order, the export in its own sort, and that
// is exactly how the two come apart (divergence 1 below).
const ROUTES: Array<[string, string, string, RouteSchema?]> = [
  ["GET", "/items/new", "staticNew"],
  ["GET", "/items/:id", "byId"],
  ["GET", "/num/:id{[0-9]+}", "numeric"],
  ["GET", "/mid/*/y", "midWild"],
  ["GET", "/files/*", "files"],
  ["OPTIONS", "/opt", "optionsProbe"],
  ["GET", "/multi", "multi"],
  ["POST", "/multi", "multi"],
  // Schema-bearing routes. Appended, so the precedence probes above keep the
  // registration order they depend on — none of these paths overlaps an existing one.
  ["GET", "/v/param/:id", "vParam", { params: { id: { type: "integer" } } }],
  ["GET", "/v/query", "vQuery", {
    query: {
      limit: { type: "integer", required: true },
      kind: { type: "string", enum: ["a", "b"] },
    },
  }],
  ["POST", "/v/body", "vBody", { body: BODY_SCHEMA }],
  // The SAME handler as /v/body, with all three slots. Two routes, one handler,
  // different schemas: the validators table is keyed by method and path, and a table
  // keyed by handler name would validate /v/body against this route's params.
  ["POST", "/v/all/:id", "vBody", {
    params: { id: { type: "integer" } },
    query: { limit: { type: "integer", required: true } },
    body: BODY_SCHEMA,
  }],
  // `format` on BOTH sides of the derivation split: dropped from the params shorthand,
  // passed through to ajv inside the body. Both hosts must treat it the same way —
  // documented, not asserted — and must still enforce everything around it.
  ["POST", "/v/format/:id", "vBody", {
    params: { id: { type: "string", format: "uuid" } },
    body: {
      type: "object",
      properties: {
        email: { type: "string", format: "email" },
        n: { type: "integer" },
      },
      required: ["n"],
    },
  }],
];

// --- Probes --------------------------------------------------------------------

/** The headers worth comparing: what the shell decides, never what the transport adds. */
const COMPARED_HEADERS = [
  "content-type",
  "allow",
  "access-control-allow-origin",
  "access-control-allow-methods",
  "access-control-allow-headers",
  "vary",
] as const;

interface Expected {
  status: number;
  /** Omitted when the body is not what the probe is about. */
  body?: string;
  /** Only the COMPARED_HEADERS keys; an absent key is asserted absent. */
  headers?: Record<string, string>;
}

interface Probe {
  label: string;
  /** A factory, not a Request: each host needs its own, and a body reads once. */
  request: () => Request;
  expect: Expected;
  exportDiffers?: { expect: Expected; why: string };
}

// Both hosts' envelopes AND both hosts' handlers land on a bare application/json:
// Hono's c.json() does not append a charset, and neither does Response.json(). Measured,
// because the opposite was the obvious guess.
const JSON_CT = "application/json";
const CORS_ORIGIN = { "access-control-allow-origin": "*" };

/* The preflight's method list — one constant, read from core/config.ts by both hosts.

   It was a divergence nobody predicted. The export PINS the list so an exported app's
   preflight stops drifting with whatever `npm:hono@4` resolved to on the day it was
   installed, and the value pinned is Hono 4.13.1's — the version the emitted
   package.json declares. But the kernel's own lock pins hono@4.12.21, and QUERY entered
   cors()'s default in 4.13.1, so the live preview advertised six methods and an exported
   app seven: the pin measured from the wrong side of a lock two minors behind. QUERY
   stays, because it matches the Hono an exported app installs and a preflight naming a
   method the app does not route costs a browser nothing. */
const ALLOW_METHODS = CORS_ALLOW_METHODS;

function url(path: string): string {
  return `http://localhost${path}`;
}

function envelope(code: string, message: string): string {
  return JSON.stringify({ error: true, code, message });
}

const PROBES: Probe[] = [
  {
    label: "a param route, with its param",
    request: () => new Request(url("/items/7")),
    expect: {
      status: 200,
      body: '{"via":"byId","id":"7"}',
      headers: { ...CORS_ORIGIN, "content-type": JSON_CT },
    },
  },
  {
    // The GET response's headers survive; only the body goes.
    label: "HEAD is served by the GET route, without its body",
    request: () => new Request(url("/items/7"), { method: "HEAD" }),
    expect: {
      status: 200,
      body: "",
      headers: { ...CORS_ORIGIN, "content-type": JSON_CT },
    },
  },
  {
    label: "a terminal wildcard's bare parent",
    request: () => new Request(url("/files")),
    expect: {
      status: 200,
      body: '{"via":"files"}',
      headers: { ...CORS_ORIGIN, "content-type": JSON_CT },
    },
  },
  {
    label: "an unregistered path is a 404 envelope",
    request: () => new Request(url("/nope")),
    expect: {
      status: 404,
      body: envelope("NOT_FOUND", "No route matches GET /nope."),
      headers: { ...CORS_ORIGIN, "content-type": JSON_CT },
    },
  },
  {
    label: "a registered path under the wrong method is a 405, with Allow",
    request: () => new Request(url("/items/7"), { method: "DELETE" }),
    expect: {
      status: 405,
      body: envelope(
        "METHOD_NOT_ALLOWED",
        "Method DELETE is not allowed for /items/7.",
      ),
      headers: { ...CORS_ORIGIN, "content-type": JSON_CT, allow: "GET" },
    },
  },
  {
    label: "Allow lists every method a path is registered under",
    request: () => new Request(url("/multi"), { method: "PUT" }),
    expect: {
      status: 405,
      headers: {
        ...CORS_ORIGIN,
        "content-type": JSON_CT,
        allow: "GET, POST",
      },
    },
  },
  {
    // Both hosts resolve in the canonical order (core/route-order.ts), so /items/:id
    // shadows /items/new in BOTH — registration order no longer decides. That the
    // param route wins is the export's long-standing behaviour, not an improvement;
    // what changed is that the preview now shows it instead of hiding it.
    label: "a static route registered after an overlapping param route",
    request: () => new Request(url("/items/new")),
    expect: {
      status: 200,
      body: '{"via":"byId","id":"new"}',
      headers: { ...CORS_ORIGIN, "content-type": JSON_CT },
    },
  },
  {
    // Both hosts honour the constraint, so no route is registered at this path under
    // ANY method and the answer is a plain 404. The preview used to say 405 here.
    label: "a constrained param the value does not satisfy",
    request: () => new Request(url("/num/abc"), { method: "POST" }),
    expect: {
      status: 404,
      body: envelope("NOT_FOUND", "No route matches POST /num/abc."),
      headers: { ...CORS_ORIGIN, "content-type": JSON_CT },
    },
  },
  {
    // A non-terminal `*` is ONE segment in both hosts, so three do not match and
    // nothing is registered at this path. The preview used to answer 405 with
    // `Allow: GET` — refusing the very method it named.
    label: "a non-terminal wildcard given more than one segment",
    request: () => new Request(url("/mid/a/b/y")),
    expect: {
      status: 404,
      body: envelope("NOT_FOUND", "No route matches GET /mid/a/b/y."),
      headers: { ...CORS_ORIGIN, "content-type": JSON_CT },
    },
  },
  {
    // Reachable in both hosts now. cors() used to answer every OPTIONS request in the
    // preview before anything routed, so this handler could never run there.
    label: "an OPTIONS handler the app registered itself",
    request: () => new Request(url("/opt"), { method: "OPTIONS" }),
    expect: {
      status: 200,
      body: '{"via":"options"}',
      headers: { ...CORS_ORIGIN, "content-type": JSON_CT },
    },
  },
  {
    label: "a browser preflight, on a path with no OPTIONS route",
    request: () =>
      new Request(url("/items/7"), {
        method: "OPTIONS",
        headers: { "access-control-request-headers": "x-a, x-b" },
      }),
    expect: {
      status: 204,
      body: "",
      headers: {
        ...CORS_ORIGIN,
        "access-control-allow-methods": ALLOW_METHODS,
        "access-control-allow-headers": "x-a,x-b",
        vary: "Access-Control-Request-Headers",
      },
    },
  },
  // --- Schema validation -----------------------------------------------------------
  //
  // Both hosts compile the same derived schemas with the same ajv options; the export's
  // were compiled to source at export time. So these compare BODIES, not just statuses —
  // if ajv's message strings did not survive codegen, every one of them fails here.
  {
    label: "a valid param reaches the handler as a STRING, not coerced",
    // ajv runs with coerceTypes and would rewrite "7" to 7 in place. Both hosts validate
    // a copy; if either stopped, its handler would report "number" and this diverges.
    request: () => new Request(url("/v/param/7")),
    expect: {
      status: 200,
      body: '{"via":"vParam","id":"7","type":"string"}',
      headers: { ...CORS_ORIGIN, "content-type": JSON_CT },
    },
  },
  {
    label: "a param of the wrong type is a 400",
    request: () => new Request(url("/v/param/abc")),
    expect: {
      status: 400,
      body: JSON.stringify({
        error: "Validation failed",
        details: [{ in: "path", path: "/id", message: "must be integer" }],
      }),
      headers: { ...CORS_ORIGIN, "content-type": JSON_CT },
    },
  },
  {
    label: "a valid query reaches the handler with its raw strings",
    request: () => new Request(url("/v/query?limit=5&kind=a")),
    expect: {
      status: 200,
      body: '{"via":"vQuery","limit":"5","kind":"a"}',
      headers: { ...CORS_ORIGIN, "content-type": JSON_CT },
    },
  },
  {
    label: "a missing required query param is a 400",
    request: () => new Request(url("/v/query")),
    expect: {
      status: 400,
      body: JSON.stringify({
        error: "Validation failed",
        details: [{
          in: "query",
          path: "/",
          message: "must have required property 'limit'",
        }],
      }),
      headers: { ...CORS_ORIGIN, "content-type": JSON_CT },
    },
  },
  {
    label: "a query param outside its enum is a 400",
    request: () => new Request(url("/v/query?limit=5&kind=z")),
    expect: {
      status: 400,
      body: JSON.stringify({
        error: "Validation failed",
        details: [{
          in: "query",
          path: "/kind",
          message: "must be equal to one of the allowed values",
        }],
      }),
      headers: { ...CORS_ORIGIN, "content-type": JSON_CT },
    },
  },
  {
    label: "a repeated query key validates on its FIRST value, in both hosts",
    // Object.fromEntries(searchParams) keeps the last; both hosts keep the first.
    request: () => new Request(url("/v/query?limit=5&limit=nope")),
    expect: {
      status: 200,
      body: '{"via":"vQuery","limit":"5","kind":null}',
      headers: { ...CORS_ORIGIN, "content-type": JSON_CT },
    },
  },
  {
    label: "a valid body is still readable by the handler",
    // The clone taken before validation. If either host read the body without cloning,
    // its handler would get an empty stream and 500.
    request: () =>
      new Request(url("/v/body"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ value: "hello", n: 3 }),
      }),
    expect: {
      status: 200,
      body: '{"via":"vBody","got":{"value":"hello","n":3},"id":null}',
      headers: { ...CORS_ORIGIN, "content-type": JSON_CT },
    },
  },
  {
    label: "a body missing a required property is a 400",
    request: () =>
      new Request(url("/v/body"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ n: 1 }),
      }),
    expect: {
      status: 400,
      body: JSON.stringify({
        error: "Validation failed",
        details: [{
          in: "body",
          path: "/",
          message: "must have required property 'value'",
        }],
      }),
      headers: { ...CORS_ORIGIN, "content-type": JSON_CT },
    },
  },
  {
    label: "a body string under minLength is a 400, with ajv's own wording",
    request: () =>
      new Request(url("/v/body"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ value: "x" }),
      }),
    expect: {
      status: 400,
      body: JSON.stringify({
        error: "Validation failed",
        details: [{
          in: "body",
          path: "/value",
          message: "must NOT have fewer than 2 characters",
        }],
      }),
      headers: { ...CORS_ORIGIN, "content-type": JSON_CT },
    },
  },
  {
    label: "every body error is reported, not just the first",
    // allErrors: true on both sides. With it off, only one detail comes back.
    request: () =>
      new Request(url("/v/body"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ value: "x", n: 1.5 }),
      }),
    expect: {
      status: 400,
      body: JSON.stringify({
        error: "Validation failed",
        details: [
          {
            in: "body",
            path: "/value",
            message: "must NOT have fewer than 2 characters",
          },
          { in: "body", path: "/n", message: "must be integer" },
        ],
      }),
      headers: { ...CORS_ORIGIN, "content-type": JSON_CT },
    },
  },
  {
    label: "a body that is not JSON gets its own envelope",
    request: () =>
      new Request(url("/v/body"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not json",
      }),
    expect: {
      status: 400,
      body: JSON.stringify({ error: "Invalid JSON body" }),
      headers: { ...CORS_ORIGIN, "content-type": JSON_CT },
    },
  },
  {
    label: "path, query and body errors accumulate in that order",
    request: () =>
      new Request(url("/v/all/abc"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ n: 1 }),
      }),
    expect: {
      status: 400,
      body: JSON.stringify({
        error: "Validation failed",
        details: [
          { in: "path", path: "/id", message: "must be integer" },
          {
            in: "query",
            path: "/",
            message: "must have required property 'limit'",
          },
          {
            in: "body",
            path: "/",
            message: "must have required property 'value'",
          },
        ],
      }),
      headers: { ...CORS_ORIGIN, "content-type": JSON_CT },
    },
  },
  {
    label:
      "a malformed body discards the path and query errors already collected",
    request: () =>
      new Request(url("/v/all/abc"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{",
      }),
    expect: {
      status: 400,
      body: JSON.stringify({ error: "Invalid JSON body" }),
      headers: { ...CORS_ORIGIN, "content-type": JSON_CT },
    },
  },
  {
    label:
      "the route sharing vBody without params is NOT validated against them",
    // /v/body and /v/all/:id share one handler. A validators table keyed by handler name
    // would apply /v/all/:id's params schema here and 400 a request with no :id at all.
    request: () =>
      new Request(url("/v/body"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ value: "ok" }),
      }),
    expect: {
      status: 200,
      body: '{"via":"vBody","got":{"value":"ok"},"id":null}',
      headers: { ...CORS_ORIGIN, "content-type": JSON_CT },
    },
  },
  {
    label: "a format keyword is documented, not asserted — in both hosts",
    // Neither host rejects a malformed email or a non-uuid id. ajv 8 ships no formats
    // and asserting them is a separate decision; what matters here is that the two
    // agree.
    request: () =>
      new Request(url("/v/format/not-a-uuid"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ n: 1, email: "nonsense" }),
      }),
    expect: {
      status: 200,
      body:
        '{"via":"vBody","got":{"n":1,"email":"nonsense"},"id":"not-a-uuid"}',
      headers: { ...CORS_ORIGIN, "content-type": JSON_CT },
    },
  },
  {
    label: "a format keyword does not cost the body its other checks",
    // The regression this guards. Before ajv was told to ignore formats, the `format:
    // "email"` above failed the WHOLE body schema to compile and this request — missing
    // a required `n` — reached the handler and 200d.
    request: () =>
      new Request(url("/v/format/x"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "a@b.c" }),
      }),
    expect: {
      status: 400,
      body: JSON.stringify({
        error: "Validation failed",
        details: [{
          in: "body",
          path: "/",
          message: "must have required property 'n'",
        }],
      }),
      headers: { ...CORS_ORIGIN, "content-type": JSON_CT },
    },
  },
  {
    label: "a schemaless route is untouched by any of this",
    request: () => new Request(url("/items/abc")),
    expect: {
      status: 200,
      body: '{"via":"byId","id":"abc"}',
      headers: { ...CORS_ORIGIN, "content-type": JSON_CT },
    },
  },
];

// --- Running both hosts --------------------------------------------------------

interface Answer {
  status: number;
  body: string;
  headers: Record<string, string>;
}

async function answer(response: Response): Promise<Answer> {
  const headers: Record<string, string> = {};
  for (const name of COMPARED_HEADERS) {
    const value = response.headers.get(name);
    if (value !== null) headers[name] = value;
  }
  return { status: response.status, body: await response.text(), headers };
}

function expected(e: Expected, actual: Answer): Answer {
  return {
    status: e.status,
    body: e.body ?? actual.body,
    headers: e.headers ?? actual.headers,
  };
}

interface Hosts {
  preview(request: Request): Promise<Response>;
  exported(request: Request): Promise<Response>;
}

/** The fixture in both hosts. `configure` runs after the fixture is registered and
 *  before the export, so a config it sets is baked into the exported app too. */
async function withBothHosts(
  configure: (kernel: Kernel) => Promise<void> | void,
  run: (hosts: Hosts, kernel: Kernel) => Promise<void>,
): Promise<void> {
  await initCompiler();
  const db = await Database.create({ driver: "pglite" });
  const dir = Deno.makeTempDirSync({ prefix: "preview-export-parity-" });
  const cwd = Deno.cwd();
  const kernel = new Kernel(db, { composition: testStoreComposition() });
  let preview: ReturnType<typeof createAppServer> | null = null;
  try {
    const deps = await kernel.compileDeps();
    for (const { name, source } of HANDLERS) {
      const compiled = await compileHandler(name, source, deps);
      assert(compiled.ok, `${name} did not compile`);
      kernel.handlers.register(name, source, compiled.data);
    }
    for (const [method, path, handlerName, schema] of ROUTES) {
      kernel.routes.register(method, path, handlerName, schema);
    }
    await configure(kernel);

    const { files } = await exportProject(kernel, {
      projectName: "Parity App",
      projectVersion: "0.0.1",
    });
    writeExportFiles(dir, files);

    preview = createAppServer(kernel, APP_PORT_AUTO);
    preview.rebuild();
    const base = `http://127.0.0.1:${preview.port}`;

    // The exported app's PGlite directory is relative to the cwd, so run it from its
    // own tree. The preview is already bound and does not care.
    Deno.chdir(dir);
    const mod = await import(pathToFileURL(join(dir, "main.ts")).href) as {
      createApp: () => Promise<{ fetch(req: Request): Promise<Response> }>;
    };
    const exported = await mod.createApp();

    await run({
      // pathname AND search. Rebuilding the URL without the query string would send
      // every query-validation probe to the preview stripped of the thing it is
      // probing, and they would pass by answering the export's question twice.
      preview: (request) => {
        const u = new URL(request.url);
        return fetch(new Request(base + u.pathname + u.search, request));
      },
      exported: (request) => exported.fetch(request),
    }, kernel);
  } finally {
    Deno.chdir(cwd);
    if (preview) await preview.shutdown();
    await db.close();
    stopCompiler();
    rmSync(dir, { recursive: true, force: true });
  }
}

async function assertProbes(hosts: Hosts, probes: Probe[]): Promise<void> {
  for (const probe of probes) {
    const previewAnswer = await answer(await hosts.preview(probe.request()));
    const exportedAnswer = await answer(await hosts.exported(probe.request()));

    assertEquals(
      previewAnswer,
      expected(probe.expect, previewAnswer),
      `preview: ${probe.label}`,
    );
    assertEquals(
      exportedAnswer,
      expected(
        probe.exportDiffers?.expect ?? probe.expect,
        exportedAnswer,
      ),
      `export: ${probe.label}`,
    );
  }
}

Deno.test({
  name: "the preview and the exported app answer a user's app alike",
  // Both hosts boot PGlite, which the sanitizers see as outstanding ops.
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    assertEquals(
      PROBES.filter((p) => p.exportDiffers !== undefined).length,
      OPEN_DIVERGENCES,
      "the recorded preview/export divergence count changed",
    );
    await withBothHosts(() => {}, (hosts) => assertProbes(hosts, PROBES));
  },
});

// --- The auth gate (core/config.ts APP_AUTH_GATE_CONFIG) -------------------------
//
// The same fixture, plus a gate handler named by the config and one asset. The gate
// refuses with a body naming the route it was handed, so every refusal also proves the
// gate saw the matched route's PATTERN and that its request copy had no body.

const GATE_SOURCE = `function authGate(
  req: Request,
  ctx: { params: Record<string, string>; route: { method: string; path: string } },
): Response | null | string {
  const mode = req.headers.get("x-gate");
  if (mode === "throw") throw new Error("gate exploded");
  if (mode === "garbage") return "yes";
  if (mode === "pass") return null;
  if (ctx.route.path === "/items/:id" && ctx.params.id === "open") return null;
  return Response.json(
    { refused: ctx.route.method + " " + ctx.route.path, bodyless: req.body === null },
    { status: 401 },
  );
}`;

const PASS = { "x-gate": "pass" };
const JSON_ONLY = { "content-type": JSON_CT };
const INTERNAL_ERROR = {
  status: 500,
  body: "Internal Server Error",
  headers: { "content-type": "text/plain; charset=UTF-8" },
};

function refused(route: string): Answer {
  return {
    status: 401,
    body: JSON.stringify({ refused: route, bodyless: true }),
    headers: JSON_ONLY,
  };
}

function badBody(headers: Record<string, string> = {}): Request {
  return new Request(url("/v/body"), {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ value: "x" }),
  });
}

// No probe here carries access-control-allow-origin: behind a gate neither host sends
// it, and an expected header set that omits a key asserts the key absent.
const GATED_PROBES: Probe[] = [
  {
    label: "gated: a refusal names the route PATTERN, not the path",
    request: () => new Request(url("/items/7")),
    expect: refused("GET /items/:id"),
  },
  {
    label: "gated: a pass reaches the handler, without CORS",
    request: () => new Request(url("/items/7"), { headers: PASS }),
    expect: {
      status: 200,
      body: '{"via":"byId","id":"7"}',
      headers: JSON_ONLY,
    },
  },
  {
    label: "gated: the gate sees the matched params",
    request: () => new Request(url("/items/open")),
    expect: {
      status: 200,
      body: '{"via":"byId","id":"open"}',
      headers: JSON_ONLY,
    },
  },
  {
    label: "gated: HEAD is refused as its GET route, without a body",
    request: () => new Request(url("/items/7"), { method: "HEAD" }),
    expect: { ...refused("GET /items/:id"), body: "" },
  },
  {
    // Gate before validation: a refused caller learns nothing about the schema.
    label: "gated: a refused invalid body is a 401, not a 400",
    request: () => badBody(),
    expect: refused("POST /v/body"),
  },
  {
    label: "gated: a passed invalid body is still validated",
    request: () => badBody(PASS),
    expect: {
      status: 400,
      body: JSON.stringify({
        error: "Validation failed",
        details: [{
          in: "body",
          path: "/value",
          message: "must NOT have fewer than 2 characters",
        }],
      }),
      headers: JSON_ONLY,
    },
  },
  {
    // The gate's copy is body-less; the handler's is not.
    label: "gated: a passed body still reaches the handler intact",
    request: () =>
      new Request(url("/v/body"), {
        method: "POST",
        headers: { "content-type": "application/json", ...PASS },
        body: JSON.stringify({ value: "ok" }),
      }),
    expect: {
      status: 200,
      body: '{"via":"vBody","got":{"value":"ok"},"id":null}',
      headers: JSON_ONLY,
    },
  },
  {
    label: "gated: a route miss is never gated",
    request: () => new Request(url("/nope")),
    expect: {
      status: 404,
      body: envelope("NOT_FOUND", "No route matches GET /nope."),
      headers: JSON_ONLY,
    },
  },
  {
    label: "gated: an unrouted OPTIONS is a route miss, not a preflight",
    request: () =>
      new Request(url("/items/7"), {
        method: "OPTIONS",
        headers: { "access-control-request-headers": "x-a" },
      }),
    expect: {
      status: 405,
      body: envelope(
        "METHOD_NOT_ALLOWED",
        "Method OPTIONS is not allowed for /items/7.",
      ),
      headers: { ...JSON_ONLY, allow: "GET" },
    },
  },
  {
    label: "gated: a platform asset route is refused",
    request: () => new Request(url("/_assets/note.txt")),
    expect: refused("GET /_assets/:name"),
  },
  {
    label: "gated: a platform asset route is served on a pass",
    request: () => new Request(url("/_assets/note.txt"), { headers: PASS }),
    expect: { status: 200, body: "behind the gate" },
  },
  {
    label: "gated: a gate that throws fails closed",
    request: () =>
      new Request(url("/items/7"), { headers: { "x-gate": "throw" } }),
    expect: INTERNAL_ERROR,
  },
  {
    label: "gated: a gate answering neither null nor a Response fails closed",
    request: () =>
      new Request(url("/items/7"), { headers: { "x-gate": "garbage" } }),
    expect: INTERNAL_ERROR,
  },
];

Deno.test({
  name: "an auth gate answers alike in the preview and the exported app",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await withBothHosts(
      async (kernel) => {
        // Named like the export's own wiring would name it. A gate called authGate
        // once shadowed itself in the generated main.ts and crashed the binary at boot.
        const compiled = await compileHandler(
          "authGate",
          GATE_SOURCE,
          await kernel.compileDeps(),
        );
        assert(compiled.ok, "gate did not compile");
        kernel.handlers.register("authGate", GATE_SOURCE, compiled.data);
        kernel.assets.register(
          "note.txt",
          new TextEncoder().encode("behind the gate"),
          "text/plain",
        );
        kernel.configs.set(APP_AUTH_GATE_CONFIG, "authGate");
      },
      async (hosts, kernel) => {
        await assertProbes(hosts, GATED_PROBES);

        // The OpenAPI spec is at different paths in the two hosts, so it is checked per
        // host rather than as a parity probe. Both are refused.
        for (const path of ["/_api/openapi.json", "/_api/docs"]) {
          assertEquals(
            await answer(await hosts.preview(new Request(url(path)))),
            refused(`GET ${path}`),
            `preview: ${path} is refused`,
          );
        }
        for (const path of ["/openapi.json", "/_health"]) {
          assertEquals(
            await answer(await hosts.exported(new Request(url(path)))),
            refused(`GET ${path}`),
            `export: ${path} is refused`,
          );
        }

        // A config naming a handler that does not exist: the preview refuses every
        // matched request, and the export refuses to build.
        kernel.configs.set(APP_AUTH_GATE_CONFIG, "noSuchGate");
        assertEquals(
          await answer(await hosts.preview(new Request(url("/items/7")))),
          INTERNAL_ERROR,
          "preview: a missing gate handler fails closed",
        );
        await assertRejects(
          () => exportProject(kernel),
          Error,
          'APP_AUTH_GATE names handler "noSuchGate"',
        );
      },
    );
  },
});
