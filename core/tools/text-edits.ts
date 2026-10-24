// @layer core — pure exact-match text editing for registry entities. Extracted from
// dispatch so the matching semantics are unit-testable without a kernel, and so the
// one rule that makes this verb safe lives in one place.
//
// The rule: every `find` must occur EXACTLY the expected number of times. Zero matches
// means the agent's model of the file is wrong; more than expected means the edit is
// ambiguous and would silently hit the wrong occurrence. Both fail closed, before any
// mutation. That is what removes the need for a preview/apply handshake — a
// unique-match edit cannot land somewhere the caller did not mean.
import type { Result } from "../types.ts";

export interface TextEdit {
  find: string;
  replace: string;
  // Expected occurrences of `find`. Defaults to 1 — the safe case. Set it explicitly
  // to rewrite a value that genuinely repeats (e.g. a colour used in three rules).
  count?: number;
}

// Normalize one raw tool-input edit. Returns null for anything malformed, so the
// caller can reject the whole batch rather than silently dropping an edit.
export function normalizeTextEdit(value: unknown): TextEdit | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.find !== "string" || raw.find.length === 0) return null;
  if (typeof raw.replace !== "string") return null;
  const count = raw.count;
  if (count !== undefined) {
    if (typeof count !== "number" || !Number.isInteger(count) || count < 1) {
      return null;
    }
  }
  return {
    find: raw.find,
    replace: raw.replace,
    ...(typeof count === "number" ? { count } : {}),
  };
}

function occurrences(haystack: string, needle: string): number {
  let n = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return n;
    n++;
    // Advance past the match so overlapping needles are not double-counted the way
    // a naive `at + 1` would.
    from = at + needle.length;
  }
}

// Replace the first `count` occurrences of `find`. Plain string scanning, never a
// RegExp: the agent's `find` is arbitrary file content, and regex-escaping it would be
// one more thing to get wrong.
function replaceAll(source: string, edit: TextEdit, times: number): string {
  let out = "";
  let from = 0;
  for (let i = 0; i < times; i++) {
    const at = source.indexOf(edit.find, from);
    if (at === -1) break;
    out += source.slice(from, at) + edit.replace;
    from = at + edit.find.length;
  }
  return out + source.slice(from);
}

// Apply every edit in order, all-or-nothing. An edit's expected count is checked
// against the text as it stands AFTER the preceding edits, so a batch that rewrites
// overlapping regions is rejected rather than half-applied.
export function applyTextEdits(
  source: string,
  edits: readonly TextEdit[],
): Result<string> {
  if (edits.length === 0) {
    return {
      ok: false,
      error: {
        code: "EDIT_EMPTY",
        message: "No edits were supplied.",
        suggestion: "Pass at least one { find, replace } edit.",
      },
    };
  }
  let text = source;
  for (const edit of edits) {
    const expected = edit.count ?? 1;
    const found = occurrences(text, edit.find);
    if (found === 0) {
      return {
        ok: false,
        error: {
          code: "EDIT_NO_MATCH",
          message: `The text to replace was not found: ${
            JSON.stringify(edit.find)
          }.`,
          suggestion:
            "Read the current content first and copy the exact text, including " +
            "whitespace and indentation.",
        },
      };
    }
    if (found !== expected) {
      return {
        ok: false,
        error: {
          code: "EDIT_AMBIGUOUS_MATCH",
          message: `Expected ${expected} occurrence(s) of ${
            JSON.stringify(edit.find)
          } but found ${found}.`,
          suggestion: expected === 1
            ? `Include more surrounding text so the match is unique, or pass count: ${found} to replace every occurrence.`
            : `Pass count: ${found}, or narrow the text to match.`,
        },
      };
    }
    text = replaceAll(text, edit, expected);
  }
  if (text === source) {
    return {
      ok: false,
      error: {
        code: "EDIT_NO_CHANGE",
        message: "The edits produced no change to the content.",
        suggestion: "Check that `replace` differs from `find`.",
      },
    };
  }
  return { ok: true, data: text };
}
