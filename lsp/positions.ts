// @layer lsp — the single, centralized bridge between the two coordinate systems
// in play, isolated here because an off-by-one at this seam is the classic LSP
// bug (docs/lsp-support-plan.md §9). Every ±1 conversion goes through this module
// and nowhere else, so there is exactly one place to reason about (and test).
//
//   LSP wire:        line 0-based, character 0-based   (protocol.ts `Position`)
//   Language service: line 1-based, column   1-based   (core/language-service.ts)
//
// Stage 0 does not yet call the read methods, but the conversions are needed the
// moment Stage 1 translates results — landing + testing them now keeps that seam
// honest from the start.
import type { Position, Range } from "./protocol.ts";

// A 1-based service position. Mirrors the {line,column} the language service
// consumes and emits; kept as a local shape so this module owns both sides.
export interface ServicePosition {
  line: number;
  column: number;
}

export interface ServiceRange {
  start: ServicePosition;
  end: ServicePosition;
}

// LSP (0-based) → service (1-based). Editors never send negative coordinates, but
// clamp at 0 defensively so a malformed client can't produce a 0/negative service
// line the offset math (language-service.ts) would then re-clamp inconsistently.
export function lspToServicePosition(position: Position): ServicePosition {
  return {
    line: Math.max(0, position.line) + 1,
    column: Math.max(0, position.character) + 1,
  };
}

// Service (1-based) → LSP (0-based). The service never emits below 1, so the
// subtraction can't go negative in practice; clamp anyway to keep the inverse
// total.
export function serviceToLspPosition(position: ServicePosition): Position {
  return {
    line: Math.max(1, position.line) - 1,
    character: Math.max(1, position.column) - 1,
  };
}

// LSP (0-based line/character) → a string offset into `source` (Stage 7 rename apply).
// A third representation of the same coordinate, so it lives here with the rest of the
// position math rather than in the edit-apply logic. Walks line-by-line: sums the
// lengths of the lines before `line` (each +1 for the newline the split removed), then
// adds `character`. Clamps into range so a malformed edit can't index out of bounds —
// past-the-end coordinates saturate at source.length, mirroring the defensive clamps
// above. Assumes `\n` line endings, matching the language service's own offset math.
export function positionToOffset(source: string, position: Position): number {
  const line = Math.max(0, position.line);
  const character = Math.max(0, position.character);
  const lines = source.split("\n");
  let offset = 0;
  for (let i = 0; i < line && i < lines.length; i++) {
    offset += lines[i]!.length + 1; // +1 for the "\n" removed by split
  }
  const lineLength = lines[Math.min(line, lines.length - 1)]?.length ?? 0;
  return Math.min(offset + Math.min(character, lineLength), source.length);
}

export function lspToServiceRange(range: Range): ServiceRange {
  return {
    start: lspToServicePosition(range.start),
    end: lspToServicePosition(range.end),
  };
}

export function serviceToLspRange(range: ServiceRange): Range {
  return {
    start: serviceToLspPosition(range.start),
    end: serviceToLspPosition(range.end),
  };
}
