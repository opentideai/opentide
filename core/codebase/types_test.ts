import { assertEquals } from "@std/assert";
import {
  CODEBASE_GRAPH_SCHEMA_VERSION,
  type CodeFile,
  createEmptyCodebaseGraph,
  edgeSemanticId,
  fileSemanticId,
  type HandlerSemantic,
  mergeCodebaseContributions,
  type RouteSemantic,
  routeSemanticId,
  type SemanticContribution,
  type SemanticDiagnostic,
  type SemanticEdge,
  semanticId,
  symbolSemanticId,
  type TestSemantic,
  validateCodebaseGraph,
} from "./index.ts";

const source = {
  pluginId: "generic-tsjs",
  ruleId: "fixture",
  method: "ast" as const,
  inferred: true,
};

Deno.test("codebase graph creates a stable empty shape", () => {
  const graph = createEmptyCodebaseGraph(
    "project-1",
    "/workspace/app",
    "2026-07-03T00:00:00.000Z",
  );

  assertEquals(graph.projectId, "project-1");
  assertEquals(graph.schemaVersion, CODEBASE_GRAPH_SCHEMA_VERSION);
  assertEquals(graph.rootPath, "/workspace/app");
  assertEquals(graph.indexedAt, "2026-07-03T00:00:00.000Z");
  assertEquals(graph.files, []);
  assertEquals(graph.routes, []);
  assertEquals(graph.edges, []);
  assertEquals(graph.diagnostics, []);
});

Deno.test("semantic id helpers normalize common keys", () => {
  assertEquals(semanticId("Route", "GET /Users/:id"), "route:get /users/:id");
  assertEquals(fileSemanticId("./src\\server.ts"), "file:src/server.ts");
  assertEquals(
    symbolSemanticId("src/server.ts", "createUser"),
    "symbol:src/server.ts#createuser",
  );
  assertEquals(
    routeSemanticId("post", "/users/:id"),
    "route:post /users/:id",
  );
  assertEquals(
    edgeSemanticId("routes-to", "route:get /", "handler:list"),
    "edge:routes-to:route:get /->handler:list",
  );
});

Deno.test("mergeCodebaseContributions merges entities by id and keeps provenance", () => {
  const base = createEmptyCodebaseGraph("project-1", "/workspace/app");
  const fileId = fileSemanticId("src/server.ts");
  const routeId = routeSemanticId("GET", "/users/:id");
  const handlerId = semanticId("handler", "listUsers");
  const secondHandlerId = semanticId("handler", "auditUsers");
  const middlewareId = semanticId("middleware", "requireAuth");
  const edgeId = edgeSemanticId("routes-to", routeId, handlerId);

  const lowConfidenceRoute: RouteSemantic = {
    id: routeId,
    kind: "route",
    name: "GET /users/:id",
    method: "GET",
    path: "/users/:id",
    handlerIds: [handlerId],
    middlewareIds: [],
    source,
    confidence: 0.45,
    locations: [{
      file: "src/server.ts",
      startLine: 10,
      startColumn: 1,
    }],
    tags: ["api"],
  };

  const highConfidenceRoute: RouteSemantic = {
    ...lowConfidenceRoute,
    handlerIds: [secondHandlerId],
    middlewareIds: [middlewareId],
    source: { ...source, pluginId: "express" },
    confidence: 0.92,
    locations: [{
      file: "src/routes/users.ts",
      startLine: 4,
      startColumn: 3,
    }],
    framework: "express",
    pathSyntax: "express",
    tags: ["users"],
  };

  const file: CodeFile = {
    id: fileId,
    kind: "file",
    name: "server.ts",
    path: "src/server.ts",
    language: "typescript",
    source,
    confidence: 1,
    locations: [{
      file: "src/server.ts",
      startLine: 1,
      startColumn: 1,
    }],
  };

  const edge: SemanticEdge = {
    id: edgeId,
    type: "routes-to",
    sourceId: routeId,
    targetId: handlerId,
    source: { ...source, pluginId: "express" },
    confidence: 0.92,
  };

  const contributionA: SemanticContribution = {
    pluginId: "generic-tsjs",
    files: [file],
    routes: [lowConfidenceRoute],
  };
  const contributionB: SemanticContribution = {
    pluginId: "express",
    routes: [highConfidenceRoute],
    edges: [edge],
    plugins: [{
      pluginId: "express",
      status: "matched",
      confidence: 0.95,
    }],
  };

  const graph = mergeCodebaseContributions(base, [
    contributionA,
    contributionB,
  ]);

  assertEquals(graph.files.length, 1);
  assertEquals(graph.routes.length, 1);
  assertEquals(graph.routes[0]?.id, routeId);
  assertEquals(graph.routes[0]?.confidence, 0.92);
  assertEquals(graph.routes[0]?.source.pluginId, "express");
  assertEquals(graph.routes[0]?.handlerIds, [secondHandlerId, handlerId]);
  assertEquals(graph.routes[0]?.middlewareIds, [middlewareId]);
  assertEquals(graph.routes[0]?.locations, [
    { file: "src/routes/users.ts", startLine: 4, startColumn: 3 },
    { file: "src/server.ts", startLine: 10, startColumn: 1 },
  ]);
  assertEquals(graph.routes[0]?.tags, ["api", "users"]);
  assertEquals(graph.edges, [edge]);
  assertEquals(graph.plugins.map((p) => p.pluginId), [
    "express",
    "generic-tsjs",
  ]);
});

Deno.test("mergeCodebaseContributions deduplicates diagnostics and round-trips JSON", () => {
  const base = createEmptyCodebaseGraph("project-1", "/workspace/app");
  const diagnostic: SemanticDiagnostic = {
    id: semanticId("diagnostic", "missing-command"),
    severity: "warning",
    message: "No test command was found.",
    source,
    entityIds: ["command:test"],
  };

  const graph = mergeCodebaseContributions(base, [
    {
      pluginId: "generic-tsjs",
      diagnostics: [diagnostic],
    },
    {
      pluginId: "project-local",
      diagnostics: [{
        ...diagnostic,
        message: "No verified test command was found.",
        entityIds: ["command:test", "fact:package-json"],
      }],
    },
  ]);

  assertEquals(graph.diagnostics.length, 1);
  assertEquals(
    graph.diagnostics[0]?.message,
    "No verified test command was found.",
  );
  assertEquals(graph.diagnostics[0]?.entityIds, [
    "command:test",
    "fact:package-json",
  ]);

  const roundTripped = JSON.parse(JSON.stringify(graph));
  assertEquals(roundTripped, graph);
});

Deno.test("validateCodebaseGraph accepts a connected graph", () => {
  const routeId = routeSemanticId("GET", "/users");
  const handlerId = semanticId("handler", "listUsers");
  const graph = createEmptyCodebaseGraph("project-1", "/workspace/app");

  const handler: HandlerSemantic = {
    id: handlerId,
    kind: "handler",
    name: "listUsers",
    language: "typescript",
    abi: {
      id: "express-req-res-next",
      params: [
        { name: "req", role: "request" },
        { name: "res", role: "response" },
      ],
      responseStyle: "res-mutation",
    },
    routeIds: [routeId],
    source,
    confidence: 0.9,
    locations: [{ file: "src/users.ts", startLine: 1, startColumn: 1 }],
  };

  const route: RouteSemantic = {
    id: routeId,
    kind: "route",
    name: "GET /users",
    method: "GET",
    path: "/users",
    handlerIds: [handlerId],
    middlewareIds: [],
    source,
    confidence: 0.9,
    locations: [{ file: "src/users.ts", startLine: 10, startColumn: 1 }],
  };

  const edge: SemanticEdge = {
    id: edgeSemanticId("routes-to", routeId, handlerId),
    type: "routes-to",
    sourceId: routeId,
    targetId: handlerId,
    source,
    confidence: 0.9,
  };

  graph.routes.push(route);
  graph.handlers.push(handler);
  graph.edges.push(edge);

  assertEquals(validateCodebaseGraph(graph), []);
});

Deno.test("validateCodebaseGraph reports broken references and invalid metadata", () => {
  const graph = createEmptyCodebaseGraph("project-1", "/workspace/app");
  const routeId = routeSemanticId("GET", "/broken");
  const testId = semanticId("test", "brokenRoute_test");

  graph.routes.push({
    id: routeId,
    kind: "route",
    name: "GET /broken",
    method: "GET",
    path: "/broken",
    handlerIds: ["handler:missing"],
    middlewareIds: ["middleware:missing"],
    source,
    confidence: 1.2,
    locations: [{ file: "src/broken.ts", startLine: 0, startColumn: 1 }],
  });
  graph.edges.push({
    id: edgeSemanticId("routes-to", routeId, "handler:missing"),
    type: "routes-to",
    sourceId: routeId,
    targetId: "handler:missing",
    source,
    confidence: 0.7,
  });
  const test: TestSemantic = {
    id: testId,
    kind: "test",
    name: "brokenRoute_test",
    language: "typescript",
    file: "src/broken.test.ts",
    targetIds: ["handler:missing"],
    source,
    confidence: 0.8,
    locations: [{ file: "src/broken.test.ts", startLine: 1, startColumn: 1 }],
  };
  graph.tests.push(test);

  assertEquals(validateCodebaseGraph(graph).map((issue) => issue.code), [
    "INVALID_CONFIDENCE",
    "INVALID_LOCATION",
    "BROKEN_EDGE_TARGET",
    "BROKEN_ROUTE_HANDLER",
    "BROKEN_ROUTE_MIDDLEWARE",
    "BROKEN_TEST_TARGET",
  ]);
});
