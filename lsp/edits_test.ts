import { assertEquals } from "@std/assert";
import { applyTextEdits, identifierAt } from "./edits.ts";
import type { TextEdit } from "./protocol.ts";

// applyTextEdits is the pure "WorkspaceEdit → new source" seam (Stage 7). The bug it
// must not have: applying an earlier edit shifting a later edit's offsets. These pin
// multi-occurrence replacement (the rename shape) and order-independence.

const edit = (
  line: number,
  from: number,
  to: number,
  newText: string,
): TextEdit => ({
  range: { start: { line, character: from }, end: { line, character: to } },
  newText,
});

Deno.test("applyTextEdits replaces every occurrence, longer or shorter", () => {
  const src = "const foo = 1;\nreturn foo + foo;";
  // Rename foo → doubled at all three occurrences.
  const edits = [
    edit(0, 6, 9, "doubled"),
    edit(1, 7, 10, "doubled"),
    edit(1, 13, 16, "doubled"),
  ];
  assertEquals(
    applyTextEdits(src, edits),
    "const doubled = 1;\nreturn doubled + doubled;",
  );
});

Deno.test("applyTextEdits is order-independent (edits sorted internally)", () => {
  const src = "aXbXc";
  const edits = [
    edit(0, 3, 4, "Y"), // second X
    edit(0, 1, 2, "Y"), // first X — supplied out of order
  ];
  assertEquals(applyTextEdits(src, edits), "aYbYc");
});

Deno.test("applyTextEdits with no edits returns the source unchanged", () => {
  assertEquals(applyTextEdits("hello", []), "hello");
});

// identifierAt recovers the OLD name under the cursor — the discriminator between a
// symbol rename and an entity-name rename. Pin cursor-inside, cursor-at-end, and
// cursor-not-on-a-token.

Deno.test("identifierAt reads the token the cursor sits inside", () => {
  const src = "function getUsers(c) {\n  return foo(c);\n}";
  assertEquals(identifierAt(src, { line: 0, character: 12 }), "getUsers");
  assertEquals(identifierAt(src, { line: 1, character: 9 }), "foo");
});

Deno.test("identifierAt catches a cursor resting just past the token", () => {
  const src = "const foo = 1;";
  // Character 9 is the space right after "foo" (chars 6-8) — still targets foo.
  assertEquals(identifierAt(src, { line: 0, character: 9 }), "foo");
});

Deno.test("identifierAt returns empty off a token or past the line", () => {
  const src = "a + b";
  assertEquals(identifierAt(src, { line: 0, character: 2 }), ""); // the '+'
  assertEquals(identifierAt(src, { line: 5, character: 0 }), ""); // no such line
});
