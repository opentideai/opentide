import { assertEquals } from "@std/assert";
import {
  lspToServicePosition,
  lspToServiceRange,
  positionToOffset,
  serviceToLspPosition,
  serviceToLspRange,
} from "./positions.ts";

// The whole point of this module is that the ±1 lives in exactly one place; these
// tests pin the boundary (the origin) and the round-trip, the two things an
// off-by-one would break (docs/lsp-support-plan.md §9).

Deno.test("origin maps 0-based LSP (0,0) ⇄ 1-based service (1,1)", () => {
  assertEquals(lspToServicePosition({ line: 0, character: 0 }), {
    line: 1,
    column: 1,
  });
  assertEquals(serviceToLspPosition({ line: 1, column: 1 }), {
    line: 0,
    character: 0,
  });
});

Deno.test("position conversion round-trips both directions", () => {
  for (let line = 0; line < 50; line++) {
    for (let character = 0; character < 50; character++) {
      const lsp = { line, character };
      assertEquals(serviceToLspPosition(lspToServicePosition(lsp)), lsp);
    }
  }
  for (let line = 1; line <= 50; line++) {
    for (let column = 1; column <= 50; column++) {
      const service = { line, column };
      assertEquals(
        lspToServicePosition(serviceToLspPosition(service)),
        service,
      );
    }
  }
});

Deno.test("negative LSP coordinates clamp to the service origin", () => {
  assertEquals(lspToServicePosition({ line: -5, character: -3 }), {
    line: 1,
    column: 1,
  });
});

// Stage 7: positionToOffset is the third coordinate view (0-based line/char → string
// offset) the rename apply relies on. Pin the origin, the newline accounting, and the
// end-of-content clamp — the ways an offset bug would corrupt a spliced edit.
Deno.test("positionToOffset: origin is offset 0", () => {
  assertEquals(positionToOffset("abc\ndef", { line: 0, character: 0 }), 0);
});

Deno.test("positionToOffset accounts for the newline between lines", () => {
  const src = "abc\ndef\nghi";
  // line 1 starts after "abc\n" = 4; char 2 on line 1 = 'f' at offset 6.
  assertEquals(positionToOffset(src, { line: 1, character: 0 }), 4);
  assertEquals(positionToOffset(src, { line: 1, character: 2 }), 6);
  assertEquals(positionToOffset(src, { line: 2, character: 0 }), 8);
});

Deno.test("positionToOffset clamps a past-the-end position to source.length", () => {
  const src = "abc\ndef";
  assertEquals(positionToOffset(src, { line: 99, character: 99 }), src.length);
  // A character past the line end clamps to the line end, not into the next line.
  assertEquals(positionToOffset(src, { line: 0, character: 99 }), 3);
});

Deno.test("range conversion applies to both endpoints", () => {
  const lspRange = {
    start: { line: 2, character: 4 },
    end: { line: 6, character: 0 },
  };
  const serviceRange = lspToServiceRange(lspRange);
  assertEquals(serviceRange, {
    start: { line: 3, column: 5 },
    end: { line: 7, column: 1 },
  });
  assertEquals(serviceToLspRange(serviceRange), lspRange);
});
