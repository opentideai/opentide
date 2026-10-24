import { assert, assertEquals } from "@std/assert";
import type { MergedDiagnostic } from "../core/diagnostics.ts";
import type {
  CompletionItem as ServiceCompletionItem,
  DefinitionResult,
  HighlightRange,
  HoverResult,
  ReferenceResult,
  RenameLocation,
} from "../core/language-service.ts";
import {
  CompletionItemKind,
  DiagnosticSeverity,
  DocumentHighlightKind,
  MarkupKind,
} from "./protocol.ts";
import {
  toCompletionItems,
  toDefinitionLocations,
  toDiagnostics,
  toDocumentHighlights,
  toHover,
  toReferenceLocations,
  toWorkspaceEdit,
} from "./translate.ts";

// The through-line of every assertion below: the service speaks 1-based line/column
// and a string kind vocabulary; the LSP wire speaks 0-based positions and numeric
// enums. Each translator must apply the -1 and the enum map, and nothing else.

Deno.test("toCompletionItems maps kind strings to LSP numeric kinds", () => {
  const items: ServiceCompletionItem[] = [
    { label: "json", kind: "method", detail: "(data) => Response" },
    { label: "MAX", kind: "constant", documentation: "the max", sortText: "0" },
    { label: "weird", kind: "not-a-real-kind" },
  ];
  const out = toCompletionItems(items);
  assertEquals(out[0]!.kind, CompletionItemKind.Method);
  assertEquals(out[0]!.detail, "(data) => Response");
  assertEquals(out[1]!.kind, CompletionItemKind.Constant);
  assertEquals(out[1]!.documentation, "the max");
  assertEquals(out[1]!.sortText, "0");
  // Unknown kinds fall back to Text rather than leaking the raw string.
  assertEquals(out[2]!.kind, CompletionItemKind.Text);
  // Absent optionals stay absent (no detail/documentation/sortText keys).
  assert(!("detail" in out[2]!));
});

Deno.test("toHover renders a markdown code block and converts the range", () => {
  const result: HoverResult = {
    text: "const db: Database",
    documentation: "the app database",
    range: { startLine: 3, startColumn: 5, endLine: 3, endColumn: 7 },
  };
  const hover = toHover(result);
  assertEquals(hover.contents.kind, MarkupKind.Markdown);
  assert(hover.contents.value.includes("```typescript"));
  assert(hover.contents.value.includes("const db: Database"));
  assert(hover.contents.value.includes("the app database"));
  // 1-based service range (3,5)-(3,7) → 0-based LSP (2,4)-(2,6).
  assertEquals(hover.range, {
    start: { line: 2, character: 4 },
    end: { line: 2, character: 6 },
  });
});

Deno.test("toHover omits the range when the service supplies none", () => {
  const hover = toHover({ text: "any" });
  assert(hover.range === undefined);
});

Deno.test("toDefinitionLocations builds opentide:// URIs with point ranges", () => {
  const defs: DefinitionResult[] = [
    { entityType: "function", entityName: "formatUser", line: 1, column: 10 },
  ];
  const locations = toDefinitionLocations(defs, "typescript");
  assertEquals(
    locations[0]!.uri,
    "opentide://typescript/functions/formatUser.ts",
  );
  // A definition is a point: start === end, at the 0-based converted position.
  assertEquals(locations[0]!.range, {
    start: { line: 0, character: 9 },
    end: { line: 0, character: 9 },
  });
});

Deno.test("toReferenceLocations builds URIs with full spans", () => {
  const refs: ReferenceResult[] = [
    {
      entityType: "handler",
      entityName: "getUsers",
      line: 2,
      column: 3,
      endLine: 2,
      endColumn: 11,
      lineText: "  getUsers()",
    },
  ];
  const locations = toReferenceLocations(refs, "typescript");
  assertEquals(locations[0]!.uri, "opentide://typescript/handlers/getUsers.ts");
  assertEquals(locations[0]!.range, {
    start: { line: 1, character: 2 },
    end: { line: 1, character: 10 },
  });
});

Deno.test("toDocumentHighlights maps read/write/text kinds", () => {
  const ranges: HighlightRange[] = [
    { from: { line: 1, column: 1 }, to: { line: 1, column: 5 }, kind: "write" },
    { from: { line: 2, column: 1 }, to: { line: 2, column: 5 }, kind: "read" },
    { from: { line: 3, column: 1 }, to: { line: 3, column: 5 }, kind: "text" },
  ];
  const out = toDocumentHighlights(ranges);
  assertEquals(out[0]!.kind, DocumentHighlightKind.Write);
  assertEquals(out[1]!.kind, DocumentHighlightKind.Read);
  assertEquals(out[2]!.kind, DocumentHighlightKind.Text);
  assertEquals(out[0]!.range, {
    start: { line: 0, character: 0 },
    end: { line: 0, character: 4 },
  });
});

Deno.test("toDiagnostics maps severities, keeps code, reads each entry's source", () => {
  const entries: MergedDiagnostic[] = [
    {
      line: 4,
      column: 2,
      endLine: 4,
      endColumn: 8,
      message: "Cannot find name 'foo'.",
      severity: "error",
      code: 2304,
      source: "tsc",
    },
    { line: 1, column: 1, message: "unused", severity: "hint", source: "tsc" },
  ];
  const out = toDiagnostics(entries);
  assertEquals(out[0]!.severity, DiagnosticSeverity.Error);
  assertEquals(out[0]!.source, "tsc");
  assertEquals(out[0]!.code, 2304);
  assertEquals(out[0]!.range, {
    start: { line: 3, character: 1 },
    end: { line: 3, character: 7 },
  });
  // No end ⇒ point range at the start; hint → Hint severity.
  assertEquals(out[1]!.severity, DiagnosticSeverity.Hint);
  assertEquals(out[1]!.range, {
    start: { line: 0, character: 0 },
    end: { line: 0, character: 0 },
  });
  assert(out[1]!.code === undefined);
});

// Stage 2: a single stream carries entries from different engines, each stamped
// with its own source and a code that may be a TS number or a QC rule string.
Deno.test("toDiagnostics namespaces tsc and qc entries individually", () => {
  const out = toDiagnostics([
    {
      line: 1,
      column: 1,
      message: "Cannot find name.",
      severity: "error",
      code: 2304,
      source: "tsc",
    },
    {
      line: 3,
      column: 1,
      message: "no console.log",
      severity: "warning",
      code: "no-console",
      source: "qc",
    },
  ]);
  assertEquals(out[0]!.source, "tsc");
  assertEquals(out[0]!.code, 2304);
  assertEquals(out[1]!.source, "qc");
  assertEquals(out[1]!.code, "no-console");
  assertEquals(out[1]!.severity, DiagnosticSeverity.Warning);
});

// Stage 7: the (already cross-entity) RenameLocation[] folds into ONE WorkspaceEdit
// keyed by each entity's opentide:// URI, every span becoming a TextEdit with newText =
// newName, and every coordinate carried down to 0-based through the same spanRange path.
Deno.test("toWorkspaceEdit groups cross-entity spans by URI with 0-based ranges", () => {
  const locations: RenameLocation[] = [
    // The definition, in the function's own file.
    {
      entityType: "function",
      entityName: "calcTax",
      line: 1,
      column: 10,
      endLine: 1,
      endColumn: 17,
    },
    // A reference in a handler.
    {
      entityType: "handler",
      entityName: "checkout",
      line: 4,
      column: 3,
      endLine: 4,
      endColumn: 10,
    },
    // A second reference in the SAME handler → same URI, two edits.
    {
      entityType: "handler",
      entityName: "checkout",
      line: 6,
      column: 8,
      endLine: 6,
      endColumn: 15,
    },
  ];
  const edit = toWorkspaceEdit(locations, "computeTax", "typescript");
  const fnUri = "opentide://typescript/functions/calcTax.ts";
  const handlerUri = "opentide://typescript/handlers/checkout.ts";
  assertEquals(Object.keys(edit.changes).sort(), [handlerUri, fnUri].sort());
  // The function file: one edit, 0-based range (service 1-based → LSP 0-based).
  assertEquals(edit.changes[fnUri], [
    {
      range: {
        start: { line: 0, character: 9 },
        end: { line: 0, character: 16 },
      },
      newText: "computeTax",
    },
  ]);
  // The handler file: both references, each replaced with the new name.
  assertEquals(edit.changes[handlerUri]!.length, 2);
  assertEquals(edit.changes[handlerUri]![0]!.newText, "computeTax");
  assertEquals(edit.changes[handlerUri]![1]!.range, {
    start: { line: 5, character: 7 },
    end: { line: 5, character: 14 },
  });
});
