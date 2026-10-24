// @layer lsp — the pure text-application side of Stage 7 rename (docs/lsp-support-plan.md
// Stage 7). translate.ts turns the language service's RenameLocation[] into a
// WorkspaceEdit (entity → 0-based TextEdit[]); this module turns a document's TextEdit[]
// back into the new SOURCE the server persists atomically through the tool layer.
// Applying the very same WorkspaceEdit the client receives is what guarantees the
// server-side registry and the client's buffers converge to identical text. No kernel,
// no I/O, no LSP transport — pure functions over strings, unit-tested in isolation.
import type { Position, TextEdit } from "./protocol.ts";
import { positionToOffset } from "./positions.ts";

// Apply a document's TextEdits to its source, returning the rewritten text. Edits are
// resolved to string offsets (positions.ts owns the coordinate math) and spliced in
// DESCENDING start order so an earlier edit never shifts the offsets of a later one —
// the standard LSP apply rule for a non-overlapping edit set (a rename produces exactly
// that: one same-length identifier replaced at each disjoint occurrence). The input is
// not mutated. A stable sort on equal starts keeps input order, which for the rename
// case is irrelevant (disjoint spans) but keeps the function total.
export function applyTextEdits(source: string, edits: TextEdit[]): string {
  const resolved = edits
    .map((edit) => ({
      start: positionToOffset(source, edit.range.start),
      end: positionToOffset(source, edit.range.end),
      newText: edit.newText,
    }))
    .sort((a, b) => b.start - a.start);
  let result = source;
  for (const edit of resolved) {
    result = result.slice(0, edit.start) + edit.newText +
      result.slice(edit.end);
  }
  return result;
}

// The set of characters that make up an identifier token. TypeScript identifiers are
// [A-Za-z0-9_$]; the entity/symbol names OpenTide renames are a subset. Used only to
// recover the OLD name under the cursor, which discriminates a symbol rename from an
// entity-name rename (server.ts) — it never validates a name.
const IDENTIFIER_CHAR = /[A-Za-z0-9_$]/;

// The identifier token the cursor sits in/at, or "" if the position isn't on one.
// Expands left and right from the 0-based position over identifier characters. LSP
// clients place the rename cursor anywhere within the token (or just past its end), so
// we probe both the character at the cursor and the one before it. Pure lookup over the
// source — the actual rename spans come from the language service, not from here.
export function identifierAt(source: string, position: Position): string {
  const lines = source.split("\n");
  const line = lines[position.line];
  if (line === undefined) return "";
  const clampedChar = Math.max(0, Math.min(position.character, line.length));
  // Find a starting index that is inside the token: the cursor char, else the one to its
  // left (a cursor resting immediately after the token still targets it).
  let index = clampedChar;
  if (!(IDENTIFIER_CHAR.test(line[index] ?? ""))) index = clampedChar - 1;
  if (index < 0 || !IDENTIFIER_CHAR.test(line[index] ?? "")) return "";
  let start = index;
  while (start > 0 && IDENTIFIER_CHAR.test(line[start - 1]!)) start--;
  let end = index;
  while (end < line.length - 1 && IDENTIFIER_CHAR.test(line[end + 1]!)) end++;
  return line.slice(start, end + 1);
}
