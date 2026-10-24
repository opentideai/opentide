import { assert, assertEquals } from "@std/assert";
import { applyTextEdits, normalizeTextEdit } from "./text-edits.ts";
import type { Result } from "../types.ts";

// Narrow a Result to its error branch. Result<T> is a discriminated union, so a test
// that expects failure has to assert the discriminant before reading `error`.
function failure<T>(result: Result<T>): { code: string; suggestion?: string } {
  assert(!result.ok, "expected the edit to fail");
  return result.error;
}

const CSS = `.header {
  margin: 76px;
  padding: 8px;
}
.footer {
  margin: 76px;
}`;

Deno.test("applyTextEdits replaces a unique match", () => {
  const result = applyTextEdits(CSS, [{
    find: ".header {\n  margin: 76px;",
    replace: ".header {",
  }]);
  assert(result.ok);
  assertEquals(
    result.data,
    `.header {
  padding: 8px;
}
.footer {
  margin: 76px;
}`,
  );
});

// The rule that removes the need for a preview/apply handshake: an edit that could
// hit the wrong occurrence fails instead of guessing.
Deno.test("applyTextEdits refuses an ambiguous match and changes nothing", () => {
  const error = failure(applyTextEdits(CSS, [{
    find: "  margin: 76px;\n",
    replace: "",
  }]));
  assertEquals(error.code, "EDIT_AMBIGUOUS_MATCH");
  // The error must tell the caller how to proceed, both ways.
  assert(error.suggestion?.includes("count: 2"));
});

Deno.test("applyTextEdits honors an explicit count for a genuinely repeated value", () => {
  const result = applyTextEdits(CSS, [{
    find: "  margin: 76px;\n",
    replace: "",
    count: 2,
  }]);
  assert(result.ok);
  assert(!result.data.includes("76px"));
});

Deno.test("applyTextEdits refuses a find that is not present", () => {
  assertEquals(
    failure(applyTextEdits(CSS, [{
      find: "margin: 80px;",
      replace: "margin: 0;",
    }])).code,
    "EDIT_NO_MATCH",
  );
});

Deno.test("applyTextEdits applies edits in order, all-or-nothing", () => {
  const ok = applyTextEdits(CSS, [
    { find: "padding: 8px;", replace: "padding: 12px;" },
    { find: ".footer {", replace: ".site-footer {" },
  ]);
  assert(ok.ok);
  assert(ok.data.includes("padding: 12px;"));
  assert(ok.data.includes(".site-footer {"));

  // A later edit failing aborts the whole batch — no half-applied result escapes.
  assertEquals(
    failure(applyTextEdits(CSS, [
      { find: "padding: 8px;", replace: "padding: 12px;" },
      { find: "does-not-exist", replace: "x" },
    ])).code,
    "EDIT_NO_MATCH",
  );
});

// Each edit's count is checked against the text as it stands after the preceding
// edits, so a batch that rewrites overlapping regions is rejected, not half-applied.
Deno.test("applyTextEdits sees the effect of preceding edits", () => {
  const result = applyTextEdits("a a a", [
    { find: "a a a", replace: "a a" },
    { find: "a", replace: "b", count: 2 },
  ]);
  assert(result.ok);
  assertEquals(result.data, "b b");
});

Deno.test("applyTextEdits rejects an empty batch and a no-op batch", () => {
  assertEquals(failure(applyTextEdits(CSS, [])).code, "EDIT_EMPTY");
  assertEquals(
    failure(
      applyTextEdits(CSS, [{
        find: "padding: 8px;",
        replace: "padding: 8px;",
      }]),
    ).code,
    "EDIT_NO_CHANGE",
  );
});

// `find` is scanned as a plain string, never compiled to a RegExp — the agent's find
// text is arbitrary file content and regex metacharacters are common in CSS and JS.
Deno.test("applyTextEdits treats regex metacharacters literally", () => {
  const src = "const re = /^a.*b$/; // (group) [class] {1,2}";
  const result = applyTextEdits(src, [{
    find: "/^a.*b$/",
    replace: "/^x$/",
  }]);
  assert(result.ok);
  assertEquals(result.data, "const re = /^x$/; // (group) [class] {1,2}");
  // A find that would match as a REGEX but does not literally occur must not match:
  // "c.nst" is a valid pattern for "const", and matching it would mean the agent's
  // find text was being compiled rather than searched.
  assertEquals(
    failure(applyTextEdits(src, [{ find: "c.nst", replace: "z" }])).code,
    "EDIT_NO_MATCH",
  );
});

// Overlapping needles are counted by advancing past each match, not by one char, so
// "aa" in "aaa" is one occurrence — and therefore unambiguous.
Deno.test("applyTextEdits counts overlapping needles without double-counting", () => {
  const result = applyTextEdits("aaa", [{ find: "aa", replace: "b" }]);
  assert(result.ok);
  assertEquals(result.data, "ba");
});

Deno.test("normalizeTextEdit rejects malformed input", () => {
  assertEquals(normalizeTextEdit({ find: "a", replace: "b" }), {
    find: "a",
    replace: "b",
  });
  assertEquals(normalizeTextEdit({ find: "a", replace: "b", count: 3 }), {
    find: "a",
    replace: "b",
    count: 3,
  });
  // An empty find would match everywhere; a missing replace is not a deletion.
  assertEquals(normalizeTextEdit({ find: "", replace: "b" }), null);
  assertEquals(normalizeTextEdit({ find: "a" }), null);
  assertEquals(normalizeTextEdit({ find: "a", replace: 1 }), null);
  assertEquals(normalizeTextEdit({ find: "a", replace: "b", count: 0 }), null);
  assertEquals(
    normalizeTextEdit({ find: "a", replace: "b", count: 1.5 }),
    null,
  );
  assertEquals(normalizeTextEdit(null), null);
  assertEquals(normalizeTextEdit("nope"), null);
  // An empty replace IS valid — that is how you delete.
  assertEquals(normalizeTextEdit({ find: "a", replace: "" }), {
    find: "a",
    replace: "",
  });
});
