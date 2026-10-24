import { createHash } from "node:crypto";
import _Ajv from "ajv";
const Ajv = _Ajv as unknown as typeof _Ajv.default;
import type { Kernel } from "./registries.ts";
import { generateOpenAPISpec } from "./openapi.ts";
import { errorMessage, errorStack } from "./util.ts";
import {
  APP_AUTH_GATE_CONFIG,
  APP_PORT_AUTO,
  APP_SERVER_PORT,
  CORS_ALLOW_METHODS,
  getAppServerHost,
  getKernelSettings,
  ROUTE_METHOD_NOT_ALLOWED_CODE,
  ROUTE_NOT_FOUND_CODE,
} from "./config.ts";
import {
  allowedMethods,
  type CompiledRoute,
  compileRoutes,
  match,
  type RouteDef,
} from "./route-matcher.ts";
import { compareRouteKeys } from "./route-order.ts";
import {
  AJV_OPTIONS,
  deriveRouteSchemas,
  type RouteValidators,
  validateRequest,
} from "./route-validation.ts";
import { sharedGatewayContract } from "./runtime.ts";
import {
  type DocumentRecord,
  type DocumentRef,
  type DocumentStore,
  LOG_EVIDENCE_DOCUMENT_KIND,
  LOG_EVIDENCE_DOCUMENT_SOURCE,
} from "./documents.ts";
import type { LogEntry, LogLevel, LogSource, Result } from "./types.ts";

export interface AppServer {
  rebuild: () => void;
  restart: () => void;
  shutdown: () => Promise<void>;
  setProxy: (targetPort: number) => void;
  clearProxy: () => void;
  /**
   * Live-rebind the app preview listener to a new port without touching the
   * kernel, DB, registries, chat, or control-server. Recycles only the app
   * `Deno.serve` listener, honoring the same collision fallback as first bind
   * (a taken fixed port falls back to a free one). Returns the actually-bound
   * port, which may differ from `newPort` on fallback. Async because it awaits
   * the old listener's shutdown before re-binding (so the old `Deno.serve` never
   * leaks and the port is released before a same-port re-bind).
   */
  rebind: (newPort: number) => Promise<number>;
  readonly port: number;
  readonly listening: boolean;
}

// --- Slice D: forensic log() evidence documents (plan §8/§11 — log refs) ---
//
// The content-bearing subset of a LogEntry the capture path renders + content-addresses on
// — everything BUT the volatile `id` (a resettable per-buffer counter) and `timestamp`, both
// omitted so a re-emit of the same forensic payload dedupes to one doc. The chosen consumer
// (the user-app handler-error seam below) builds this in-hand, BEFORE the entry is logged,
// because a buffered entry can never be stamped after the fact — KernelLog has no per-entry
// update seam (registries.ts).
export type LogEvidenceEntry = Omit<LogEntry, "id" | "timestamp">;

// The forensic subset the 500-slot ring buffer genuinely loses: an error carrying a stack
// from a user-code source (handler/script/app). Info/warn or stackless entries are the noise
// the buffer already retains enough of — capturing them would mint churn, not evidence. This
// predicate is ALSO the recursion firewall: the capture path degrades by emitting a
// source:"system" log, which fails this test, so a capture-failure log can never re-enter
// capture.
const FORENSIC_LOG_SOURCES: readonly LogSource[] = ["handler", "script", "app"];
export function isForensicLogEntry(entry: LogEvidenceEntry): boolean {
  return entry.level === "error" &&
    typeof entry.stack === "string" && entry.stack.length > 0 &&
    FORENSIC_LOG_SOURCES.includes(entry.source);
}

// Best-effort JSON rendering of an entry's metadata bag (mirrors dispatch.ts's
// stringifyEvidenceData): a value that can't be serialised (e.g. a cycle) falls back to its
// String form so a pathological payload never throws out of the deterministic renderer.
function safeMetadataJson(
  metadata: Record<string, unknown> | undefined,
  pretty: boolean,
): string {
  if (metadata === undefined) return "";
  try {
    return JSON.stringify(metadata, null, pretty ? 2 : 0) ?? String(metadata);
  } catch {
    return String(metadata);
  }
}

// The composite, content-stable origin key for a forensic log entry (mirrors C-rich's
// runEvidenceLedgerKey). A raw LogEntry.id is a fragile key — a per-buffer nextId that resets
// to 1 on clear() and survives only for the most-recent ~500 entries, so neither globally
// unique nor stable across a restart. Instead we content-address the forensic payload
// (source | message | stack | metadata) and prefix it with source:route for legibility. A
// re-emit of the SAME payload yields the SAME key — so findBySource rediscovers the one doc
// and recordUniqueRef re-points the one ref, with no duplicate on id reuse or a buffer reset.
export function logEvidenceKey(entry: LogEvidenceEntry): string {
  const payload = [
    entry.source,
    entry.message,
    entry.stack ?? "",
    safeMetadataJson(entry.metadata, false),
  ].join("\0");
  const hash = createHash("sha256").update(payload).digest("hex");
  return `${entry.source}:${entry.route ?? ""}:${hash}`;
}

// Deterministic markdown snapshot of a forensic log entry — these bytes ARE what the
// log/evidence ref cites. The volatile id/timestamp are omitted (see LogEvidenceEntry) so an
// unchanged re-emit content-addresses to the same blob and DocumentStore.update dedupes it to
// a no-op; the KernelLog entry keeps the authoritative timing.
export function renderLogEvidenceDocument(entry: LogEvidenceEntry): string {
  const lines = [
    `# Log evidence: ${entry.level} (${entry.source})`,
    "",
    `- **Level:** ${entry.level}`,
    `- **Source:** ${entry.source}`,
  ];
  if (entry.route) lines.push(`- **Route:** ${entry.route}`);
  lines.push("", "## Message", "", entry.message);
  if (entry.stack) {
    lines.push("", "## Stack", "", "```", entry.stack, "```");
  }
  if (entry.metadata !== undefined) {
    lines.push(
      "",
      "## Metadata",
      "",
      "```json",
      safeMetadataJson(entry.metadata, true),
      "```",
    );
  }
  return `${lines.join("\n")}\n`;
}

// Capture one forensic log entry's bytes as a versioned agent document + a single
// log/evidence ref citing the head (plan §8/§11, Slice D). ADDITIVE provenance: the KernelLog
// ring buffer + on-disk snapshot stay authoritative; this is a durable, byte-exact pointer
// beside them. Mirrors captureRunEvidenceDocument shape-for-shape — the doc is found by its
// ORIGIN (metadata.source=LOG_EVIDENCE_DOCUMENT_SOURCE + sourceId=<composite key>), NOT via
// the ref — so a re-emit with the SAME key rediscovers and updates the SAME doc instead of
// minting a second, and a lost ref self-heals on the next capture (recordUniqueRef re-points
// the single ref at the head atomically). Best-effort: returns the store Result (never throws
// for the store's own errors — PROJECT_REQUIRED with no project loaded is a Result, not a
// throw) so the caller degrades a provenance-write failure to a log. Never calls log() itself
// (that is the caller's job) so it can never trip the capture recursion firewall.
export async function captureLogEvidenceDocument(
  store: DocumentStore,
  entry: LogEvidenceEntry,
  sessionId: string | undefined,
): Promise<Result<DocumentRef>> {
  const key = logEvidenceKey(entry);
  const content = renderLogEvidenceDocument(entry);

  const existing = await store.findBySource(
    LOG_EVIDENCE_DOCUMENT_SOURCE,
    key,
    { sessionId },
  );

  let doc: DocumentRecord;
  if (existing) {
    const updated = await store.update(existing.id, {
      content,
      createdBy: "agent",
    });
    if (!updated.ok) return updated;
    doc = updated.data;
  } else {
    const created = await store.create({
      name: `Log evidence: ${entry.source} ${entry.level}`,
      kind: LOG_EVIDENCE_DOCUMENT_KIND,
      content,
      scope: "session",
      sessionId,
      createdBy: "agent",
      metadata: {
        source: LOG_EVIDENCE_DOCUMENT_SOURCE,
        sourceId: key,
        title: `Log evidence (${entry.source}/${entry.level})`,
      },
    });
    if (!created.ok) return created;
    doc = created.data;
  }

  return await store.recordUniqueRef({
    documentId: doc.id,
    refType: "log",
    refId: key,
    role: "evidence",
    versionHash: doc.currentVersionHash,
    sessionId,
  });
}

export function createAppServer(
  kernel: Kernel,
  port = APP_SERVER_PORT,
  timeoutMs = getKernelSettings().handlerTimeoutMs,
): AppServer {
  let server: Deno.HttpServer<Deno.NetAddr> | null = null;
  // The port we currently *want* to bind. Mutable so `rebind` can change what
  // `bindServer` binds and what the built app is told its port is; `actualPort`
  // is the port we actually got (may differ after a collision fallback).
  let requestedPort = port;
  let actualPort = port;
  // Before the first rebuild() there is no table, so every path is a route miss. Only
  // reachable if something serves through this before rebuild()/setProxy(); answering
  // the documented envelope beats answering a framework's default.
  let currentApp: PreviewApp = {
    fetch: (request) =>
      Promise.resolve(
        finalize(
          missResponse([], request.method, new URL(request.url).pathname),
          request.method,
        ),
      ),
  };

  // Bind the app server, falling back to an OS-assigned free port when the
  // requested port is already taken (e.g. a second stack sharing the default
  // app port). The IDE reads the actually-bound port back from the kernel, so
  // a fallback port is transparent to clients. A caller that explicitly asked
  // for APP_PORT_AUTO (0) already gets a free port, so no fallback is needed.
  // Loopback by default; OPENTIDE_APP_HOST opts a trusted-network box into binding
  // the overlay so the IDE-origin-derived preview URL is reachable (see config).
  const host = getAppServerHost();
  const bindServer = (): Deno.HttpServer<Deno.NetAddr> => {
    const handler = (req: Request) => currentApp.fetch(req);
    try {
      return Deno.serve(
        { hostname: host, port: requestedPort, onListen: () => {} },
        handler,
      );
    } catch (err) {
      if (
        err instanceof Deno.errors.AddrInUse && requestedPort !== APP_PORT_AUTO
      ) {
        console.warn(
          `  App port :${requestedPort} in use — falling back to a free port`,
        );
        return Deno.serve(
          { hostname: host, port: APP_PORT_AUTO, onListen: () => {} },
          handler,
        );
      }
      throw err;
    }
  };

  const self: AppServer = {
    get port() {
      return actualPort;
    },
    get listening() {
      return server !== null;
    },
    rebuild() {
      currentApp = buildApp(kernel, timeoutMs);
      const hasRoutes = kernel.routes.list().length > 0;
      if (hasRoutes && !server) {
        server = bindServer();
        actualPort = server.addr.port;
        console.log(`  App server listening on :${actualPort}`);
      }
    },
    restart() {
      kernel.log.log("info", "system", "App server restarted");
      self.rebuild();
    },
    setProxy(targetPort: number) {
      // A pure catch-all: no routing, no table, so it is the closure it always was minus
      // the framework wrapper that held it.
      const proxy: PreviewApp = {
        fetch: async (request: Request): Promise<Response> => {
          const url = new URL(request.url);
          url.port = String(targetPort);
          const headers = new Headers(request.headers);
          // Let fetch derive Host from the target URL rather than forwarding the
          // proxy's incoming Host header.
          headers.delete("host");
          // Ask the child dev server for an UNCOMPRESSED response so proxied HTML can
          // be spliced (console-capture injection below) without a decompress/
          // recompress round-trip. Cheap on localhost, and only HTML is rewritten.
          headers.set("accept-encoding", "identity");
          const method = request.method;
          const hasBody = method !== "GET" && method !== "HEAD";
          const init: RequestInit = { method, headers, redirect: "manual" };
          if (hasBody) {
            init.body = request.body;
            // Streaming a request body requires half-duplex in Deno/undici;
            // omitting it throws for non-empty POST/PUT bodies.
            (init as RequestInit & { duplex?: "half" }).duplex = "half";
          }
          const resp = await fetch(url.toString(), init);
          return await proxyHtmlWithConsole(resp);
        },
      };
      currentApp = proxy;
      if (!server) {
        server = bindServer();
        actualPort = server.addr.port;
        console.log(`  App server listening on :${actualPort} (proxy mode)`);
      }
    },
    clearProxy() {
      self.rebuild();
    },
    async rebind(newPort: number): Promise<number> {
      // Recycle only the app listener: tear down the current Deno.serve (if any)
      // and re-bind on the new requested port. Kernel, DB, registries, chat, and
      // control-server are untouched. Honors the same collision fallback as first
      // bind (a taken fixed port transparently falls back to a free one).
      if (server) {
        await server.shutdown();
        server = null;
      }
      requestedPort = newPort;
      // Rebuild before binding so a fresh app (with the current route set) is
      // served on the new listener. The app's surfaces are host/port-agnostic
      // (relative OpenAPI + docs URLs), so no port needs threading in.
      currentApp = buildApp(kernel, timeoutMs);
      server = bindServer();
      actualPort = server.addr.port;
      kernel.appPort = actualPort;
      if (actualPort !== newPort && newPort !== APP_PORT_AUTO) {
        kernel.log.log(
          "warn",
          "system",
          `App preview port :${newPort} unavailable — rebound on :${actualPort}`,
        );
      } else {
        kernel.log.log(
          "info",
          "system",
          `App preview server rebound on :${actualPort}`,
        );
      }
      return actualPort;
    },
    async shutdown() {
      if (server) {
        await server.shutdown();
        server = null;
        actualPort = requestedPort;
      }
    },
  };

  return self;
}

const MAX_BODY_CAPTURE = getKernelSettings().maxBodyCapture;

function headersToRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((v, k) => {
    out[k] = v;
  });
  return out;
}

async function captureBody(
  response: Response,
): Promise<[Response, string | null]> {
  const ct = response.headers.get("content-type") ?? "";
  const isBinary = /image|audio|video|octet-stream|font|woff|wasm/.test(ct);
  if (isBinary) return [response, null];
  const cloned = response.clone();
  try {
    const text = await cloned.text();
    if (!text) return [response, null];
    return [
      response,
      text.length > MAX_BODY_CAPTURE
        ? text.slice(0, MAX_BODY_CAPTURE) + "…"
        : text,
    ];
  } catch {
    return [response, null];
  }
}

async function captureRequestBody(request: Request): Promise<string | null> {
  if (!request.body) return null;
  const ct = request.headers.get("content-type") ?? "";
  const isBinary = /image|audio|video|octet-stream|font|woff|wasm/.test(ct);
  if (isBinary) return null;
  try {
    const text = await request.clone().text();
    if (!text) return null;
    return text.length > MAX_BODY_CAPTURE
      ? text.slice(0, MAX_BODY_CAPTURE) + "…"
      : text;
  } catch {
    return null;
  }
}

const CONSOLE_INTERCEPT_SCRIPT = `<script data-genie-console>
(function(){
  var L=["log","info","warn","error","debug"];
  var O={};
  function previewPath(){return location.pathname+location.search+location.hash}
  function sendLocation(){window.parent.postMessage({type:"genie:preview-location",href:location.href,path:previewPath(),timestamp:new Date().toISOString()},"*")}
  function ser(v){try{return typeof v==="object"?JSON.stringify(v):String(v)}catch(e){return String(v)}}
  var HP=history.pushState, HR=history.replaceState;
  history.pushState=function(){var r=HP.apply(history,arguments);sendLocation();return r};
  history.replaceState=function(){var r=HR.apply(history,arguments);sendLocation();return r};
  window.addEventListener("popstate",sendLocation);
  window.addEventListener("hashchange",sendLocation);
  sendLocation();
  L.forEach(function(l){
    O[l]=console[l];
    console[l]=function(){
      O[l].apply(console,arguments);
      var a=[];for(var i=0;i<arguments.length;i++) a.push(ser(arguments[i]));
      window.parent.postMessage({type:"genie:console",level:l,args:a,timestamp:new Date().toISOString()},"*");
    };
  });
  window.addEventListener("error",function(e){
    window.parent.postMessage({type:"genie:console",level:"error",args:[e.message+(e.filename?" ("+e.filename+":"+e.lineno+")":"")],timestamp:new Date().toISOString()},"*");
  });
  window.addEventListener("unhandledrejection",function(e){
    var m=e.reason instanceof Error?e.reason.message:String(e.reason);
    window.parent.postMessage({type:"genie:console",level:"error",args:["Unhandled promise rejection: "+m],timestamp:new Date().toISOString()},"*");
  });
  window.addEventListener("message",function(e){
    if(!e.data||e.data.type!=="genie:eval") return;
    var code=e.data.code, id=e.data.id, ts=new Date().toISOString();
    try{
      var r=(0,eval)(code);
      window.parent.postMessage({type:"genie:eval-result",id:id,ok:true,value:ser(r),timestamp:ts},"*");
    }catch(err){
      window.parent.postMessage({type:"genie:eval-result",id:id,ok:false,value:err.message||String(err),timestamp:ts},"*");
    }
  });
})();
</script>`;

// Source-backed proxy counterpart to the buildApp injection above: splice the
// console/error-capture script into proxied text/html so an IMPORTED app's runtime
// console + uncaught errors surface in the IDE preview console (project import,
// Slice 3 follow-up). Non-HTML responses (JS/CSS/JSON/images/HMR) stream through
// untouched. The proxy requests `accept-encoding: identity`, so the HTML arrives
// uncompressed and a splice + Content-Length fix is all that is needed; a stale
// Content-Encoding is dropped since the body is re-emitted decoded.
//
// Known limitations (documented, not solved here): an app whose Content-Security-
// Policy forbids inline scripts will block the intercept; and Vite-style HMR
// websockets are not carried by this fetch-based proxy (pre-existing).
async function proxyHtmlWithConsole(resp: Response): Promise<Response> {
  const contentType = resp.headers.get("content-type") ?? "";
  if (!contentType.includes("text/html")) {
    return new Response(resp.body, {
      status: resp.status,
      headers: resp.headers,
    });
  }
  // Clone so a failed text() read can still fall back to the original stream.
  const fallback = resp.clone();
  let html: string;
  try {
    html = await resp.text();
  } catch {
    return new Response(fallback.body, {
      status: fallback.status,
      headers: fallback.headers,
    });
  }
  if (resp.ok && html && !html.includes("data-genie-console")) {
    html = injectConsoleScript(html);
  }
  const headers = new Headers(resp.headers);
  headers.delete("content-encoding");
  headers.set(
    "content-length",
    String(new TextEncoder().encode(html).byteLength),
  );
  return new Response(html, { status: resp.status, headers });
}

function injectConsoleScript(html: string): string {
  const headEnd = html.indexOf("</head>");
  if (headEnd !== -1) {
    return html.slice(0, headEnd) + CONSOLE_INTERCEPT_SCRIPT +
      html.slice(headEnd);
  }
  const bodyStart = html.indexOf("<body");
  if (bodyStart !== -1) {
    const tagEnd = html.indexOf(">", bodyStart);
    if (tagEnd !== -1) {
      return html.slice(0, tagEnd + 1) + CONSOLE_INTERCEPT_SCRIPT +
        html.slice(tagEnd + 1);
    }
  }
  return CONSOLE_INTERCEPT_SCRIPT + html;
}

/* --- The preview's shell ----------------------------------------------------------

   Everything the Hono instance used to do apart from matching. Same shape as the app
   export's emitted shell (`ExportedApp` in core/export.ts), because the two hosts now
   share the matcher and should read alike; core/preview-export-parity_test.ts holds
   them to the same answers.

   Each response shape below reproduces what the Hono shell answered — measured, not
   assumed, against the Hono the lock pins. The one deliberate change is the preflight's
   method list, which now comes from core/config.ts so both hosts advertise the same
   one; the preview used to advertise 4.12.21's six methods and an exported app
   4.13.1's seven. */

interface PreviewApp {
  fetch(request: Request): Promise<Response>;
}

/* Platform routes share the table with the user's, under handler names a registry entry
   can never hold — a handler name is an identifier and these carry a colon. The export
   uses the same trick for the same reason. */
const PLATFORM_ASSETS_HANDLER = "platform:assets";
const PLATFORM_OPENAPI_HANDLER = "platform:openapi";
const PLATFORM_DOCS_HANDLER = "platform:docs";

const CORS_ALLOW_ORIGIN_HEADER = "access-control-allow-origin";
/** Hono's `c.text()` content-type. Measured; the space after the semicolon is real. */
const TEXT_PLAIN = "text/plain; charset=UTF-8";
/** Hono's `c.html()` content-type. */
const TEXT_HTML = "text/html; charset=UTF-8";

function textResponse(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: { "content-type": TEXT_PLAIN },
  });
}

function htmlResponse(body: string): Response {
  return new Response(body, { headers: { "content-type": TEXT_HTML } });
}

function envelopeResponse(
  status: number,
  code: string,
  message: string,
  extra?: Record<string, string>,
): Response {
  return new Response(JSON.stringify({ error: true, code, message }), {
    status,
    headers: { "content-type": "application/json", ...extra },
  });
}

// The documented error envelope for a route miss (F-03/F-04): CLAUDE.md requires a user
// app's framework-level 404/405 to use the same shape as its handlers, and Hono's
// default was plain text and never a 405. `allowedMethods` is the shared matcher's, so
// the question "is anything registered at this path" gets the same answer here as in an
// export.
function missResponse(
  compiled: readonly CompiledRoute[],
  method: string,
  pathname: string,
): Response {
  const allowed = allowedMethods(compiled, pathname);
  if (allowed.length > 0) {
    return envelopeResponse(
      405,
      ROUTE_METHOD_NOT_ALLOWED_CODE,
      `Method ${method} is not allowed for ${pathname}.`,
      { Allow: allowed.join(", ") },
    );
  }
  return envelopeResponse(
    404,
    ROUTE_NOT_FOUND_CODE,
    `No route matches ${method} ${pathname}.`,
  );
}

// The CORS preflight answer, measured from `cors()` as the shell configured it: 204,
// empty, the allow-methods list, and — only when the request asked for headers — the
// requested names comma-joined WITHOUT spaces plus a `vary`.
function preflightResponse(request: Request): Response {
  const headers = new Headers({
    [CORS_ALLOW_ORIGIN_HEADER]: "*",
    "access-control-allow-methods": CORS_ALLOW_METHODS,
  });
  const requested = request.headers.get("access-control-request-headers");
  if (requested !== null) {
    headers.set(
      "access-control-allow-headers",
      requested.split(",").map((name) => name.trim()).join(","),
    );
    headers.set("vary", "Access-Control-Request-Headers");
  }
  return new Response(null, { status: 204, headers });
}

// A fresh Response rather than a mutation: a Response from `Response.redirect()` carries
// an immutable header guard and `headers.set` on it throws. Also where HEAD loses its
// body — Hono dispatched HEAD as GET and returned the GET response with none.
// `cors` is false behind an auth gate (core/config.ts APP_AUTH_GATE_CONFIG).
function finalize(response: Response, method: string, cors = true): Response {
  const headers = new Headers(response.headers);
  if (cors) headers.set(CORS_ALLOW_ORIGIN_HEADER, "*");
  return new Response(method === "HEAD" ? null : response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

// Splice the console/error-capture script into any text/html a handler returns, so a
// preview iframe's console and uncaught errors surface in the IDE. Content-length has to
// describe the SPLICED body or the browser truncates it.
//
// Read through a CLONE: on a body that cannot be read as text, the original is still
// intact to return. The middleware this replaces read the response itself and left a
// drained one behind on that path.
async function injectConsoleIntoHtml(response: Response): Promise<Response> {
  if (!(response.headers.get("content-type") ?? "").includes("text/html")) {
    return response;
  }
  // A bodiless response — a 304, or a HEAD already stripped — has nothing to splice, and
  // splicing anyway would give it a body made of nothing but the script plus a
  // content-length describing it. Guarded here rather than left to the order this is
  // called in, because an HTTP client drops a HEAD body regardless of what the server
  // writes, so no over-the-wire test can catch getting that order wrong.
  if (response.body === null) return response;
  let html: string;
  try {
    html = await response.clone().text();
  } catch {
    return response;
  }
  if (html.includes("data-genie-console")) return response;
  const injected = injectConsoleScript(html);
  const headers = new Headers(response.headers);
  headers.set(
    "content-length",
    String(new TextEncoder().encode(injected).byteLength),
  );
  return new Response(injected, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function buildApp(kernel: Kernel, timeoutMs: number): PreviewApp {
  // The CANONICAL order, not the registry's insertion order. Both hosts resolve first
  // match wins, so for overlapping routes the order decides the handler — and the
  // export has always sorted (a reproducible build has to). Sorting here means a
  // request reaches the same handler in the preview as it will in production, instead
  // of whichever route the agent happened to write first. core/route-order.ts says
  // what this order is and what it deliberately is not.
  const routes = [...kernel.routes.list()].sort(compareRouteKeys);
  const gatewayContract = sharedGatewayContract(kernel.runtime);

  if (!gatewayContract) {
    // Unreachable in this build: no registered adapter declares executionMode "proxy"
    // (core/runtime.ts), which is the only thing that makes the contract null. Kept
    // because the contract permits it, and said here so nobody hunts for its test.
    const message =
      `Runtime "${kernel.runtimeId}" is not served by the shared gateway.`;
    return {
      fetch: (request) =>
        Promise.resolve(finalize(textResponse(message, 501), request.method)),
    };
  }

  // The schemas come from core/route-validation.ts, which the app export also derives
  // through, so the two hosts cannot compile different schemas from the same route. What
  // differs is only WHEN: the preview compiles here, per rebuild, against live ajv; the
  // export compiles to source at export time (core/export-validators.ts).
  const ajv = new Ajv({ ...AJV_OPTIONS });

  const validators = new Map<string, RouteValidators>();

  for (const route of routes) {
    const derived = deriveRouteSchemas(route.schema);
    const key = `${route.method} ${route.path}`;
    const rv: RouteValidators = {};

    // A schema ajv rejects is logged and SKIPPED, leaving that slot unvalidated rather
    // than failing the rebuild — one bad schema must not take the whole app down. The
    // export degrades the same way, and reports which routes it happened to.
    for (const slot of ["body", "query", "params"] as const) {
      const schema = derived[slot];
      if (!schema) continue;
      try {
        rv[slot] = ajv.compile(schema);
      } catch (err) {
        kernel.log.log(
          "warn",
          "system",
          `Invalid ${slot} schema for ${key} — the route will serve ` +
            `UNVALIDATED until it is fixed: ${errorMessage(err)}`,
        );
      }
    }

    if (rv.body || rv.query || rv.params) validators.set(key, rv);
  }

  // Relative server URL so the spec + "try it" resolve against whatever origin
  // serves the app (localhost locally, the tailnet host remotely), never a
  // hardcoded localhost that a remote browser can't reach.
  const openApiSpec = generateOpenAPISpec(routes, { serverUrl: "/" });
  const docsPage = swaggerUIPage();

  type PlatformHandler = (
    request: Request,
    params: Readonly<Record<string, string>>,
  ) => Response;

  const platformHandlers: Record<string, PlatformHandler> = {
    [PLATFORM_ASSETS_HANDLER]: (request, params) => {
      const asset = kernel.assets.get(params.name ?? "");
      // Plain text, NOT the route-miss envelope: the route matched and the asset behind
      // it is missing, which is a different answer to "no such route".
      if (!asset) return textResponse("Not found", 404);
      const etag = `"${asset.registeredAt}"`;
      if (request.headers.get("If-None-Match") === etag) {
        return new Response(null, { status: 304, headers: { ETag: etag } });
      }
      return new Response(asset.content as unknown as BodyInit, {
        headers: {
          "Content-Type": asset.mimeType,
          "Cache-Control": "no-cache",
          "ETag": etag,
        },
      });
    },
    [PLATFORM_OPENAPI_HANDLER]: () => Response.json(openApiSpec),
    [PLATFORM_DOCS_HANDLER]: () => htmlResponse(docsPage),
  };

  // The order the Hono shell registered these in, preserved: the asset route BEFORE the
  // user's routes, so a user route at /_assets/:name cannot take it, and the two /_api
  // pages AFTER, so a user route there can. That asymmetry is inherited, not designed —
  // the export instead declines to emit a platform route whose path a user route claims
  // (`claimsPath` in core/export.ts), which is the better rule and a separate change.
  const table: RouteDef[] = [
    {
      method: "GET",
      path: "/_assets/:name",
      handlerName: PLATFORM_ASSETS_HANDLER,
    },
    ...routes.map((r) => ({
      method: r.method,
      path: r.path,
      handlerName: r.handlerName,
    })),
    {
      method: "GET",
      path: "/_api/openapi.json",
      handlerName: PLATFORM_OPENAPI_HANDLER,
    },
    { method: "GET", path: "/_api/docs", handlerName: PLATFORM_DOCS_HANDLER },
  ];
  const compiled = compileRoutes(table);

  async function dispatchUserRoute(
    route: RouteDef,
    request: Request,
    params: Readonly<Record<string, string>>,
  ): Promise<Response> {
    const routeLabel = `${route.method} ${route.path}`;
    const rv = validators.get(routeLabel);
    const url = new URL(request.url);

    // Body validation below consumes the request. Take the handler's copy first, while
    // the body is still unread. Only routes that actually validate a body pay for the
    // clone; everything else keeps streaming the original.
    const handlerReq = rv?.body ? request.clone() : request;
    const requestBody = await captureRequestBody(request);

    // The same function the exported app runs, copied there verbatim. `request` is safe
    // to read here: the handler's copy was taken above, before anything touched the body.
    if (rv) {
      const bad = await validateRequest(rv, params, url, () => request.json());
      if (bad) return bad;
    }

    const handler = kernel.handlers.getFn(route.handlerName);

    if (!handler) {
      const msg = `Handler "${route.handlerName}" not found`;
      kernel.log.log("error", "handler", msg, { route: routeLabel });
      return Response.json({ error: msg }, { status: 500 });
    }

    const requestId = crypto.randomUUID();

    const { result: response, trace } = await kernel.tracer.run(
      requestId,
      request.method,
      url.pathname,
      async () => {
        let timerId: ReturnType<typeof setTimeout> | undefined;
        try {
          const timeout = new Promise<never>((_, reject) => {
            timerId = setTimeout(
              () =>
                reject(
                  new Error(
                    `Handler "${route.handlerName}" timed out after ${timeoutMs}ms`,
                  ),
                ),
              timeoutMs,
            );
          });
          return await Promise.race([
            handler(handlerReq, { params }),
            timeout,
          ]);
        } catch (err) {
          const message = errorMessage(err);
          const isTimeout = message.includes("timed out");
          const status = isTimeout ? 503 : 500;
          const stack = errorStack(err);
          const level: LogLevel = isTimeout ? "warn" : "error";
          // Slice D (plan §8/§11 — log refs): a user-app handler crash's stack is
          // exactly the forensic payload the 500-slot ring buffer loses. Mint a durable,
          // versioned log/evidence doc from the entry's bytes BEFORE logging, then thread
          // the minted id into the entry's metadata.documentId — the entry cannot be
          // stamped after the fact (KernelLog has no per-entry update seam). Core is the
          // right seam: kernel.documents is reachable here (no upward import), and this is
          // the one place that reliably produces error+stack+route entries. Its OWN
          // try/catch so a provenance failure never drops or alters the log entry; the
          // failure log it emits is source "system" (not a forensic source), so
          // isForensicLogEntry rejects it and capture can never recurse into itself.
          const forensic: LogEvidenceEntry = {
            level,
            source: "handler",
            message,
            route: routeLabel,
            stack,
          };
          let documentId: string | undefined;
          if (isForensicLogEntry(forensic)) {
            try {
              const captured = await captureLogEvidenceDocument(
                kernel.documents,
                forensic,
                undefined,
              );
              if (captured.ok) {
                documentId = captured.data.documentId;
              } else {
                kernel.log.log(
                  "debug",
                  "system",
                  `Handler-error evidence not captured as a document: ` +
                    `${captured.error.code} (${captured.error.message})`,
                );
              }
            } catch (docErr) {
              kernel.log.log(
                "warn",
                "system",
                `Capturing handler-error evidence document failed: ${
                  errorMessage(docErr)
                }`,
              );
            }
          }
          kernel.log.log(level, "handler", message, {
            route: routeLabel,
            stack,
            ...(documentId ? { metadata: { documentId } } : {}),
          });
          return Response.json({ error: message }, { status });
        } finally {
          // Always clear the timeout — on the error path too, or the timer
          // stays pending until it fires (rejecting an already-settled race).
          clearTimeout(timerId);
        }
      },
    );

    const [resp, responseBody] = await captureBody(response);
    trace.status = resp.status;

    const requestHeaders = headersToRecord(request.headers);
    const responseHeaders = headersToRecord(resp.headers);
    kernel.requestLog.push({
      timestamp: new Date().toISOString(),
      method: request.method,
      url: request.url,
      path: url.pathname,
      status: resp.status,
      durationMs: trace.durationMs ?? 0,
      requestHeaders,
      requestBody,
      responseHeaders,
      responseBody,
    });
    kernel.log.log(
      "info",
      "handler",
      `${request.method} ${url.pathname} ${resp.status} ${
        trace.durationMs ?? 0
      }ms`,
      {
        route: routeLabel,
        metadata: {
          method: request.method,
          path: url.pathname,
          status: resp.status,
          durationMs: trace.durationMs,
          requestId,
        },
      },
    );
    return resp;
  }

  // The auth gate (core/config.ts APP_AUTH_GATE_CONFIG). Read per request, not per
  // rebuild, so a set_config takes effect without one. Null lets the request through.
  async function runGate(
    gateName: string,
    route: RouteDef,
    request: Request,
    params: Readonly<Record<string, string>>,
  ): Promise<Response | null> {
    const gate = kernel.handlers.getFn(gateName);
    if (!gate) {
      kernel.log.log(
        "error",
        "system",
        `${APP_AUTH_GATE_CONFIG} names handler "${gateName}", which does not ` +
          `exist — refusing every request until it does.`,
      );
      return textResponse("Internal Server Error", 500);
    }
    // Body-less, so the gate cannot drain the stream the handler is about to read.
    const gateReq = new Request(request.url, {
      method: request.method,
      headers: request.headers,
    });
    try {
      const verdict: unknown = await gate(
        gateReq,
        {
          params,
          route: { method: route.method, path: route.path },
        } as Parameters<typeof gate>[1],
      );
      if (verdict === null || verdict === undefined) return null;
      if (verdict instanceof Response) return verdict;
      throw new Error(
        `Gate "${gateName}" answered ${typeof verdict}; expected null or a Response`,
      );
    } catch (err) {
      kernel.log.log("error", "handler", errorMessage(err), {
        route: `${route.method} ${route.path}`,
        stack: errorStack(err),
      });
      return textResponse("Internal Server Error", 500);
    }
  }

  return {
    fetch: async (request: Request): Promise<Response> => {
      const gateConfig = kernel.configs.get(APP_AUTH_GATE_CONFIG);
      const gateName = typeof gateConfig === "string" && gateConfig !== ""
        ? gateConfig
        : null;
      const cors = gateName === null;
      try {
        const pathname = new URL(request.url).pathname;

        const hit = match(compiled, request.method, pathname);

        // The route table gets first refusal on OPTIONS, and the preflight is the
        // fallback. `cors()` had it the other way round and answered EVERY OPTIONS
        // request before routing, so a user's own OPTIONS handler was unreachable in the
        // preview — not even on an ALL route. A preflight from a browser goes to a path
        // with no OPTIONS handler, so it still lands here.
        if (hit.route === null) {
          return request.method === "OPTIONS" && cors
            ? preflightResponse(request)
            : finalize(
              missResponse(compiled, request.method, pathname),
              request.method,
              cors,
            );
        }

        const refused = gateName === null
          ? null
          : await runGate(gateName, hit.route, request, hit.params);
        const platform = platformHandlers[hit.route.handlerName];
        const response = refused ??
          (platform
            ? platform(request, hit.params)
            : await dispatchUserRoute(hit.route, request, hit.params));
        return finalize(
          await injectConsoleIntoHtml(response),
          request.method,
          cors,
        );
      } catch (err) {
        // A user handler's own throw is caught and logged inside dispatchUserRoute; this
        // is the shell's net for everything else. Hono had none, so a throw out here
        // used to surface as whatever Deno.serve answers. Explicit beats ambient.
        kernel.log.log("error", "system", errorMessage(err), {
          stack: errorStack(err),
        });
        return finalize(
          textResponse("Internal Server Error", 500),
          request.method,
          cors,
        );
      }
    },
  };
}

function swaggerUIPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>API Docs</title>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css" />
  <style>body { margin: 0; } .swagger-ui .topbar { display: none; }</style>
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
  <script>
    SwaggerUIBundle({
      url: '/_api/openapi.json',
      dom_id: '#swagger-ui',
      presets: [SwaggerUIBundle.presets.apis, SwaggerUIBundle.SwaggerUIStandalonePreset],
      layout: 'BaseLayout',
    });
  </script>
</body>
</html>`;
}
