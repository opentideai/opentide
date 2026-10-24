import { assertEquals } from "@std/assert";
import type { RouteEntry, RouteSchema } from "../core/types.ts";
import { HEALTH_OK_STATUS } from "./production-smoke.ts";
import {
  buildRouteSmokePlan,
  deriveExpectedStatus,
  HTTP_GET,
  HTTP_HEAD,
  isPlatformRoute,
  SKIP_MUTATING_METHOD,
  SKIP_REQUIRES_BODY,
  SKIP_REQUIRES_PATH_PARAM,
  SKIP_REQUIRES_QUERY,
} from "./route-smoke-plan.ts";

// Build a RouteEntry literal with only the fields the derivation reads; the
// registeredAt/handlerName are required by the interface but never inspected.
function route(
  method: string,
  path: string,
  schema?: RouteSchema,
): RouteEntry {
  return {
    method,
    path,
    handlerName: `${method} ${path}`,
    registeredAt: "1970-01-01T00:00:00.000Z",
    ...(schema ? { schema } : {}),
  };
}

Deno.test("empty routes + no OpenAPI → plan is exactly [GET /_health]", () => {
  const plan = buildRouteSmokePlan([], false);
  assertEquals(plan, {
    probes: [
      {
        method: HTTP_GET,
        path: "/_health",
        expectedStatus: HEALTH_OK_STATUS,
        expectsJson: false,
        deterministicBody: false,
      },
    ],
    skipped: [],
  });
});

Deno.test("expectOpenApi=true adds GET /openapi.json probe", () => {
  const plan = buildRouteSmokePlan([], true);
  assertEquals(plan.probes, [
    {
      method: HTTP_GET,
      path: "/_health",
      expectedStatus: HEALTH_OK_STATUS,
      expectsJson: false,
      deterministicBody: false,
    },
    {
      method: HTTP_GET,
      path: "/openapi.json",
      expectedStatus: HEALTH_OK_STATUS,
      expectsJson: false,
      deterministicBody: false,
    },
  ]);
  assertEquals(plan.skipped, []);
});

Deno.test("param-free GET and HEAD become probes", () => {
  const plan = buildRouteSmokePlan(
    [route(HTTP_GET, "/alpha"), route(HTTP_HEAD, "/beta")],
    false,
  );
  assertEquals(plan.probes, [
    {
      method: HTTP_GET,
      path: "/_health",
      expectedStatus: HEALTH_OK_STATUS,
      expectsJson: false,
      deterministicBody: false,
    },
    {
      method: HTTP_GET,
      path: "/alpha",
      expectedStatus: HEALTH_OK_STATUS,
      expectsJson: false,
      deterministicBody: false,
    },
    {
      method: HTTP_HEAD,
      path: "/beta",
      expectedStatus: HEALTH_OK_STATUS,
      expectsJson: false,
      deterministicBody: false,
    },
  ]);
  assertEquals(plan.skipped, []);
});

Deno.test("mutating method → SKIP_MUTATING_METHOD", () => {
  const plan = buildRouteSmokePlan([route("POST", "/x")], false);
  assertEquals(plan.skipped, [
    { method: "POST", path: "/x", reason: SKIP_MUTATING_METHOD },
  ]);
});

Deno.test("colon path param → SKIP_REQUIRES_PATH_PARAM", () => {
  const plan = buildRouteSmokePlan([route(HTTP_GET, "/users/:id")], false);
  assertEquals(plan.skipped, [
    { method: HTTP_GET, path: "/users/:id", reason: SKIP_REQUIRES_PATH_PARAM },
  ]);
});

Deno.test("non-empty schema.params → SKIP_REQUIRES_PATH_PARAM", () => {
  const plan = buildRouteSmokePlan(
    [route(HTTP_GET, "/items", { params: { id: { type: "string" } } })],
    false,
  );
  assertEquals(plan.skipped, [
    { method: HTTP_GET, path: "/items", reason: SKIP_REQUIRES_PATH_PARAM },
  ]);
});

Deno.test("required query param → SKIP_REQUIRES_QUERY", () => {
  const plan = buildRouteSmokePlan(
    [route(HTTP_GET, "/search", {
      query: { q: { type: "string", required: true } },
    })],
    false,
  );
  assertEquals(plan.skipped, [
    { method: HTTP_GET, path: "/search", reason: SKIP_REQUIRES_QUERY },
  ]);
});

Deno.test("optional query param alone does NOT skip", () => {
  const plan = buildRouteSmokePlan(
    [route(HTTP_GET, "/list", { query: { page: { type: "string" } } })],
    false,
  );
  assertEquals(plan.skipped, []);
  assertEquals(plan.probes.map((p) => p.path), ["/_health", "/list"]);
});

Deno.test("required body → SKIP_REQUIRES_BODY", () => {
  const plan = buildRouteSmokePlan(
    [route(HTTP_GET, "/y", { body: { type: "object", required: ["x"] } })],
    false,
  );
  assertEquals(plan.skipped, [
    { method: HTTP_GET, path: "/y", reason: SKIP_REQUIRES_BODY },
  ]);
});

Deno.test("precedence: POST /users/:id is SKIP_MUTATING_METHOD (method first)", () => {
  const plan = buildRouteSmokePlan([route("POST", "/users/:id")], false);
  assertEquals(plan.skipped, [
    { method: "POST", path: "/users/:id", reason: SKIP_MUTATING_METHOD },
  ]);
});

Deno.test("platform routes are neither duplicated into probes nor skipped", () => {
  const plan = buildRouteSmokePlan(
    [route(HTTP_GET, "/_health"), route(HTTP_GET, "/openapi.json")],
    true,
  );
  // Exactly the always-generate pair, once each; nothing skipped.
  assertEquals(plan.probes, [
    {
      method: HTTP_GET,
      path: "/_health",
      expectedStatus: HEALTH_OK_STATUS,
      expectsJson: false,
      deterministicBody: false,
    },
    {
      method: HTTP_GET,
      path: "/openapi.json",
      expectedStatus: HEALTH_OK_STATUS,
      expectsJson: false,
      deterministicBody: false,
    },
  ]);
  assertEquals(plan.skipped, []);
});

Deno.test("duplicate app route is deduped to a single probe", () => {
  const plan = buildRouteSmokePlan(
    [route(HTTP_GET, "/alpha"), route(HTTP_GET, "/alpha")],
    false,
  );
  assertEquals(plan.probes.filter((p) => p.path === "/alpha").length, 1);
});

Deno.test("determinism: shuffled input yields a byte-identical, sorted plan", () => {
  const routes = [
    route("POST", "/zeta"),
    route(HTTP_GET, "/alpha"),
    route(HTTP_HEAD, "/alpha"),
    route(HTTP_GET, "/users/:id"),
    route(HTTP_GET, "/mid", {
      query: { q: { type: "string", required: true } },
    }),
  ];
  const sortedPlan = buildRouteSmokePlan(routes, true);
  const shuffledPlan = buildRouteSmokePlan(routes.toReversed(), true);
  assertEquals(shuffledPlan, sortedPlan);

  // Probes are (path, method)-ordered: /_health, then /alpha (GET before HEAD),
  // then /openapi.json (/mid, /users/:id, /zeta are all skipped).
  assertEquals(sortedPlan.probes, [
    {
      method: HTTP_GET,
      path: "/_health",
      expectedStatus: HEALTH_OK_STATUS,
      expectsJson: false,
      deterministicBody: false,
    },
    {
      method: HTTP_GET,
      path: "/alpha",
      expectedStatus: HEALTH_OK_STATUS,
      expectsJson: false,
      deterministicBody: false,
    },
    {
      method: HTTP_HEAD,
      path: "/alpha",
      expectedStatus: HEALTH_OK_STATUS,
      expectsJson: false,
      deterministicBody: false,
    },
    {
      method: HTTP_GET,
      path: "/openapi.json",
      expectedStatus: HEALTH_OK_STATUS,
      expectsJson: false,
      deterministicBody: false,
    },
  ]);
  // Skipped are (path, method)-ordered too.
  assertEquals(sortedPlan.skipped, [
    { method: HTTP_GET, path: "/mid", reason: SKIP_REQUIRES_QUERY },
    { method: HTTP_GET, path: "/users/:id", reason: SKIP_REQUIRES_PATH_PARAM },
    { method: "POST", path: "/zeta", reason: SKIP_MUTATING_METHOD },
  ]);
});

// --- deriveExpectedStatus (Slice 4.2) -----------------------------------------

Deno.test("deriveExpectedStatus: only 201 declared → 201", () => {
  assertEquals(
    deriveExpectedStatus({ responses: { "201": { description: "Created" } } }),
    201,
  );
});

Deno.test("deriveExpectedStatus: 200 + 404 declared → 200 (lowest 2xx)", () => {
  assertEquals(
    deriveExpectedStatus({
      responses: {
        "404": { description: "Missing" },
        "200": { description: "OK" },
      },
    }),
    200,
  );
});

Deno.test("deriveExpectedStatus: no 2xx declared → 200 fallback", () => {
  assertEquals(
    deriveExpectedStatus({
      responses: { "404": { description: "Missing" } },
    }),
    HEALTH_OK_STATUS,
  );
});

Deno.test("deriveExpectedStatus: missing/partial schema → 200 fallback", () => {
  assertEquals(deriveExpectedStatus(undefined), HEALTH_OK_STATUS);
  assertEquals(deriveExpectedStatus({}), HEALTH_OK_STATUS);
  assertEquals(deriveExpectedStatus({ responses: {} }), HEALTH_OK_STATUS);
});

// --- expectsJson / expectedStatus threaded onto the probe (Slice 4.2) ---------

Deno.test("a JSON-declared 2xx response yields expectsJson + the derived status", () => {
  const plan = buildRouteSmokePlan(
    [route(HTTP_GET, "/widget", {
      responses: {
        "201": { description: "Created", schema: { type: "object" } },
      },
    })],
    false,
  );
  const widget = plan.probes.find((p) => p.path === "/widget");
  assertEquals(widget, {
    method: HTTP_GET,
    path: "/widget",
    expectedStatus: 201,
    expectsJson: true,
    deterministicBody: false,
  });
});

Deno.test("a schema-less 2xx response is not expectsJson", () => {
  const plan = buildRouteSmokePlan(
    [route(HTTP_GET, "/plain", {
      responses: { "200": { description: "OK" } },
    })],
    false,
  );
  const plain = plan.probes.find((p) => p.path === "/plain");
  assertEquals(plain, {
    method: HTTP_GET,
    path: "/plain",
    expectedStatus: HEALTH_OK_STATUS,
    expectsJson: false,
    deterministicBody: false,
  });
});

// --- isPlatformRoute export (Slice 4.2) ---------------------------------------

Deno.test("isPlatformRoute matches exactly the always-generate pair", () => {
  assertEquals(isPlatformRoute("/_health"), true);
  assertEquals(isPlatformRoute("/openapi.json"), true);
  assertEquals(isPlatformRoute("/alpha"), false);
  assertEquals(isPlatformRoute("/"), false);
});

// --- productionTest fixtures (Slice 4.3) --------------------------------------

Deno.test("POST marked safe with a body fixture becomes a probe carrying method + body", () => {
  const plan = buildRouteSmokePlan(
    [route("POST", "/orders", {
      body: { type: "object", required: ["item"] },
      responses: {
        "201": { description: "Created", schema: { type: "object" } },
      },
      productionTest: {
        safe: true,
        exampleRequest: { body: { item: "widget" } },
      },
    })],
    false,
  );
  assertEquals(plan.skipped, []);
  const orders = plan.probes.find((p) => p.path === "/orders");
  // The whole resolved probe: promoted method, the derived 201 status, the JSON
  // body flag, the serialized body, and deterministicBody defaulted false.
  assertEquals(orders, {
    method: "POST",
    path: "/orders",
    expectedStatus: 201,
    expectsJson: true,
    requestBody: { item: "widget" },
    deterministicBody: false,
  });
});

Deno.test("a POST without productionTest.safe stays SKIP_MUTATING_METHOD even with a body fixture", () => {
  const plan = buildRouteSmokePlan(
    [route("POST", "/orders", {
      body: { type: "object", required: ["item"] },
      productionTest: { exampleRequest: { body: { item: "widget" } } },
    })],
    false,
  );
  // The safety gate is on `safe`, not on merely supplying inputs: an unmarked
  // mutating method is never auto-executed.
  assertEquals(plan.probes.some((p) => p.path === "/orders"), false);
  assertEquals(plan.skipped, [
    { method: "POST", path: "/orders", reason: SKIP_MUTATING_METHOD },
  ]);
});

Deno.test("GET /users/:id with a pathParams fixture probes the substituted path", () => {
  const plan = buildRouteSmokePlan(
    [route(HTTP_GET, "/users/:id", {
      params: { id: { type: "string" } },
      productionTest: { exampleRequest: { pathParams: { id: "123" } } },
    })],
    false,
  );
  assertEquals(plan.skipped, []);
  // The PROBE path is resolved; the unsubstituted template is gone.
  assertEquals(plan.probes.some((p) => p.path === "/users/123"), true);
  assertEquals(plan.probes.some((p) => p.path === "/users/:id"), false);
});

Deno.test("a parameterized route missing its pathParams fixture stays SKIP_REQUIRES_PATH_PARAM", () => {
  const plan = buildRouteSmokePlan(
    [route(HTTP_GET, "/users/:id", {
      params: { id: { type: "string" } },
      // A fixture is present but covers the wrong axis (query, not pathParams).
      productionTest: { exampleRequest: { query: { q: "x" } } },
    })],
    false,
  );
  assertEquals(plan.probes.some((p) => p.path.startsWith("/users")), false);
  assertEquals(plan.skipped, [
    { method: HTTP_GET, path: "/users/:id", reason: SKIP_REQUIRES_PATH_PARAM },
  ]);
});

Deno.test("a required query is probed with a query fixture and skipped without one", () => {
  const withFixture = buildRouteSmokePlan(
    [route(HTTP_GET, "/search", {
      query: { q: { type: "string", required: true } },
      productionTest: { exampleRequest: { query: { q: "hello world" } } },
    })],
    false,
  );
  assertEquals(withFixture.skipped, []);
  // The value is encodeURIComponent-encoded onto the path.
  assertEquals(
    withFixture.probes.some((p) => p.path === "/search?q=hello%20world"),
    true,
  );

  const withoutFixture = buildRouteSmokePlan(
    [route(HTTP_GET, "/search", {
      query: { q: { type: "string", required: true } },
      productionTest: { exampleRequest: { pathParams: {} } },
    })],
    false,
  );
  assertEquals(withoutFixture.skipped, [
    { method: HTTP_GET, path: "/search", reason: SKIP_REQUIRES_QUERY },
  ]);
});

Deno.test("productionTest.expectedStatus overrides the schema-derived status", () => {
  const plan = buildRouteSmokePlan(
    [route(HTTP_GET, "/teapot", {
      responses: { "200": { description: "OK" } },
      productionTest: { expectedStatus: 418 },
    })],
    false,
  );
  const probe = plan.probes.find((p) => p.path === "/teapot");
  assertEquals(probe?.expectedStatus, 418);
});

Deno.test("query-string keys are sorted, so the probe path is byte-stable", () => {
  const plan = buildRouteSmokePlan(
    [route(HTTP_GET, "/list", {
      productionTest: { exampleRequest: { query: { zeta: "1", alpha: "2" } } },
    })],
    false,
  );
  assertEquals(
    plan.probes.some((p) => p.path === "/list?alpha=2&zeta=1"),
    true,
  );
});

Deno.test("path param values are encodeURIComponent-encoded (cannot break out of a segment)", () => {
  const plan = buildRouteSmokePlan(
    [route(HTTP_GET, "/files/:name", {
      params: { name: { type: "string" } },
      productionTest: { exampleRequest: { pathParams: { name: "a/b c" } } },
    })],
    false,
  );
  assertEquals(plan.probes.some((p) => p.path === "/files/a%2Fb%20c"), true);
});

Deno.test("productionTest.deterministicBody is threaded onto the probe", () => {
  const plan = buildRouteSmokePlan(
    [route("POST", "/orders", {
      productionTest: { safe: true, deterministicBody: true },
    })],
    false,
  );
  const probe = plan.probes.find((p) => p.path === "/orders");
  assertEquals(probe?.deterministicBody, true);
});

Deno.test("a required-body GET stays SKIP_REQUIRES_BODY even with a body fixture", () => {
  const plan = buildRouteSmokePlan(
    [route(HTTP_GET, "/y", {
      body: { type: "object", required: ["x"] },
      // A GET cannot carry a body (fetch forbids it), so the fixture can't rescue
      // it — the contradiction stays honestly skipped.
      productionTest: { exampleRequest: { body: { x: 1 } } },
    })],
    false,
  );
  assertEquals(plan.probes.some((p) => p.path === "/y"), false);
  assertEquals(plan.skipped, [
    { method: HTTP_GET, path: "/y", reason: SKIP_REQUIRES_BODY },
  ]);
});

Deno.test("a promoted mutating probe with no body fixture carries no requestBody", () => {
  const plan = buildRouteSmokePlan(
    [route("DELETE", "/orders/:id", {
      params: { id: { type: "string" } },
      productionTest: {
        safe: true,
        exampleRequest: { pathParams: { id: "7" } },
      },
    })],
    false,
  );
  const probe = plan.probes.find((p) => p.path === "/orders/7");
  assertEquals(probe?.method, "DELETE");
  assertEquals(probe !== undefined && "requestBody" in probe, false);
});
