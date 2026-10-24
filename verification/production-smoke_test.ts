import { assert, assertEquals } from "@std/assert";
import {
  checkRouteSmokeContract,
  probeRouteSmoke,
  type RouteProbeResult,
} from "./production-smoke.ts";

// Slice 4.2 (docs/production-output-hardening-plan.md → Milestone 4): the route
// contract `checkRouteSmokeContract` is pure and never throws — given the results
// probeRouteSmoke observed against a booted app, it returns the FIRST failure
// message (naming the offending METHOD /path) or null when every probe holds.
// probeRouteSmoke itself is exercised end-to-end via the production-build gate
// tests (a real boot); here we prove the contract in isolation, no subprocess.
//
// Slice 4.3 note: checkRouteSmokeContract is method-agnostic and UNCHANGED (a
// 201-from-POST is validated exactly like a 200-from-GET), so it needs no new
// pure cases here. The new request-building (buildRouteRequestInit issuing a
// fixture-driven POST/param'd GET with a JSON body) is covered end-to-end by the
// fixture-driven gate tests in production-build_test.ts rather than re-mocked here.

// Build a RouteProbeResult literal with sensible reachable-200 defaults; overrides
// let each test bend exactly the field under test.
function result(
  over: Partial<RouteProbeResult> & Pick<RouteProbeResult, "method" | "path">,
): RouteProbeResult {
  return {
    expectedStatus: 200,
    expectsJson: false,
    actualStatus: 200,
    contentType: null,
    deterministicBody: false,
    bodyHash: null,
    ...over,
  };
}

Deno.test("checkRouteSmokeContract: a clean 200 set → null", () => {
  const results = [
    result({ method: "GET", path: "/alpha" }),
    result({ method: "HEAD", path: "/beta" }),
  ];
  assertEquals(checkRouteSmokeContract(results), null);
});

Deno.test("checkRouteSmokeContract: a 500 fails, naming the route", () => {
  const results = [
    result({ method: "GET", path: "/alpha" }),
    result({
      method: "GET",
      path: "/boom",
      actualStatus: 500,
      bodySnippet: "database unavailable",
    }),
  ];
  const msg = checkRouteSmokeContract(results);
  assertEquals(msg !== null, true);
  assertEquals(msg!.includes("GET /boom"), true);
  assertEquals(msg!.includes("500"), true);
  assertEquals(msg!.includes("database unavailable"), true);
});

Deno.test("checkRouteSmokeContract: any 5xx fails (not just 500)", () => {
  const results = [result({ method: "GET", path: "/bad", actualStatus: 503 })];
  const msg = checkRouteSmokeContract(results);
  assertEquals(msg !== null, true);
  assertEquals(msg!.includes("/bad"), true);
  assertEquals(msg!.includes("503"), true);
});

Deno.test("checkRouteSmokeContract: a status mismatch (expected 201, got 200) fails", () => {
  const results = [
    result({
      method: "GET",
      path: "/created",
      expectedStatus: 201,
      bodySnippet: '{"message":"wrong state"}',
    }),
  ];
  const msg = checkRouteSmokeContract(results);
  assertEquals(msg !== null, true);
  assertEquals(msg!.includes("GET /created"), true);
  assertEquals(msg!.includes("201"), true);
  assertEquals(msg!.includes("wrong state"), true);
});

Deno.test("checkRouteSmokeContract: expected 201 and got 201 → null", () => {
  const results = [
    result({
      method: "GET",
      path: "/created",
      expectedStatus: 201,
      actualStatus: 201,
    }),
  ];
  assertEquals(checkRouteSmokeContract(results), null);
});

Deno.test("checkRouteSmokeContract: a JSON-declared route whose body didn't parse fails", () => {
  const results = [
    result({
      method: "GET",
      path: "/json",
      expectsJson: true,
      contentType: "application/json",
      jsonParsed: false,
    }),
  ];
  const msg = checkRouteSmokeContract(results);
  assertEquals(msg !== null, true);
  assertEquals(msg!.includes("GET /json"), true);
});

Deno.test("checkRouteSmokeContract: a JSON-declared route with a parsed JSON body → null", () => {
  const results = [
    result({
      method: "GET",
      path: "/json",
      expectsJson: true,
      contentType: "application/json; charset=utf-8",
      jsonParsed: true,
    }),
  ];
  assertEquals(checkRouteSmokeContract(results), null);
});

Deno.test("checkRouteSmokeContract: a JSON-declared route with a non-JSON content-type fails", () => {
  const results = [
    result({
      method: "GET",
      path: "/json",
      expectsJson: true,
      contentType: "text/html",
      jsonParsed: true,
    }),
  ];
  const msg = checkRouteSmokeContract(results);
  assertEquals(msg !== null, true);
  assertEquals(msg!.includes("GET /json"), true);
  assertEquals(msg!.includes("content-type"), true);
});

Deno.test("checkRouteSmokeContract: an unreachable route (fetch failed) fails, naming the route", () => {
  const results = [
    result({
      method: "GET",
      path: "/gone",
      actualStatus: null,
      error: "connection refused",
    }),
  ];
  const msg = checkRouteSmokeContract(results);
  assertEquals(msg !== null, true);
  assertEquals(msg!.includes("GET /gone"), true);
  assertEquals(msg!.includes("connection refused"), true);
});

Deno.test("checkRouteSmokeContract: empty results → null (nothing to fault)", () => {
  assertEquals(checkRouteSmokeContract([]), null);
});

Deno.test({
  name: "probeRouteSmoke observes redirect status without following Location",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const server = Deno.serve(
      { hostname: "127.0.0.1", port: 0, onListen: () => undefined },
      () =>
        new Response(null, {
          status: 302,
          headers: { location: "http://169.254.169.254/latest/meta-data" },
        }),
    );
    try {
      const base = new URL(`http://127.0.0.1:${server.addr.port}`);
      const [result] = await probeRouteSmoke(base, [{
        method: "GET",
        path: "/redirect",
        expectedStatus: 302,
        expectsJson: false,
        deterministicBody: false,
      }]);

      assert(result);
      assertEquals(result.actualStatus, 302);
      assertEquals(result.error, undefined);
      assertEquals(checkRouteSmokeContract([result]), null);
    } finally {
      await server.shutdown();
    }
  },
});
