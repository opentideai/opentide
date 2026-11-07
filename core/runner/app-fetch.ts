// User code that fetches its own app (a test doing `fetch(appUrl("/x"))`)
// can't reach it from the runner: loopback is denied. So the runner's fetch
// sends app-origin requests to the kernel, and the kernel makes them.
//
// The kernel only ever fetches its own app origin: it takes the path and query
// from the runner and nothing else, and doesn't follow redirects. The runner
// follows them itself, so a redirect off the app origin goes through the
// runner's own fetch and its deny list.

import { RUNNER_REQUEST_TIMEOUT_MS } from "../config.ts";
import type { RequestHandler, RpcPeer } from "./peer.ts";
import {
  decodeRequest,
  decodeResponse,
  encodeRequest,
  encodeResponse,
  RUNNER_ERROR_CODES,
  RUNNER_METHODS,
  type WireRequest,
  type WireResponse,
} from "./protocol.ts";

// The Fetch standard's redirect limit.
const MAX_REDIRECTS = 20;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export type AppForward = (request: Request) => Promise<Response>;

// The runner's fetch: anything for the app's origin goes to `forward`,
// everything else to the real fetch.
export function appFetchShim(
  realFetch: typeof fetch,
  appOrigin: () => string,
  forward: AppForward,
): typeof fetch {
  const shim = async (
    input: string | URL | Request,
    init?: RequestInit,
    hops = 0,
  ): Promise<Response> => {
    if (originOf(input) !== appOrigin()) return realFetch(input, init);
    const request = new Request(input, init);
    const body = request.body ? await request.arrayBuffer() : null;
    const response = await forward(
      new Request(request, { body, redirect: "manual" }),
    );
    const location = response.headers.get("location");
    if (!REDIRECT_STATUSES.has(response.status) || location === null) {
      return response;
    }
    if (request.redirect === "manual") return response;
    if (request.redirect === "error") {
      throw new TypeError(
        `Redirect from ${request.url} with redirect: "error"`,
      );
    }
    if (hops >= MAX_REDIRECTS) {
      throw new TypeError(`Too many redirects fetching ${request.url}`);
    }
    await response.body?.cancel();
    const method = switchesToGet(response.status, request.method)
      ? "GET"
      : request.method;
    return shim(new URL(location, request.url), {
      method,
      headers: request.headers,
      body: method === request.method ? body : null,
      redirect: request.redirect,
    }, hops + 1);
  };
  return (input, init) => shim(input, init);
}

// The runner's side of the hop: the request goes to the kernel whole.
export function rpcAppForward(peer: RpcPeer): AppForward {
  return async (request) => {
    const answer = await peer.request<WireResponse>(
      RUNNER_METHODS.appFetch,
      await encodeRequest(request),
      RUNNER_REQUEST_TIMEOUT_MS,
    );
    if (!answer.ok) throw new TypeError(answer.error.message);
    return decodeResponse(answer.data);
  };
}

// The kernel's answer to app.fetch: the same request, made to its own app.
export function appFetchHandler(
  appOrigin: () => string,
  fetchFn: typeof fetch = fetch,
): RequestHandler {
  return async (params) => {
    if (!isWireRequest(params)) {
      return {
        ok: false,
        error: {
          code: RUNNER_ERROR_CODES.invalidParams,
          message: "app.fetch needs a request",
        },
      };
    }
    const asked = new URL(params.url);
    const target = new URL(asked.pathname + asked.search, appOrigin());
    const request = decodeRequest({ ...params, url: target.href });
    const headers = new Headers(request.headers);
    headers.delete("host");
    const response = await fetchFn(
      new Request(request, { headers, redirect: "manual" }),
    );
    return await encodeResponse(response);
  };
}

function originOf(input: string | URL | Request): string | null {
  const href = input instanceof Request
    ? input.url
    : input instanceof URL
    ? input.href
    : String(input);
  return URL.canParse(href) ? new URL(href).origin : null;
}

// What browsers and Deno do: a 303 always becomes a GET, and a 301 or 302
// does for a POST.
function switchesToGet(status: number, method: string): boolean {
  return status === 303 ||
    ((status === 301 || status === 302) && method === "POST");
}

function isWireRequest(params: unknown): params is WireRequest {
  if (typeof params !== "object" || params === null) return false;
  const p = params as Record<string, unknown>;
  return typeof p.url === "string" && URL.canParse(p.url) &&
    typeof p.method === "string" && Array.isArray(p.headers);
}
