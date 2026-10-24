// @layer core — the unified diagnostics merge (docs/lsp-support-plan.md Stage 2).
// One place composes the three diagnostics sources OpenTide can produce for an
// entity — the TypeScript compiler, the QC engine, and the verification layer —
// into a single namespaced stream. It lives in core (not lsp/) on purpose: both
// consumers share this exact code path — the LSP push (lsp/server.ts) and the
// REST projection (core/control-server.ts) — so the "QC-in-the-editor" win lands
// in the in-house Genie IDE too, even if no external editor ever ships (plan §8).
//
// It adds ZERO intelligence: TS diagnostics come from the runtime seam
// (kernel.runtime.getDiagnostics — multi-runtime honesty, plan §9), QC from
// runQC (core/qc.ts), and verification from an injected composition seam
// (kernel.composition.verificationDiagnostics) so core never imports verification.
// Each source is tagged; nothing here decides what a diagnostic means.
import {
  LSP_DIAGNOSTIC_SOURCE_QC,
  LSP_DIAGNOSTIC_SOURCE_TS,
  LSP_DIAGNOSTIC_SOURCE_VERIFY,
  QC_DIAGNOSTIC_DEFAULT_COLUMN,
  QC_DIAGNOSTIC_DEFAULT_LINE,
} from "./config.ts";
import type { DiagnosticEntry } from "./language-service.ts";
import { type QCIssue, type QCKind, runQC } from "./qc.ts";
import type { Kernel } from "./registries.ts";

// The three namespaces a merged diagnostic can carry. The `source` field is the
// contract clients (external editors, the Genie IDE) filter the streams on.
export type DiagnosticSource =
  | typeof LSP_DIAGNOSTIC_SOURCE_TS
  | typeof LSP_DIAGNOSTIC_SOURCE_QC
  | typeof LSP_DIAGNOSTIC_SOURCE_VERIFY;

// A diagnostic in the merged stream: the DiagnosticEntry fields plus its own
// `source` namespace and a `code` widened to string (QC rule names) as well as
// number (TS error codes). Every entry knows which engine produced it, so the
// translator (lsp/translate.ts) reads the source per-entry instead of stamping one.
export interface MergedDiagnostic extends Omit<DiagnosticEntry, "code"> {
  source: DiagnosticSource;
  code?: number | string;
}

// Only entity types the QC engine understands get a QC pass. The language entities
// are handler/function/test; QC's kinds are handler/function/template/css/js/… —
// so handler and function map directly and everything else (test) is skipped.
const QC_KIND_BY_ENTITY_TYPE: Record<string, QCKind> = {
  handler: "handler",
  function: "function",
};

// Translate QC issues into merged diagnostics. Pure and exported on its own so the
// write path (Stage 3) can reuse it verbatim: when the define_* upsert returns
// QC_FAILED, its issues become publishDiagnostics on the saved buffer — the QC gate
// becomes the linter. Severity passes through (QCIssue.level ⊂ DiagnosticEntry
// severity); the rule name becomes the `code`; a missing line anchors at the gutter.
export function qcIssuesToDiagnostics(issues: QCIssue[]): MergedDiagnostic[] {
  return issues.map((issue) => ({
    line: issue.line ?? QC_DIAGNOSTIC_DEFAULT_LINE,
    column: QC_DIAGNOSTIC_DEFAULT_COLUMN,
    message: issue.message,
    severity: issue.level,
    source: LSP_DIAGNOSTIC_SOURCE_QC,
    code: issue.rule,
  }));
}

// The registered source of an entity, used when no live buffer override is passed
// (the caller saved, or is linting the persisted entity). Only the QC-eligible
// entity types are resolvable; anything else returns undefined and QC is skipped.
function registeredSource(
  kernel: Kernel,
  entityType: string,
  entityName: string,
): string | undefined {
  switch (entityType) {
    case "handler":
      return kernel.handlers.get(entityName)?.source;
    case "function":
      return kernel.functions.getEntry(entityName)?.source;
    default:
      return undefined;
  }
}

async function tscDiagnostics(
  kernel: Kernel,
  entityType: string,
  entityName: string,
  content?: string,
): Promise<MergedDiagnostic[]> {
  const entries = await kernel.runtime.getDiagnostics?.(
    entityType,
    entityName,
    kernel,
    content,
  ) ?? [];
  return entries.map((entry) => ({
    ...entry,
    source: LSP_DIAGNOSTIC_SOURCE_TS,
  }));
}

async function qcDiagnostics(
  kernel: Kernel,
  entityType: string,
  entityName: string,
  content?: string,
): Promise<MergedDiagnostic[]> {
  const kind = QC_KIND_BY_ENTITY_TYPE[entityType];
  if (!kind) return [];
  const source = content ?? registeredSource(kernel, entityType, entityName);
  if (source === undefined) return [];
  const result = await runQC(source, kind);
  return qcIssuesToDiagnostics(result.issues);
}

async function verificationDiagnostics(
  kernel: Kernel,
  entityType: string,
  entityName: string,
  content?: string,
): Promise<MergedDiagnostic[]> {
  const provider = kernel.composition.verificationDiagnostics;
  if (!provider) return [];
  const entries = await provider(kernel, entityType, entityName, content);
  return entries.map((entry) => ({
    ...entry,
    source: LSP_DIAGNOSTIC_SOURCE_VERIFY,
  }));
}

// Merge the compiler, QC, and verification diagnostics for one entity into a single
// namespaced stream. Mirrors the runtime seam's signature (entityType, entityName,
// optional live-buffer content) so it drops into every existing call site. The three
// sources run concurrently; a source that has nothing to say contributes an empty
// slice (a runtime without getDiagnostics, a non-QC entity type, an absent
// verification provider), so the result is always the union of whatever is available.
export async function getMergedDiagnostics(
  kernel: Kernel,
  entityType: string,
  entityName: string,
  content?: string,
): Promise<MergedDiagnostic[]> {
  const [tsc, qc, verify] = await Promise.all([
    tscDiagnostics(kernel, entityType, entityName, content),
    qcDiagnostics(kernel, entityType, entityName, content),
    verificationDiagnostics(kernel, entityType, entityName, content),
  ]);
  return [...tsc, ...qc, ...verify];
}
