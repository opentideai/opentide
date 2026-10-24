import { assertEquals, assertThrows } from "@std/assert";
import {
  type CodeFile,
  createDefaultSemanticsPluginRegistry,
  createGenericTsJsPlugin,
  type DetectionResult,
  edgeSemanticId,
  fileSemanticId,
  GENERIC_TSJS_PLUGIN_ID,
  HONO_PLUGIN_ID,
  indexCodebaseWithPlugins,
  type RouteSemantic,
  routeSemanticId,
  type SemanticEdge,
  semanticId,
  type SemanticsPlugin,
  SemanticsPluginRegistry,
} from "./index.ts";

const source = (pluginId: string) => ({
  pluginId,
  method: "ast" as const,
  inferred: true,
});

const capabilities = {
  detect: true,
  index: true,
  mutate: false,
  commands: false,
  generatedTypes: false,
  auditGuidance: false,
  preview: false,
};

function detection(
  confidence: number,
  suggestedPriority = 0,
): DetectionResult {
  return {
    matched: true,
    confidence,
    suggestedPriority,
    evidence: [{ kind: "source-pattern", description: "test fixture" }],
  };
}

function fakePlugin(
  id: string,
  result: DetectionResult,
  routePath?: string,
): SemanticsPlugin {
  return {
    manifest: {
      id,
      label: id,
      version: "0.0.0-test",
      languages: ["typescript", "javascript"],
      detects: [id],
      capabilities,
    },
    detect() {
      return result;
    },
    index() {
      const fileId = fileSemanticId(`src/${id}.ts`);
      const file: CodeFile = {
        id: fileId,
        kind: "file",
        name: `${id}.ts`,
        path: `src/${id}.ts`,
        language: "typescript",
        source: source(id),
        confidence: result.confidence,
        locations: [{ file: `src/${id}.ts`, startLine: 1, startColumn: 1 }],
      };

      const routes: RouteSemantic[] = [];
      const edges: SemanticEdge[] = [];
      if (routePath) {
        const routeId = routeSemanticId("GET", routePath);
        const handlerId = semanticId("handler", `${id}Handler`);
        routes.push({
          id: routeId,
          kind: "route",
          name: `GET ${routePath}`,
          method: "GET",
          path: routePath,
          handlerIds: [handlerId],
          middlewareIds: [],
          source: source(id),
          confidence: result.confidence,
          locations: [{
            file: `src/${id}.ts`,
            startLine: 2,
            startColumn: 1,
          }],
        });
        edges.push({
          id: edgeSemanticId("defines", fileId, routeId),
          type: "defines",
          sourceId: fileId,
          targetId: routeId,
          source: source(id),
          confidence: result.confidence,
        });
      }

      return {
        pluginId: id,
        files: [file],
        routes,
        edges,
      };
    },
  };
}

Deno.test("default semantics plugin registry includes generic TS/JS + Hono plugins", () => {
  const registry = createDefaultSemanticsPluginRegistry();

  assertEquals(registry.list().map((p) => p.id), [
    GENERIC_TSJS_PLUGIN_ID,
    HONO_PLUGIN_ID,
  ]);
  assertEquals(
    registry.get(GENERIC_TSJS_PLUGIN_ID)?.manifest.label,
    "Generic TS/JS",
  );
});

Deno.test("semantics plugin registry requires explicit replacement", () => {
  const registry = new SemanticsPluginRegistry();
  const original = fakePlugin("same", detection(0.4), "/original");
  const replacement = fakePlugin("same", detection(0.8), "/replacement");

  registry.register(original);
  assertThrows(
    () => registry.register(replacement),
    Error,
    'Semantics plugin "same" is already registered',
  );

  registry.replace(replacement);
  assertEquals(registry.get("same"), replacement);
});

Deno.test("indexCodebaseWithPlugins runs matched plugins in deterministic priority order", async () => {
  const registry = new SemanticsPluginRegistry();
  registry.register(createGenericTsJsPlugin());
  registry.register(fakePlugin("low", detection(0.2), "/low"));
  registry.register(fakePlugin("high", detection(0.9), "/high"));
  registry.register(fakePlugin("priority", detection(0.5, 10), "/priority"));

  const graph = await indexCodebaseWithPlugins(
    registry,
    { projectId: "p1", rootPath: "/repo" },
    { indexedAt: "2026-07-03T00:00:00.000Z" },
  );

  assertEquals(graph.projectId, "p1");
  assertEquals(graph.files.map((f) => f.path), [
    "src/high.ts",
    "src/low.ts",
    "src/priority.ts",
  ]);
  assertEquals(graph.routes.map((r) => r.path), [
    "/high",
    "/low",
    "/priority",
  ]);
  assertEquals(graph.plugins.map((p) => p.pluginId), [
    GENERIC_TSJS_PLUGIN_ID,
    "high",
    "low",
    "priority",
  ]);
});

Deno.test("indexCodebaseWithPlugins records skipped and disabled plugins", async () => {
  const registry = new SemanticsPluginRegistry();
  registry.register(createGenericTsJsPlugin());
  registry.register(fakePlugin("skipped", {
    matched: false,
    confidence: 0.1,
    evidence: [],
  }));
  registry.register(fakePlugin("disabled", detection(1), "/disabled"));

  const graph = await indexCodebaseWithPlugins(
    registry,
    { projectId: "p1", rootPath: "/repo" },
    { disabledPluginIds: ["disabled"] },
  );

  assertEquals(graph.files, []);
  assertEquals(graph.plugins.map((p) => [p.pluginId, p.status]), [
    [GENERIC_TSJS_PLUGIN_ID, "completed"],
    ["skipped", "skipped"],
  ]);
});

Deno.test("indexCodebaseWithPlugins reports unknown enabled plugin ids", async () => {
  const registry = new SemanticsPluginRegistry();
  registry.register(createGenericTsJsPlugin());

  const graph = await indexCodebaseWithPlugins(
    registry,
    { projectId: "p1", rootPath: "/repo" },
    { enabledPluginIds: [GENERIC_TSJS_PLUGIN_ID, "missing"] },
  );

  assertEquals(graph.diagnostics.map((d) => d.message), [
    'Enabled semantics plugin "missing" is not registered.',
  ]);
  assertEquals(graph.plugins.map((p) => [p.pluginId, p.status]), [
    [GENERIC_TSJS_PLUGIN_ID, "completed"],
    ["missing", "error"],
  ]);
});

Deno.test("indexCodebaseWithPlugins converts plugin errors into diagnostics", async () => {
  const registry = new SemanticsPluginRegistry();
  registry.register({
    manifest: {
      id: "broken",
      label: "Broken",
      version: "0.0.0-test",
      languages: ["typescript"],
      detects: ["broken"],
      capabilities,
    },
    detect() {
      return detection(1);
    },
    index() {
      throw new Error("boom");
    },
  });

  const graph = await indexCodebaseWithPlugins(
    registry,
    { projectId: "p1", rootPath: "/repo" },
  );

  assertEquals(graph.diagnostics.length, 1);
  assertEquals(graph.diagnostics[0]?.severity, "error");
  assertEquals(
    graph.diagnostics[0]?.message,
    'Semantics plugin "broken" failed during index: boom',
  );
  assertEquals(graph.plugins[0]?.status, "error");
  assertEquals(graph.plugins[0]?.diagnostics?.length, 1);
});
