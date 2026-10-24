// Related-test selection over the neutral CodebaseGraph (project import, Slice 6).
//
// Given something that changed — a source file path (the `key` of a source-backed
// ChangeRecord from Slice 5), or a graph node id (file/module/symbol/route/handler)
// — walk the graph's test nodes + `tested-by` edges to the TestSemantics that
// exercise it, and derive the concrete command to run them from the graph's `test`
// ProjectCommand allow-list.
//
// Pure over the graph and unit-testable in isolation. Selection never invents a
// command string: it only ever returns a ProjectCommand already present in
// `graph.commands`, mirroring the runner's allow-list posture.

import {
  type CodebaseGraph,
  fileSemanticId,
  type ProjectCommand,
  type TestSemantic,
} from "./types.ts";

export interface RelatedTestsSelection {
  // The changed key as supplied (path or node id).
  changed: string;
  // The graph file ids the changed key resolved to (empty ⇒ nothing recognized).
  matchedFileIds: string[];
  // Tests reachable from the changed key via targetIds / tested-by edges (or the
  // changed file itself when it is a test file). Empty ⇒ no related tests.
  tests: TestSemantic[];
  // The command that runs the tests, from graph.commands (commandKind "test"), or
  // null when the project exposes no test command.
  command: ProjectCommand | null;
  // The specific related test files. For v1 the runner executes the FULL suite
  // (see `runsFullSuite`); these let a caller/log show what was narrowed to.
  relatedTestFiles: string[];
  // True when the related tests are a strict subset of all graph tests — i.e. a
  // path-filtered run WOULD narrow the suite (even though v1 runs it whole).
  narrowed: boolean;
}

// The `test` command to run for a project, preferring an exact `test` script over a
// more specific variant (`test:unit`, …). Returns null when none is discovered.
export function pickTestCommand(graph: CodebaseGraph): ProjectCommand | null {
  const tests = graph.commands.filter((c) => c.commandKind === "test");
  if (tests.length === 0) return null;
  return tests.find((c) => c.name === "test") ?? tests[0]!;
}

export function selectRelatedTests(
  graph: CodebaseGraph,
  changed: string,
): RelatedTestsSelection {
  const matchedFileIds = resolveToFileIds(graph, changed);
  const matched = new Set(matchedFileIds);

  // A tested-by edge points from a source file to the test that covers it; index
  // the tests reachable from each matched file id.
  const testsById = new Map(graph.tests.map((test) => [test.id, test]));
  const reachableTestIds = new Set<string>();
  for (const edge of graph.edges) {
    if (edge.type !== "tested-by") continue;
    if (matched.has(edge.sourceId) && testsById.has(edge.targetId)) {
      reachableTestIds.add(edge.targetId);
    }
  }

  const selected: TestSemantic[] = [];
  for (const test of graph.tests) {
    const targetsChanged = test.targetIds.some((id) => matched.has(id));
    const testItselfChanged = matched.has(fileSemanticId(test.file));
    if (targetsChanged || testItselfChanged || reachableTestIds.has(test.id)) {
      selected.push(test);
    }
  }
  selected.sort((a, b) => a.id.localeCompare(b.id));

  const relatedTestFiles = [...new Set(selected.map((t) => t.file))].toSorted();
  return {
    changed,
    matchedFileIds,
    tests: selected,
    command: pickTestCommand(graph),
    relatedTestFiles,
    narrowed: selected.length > 0 && selected.length < graph.tests.length,
  };
}

// Resolve a changed key to the set of graph FILE ids it concerns. Accepts a file
// path (with or without a leading "./"), a file id, a module id, or a symbol /
// route / handler node id — each maps back to the file(s) it lives in, since test
// targetIds and tested-by edges are keyed on file ids.
function resolveToFileIds(graph: CodebaseGraph, changed: string): string[] {
  const ids = new Set<string>();
  const normalizedPath = changed.replace(/^\.\/+/, "");

  // Path key (the natural source-backed ChangeRecord key). Resolve to the file id
  // directly — the file need not still be in the graph (a just-deleted file still
  // has tests that targeted it), and fileSemanticId is deterministic. A non-path
  // node id (handled below) never looks like a path, so this adds no false match.
  if (looksLikePath(normalizedPath)) ids.add(fileSemanticId(normalizedPath));

  // Node-id match: map each entity kind carrying a file back to that file's id.
  for (const file of graph.files) {
    if (file.id === changed) ids.add(file.id);
  }
  for (const module of graph.modules) {
    if (module.id === changed) ids.add(fileSemanticId(module.file));
  }
  for (const symbol of graph.symbols) {
    if (symbol.id === changed) ids.add(fileSemanticId(symbol.file));
  }
  for (const route of graph.routes) {
    if (route.id === changed) addLocationFileIds(route.locations, ids);
  }
  for (const handler of graph.handlers) {
    if (handler.id === changed) addLocationFileIds(handler.locations, ids);
  }

  return [...ids].toSorted();
}

// A changed key is a file path (not a graph node id) when it carries a directory
// separator or a file extension but not a semantic-id kind prefix (`kind:`).
function looksLikePath(value: string): boolean {
  if (/^[a-z]+:/i.test(value)) return false; // e.g. "symbol:…", "route:…"
  return value.includes("/") || /\.[a-z0-9]+$/i.test(value);
}

function addLocationFileIds(
  locations: { file: string }[],
  ids: Set<string>,
): void {
  for (const location of locations) ids.add(fileSemanticId(location.file));
}
