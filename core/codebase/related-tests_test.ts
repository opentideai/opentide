import { assertEquals } from "@std/assert";
import {
  type CodebaseGraph,
  createEmptyCodebaseGraph,
  edgeSemanticId,
  fileSemanticId,
  type ProjectCommand,
  semanticId,
  symbolSemanticId,
  type TestSemantic,
} from "./types.ts";
import { pickTestCommand, selectRelatedTests } from "./related-tests.ts";

function testNode(file: string, targets: string[]): TestSemantic {
  return {
    id: semanticId("test", file),
    kind: "test",
    name: file.split("/").at(-1) ?? file,
    language: "typescript",
    file,
    targetIds: targets,
    source: { pluginId: "generic-tsjs", method: "ast", inferred: false },
    confidence: 0.9,
    locations: [{ file, startLine: 1, startColumn: 1 }],
  };
}

function testCommand(): ProjectCommand {
  return {
    id: "command:test:test",
    kind: "command",
    name: "test",
    commandKind: "test",
    command: "npm run test",
    packageManager: "npm",
    source: { pluginId: "generic-tsjs", method: "manifest", inferred: false },
    confidence: 0.95,
    locations: [{ file: "package.json", startLine: 1, startColumn: 1 }],
  };
}

// A tiny fixture: math.ts is tested by math_test.ts (targets file:src/math.ts +
// a tested-by edge); util.ts has its own test; lonely.ts has none.
function fixtureGraph(): CodebaseGraph {
  const graph = createEmptyCodebaseGraph("p1", "/tmp/p1");
  const mathTest = testNode("src/math_test.ts", [
    fileSemanticId("src/math.ts"),
  ]);
  const utilTest = testNode("src/util_test.ts", [
    fileSemanticId("src/util.ts"),
  ]);
  graph.tests.push(mathTest, utilTest);
  graph.edges.push({
    id: edgeSemanticId("tested-by", fileSemanticId("src/math.ts"), mathTest.id),
    type: "tested-by",
    sourceId: fileSemanticId("src/math.ts"),
    targetId: mathTest.id,
    source: { pluginId: "generic-tsjs", method: "ast", inferred: true },
    confidence: 0.7,
  });
  // A symbol in math.ts so we can resolve by symbol id too.
  graph.symbols.push({
    id: symbolSemanticId("src/math.ts", "add"),
    kind: "symbol",
    symbolKind: "function",
    name: "add",
    file: "src/math.ts",
    exported: true,
    source: { pluginId: "generic-tsjs", method: "ast", inferred: false },
    confidence: 0.95,
    locations: [{ file: "src/math.ts", startLine: 1, startColumn: 1 }],
  });
  graph.commands.push(testCommand());
  return graph;
}

Deno.test("selectRelatedTests: a changed source file → its tests via targets/edges", () => {
  const graph = fixtureGraph();
  const selection = selectRelatedTests(graph, "src/math.ts");
  assertEquals(selection.tests.map((t) => t.file), ["src/math_test.ts"]);
  assertEquals(selection.relatedTestFiles, ["src/math_test.ts"]);
  assertEquals(selection.command?.command, "npm run test");
  // 1 of 2 tests ⇒ a path-filtered run would narrow the suite.
  assertEquals(selection.narrowed, true);
});

Deno.test("selectRelatedTests: resolves a symbol id back to its file's tests", () => {
  const graph = fixtureGraph();
  const selection = selectRelatedTests(
    graph,
    symbolSemanticId("src/math.ts", "add"),
  );
  assertEquals(selection.tests.map((t) => t.file), ["src/math_test.ts"]);
});

Deno.test("selectRelatedTests: a leading ./ on the path still resolves", () => {
  const graph = fixtureGraph();
  const selection = selectRelatedTests(graph, "./src/util.ts");
  assertEquals(selection.tests.map((t) => t.file), ["src/util_test.ts"]);
});

Deno.test("selectRelatedTests: changing a test file selects that test itself", () => {
  const graph = fixtureGraph();
  const selection = selectRelatedTests(graph, "src/math_test.ts");
  assertEquals(selection.tests.map((t) => t.file), ["src/math_test.ts"]);
});

Deno.test("selectRelatedTests: an unrelated file yields no tests", () => {
  const graph = fixtureGraph();
  const selection = selectRelatedTests(graph, "src/lonely.ts");
  assertEquals(selection.tests, []);
  assertEquals(selection.relatedTestFiles, []);
  assertEquals(selection.narrowed, false);
});

Deno.test("pickTestCommand: prefers the exact `test` script over a variant", () => {
  const graph = createEmptyCodebaseGraph("p1", "/tmp/p1");
  const variant: ProjectCommand = {
    ...testCommand(),
    id: "command:test:test:unit",
    name: "test:unit",
  };
  graph.commands.push(variant, testCommand());
  assertEquals(pickTestCommand(graph)?.name, "test");
});
