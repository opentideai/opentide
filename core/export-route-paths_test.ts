import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { testStoreComposition } from "../verification/test-stores.ts";
import { Database } from "./db.ts";
import {
  assertExportableRoutePaths,
  exportProject,
  routePathParamNames,
} from "./export.ts";
import { Kernel } from "./registries.ts";

// Stage 10 of docs/framework-free-handler-abi-plan.md: the exported shell routes on
// URLPattern instead of Hono. These tests cover the preconditions the swap needs and
// the matcher it emits.

// --- Path-parameter extraction (brace-balanced) --------------------------------

Deno.test("routePathParamNames reads the kernel path DSL", () => {
  assertEquals(routePathParamNames("/items"), []);
  assertEquals(routePathParamNames("/items/:id"), ["id"]);
  assertEquals(routePathParamNames("/:a/x/:b"), ["a", "b"]);
  assertEquals(routePathParamNames("/items/:id{[0-9]+}"), ["id"]);
  // A `*` is not a named parameter.
  assertEquals(routePathParamNames("/files/*"), []);
  // The regex constraint body is skipped with BALANCED braces. A lazy `[^}]*` stops
  // at the inner `}` of `{2}` and then reads `:page` out of the leftover text — or,
  // worse, mistakes part of a constraint for a name.
  assertEquals(routePathParamNames("/d/:code{\\d{2}}/:page"), ["code", "page"]);
  // And the body is SKIPPED, not scanned: a `:word` inside a constraint is regex
  // syntax, not a parameter. Without the skip this reports a third parameter that
  // the route does not have.
  assertEquals(routePathParamNames("/x/:a{b:c}/:d"), ["a", "d"]);
});

// --- The duplicate-parameter refusal ------------------------------------------

Deno.test("assertExportableRoutePaths refuses a repeated path parameter", () => {
  const routes = [{
    method: "GET",
    path: "/:id/x/:id",
    handlerName: "h",
    registeredAt: "2026-01-01T00:00:00.000Z",
  }];
  let message = "";
  try {
    assertExportableRoutePaths(routes);
  } catch (err) {
    message = err instanceof Error ? err.message : String(err);
  }
  // The route and the offending parameter are both named, and the message says what
  // to do about it — a diagnostic a user can act on without reading our source.
  assertStringIncludes(message, "GET /:id/x/:id");
  assertStringIncludes(message, '":id"');
  assertStringIncludes(message, "silently discarded");
});

Deno.test("assertExportableRoutePaths accepts distinct parameters, wildcards and constraints", () => {
  assertExportableRoutePaths([
    { method: "GET", path: "/:a/x/:b", handlerName: "h", registeredAt: "t" },
    { method: "GET", path: "/f/*/g/*", handlerName: "h", registeredAt: "t" },
    {
      method: "GET",
      path: "/d/:code{\\d{2}}/:page",
      handlerName: "h",
      registeredAt: "t",
    },
  ]);
});

Deno.test("exportProject refuses a project with a duplicate-parameter route", async () => {
  const db = await Database.create({ driver: "pglite" });
  try {
    const kernel = new Kernel(db, { composition: testStoreComposition() });
    kernel.handlers.register(
      "dup",
      "function dup(req: Request) { return new Response('x'); }",
      () => new Response(),
    );
    kernel.routes.register("GET", "/:id/x/:id", "dup", { summary: "dup" });

    await assertRejects(
      () => exportProject(kernel),
      Error,
      "uses the path parameter",
    );
  } finally {
    await db.close();
  }
});
