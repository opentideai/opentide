// @layer lsp — the pure, side-effect-free translation seam between the language
// service's result shapes (entity-addressed, 1-based line/column) and the LSP wire
// shapes (URI-addressed, 0-based positions). This is the "only real work" of Stage
// 1 (docs/lsp-support-plan.md Stage 1): every function here takes a service result
// and returns an LSP shape, routing EVERY coordinate through positions.ts and every
// entity reference through entityUri (lsp/uri.ts). No kernel, no I/O, no state —
// which is exactly why it is unit-testable in isolation (plan §10).
import type { MergedDiagnostic } from "../core/diagnostics.ts";
import type {
  CompletionItem as ServiceCompletionItem,
  DefinitionResult,
  DiagnosticEntry,
  HighlightRange,
  HoverResult,
  ReferenceResult,
  RenameLocation,
} from "../core/language-service.ts";
import {
  type CompletionItem,
  CompletionItemKind,
  type Diagnostic,
  DiagnosticSeverity,
  type DocumentHighlight,
  DocumentHighlightKind,
  type Hover,
  type Location,
  MarkupKind,
  type Range,
  type TextEdit,
  type WorkspaceEdit,
} from "./protocol.ts";
import { serviceToLspPosition } from "./positions.ts";
import { entityUri } from "./uri.ts";

// --- kind / severity maps (the service's string vocabulary → LSP's numeric one) ---

// Service completion kinds are the values of COMPLETION_KIND_MAP in
// language-service.ts; map each to the nearest LSP CompletionItemKind. Unknown
// kinds fall back to Text — cosmetic (drives the icon), never load-bearing.
const COMPLETION_KIND_TO_LSP: Record<string, number> = {
  function: CompletionItemKind.Function,
  method: CompletionItemKind.Method,
  property: CompletionItemKind.Property,
  variable: CompletionItemKind.Variable,
  constant: CompletionItemKind.Constant,
  parameter: CompletionItemKind.Variable,
  type: CompletionItemKind.TypeParameter,
  interface: CompletionItemKind.Interface,
  class: CompletionItemKind.Class,
  keyword: CompletionItemKind.Keyword,
  text: CompletionItemKind.Text,
  module: CompletionItemKind.Module,
  enum: CompletionItemKind.Enum,
  enumMember: CompletionItemKind.EnumMember,
};

const DIAGNOSTIC_SEVERITY_TO_LSP: Record<DiagnosticEntry["severity"], number> =
  {
    error: DiagnosticSeverity.Error,
    warning: DiagnosticSeverity.Warning,
    info: DiagnosticSeverity.Information,
    hint: DiagnosticSeverity.Hint,
  };

const HIGHLIGHT_KIND_TO_LSP: Record<HighlightRange["kind"], number> = {
  text: DocumentHighlightKind.Text,
  read: DocumentHighlightKind.Read,
  write: DocumentHighlightKind.Write,
};

// --- range helpers ---

// A degenerate (empty) range at a single 1-based service point — used for a
// definition target, which the service reports as a point, not a span. LSP requires
// a range on every Location, so start === end places the cursor without selecting.
function pointRange(line: number, column: number): Range {
  const position = serviceToLspPosition({ line, column });
  return { start: position, end: position };
}

// A full 1-based service span → 0-based LSP range.
function spanRange(
  startLine: number,
  startColumn: number,
  endLine: number,
  endColumn: number,
): Range {
  return {
    start: serviceToLspPosition({ line: startLine, column: startColumn }),
    end: serviceToLspPosition({ line: endLine, column: endColumn }),
  };
}

// --- translators (one per read feature) ---

export function toCompletionItems(
  items: ServiceCompletionItem[],
): CompletionItem[] {
  return items.map((item) => ({
    label: item.label,
    kind: COMPLETION_KIND_TO_LSP[item.kind] ?? CompletionItemKind.Text,
    ...(item.detail ? { detail: item.detail } : {}),
    ...(item.documentation ? { documentation: item.documentation } : {}),
    ...(item.sortText ? { sortText: item.sortText } : {}),
  }));
}

export function toHover(result: HoverResult): Hover {
  // Render the type signature as a fenced TS block; append the doc text below it.
  // Markdown is safe here — the service already produced display strings.
  const parts = ["```typescript", result.text, "```"];
  if (result.documentation) parts.push("", result.documentation);
  const hover: Hover = {
    contents: { kind: MarkupKind.Markdown, value: parts.join("\n") },
  };
  if (result.range) {
    hover.range = spanRange(
      result.range.startLine,
      result.range.startColumn,
      result.range.endLine,
      result.range.endColumn,
    );
  }
  return hover;
}

// Each entity-addressed definition becomes a Location whose URI is the target
// entity's `opentide://` URI (which may differ from the requesting document — go-to-def
// jumps across entities). runtimeId comes from the requesting document's ref.
export function toDefinitionLocations(
  results: DefinitionResult[],
  runtimeId: string,
): Location[] {
  return results.map((r) => ({
    uri: entityUri({
      runtimeId,
      entityType: r.entityType,
      entityName: r.entityName,
    }),
    range: pointRange(r.line, r.column),
  }));
}

export function toReferenceLocations(
  results: ReferenceResult[],
  runtimeId: string,
): Location[] {
  return results.map((r) => ({
    uri: entityUri({
      runtimeId,
      entityType: r.entityType,
      entityName: r.entityName,
    }),
    range: spanRange(r.line, r.column, r.endLine, r.endColumn),
  }));
}

// Highlights are always within the requesting document, so they carry a range +
// kind but no URI (per the LSP DocumentHighlight shape).
export function toDocumentHighlights(
  ranges: HighlightRange[],
): DocumentHighlight[] {
  return ranges.map((r) => ({
    range: spanRange(r.from.line, r.from.column, r.to.line, r.to.column),
    kind: HIGHLIGHT_KIND_TO_LSP[r.kind] ?? DocumentHighlightKind.Text,
  }));
}

// Stage 7 rename: fold the (already cross-entity) RenameLocation[] into one
// WorkspaceEdit. Each location is a span in some entity's virtual file; group them by
// that entity's `opentide://` URI and emit a TextEdit per span, all replacing the span with
// `newName`. This is the SINGLE source of truth for both sides of the rename — the wire
// result the client applies to its buffers AND (via applyTextEdits) the new source the
// server persists — so client and registry can't diverge. runtimeId comes from the
// requesting document's ref (a rename stays within one runtime). Coordinates route
// through spanRange like every other translator, so the ±1 lives only in positions.ts.
export function toWorkspaceEdit(
  locations: RenameLocation[],
  newName: string,
  runtimeId: string,
): WorkspaceEdit {
  const changes: { [uri: string]: TextEdit[] } = {};
  for (const loc of locations) {
    const uri = entityUri({
      runtimeId,
      entityType: loc.entityType,
      entityName: loc.entityName,
    });
    const edit: TextEdit = {
      range: spanRange(loc.line, loc.column, loc.endLine, loc.endColumn),
      newText: newName,
    };
    (changes[uri] ??= []).push(edit);
  }
  return { changes };
}

// Merged diagnostics carry their OWN `source` label (Stage 2: "tsc" | "qc" |
// "verify"), so each entry is namespaced individually rather than the whole stream
// stamped one source — the win is a QC violation squiggling next to a TS error in
// the same publish. An entry with no end falls back to a point range at its start.
export function toDiagnostics(entries: MergedDiagnostic[]): Diagnostic[] {
  return entries.map((d) => {
    const range = d.endLine !== undefined
      ? spanRange(d.line, d.column, d.endLine, d.endColumn ?? d.column)
      : pointRange(d.line, d.column);
    const diagnostic: Diagnostic = {
      range,
      severity: DIAGNOSTIC_SEVERITY_TO_LSP[d.severity],
      source: d.source,
      message: d.message,
    };
    if (d.code !== undefined) diagnostic.code = d.code;
    return diagnostic;
  });
}
