import { assertEquals } from "@std/assert";
import type { RouteProbeResult } from "./production-smoke.ts";
import {
  comparableTargetRouteResults,
  compareTargetParity,
  type TargetRouteResults,
} from "./route-parity.ts";

// Slice 4.4 (docs/production-output-hardening-plan.md → Milestone 4, Phase 8):
// compareTargetParity is pure and never throws — given the per-route observations
// each target smoke gate retained, it returns the FIRST cross-target mismatch
// (naming the route, the field, and both target values) or null when every target
// agrees on every probed route. The retention + wiring is exercised end-to-end via
// the production-build gate tests (real boots); here we prove the comparator in
// isolation, no subprocess. Deno-source is always the baseline (observations[0]).

// Build a RouteProbeResult with reachable-200 defaults; overrides bend the field
// under test. Mirrors production-smoke_test.ts's `result` helper.
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

function target(
  name: string,
  results: RouteProbeResult[],
): TargetRouteResults {
  return { target: name, results };
}

// --- Agreement → null ---------------------------------------------------------

Deno.test("compareTargetParity: two targets fully agreeing → null", () => {
  const routes = [
    result({ method: "GET", path: "/alpha", contentType: "application/json" }),
    result({ method: "HEAD", path: "/beta" }),
  ];
  const observations = [
    target("deno-source", routes),
    target("node", routes.map((r) => ({ ...r }))),
  ];
  assertEquals(compareTargetParity(observations), null);
});

// --- Status parity ------------------------------------------------------------

Deno.test("compareTargetParity: a status mismatch names the route and both statuses", () => {
  const observations = [
    target("deno-source", [result({ method: "GET", path: "/orders" })]),
    target("node", [
      result({
        method: "GET",
        path: "/orders",
        expectedStatus: 404,
        actualStatus: 404,
      }),
    ]),
  ];
  const msg = compareTargetParity(observations);
  assertEquals(typeof msg, "string");
  assertEquals(msg!.includes("GET /orders"), true);
  assertEquals(msg!.includes("200"), true);
  assertEquals(msg!.includes("404"), true);
  // Both target names appear so the divergence is actionable.
  assertEquals(msg!.includes("deno-source"), true);
  assertEquals(msg!.includes("node"), true);
});

// --- Content-type parity ------------------------------------------------------

Deno.test("compareTargetParity: a content-type mismatch is caught", () => {
  const observations = [
    target("deno-source", [
      result({ method: "GET", path: "/x", contentType: "text/plain" }),
    ]),
    target("node", [
      result({ method: "GET", path: "/x", contentType: "text/html" }),
    ]),
  ];
  const msg = compareTargetParity(observations);
  assertEquals(typeof msg, "string");
  assertEquals(msg!.includes("GET /x"), true);
  assertEquals(msg!.includes("content-type"), true);
  assertEquals(msg!.includes("text/plain"), true);
  assertEquals(msg!.includes("text/html"), true);
});

Deno.test("compareTargetParity: content-type differing ONLY by case → null (normalized)", () => {
  const observations = [
    target("deno-source", [
      result({
        method: "GET",
        path: "/x",
        contentType: "application/json; charset=utf-8",
      }),
    ]),
    target("node", [
      result({
        method: "GET",
        path: "/x",
        contentType: "application/json; charset=UTF-8",
      }),
    ]),
  ];
  assertEquals(compareTargetParity(observations), null);
});

// --- Body parity (deterministicBody) ------------------------------------------

Deno.test("compareTargetParity: a bodyHash mismatch on a deterministicBody route is caught", () => {
  const observations = [
    target("deno-source", [
      result({
        method: "GET",
        path: "/orders",
        deterministicBody: true,
        bodyHash: "aaaa",
      }),
    ]),
    target("node", [
      result({
        method: "GET",
        path: "/orders",
        deterministicBody: true,
        bodyHash: "bbbb",
      }),
    ]),
  ];
  const msg = compareTargetParity(observations);
  assertEquals(typeof msg, "string");
  assertEquals(msg!.includes("GET /orders"), true);
  assertEquals(msg!.includes("body"), true);
  assertEquals(msg!.includes("deterministicBody"), true);
});

Deno.test("compareTargetParity: bodies differ but deterministicBody false (bodyHash null) → null (not compared)", () => {
  // A bare non-deterministic route carries a null hash on both targets even though
  // the real bodies differ (a timestamp/random id): parity never body-compares it.
  const observations = [
    target("deno-source", [
      result({ method: "GET", path: "/now", bodyHash: null }),
    ]),
    target("node", [
      result({ method: "GET", path: "/now", bodyHash: null }),
    ]),
  ];
  assertEquals(compareTargetParity(observations), null);
});

Deno.test("compareTargetParity: bodyHash present on baseline but null on the other → null (only compared when both present)", () => {
  const observations = [
    target("deno-source", [
      result({
        method: "GET",
        path: "/orders",
        deterministicBody: true,
        bodyHash: "aaaa",
      }),
    ]),
    // The other target did not fingerprint (e.g. body read failed) → null, so the
    // pair is not body-compared and this agrees on everything else.
    target("node", [
      result({ method: "GET", path: "/orders", bodyHash: null }),
    ]),
  ];
  assertEquals(compareTargetParity(observations), null);
});

// --- Comparable route filtering ----------------------------------------------

Deno.test("compareTargetParity: a route present on the baseline but absent on another is excluded", () => {
  const observations = [
    target("deno-source", [result({ method: "GET", path: "/orders" })]),
    target("node", []),
  ];
  assertEquals(compareTargetParity(observations), null);
  assertEquals(
    comparableTargetRouteResults(observations)[0]!.results.length,
    0,
  );
});

Deno.test("compareTargetParity: advisory-failed routes are excluded but passing routes still compare", () => {
  const observations = [
    target("deno-source", [
      result({ method: "GET", path: "/bad", actualStatus: 500 }),
      result({
        method: "GET",
        path: "/ok",
        contentType: "application/json",
      }),
    ]),
    target("node", [
      result({ method: "GET", path: "/bad", actualStatus: 200 }),
      result({
        method: "GET",
        path: "/ok",
        contentType: "text/html",
      }),
    ]),
  ];
  const comparable = comparableTargetRouteResults(observations);
  assertEquals(comparable[0]!.results.map((r) => r.path), ["/ok"]);
  const msg = compareTargetParity(observations);
  assertEquals(typeof msg, "string");
  assertEquals(msg!.includes("GET /ok"), true);
  assertEquals(msg!.includes("GET /bad"), false);
});

// --- Three targets ------------------------------------------------------------

Deno.test("compareTargetParity: three targets where the third diverges is caught", () => {
  const routes = [result({ method: "GET", path: "/alpha", actualStatus: 200 })];
  const observations = [
    target("deno-source", routes.map((r) => ({ ...r }))),
    target("node", routes.map((r) => ({ ...r }))),
    target("binary", [
      result({
        method: "GET",
        path: "/alpha",
        expectedStatus: 201,
        actualStatus: 201,
      }),
    ]),
  ];
  const msg = compareTargetParity(observations);
  assertEquals(typeof msg, "string");
  assertEquals(msg!.includes("GET /alpha"), true);
  assertEquals(msg!.includes("binary"), true);
  assertEquals(msg!.includes("201"), true);
});

// --- Nothing to compare -------------------------------------------------------

Deno.test("compareTargetParity: a single-target list → null (nothing to compare)", () => {
  const observations = [
    target("deno-source", [result({ method: "GET", path: "/alpha" })]),
  ];
  assertEquals(compareTargetParity(observations), null);
});

Deno.test("compareTargetParity: an empty observation list → null", () => {
  assertEquals(compareTargetParity([]), null);
});

// --- Determinism --------------------------------------------------------------

// The same observations always yield the same first mismatch: routes are walked in
// the baseline's order and targets in the given order. Here both /alpha (status)
// and /beta (content-type) diverge; the baseline lists /alpha first, so its status
// mismatch is the deterministic first result across repeated calls.
Deno.test("compareTargetParity: first mismatch is deterministic (baseline route order, fixed target order)", () => {
  const observations = [
    target("deno-source", [
      result({ method: "GET", path: "/alpha", actualStatus: 200 }),
      result({ method: "GET", path: "/beta", contentType: "text/plain" }),
    ]),
    target("node", [
      result({
        method: "GET",
        path: "/alpha",
        expectedStatus: 201,
        actualStatus: 201,
      }),
      result({ method: "GET", path: "/beta", contentType: "text/html" }),
    ]),
  ];
  const first = compareTargetParity(observations);
  assertEquals(first, compareTargetParity(observations));
  // /alpha precedes /beta in the baseline, so its (status) mismatch wins.
  assertEquals(first!.includes("GET /alpha"), true);
  assertEquals(first!.includes("GET /beta"), false);
});
