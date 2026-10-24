// @layer core — the handler ABI: which shape a stored handler source was written
// against, and the compatibility shim for the older one.
//
// Handlers are `(req: Request, ctx: HandlerContext) => Response` (docs/framework-
// free-handler-abi-plan.md). Before that they took a Hono `Context`. Rather than
// migrate stored source — which would mean a data migration over every project on
// disk — we derive which ABI a handler was written against from its source and wrap
// the legacy ones at compile time. The bit is derived, never persisted: a detector
// that misfires is fixed by shipping a better detector, not by rewriting state.
//
// The shim reproduces the *observed* behaviour of Hono's Context for the surface
// `LanguageService.generateGlobals` declares — including two quirks that look like
// bugs and are not: `c.text()` emits `text/plain;charset=UTF-8` (no space) when
// nothing else has been set on the context and `text/plain; charset=UTF-8` (with a
// space) once it has, because the first case hands the string straight to the
// `Response` constructor; and `c.body()` never sets content-type itself, leaving it
// to the constructor or to whatever `c.header()` already put there.

import { ROUTE_NOT_FOUND_CODE } from "./config.ts";
import type { HandlerContext, HandlerFn } from "./types.ts";

export type HandlerAbi = "fetch" | "legacy-context";

/** Hono's own constant, used once the context has prepared headers. */
const TEXT_PLAIN = "text/plain; charset=UTF-8";
/* And what the Response CONSTRUCTOR derives for a string body, which is what Hono's
   still-fresh `c.text()` leans on instead — note the missing space, which is the
   whole reason there are two constants.

   Written out rather than left to the constructor because the constructor does not
   agree across runtimes: Deno omits the space, undici (and therefore the exported
   app's Node target) includes it. Leaving it implicit made one legacy handler answer
   `GET /alpha` with a different content-type on the Deno and Node artifacts, which
   the export's route-parity gate fails — correctly. Pinning Deno's spelling keeps the
   quirk observable and makes it deterministic. */
const TEXT_PLAIN_FROM_CONSTRUCTOR = "text/plain;charset=UTF-8";
const TEXT_HTML = "text/html; charset=UTF-8";
const APPLICATION_JSON = "application/json";
const DEFAULT_REDIRECT_STATUS = 302;

// --- Detection ---

// The compiler evaluates the source and returns the binding named after the
// handler, so the definition is always one of these forms. Each pattern captures
// the parameter list; `lastIndex` after a match is where the body begins.
const DEFINITION_FORMS = [
  // async function name(a, b) / function name(a, b)
  (name: string) =>
    new RegExp(`(?:async\\s+)?function\\s*\\*?\\s*${name}\\s*\\(([^)]*)\\)`),
  // const name = async (a, b) => / const name = (a, b) =>
  (name: string) =>
    new RegExp(
      `(?:const|let|var)\\s+${name}\\s*(?::[^=]+)?=\\s*(?:async\\s*)?\\(([^)]*)\\)\\s*=>`,
    ),
  // const name = async function (a, b)
  (name: string) =>
    new RegExp(
      `(?:const|let|var)\\s+${name}\\s*(?::[^=]+)?=\\s*(?:async\\s+)?function\\s*\\*?\\s*\\w*\\s*\\(([^)]*)\\)`,
    ),
  // const name = c => — a single unparenthesised arrow parameter
  (name: string) =>
    new RegExp(
      `(?:const|let|var)\\s+${name}\\s*=\\s*(?:async\\s+)?([A-Za-z_$][\\w$]*)\\s*=>`,
    ),
];

interface Definition {
  params: string[];
  body: string;
}

function findDefinition(source: string, name: string): Definition | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const build of DEFINITION_FORMS) {
    const match = build(escaped).exec(source);
    if (!match) continue;
    const raw = match[1] ?? "";
    return {
      params: splitParams(raw),
      body: source.slice(match.index + match[0].length),
    };
  }
  return null;
}

// Parameter lists are shallow in practice, but a destructured or generic-typed
// parameter can carry commas that are not separators.
function splitParams(raw: string): string[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of trimmed) {
    if (ch === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{" || ch === "<") depth++;
    if (ch === ")" || ch === "]" || ch === "}" || ch === ">") depth--;
    current += ch;
  }
  parts.push(current.trim());
  return parts.filter((p) => p.length > 0);
}

// `doc.id` contains `c.id`. Every member probe has to refuse to match mid-identifier
// or mid-property-chain, or a SQL alias and a variable called `doc` both read as
// context access.
function memberProbe(param: string, member: string): RegExp {
  return new RegExp(`(?<![\\w$.])${param}\\.${member}`);
}

function usesAny(body: string, param: string, members: string[]): boolean {
  return members.some((m) => memberProbe(param, m).test(body));
}

/**
 * Which ABI `source` was written against.
 *
 * Rule order is load-bearing. `Request` has `.json()`, `.text()` and `.headers`,
 * so those names alone cannot mean "legacy" — a fetch-style handler doing
 * `await req.json()` would be shimmed and then receive a `Response` where it
 * expected the parsed body. The two exact discriminators run first: `.req.` exists
 * only on a context, and no legacy handler ever awaits a context response method.
 */
export function detectHandlerAbi(source: string, name: string): HandlerAbi {
  const def = findDefinition(source, name);
  if (!def) return "fetch";

  const first = def.params[0];
  if (!first) return "fetch";

  // 1. An explicit `Request` annotation settles it.
  if (/^[\w$]+\s*:\s*Request\b/.test(first)) return "fetch";

  // 2. Nothing in the legacy ABI took a second parameter.
  if (def.params.length >= 2) return "fetch";

  const param = /^([A-Za-z_$][\w$]*)/.exec(first)?.[1];
  if (!param) return "fetch";
  const { body } = def;

  // 3. `Request` has no `.req`. Unambiguous, and it covers most real handlers.
  if (memberProbe(param, "req\\.").test(body)) return "legacy-context";

  // 4. The `Request`-only surface. `await <p>.json(` matters most: a context's
  //    response methods are synchronous constructors and are never awaited.
  if (
    new RegExp(`await\\s+(?<![\\w$.])${param}\\.(?:json|text|formData)\\s*\\(`)
      .test(body) ||
    usesAny(body, param, [
      "arrayBuffer\\s*\\(",
      "formData\\s*\\(",
      "blob\\s*\\(",
      "clone\\s*\\(",
      "headers\\b",
      "bodyUsed\\b",
      "signal\\b",
    ])
  ) return "fetch";

  // 5. Context members with no `Request` equivalent at all.
  if (
    usesAny(body, param, [
      "html\\s*\\(",
      "redirect\\s*\\(",
      "notFound\\s*\\(",
      "param\\s*\\(",
      "newResponse\\s*\\(",
    ])
  ) return "legacy-context";

  // 6. The ambiguous names, now safe: rule 4 already claimed the awaited reads.
  if (
    usesAny(body, param, [
      "json\\s*\\(",
      "text\\s*\\(",
      "body\\s*\\(",
      "header\\s*\\(",
      "status\\s*\\(",
      "set\\s*\\(",
      "get\\s*\\(",
    ])
  ) return "legacy-context";

  // 7. Annotations last, because `(c: any)` is what the old prompt actually
  //    produced — 175 of 175 handlers in the field — and `(req: any)` is what the
  //    new one plausibly will. The identifier breaks the tie.
  if (/:\s*Context\b/.test(first)) return "legacy-context";
  if (/:\s*any\b/.test(first) && !/^(req|request)$/i.test(param)) {
    return "legacy-context";
  }

  // 8. No evidence either way: a handler that ignores its argument works under
  //    both ABIs, so the unwrapped shape is the safe answer.
  return "fetch";
}

// --- The legacy compatibility shim ---

export interface LegacyContextRequest {
  method: string;
  url: string;
  path: string;
  query(key: string): string | undefined;
  query(): Record<string, string>;
  queries(key: string): string[] | undefined;
  param(key: string): string | undefined;
  param(): Record<string, string>;
  header(name: string): string | undefined;
  header(): Record<string, string>;
  json<T = unknown>(): Promise<T>;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
  raw: Request;
  valid<T>(target: string): T | undefined;
}

export interface LegacyContext {
  req: LegacyContextRequest;
  json(data: unknown, status?: number): Response;
  text(text: string, status?: number): Response;
  html(html: string, status?: number): Response;
  redirect(url: string, status?: number): Response;
  header(name: string, value: string | undefined): void;
  set(key: string, value: unknown): void;
  get(key: string): unknown;
  status(code: number): void;
  body(
    data: BodyInit | null,
    status?: number,
    headers?: Record<string, string>,
  ): Response;
  notFound(): Response;
}

export type LegacyHandlerFn = (
  c: LegacyContext,
) => Response | Promise<Response>;

/** What the modern equivalent is, for members the shim deliberately omits. */
const MIGRATION_HINTS: Record<string, string> = {
  env: "the `env` closure binding",
  executionCtx: "not available — the kernel has no execution context",
  var: "`c.get(key)`",
  event: "not available",
  error: "not available",
  res: "return a Response instead of mutating one",
  newResponse: "`new Response(body, init)`",
  stream: "`new Response(readableStream)`",
  parseBody: "`await c.req.formData()` on the raw Request (`c.req.raw`)",
  formData: "`await c.req.raw.formData()`",
  blob: "`await c.req.raw.blob()`",
  cookie: 'read the `Cookie` header via `c.req.header("cookie")`',
  render: "not available",
  setRenderer: "not available",
};

// A handler reaching for a member the kernel never declared should say so by name.
// Symbols and the handful of names the runtime itself probes (`then` when a value
// is awaited, `toJSON` when it is serialised) must pass through as undefined, or
// awaiting the context throws instead of resolving.
const RUNTIME_PROBES = new Set([
  "then",
  "catch",
  "finally",
  "toJSON",
  "inspect",
  "constructor",
  "valueOf",
  "toString",
  "nodeType",
]);

function guard<T extends object>(target: T, label: string): T {
  return new Proxy(target, {
    get(obj, prop, receiver) {
      if (typeof prop === "symbol" || prop in obj) {
        return Reflect.get(obj, prop, receiver);
      }
      if (RUNTIME_PROBES.has(prop)) return undefined;
      const hint = MIGRATION_HINTS[prop];
      throw new TypeError(
        `${label}.${prop} is not available. This handler uses the legacy Hono ` +
          `context, which the kernel emulates for the members it documented; ` +
          `${prop} was never one of them.` +
          (hint ? ` Use ${hint}.` : "") +
          ` Rewrite the handler against (req: Request, ctx: HandlerContext) ` +
          `to get the full Request/Response API.`,
      );
    },
  });
}

function headersFrom(request: Request): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of request.headers) out[k] = v;
  return out;
}

function firstQueryValues(url: URL): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of url.searchParams) if (!(k in out)) out[k] = v;
  return out;
}

/**
 * Adapt a handler written against the legacy Hono context to the fetch ABI.
 *
 * One context is built per request. It is not reused, so deferred `c.header()` and
 * `c.status()` state cannot leak between requests.
 */
export function wrapLegacyContextHandler(fn: LegacyHandlerFn): HandlerFn {
  return (req: Request, ctx: HandlerContext): Response | Promise<Response> => {
    const url = new URL(req.url);
    // Deferred mutations. `fresh` tracks whether anything has been set, because
    // Hono returns a bare `new Response(text)` only in that case and the two paths
    // produce different content-type spellings.
    const prepared = new Headers();
    let preparedStatus: number | undefined;
    let fresh = true;
    const store = new Map<string, unknown>();

    const responseInit = (
      status?: number,
      extra?: Record<string, string>,
    ): ResponseInit => {
      const headers = new Headers(prepared);
      if (extra) {
        for (const [k, v] of Object.entries(extra)) {
          headers.set(k, v);
        }
      }
      return { status: status ?? preparedStatus ?? 200, headers };
    };

    const request: LegacyContextRequest = {
      method: req.method,
      url: req.url,
      path: url.pathname,
      // deno-lint-ignore no-explicit-any
      query(key?: string): any {
        if (key === undefined) return firstQueryValues(url);
        return url.searchParams.get(key) ?? undefined;
      },
      queries(key: string): string[] | undefined {
        const all = url.searchParams.getAll(key);
        return all.length > 0 ? all : undefined;
      },
      // deno-lint-ignore no-explicit-any
      param(key?: string): any {
        if (key === undefined) return { ...ctx.params };
        return ctx.params[key];
      },
      // deno-lint-ignore no-explicit-any
      header(name?: string): any {
        if (name === undefined) return headersFrom(req);
        return req.headers.get(name) ?? undefined;
      },
      json<T = unknown>(): Promise<T> {
        return req.json() as Promise<T>;
      },
      text: () => req.text(),
      arrayBuffer: () => req.arrayBuffer(),
      raw: req,
      // The kernel validates before dispatch and never populates a validated
      // store, so this was always undefined. Declared, so not a Proxy throw.
      valid: <T>(_target: string): T | undefined => undefined,
    };

    const context: LegacyContext = {
      req: guard(request, "c.req"),

      json(data: unknown, status?: number): Response {
        fresh = false;
        return new Response(
          JSON.stringify(data),
          responseInit(status, { "content-type": APPLICATION_JSON }),
        );
      },

      text(text: string, status?: number): Response {
        if (fresh && status === undefined) {
          return new Response(text, {
            headers: { "content-type": TEXT_PLAIN_FROM_CONSTRUCTOR },
          });
        }
        fresh = false;
        return new Response(
          text,
          responseInit(status, { "content-type": TEXT_PLAIN }),
        );
      },

      html(html: string, status?: number): Response {
        fresh = false;
        return new Response(
          html,
          responseInit(status, { "content-type": TEXT_HTML }),
        );
      },

      redirect(location: string, status?: number): Response {
        fresh = false;
        const headers = new Headers(prepared);
        headers.set("location", location);
        return new Response(null, {
          status: status ?? DEFAULT_REDIRECT_STATUS,
          headers,
        });
      },

      // Content-type is deliberately left alone: when it is unset the Response
      // constructor supplies one, and when `c.header("Content-Type", …)` set it
      // the handler meant it.
      body(
        data: BodyInit | null,
        status?: number,
        headers?: Record<string, string>,
      ): Response {
        fresh = false;
        return new Response(data, responseInit(status, headers));
      },

      /* The one member whose answer belongs to the HOST, not to Hono: `c.notFound()`
         invokes the app's own notFound handler. Both hosts — the live preview
         (core/app-server.ts) and the exported shell — answer the documented envelope,
         so that is what this returns. A bare `new Hono()` would answer its plain-text
         default, which is why this case sits outside the Hono-parity corpus in
         core/handler-abi_test.ts. */
      notFound(): Response {
        return new Response(
          JSON.stringify({
            error: true,
            code: ROUTE_NOT_FOUND_CODE,
            message: `No route matches ${req.method} ${url.pathname}.`,
          }),
          { status: 404, headers: { "content-type": APPLICATION_JSON } },
        );
      },

      header(name: string, value: string | undefined): void {
        fresh = false;
        if (value === undefined) prepared.delete(name);
        else prepared.set(name, value);
      },

      status(code: number): void {
        fresh = false;
        preparedStatus = code;
      },

      set(key: string, value: unknown): void {
        store.set(key, value);
      },

      get(key: string): unknown {
        return store.get(key);
      },
    };

    return fn(guard(context, "c"));
  };
}
