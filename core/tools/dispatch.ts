import {
  PROJECT_STATE_DIR_NAME,
  projectManifestPath,
} from "../project-layout.ts";
import { dirname, join, normalize, relative, resolve, sep } from "node:path";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import type { Kernel } from "../registries.ts";
import { isSafePathSegment } from "../registries.ts";
import { runtimeDependencyNote } from "../runtime-dependencies.ts";
import type {
  CompileDeps,
  DevToolArgDef,
  DevToolFn,
  DevViewFn,
  FunctionEntry,
  HandlerEntry,
  HandlerFn,
  Result,
  RouteSchema,
  TestFn,
  TestVerificationMetadata,
} from "../types.ts";
import type {
  ChangeAction,
  ChangeContext,
  ChangeRecord,
} from "../changelog.ts";
// Changeset/verification vocabulary is sourced from types.ts (core), not
// changesets.ts (verification), so this core module stays layer-clean (§3.2).
import { ChangesetActiveError } from "../types.ts";
import type {
  AttestationKind,
  ChangeClass,
  Changeset,
  ChangesetPlan,
  ChangesetPlanAmendment,
  FormalSpec,
  FormalSpecEnforcement,
  FormalSpecTechnique,
  VerificationCheck,
  VerificationCheckKind,
  VerificationClaim,
  VerificationClaimPriority,
  VerificationClaimResult,
  VerificationClaimSource,
  VerificationEvidence,
  VerificationStatus,
  VerificationTier,
} from "../types.ts";
// The verification/agent-owned tool handlers (audits, changeset governance,
// import classification) are called through the composition-registered
// capability registry instead of imported upward (§3.3, tool-capabilities.ts).
import { changeScope, isTierExempt, mutationToolTier } from "./change-tiers.ts";
import {
  maybePeriodicBackup,
  maybePeriodicCheckpoint,
} from "../backup-cadence.ts";
import {
  applyTextEdits,
  normalizeTextEdit,
  type TextEdit,
} from "./text-edits.ts";
import { verificationTools } from "../tool-capabilities.ts";
import {
  currentFingerprints,
  fingerprintProject,
  fingerprintScope,
  PROJECT_SCOPE,
  resolveScopeSource,
} from "../fingerprint.ts";
import { createTimestampedId } from "../ids.ts";
import {
  formatKernelTimeoutMs,
  getKernelSettings,
  MCP_SURFACE_VERSION,
  TOOL_ERROR_STALE_WRITE,
} from "../config.ts";
import { projectGuide } from "../agent-guide.ts";
import {
  changesetOrphanReason,
  describeOrphan,
  type OrphanReason,
} from "../session-liveness.ts";
import { generateAgentMd, generateReadme } from "../export.ts";
import {
  exportDataFixture,
  importDataFixture,
  resetDataTables,
} from "../data-fixtures.ts";
import { kernelInspectAPI } from "../dev-views.ts";
import {
  decodeBase64,
  encodeBase64,
  errorMessage,
  escapeRegex,
} from "../util.ts";
import { validateSchemaConventions } from "../db.ts";
import {
  checkDependants,
  type EntitySource,
  formatDepWarnings,
  formatIssues,
  type QCKind,
  runQC,
  verifyFormalSpecMarker,
} from "../qc.ts";
import {
  browserStatus,
  screenshotApp,
  testApp,
  type TestStep,
} from "../browser.ts";
import { getSharedLanguageService } from "../language-service.ts";
import { findDeadCode, findFunctionCallers } from "../analysis.ts";
import { isEditableTextAssetMime } from "../assets.ts";
import { blastRadiusReport, buildKnowledgeGraph } from "../knowledge-graph.ts";
import { computeCoverage } from "../coverage.ts";
import { auditComplexity } from "../audit-complexity.ts";
import type {
  AssetEntry,
  AuditCategory,
  CustomAuditEntry,
  MigrationEntry,
  MigrationProvenance,
  TypeEntry,
  TypeFieldDef,
} from "../types.ts";
import { BUILTIN_AUDIT_CATEGORIES } from "../types.ts";
import { getDoc, listTopics } from "../docs/index.ts";
import {
  formatPinnedMessagesContext,
  formatProjectContext,
  formatSessionContext,
  getPinnedMessageInfos,
  getProjectSummary,
  getSessionContext,
  listProjectMentionTargets,
  liveCounts,
  persistedCounts,
  readPersistedState,
  resolveProject,
} from "../project-context.ts";
import { normalizeSummaryKind, summarizeSession } from "../session-summary.ts";
import { doctorProject } from "../project-doctor.ts";
import { checkProjectAwareReadiness } from "../project-readiness.ts";
import {
  checkExportTypes,
  DEFAULT_BUILD_OPTIONS,
  type ExportTypeCheckResult,
  getVersion,
  writeExportFiles,
} from "../build.ts";
import type { RuntimeScriptResult } from "../runtime.ts";
import {
  DUPLICATE_BLOCK_THRESHOLD,
  findSimilarEntities,
  functionEntity,
  handlerEntity,
  type SimilarEntity,
} from "../semantic-duplicates.ts";
import {
  getProjectPaths,
  PROJECT_MODE_SOURCE_BACKED,
  readProjectMode,
} from "../project-manager.ts";
import type {
  DocumentMetadata,
  DocumentRecord,
  DocumentRef,
  DocumentScope,
  DocumentStore,
  ListDocumentsFilter,
} from "../documents.ts";
import {
  ATTACHMENT_DOCUMENT_SOURCE,
  EVIDENCE_DOCUMENT_KIND,
  EVIDENCE_DOCUMENT_SOURCE,
  RUN_EVIDENCE_DOCUMENT_KIND,
  RUN_EVIDENCE_DOCUMENT_SOURCE,
} from "../documents.ts";
import {
  asSourceFileSnapshot,
  buildImportClassifierRequest,
  canRestoreSourceSnapshot,
  type CodebaseGraphSummary,
  indexSourceBackedCodebase,
  summarizeCodebaseGraph,
  writeSourceSnapshot,
} from "../codebase/index.ts";
import {
  commitProjectTextFile,
  type ProjectTextFileRequest,
  stageProjectTextFile,
} from "../project-files.ts";
import { saveBranchSnapshots, saveKernelState } from "../persistence.ts";
import {
  rewindForAbandon,
  takeChangesetSnapshot,
} from "../changeset-snapshots.ts";
import {
  gitAddTideGitignore,
  gitCommit,
  gitInit,
  GitProjectError,
  gitPush,
  gitSetRemote,
  gitStatus,
} from "../git.ts";
import { resolveGitCommitMessage } from "../git-message.ts";
import {
  commitLandedChangeset,
  commitManagedPaths,
} from "../landing-commit.ts";
import {
  type AssetSnapshot,
  assetSnapshot,
  assetSnapshotBytes,
  assetSnapshotRestorable,
} from "./asset-snapshot.ts";
import {
  entitiesInModule,
  isModuleMoveCategory,
  moveEntityToModule,
  recordModuleMove,
} from "./module-move.ts";
import { reservedNameError, reservedNamesReport } from "../reserved-names.ts";
import { discardTaskFork, listTasks, startTask } from "../tasks/fork.ts";
import { mergeTask } from "../tasks/task-merge.ts";
import {
  captureChangesetPlanDocument,
  captureScreenshotEvidenceDocument,
} from "../document-capture.ts";
import {
  buildChangedScopeContext,
  buildClaimContext,
  buildProjectContext,
  changedScopesOf,
} from "../code-context.ts";
import { requestReview, type ReviewKind, submitReview } from "../reviews.ts";

export interface ToolResult {
  ok: boolean;
  data?: unknown;
  error?: { code: string; message: string; suggestion?: string };
  _images?: Array<{ png: Uint8Array }>;
  _changesetEvent?: string;
  _changeset?: unknown;
}

export interface TestRunItemResult {
  name: string;
  passed: boolean;
  error?: string;
  errorName?: string;
  durationMs: number;
  ranAt: string;
}

export interface TestRunSummary {
  passed: number;
  failed: number;
  total: number;
  results: TestRunItemResult[];
  summary: string;
  message?: string;
}

export type ExportTypeCheckToolData = ExportTypeCheckResult & {
  summary: string;
};

export type TestRunProgressEvent =
  | { type: "cleared"; names: string[] }
  | { type: "started"; name: string }
  | { type: "result"; result: TestRunItemResult }
  | (TestRunSummary & { type: "summary" })
  | { type: "error"; code?: string; message: string };

// Optimistic-concurrency guard shared by define_handler/define_function
// (docs/lsp-support-plan.md Stage 5). Returns a STALE_WRITE ToolResult when the
// caller supplied an `expectedRevision` that no longer matches the entity's current
// revision (a concurrent write landed in between); null otherwise — including when
// no expectedRevision was supplied, preserving last-writer-wins for existing callers.
function checkExpectedRevision(
  input: Record<string, unknown>,
  currentRevision: number | undefined,
  label: string,
): ToolResult | null {
  const expected = input.expectedRevision;
  if (typeof expected !== "number") return null;
  const current = currentRevision ?? 0;
  if (current === expected) return null;
  return {
    ok: false,
    data: { expectedRevision: expected, currentRevision: current },
    error: {
      code: TOOL_ERROR_STALE_WRITE,
      message: `${label} "${input.name}" was modified since you opened it ` +
        `(expected revision ${expected}, current ${current}). Reload the latest ` +
        `version before saving.`,
      suggestion:
        "Reload the entity to pick up the newer version, then re-apply your change.",
    },
  };
}

function testsMatchingPattern(
  kernel: Kernel,
  pattern?: string,
): ReturnType<Kernel["tests"]["list"]> {
  let tests = kernel.tests.list();

  if (pattern) {
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(
      /\*/g,
      ".*",
    ).replace(/\?/g, ".");
    const regex = new RegExp("^" + escaped + "$");
    tests = tests.filter((t) => regex.test(t.name));
  }

  return tests;
}

export async function runKernelTests(
  kernel: Kernel,
  pattern?: string,
  onProgress?: (event: TestRunProgressEvent) => void,
  signal?: AbortSignal,
): Promise<ToolResult & { data?: TestRunSummary }> {
  let tests: ReturnType<Kernel["tests"]["list"]>;
  try {
    tests = testsMatchingPattern(kernel, pattern);
  } catch {
    return {
      ok: false,
      error: {
        code: "INVALID_PATTERN",
        message: `Invalid test pattern: "${pattern}"`,
      },
    };
  }

  if (tests.length === 0) {
    const message = pattern
      ? `No tests matching "${pattern}".`
      : "No tests registered.";
    return {
      ok: true,
      data: {
        passed: 0,
        failed: 0,
        total: 0,
        results: [],
        summary: message,
        message,
      },
    };
  }

  const clearedNames = tests.map((test) => test.name);
  for (const test of tests) {
    kernel.tests.clearResult(test.name);
  }
  onProgress?.({ type: "cleared", names: clearedNames });

  const results: TestRunItemResult[] = [];
  let passed = 0;
  let failed = 0;

  const abortError = () => {
    const err = new Error("Test run cancelled");
    err.name = "AbortError";
    return err;
  };
  const throwIfAborted = () => {
    if (signal?.aborted) throw abortError();
  };

  const ranAt = new Date().toISOString();
  const testTimeoutMs = getKernelSettings().testTimeoutMs;
  for (const test of tests) {
    throwIfAborted();
    onProgress?.({ type: "started", name: test.name });
    throwIfAborted();
    const start = performance.now();
    let testTimerId: ReturnType<typeof setTimeout>;
    let abortHandler: (() => void) | undefined;
    try {
      const abort = new Promise<never>((_, reject) => {
        if (!signal) return;
        if (signal.aborted) {
          reject(abortError());
          return;
        }
        abortHandler = () => reject(abortError());
        signal.addEventListener("abort", abortHandler, { once: true });
      });
      await Promise.race([
        test.fn(),
        new Promise<never>((_, reject) => {
          testTimerId = setTimeout(
            () =>
              reject(
                new Error(
                  `Test timed out after ${
                    formatKernelTimeoutMs(testTimeoutMs)
                  }`,
                ),
              ),
            testTimeoutMs,
          );
        }),
        abort,
      ]);
      clearTimeout(testTimerId!);
      if (signal && abortHandler) {
        signal.removeEventListener("abort", abortHandler);
      }
      passed++;
      const durationMs = Math.round(performance.now() - start);
      const result = { name: test.name, passed: true, durationMs, ranAt };
      results.push(result);
      kernel.tests.updateResult(test.name, {
        passed: true,
        durationMs,
        ranAt,
      });
      onProgress?.({ type: "result", result });
    } catch (err) {
      clearTimeout(testTimerId!);
      if (signal && abortHandler) {
        signal.removeEventListener("abort", abortHandler);
      }
      if (err instanceof Error && err.name === "AbortError") {
        throw err;
      }
      failed++;
      const durationMs = Math.round(performance.now() - start);
      const error = errorMessage(err);
      const errorName = err instanceof Error ? err.name : undefined;
      const result = {
        name: test.name,
        passed: false,
        error,
        ...(errorName ? { errorName } : {}),
        durationMs,
        ranAt,
      };
      results.push(result);
      kernel.tests.updateResult(test.name, {
        passed: false,
        error,
        ...(errorName ? { errorName } : {}),
        durationMs,
        ranAt,
      });
      onProgress?.({ type: "result", result });
    }
  }

  const summary = `${passed}/${tests.length} passed` +
    (failed > 0 ? `, ${failed} failed` : "");
  kernel.log.log("info", "system", `Tests: ${summary}`);

  return {
    ok: true,
    data: { passed, failed, total: tests.length, results, summary },
  };
}

export async function runExportTypeCheck(
  kernel: Kernel,
): Promise<ToolResult & { data?: ExportTypeCheckToolData }> {
  const projectDir = kernel.projectDir;
  if (!projectDir) {
    return {
      ok: false,
      error: {
        code: "NO_PROJECT",
        message: "No project directory available.",
      },
    };
  }

  try {
    const result = await checkExportTypes(kernel, projectDir);
    const summary = result.ok
      ? "Export type check passed."
      : result.issues.length === 1
      ? "Export type check found 1 issue."
      : `Export type check found ${result.issues.length} issues.`;
    return { ok: true, data: { ...result, summary } };
  } catch (err) {
    return {
      ok: false,
      error: {
        code: "EXPORT_TYPE_CHECK_FAILED",
        message: errorMessage(err),
        suggestion:
          "Inspect the export/type-check setup and retry. This indicates the validation tool itself could not complete.",
      },
    };
  }
}

async function holderSessionName(
  kernel: Kernel,
  holder: Changeset,
): Promise<string | null> {
  if (!holder.sessionId) return null;
  const session = await kernel.sessions.getSession(holder.sessionId)
    .catch(() => null);
  return session?.name ?? null;
}

// Why the project's holder has no writer any more, or null while it still has
// one (core/session-liveness.ts).
function orphanReason(
  kernel: Kernel,
  holder: Changeset,
): Promise<OrphanReason | null> {
  return changesetOrphanReason(holder, kernel.sessions, kernel.liveSessions);
}

// What a second writer is told: whose changeset holds the project, for how
// long, and how to free it. An orphaned one can be taken over.
async function changesetActiveResult(
  kernel: Kernel,
  holder: Changeset,
): Promise<ToolResult> {
  const sessionName = await holderSessionName(kernel, holder);
  const orphan = await orphanReason(kernel, holder);
  const minutes = Math.max(
    0,
    Math.round((Date.now() - Date.parse(holder.createdAt)) / 60_000),
  );
  const held = `This project has one writer at a time. Changeset ` +
    `"${holder.id}" ("${holder.title}") is ${holder.status} in ` +
    `another session${sessionName ? ` ("${sessionName}")` : ""}, ` +
    `opened ${minutes} min ago.`;
  if (orphan) {
    return {
      ok: false,
      error: {
        code: "CHANGESET_ACTIVE",
        message: `${held} Nobody is driving it: ${describeOrphan(orphan)}.`,
        suggestion: `adopt_changeset({changeset_id: "${holder.id}"}) to ` +
          "continue it in this session (its plan and step statuses come " +
          "with it), or abandon_changeset to rewind it and start over. Ask " +
          "the user which, unless they already said.",
      },
    };
  }
  return {
    ok: false,
    error: {
      code: "CHANGESET_ACTIVE",
      message: held,
      suggestion: "Wait for it to complete, or have a person abandon it: " +
        `the IDE inspector's Abandon, or POST /api/changesets/${holder.id}/abandon. ` +
        "Abandoning rewinds its code, schema and files where it can; app rows stay.",
    },
  };
}

const ACTIVE_CHANGESET_STATUSES: ReadonlySet<string> = new Set([
  "planning",
  "approved",
  "in_progress",
]);

// adopt_changeset: move a changeset whose client is gone to the calling
// session. Only an orphaned one moves; a live owner keeps its work.
async function adoptChangeset(
  kernel: Kernel,
  requestedId: string | undefined,
  context: ChangeContext | undefined,
): Promise<ToolResult> {
  const sessionId = context?.sessionId;
  if (!sessionId) {
    return {
      ok: false,
      error: {
        code: "NO_SESSION",
        message: "adopt_changeset needs a session to move the changeset to.",
      },
    };
  }
  const target = requestedId
    ? await kernel.changesets.get(requestedId)
    : await kernel.changesets.getActive();
  if (!target) {
    return {
      ok: false,
      error: {
        code: requestedId ? "CHANGESET_NOT_FOUND" : "NO_ACTIVE_CHANGESET",
        message: requestedId
          ? `Changeset "${requestedId}" not found.`
          : "No changeset is open in this project.",
        suggestion: "create_changeset to start one.",
      },
    };
  }
  if (!ACTIVE_CHANGESET_STATUSES.has(target.status)) {
    return {
      ok: false,
      error: {
        code: "CHANGESET_NOT_ACTIVE",
        message: `Changeset "${target.id}" is ${target.status}; only an ` +
          "open one can be adopted.",
      },
    };
  }
  if (target.sessionId === sessionId) {
    return { ok: true, data: adoptedView(target, "already_yours") };
  }
  const own = await kernel.changesets.getActive(sessionId);
  if (own) {
    return {
      ok: false,
      error: {
        code: "CHANGESET_ACTIVE",
        message: `This session already has changeset "${own.id}" open.`,
        suggestion: "Complete or abandon it first.",
      },
    };
  }
  const reason = await orphanReason(kernel, target);
  if (!reason) {
    return {
      ok: false,
      error: {
        code: "CHANGESET_HELD",
        message: `Changeset "${target.id}" belongs to a session that is ` +
          "still connected; it can't be adopted.",
        suggestion: "Wait for it to complete, or have a person abandon it.",
      },
    };
  }
  const adopted = await kernel.changesets.reassignSession(target.id, sessionId);
  if (!adopted) {
    return {
      ok: false,
      error: {
        code: "CHANGESET_NOT_FOUND",
        message: `Changeset "${target.id}" disappeared while adopting it.`,
      },
    };
  }
  return {
    ok: true,
    data: adoptedView(adopted, reason),
    _changesetEvent: "changeset_updated",
    _changeset: adopted,
  };
}

function adoptedView(cs: Changeset, from: OrphanReason | "already_yours") {
  return {
    id: cs.id,
    title: cs.title,
    status: cs.status,
    adoptedBecause: from,
    plan: cs.plan,
    next: "Continue from the first step that isn't done. The previous " +
      "client's changes are already in the project; check them with " +
      "list_handlers / list_routes / run_tests before building on them.",
  };
}

// Mints a kernel attestation on the active changeset. Best-effort: attestation
// is proof-of-execution, so a minting failure must never break the verifier
// that produced the result. Returns the new attestation id, or null when there
// is no in-progress changeset to attach it to.
// The attestation id goes back in the result so the caller can cite it from
// record_verification_run.
function withAttestationId<T extends object>(
  data: T,
  attestationId: string | null,
): Result<T & { attestationId?: string }> {
  return {
    ok: true,
    data: { ...data, ...(attestationId ? { attestationId } : {}) },
  };
}

async function mintAttestation(
  kernel: Kernel,
  context: ChangeContext | null,
  att: {
    kind: AttestationKind;
    status: VerificationStatus;
    fingerprint: string;
    scope: string;
    summary: string;
    checkId?: string;
    producer?: "client";
    reviewer?: string;
  },
  explicitChangesetId?: string,
): Promise<string | null> {
  try {
    let changesetId = explicitChangesetId ?? context?.changesetId;
    if (!changesetId) {
      const active = await kernel.changesets.getActive(context?.sessionId);
      if (active?.status === "in_progress") changesetId = active.id;
    }
    if (!changesetId) return null;
    const id = createTimestampedId("att");
    await kernel.changesets.recordAttestation(changesetId, {
      ...att,
      id,
      ...(context?.toolCallId ? { toolCallId: context.toolCallId } : {}),
      ...(context?.turnId ? { turnId: context.turnId } : {}),
      ...(context?.principalId ? { principalId: context.principalId } : {}),
    });
    // Slice C-minimal (plan §8, §11): persist the just-minted attestation as a durable,
    // versioned evidence document + a single ledger/evidence ref citing the head. This is
    // the direct core-side analog of Slice B's chat-loop seam — DocumentStore is reachable
    // as kernel.documents, no ChangesetStore contract change, out of agent/brain.ts. Wrapped
    // in its OWN try/catch (inside the outer best-effort guard) so a provenance-persistence
    // failure can NEVER change mintAttestation's return value: the attestation is already
    // recorded on the changeset and remains authoritative; the doc + ref are purely additive.
    try {
      const captured = await captureAttestationEvidenceDocument(
        kernel.documents,
        { ...att, id },
        context?.sessionId,
      );
      if (!captured.ok) {
        kernel.log.log(
          "debug",
          "system",
          `Attestation "${id}" not captured as an evidence document: ` +
            `${captured.error.code} (${captured.error.message})`,
        );
      }
    } catch (err) {
      kernel.log.log(
        "warn",
        "system",
        `Capturing attestation "${id}" evidence failed: ${errorMessage(err)}`,
      );
    }
    return id;
  } catch (err) {
    kernel.log.log(
      "warn",
      "system",
      `Attestation minting failed: ${errorMessage(err)}`,
    );
    return null;
  }
}

// The attestation shape mintAttestation mints, plus its assigned id. Shared by the
// capture helper and its renderer so the two never drift.
type MintedAttestation = {
  id: string;
  kind: AttestationKind;
  status: VerificationStatus;
  fingerprint: string;
  scope: string;
  summary: string;
  checkId?: string;
};

// Render a minted attestation as a compact markdown evidence snapshot. These bytes ARE
// what the ledger/evidence ref cites — a durable, human-readable record of the unit
// (kind/status/scope/fingerprint/summary) that flowed through the mintAttestation choke
// point, beside the authoritative ledger row.
function renderAttestationEvidenceDocument(att: MintedAttestation): string {
  const lines = [
    `# Attestation ${att.id}`,
    "",
    `- **Kind:** ${att.kind}`,
    `- **Status:** ${att.status}`,
    `- **Scope:** ${att.scope}`,
    `- **Fingerprint:** ${att.fingerprint}`,
  ];
  if (att.checkId) lines.push(`- **Check:** ${att.checkId}`);
  lines.push("", "## Summary", "", att.summary);
  return `${lines.join("\n")}\n`;
}

// Capture a minted kernel attestation as a versioned agent document + a single
// ledger/evidence ref citing the head (plan §8, Slice C-minimal). ADDITIVE provenance:
// the _genie_verification_ledger row (and the attestation embedded in the changeset plan
// jsonb) stays authoritative; this is a durable, versioned, byte-exact pointer beside it.
// Mirrors Slice B's captureChangesetPlanDocument shape-for-shape: the doc is found by its
// ORIGIN — metadata.source=EVIDENCE_DOCUMENT_SOURCE + sourceId=<attestation id> — NOT via
// the ledger/evidence ref, so a retried/duplicate mint of the SAME id rediscovers and
// reuses the same doc instead of minting a second, and a lost ref self-heals on the next
// capture (recordUniqueRef re-points the single ref at the head atomically). Attestations
// are append-only and never re-minted under one id, so in practice this is create-once;
// routing through findBySource + recordUniqueRef keeps a duplicate mint a clean no-op
// rather than a second doc or a duplicate ref. Best-effort: returns the store Result
// (never throws for the store's own errors — PROJECT_REQUIRED with no project loaded is a
// Result, not a throw) so the caller degrades a provenance-write failure to a debug log.
// Exported for direct capture tests (mirrors Slice B's captureChangesetPlanDocument).
export async function captureAttestationEvidenceDocument(
  store: DocumentStore,
  att: MintedAttestation,
  sessionId: string | undefined,
): Promise<Result<DocumentRef>> {
  const content = renderAttestationEvidenceDocument(att);

  const existing = await store.findBySource(EVIDENCE_DOCUMENT_SOURCE, att.id, {
    sessionId,
  });

  let doc: DocumentRecord;
  if (existing) {
    const updated = await store.update(existing.id, {
      content,
      createdBy: "agent",
    });
    if (!updated.ok) return updated;
    doc = updated.data;
  } else {
    const created = await store.create({
      name: `Attestation: ${att.kind} (${att.status})`,
      kind: EVIDENCE_DOCUMENT_KIND,
      content,
      scope: "session",
      sessionId,
      createdBy: "agent",
      metadata: {
        source: EVIDENCE_DOCUMENT_SOURCE,
        sourceId: att.id,
        title: `Attestation ${att.id}`,
      },
    });
    if (!created.ok) return created;
    doc = created.data;
  }

  return await store.recordUniqueRef({
    documentId: doc.id,
    refType: "ledger",
    refId: att.id,
    role: "evidence",
    versionHash: doc.currentVersionHash,
    sessionId,
  });
}

// The stable, composite origin key for one record_verification_run EVIDENCE ITEM
// (Slice C-rich). Unlike an attestation's kernel-minted id, an evidence item's id is
// agent-supplied and defaults to evidence_${index} — NOT globally unique. Composing it
// with the changeset id makes the key stable per (changeset, item) and collision-free
// across changesets that each carry an evidence_0. This ONE key is used both as the doc's
// metadata.sourceId (so findBySource rediscovers the doc it owns) AND as the ledger ref's
// refId (so listRefsByTarget("ledger", key, "evidence") resolves the single live ref) —
// keeping the two in lock-step is exactly what makes a re-run a clean per-item no-op.
export function runEvidenceLedgerKey(
  changesetId: string,
  evidenceId: string,
): string {
  return `${changesetId}:${evidenceId}`;
}

// Render one verification-run evidence item as a compact markdown snapshot — these bytes
// ARE what the ledger/evidence ref cites (plan §8, Slice C-rich). Deterministic: no
// timestamps or ids beyond the agent-supplied item id, so an unchanged re-run
// content-addresses to the same blob and DocumentStore.update dedupes it to a no-op. The
// item's own createdAt is deliberately omitted for that reason — the ledger row keeps the
// authoritative timing.
function renderRunEvidenceDocument(evidence: VerificationEvidence): string {
  const lines = [
    `# Evidence ${evidence.id}`,
    "",
    `- **Kind:** ${evidence.kind}`,
    `- **Status:** ${evidence.status}`,
  ];
  if (evidence.checkId) lines.push(`- **Check:** ${evidence.checkId}`);
  if (evidence.attestationId) {
    lines.push(`- **Attestation:** ${evidence.attestationId}`);
  }
  if (evidence.artifactPath) {
    lines.push(`- **Artifact:** ${evidence.artifactPath}`);
  }
  lines.push("", "## Summary", "", evidence.summary);
  if (evidence.data !== undefined) {
    lines.push(
      "",
      "## Data",
      "",
      "```json",
      stringifyEvidenceData(evidence.data),
      "```",
    );
  }
  return `${lines.join("\n")}\n`;
}

// Best-effort JSON rendering of an evidence item's `data` bag (agent-supplied, `unknown`).
// A value that can't be JSON-serialised (e.g. a cycle) falls back to its String form so a
// pathological payload never throws out of the deterministic renderer.
function stringifyEvidenceData(data: unknown): string {
  try {
    return JSON.stringify(data, null, 2) ?? String(data);
  } catch {
    return String(data);
  }
}

// Capture one record_verification_run evidence item's bytes as a versioned agent document
// + a single ledger/evidence ref citing the head (plan §8/§11, Slice C-rich — PRIMARY).
// ADDITIVE provenance: the _genie_verification_ledger row + the changeset's plan.evidence
// jsonb stay authoritative; this is a durable, versioned, byte-exact pointer beside them.
// Mirrors captureAttestationEvidenceDocument shape-for-shape, but the origin key is the
// COMPOSITE runEvidenceLedgerKey(changesetId, evidence.id) — because the item id alone is
// not stable/unique (see that helper). The doc is found by its ORIGIN
// (metadata.source=RUN_EVIDENCE_DOCUMENT_SOURCE + sourceId=<composite key>) — NOT via the
// ref — so a re-run with the SAME composite key rediscovers and updates the SAME doc
// instead of minting a second, and a lost ref self-heals on the next capture (recordUniqueRef
// re-points the single ref at the head atomically). Best-effort: returns the store Result
// (never throws for the store's own errors — PROJECT_REQUIRED with no project loaded is a
// Result, not a throw) so the caller degrades a provenance-write failure to a debug log.
export async function captureRunEvidenceDocument(
  store: DocumentStore,
  changesetId: string,
  evidence: VerificationEvidence,
  sessionId: string | undefined,
): Promise<Result<DocumentRef>> {
  const ledgerKey = runEvidenceLedgerKey(changesetId, evidence.id);
  const content = renderRunEvidenceDocument(evidence);

  const existing = await store.findBySource(
    RUN_EVIDENCE_DOCUMENT_SOURCE,
    ledgerKey,
    { sessionId },
  );

  let doc: DocumentRecord;
  if (existing) {
    const updated = await store.update(existing.id, {
      content,
      createdBy: "agent",
    });
    if (!updated.ok) return updated;
    doc = updated.data;
  } else {
    const created = await store.create({
      name: `Evidence: ${evidence.kind} (${evidence.status})`,
      kind: RUN_EVIDENCE_DOCUMENT_KIND,
      content,
      scope: "session",
      sessionId,
      createdBy: "agent",
      metadata: {
        source: RUN_EVIDENCE_DOCUMENT_SOURCE,
        sourceId: ledgerKey,
        title: `Evidence ${evidence.id}`,
      },
    });
    if (!created.ok) return created;
    doc = created.data;
  }

  return await store.recordUniqueRef({
    documentId: doc.id,
    refType: "ledger",
    refId: ledgerKey,
    role: "evidence",
    versionHash: doc.currentVersionHash,
    sessionId,
  });
}

// Capture every evidence item of a verification run (plan §8/§11, Slice C-rich). Each item
// is a DISTINCT target — its own doc + its own single live ledger/evidence ref keyed on the
// composite (changeset, item) origin — so N items yield N docs + N refs. Returns one Result
// per item (in evidence order) so the caller can log per-item failures without letting any
// single failure abort the rest; a per-item store error degrades that item only.
export async function captureRunEvidenceDocuments(
  store: DocumentStore,
  changesetId: string,
  evidence: VerificationEvidence[],
  sessionId: string | undefined,
): Promise<Result<DocumentRef>[]> {
  const results: Result<DocumentRef>[] = [];
  for (const item of evidence) {
    results.push(
      await captureRunEvidenceDocument(store, changesetId, item, sessionId),
    );
  }
  return results;
}

interface FormalSpecVerificationEntry {
  specId: string;
  technique: FormalSpecTechnique;
  scope: string;
  enforcement: FormalSpecEnforcement;
  met: boolean;
  status: VerificationStatus;
  detail: string;
}

// Verifies the active changeset's formal specs: runs the export type check
// (deno check) once, then confirms each spec's guard marker is present in its
// target entity. A spec passes only when its marker is present AND the export
// type-checks — meaning the compiler is actually enforcing the invariant.
// Returns per-spec results plus ready-to-record "invariant" evidence.
export async function runFormalSpecVerification(
  kernel: Kernel,
  changeset: Changeset,
  context?: ChangeContext,
): Promise<ToolResult> {
  const projectDir = kernel.projectDir;
  if (!projectDir) {
    return {
      ok: false,
      error: { code: "NO_PROJECT", message: "No project directory available." },
    };
  }
  const specs = changeset.plan.formalSpecs ?? [];
  if (specs.length === 0) {
    return {
      ok: true,
      data: {
        typeCheckPassed: null,
        specs: [],
        evidence: [],
        summary: "No formal specs to verify on this changeset.",
      },
    };
  }

  let typeCheck: ExportTypeCheckResult;
  try {
    typeCheck = await checkExportTypes(kernel, projectDir);
  } catch (err) {
    return {
      ok: false,
      error: {
        code: "EXPORT_TYPE_CHECK_FAILED",
        message: errorMessage(err),
        suggestion:
          "The type-check tool itself could not complete. Inspect the export/type-check setup and retry.",
      },
    };
  }

  const results: FormalSpecVerificationEntry[] = specs.map((spec) => {
    const source = resolveScopeSource(kernel, spec.scope);
    if (source === null) {
      return {
        specId: spec.id,
        technique: spec.technique,
        scope: spec.scope,
        enforcement: spec.enforcement,
        met: false,
        status: "failed",
        detail:
          `Target entity for scope "${spec.scope}" not found. Set scope to "handler:<name>" or "function:<name>".`,
      };
    }
    const marker = verifyFormalSpecMarker(spec, source);
    const met = marker.met && typeCheck.ok;
    const detail = marker.met && !typeCheck.ok
      ? `Guard present but export type check is failing — fix the ${typeCheck.issues.length} type error(s) so the invariant is enforced.`
      : marker.detail;
    return {
      specId: spec.id,
      technique: spec.technique,
      scope: spec.scope,
      enforcement: spec.enforcement,
      met,
      status: met ? "passed" : "failed",
      detail,
    };
  });

  // Mint one kernel attestation per spec, fingerprinted to its target entity,
  // and hand its id back on the evidence so record_verification_run can link it.
  const evidence: Array<{
    kind: "invariant";
    checkId: string;
    status: VerificationStatus;
    summary: string;
    attestationId?: string;
  }> = [];
  for (const r of results) {
    const summary = `${r.technique} on ${r.scope}: ${r.detail}`;
    const attestationId = await mintAttestation(
      kernel,
      context ?? null,
      {
        kind: "invariant",
        status: r.status,
        fingerprint: fingerprintScope(kernel, r.scope) ?? "",
        scope: r.scope,
        checkId: r.specId,
        summary,
      },
      changeset.id,
    );
    const item = {
      kind: "invariant" as const,
      checkId: r.specId,
      status: r.status,
      summary,
      ...(attestationId ? { attestationId } : {}),
    };
    evidence.push(item);
  }

  const passed = results.filter((r) => r.status === "passed").length;
  const summary = `${passed}/${results.length} formal spec(s) verified.` +
    (typeCheck.ok
      ? ""
      : ` Export type check failing (${typeCheck.issues.length} issue(s)).`);

  return {
    ok: true,
    data: {
      typeCheckPassed: typeCheck.ok,
      typeCheckOutput: typeCheck.output,
      specs: results,
      evidence,
      summary,
    },
  };
}

function inferModule(
  input: Record<string, unknown>,
  kernel: Kernel,
): string | undefined {
  if (input.module) return input.module as string;
  if (input.path) {
    const segments = (input.path as string).split("/").filter((s) =>
      s && s !== "api" && !s.startsWith(":")
    );
    if (segments.length > 0) return segments[0];
  }
  if (input.handlerName) {
    const handler = kernel.handlers.get(input.handlerName as string);
    if (handler?.module) return handler.module;
  }
  return undefined;
}
// Reject an asset name / module that isn't a single safe path segment before it
// is registered — it would become a path in the export tree and could escape the
// output dir (F-08 defense-in-depth). Returns an error ToolResult, or null when
// both are safe.
function unsafeAssetSegment(
  name: string,
  module: string | undefined,
): ToolResult | null {
  const bad = !isSafePathSegment(name)
    ? { field: "name", value: name }
    : (module !== undefined && !isSafePathSegment(module))
    ? { field: "module", value: module }
    : null;
  if (!bad) return null;
  return {
    ok: false,
    error: {
      code: "INVALID_ASSET_NAME",
      message:
        `Asset ${bad.field} "${bad.value}" must be a single path segment ` +
        "(no “/”, “\\”, or “..”).",
      suggestion: 'Use a plain filename such as "logo.png".',
    },
  };
}

function getTypeDiagnostics(
  entityType: string,
  entityName: string,
  kernel: Kernel,
): string | null {
  const ls = getSharedLanguageService();
  const diagnostics = ls.getDiagnostics(entityType, entityName, kernel);
  const errors = diagnostics.filter((d) => d.severity === "error");
  const warnings = diagnostics.filter((d) => d.severity === "warning");
  if (errors.length === 0 && warnings.length === 0) return null;

  const lines: string[] = [];
  for (const d of [...errors, ...warnings]) {
    const loc = `${d.line}:${d.column}`;
    const sev = d.severity === "error" ? "ERROR" : "WARN";
    const code = d.code ? ` ts(${d.code})` : "";
    lines.push(`  [${sev}] ${loc}${code}: ${d.message}`);
  }
  return `TypeScript diagnostics (${errors.length} errors, ${warnings.length} warnings):\n${
    lines.join("\n")
  }`;
}

/**
 * Summary shape shared by the app-structure `list_*` verbs that used to dump
 * full source (`list_handlers`, `list_functions`, `list_types`). Source was the
 * single largest slice of tool-result bytes and a tool result is re-read on
 * every request for the rest of the turn — see docs/agent-cost-reduction.md
 * §4.2. The list form carries only what the agent needs to pick what to open
 * (module, purpose) plus `sourceLines` to judge how big it is; `name` returns
 * the one full entry. One helper so the three can't drift apart.
 */
function entitySummary(
  entry: {
    name: string;
    registeredAt?: string;
    module?: string;
    purpose?: string;
    source?: string;
  },
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    name: entry.name,
    ...(entry.registeredAt ? { registeredAt: entry.registeredAt } : {}),
    ...(entry.module ? { module: entry.module } : {}),
    ...(entry.purpose ? { purpose: entry.purpose } : {}),
    ...(entry.source !== undefined
      ? { sourceLines: entry.source.split("\n").length }
      : {}),
    ...extra,
  };
}

function allEntitySources(kernel: Kernel): EntitySource[] {
  const entities: EntitySource[] = [];
  for (const h of kernel.handlers.list()) {
    entities.push({ name: h.name, source: h.source, kind: "handler" });
  }
  for (const f of kernel.functions.list()) {
    entities.push({ name: f.name, source: f.source, kind: "function" });
  }
  return entities;
}

function allSimilarEntities(kernel: Kernel): SimilarEntity[] {
  return [
    ...kernel.functions.list().map(functionEntity),
    ...kernel.handlers.list().map(handlerEntity),
  ];
}

async function saveScreenshot(
  kernel: Kernel,
  png: Uint8Array,
): Promise<string> {
  const screenshotDir = kernel.projectDir
    ? getProjectPaths(kernel.projectDir).screenshotArtifactsDir
    : join(
      Deno.cwd(),
      PROJECT_STATE_DIR_NAME,
      "history",
      "artifacts",
      "screenshots",
    );
  await Deno.mkdir(screenshotDir, { recursive: true });
  const name = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}.png`;
  const path = join(screenshotDir, name);
  await Deno.writeFile(path, png);
  return path;
}

const AUTO_SNAPSHOT_TOOLS = new Set([
  "alter_schema",
  "drop_schema",
  "restore_snapshot",
]);

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeClaimSource(value: unknown): VerificationClaimSource {
  return value === "user" || value === "agent" || value === "inferred"
    ? value
    : "agent";
}

function normalizeClaimPriority(value: unknown): VerificationClaimPriority {
  return value === "must" || value === "should" || value === "nice"
    ? value
    : "should";
}

function normalizeVerificationStatus(value: unknown): VerificationStatus {
  return value === "passed" || value === "failed" || value === "partial" ||
      value === "manual"
    ? value
    : "partial";
}

function normalizeCheckKind(value: unknown): VerificationCheckKind {
  const allowed = new Set<VerificationCheckKind>([
    "unit",
    "integration",
    "e2e",
    "screenshot",
    "typecheck",
    "coverage",
    "audit",
    "adversarial",
    "manual",
    "invariant",
    "manifest",
  ]);
  return typeof value === "string" &&
      allowed.has(value as VerificationCheckKind)
    ? value as VerificationCheckKind
    : "manual";
}

function normalizeAcceptanceCriteria(input: unknown): VerificationClaim[] {
  if (!Array.isArray(input)) return [];
  return input
    .map((item, index): VerificationClaim | null => {
      if (typeof item === "string") {
        return {
          id: `claim_${index}`,
          text: item,
          source: "agent",
          priority: "should",
        };
      }
      if (!isRecord(item) || typeof item.text !== "string") return null;
      return {
        id: typeof item.id === "string" && item.id.trim()
          ? item.id.trim()
          : `claim_${index}`,
        text: item.text,
        source: normalizeClaimSource(item.source),
        priority: normalizeClaimPriority(item.priority),
      };
    })
    .filter((claim): claim is VerificationClaim => claim !== null);
}

function normalizeVerificationPlan(input: unknown): VerificationCheck[] {
  if (!Array.isArray(input)) return [];
  return input
    .map((item, index): VerificationCheck | null => {
      if (!isRecord(item) || typeof item.description !== "string") return null;
      return {
        id: typeof item.id === "string" && item.id.trim()
          ? item.id.trim()
          : `check_${index}`,
        claimIds: stringArray(item.claimIds),
        kind: normalizeCheckKind(item.kind),
        description: item.description,
      };
    })
    .filter((check): check is VerificationCheck => check !== null);
}

function normalizeTestVerification(
  input: unknown,
): TestVerificationMetadata | undefined {
  if (!isRecord(input)) return undefined;
  const claimIds = stringArray(input.claimIds);
  const allowedKinds = new Set<TestVerificationMetadata["kind"]>([
    "unit",
    "integration",
    "e2e",
    "adversarial",
  ]);
  const kind = typeof input.kind === "string" &&
      allowedKinds.has(input.kind as TestVerificationMetadata["kind"])
    ? input.kind as TestVerificationMetadata["kind"]
    : undefined;
  const description = typeof input.description === "string" &&
      input.description.trim()
    ? input.description.trim()
    : undefined;
  const generatedFrom = typeof input.generatedFrom === "string" &&
      input.generatedFrom.trim()
    ? input.generatedFrom.trim()
    : undefined;
  const verification: TestVerificationMetadata = {
    ...(claimIds.length > 0 ? { claimIds } : {}),
    ...(kind ? { kind } : {}),
    ...(description ? { description } : {}),
    ...(generatedFrom ? { generatedFrom } : {}),
  };
  return Object.keys(verification).length > 0 ? verification : undefined;
}

function normalizeFormalSpecTechnique(
  value: unknown,
): FormalSpecTechnique | null {
  const allowed = new Set<FormalSpecTechnique>([
    "exhaustive-switch",
    "satisfies-guard",
    "discriminated-union",
    "union-alias",
    "numeric-range",
    "exhaustive-record",
    "branded-type",
  ]);
  return typeof value === "string" && allowed.has(value as FormalSpecTechnique)
    ? value as FormalSpecTechnique
    : null;
}

function normalizeFormalSpecs(
  input: unknown,
  acceptanceCriteria: VerificationClaim[],
): FormalSpec[] {
  if (!Array.isArray(input)) return [];
  // Default enforcement policy: hard when the spec formalizes at least one
  // "must" acceptance criterion, otherwise soft. Computed once for all specs.
  const mustIds = new Set(
    acceptanceCriteria.filter((c) => c.priority === "must").map((c) => c.id),
  );
  return input
    .map((item, index): FormalSpec | null => {
      if (!isRecord(item)) return null;
      const technique = normalizeFormalSpecTechnique(item.technique);
      if (!technique) return null;
      if (typeof item.statement !== "string" || !item.statement.trim()) {
        return null;
      }
      const claimIds = stringArray(item.claimIds);
      const discriminant = typeof item.discriminant === "string"
        ? item.discriminant.trim()
        : "";
      const enforcement =
        item.enforcement === "hard" || item.enforcement === "soft"
          ? item.enforcement
          : claimIds.some((id) => mustIds.has(id))
          ? "hard"
          : "soft";
      return {
        id: typeof item.id === "string" && item.id.trim()
          ? item.id.trim()
          : `spec_${index}`,
        claimIds,
        technique,
        scope: typeof item.scope === "string" ? item.scope.trim() : "",
        ...(discriminant ? { discriminant } : {}),
        statement: item.statement.trim(),
        enforcement,
      };
    })
    .filter((spec): spec is FormalSpec => spec !== null);
}

function buildPlan(planInput: {
  summary: string;
  steps: string[];
  acceptanceCriteria?: unknown;
  verificationPlan?: unknown;
  formalSpecs?: unknown;
}): ChangesetPlan {
  const acceptanceCriteria = normalizeAcceptanceCriteria(
    planInput.acceptanceCriteria,
  );
  const verificationPlan = normalizeVerificationPlan(
    planInput.verificationPlan,
  );
  const formalSpecs = normalizeFormalSpecs(
    planInput.formalSpecs,
    acceptanceCriteria,
  );
  // Note: the plan is rebuilt field-by-field, so `attestations`,
  // `verificationRuns` and `independentCriteria` can never be injected from
  // agent-supplied plan input — those are kernel-only, written exclusively by
  // recordAttestation / recordVerificationRun / recordIndependentCriteria. This is
  // the provenance guarantee. It matters most for independentCriteria: a proposal
  // the implementing agent could author is worth exactly nothing, because the only
  // thing that makes it evidence is that the agent did not write it.
  return {
    summary: planInput.summary,
    steps: planInput.steps.map((desc, i) => ({
      id: `step_${i}`,
      description: desc,
      status: "pending" as const,
    })),
    ...(acceptanceCriteria.length > 0 ? { acceptanceCriteria } : {}),
    ...(verificationPlan.length > 0 ? { verificationPlan } : {}),
    ...(formalSpecs.length > 0 ? { formalSpecs } : {}),
  };
}

// The tier the agent declared for this changeset, from tool input. Anything other
// than the two known values reads as "not declared" — an unrecognized declaration is
// not a light-lane grant. The kernel adjudicates it (resolveChangeClass); this only
// narrows the raw input.
function normalizeDeclaredTier(value: unknown): VerificationTier | undefined {
  return value === "light" || value === "standard" ? value : undefined;
}

// Build + adjudicate + validate a changeset plan, in that order. Shared by
// create_changeset and update_changeset_plan so the light lane's synthesized ceremony
// is authored BEFORE validateChangesetPlan runs — which is what lets that validator
// stay hard (a light-lane changeset genuinely has an acceptance criterion and a
// planned check; the agent just did not have to write them).
function preparePlan(
  kernel: Kernel,
  input: Record<string, unknown>,
):
  | { ok: true; plan: ChangesetPlan; changeClass: ChangeClass }
  | { ok: false; error: { code: string; message: string } } {
  const vt = verificationTools(kernel.composition);
  const built = buildPlan(
    input.plan as {
      summary: string;
      steps: string[];
      acceptanceCriteria?: unknown;
      verificationPlan?: unknown;
      formalSpecs?: unknown;
    },
  );
  const resolved = vt.resolveChangeClass(
    normalizeDeclaredTier(input.change_class),
    built,
    getKernelSettings().proportionalVerification,
  );
  // An incoherent light declaration is REJECTED, not silently downgraded: a silent
  // downgrade would leave the user reading a plan that says one thing while the
  // kernel does another.
  if (resolved.issue) {
    return {
      ok: false,
      error: { code: "INVALID_CHANGE_CLASS", message: resolved.issue },
    };
  }
  const missing = vt.validateChangesetPlan(resolved.plan);
  if (missing) {
    return {
      ok: false,
      error: { code: "INVALID_CHANGESET_PLAN", message: missing },
    };
  }
  // changeClass is attached HERE, never inside buildPlan — it is kernel-adjudicated
  // and must not be reachable from agent-supplied plan input, like `attestations`.
  return {
    ok: true,
    plan: { ...resolved.plan, changeClass: resolved.changeClass },
    changeClass: resolved.changeClass,
  };
}

function buildPlanAmendment(
  amendmentInput: {
    summary_addendum?: unknown;
    steps?: unknown;
    acceptanceCriteria?: unknown;
    verificationPlan?: unknown;
    formalSpecs?: unknown;
  },
  existingPlan: ChangesetPlan,
): ChangesetPlanAmendment {
  const acceptanceCriteria = normalizeAcceptanceCriteria(
    amendmentInput.acceptanceCriteria,
  );
  const verificationPlan = normalizeVerificationPlan(
    amendmentInput.verificationPlan,
  );
  const formalSpecs = normalizeFormalSpecs(
    amendmentInput.formalSpecs,
    [...(existingPlan.acceptanceCriteria ?? []), ...acceptanceCriteria],
  );
  return {
    summaryAddendum: typeof amendmentInput.summary_addendum === "string"
      ? amendmentInput.summary_addendum
      : "",
    steps: stringArray(amendmentInput.steps).map((step) => step.trim())
      .filter((step) => step.length > 0),
    ...(acceptanceCriteria.length > 0 ? { acceptanceCriteria } : {}),
    ...(verificationPlan.length > 0 ? { verificationPlan } : {}),
    ...(formalSpecs.length > 0 ? { formalSpecs } : {}),
  };
}

function normalizeEvidence(input: unknown): VerificationEvidence[] {
  if (!Array.isArray(input)) return [];
  const now = new Date().toISOString();
  return input
    .map((item, index): VerificationEvidence | null => {
      if (!isRecord(item) || typeof item.summary !== "string") return null;
      const rawKind = typeof item.kind === "string" ? item.kind : "note";
      const kind = rawKind === "test_result" || rawKind === "note"
        ? rawKind
        : normalizeCheckKind(rawKind);
      return {
        id: typeof item.id === "string" && item.id.trim()
          ? item.id.trim()
          : `evidence_${index}`,
        kind,
        summary: item.summary,
        status: normalizeVerificationStatus(item.status),
        ...(typeof item.checkId === "string" && item.checkId.trim()
          ? { checkId: item.checkId.trim() }
          : {}),
        ...(typeof item.attestationId === "string" && item.attestationId.trim()
          ? { attestationId: item.attestationId.trim() }
          : {}),
        ...(typeof item.artifactPath === "string" && item.artifactPath.trim()
          ? { artifactPath: item.artifactPath.trim() }
          : {}),
        ...(Object.hasOwn(item, "data") ? { data: item.data } : {}),
        createdAt: typeof item.createdAt === "string" && item.createdAt.trim()
          ? item.createdAt.trim()
          : now,
      };
    })
    .filter((item): item is VerificationEvidence => item !== null);
}

function normalizeClaimResults(input: unknown): VerificationClaimResult[] {
  if (!Array.isArray(input)) return [];
  return input
    .map((item): VerificationClaimResult | null => {
      if (!isRecord(item) || typeof item.claimId !== "string") return null;
      return {
        claimId: item.claimId,
        status: normalizeVerificationStatus(item.status),
        evidenceIds: stringArray(item.evidenceIds),
        ...(typeof item.note === "string" && item.note.trim()
          ? { note: item.note.trim() }
          : {}),
      };
    })
    .filter((item): item is VerificationClaimResult => item !== null);
}

function invalidClaimEvidenceReferenceMessage(
  evidence: VerificationEvidence[],
  claimResults: VerificationClaimResult[],
): string | null {
  const evidenceIds = new Set(evidence.map((item) => item.id));
  const checkIds = new Set(
    evidence.map((item) => item.checkId).filter((id): id is string => !!id),
  );
  const attestationIds = new Set(
    evidence.map((item) => item.attestationId).filter((id): id is string =>
      !!id
    ),
  );
  const badIds = [
    ...new Set(
      claimResults.flatMap((result) =>
        result.evidenceIds.filter((id) => !evidenceIds.has(id))
      ),
    ),
  ];
  if (badIds.length === 0) return null;

  const checkIdMixups = badIds.filter((id) => checkIds.has(id));
  if (checkIdMixups.length > 0) {
    return `claimResults[].evidenceIds must reference evidence[].id values from this run, not verificationPlan checkId values. Invalid evidenceIds: ${
      checkIdMixups.join(", ")
    }.`;
  }

  const attestationIdMixups = badIds.filter((id) => attestationIds.has(id));
  if (attestationIdMixups.length > 0) {
    return `claimResults[].evidenceIds must reference evidence[].id values from this run, not attestationId values. Invalid evidenceIds: ${
      attestationIdMixups.join(", ")
    }.`;
  }

  return `claimResults[].evidenceIds reference missing evidence item(s): ${
    badIds.join(", ")
  }. Add matching evidence[].id records or correct the references.`;
}

function missingRuntimeCapability(
  kernel: Kernel,
  action: string,
): { ok: false; error: { code: string; message: string; suggestion: string } } {
  return {
    ok: false,
    error: {
      code: "RUNTIME_CAPABILITY_UNAVAILABLE",
      message: `Runtime "${kernel.runtimeId}" cannot ${action}.`,
      suggestion: "Use a project runtime adapter that supports this operation.",
    },
  };
}

async function compileRuntimeHandler(
  kernel: Kernel,
  name: string,
  source: string,
  deps: CompileDeps,
): Promise<Result<HandlerFn>> {
  const compile = kernel.runtime.compileHandler;
  if (!compile) return missingRuntimeCapability(kernel, "compile handlers");
  return await compile(name, source, deps);
}

async function compileRuntimeFunction(
  kernel: Kernel,
  name: string,
  source: string,
  deps: CompileDeps,
): Promise<Result<(...args: unknown[]) => unknown>> {
  const compile = kernel.runtime.compileFunction;
  if (!compile) return missingRuntimeCapability(kernel, "compile functions");
  return await compile(name, source, deps);
}

async function compileRuntimeTest(
  kernel: Kernel,
  name: string,
  source: string,
  deps: CompileDeps,
): Promise<Result<TestFn>> {
  const compile = kernel.runtime.compileTest;
  if (!compile) return missingRuntimeCapability(kernel, "compile tests");
  return await compile(name, source, deps);
}

async function compileRuntimeDevView(
  kernel: Kernel,
  name: string,
  source: string,
  deps: CompileDeps,
): Promise<Result<DevViewFn>> {
  const compile = kernel.runtime.compileDevView;
  if (!compile) return missingRuntimeCapability(kernel, "compile dev views");
  return await compile(name, source, deps, kernelInspectAPI(kernel));
}

async function compileRuntimeDevTool(
  kernel: Kernel,
  name: string,
  source: string,
  args: DevToolArgDef[],
  deps: CompileDeps,
): Promise<Result<DevToolFn>> {
  const compile = kernel.runtime.compileDevTool;
  if (!compile) return missingRuntimeCapability(kernel, "compile dev tools");
  return await compile(name, source, args, deps);
}

async function runRuntimeScript(
  kernel: Kernel,
  source: string,
  deps: CompileDeps,
): Promise<RuntimeScriptResult> {
  const run = kernel.runtime.runScript;
  if (!run) {
    const missing = missingRuntimeCapability(kernel, "run scripts");
    return {
      ok: false,
      error: missing.error,
      logs: [],
    };
  }
  return await run(source, deps, undefined, kernel.log);
}

function migrationProvenance(ctx: ChangeContext | null): MigrationProvenance {
  return {
    turnId: ctx?.turnId ?? null,
    changesetId: ctx?.changesetId ?? null,
  };
}

// The one statement an alter ran and the statement that reverses it, next to
// the cumulative SQL. A merge replays `statement`; `reverseSql` is null when
// the alter can't be reversed (a rebuild, or a drop that loses data).
function alterStatementSnapshot(migration: MigrationEntry) {
  return {
    migrationVersion: migration.version,
    statement: migration.sql,
    reverseSql: migration.reversible && migration.reverseSql
      ? migration.reverseSql
      : null,
  };
}

// Before/after asset snapshots plus whether undo can restore them. The registry
// entry is read after register(), so `after` carries the module it landed in.
function assetChangeSnapshots(
  kernel: Kernel,
  before: AssetEntry | undefined,
  after: AssetEntry | undefined,
) {
  const beforeSnapshot = before ? assetSnapshot(kernel, before) : null;
  const afterSnapshot = after ? assetSnapshot(kernel, after) : null;
  return {
    beforeSnapshot,
    afterSnapshot,
    undoable: assetSnapshotRestorable(beforeSnapshot) &&
      assetSnapshotRestorable(afterSnapshot),
  };
}

// The undo/redo shape of a type or custom audit: everything applySnapshot needs
// to re-register it, and nothing registry-minted (timestamps, entityUid).
function typeSnapshot(entry: TypeEntry) {
  return {
    name: entry.name,
    fields: entry.fields,
    ...(entry.description ? { description: entry.description } : {}),
    ...(entry.module ? { module: entry.module } : {}),
  };
}

export function auditSnapshot(entry: CustomAuditEntry) {
  return {
    name: entry.name,
    description: entry.description,
    prompt: entry.prompt,
    ...(entry.module ? { module: entry.module } : {}),
  };
}

function sourceRuntimeMetadata(
  kernel: Kernel,
  existing?: { runtimeId?: string; language?: string },
): { runtimeId: string; language: string } {
  return {
    runtimeId: existing?.runtimeId ?? kernel.runtimeId,
    language: existing?.language ?? kernel.runtime.defaultLanguage,
  };
}

export const MODIFICATION_TOOLS = new Set([
  "define_handler",
  "define_function",
  "register_route",
  "unregister_route",
  "define_schema",
  "alter_schema",
  "drop_schema",
  "execute_sql",
  "import_data",
  "reset_data",
  "define_template",
  "delete_template",
  "define_test",
  "remove_test",
  "upload_asset",
  "upload_text_asset",
  "delete_asset",
  "define_dev_view",
  "remove_dev_view",
  "define_dev_tool",
  "remove_dev_tool",
  "define_type",
  "remove_handler",
  "remove_function",
  "remove_type",
  "install_package",
  "remove_package",
  "define_secret",
  "set_secret_value",
  "clear_secret_value",
  "delete_secret",
  "set_config",
  "delete_config",
  "set_env",
  "delete_env",
  "define_env_var",
  "set_env_var_value",
  "clear_env_var_value",
  "delete_env_var",
  "define_audit",
  "remove_audit",
  "restore_snapshot",
  // Consolidated removal verb (surface v5.0.0). Its "remove_" prefix already makes
  // isDestructiveTool/isIdempotentTool true; listing it here changeset-gates it and
  // injects the rationale fields, matching the per-entity removals it replaces.
  "remove_entity",
  // Targeted string-replace editing for templates and text assets. Like remove_entity
  // it delegates (define_template / upload_text_asset) and is listed here so the
  // changeset gate and rationale injection apply at the outer call too.
  "edit_entity_text",
  // Document authoring (docs/document-store-plan.md §6). A mutation, but also
  // changeset-exempt (below) — authoring a session/global-scoped doc must not
  // require an active changeset, like set_config/set_env.
  "document_write",
  "apply_project_file",
  // Writers that used to bypass the gate and the changelog entirely, so a
  // changeset's footprint (and undo) silently missed them.
  "write_project_file",
  "generate_project_docs",
  "rename_module",
  "move_to_module",
]);

export function isMutationTool(name: string): boolean {
  return MODIFICATION_TOOLS.has(name);
}

// --- Behavioral classification for the outbound MCP annotation projection ---
//
// The outbound MCP projection (mcp-projection.ts) advertises the standard MCP
// behavioral hints (read-only / destructive / idempotent / open-world) per verb.
// The knowledge of what each verb DOES lives here in core, co-located with
// MODIFICATION_TOOLS, because it is the same kind of authoritative per-verb fact
// — the projection is only a formatter.
//
// Crucially, read-only status is an explicit hand-vetted allowlist, NOT the
// complement of MODIFICATION_TOOLS. Several verbs write state without being
// changelog mutations: the whole changeset-governance family, and the
// attestation-minting verifiers (submit_review, run_tests, check_export_types,
// test_coverage, verify_formal_specs) all record proof onto the active
// changeset. `readOnlyHint = !isMutationTool` would wrongly mark every one
// of those as safe-to-auto-run, so read-only is asserted only for verbs verified
// to purely inspect.

// Verbs that only inspect state — no registry/db writes, no code execution, no
// attestation minting. Everything NOT listed here is treated as a writer by the
// MCP projection (a safe default: at worst a genuine read is under-claimed). A
// guard test pins this set against CUSTOM_TOOLS so a typo or a new read verb can
// be caught.
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "list_routes",
  "list_handlers",
  "get_handler_source",
  "list_functions",
  "get_function_source",
  "list_schemas",
  "get_schema",
  "query_database",
  "get_logs",
  "find_similar_entities",
  "get_recent_errors",
  "get_recent_requests",
  "doctor_project",
  "get_config",
  "list_configs",
  "get_env",
  "list_env",
  "get_env_var",
  "list_env_vars",
  "get_secret",
  "list_secrets",
  "list_templates",
  "get_template",
  "list_assets",
  "get_asset",
  "list_packages",
  "find_unused_packages",
  "list_types",
  "get_type",
  "list_dev_views",
  "get_dev_view_source",
  "list_dev_tools",
  "list_tests",
  "get_test_source",
  "lint_code",
  "find_dead_code",
  "blast_radius",
  "analyze_complexity",
  "check_package_security",
  "list_audits",
  "search_changes",
  "list_turns",
  "get_session_context",
  "list_current_project_pins",
  "get_change",
  "list_changesets",
  "get_changeset_context",
  "get_changeset",
  "check_changeset_readiness",
  "list_modules",
  "get_module",
  "list_branches",
  "list_tasks",
  "list_snapshots",
  "get_platform_docs",
  "get_kernel_status",
  "project_status",
  "browser_status",
  // Consolidated read-only analysis verb (surface v5.0.0) — delegates to the
  // complexity/dead-code/security analyses, none of which mint attestations.
  "analyze",
  // Document reads (search/read/list) — pure inspection of the document store.
  // document_pin only writes a working-set membership row (no project mutation),
  // so it is also outside MODIFICATION_TOOLS; but it is not a pure read, so it is
  // deliberately NOT listed here (the MCP projection treats it as a writer).
  "document_query",
  "preview_project_file",
]);

// Verbs that reach an "open world" of external entities beyond the loaded
// project — a package registry / advisory database. Every other verb acts on the
// closed world of the project, so openWorldHint is false for it.
export const OPEN_WORLD_TOOLS: ReadonlySet<string> = new Set([
  "install_package",
  "check_package_security",
  "git_push",
]);

// Non-read verbs that destroy or overwrite data without a removal-family name:
// `execute_sql` runs arbitrary DML; `import_data` truncates its target tables by
// default. The DDL / whole-state-replacement verbs that are also destructive
// (alter_schema, drop_schema, restore_snapshot) are NOT repeated here — they are
// already the core's own "snapshot first, this can destroy data" judgment,
// AUTO_SNAPSHOT_TOOLS (above), which isDestructiveTool unions in so that judgment
// has a single home and the two sets can't drift.
const DESTRUCTIVE_EXTRA: ReadonlySet<string> = new Set([
  "execute_sql",
  "import_data",
  "apply_project_file",
  // Both overwrite whatever file is already at the path.
  "write_project_file",
  "generate_project_docs",
  // Deletes the fork and whatever wasn't merged.
  "discard_task",
  // Replays the fork onto main, deletes included.
  "merge_task",
]);

// Name prefixes that denote an idempotent removal: deleting/clearing/dropping an
// entity leaves the same end state on repeat, and removing data is destructive.
// Applied to ANY non-read verb, so removals outside MODIFICATION_TOOLS (e.g.
// delete_branch) are classified correctly too.
const REMOVAL_PREFIXES = [
  "delete_",
  "drop_",
  "remove_",
  "reset_",
  "clear_",
  "unregister_",
] as const;

export function isReadOnlyTool(name: string): boolean {
  return READ_ONLY_TOOLS.has(name);
}

function isRemovalTool(name: string): boolean {
  return REMOVAL_PREFIXES.some((prefix) => name.startsWith(prefix));
}

// A verb that can destroy data or irreversibly discard state. Meaningful only for
// non-read verbs: the removal family plus the arbitrary-write extras.
export function isDestructiveTool(name: string): boolean {
  if (isReadOnlyTool(name)) return false;
  return isRemovalTool(name) || AUTO_SNAPSHOT_TOOLS.has(name) ||
    DESTRUCTIVE_EXTRA.has(name);
}

// A verb whose repeat call with the same args leaves the same end state. Claimed
// only for removals (the conservative always-true case); creates/updates are left
// unclaimed even where they happen to upsert.
export function isIdempotentTool(name: string): boolean {
  if (isReadOnlyTool(name)) return false;
  return isRemovalTool(name);
}

export function isOpenWorldTool(name: string): boolean {
  return OPEN_WORLD_TOOLS.has(name);
}

const CHANGESET_TOOLS = new Set([
  "create_changeset",
  "update_changeset_plan",
  "amend_changeset_plan",
  "update_changeset_step",
  "complete_changeset",
  "abandon_changeset",
  "adopt_changeset",
]);

const CHANGESET_EXEMPT_TOOLS = new Set([
  "set_config",
  "delete_config",
  "set_env",
  "delete_env",
  "rename_session",
  "import_data",
  "reset_data",
  // Authoring a session/global-scoped document is agent scratch/plan work, not a
  // project code mutation — it must not require an active changeset (plan §6).
  "document_write",
]);

// remove_entity({type,key}) → the per-entity removal verb it delegates to, plus
// how to shape that verb's input from the generic `key`. The delegate re-runs the
// dispatch gate under its own name, so each removal keeps its exact governance
// (changeset gating, auto-snapshot) with no duplication here.
const REMOVE_ENTITY_MAP: Record<
  string,
  { tool: string; toInput: (key: string) => Record<string, unknown> }
> = {
  route: {
    tool: "unregister_route",
    toInput: (key) => {
      const parts = key.trim().split(/\s+/);
      return { method: parts[0] ?? "", path: parts.slice(1).join(" ") };
    },
  },
  schema: { tool: "drop_schema", toInput: (key) => ({ tableName: key }) },
  template: { tool: "delete_template", toInput: (key) => ({ name: key }) },
  asset: { tool: "delete_asset", toInput: (key) => ({ name: key }) },
  handler: { tool: "remove_handler", toInput: (key) => ({ name: key }) },
  function: { tool: "remove_function", toInput: (key) => ({ name: key }) },
  type: { tool: "remove_type", toInput: (key) => ({ name: key }) },
  test: { tool: "remove_test", toInput: (key) => ({ name: key }) },
  dev_view: { tool: "remove_dev_view", toInput: (key) => ({ name: key }) },
  dev_tool: { tool: "remove_dev_tool", toInput: (key) => ({ name: key }) },
  audit: { tool: "remove_audit", toInput: (key) => ({ name: key }) },
  env_var: { tool: "delete_env_var", toInput: (key) => ({ key }) },
  secret: { tool: "delete_secret", toInput: (key) => ({ key }) },
  package: { tool: "remove_package", toInput: (key) => ({ name: key }) },
};

// analyze({kind}) → the standalone analysis verb it delegates to.
const ANALYZE_KIND_MAP: Record<string, string> = {
  complexity: "analyze_complexity",
  dead_code: "find_dead_code",
};

// Read the project's display name straight off opentide.json. openProject() also
// returns it, but it rewrites the global project registry as a side effect, which
// an export has no business doing. Undefined on any failure so exportProject falls
// back to its own default rather than failing the export over a manifest read.
function readProjectManifestName(projectDir: string): string | undefined {
  try {
    const metaPath = projectManifestPath(projectDir);
    if (!existsSync(metaPath)) return undefined;
    const meta = JSON.parse(readFileSync(metaPath, "utf-8")) as {
      name?: unknown;
    };
    return typeof meta.name === "string" && meta.name ? meta.name : undefined;
  } catch {
    return undefined;
  }
}

function requireProjectDir(kernel: Kernel): string {
  if (!kernel.projectDir) {
    throw new GitProjectError(
      "NO_PROJECT",
      "No project directory is loaded.",
    );
  }
  return kernel.projectDir;
}

// Persists in-memory project state (registries, branch snapshots, logs) to disk.
// Exported so the per-step checkpoint binding (agent-loop/chat.ts) can flush before a
// step commit exactly as the git_commit tool does here — one flush definition, no drift.
export function flushKernelProjectState(kernel: Kernel): void {
  const projectDir = requireProjectDir(kernel);
  const paths = getProjectPaths(projectDir);
  kernel.log.save();
  saveKernelState(kernel, paths.stateDir);
  saveBranchSnapshots(kernel, paths.branchSnapshots);
}

function gitToolError(err: unknown): ToolResult {
  if (err instanceof GitProjectError) {
    return {
      ok: false,
      error: { code: err.code, message: err.message },
      data: err.details,
    };
  }
  return {
    ok: false,
    error: { code: "GIT_ERROR", message: errorMessage(err) },
  };
}

function compactSession(session: {
  id: string;
  name: string;
  startedAt: string;
  endedAt: string | null;
  summary: string | null;
  focus: string | null;
  archived: boolean;
  visibility?: string;
  ownerUserId?: string | null;
  lastMessageAt?: string | null;
}) {
  return {
    id: session.id,
    name: session.name,
    startedAt: session.startedAt,
    lastMessageAt: session.lastMessageAt ?? null,
    endedAt: session.endedAt,
    archived: session.archived,
    visibility: session.visibility ?? "private",
    ownerUserId: session.ownerUserId ?? null,
    summary: session.summary,
    focus: session.focus,
  };
}

function sessionToolLimit(input: Record<string, unknown>): number {
  const raw = Number(input.limit ?? 20);
  if (!Number.isFinite(raw)) return 20;
  return Math.min(Math.max(Math.trunc(raw), 1), 100);
}

function sessionMatchesText(
  session: {
    id: string;
    name: string;
    summary: string | null;
    focus: string | null;
    metadata: string | null;
  },
  query: string,
): boolean {
  const q = query.toLowerCase();
  return [
    session.id,
    session.name,
    session.summary,
    session.focus,
    session.metadata,
  ].some((value) => value?.toLowerCase().includes(q));
}

// Re-adjudicate a changeset's declared change class against what it actually changed
// (proportional verification, completion gate). Returns the verdict and persists it
// when it moved, so the escalation reason is durable and reaches the UI. Returns
// undefined when the changeset carries no class at all — a pre-existing changeset, or
// one created while the feature was off — which reads as `standard` everywhere.
async function adjudicateChangeClass(
  kernel: Kernel,
  changeset: Changeset,
): Promise<ChangeClass | undefined> {
  const declared = changeset.plan.changeClass;
  if (!declared) return undefined;
  const records = await kernel.changelog.listByChangeset(changeset.id);
  const verified = verificationTools(kernel.composition)
    .verifyChangeClass(declared, records);
  if (
    verified.effective !== declared.effective ||
    verified.escalated !== declared.escalated
  ) {
    await kernel.changesets.recordChangeClass(changeset.id, verified);
  }
  return verified;
}

// The light lane's proof: a kernel-minted manifest of exactly which entities the
// changeset changed, taken from the changelog. This is a claim about WHAT CHANGED,
// not that it works — which is why it can be minted by the kernel without a verifier
// running, and why it is honest. For a small change the diff plus the deterministic
// checks that already ran IS the proportionate evidence; a manufactured unit test
// asserting a margin would be ceremony, not proof.
//
// Recording the run here is what satisfies MISSING_VERIFICATION_RUN /
// MISSING_VERIFICATION_EVIDENCE / MISSING_CLAIM_RESULTS by CONSTRUCTION rather than
// by waiver: the changeset really does have a verification run, real evidence, and a
// per-claim result — the agent just did not have to author them.
async function recordChangeManifest(
  kernel: Kernel,
  changeset: Changeset,
  context: ChangeContext | null,
): Promise<void> {
  const records = await kernel.changelog.listByChangeset(changeset.id);
  const scopes = [...new Set(records.map(changeScope))].sort();
  const summary = scopes.length > 0
    ? `Changed ${scopes.length} entity/entities: ${scopes.join(", ")}.`
    : "No registry changes were recorded for this changeset.";
  const attestationId = await mintAttestation(kernel, context, {
    kind: "change_manifest",
    status: "passed",
    fingerprint: fingerprintProject(kernel),
    scope: PROJECT_SCOPE,
    summary,
  }, changeset.id);

  const claims = changeset.plan.acceptanceCriteria ?? [];
  const evidenceId = createTimestampedId("ev");
  await kernel.changesets.recordVerificationRun(changeset.id, {
    status: "passed",
    summary: `Light-lane verification: ${summary}`,
    evidence: [{
      id: evidenceId,
      kind: "manifest",
      summary,
      status: "passed",
      ...(changeset.plan.verificationPlan?.[0]?.id
        ? { checkId: changeset.plan.verificationPlan[0].id }
        : {}),
      ...(attestationId ? { attestationId } : {}),
      data: { scopes },
      createdAt: new Date().toISOString(),
    }],
    claimResults: claims.map((claim) => ({
      claimId: claim.id,
      status: "passed" as const,
      evidenceIds: [evidenceId],
    })),
    residualRisks: [],
  });
}

// git_commit scoped to a changeset: OpenTide's own paths and the files the
// changeset wrote, as landing commits them, and nothing else in the work tree.
// Nothing to commit, or commits turned off for the project, is not an error.
async function commitChangesetPaths(
  kernel: Kernel,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const message = input.message;
  if (typeof message !== "string" || !message.trim()) {
    return {
      ok: false,
      error: {
        code: "INVALID_INPUT",
        message: "git_commit with a changeset_id needs a message.",
      },
    };
  }
  try {
    const projectDir = requireProjectDir(kernel);
    flushKernelProjectState(kernel);
    const sha = await commitManagedPaths(
      kernel,
      projectDir,
      message,
      input.changeset_id as string,
    );
    return {
      ok: true,
      data: sha ? { committed: true, sha } : { committed: false },
    };
  } catch (err) {
    return gitToolError(err);
  }
}

// A document_write create's content: text, or bytes sent as base64.
function documentContent(
  input: Record<string, unknown>,
): Result<string | Uint8Array> {
  if (typeof input.content_base64 !== "string") {
    return { ok: true, data: (input.content as string) ?? "" };
  }
  try {
    return { ok: true, data: decodeBase64(input.content_base64) };
  } catch {
    return {
      ok: false,
      error: {
        code: "INVALID_INPUT",
        message: "content_base64 isn't valid base64.",
      },
    };
  }
}

// A user's attachment is the user's document, tagged so it isn't mistaken for
// an agent-authored one.
function documentMetadata(
  input: Record<string, unknown>,
): DocumentMetadata | undefined {
  const description = input.description as string | undefined;
  const metadata: DocumentMetadata = {
    ...(description ? { description } : {}),
    ...(input.attachment === true
      ? { source: ATTACHMENT_DOCUMENT_SOURCE }
      : {}),
  };
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

const MESSAGE_REF_ROLES = ["mention", "attachment"] as const;

// A message in the caller's session cites a document version: one it mentioned
// or one attached to it. Other refs (plans, evidence, the working set) are the
// kernel's to write.
async function recordMessageDocumentRef(
  kernel: Kernel,
  input: Record<string, unknown>,
  ctx?: ChangeContext,
): Promise<Result<DocumentRef>> {
  const invalid = (message: string): Result<DocumentRef> => ({
    ok: false,
    error: { code: "INVALID_INPUT", message },
  });
  const id = input.id as string | undefined;
  const messageId = input.message_id;
  const role = input.role as typeof MESSAGE_REF_ROLES[number];
  if (!id) return invalid("document_write action=ref requires an id.");
  if (!Number.isInteger(messageId)) {
    return invalid("document_write action=ref requires a message_id.");
  }
  if (!MESSAGE_REF_ROLES.includes(role)) {
    return invalid("role must be mention or attachment.");
  }
  const message = await kernel.sessions.getMessage(messageId as number);
  if (!message || message.sessionId !== ctx?.sessionId) {
    return {
      ok: false,
      error: {
        code: "MESSAGE_NOT_FOUND",
        message: `Message ${messageId} isn't in this session.`,
      },
    };
  }
  return await kernel.documents.recordRef({
    documentId: id,
    refType: "message",
    refId: String(message.id),
    role,
    versionHash: (input.versionHash as string | undefined) ?? null,
    sessionId: message.sessionId,
  });
}

// Shape a document_query search/list filter from the raw tool input.
function documentFilter(input: Record<string, unknown>): ListDocumentsFilter {
  const filter: ListDocumentsFilter = {};
  if (typeof input.scope === "string") {
    filter.scope = input.scope as DocumentScope;
  }
  if (typeof input.sessionId === "string") filter.sessionId = input.sessionId;
  if (input.includeArchived === true) filter.includeArchived = true;
  return filter;
}

function parseProjectTextFileRequest(
  input: Record<string, unknown>,
): Result<ProjectTextFileRequest> {
  if (typeof input.path !== "string" || input.path.trim() === "") {
    return {
      ok: false,
      error: {
        code: "INVALID_INPUT",
        message: "A non-empty string `path` is required.",
      },
    };
  }
  const req: ProjectTextFileRequest = { path: input.path };
  if (typeof input.content === "string") req.content = input.content;
  if (input.delete === true) req.delete = true;
  if (typeof input.baseFingerprint === "string") {
    req.baseFingerprint = input.baseFingerprint;
  } else if (input.baseFingerprint === null) {
    req.baseFingerprint = null;
  } else if ("baseFingerprint" in input) {
    return {
      ok: false,
      error: {
        code: "INVALID_INPUT",
        message: "`baseFingerprint` must be a string or null.",
      },
    };
  }
  return { ok: true, data: req };
}

// project_status (orientation). One read-only call that answers "is it safe to
// change this project right now", replacing the checks a session used to run by
// hand from a doc whose expected numbers drifted every few weeks. It compares
// the project against itself — memory against disk, references against
// targets — rather than against numbers written down somewhere.
//
// Deliberately excluded: run_tests (slow, and live-model tests bill) and the
// changeset readiness check (check_changeset_readiness owns it, with the
// changeset id in hand). The MCP face adds the projected surface version and
// fingerprint, which only it can compute (mcp-projection.ts).
type StatusVerdict = "ok" | "attention" | "stop";

async function projectStatus(
  kernel: Kernel,
  context?: ChangeContext,
): Promise<Record<string, unknown>> {
  const stop: string[] = [];
  const attention: string[] = [];

  let doctor: Record<string, unknown> | null = null;
  if (kernel.projectDir) {
    const report = await doctorProject(kernel.projectDir, kernel.db);
    doctor = {
      ok: report.ok,
      errors: report.errors,
      warnings: report.warnings.length,
    };
    for (const issue of report.errors) {
      stop.push(
        `Consistency error ${issue.code} at ${issue.path}: ${issue.message}`,
      );
    }
  }

  const memory = await liveCounts(kernel);
  let persisted: Record<string, unknown> | null = null;
  if (kernel.projectDir) {
    const disk = persistedCounts(readPersistedState(kernel.projectDir));
    // Schemas live in the database, not the state tree, and configs carry
    // kernel-internal keys on one side only — neither compares cleanly.
    const differing = (Object.keys(memory) as Array<keyof typeof memory>)
      .filter((k) => k !== "schemas" && k !== "configs")
      .filter((k) => memory[k] !== disk[k])
      .map((k) => ({ kind: k, memory: memory[k], disk: disk[k] }));
    persisted = { matches: differing.length === 0, differing };
    if (differing.length > 0) {
      attention.push(
        `Memory and .opentide/state differ (${
          differing.map((d) => `${d.kind} ${d.memory} vs ${d.disk}`).join(", ")
        }). If this session has changed things, that is unflushed work: ` +
          "complete the changeset or call flush_project_state. If it has not, " +
          "state did not load — stop and tell the user.",
      );
    }
  }

  // Entities defined before the define tools refused reserved names.
  const reservedInUse = [
    ...kernel.handlers.list().map((h) => ["handler", h.name] as const),
    ...kernel.functions.list().map((f) => ["function", f.name] as const),
    ...kernel.tests.list().map((t) => ["test", t.name] as const),
  ].filter(([kind, name]) => reservedNameError(kind, name) !== null);
  if (reservedInUse.length > 0) {
    attention.push(
      `Reserved name in use: ${
        reservedInUse.map(([kind, name]) => `${kind} ${name}`).join(", ")
      }. It shadows a platform binding in its own scope; rename it.`,
    );
  }

  const deadCode = findDeadCode(kernel).length;
  if (deadCode > 0) {
    attention.push(
      `${deadCode} unreachable entit${deadCode === 1 ? "y" : "ies"} ` +
        '(analyze kind "dead_code" lists them).',
    );
  }

  const active = await kernel.changesets.getActive(context?.sessionId);
  const activeChangeset = active
    ? {
      id: active.id,
      title: active.title,
      status: active.status,
      steps: {
        done: active.plan.steps.filter((s) =>
          s.status === "done" || s.status === "skipped"
        ).length,
        total: active.plan.steps.length,
      },
    }
    : null;
  // One writer per project: a changeset held by another session blocks this
  // one's create_changeset, so say so before the agent plans around it.
  const elsewhere = active ? null : await kernel.changesets.getActive();
  const heldElsewhere =
    elsewhere && (elsewhere.sessionId ?? null) !== (context?.sessionId ?? null)
      ? {
        id: elsewhere.id,
        title: elsewhere.title,
        status: elsewhere.status,
        session: await holderSessionName(kernel, elsewhere),
        orphaned: (await orphanReason(kernel, elsewhere)) !== null,
      }
      : null;

  const verdict: StatusVerdict = stop.length > 0
    ? "stop"
    : attention.length > 0
    ? "attention"
    : "ok";
  return {
    verdict,
    problems: [...stop, ...attention],
    next: verdict === "stop"
      ? "Report the problems to the user and change nothing."
      : activeChangeset
      ? `Changeset ${activeChangeset.id} is ${activeChangeset.status}; continue it or complete it before starting another.`
      : heldElsewhere?.orphaned
      ? `Changeset ${heldElsewhere.id} ("${heldElsewhere.title}") was left ` +
        "open by a client that is gone. adopt_changeset continues it here; " +
        "abandon_changeset rewinds it. Ask the user which."
      : heldElsewhere
      ? `Another session${
        heldElsewhere.session ? ` ("${heldElsewhere.session}")` : ""
      } holds changeset ${heldElsewhere.id}; create_changeset is refused ` +
        "with CHANGESET_ACTIVE until it completes or a person abandons it " +
        "from the IDE. Reading is fine."
      : "Run run_tests for a baseline, then create_changeset for any change.",
    doctor,
    counts: memory,
    persisted,
    deadCode,
    activeChangeset,
    heldElsewhere,
    // The project's own rules (set_system_prompt), in full. Server instructions
    // are cut at a client-side length cap (2,048 characters in Claude Code), so
    // this is the one place they always arrive whole.
    projectRules: projectGuide(kernel) || null,
    // The project's enabled skills: instructions the user wrote for any agent
    // working here, as the IDE's agent gets them in its prompt.
    skills: (await kernel.skills.listEnabled()).map((s) => ({
      name: s.name,
      description: s.description,
      prompt: s.prompt,
    })),
    // What define_handler / define_function / define_test refuse. Listed here
    // because the server instructions only have room for the handler list.
    reservedNames: reservedNamesReport(),
    surface: { version: MCP_SURFACE_VERSION },
  };
}

// get_code_context: the same code the closed refuter and criteria reviewer
// read, so an MCP client reviewing a change sees what the gate saw.
async function getCodeContext(
  kernel: Kernel,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const scopes = input.scopes;
  const changesetId = input.changeset_id as string | undefined;
  const claimId = input.claim_id as string | undefined;
  if (scopes !== undefined) {
    if (!Array.isArray(scopes) || !scopes.every((x) => typeof x === "string")) {
      return {
        ok: false,
        error: { code: "INVALID_INPUT", message: "scopes must be strings." },
      };
    }
    return {
      ok: true,
      data: { context: buildChangedScopeContext(kernel, scopes) },
    };
  }
  if (claimId && !changesetId) {
    return {
      ok: false,
      error: {
        code: "INVALID_INPUT",
        message: "claim_id needs changeset_id.",
      },
    };
  }
  if (!changesetId) {
    return { ok: true, data: { context: buildProjectContext(kernel) } };
  }
  const changeset = await kernel.changesets.get(changesetId);
  if (!changeset) {
    return {
      ok: false,
      error: {
        code: "CHANGESET_NOT_FOUND",
        message: `Changeset "${changesetId}" not found.`,
      },
    };
  }
  const changed = await changedScopesOf(kernel, changesetId);
  const context = claimId
    ? buildClaimContext(kernel, changeset, claimId, changed)
    : buildChangedScopeContext(kernel, changed);
  return { ok: true, data: { context } };
}

export async function dispatchTool(
  name: string,
  input: Record<string, unknown>,
  kernel: Kernel,
  rebuild: () => void,
  context?: ChangeContext,
): Promise<ToolResult> {
  const result = await dispatchToolCall(name, input, kernel, rebuild, context);
  if (result.ok) await captureResultDocuments(kernel, name, result, context);
  return result;
}

// The tools whose result carries a changeset whose plan was just written.
const PLAN_WRITING_TOOLS: ReadonlySet<string> = new Set([
  "create_changeset",
  "update_changeset_plan",
  "amend_changeset_plan",
]);

// Keeps a durable document of what a call produced: a changeset's plan, and any
// screenshots. Best-effort: the call already succeeded, so a failed capture is
// logged and the result goes back unchanged.
export async function captureResultDocuments(
  kernel: Kernel,
  name: string,
  result: ToolResult,
  context?: ChangeContext,
): Promise<void> {
  const captures: Array<[string, () => Promise<Result<unknown>>]> = [];
  const changeset = result._changeset as Changeset | undefined;
  if (PLAN_WRITING_TOOLS.has(name) && changeset?.id) {
    captures.push([
      `changeset "${changeset.id}" plan`,
      () => captureChangesetPlanDocument(kernel.documents, changeset),
    ]);
  }
  const images = result._images ?? [];
  const shotId = context?.toolCallId ?? createTimestampedId("shot");
  images.forEach((image, index) => {
    captures.push([
      `screenshot ${index} from ${name}`,
      () =>
        captureScreenshotEvidenceDocument(
          kernel.documents,
          shotId,
          index,
          image.png,
          context?.sessionId,
        ),
    ]);
  });
  for (const [what, capture] of captures) {
    try {
      const captured = await capture();
      if (!captured.ok) {
        kernel.log.log(
          "debug",
          "system",
          `${what} not captured as a document: ` +
            `${captured.error.code} (${captured.error.message})`,
        );
      }
    } catch (err) {
      kernel.log.log(
        "warn",
        "system",
        `Capturing ${what} failed: ${errorMessage(err)}`,
      );
    }
  }
}

async function dispatchToolCall(
  name: string,
  input: Record<string, unknown>,
  kernel: Kernel,
  rebuild: () => void,
  context?: ChangeContext,
): Promise<ToolResult> {
  // Stream A / A1: stamp a binary authorOrigin on every tool-driven mutation
  // once, at this universal choke point, if not already set. manualEdit is the
  // sole human signal today (manual Code-panel save + schema-edit escape hatch);
  // every other tool path is agent-driven. Every changelog.record() below reads
  // the same `context` object (as `ctx`), so this single stamp reaches them all.
  // authorOrigin supersedes manualEdit *semantically*, not mechanically — the
  // changeset gate below still reads manualEdit unchanged.
  if (context && context.authorOrigin === undefined) {
    context.authorOrigin = context.manualEdit ? "human" : "ai";
  }

  if (
    MODIFICATION_TOOLS.has(name) && !CHANGESET_TOOLS.has(name) && context &&
    !context.changesetId &&
    (context.manualEdit || CHANGESET_EXEMPT_TOOLS.has(name))
  ) {
    // Ungated writes (manual saves, exempt verbs) don't need a changeset, but
    // when one is open the write is part of it: stamp it so its footprint and
    // rollback see the change.
    const active = await kernel.activeChangesetId(context.sessionId);
    if (active) context.changesetId = active;
  }

  if (
    MODIFICATION_TOOLS.has(name) && !CHANGESET_EXEMPT_TOOLS.has(name) &&
    !CHANGESET_TOOLS.has(name)
  ) {
    if (!context?.manualEdit) {
      const blocked = () => ({
        ok: false as const,
        error: {
          code: "CHANGESET_REQUIRED",
          message:
            `Tool "${name}" requires an approved changeset. Call create_changeset first to propose your plan, then wait for user approval before making changes.`,
          suggestion:
            "Create or amend a changeset, then STOP and wait for the user to approve it.",
        },
      });
      let governing: Changeset | null | undefined;
      if (context?.changesetId) {
        governing = await kernel.changesets.get(context.changesetId);
        if (governing?.status !== "in_progress") {
          return blocked();
        }
      } else {
        governing = await kernel.changesets.getActive(context?.sessionId);
        if (governing?.status !== "in_progress") {
          return blocked();
        }
        if (context) context.changesetId = governing.id;
      }
      if (!context?.changesetId) {
        return blocked();
      }
      // Proportional verification: a light-lane changeset traded ceremony for a
      // NARROWED surface, and this is where that narrowing is enforced. Refusing the
      // first out-of-budget call — before the write lands — is what makes the reduced
      // gate sound: the relaxation rests on what the kernel will let the changeset
      // do, not on the model's declaration being honest. Reads the already-fetched
      // changeset and a core-local map, so the hot path touches no composition seam
      // (verificationTools() throws in a core-only assembly).
      if (
        governing.plan.changeClass?.effective === "light" &&
        !isTierExempt(name) && mutationToolTier(name) !== "light"
      ) {
        return {
          ok: false,
          error: {
            code: "CHANGE_CLASS_EXCEEDED",
            message:
              `Tool "${name}" is outside the light verification lane this changeset ` +
              `was approved under. The light lane covers small, low-blast-radius ` +
              `edits; "${name}" touches a structural surface (routes, schemas, SQL, ` +
              `secrets, env vars, packages, snapshots) or deletes a code entity.`,
            suggestion:
              "Call amend_changeset_plan with the added scope, then STOP. Amending " +
              "moves the changeset out of the light lane and back to `planning`, so " +
              "the user must approve it again before this tool will run.",
          },
        };
      }
    }
  }

  if (AUTO_SNAPSHOT_TOOLS.has(name)) {
    await kernel.snapshots.save(kernel, `auto: before ${name}`);
  }

  // Periodic database backup, taken BEFORE the mutation rather than after it: the
  // useful copy is the last known-good state, and a pre-write backup is the one that
  // exists when the write is what went wrong. Interval-guarded in backup-cadence.ts,
  // so this costs one dump per DB_BACKUP_INTERVAL_MS, not one per call.
  //
  // This is the only backup an MCP session gets. The IDE has its own trigger (a
  // completed chat turn, control-server.ts) and both go through the same clock; a
  // headless session has no turns, and relies on a clean exit for everything else.
  if (isMutationTool(name) && kernel.projectDir) {
    await maybePeriodicBackup(kernel, kernel.projectDir);
    // Checkpoint on its own, much shorter clock. Taken here, before the mutation, it
    // flushes everything up to the PREVIOUS call — which is the point: an unclean exit
    // on PGlite does not merely lose the unflushed writes, it loses the data directory,
    // so what matters is that the gap is bounded, not which side of this call it falls
    // on. A headless session relying on a clean exit for this is how four data
    // directories were lost.
    await maybePeriodicCheckpoint(kernel, kernel.projectDir);
  }

  const deps = await kernel.compileDeps();

  const ctx = context ?? null;

  switch (name) {
    // --- Inspection ---

    case "list_routes":
      return { ok: true, data: kernel.routes.list() };

    // --- Consolidated multiplexers (surface v5.0.0) ---

    case "edit_entity_text": {
      const entityType = input.type as string;
      const entityName = input.name as string;
      const rawEdits = input.edits;
      if (!Array.isArray(rawEdits)) {
        return {
          ok: false,
          error: {
            code: "INVALID_INPUT",
            message: "`edits` must be an array of { find, replace, count? }.",
          },
        };
      }
      const edits: TextEdit[] = [];
      for (const raw of rawEdits) {
        const edit = normalizeTextEdit(raw);
        if (!edit) {
          return {
            ok: false,
            error: {
              code: "INVALID_INPUT",
              message:
                "Each edit needs a non-empty string `find`, a string `replace`, " +
                "and an optional positive integer `count`.",
            },
          };
        }
        edits.push(edit);
      }

      // Read current content. Only text-bearing entities are supported — a binary
      // asset has no meaningful string to search.
      let current: string;
      let mimeType = "";
      if (entityType === "template") {
        const found = kernel.templates.get(entityName);
        if (found === undefined) {
          return {
            ok: false,
            error: {
              code: "TEMPLATE_NOT_FOUND",
              message: `Template "${entityName}" is not registered.`,
            },
          };
        }
        current = found;
      } else if (entityType === "text_asset") {
        const asset = kernel.assets.get(entityName);
        if (!asset) {
          return {
            ok: false,
            error: {
              code: "ASSET_NOT_FOUND",
              message: `Asset "${entityName}" is not registered.`,
            },
          };
        }
        mimeType = asset.mimeType;
        try {
          current = new TextDecoder("utf-8", { fatal: true }).decode(
            asset.content,
          );
        } catch {
          return {
            ok: false,
            error: {
              code: "ASSET_NOT_TEXT",
              message:
                `Asset "${entityName}" (${asset.mimeType}) is not valid UTF-8 text.`,
              suggestion: "Use upload_asset to replace a binary asset.",
            },
          };
        }
      } else {
        return {
          ok: false,
          error: {
            code: "INVALID_TYPE",
            message:
              `edit_entity_text: unsupported type "${entityType}". Valid types: ` +
              "template, text_asset.",
          },
        };
      }

      const edited = applyTextEdits(current, edits);
      if (!edited.ok) return edited;

      // Delegate to the full-content verb under ITS OWN name, exactly as
      // remove_entity delegates. That is what keeps QC, changelog recording, the
      // auto-snapshot and the changeset/change-class gate working here with zero
      // duplication — this verb saves output tokens, it does not bypass governance.
      return await dispatchToolCall(
        entityType === "template" ? "define_template" : "upload_text_asset",
        {
          name: entityName,
          content: edited.data,
          ...(entityType === "text_asset" ? { mimeType } : {}),
          rationale: input.rationale,
          implementation: input.implementation,
        },
        kernel,
        rebuild,
        context,
      );
    }

    case "remove_entity": {
      const entityType = input.type as string;
      const key = input.key as string;
      const spec = REMOVE_ENTITY_MAP[entityType];
      if (!spec) {
        return {
          ok: false,
          error: {
            code: "INVALID_TYPE",
            message:
              `remove_entity: unsupported type "${entityType}". Valid types: ${
                Object.keys(REMOVE_ENTITY_MAP).join(", ")
              }.`,
          },
        };
      }
      // Delegate to the per-entity removal verb, carrying the rationale fields
      // through. The delegate re-enters the gate under its own name; the active
      // changeset is already resolved on `context`, so it passes cleanly.
      return await dispatchToolCall(
        spec.tool,
        {
          ...spec.toInput(key),
          rationale: input.rationale,
          implementation: input.implementation,
        },
        kernel,
        rebuild,
        context,
      );
    }

    case "analyze": {
      const kind = input.kind as string;
      const tool = ANALYZE_KIND_MAP[kind];
      if (!tool) {
        return {
          ok: false,
          error: {
            code: "INVALID_KIND",
            message: `analyze: unsupported kind "${kind}". Valid kinds: ${
              Object.keys(ANALYZE_KIND_MAP).join(", ")
            }.`,
          },
        };
      }
      return await dispatchToolCall(tool, input, kernel, rebuild, context);
    }

    case "list_handlers": {
      const one = input.name as string | undefined;
      if (one) {
        const entry = kernel.handlers.get(one);
        if (!entry) {
          return {
            ok: false,
            error: {
              code: "NOT_FOUND",
              message: `Handler "${one}" not found.`,
            },
          };
        }
        return {
          ok: true,
          data: {
            name: entry.name,
            source: entry.source,
            registeredAt: entry.registeredAt,
            ...(entry.schema ? { schema: entry.schema } : {}),
            ...(entry.module ? { module: entry.module } : {}),
            ...(entry.purpose ? { purpose: entry.purpose } : {}),
            ...(entry.runtimeId ? { runtimeId: entry.runtimeId } : {}),
            ...(entry.language ? { language: entry.language } : {}),
          },
        };
      }
      return {
        ok: true,
        data: kernel.handlers.list().map((h) =>
          entitySummary(h, {
            ...(h.language ? { language: h.language } : {}),
            ...(h.runtimeId ? { runtimeId: h.runtimeId } : {}),
            hasSchema: Boolean(h.schema),
          })
        ),
      };
    }

    case "get_handler_source": {
      const entry = kernel.handlers.get(input.handlerName as string);
      if (!entry) {
        return {
          ok: false,
          error: {
            code: "NOT_FOUND",
            message: `Handler "${input.handlerName}" not found.`,
          },
        };
      }
      return {
        ok: true,
        data: {
          name: entry.name,
          source: entry.source,
          registeredAt: entry.registeredAt,
          ...(entry.schema ? { schema: entry.schema } : {}),
          ...(entry.module ? { module: entry.module } : {}),
          ...(entry.purpose ? { purpose: entry.purpose } : {}),
        },
      };
    }

    case "list_functions": {
      const one = input.name as string | undefined;
      if (one) {
        const entry = kernel.functions.getEntry(one);
        if (!entry) {
          return {
            ok: false,
            error: {
              code: "NOT_FOUND",
              message: `Function "${one}" not found.`,
            },
          };
        }
        return {
          ok: true,
          data: {
            name: entry.name,
            source: entry.source,
            registeredAt: entry.registeredAt,
            ...(entry.returnType ? { returnType: entry.returnType } : {}),
            ...(entry.module ? { module: entry.module } : {}),
            ...(entry.purpose ? { purpose: entry.purpose } : {}),
          },
        };
      }
      return {
        ok: true,
        data: kernel.functions.list().map((f) =>
          entitySummary(f, f.returnType ? { returnType: f.returnType } : {})
        ),
      };
    }

    case "get_function_source": {
      const entry = kernel.functions.getEntry(input.functionName as string);
      if (!entry) {
        return {
          ok: false,
          error: {
            code: "NOT_FOUND",
            message: `Function "${input.functionName}" not found.`,
          },
        };
      }
      return {
        ok: true,
        data: {
          name: entry.name,
          source: entry.source,
          registeredAt: entry.registeredAt,
          ...(entry.returnType ? { returnType: entry.returnType } : {}),
          ...(entry.module ? { module: entry.module } : {}),
          ...(entry.purpose ? { purpose: entry.purpose } : {}),
        },
      };
    }

    case "find_similar_entities": {
      const kind = input.kind as string;
      if (kind !== "function" && kind !== "handler") {
        return {
          ok: false,
          error: {
            code: "INVALID_KIND",
            message:
              'find_similar_entities currently supports kind "function" or "handler".',
          },
        };
      }
      const candidates = findSimilarEntities(
        {
          kind,
          name: input.name as string,
          purpose: input.purpose as string | undefined,
          source: input.source as string | undefined,
          module: input.module as string | undefined,
        },
        allSimilarEntities(kernel),
        { excludeSameName: true },
      );
      return { ok: true, data: { candidates } };
    }

    case "list_schemas":
      return { ok: true, data: await kernel.db.listSchemas() };

    case "get_schema":
      return await kernel.db.getSchema(input.tableName as string);

    case "query_database": {
      try {
        const rows = await kernel.db.query(
          input.sql as string,
          (input.params as unknown[]) ?? [],
        );
        return { ok: true, data: { rows, count: rows.length } };
      } catch (err) {
        return {
          ok: false,
          error: { code: "QUERY_ERROR", message: errorMessage(err) },
        };
      }
    }

    case "doctor_project": {
      const projectDir = kernel.projectDir;
      if (!projectDir) {
        return {
          ok: false,
          error: {
            code: "NO_PROJECT",
            message: "No project directory available.",
          },
        };
      }
      const report = await doctorProject(projectDir, kernel.db);
      return {
        ok: true,
        data: {
          ...report,
          message: report.ok
            ? "Project consistency check passed."
            : `Project consistency check found ${report.errors.length} error${
              report.errors.length === 1 ? "" : "s"
            } and ${report.warnings.length} warning${
              report.warnings.length === 1 ? "" : "s"
            }.`,
        },
      };
    }

    case "project_status":
      return { ok: true, data: await projectStatus(kernel, context) };

    case "git_status": {
      try {
        return {
          ok: true,
          data: gitStatus(
            requireProjectDir(kernel),
            () => flushKernelProjectState(kernel),
          ),
        };
      } catch (err) {
        return gitToolError(err);
      }
    }

    case "git_init": {
      try {
        return { ok: true, data: gitInit(requireProjectDir(kernel)) };
      } catch (err) {
        return gitToolError(err);
      }
    }

    case "git_add_tide_gitignore": {
      try {
        return {
          ok: true,
          data: gitAddTideGitignore(requireProjectDir(kernel)),
        };
      } catch (err) {
        return gitToolError(err);
      }
    }

    case "git_set_remote": {
      try {
        return {
          ok: true,
          data: gitSetRemote(
            requireProjectDir(kernel),
            input.url as string,
            input.name as string | undefined,
          ),
        };
      } catch (err) {
        return gitToolError(err);
      }
    }

    case "git_commit": {
      if (typeof input.changeset_id === "string") {
        return await commitChangesetPaths(kernel, input);
      }
      try {
        const projectDir = requireProjectDir(kernel);
        // A caller that wants a better subject writes the message itself.
        const resolvedMessage = resolveGitCommitMessage(
          projectDir,
          input.message as string | undefined,
          () => flushKernelProjectState(kernel),
        );
        return {
          ok: true,
          data: gitCommit(projectDir, resolvedMessage.message),
        };
      } catch (err) {
        return gitToolError(err);
      }
    }

    case "git_push": {
      try {
        return {
          ok: true,
          data: gitPush(
            requireProjectDir(kernel),
            input.name as string | undefined,
            input.branch as string | undefined,
            () => flushKernelProjectState(kernel),
          ),
        };
      } catch (err) {
        return gitToolError(err);
      }
    }

    case "list_configs":
      return { ok: true, data: kernel.configs.list() };

    case "get_config": {
      const entry = kernel.configs.getEntry(input.name as string);
      if (!entry) {
        return {
          ok: false,
          error: {
            code: "NOT_FOUND",
            message: `Config "${input.name}" not found.`,
          },
        };
      }
      return { ok: true, data: entry };
    }

    case "get_logs":
      return {
        ok: true,
        data: kernel.log.query({
          level: input.level as string | undefined,
          source: input.source as string | undefined,
          limit: (input.limit as number) ?? 50,
          search: input.search as string | undefined,
        }),
      };

    case "get_recent_errors":
      return {
        ok: true,
        data: kernel.log.query({
          level: "error",
          limit: (input.limit as number) ?? 20,
        }),
      };

    case "get_recent_requests":
      return {
        ok: true,
        data: kernel.requestLog.recent((input.limit as number) ?? 20),
      };

    // --- Codebase Index (source-backed project import) ---

    case "index_codebase": {
      const rootPath = (input.rootPath as string | undefined) ??
        kernel.projectDir;
      const classificationMode = (input.classification as string | undefined) ??
        "off";
      if (classificationMode !== "off" && classificationMode !== "assist") {
        return {
          ok: false,
          error: {
            code: "INVALID_CLASSIFICATION",
            message:
              `Invalid index_codebase classification mode "${classificationMode}".`,
            suggestion: 'Use "off" or "assist".',
          },
        };
      }
      if (!rootPath) {
        return {
          ok: false,
          error: {
            code: "NO_PROJECT",
            message:
              "No rootPath provided and no project directory is loaded to index.",
            suggestion:
              "Open a project or pass an explicit rootPath to index_codebase.",
          },
        };
      }
      try {
        // projectId labels the graph; the loaded project has no separate id, so
        // key it by its root path (stable for a given project on this machine).
        const { graph, discovery, sourceIndex } =
          await indexSourceBackedCodebase({
            projectId: kernel.projectDir ?? rootPath,
            rootPath,
          });
        // Cache the full graph so GET /api/codebase can serve it without re-indexing.
        kernel.codebaseGraph = graph;
        // Classification runs on the client's model: assist mode leaves the
        // classifier's input for request_review kind "imports".
        kernel.codebaseClassification = classificationMode === "assist"
          ? {
            graph,
            request: buildImportClassifierRequest({
              graph,
              discovery,
              sourceIndex,
            }),
          }
          : null;
        const classification = classificationMode === "assist"
          ? {
            status: "review_owed" as const,
            reason:
              'Classify with request_review kind "imports", then submit_review.',
          }
          : { status: "not_requested" as const };
        const summary = summarizeCodebaseGraph(graph, discovery);
        return {
          ok: true,
          data: {
            ...summary,
            classification,
            message: `Indexed ${summary.counts.files} file(s) at ${rootPath} ` +
              `(package manager: ${summary.packageManager}` +
              (summary.frameworks.length
                ? `, frameworks: ${summary.frameworks.join(", ")}`
                : "") +
              ").",
          },
        };
      } catch (err) {
        return {
          ok: false,
          error: {
            code: "INDEX_FAILED",
            message: `Failed to index codebase at ${rootPath}: ${
              errorMessage(err)
            }`,
            suggestion:
              "Confirm the path exists and is readable, then retry index_codebase.",
          },
        };
      }
    }

    // --- Modification (with changelog) ---

    case "define_handler": {
      const handlerName = input.name as string;
      const source = input.source as string;
      const reservedHandler = reservedNameError("handler", handlerName);
      if (reservedHandler) return { ok: false, error: reservedHandler };
      const handlerSchema = input.schema as RouteSchema | undefined;
      const purpose = input.purpose as string | undefined;
      const duplicateJustification = input.duplicateJustification as
        | string
        | undefined;
      const existing = kernel.handlers.get(handlerName);
      const before = existing
        ? {
          name: existing.name,
          source: existing.source,
          schema: existing.schema,
          module: existing.module,
          purpose: existing.purpose,
          runtimeId: existing.runtimeId,
          language: existing.language,
        }
        : null;
      // Optimistic concurrency (docs/lsp-support-plan.md Stage 5): an
      // expectedRevision from a client that opened this entity earlier. If the
      // registry's current revision has moved on, someone wrote in between — refuse
      // rather than clobber. Absent ⇒ last-writer-wins (existing callers unaffected).
      const staleWrite = checkExpectedRevision(
        input,
        existing?.revision,
        "Handler",
      );
      if (staleWrite) return staleWrite;

      const resolvedSchema = handlerSchema ?? existing?.schema;
      const module = inferModule(input, kernel) ?? existing?.module;
      const resolvedPurpose = purpose ?? existing?.purpose;
      const duplicateCandidates = findSimilarEntities(
        {
          kind: "handler",
          name: handlerName,
          source,
          schema: resolvedSchema,
          module,
          purpose: resolvedPurpose,
        },
        allSimilarEntities(kernel),
        { excludeSameName: true },
      );
      const blockedCandidates = duplicateCandidates.filter((candidate) =>
        candidate.score >= DUPLICATE_BLOCK_THRESHOLD
      );
      if (blockedCandidates.length > 0 && !duplicateJustification) {
        return {
          ok: false,
          data: { candidates: blockedCandidates },
          error: {
            code: "POSSIBLE_DUPLICATE_ENTITY",
            message:
              `Handler "${handlerName}" appears to duplicate an existing entity.`,
            suggestion:
              "Reuse or update an existing handler, or retry with duplicateJustification explaining why a separate handler is required.",
          },
        };
      }

      const result = await compileRuntimeHandler(
        kernel,
        handlerName,
        source,
        deps,
      );
      if (!result.ok) return result;

      const qc = await runQC(source, "handler");
      if (!qc.passed) {
        return {
          ok: false,
          error: {
            code: "QC_FAILED",
            message: `Quality checks failed:\n${formatIssues(qc.issues)}`,
            suggestion: "Fix the issues and try again.",
          },
        };
      }

      const depWarnings = checkDependants(
        handlerName,
        "handler",
        before?.source ?? null,
        source,
        allEntitySources(kernel),
      );

      const sourceRuntime = sourceRuntimeMetadata(kernel, existing);
      kernel.handlers.register(
        handlerName,
        source,
        result.data,
        resolvedSchema,
        module,
        sourceRuntime.runtimeId,
        sourceRuntime.language,
        resolvedPurpose,
      );
      rebuild();

      await kernel.changelog.record({
        category: "handler",
        key: handlerName,
        action: before ? "update" : "create",
        beforeSnapshot: before,
        afterSnapshot: {
          name: handlerName,
          source,
          ...(resolvedSchema ? { schema: resolvedSchema } : {}),
          ...(module ? { module } : {}),
          ...(resolvedPurpose ? { purpose: resolvedPurpose } : {}),
          ...(duplicateJustification
            ? {
              duplicateJustification,
              duplicateCandidates: blockedCandidates.length
                ? blockedCandidates
                : duplicateCandidates,
            }
            : {}),
          ...sourceRuntime,
        },
        context: ctx,
      });

      // Announce the accepted write so an out-of-band observer (the LSP server) can
      // refresh an open document (Stage 5). Fire after the registry mutation +
      // changelog record, reading the entry's freshly-bumped revision.
      kernel.notifyEntityChange({
        entityType: "handler",
        entityName: handlerName,
        revision: kernel.handlers.get(handlerName)?.revision ?? 0,
      });

      const tsDiag = getTypeDiagnostics("handler", handlerName, kernel);

      const notes: string[] = [];
      if (qc.issues.length) notes.push(`QC: ${qc.summary}`);
      if (depWarnings.length) notes.push(formatDepWarnings(depWarnings));
      if (tsDiag) notes.push(tsDiag);
      const suffix = notes.length ? "\n" + notes.join("\n") : "";
      return {
        ok: true,
        data: {
          name: handlerName,
          qc: qc.summary,
          dependencyWarnings: depWarnings,
          duplicateCandidates,
          ...(duplicateJustification ? { duplicateJustification } : {}),
          tsDiagnostics: tsDiag,
          message:
            `Handler "${handlerName}" defined and routes rebuilt.${suffix}`,
        },
      };
    }

    case "define_function": {
      const fnName = input.name as string;
      const source = input.source as string;
      const reservedFunction = reservedNameError("function", fnName);
      if (reservedFunction) return { ok: false, error: reservedFunction };
      const returnType = input.returnType as string | undefined;
      const purpose = input.purpose as string | undefined;
      const duplicateJustification = input.duplicateJustification as
        | string
        | undefined;
      const existing = kernel.functions.getEntry(fnName);
      const before = existing
        ? {
          name: existing.name,
          source: existing.source,
          module: existing.module,
          returnType: existing.returnType,
          purpose: existing.purpose,
          runtimeId: existing.runtimeId,
          language: existing.language,
        }
        : null;
      const staleWrite = checkExpectedRevision(
        input,
        existing?.revision,
        "Function",
      );
      if (staleWrite) return staleWrite;

      const module = inferModule(input, kernel) ?? existing?.module;
      const resolvedReturnType = returnType ?? existing?.returnType;
      const resolvedPurpose = purpose ?? existing?.purpose;
      const duplicateCandidates = findSimilarEntities(
        {
          kind: "function",
          name: fnName,
          source,
          returnType: resolvedReturnType,
          module,
          purpose: resolvedPurpose,
        },
        allSimilarEntities(kernel),
        { excludeSameName: true },
      );
      const blockedCandidates = duplicateCandidates.filter((candidate) =>
        candidate.score >= DUPLICATE_BLOCK_THRESHOLD
      );
      if (blockedCandidates.length > 0 && !duplicateJustification) {
        return {
          ok: false,
          data: { candidates: blockedCandidates },
          error: {
            code: "POSSIBLE_DUPLICATE_ENTITY",
            message:
              `Function "${fnName}" appears to duplicate an existing entity.`,
            suggestion:
              "Reuse or update an existing function, or retry with duplicateJustification explaining why a separate function is required.",
          },
        };
      }

      const result = await compileRuntimeFunction(kernel, fnName, source, deps);
      if (!result.ok) return result;

      const qc = await runQC(source, "function");
      if (!qc.passed) {
        return {
          ok: false,
          error: {
            code: "QC_FAILED",
            message: `Quality checks failed:\n${formatIssues(qc.issues)}`,
            suggestion: "Fix the issues and try again.",
          },
        };
      }

      const depWarnings = checkDependants(
        fnName,
        "function",
        before?.source ?? null,
        source,
        allEntitySources(kernel),
      );

      const sourceRuntime = sourceRuntimeMetadata(kernel, existing);
      kernel.functions.register(
        fnName,
        source,
        result.data,
        module,
        resolvedReturnType,
        sourceRuntime.runtimeId,
        sourceRuntime.language,
        resolvedPurpose,
      );

      await kernel.changelog.record({
        category: "function",
        key: fnName,
        action: before ? "update" : "create",
        beforeSnapshot: before,
        afterSnapshot: {
          name: fnName,
          source,
          ...(resolvedReturnType ? { returnType: resolvedReturnType } : {}),
          ...(module ? { module } : {}),
          ...(resolvedPurpose ? { purpose: resolvedPurpose } : {}),
          ...(duplicateJustification
            ? {
              duplicateJustification,
              duplicateCandidates: blockedCandidates.length
                ? blockedCandidates
                : duplicateCandidates,
            }
            : {}),
          ...sourceRuntime,
        },
        context: ctx,
      });

      kernel.notifyEntityChange({
        entityType: "function",
        entityName: fnName,
        revision: kernel.functions.getEntry(fnName)?.revision ?? 0,
      });

      const tsDiag = getTypeDiagnostics("function", fnName, kernel);

      const notes: string[] = [];
      if (qc.issues.length) notes.push(`QC: ${qc.summary}`);
      if (depWarnings.length) notes.push(formatDepWarnings(depWarnings));
      if (tsDiag) notes.push(tsDiag);
      const suffix = notes.length ? "\n" + notes.join("\n") : "";
      return {
        ok: true,
        data: {
          name: fnName,
          returnType: resolvedReturnType,
          qc: qc.summary,
          dependencyWarnings: depWarnings,
          duplicateCandidates,
          ...(duplicateJustification ? { duplicateJustification } : {}),
          tsDiagnostics: tsDiag,
          message: `Function "${fnName}" defined.${suffix}`,
        },
      };
    }

    case "register_route": {
      const handlerName = input.handlerName as string;
      const handler = kernel.handlers.get(handlerName);
      if (!handler?.fn) {
        return {
          ok: false,
          error: {
            code: "NOT_FOUND",
            message:
              `Handler "${handlerName}" not found. Define it first with define_handler.`,
          },
        };
      }

      const method = input.method as string;
      const path = input.path as string;
      const explicitSchema = input.schema as RouteSchema | undefined;
      const schema = explicitSchema ?? handler.schema;
      const routeKey = `${method.toUpperCase()} ${path}`;
      const existing = kernel.routes.get(method, path);
      const before = existing
        ? {
          method: existing.method,
          path: existing.path,
          handlerName: existing.handlerName,
          schema: existing.schema,
        }
        : null;

      const module = inferModule(input, kernel) ?? existing?.module;
      kernel.routes.register(method, path, handlerName, schema, module);
      rebuild();

      await kernel.changelog.record({
        category: "route",
        key: routeKey,
        action: before ? "update" : "create",
        beforeSnapshot: before,
        afterSnapshot: {
          method: method.toUpperCase(),
          path,
          handlerName,
          ...(schema ? { schema } : {}),
          ...(module ? { module } : {}),
        },
        context: ctx,
      });

      const schemaSource = explicitSchema
        ? "route"
        : handler.schema
        ? "handler"
        : null;
      return {
        ok: true,
        data: {
          method,
          path,
          handlerName,
          hasSchema: !!schema,
          schemaSource,
          message: `Route registered.${
            schemaSource === "handler" ? " Schema inherited from handler." : ""
          }`,
        },
      };
    }

    case "unregister_route": {
      const method = input.method as string;
      const path = input.path as string;
      const routeKey = `${method.toUpperCase()} ${path}`;
      const existing = kernel.routes.get(method, path);

      const removed = kernel.routes.unregister(method, path);
      if (!removed) {
        return {
          ok: false,
          error: {
            code: "NOT_FOUND",
            message: `Route ${method} ${path} not found.`,
          },
        };
      }
      rebuild();

      await kernel.changelog.record({
        category: "route",
        key: routeKey,
        action: "delete",
        beforeSnapshot: existing
          ? {
            method: existing.method,
            path: existing.path,
            handlerName: existing.handlerName,
          }
          : null,
        afterSnapshot: null,
        context: ctx,
      });

      return { ok: true, data: { method, path, message: "Route removed." } };
    }

    case "define_schema": {
      const module = inferModule(input, kernel);
      const result = await kernel.db.defineSchema(
        input.tableName as string,
        input.sql as string,
        module,
        migrationProvenance(ctx),
      );

      if (result.ok) {
        await kernel.changelog.record({
          category: "schema",
          key: input.tableName as string,
          action: "create",
          beforeSnapshot: null,
          afterSnapshot: { tableName: input.tableName, sql: input.sql, module },
          context: ctx,
          undoable: false,
        });

        const conventions = validateSchemaConventions(
          result.data.columns,
          input.sql as string,
        );
        if (conventions.length > 0) {
          return {
            ok: true,
            data: {
              ...result.data,
              _warnings: conventions.map((w) => `⚠ ${w}`).join("\n"),
            },
          };
        }
      }

      return result;
    }

    case "alter_schema": {
      const tableName = input.tableName as string;
      const module = inferModule(input, kernel);
      const result = await kernel.db.alterSchema(
        tableName,
        input.sql as string,
        module,
        migrationProvenance(ctx),
      );

      if (result.ok) {
        const migration = result.data.migration;
        await kernel.changelog.record({
          category: "schema",
          key: tableName,
          action: "update",
          beforeSnapshot: { tableName, sql: result.data.previousSql },
          afterSnapshot: {
            tableName,
            // Cumulative table DDL after the alter (base CREATE TABLE + this and
            // prior statements), not just `input.sql`. Diffing the previous
            // cumulative against the incremental statement rendered the whole
            // CREATE TABLE as deleted; diffing cumulative-before vs -after shows
            // an ALTER/CREATE INDEX as the addition it actually is.
            sql: result.data.sql,
            ...(migration ? alterStatementSnapshot(migration) : {}),
          },
          context: ctx,
          undoable: false,
        });
      }

      return result;
    }

    case "drop_schema": {
      const tableName = input.tableName as string;
      const oldSchema = await kernel.db.getSchema(tableName);
      const beforeSql = oldSchema.ok ? oldSchema.data.sql : null;

      const result = await kernel.db.dropSchema(
        tableName,
        migrationProvenance(ctx),
      );

      if (result.ok) {
        await kernel.changelog.record({
          category: "schema",
          key: tableName,
          action: "delete",
          beforeSnapshot: beforeSql ? { tableName, sql: beforeSql } : null,
          afterSnapshot: null,
          context: ctx,
          undoable: false,
        });
      }

      return result;
    }

    case "execute_sql": {
      try {
        const result = await kernel.db.execute(
          input.sql as string,
          (input.params as unknown[]) ?? [],
        );

        await kernel.changelog.record({
          category: "sql",
          key: (input.sql as string).slice(0, 100),
          action: "execute",
          beforeSnapshot: null,
          afterSnapshot: {
            sql: input.sql,
            params: input.params ?? [],
            changes: result.changes,
          },
          context: ctx,
          undoable: false,
        });

        return { ok: true, data: result };
      } catch (err) {
        return {
          ok: false,
          error: { code: "SQL_ERROR", message: errorMessage(err) },
        };
      }
    }

    // --- App Config ---

    case "set_config": {
      const configName = input.name as string;
      const existing = kernel.configs.getEntry(configName);
      const before = existing
        ? {
          name: existing.name,
          value: existing.value,
          description: existing.description,
        }
        : null;

      try {
        kernel.configs.set(
          configName,
          input.value,
          input.description as string | undefined,
          input.module as string | undefined,
        );
      } catch (err) {
        return {
          ok: false,
          error: {
            code: "INVALID_CONFIG_VALUE",
            message: errorMessage(err),
          },
        };
      }

      await kernel.changelog.record({
        category: "config",
        key: configName,
        action: before ? "update" : "create",
        beforeSnapshot: before,
        afterSnapshot: {
          name: configName,
          value: input.value,
          description: input.description,
        },
        context: ctx,
      });

      return {
        ok: true,
        data: {
          name: configName,
          message: before ? "Config updated." : "Config created.",
        },
      };
    }

    case "delete_config": {
      const configName = input.name as string;
      const existing = kernel.configs.getEntry(configName);

      const removed = kernel.configs.delete(configName);
      if (!removed) {
        return {
          ok: false,
          error: {
            code: "NOT_FOUND",
            message: `Config "${configName}" not found.`,
          },
        };
      }

      await kernel.changelog.record({
        category: "config",
        key: configName,
        action: "delete",
        beforeSnapshot: existing
          ? {
            name: existing.name,
            value: existing.value,
            description: existing.description,
          }
          : null,
        afterSnapshot: null,
        context: ctx,
      });

      return {
        ok: true,
        data: { name: configName, message: "Config deleted." },
      };
    }

    // --- Templates ---

    case "define_template": {
      const templateName = input.name as string;
      const content = input.content as string;
      const existing = kernel.templates.getEntry(templateName);
      const before = existing
        ? { name: existing.name, content: existing.content }
        : null;

      const qc = await runQC(content, "template");
      if (!qc.passed) {
        return {
          ok: false,
          error: {
            code: "QC_FAILED",
            message: `Quality checks failed:\n${formatIssues(qc.issues)}`,
            suggestion: "Fix the issues and try again.",
          },
        };
      }

      const module = inferModule(input, kernel) ?? existing?.module;
      kernel.templates.register(templateName, content, module);

      await kernel.changelog.record({
        category: "template",
        key: templateName,
        action: before ? "update" : "create",
        beforeSnapshot: before,
        afterSnapshot: {
          name: templateName,
          content,
          ...(module ? { module } : {}),
        },
        context: ctx,
      });

      const qcNote = qc.issues.length ? `\nQC: ${qc.summary}` : "";
      return {
        ok: true,
        data: {
          name: templateName,
          qc: qc.summary,
          message:
            `Template "${templateName}" defined. Access it in handlers with \`templates.get("${templateName}")\`.${qcNote}`,
        },
      };
    }

    case "list_templates": {
      const one = input.name as string | undefined;
      if (one) {
        const entry = kernel.templates.getEntry(one);
        if (!entry) {
          return {
            ok: false,
            error: {
              code: "NOT_FOUND",
              message: `Template "${one}" not found.`,
            },
          };
        }
        return {
          ok: true,
          data: {
            name: entry.name,
            content: entry.content,
            registeredAt: entry.registeredAt,
          },
        };
      }
      return {
        ok: true,
        data: kernel.templates.list().map((t) => ({
          name: t.name,
          size: t.content.length,
          registeredAt: t.registeredAt,
        })),
      };
    }

    case "get_template": {
      const entry = kernel.templates.getEntry(input.name as string);
      if (!entry) {
        return {
          ok: false,
          error: {
            code: "NOT_FOUND",
            message: `Template "${input.name}" not found.`,
          },
        };
      }
      return {
        ok: true,
        data: {
          name: entry.name,
          content: entry.content,
          registeredAt: entry.registeredAt,
        },
      };
    }

    case "delete_template": {
      const templateName = input.name as string;
      const existing = kernel.templates.getEntry(templateName);
      if (!existing) {
        return {
          ok: false,
          error: {
            code: "NOT_FOUND",
            message: `Template "${templateName}" not found.`,
          },
        };
      }

      kernel.templates.remove(templateName);

      await kernel.changelog.record({
        category: "template",
        key: templateName,
        action: "delete",
        beforeSnapshot: { name: existing.name, content: existing.content },
        afterSnapshot: null,
        context: ctx,
      });

      return {
        ok: true,
        data: {
          name: templateName,
          message: `Template "${templateName}" deleted.`,
        },
      };
    }

    // --- Assets ---

    case "upload_text_asset": {
      const assetName = input.name as string;
      const textContent = input.content as string;
      const mimeType = input.mimeType as string;
      const existing = kernel.assets.get(assetName);
      const before = existing
        ? {
          name: existing.name,
          mimeType: existing.mimeType,
          size: existing.size,
        }
        : null;

      const qcKind: QCKind | null = mimeType.includes("css")
        ? "css"
        : mimeType.includes("javascript")
        ? "js"
        : null;
      let qcNote = "";
      if (qcKind) {
        const qc = await runQC(textContent, qcKind);
        if (!qc.passed) {
          return {
            ok: false,
            error: {
              code: "QC_FAILED",
              message: `Quality checks failed:\n${formatIssues(qc.issues)}`,
              suggestion: "Fix the issues and try again.",
            },
          };
        }
        if (qc.issues.length) qcNote = `\nQC: ${qc.summary}`;
      }

      const module = inferModule(input, kernel) ?? existing?.module;
      const unsafe = unsafeAssetSegment(assetName, module);
      if (unsafe) return unsafe;
      const content = new TextEncoder().encode(textContent);
      kernel.assets.register(assetName, content, mimeType, module);
      rebuild();

      await kernel.changelog.record({
        category: "asset",
        key: assetName,
        action: before ? "update" : "create",
        ...assetChangeSnapshots(
          kernel,
          existing,
          kernel.assets.get(assetName),
        ),
        context: ctx,
      });

      return {
        ok: true,
        data: {
          name: assetName,
          size: content.byteLength,
          url: `/_assets/${assetName}`,
          message:
            `Asset "${assetName}" uploaded (${content.byteLength} bytes). Serve at /_assets/${assetName}${qcNote}`,
        },
      };
    }

    case "upload_asset": {
      const assetName = input.name as string;
      const contentBase64 = input.contentBase64 as string;
      const mimeType = input.mimeType as string;
      const existing = kernel.assets.get(assetName);
      const before = existing
        ? {
          name: existing.name,
          mimeType: existing.mimeType,
          size: existing.size,
        }
        : null;

      let content: Uint8Array;
      try {
        const binary = atob(contentBase64);
        content = Uint8Array.from(binary, (c) => c.charCodeAt(0));
      } catch {
        return {
          ok: false,
          error: {
            code: "INVALID_BASE64",
            message: "Content is not valid base64.",
          },
        };
      }

      const module = inferModule(input, kernel) ?? existing?.module;
      const unsafe = unsafeAssetSegment(assetName, module);
      if (unsafe) return unsafe;
      kernel.assets.register(assetName, content, mimeType, module);
      rebuild();

      await kernel.changelog.record({
        category: "asset",
        key: assetName,
        action: before ? "update" : "create",
        ...assetChangeSnapshots(
          kernel,
          existing,
          kernel.assets.get(assetName),
        ),
        context: ctx,
      });

      return {
        ok: true,
        data: {
          name: assetName,
          size: content.byteLength,
          url: `/_assets/${assetName}`,
          message:
            `Asset "${assetName}" uploaded (${content.byteLength} bytes). Serve at /_assets/${assetName}`,
        },
      };
    }

    case "list_assets": {
      const assetName = typeof input.name === "string" ? input.name : undefined;
      const includeContent = input.includeContent === true;
      if (includeContent && !assetName) {
        return {
          ok: false,
          error: {
            code: "NAME_REQUIRED",
            message: "Asset name is required when includeContent is true.",
            suggestion:
              "Pass the asset filename in name, or omit includeContent to list all assets.",
          },
        };
      }
      if (!assetName) return { ok: true, data: kernel.assets.list() };

      const asset = kernel.assets.get(assetName);
      if (!asset) {
        return {
          ok: false,
          error: {
            code: "NOT_FOUND",
            message: `Asset "${assetName}" not found.`,
          },
        };
      }

      if (includeContent && !isEditableTextAssetMime(asset.mimeType)) {
        return {
          ok: false,
          error: {
            code: "ASSET_CONTENT_UNAVAILABLE",
            message:
              `Asset "${assetName}" is not an editable text asset; content is not available through list_assets.`,
            suggestion:
              "Use list_assets without includeContent for binary asset metadata.",
          },
        };
      }
      const data = {
        name: asset.name,
        mimeType: asset.mimeType,
        size: asset.size,
        registeredAt: asset.registeredAt,
        ...(asset.module ? { module: asset.module } : {}),
        ...(includeContent
          ? { content: new TextDecoder().decode(asset.content) }
          : {}),
      };
      return { ok: true, data };
    }

    case "get_asset": {
      const asset = kernel.assets.get(input.name as string);
      if (!asset) {
        return {
          ok: false,
          error: {
            code: "NOT_FOUND",
            message: `Asset "${input.name}" not found.`,
          },
        };
      }
      return {
        ok: true,
        data: {
          name: asset.name,
          mimeType: asset.mimeType,
          size: asset.size,
          registeredAt: asset.registeredAt,
          url: `/_assets/${asset.name}`,
        },
      };
    }

    case "delete_asset": {
      const assetName = input.name as string;
      const existing = kernel.assets.get(assetName);
      if (!existing) {
        return {
          ok: false,
          error: {
            code: "NOT_FOUND",
            message: `Asset "${assetName}" not found.`,
          },
        };
      }

      kernel.assets.remove(assetName);
      rebuild();

      await kernel.changelog.record({
        category: "asset",
        key: assetName,
        action: "delete",
        ...assetChangeSnapshots(kernel, existing, undefined),
        context: ctx,
      });

      return {
        ok: true,
        data: { name: assetName, message: `Asset "${assetName}" deleted.` },
      };
    }

    // --- Custom Types ---

    case "define_type": {
      const typeName = input.name as string;
      const fields = input.fields as Array<
        { name: string; type: string; description?: string; optional?: boolean }
      >;
      const description = input.description as string | undefined;
      const existing = kernel.types.get(typeName);

      const module = inferModule(input, kernel) ?? existing?.module;
      kernel.types.register(typeName, fields, description, module);

      await kernel.changelog.record({
        category: "type",
        key: typeName,
        action: existing ? "update" : "create",
        beforeSnapshot: existing ? typeSnapshot(existing) : null,
        afterSnapshot: {
          name: typeName,
          fields,
          ...(description ? { description } : {}),
          ...(module ? { module } : {}),
        },
        context: ctx,
      });

      return {
        ok: true,
        data: {
          name: typeName,
          fieldCount: fields.length,
          message: `Type "${typeName}" defined with ${fields.length} fields.`,
        },
      };
    }

    case "list_types": {
      const one = input.name as string | undefined;
      if (one) {
        const entry = kernel.types.get(one);
        if (!entry) {
          return {
            ok: false,
            error: {
              code: "NOT_FOUND",
              message: `Type "${one}" not found.`,
            },
          };
        }
        return { ok: true, data: entry };
      }
      return {
        ok: true,
        data: kernel.types.list().map((t) =>
          entitySummary(t, {
            ...(t.description ? { description: t.description } : {}),
            fieldCount: t.fields.length,
          })
        ),
      };
    }

    case "get_type": {
      const entry = kernel.types.get(input.name as string);
      if (!entry) {
        return {
          ok: false,
          error: {
            code: "NOT_FOUND",
            message: `Type "${input.name}" not found.`,
          },
        };
      }
      return { ok: true, data: entry };
    }

    case "remove_handler": {
      const handlerName = input.name as string;
      const existing = kernel.handlers.get(handlerName);
      if (!existing) {
        return {
          ok: false,
          error: {
            code: "NOT_FOUND",
            message: `Handler "${handlerName}" not found.`,
          },
        };
      }

      // A bound handler is load-bearing: removing it would leave routes pointing
      // at nothing. Unbinding is the caller's decision to make explicitly, not a
      // side effect of a delete, so name the routes and refuse.
      const boundRoutes = kernel.routes.list()
        .filter((route) => route.handlerName === handlerName)
        .map((route) => `${route.method} ${route.path}`);
      if (boundRoutes.length > 0) {
        return {
          ok: false,
          error: {
            code: "HANDLER_ROUTED",
            message:
              `Handler "${handlerName}" still serves ${boundRoutes.length} route(s): ${
                boundRoutes.join(", ")
              }. Remove the route(s) first (remove_entity type "route").`,
          },
        };
      }

      kernel.handlers.remove(handlerName);
      rebuild();

      await kernel.changelog.record({
        category: "handler",
        key: handlerName,
        action: "delete",
        beforeSnapshot: {
          name: existing.name,
          source: existing.source,
          ...(existing.module ? { module: existing.module } : {}),
          ...(existing.purpose ? { purpose: existing.purpose } : {}),
          ...(existing.schema ? { schema: existing.schema } : {}),
        },
        afterSnapshot: null,
        context: ctx,
      });

      return {
        ok: true,
        data: {
          name: handlerName,
          message: `Handler "${handlerName}" removed.`,
        },
      };
    }

    case "remove_function": {
      const functionName = input.name as string;
      // functions.get() hands back the callable; the registry ENTRY (source and
      // metadata) is what the changelog needs to restore on undo.
      const existing = kernel.functions.list().find((fn) =>
        fn.name === functionName
      );
      if (!existing) {
        return {
          ok: false,
          error: {
            code: "NOT_FOUND",
            message: `Function "${functionName}" not found.`,
          },
        };
      }

      // Refuse while anything still calls it — handlers, other functions, and
      // TESTS. The test case is the one worth spelling out: a function only a
      // test exercises looks dead to the call graph, and removing it turns a
      // passing suite red for reasons the diff does not explain.
      const callers = findFunctionCallers(kernel, functionName);
      if (callers.length > 0) {
        return {
          ok: false,
          error: {
            code: "FUNCTION_IN_USE",
            message:
              `Function "${functionName}" is still called by ${callers.length} entity/entities: ${
                callers.join(", ")
              }. Remove or update them first.`,
          },
        };
      }

      kernel.functions.remove(functionName);
      rebuild();

      await kernel.changelog.record({
        category: "function",
        key: functionName,
        action: "delete",
        beforeSnapshot: {
          name: existing.name,
          source: existing.source,
          ...(existing.module ? { module: existing.module } : {}),
          ...(existing.purpose ? { purpose: existing.purpose } : {}),
          ...(existing.returnType ? { returnType: existing.returnType } : {}),
        },
        afterSnapshot: null,
        context: ctx,
      });

      return {
        ok: true,
        data: {
          name: functionName,
          message: `Function "${functionName}" removed.`,
        },
      };
    }

    case "remove_type": {
      const typeName = input.name as string;
      const existing = kernel.types.get(typeName);
      if (!existing) {
        return {
          ok: false,
          error: {
            code: "NOT_FOUND",
            message: `Type "${typeName}" not found.`,
          },
        };
      }

      kernel.types.remove(typeName);

      await kernel.changelog.record({
        category: "type",
        key: typeName,
        action: "delete",
        beforeSnapshot: typeSnapshot(existing),
        afterSnapshot: null,
        context: ctx,
      });

      return {
        ok: true,
        data: { name: typeName, message: `Type "${typeName}" removed.` },
      };
    }

    // --- Dev Views ---

    case "define_dev_view": {
      const viewName = input.name as string;
      const targetType = input.targetType as string;
      const title = input.title as string;
      const source = input.source as string;
      const existing = kernel.devViews.get(viewName);
      if (existing?.builtIn) {
        return {
          ok: false,
          error: {
            code: "CANNOT_EDIT",
            message: `Cannot edit built-in dev view "${viewName}".`,
          },
        };
      }
      const before = existing
        ? {
          name: existing.name,
          targetType: existing.targetType,
          title: existing.title,
          source: existing.source,
          runtimeId: existing.runtimeId,
          language: existing.language,
        }
        : null;

      const result = await compileRuntimeDevView(
        kernel,
        viewName,
        source,
        deps,
      );
      if (!result.ok) return result;

      const qc = await runQC(source, "dev_view");
      if (!qc.passed) {
        return {
          ok: false,
          error: {
            code: "QC_FAILED",
            message: `Quality checks failed:\n${formatIssues(qc.issues)}`,
            suggestion: "Fix the issues and try again.",
          },
        };
      }

      const module = inferModule(input, kernel) ?? existing?.module;
      const sourceRuntime = sourceRuntimeMetadata(kernel, existing);
      kernel.devViews.register(
        viewName,
        targetType,
        title,
        source,
        result.data,
        false,
        module,
        sourceRuntime.runtimeId,
        sourceRuntime.language,
      );

      await kernel.changelog.record({
        category: "dev_view",
        key: viewName,
        action: before ? "update" : "create",
        beforeSnapshot: before,
        afterSnapshot: {
          name: viewName,
          targetType,
          title,
          source,
          ...(module ? { module } : {}),
          ...sourceRuntime,
        },
        context: ctx,
      });

      const qcNote = qc.issues.length ? `\nQC: ${qc.summary}` : "";
      return {
        ok: true,
        data: {
          name: viewName,
          targetType,
          qc: qc.summary,
          message:
            `Dev view "${viewName}" defined for type "${targetType}".${qcNote}`,
        },
      };
    }

    case "remove_dev_view": {
      const viewName = input.name as string;
      const existing = kernel.devViews.get(viewName);
      if (!existing) {
        return {
          ok: false,
          error: {
            code: "NOT_FOUND",
            message: `Dev view "${viewName}" not found.`,
          },
        };
      }
      if (existing.builtIn) {
        return {
          ok: false,
          error: {
            code: "CANNOT_REMOVE",
            message: `Cannot remove built-in dev view "${viewName}".`,
          },
        };
      }

      kernel.devViews.remove(viewName);

      await kernel.changelog.record({
        category: "dev_view",
        key: viewName,
        action: "delete",
        beforeSnapshot: {
          name: existing.name,
          targetType: existing.targetType,
          title: existing.title,
          source: existing.source,
          runtimeId: existing.runtimeId,
          language: existing.language,
        },
        afterSnapshot: null,
        context: ctx,
      });

      return {
        ok: true,
        data: { name: viewName, message: `Dev view "${viewName}" removed.` },
      };
    }

    case "list_dev_views": {
      const one = input.name as string | undefined;
      if (one) {
        const entry = kernel.devViews.get(one);
        if (!entry) {
          return {
            ok: false,
            error: {
              code: "NOT_FOUND",
              message: `Dev view "${one}" not found.`,
            },
          };
        }
        return {
          ok: true,
          data: {
            name: entry.name,
            targetType: entry.targetType,
            title: entry.title,
            source: entry.source,
            builtIn: entry.builtIn,
          },
        };
      }
      return {
        ok: true,
        data: kernel.devViews.list().map((v) => ({
          name: v.name,
          targetType: v.targetType,
          title: v.title,
          builtIn: v.builtIn,
          registeredAt: v.registeredAt,
        })),
      };
    }

    case "get_dev_view_source": {
      const entry = kernel.devViews.get(input.name as string);
      if (!entry) {
        return {
          ok: false,
          error: {
            code: "NOT_FOUND",
            message: `Dev view "${input.name}" not found.`,
          },
        };
      }
      return {
        ok: true,
        data: {
          name: entry.name,
          targetType: entry.targetType,
          title: entry.title,
          source: entry.source,
          builtIn: entry.builtIn,
        },
      };
    }

    // --- Dev Tools ---

    case "define_dev_tool": {
      const toolName = input.name as string;
      const description = input.description as string;
      const args = input.args as Array<
        { name: string; type: string; description: string; required: boolean }
      >;
      const source = input.source as string;
      const existing = kernel.devTools.get(toolName);
      const before = existing
        ? {
          name: existing.name,
          description: existing.description,
          args: existing.args,
          source: existing.source,
          runtimeId: existing.runtimeId,
          language: existing.language,
        }
        : null;

      const result = await compileRuntimeDevTool(
        kernel,
        toolName,
        source,
        args,
        deps,
      );
      if (!result.ok) return result;

      const qc = await runQC(source, "dev_tool");
      if (!qc.passed) {
        return {
          ok: false,
          error: {
            code: "QC_FAILED",
            message: `Quality checks failed:\n${formatIssues(qc.issues)}`,
            suggestion: "Fix the issues and try again.",
          },
        };
      }

      const module = inferModule(input, kernel) ?? existing?.module;
      const sourceRuntime = sourceRuntimeMetadata(kernel, existing);
      kernel.devTools.register(
        toolName,
        description,
        args,
        source,
        result.data,
        module,
        sourceRuntime.runtimeId,
        sourceRuntime.language,
      );

      await kernel.changelog.record({
        category: "dev_tool",
        key: toolName,
        action: before ? "update" : "create",
        beforeSnapshot: before,
        afterSnapshot: {
          name: toolName,
          description,
          args,
          source,
          ...(module ? { module } : {}),
          ...sourceRuntime,
        },
        context: ctx,
      });

      const qcNote = qc.issues.length ? `\nQC: ${qc.summary}` : "";
      return {
        ok: true,
        data: {
          name: toolName,
          qc: qc.summary,
          message: `Dev tool "${toolName}" defined.${qcNote}`,
        },
      };
    }

    case "remove_dev_tool": {
      const toolName = input.name as string;
      const existing = kernel.devTools.get(toolName);
      if (!existing) {
        return {
          ok: false,
          error: {
            code: "NOT_FOUND",
            message: `Dev tool "${toolName}" not found.`,
          },
        };
      }

      kernel.devTools.remove(toolName);

      await kernel.changelog.record({
        category: "dev_tool",
        key: toolName,
        action: "delete",
        beforeSnapshot: {
          name: existing.name,
          description: existing.description,
          args: existing.args,
          source: existing.source,
          runtimeId: existing.runtimeId,
          language: existing.language,
        },
        afterSnapshot: null,
        context: ctx,
      });

      return {
        ok: true,
        data: { name: toolName, message: `Dev tool "${toolName}" removed.` },
      };
    }

    case "list_dev_tools":
      return {
        ok: true,
        data: kernel.devTools.list().map((t) => ({
          name: t.name,
          description: t.description,
          args: t.args,
          registeredAt: t.registeredAt,
        })),
      };

    case "call_dev_tool": {
      const toolName = input.name as string;
      const entry = kernel.devTools.get(toolName);
      if (!entry) {
        return {
          ok: false,
          error: {
            code: "NOT_FOUND",
            message: `Dev tool "${toolName}" not found.`,
          },
        };
      }

      const argsRecord = (input.args as Record<string, unknown>) ?? {};
      for (const arg of entry.args) {
        if (arg.required && argsRecord[arg.name] === undefined) {
          return {
            ok: false,
            error: {
              code: "MISSING_ARG",
              message: `Required argument "${arg.name}" is missing.`,
            },
          };
        }
      }
      const orderedArgs = entry.args.map((a) => argsRecord[a.name]);

      let timerId: ReturnType<typeof setTimeout>;
      try {
        const timeout = new Promise<never>((_, reject) => {
          timerId = setTimeout(
            () => reject(new Error("Dev tool timed out after 30s")),
            30_000,
          );
        });
        const result = await Promise.race([
          Promise.resolve(entry.fn(...orderedArgs)),
          timeout,
        ]);
        clearTimeout(timerId!);
        return { ok: true, data: result };
      } catch (err) {
        clearTimeout(timerId!);
        return {
          ok: false,
          error: { code: "RUNTIME_ERROR", message: errorMessage(err) },
        };
      }
    }

    // --- Packages ---

    case "install_package": {
      const pkgName = input.name as string;
      const version = input.version as string | undefined;
      if (!kernel.runtime.installPackage || !kernel.runtime.getPackageEntry) {
        return {
          ok: false,
          error: {
            code: "UNSUPPORTED_RUNTIME",
            message:
              `Runtime "${kernel.runtimeId}" does not support package installation.`,
          },
        };
      }
      const existing = kernel.runtime.getPackageEntry(kernel, pkgName);
      const before = existing
        ? { name: existing.name, specifier: existing.specifier }
        : null;

      try {
        const entry = await kernel.runtime.installPackage(
          kernel,
          pkgName,
          version,
        );

        await kernel.changelog.record({
          category: "package",
          key: pkgName,
          action: before ? "update" : "create",
          beforeSnapshot: before,
          afterSnapshot: { name: pkgName, specifier: entry.specifier },
          context: ctx,
          undoable: false,
        });

        const exports = Object.keys(entry.module).filter((k) =>
          k !== "__esModule"
        );
        // Informational, never blocking: installing a framework IS the endorsed
        // carve-out (see this tool's description), so a name shared with one of the
        // shell's bundled deps is a fact to surface, not a mistake to reject. The
        // export aliases the user's copy so `packages.<name>` keeps resolving to it.
        const runtimeNote = runtimeDependencyNote(pkgName);
        return {
          ok: true,
          data: {
            name: pkgName,
            specifier: entry.specifier,
            exports,
            message:
              `Package "${pkgName}" installed. Access it as \`packages.${pkgName}\` in handlers, functions, and scripts.${
                runtimeNote ? `\n[NOTE] ${runtimeNote}` : ""
              }`,
          },
        };
      } catch (err) {
        return {
          ok: false,
          error: {
            code: "INSTALL_FAILED",
            message: `Failed to install "${pkgName}": ${errorMessage(err)}`,
            suggestion:
              "Check the package name and version. Use the exact npm package name.",
          },
        };
      }
    }

    case "list_packages":
      return { ok: true, data: kernel.runtime.listPackages?.(kernel) ?? [] };

    case "remove_package": {
      const pkgName = input.name as string;
      if (!kernel.runtime.removePackage || !kernel.runtime.getPackageEntry) {
        return {
          ok: false,
          error: {
            code: "UNSUPPORTED_RUNTIME",
            message:
              `Runtime "${kernel.runtimeId}" does not support package removal.`,
          },
        };
      }
      const existing = kernel.runtime.getPackageEntry(kernel, pkgName);
      if (!existing) {
        return {
          ok: false,
          error: {
            code: "NOT_FOUND",
            message: `Package "${pkgName}" not found.`,
          },
        };
      }

      const entities = allEntitySources(kernel);
      const pattern = new RegExp(
        `\\bpackages\\.${escapeRegex(pkgName)}\\b`,
      );
      const refs = entities.filter((e) => pattern.test(e.source)).map((e) =>
        `${e.kind}:${e.name}`
      );

      kernel.runtime.removePackage(kernel, pkgName);

      await kernel.changelog.record({
        category: "package",
        key: pkgName,
        action: "delete",
        beforeSnapshot: { name: existing.name, specifier: existing.specifier },
        afterSnapshot: null,
        context: ctx,
        undoable: false,
      });

      const warning = refs.length > 0
        ? `\n[WARN] Package "${pkgName}" is still referenced by: ${
          refs.join(", ")
        }. Those entities will error at runtime.`
        : "";
      return {
        ok: true,
        data: {
          name: pkgName,
          brokenRefs: refs,
          message: `Package "${pkgName}" removed.${warning}`,
        },
      };
    }

    case "find_unused_packages": {
      const packages = kernel.runtime.listPackages?.(kernel) ?? [];
      if (packages.length === 0) {
        return {
          ok: true,
          data: { used: [], unused: [], message: "No packages installed." },
        };
      }

      if (!kernel.runtime.findUnusedPackages) {
        return {
          ok: false,
          error: {
            code: "UNSUPPORTED_RUNTIME",
            message:
              `Runtime "${kernel.runtimeId}" does not support unused package analysis.`,
          },
        };
      }
      const { used, unused } = await kernel.runtime.findUnusedPackages(kernel);

      const parts: string[] = [];
      if (unused.length) {
        parts.push(
          `${unused.length} unused: ${unused.map((p) => p.name).join(", ")}`,
        );
      }
      if (used.length) parts.push(`${used.length} in use`);
      return {
        ok: true,
        data: {
          used,
          unused,
          message: parts.join(". ") || "No packages installed.",
        },
      };
    }

    // --- Tests ---

    case "define_test": {
      const testName = input.name as string;
      const source = input.source as string;
      const reservedTest = reservedNameError("test", testName);
      if (reservedTest) return { ok: false, error: reservedTest };
      const existing = kernel.tests.get(testName);
      const before = existing
        ? {
          name: existing.name,
          source: existing.source,
          runtimeId: existing.runtimeId,
          language: existing.language,
          verification: existing.verification,
        }
        : null;

      const result = await compileRuntimeTest(kernel, testName, source, deps);
      if (!result.ok) return result;

      const module = inferModule(input, kernel) ?? existing?.module;
      const sourceRuntime = sourceRuntimeMetadata(kernel, existing);
      const verification = normalizeTestVerification(input.verification) ??
        existing?.verification;
      kernel.tests.register(
        testName,
        source,
        result.data,
        module,
        ctx?.changesetId,
        sourceRuntime.runtimeId,
        sourceRuntime.language,
        verification,
      );

      await kernel.changelog.record({
        category: "test",
        key: testName,
        action: before ? "update" : "create",
        beforeSnapshot: before,
        afterSnapshot: {
          name: testName,
          source,
          ...(module ? { module } : {}),
          ...sourceRuntime,
          ...(verification ? { verification } : {}),
        },
        context: ctx,
      });

      const tsDiag = getTypeDiagnostics("test", testName, kernel);
      const notes: string[] = [];
      if (tsDiag) notes.push(tsDiag);
      const suffix = notes.length ? "\n" + notes.join("\n") : "";
      return {
        ok: true,
        data: {
          name: testName,
          tsDiagnostics: tsDiag,
          message: `Test "${testName}" defined.${suffix}`,
        },
      };
    }

    case "get_code_context":
      return await getCodeContext(kernel, input);
    case "list_tests": {
      const one = input.name as string | undefined;
      if (one) {
        const entry = kernel.tests.get(one);
        if (!entry) {
          return {
            ok: false,
            error: {
              code: "NOT_FOUND",
              message: `Test "${one}" not found.`,
            },
          };
        }
        return {
          ok: true,
          data: {
            name: entry.name,
            source: entry.source,
            registeredAt: entry.registeredAt,
          },
        };
      }
      const claimId = input.claim_id as string | undefined;
      const tests = claimId
        ? kernel.tests.list().filter((t) =>
          t.verification?.claimIds?.includes(claimId)
        )
        : kernel.tests.list();
      return {
        ok: true,
        data: tests.map((t) => ({
          name: t.name,
          registeredAt: t.registeredAt,
          ...(t.changesetId ? { changesetId: t.changesetId } : {}),
          ...(t.verification ? { verification: t.verification } : {}),
        })),
      };
    }

    case "get_test_source": {
      const entry = kernel.tests.get(input.name as string);
      if (!entry) {
        return {
          ok: false,
          error: {
            code: "NOT_FOUND",
            message: `Test "${input.name}" not found.`,
          },
        };
      }
      return {
        ok: true,
        data: {
          name: entry.name,
          source: entry.source,
          registeredAt: entry.registeredAt,
        },
      };
    }

    case "remove_test": {
      const testName = input.name as string;
      const existing = kernel.tests.get(testName);
      if (!existing) {
        return {
          ok: false,
          error: {
            code: "NOT_FOUND",
            message: `Test "${testName}" not found.`,
          },
        };
      }

      kernel.tests.remove(testName);

      await kernel.changelog.record({
        category: "test",
        key: testName,
        action: "delete",
        beforeSnapshot: {
          name: existing.name,
          source: existing.source,
          runtimeId: existing.runtimeId,
          language: existing.language,
        },
        afterSnapshot: null,
        context: ctx,
      });

      return {
        ok: true,
        data: { name: testName, message: `Test "${testName}" removed.` },
      };
    }

    case "run_tests": {
      const pattern = input.pattern as string | undefined;
      const result = await runKernelTests(kernel, pattern);
      if (!result.ok || !result.data || result.data.total === 0) return result;
      const attestationId = await mintAttestation(kernel, ctx, {
        kind: "test",
        status: result.data.failed === 0 ? "passed" : "failed",
        fingerprint: fingerprintProject(kernel),
        scope: PROJECT_SCOPE,
        summary: result.data.summary,
      });
      return withAttestationId(result.data, attestationId);
    }

    case "check_export_types": {
      const result = await runExportTypeCheck(kernel);
      if (!result.ok || !result.data) return result;
      const attestationId = await mintAttestation(kernel, ctx, {
        kind: "typecheck",
        status: result.data.ok ? "passed" : "failed",
        fingerprint: fingerprintProject(kernel),
        scope: PROJECT_SCOPE,
        summary: result.data.summary,
      });
      return withAttestationId(result.data, attestationId);
    }

    case "test_coverage": {
      const report = await computeCoverage(
        kernel,
        input.module as string | undefined,
      );
      const overall = report.summary.overall;
      const attestationId = await mintAttestation(kernel, ctx, {
        kind: "coverage",
        status: overall.total === 0 || overall.covered < overall.total
          ? "partial"
          : "passed",
        fingerprint: fingerprintProject(kernel),
        scope: PROJECT_SCOPE,
        summary:
          `Coverage ${overall.covered}/${overall.total} entities (${overall.percent}%).`,
      });
      return withAttestationId(report, attestationId);
    }

    // --- Execution ---

    case "run_script": {
      const result = await runRuntimeScript(
        kernel,
        input.source as string,
        deps,
      );
      if (!result.ok) return { ok: false, error: result.error };
      return {
        ok: true,
        data: {
          output: result.output,
          logs: result.logs,
          durationMs: result.durationMs,
        },
      };
    }

    // --- Quality Control ---

    case "lint_code": {
      const source = input.source as string;
      const kind = (input.kind as QCKind) ?? "function";
      const qc = await runQC(source, kind);
      return {
        ok: true,
        data: {
          passed: qc.passed,
          summary: qc.summary,
          issues: qc.issues,
          report: formatIssues(qc.issues),
        },
      };
    }

    case "find_dead_code": {
      const items = findDeadCode(kernel);
      return { ok: true, data: { deadCode: items, count: items.length } };
    }

    case "blast_radius": {
      const category = input.category as string;
      const name = input.name as string;
      // Same projection helper the blast-radius API uses, so tool and endpoint
      // never diverge. Unknown/non-graph-node entity → empty + zero, not an error.
      const graph = buildKnowledgeGraph(kernel);
      return { ok: true, data: blastRadiusReport(graph, category, name) };
    }

    // --- Audits ---

    // --- Reviews the client runs (core/reviews.ts) ---

    case "request_review": {
      const handlers = verificationTools(kernel.composition);
      const kind = input.kind as ReviewKind;
      const result = await requestReview(
        kernel,
        {
          kind,
          ...(typeof input.changeset_id === "string"
            ? { changesetId: input.changeset_id }
            : {}),
          ...(stringArray(input.claim_ids).length > 0
            ? { claimIds: stringArray(input.claim_ids) }
            : {}),
          force: input.force === true,
          ...(typeof input.category === "string"
            ? { category: input.category }
            : {}),
        },
        ctx,
        {
          auditConfig: (category) => handlers.auditConfig(category, kernel),
          auditCategories: () => handlers.auditCategories(kernel),
        },
      );
      return result;
    }

    case "submit_review": {
      const result = await submitReview(
        kernel,
        {
          packetId: String(input.packet_id ?? ""),
          verdict: input.verdict,
          ...(typeof input.reviewer === "string"
            ? { reviewer: input.reviewer }
            : {}),
        },
        (attestation, changesetId) =>
          mintAttestation(kernel, ctx, attestation, changesetId),
      );
      if (!result.ok) return result;
      const { data, changesetId } = result.data;
      const updated = changesetId
        ? await kernel.changesets.get(changesetId)
        : null;
      return {
        ok: true,
        data,
        ...(updated
          ? { _changesetEvent: "changeset_updated", _changeset: updated }
          : {}),
      };
    }

    case "list_audits": {
      const category = input.category as string | undefined;
      const results = category
        ? kernel.audits.listByCategory(category as AuditCategory)
        : kernel.audits.list();
      return {
        ok: true,
        data: results.map((r) => ({
          id: r.id,
          category: r.category,
          status: r.status,
          startedAt: r.startedAt,
          completedAt: r.completedAt,
          issueCount: r.issues.length,
          summary: r.summary,
          score: r.score,
        })),
      };
    }

    case "define_audit": {
      const name = input.name as string;
      const description = input.description as string;
      const prompt = input.prompt as string;
      const module = input.module as string | undefined;
      if (
        BUILTIN_AUDIT_CATEGORIES.includes(
          name as import("../types.ts").BuiltInAuditCategory,
        )
      ) {
        return {
          ok: false,
          error: {
            code: "RESERVED_NAME",
            message: `"${name}" is a built-in audit category`,
          },
        };
      }
      const existing = kernel.customAudits.get(name);
      kernel.customAudits.register(name, description, prompt, module);
      await kernel.changelog.record({
        category: "audit",
        key: name,
        action: existing ? "update" : "create",
        beforeSnapshot: existing ? auditSnapshot(existing) : null,
        afterSnapshot: auditSnapshot(kernel.customAudits.get(name)!),
        context: ctx,
      });
      return { ok: true, data: { name, description } };
    }

    case "remove_audit": {
      const name = input.name as string;
      if (
        BUILTIN_AUDIT_CATEGORIES.includes(
          name as import("../types.ts").BuiltInAuditCategory,
        )
      ) {
        return {
          ok: false,
          error: {
            code: "RESERVED_NAME",
            message: `Cannot remove built-in audit "${name}"`,
          },
        };
      }
      const before = kernel.customAudits.get(name);
      const removed = kernel.customAudits.remove(name);
      if (!removed) {
        return {
          ok: false,
          error: {
            code: "NOT_FOUND",
            message: `Custom audit "${name}" not found`,
          },
        };
      }
      await kernel.changelog.record({
        category: "audit",
        key: name,
        action: "delete",
        beforeSnapshot: before ? auditSnapshot(before) : null,
        afterSnapshot: null,
        context: ctx,
      });
      return { ok: true, data: { removed: name } };
    }

    case "check_package_security": {
      const result = await verificationTools(kernel.composition).auditPackages(
        kernel.runtime.listPackages?.(kernel) ?? [],
      );
      return { ok: true, data: result };
    }

    case "analyze_complexity": {
      const result = auditComplexity(kernel);
      return { ok: true, data: result };
    }

    // --- Project text files ---

    case "preview_project_file": {
      if (!kernel.projectDir) {
        return {
          ok: false,
          error: {
            code: "NO_PROJECT",
            message: "No project directory is loaded.",
          },
        };
      }
      const parsed = parseProjectTextFileRequest(input);
      if (!parsed.ok) return parsed;
      const staged = stageProjectTextFile(kernel.projectDir, parsed.data);
      return staged.ok
        ? { ok: true, data: staged.data }
        : { ok: false, error: staged.error };
    }

    case "apply_project_file": {
      if (!kernel.projectDir) {
        return {
          ok: false,
          error: {
            code: "NO_PROJECT",
            message: "No project directory is loaded.",
          },
        };
      }
      const parsed = parseProjectTextFileRequest(input);
      if (!parsed.ok) return parsed;
      const committed = commitProjectTextFile(kernel.projectDir, parsed.data);
      if (!committed.ok) return { ok: false, error: committed.error };

      const edit = committed.data;
      const record = await kernel.changelog.record({
        category: "module",
        key: edit.key,
        action: edit.action,
        beforeSnapshot: edit.before,
        afterSnapshot: edit.after,
        context: {
          ...ctx,
          sourceBacked: true,
          projectFile: true,
          userMessage: ctx?.userMessage ?? "Project file edit",
        },
      });

      if (readProjectMode(kernel.projectDir) === PROJECT_MODE_SOURCE_BACKED) {
        await reindexSourceBackedCodebase(kernel);
      }
      return { ok: true, data: { change: record, file: edit } };
    }

    // --- Document store (docs/document-store-plan.md §6) ---

    case "document_query": {
      const action = input.action as string;
      switch (action) {
        case "search": {
          const query = (input.query as string | undefined) ?? "";
          return await kernel.documents.search(query, documentFilter(input));
        }
        case "list":
          return await kernel.documents.list(documentFilter(input));
        case "read": {
          const id = input.id as string | undefined;
          if (!id) {
            return {
              ok: false,
              error: {
                code: "INVALID_INPUT",
                message: "document_query action=read requires an id.",
              },
            };
          }
          const meta = await kernel.documents.read(id);
          if (!meta.ok) return meta;
          if (input.includeContent) {
            const read = await kernel.documents.readContentBytes(
              id,
              input.versionHash as string | undefined,
            );
            if (!read.ok) return read;
            const { version, bytes } = read.data;
            return {
              ok: true,
              data: {
                ...meta.data,
                version,
                ...(input.encoding === "base64"
                  ? { contentBase64: encodeBase64(bytes) }
                  : { content: new TextDecoder().decode(bytes) }),
              },
            };
          }
          return meta;
        }
        case "pinned": {
          const sessionId = (input.sessionId as string | undefined) ??
            context?.sessionId;
          if (!sessionId) {
            return {
              ok: false,
              error: {
                code: "SESSION_REQUIRED",
                message:
                  "document_query action=pinned needs a sessionId or a session.",
              },
            };
          }
          return {
            ok: true,
            data: { ids: await kernel.documents.listPinned(sessionId) },
          };
        }
        default:
          return {
            ok: false,
            error: {
              code: "INVALID_ACTION",
              message:
                `document_query: unsupported action "${action}". Valid: search, read, list, pinned.`,
            },
          };
      }
    }

    case "document_write": {
      const action = input.action as string;
      switch (action) {
        case "create": {
          const content = documentContent(input);
          if (!content.ok) return content;
          return await kernel.documents.create({
            name: (input.name as string) ?? "",
            kind: (input.kind as string) ?? "text/markdown",
            content: content.data,
            scope: (input.scope as DocumentScope) ?? "session",
            sessionId: (input.sessionId as string | undefined) ??
              ctx?.sessionId ?? null,
            createdBy: input.attachment === true ? "user" : "agent",
            note: input.note as string | undefined,
            metadata: documentMetadata(input),
          });
        }
        case "update": {
          const id = input.id as string | undefined;
          if (!id) {
            return {
              ok: false,
              error: {
                code: "INVALID_INPUT",
                message: "document_write action=update requires an id.",
              },
            };
          }
          return await kernel.documents.update(id, {
            content: (input.content as string) ?? "",
            createdBy: "agent",
            note: input.note as string | undefined,
          });
        }
        case "archive": {
          const id = input.id as string | undefined;
          if (!id) {
            return {
              ok: false,
              error: {
                code: "INVALID_INPUT",
                message: "document_write action=archive requires an id.",
              },
            };
          }
          return await kernel.documents.archive(id);
        }
        case "ref":
          return await recordMessageDocumentRef(
            kernel,
            input,
            ctx ?? undefined,
          );
        default:
          return {
            ok: false,
            error: {
              code: "INVALID_ACTION",
              message:
                `document_write: unsupported action "${action}". Valid: create, update, archive, ref.`,
            },
          };
      }
    }

    case "document_pin": {
      const id = input.id as string;
      const pinned = input.pinned as boolean;
      const sessionId = ctx?.sessionId;
      if (!sessionId) {
        return {
          ok: false,
          error: {
            code: "SESSION_REQUIRED",
            message:
              "document_pin needs an active session to record working-set membership.",
          },
        };
      }
      return await kernel.documents.setPinned(id, pinned, sessionId);
    }

    // --- Changelog ---

    case "search_changes": {
      const query = input.query as string | undefined;
      const category = input.category as string | undefined;
      const key = input.key as string | undefined;
      const turnId = input.turnId as string | undefined;
      const limit = (input.limit as number) ?? 20;

      if (query) {
        const results = await kernel.changelog.search(query, limit);
        return { ok: true, data: { changes: results, count: results.length } };
      }

      const results = await kernel.changelog.list({
        category,
        key,
        turnId,
        limit,
      });
      return { ok: true, data: { changes: results, count: results.length } };
    }

    case "list_turns":
      return {
        ok: true,
        data: await kernel.changelog.listTurns((input.limit as number) ?? 20),
      };

    case "list_changesets": {
      const status = input.status as
        | import("../types.ts").ChangesetStatus
        | undefined;
      const changesets = await kernel.changesets.list({
        status,
        limit: (input.limit as number) ?? 20,
      });
      return { ok: true, data: { changesets, count: changesets.length } };
    }

    case "get_changeset_context": {
      const changesetId = input.changeset_id as string | undefined;
      if (!changesetId) {
        return {
          ok: false,
          error: {
            code: "INVALID_INPUT",
            message: "changeset_id is required",
          },
        };
      }
      const changeset = await kernel.changesets.get(changesetId);
      if (!changeset) {
        return {
          ok: false,
          error: {
            code: "CHANGESET_NOT_FOUND",
            message: `Changeset "${changesetId}" not found.`,
          },
        };
      }
      const changes = await kernel.changelog.listByChangeset(changeset.id);
      const includeSnapshots = input.include_snapshots === true;
      const vt = verificationTools(kernel.composition);
      // Cost fix (docs/agent-cost-reduction.md §4.3): the raw `changeset` object is
      // NOT returned. It duplicated `context` — the whole plan, every attestation and
      // every evidence blob as JSON, alongside a rendering of the same thing. Unlike
      // the mutation verbs this result carries no `_changeset` side channel, so there
      // is no IDE fallback to protect: nothing in the IDE reads this tool's result
      // (changeset-timeline.ts handles create/update_plan/amend/update_step/
      // record_verification_run/complete only). `formatChangesetContext` was extended
      // to carry the step ids, criterion ids and check ids the agent acts on.
      return {
        ok: true,
        data: {
          changesetId: changeset.id,
          status: changeset.status,
          stepCount: changeset.plan.steps.length,
          changes: includeSnapshots
            ? changes
            : changes.map((c) => vt.stripChangeSnapshots(c)),
          context: vt.formatChangesetContext(
            changeset,
            changes,
          ),
        },
      };
    }

    case "get_changeset": {
      const changesetId = input.changeset_id as string | undefined;
      const changeset = changesetId
        ? await kernel.changesets.get(changesetId)
        : await kernel.changesets.getActive(context?.sessionId);
      if (changesetId && !changeset) {
        return {
          ok: false,
          error: {
            code: "CHANGESET_NOT_FOUND",
            message: `Changeset "${changesetId}" not found.`,
          },
        };
      }
      return { ok: true, data: { changeset } };
    }

    case "check_changeset_readiness": {
      const changesetId = input.changeset_id as string | undefined;
      const changeset = changesetId
        ? await kernel.changesets.get(changesetId)
        : await kernel.changesets.getActive(context?.sessionId);
      if (!changeset) {
        return {
          ok: false,
          error: {
            code: changesetId ? "CHANGESET_NOT_FOUND" : "NO_ACTIVE_CHANGESET",
            message: changesetId
              ? `Changeset "${changesetId}" not found.`
              : "No active changeset found.",
          },
        };
      }
      return {
        ok: true,
        data: await checkProjectAwareReadiness(kernel, changeset),
      };
    }

    case "verify_formal_specs": {
      const changesetId = input.changeset_id as string | undefined;
      const changeset = changesetId
        ? await kernel.changesets.get(changesetId)
        : await kernel.changesets.getActive(context?.sessionId);
      if (!changeset) {
        return {
          ok: false,
          error: {
            code: changesetId ? "CHANGESET_NOT_FOUND" : "NO_ACTIVE_CHANGESET",
            message: changesetId
              ? `Changeset "${changesetId}" not found.`
              : "No active changeset found.",
          },
        };
      }
      return await runFormalSpecVerification(kernel, changeset, context);
    }

    case "get_change": {
      const id = input.id as number;
      const record = await kernel.changelog.get(id);
      if (!record) {
        return {
          ok: false,
          error: { code: "NOT_FOUND", message: `Change #${id} not found.` },
        };
      }
      return { ok: true, data: record };
    }

    case "undo_change": {
      const cursorBefore = await kernel.changelog.getCursor();
      const entry = await kernel.changelog.undoEntry();
      if (!entry) {
        return {
          ok: false,
          error: { code: "NOTHING_TO_UNDO", message: "No undoable changes." },
        };
      }

      const result = await applyChangelogEntries(
        kernel,
        [entry],
        "beforeSnapshot",
        cursorBefore,
        rebuild,
      );
      if (!result.ok) {
        return {
          ok: false,
          error: { code: "UNDO_FAILED", message: result.error },
        };
      }

      return {
        ok: true,
        data: {
          undone: {
            id: entry.id,
            category: entry.category,
            key: entry.key,
            action: entry.action,
          },
        },
      };
    }

    case "redo_change": {
      const cursorBefore = await kernel.changelog.getCursor();
      const entry = await kernel.changelog.redoEntry();
      if (!entry) {
        return {
          ok: false,
          error: { code: "NOTHING_TO_REDO", message: "No changes to redo." },
        };
      }

      const result = await applyChangelogEntries(
        kernel,
        [entry],
        "afterSnapshot",
        cursorBefore,
        rebuild,
      );
      if (!result.ok) {
        return {
          ok: false,
          error: { code: "REDO_FAILED", message: result.error },
        };
      }

      return {
        ok: true,
        data: {
          redone: {
            id: entry.id,
            category: entry.category,
            key: entry.key,
            action: entry.action,
          },
        },
      };
    }

    case "goto_change": {
      const targetId = input.id as number;
      const cursorBefore = await kernel.changelog.getCursor();
      const plan = await kernel.changelog.goTo(targetId);
      if (!plan) {
        return {
          ok: false,
          error: {
            code: "NOT_FOUND",
            message: `Change #${targetId} not found.`,
          },
        };
      }

      // goTo hands back one direction only; the other list is empty.
      const result = plan.undo.length > 0
        ? await applyChangelogEntries(
          kernel,
          plan.undo,
          "beforeSnapshot",
          cursorBefore,
          rebuild,
        )
        : await applyChangelogEntries(
          kernel,
          plan.redo,
          "afterSnapshot",
          cursorBefore,
          rebuild,
        );
      if (!result.ok) {
        return {
          ok: false,
          error: { code: "GOTO_FAILED", message: result.error },
        };
      }

      return {
        ok: true,
        data: { targetId, undone: plan.undo.length, redone: plan.redo.length },
      };
    }

    case "undo_turn": {
      const cursorBefore = await kernel.changelog.getCursor();
      const entries = await kernel.changelog.undoTurnEntries();
      if (!entries || entries.length === 0) {
        return {
          ok: false,
          error: { code: "NOTHING_TO_UNDO", message: "No undoable turn." },
        };
      }

      const result = await applyChangelogEntries(
        kernel,
        entries,
        "beforeSnapshot",
        cursorBefore,
        rebuild,
      );
      if (!result.ok) {
        return {
          ok: false,
          error: { code: "UNDO_FAILED", message: result.error },
        };
      }
      const undone = entries.map(changeSummary);
      return { ok: true, data: { turnId: entries[0]!.turnId, undone } };
    }

    case "redo_turn": {
      const cursorBefore = await kernel.changelog.getCursor();
      const entries = await kernel.changelog.redoTurnEntries();
      if (!entries || entries.length === 0) {
        return {
          ok: false,
          error: { code: "NOTHING_TO_REDO", message: "No turn to redo." },
        };
      }

      const result = await applyChangelogEntries(
        kernel,
        entries,
        "afterSnapshot",
        cursorBefore,
        rebuild,
      );
      if (!result.ok) {
        return {
          ok: false,
          error: { code: "REDO_FAILED", message: result.error },
        };
      }
      const redone = entries.map(changeSummary);
      return { ok: true, data: { turnId: entries[0]!.turnId, redone } };
    }

    // --- Changesets ---

    case "create_changeset": {
      const title = input.title as string;
      const description = input.description as string | undefined;
      const prepared = preparePlan(kernel, input);
      if (!prepared.ok) return { ok: false, error: prepared.error };
      const plan = prepared.plan;
      try {
        const cs = await kernel.changesets.create({
          title,
          description,
          plan,
          sessionId: context?.sessionId,
        });
        // The start snapshot is what abandon rewinds to and what a fork cut
        // mid-changeset starts from. Without it the begin still stands.
        const snapshot = await takeChangesetSnapshot(kernel, cs.id);
        return {
          ok: true,
          data: snapshot.ok ? cs : {
            ...cs,
            snapshotWarning: `No start snapshot (${snapshot.error.message}). ` +
              "Abandoning this changeset won't undo its work, and the " +
              "project can't be forked until it ends.",
          },
          _changesetEvent: "changeset_created",
          _changeset: cs,
        };
      } catch (err) {
        if (err instanceof ChangesetActiveError) {
          return await changesetActiveResult(kernel, err.holder);
        }
        return {
          ok: false,
          error: { code: "CHANGESET_ERROR", message: errorMessage(err) },
        };
      }
    }

    case "update_changeset_plan": {
      const changesetId = input.changeset_id as string;
      const prepared = preparePlan(kernel, input);
      if (!prepared.ok) return { ok: false, error: prepared.error };
      const plan = prepared.plan;
      try {
        const cs = await kernel.changesets.updatePlan(changesetId, plan);
        return {
          ok: true,
          data: cs,
          _changesetEvent: "changeset_updated",
          _changeset: cs,
        };
      } catch (err) {
        return {
          ok: false,
          error: { code: "CHANGESET_ERROR", message: errorMessage(err) },
        };
      }
    }

    case "amend_changeset_plan": {
      const changesetId = input.changeset_id as string;
      try {
        verificationTools(kernel.composition);
        const existing = await kernel.changesets.get(changesetId);
        if (!existing) {
          return {
            ok: false,
            error: { code: "CHANGESET_ERROR", message: "Changeset not found" },
          };
        }
        const amendment = buildPlanAmendment(
          input as {
            summary_addendum?: unknown;
            steps?: unknown;
            acceptanceCriteria?: unknown;
            verificationPlan?: unknown;
            formalSpecs?: unknown;
          },
          existing.plan,
        );
        let cs = await kernel.changesets.amendPlan(changesetId, amendment);
        // Amending a LIGHT changeset escalates it to standard, always. An amendment
        // exists precisely because the scope outgrew the approved plan, and the light
        // lane's whole premise is a small blast radius — so the lane no longer
        // applies. Escalating here is also what keeps the agent out of a loop: the
        // dispatch gate would otherwise keep refusing the newly added structural work
        // with no verb able to widen the class. The amendment already returns the
        // changeset to `planning`, so the user re-approves under the full gate.
        const priorClass = existing.plan.changeClass;
        if (priorClass?.effective === "light") {
          cs = await kernel.changesets.recordChangeClass(changesetId, {
            ...priorClass,
            effective: "standard",
            escalated: false,
            reason:
              "The plan was amended with scope beyond the light lane, so the full " +
              "verification gate now applies.",
          });
        }
        if (context?.changesetId === changesetId) {
          delete context.changesetId;
        }
        return {
          ok: true,
          data: cs,
          _changesetEvent: "changeset_updated",
          _changeset: cs,
        };
      } catch (err) {
        return {
          ok: false,
          error: { code: "CHANGESET_ERROR", message: errorMessage(err) },
        };
      }
    }

    case "record_verification_run": {
      const changesetId = input.changeset_id as string;
      try {
        const evidence = normalizeEvidence(input.evidence);
        const claimResults = normalizeClaimResults(input.claimResults);
        if (evidence.length === 0) {
          return {
            ok: false,
            error: {
              code: "INVALID_VERIFICATION_RUN",
              message:
                "Verification runs must include at least one evidence item.",
            },
          };
        }
        if (claimResults.length === 0) {
          return {
            ok: false,
            error: {
              code: "INVALID_VERIFICATION_RUN",
              message:
                "Verification runs must include at least one claim result.",
            },
          };
        }
        const badEvidenceReference = invalidClaimEvidenceReferenceMessage(
          evidence,
          claimResults,
        );
        if (badEvidenceReference) {
          return {
            ok: false,
            error: {
              code: "INVALID_VERIFICATION_RUN",
              message: badEvidenceReference,
            },
          };
        }
        const cs = await kernel.changesets.recordVerificationRun(changesetId, {
          status: normalizeVerificationStatus(input.status),
          summary: typeof input.summary === "string" ? input.summary : "",
          evidence,
          claimResults,
          residualRisks: stringArray(input.residualRisks),
        });
        // Slice C-rich (plan §8/§11): persist each evidence item's textual output as a
        // durable, versioned agent document + one ledger/evidence ref citing the head —
        // the C-rich reading of ledger evidence (capture the bytes that justified the
        // decision, not just the attestation). Core-side is the right seam: kernel.documents
        // is reachable here (no ChangesetStore contract change, out of agent/brain.ts), and
        // the normalized `evidence` is already in hand. Wrapped in its OWN try/catch so a
        // provenance-persistence failure NEVER breaks the verifier, drops evidence, changes
        // this case's return value/_changesetEvent, or alters the tool result — the run is
        // already recorded and remains authoritative; the docs + refs are purely additive.
        try {
          const captured = await captureRunEvidenceDocuments(
            kernel.documents,
            changesetId,
            evidence,
            context?.sessionId,
          );
          for (const item of captured) {
            if (!item.ok) {
              kernel.log.log(
                "debug",
                "system",
                `Verification-run evidence not captured as a document: ` +
                  `${item.error.code} (${item.error.message})`,
              );
            }
          }
        } catch (docErr) {
          kernel.log.log(
            "warn",
            "system",
            `Capturing verification-run evidence documents failed: ${
              errorMessage(docErr)
            }`,
          );
        }
        // Cost fix (docs/agent-cost-reduction.md §4.3): the agent gets back what it
        // needs to decide the next move — the run's id, its per-claim verdicts, and
        // whether the gate would now pass — not the whole changeset with every prior
        // run's evidence re-serialized. The IDE keeps the full object on `_changeset`
        // (changeset-timeline.ts resolves that first and needs `plan.verificationRuns`
        // to render the "verified" card).
        //
        // The hint uses the pure, synchronous verification-layer readiness, NOT
        // checkProjectAwareReadiness — a project doctor run per verification run is
        // not worth it, and complete_changeset still runs the project-aware gate for
        // real. It is a hint; the gate is the gate.
        const run = (cs.plan.verificationRuns ?? []).at(-1);
        const readiness = verificationTools(kernel.composition)
          .checkChangesetReadiness(cs, currentFingerprints(kernel, cs));
        return {
          ok: true,
          data: {
            id: cs.id,
            status: cs.status,
            runId: run?.id ?? null,
            claimResults: (run?.claimResults ?? []).map((r) => ({
              claimId: r.claimId,
              status: r.status,
            })),
            evidenceCount: run?.evidence.length ?? 0,
            readinessHint: readiness.passed
              ? "ready: nothing is blocking complete_changeset"
              : `blocked: ${
                readiness.errors.map((issue) => issue.code).join(", ")
              }`,
          },
          _changesetEvent: "changeset_updated",
          _changeset: cs,
        };
      } catch (err) {
        return {
          ok: false,
          error: { code: "CHANGESET_ERROR", message: errorMessage(err) },
        };
      }
    }

    case "update_changeset_step": {
      const changesetId = input.changeset_id as string;
      const stepId = input.step_id as string;
      const stepStatus = input.status as "in_progress" | "done" | "skipped";
      try {
        const cs = await kernel.changesets.updateStep(
          changesetId,
          stepId,
          stepStatus,
        );
        // Cost fix (docs/agent-cost-reduction.md §4.3): acknowledging a step status
        // flip does NOT need the whole changeset back — 374 calls averaging 26 KB was
        // 17.2% of all tool-result bytes. The agent needs to know which step is next;
        // it does not need the acceptance criteria, attestations or evidence re-read
        // to it. The IDE still gets the full changeset via `_changeset` below, which
        // is what `changeset-timeline.ts` resolves first — do not remove that side
        // channel without also un-slimming `data`, or the timeline card silently
        // disappears (every consumer fails by returning null).
        return {
          ok: true,
          data: {
            // `id`/`status` are the CHANGESET's, matching every other changeset verb.
            // The step's new status is not repeated here — it is in `steps` under
            // `stepId`, which the agent has to read anyway to pick the next one.
            id: cs.id,
            status: cs.status,
            stepId,
            steps: cs.plan.steps.map((s) => ({
              id: s.id,
              status: s.status,
              description: s.description,
            })),
            allStepsSettled: cs.plan.steps.every((s) =>
              s.status === "done" || s.status === "skipped"
            ),
          },
          _changesetEvent: "changeset_updated",
          _changeset: cs,
        };
      } catch (err) {
        return {
          ok: false,
          error: { code: "CHANGESET_ERROR", message: errorMessage(err) },
        };
      }
    }

    case "complete_changeset": {
      const changesetId = input.changeset_id as string;
      try {
        const existing = await kernel.changesets.get(changesetId);
        if (!existing) {
          return {
            ok: false,
            error: { code: "CHANGESET_ERROR", message: "Changeset not found" },
          };
        }
        // Proportional verification: re-adjudicate the declared change class against
        // what the changeset ACTUALLY changed, before anything downstream reads the
        // tier. The dispatch gate already refuses out-of-budget verbs one at a time;
        // this is the backstop for anything that reached the changelog anyway (a
        // delegated verb, a manual edit, a changeset created before the gate existed).
        // An escalation is persisted and surfaces as a hard readiness error.
        const verifiedClass = await adjudicateChangeClass(kernel, existing);
        const lightLane = verifiedClass?.effective === "light";
        // B-lite gate: re-verify formal specs against CURRENT code before
        // completing, minting fresh invariant attestations. This means a hard
        // spec whose guard was removed or whose entity drifted cannot slip
        // through on a stale attestation recorded earlier.
        if ((existing.plan.formalSpecs ?? []).length > 0) {
          await runFormalSpecVerification(kernel, existing, context);
        }
        // Refutation and the independent criteria review are the client's
        // (request_review / submit_review): the gate reads the verdicts it
        // recorded and never calls a model.
        // The light lane's evidence is minted here rather than demanded of the
        // agent — but only when the lane actually held. An escalated changeset gets
        // no free run: it must satisfy the full gate it turned out to need. And an
        // agent that already recorded a run is left alone: its evidence is richer
        // than a manifest, and appending would silently shadow its claim results
        // (readiness reads only the LATEST run).
        if (
          lightLane && !verifiedClass?.escalated &&
          (existing.plan.verificationRuns ?? []).length === 0
        ) {
          await recordChangeManifest(kernel, existing, ctx);
        }
        const changeset = await kernel.changesets.get(changesetId) ?? existing;
        const readiness = await checkProjectAwareReadiness(kernel, changeset);
        if (!readiness.passed) {
          return {
            ok: false,
            error: {
              code: "INCOMPLETE_VERIFICATION",
              message: `${readiness.summary}\n${
                readiness.errors.map((issue) =>
                  `${issue.code}: ${issue.message} ${issue.action}`
                ).join("\n")
              }`,
            },
            data: readiness,
          };
        }
        const completed = await kernel.changesets.complete(changesetId);
        // Durability checkpoint. Completion is the one moment the work is both finished
        // and verified, and it is infrequent enough to afford a full serialize — unlike
        // flushing per mutating verb, which would re-walk the state directory on every
        // define_* / remove_entity call. Without this, a headless session's registry
        // changes survive only a clean unload. Best-effort on purpose: a changeset that
        // passed the gate is complete whether or not the disk write succeeds, and
        // failing here would report the work as incomplete when it is not.
        let stateFlushed = false;
        if (kernel.projectDir) {
          try {
            flushKernelProjectState(kernel);
            stateFlushed = true;
          } catch (err) {
            kernel.log.log(
              "warn",
              "system",
              "complete_changeset: project state flush failed: " +
                errorMessage(err),
            );
          }
        }
        const cs = await kernel.changesets.aggregate(
          completed.id,
          kernel.sessions,
          kernel.changelog,
        );
        // Landing commits it, last, so the commit holds the completed record.
        const commit = await commitLandedChangeset(kernel, cs);
        // Cost fix (docs/agent-cost-reduction.md §4.3): success is an acknowledgement.
        // The aggregate is the FATTEST changeset payload there is — it folds in the
        // turn's tool calls, reasoning and usage — and the agent has no use for any of
        // it once the gate has passed. The failure branch above keeps `data: readiness`
        // untouched: that is the agent's only signal about what is blocking.
        // `_changeset` still carries the aggregate for the IDE.
        return {
          ok: true,
          data: {
            id: cs.id,
            status: cs.status,
            title: cs.title,
            stepCount: cs.plan.steps.length,
            completedAt: cs.completedAt,
            stateFlushed,
            commit,
          },
          _changesetEvent: "changeset_completed",
          _changeset: cs,
        };
      } catch (err) {
        return {
          ok: false,
          error: { code: "CHANGESET_ERROR", message: errorMessage(err) },
        };
      }
    }

    case "adopt_changeset": {
      return await adoptChangeset(
        kernel,
        input.changeset_id as string | undefined,
        context,
      );
    }

    case "abandon_changeset": {
      const changesetId = input.changeset_id as string;
      try {
        // An agent abandons only its own session's work. Freeing a project
        // another session holds is a person's call, made in the IDE.
        const target = await kernel.changesets.get(changesetId);
        if (
          target?.sessionId && context?.sessionId &&
          target.sessionId !== context.sessionId &&
          !(await orphanReason(kernel, target))
        ) {
          return {
            ok: false,
            error: {
              code: "CHANGESET_NOT_OWNED",
              message: `Changeset "${changesetId}" belongs to another session.`,
              suggestion: "Only the session that created it can abandon it " +
                "here while that session is connected. A person can abandon " +
                "it from the IDE.",
            },
          };
        }
        const rewind = await rewindForAbandon(kernel, changesetId, rebuild);
        const cs = await kernel.changesets.abandon(changesetId);
        return {
          ok: true,
          data: { ...cs, rewind },
          _changesetEvent: "changeset_updated",
          _changeset: cs,
        };
      } catch (err) {
        return {
          ok: false,
          error: { code: "CHANGESET_ERROR", message: errorMessage(err) },
        };
      }
    }

    // --- Modules ---

    case "list_modules": {
      const one = input.name as string | undefined;
      if (one) {
        if (!kernel.listModules().includes(one)) {
          return {
            ok: false,
            error: {
              code: "NOT_FOUND",
              message: `Module "${one}" not found.`,
            },
          };
        }
        const entities = await kernel.getModuleEntities(one);
        return { ok: true, data: { name: one, ...entities } };
      }
      const modules = kernel.listModules();
      const data: Array<
        { name: string; entities: Record<string, number>; total: number }
      > = [];
      for (const mod of modules) {
        const entities = await kernel.getModuleEntities(mod);
        const counts: Record<string, number> = {};
        let total = 0;
        for (const [cat, arr] of Object.entries(entities)) {
          if ((arr as unknown[]).length > 0) {
            counts[cat] = (arr as unknown[]).length;
            total += (arr as unknown[]).length;
          }
        }
        data.push({ name: mod, entities: counts, total });
      }
      return { ok: true, data: { modules: data, count: modules.length } };
    }

    case "get_module": {
      const modName = input.name as string;
      if (!kernel.listModules().includes(modName)) {
        return {
          ok: false,
          error: {
            code: "NOT_FOUND",
            message: `Module "${modName}" not found.`,
          },
        };
      }
      const entities = await kernel.getModuleEntities(modName);
      return { ok: true, data: { name: modName, ...entities } };
    }

    case "apply_rename": {
      // Stage 7 (docs/lsp-support-plan.md Stage 7): apply a cross-entity rename as ONE
      // atomic, governed, reversible operation. The LSP rename path computes a
      // WorkspaceEdit and hands us the RESULTING full sources — `edits` upsert entities
      // that keep their registry key (references rewritten); `rename` (at most one) is
      // the entity-name special case where the definition itself is renamed, so the new
      // key is created, its routes rebind, and the old key is retired. Atomicity is
      // compile-all-then-commit-all: EVERY source is compiled + QC'd first, and only if
      // all pass is anything registered — so a rename where one entity fails is rejected
      // whole, nothing half-applied (the exit criterion). Every mutation shares one
      // turnId, so the whole rename is a single reversible turn (undo_turn round-trips
      // it, including re-registering a retired entity from its `delete` snapshot).
      // Deliberately NOT an MCP-projected verb (see LSP_RENAME_TOOL) — it consumes
      // editor-computed sources, not agent-authoring input.
      const turnId = input.turnId as string;
      const editsInput = (input.edits ?? []) as Array<
        { entityType: string; name: string; source: string }
      >;
      const renameInput = input.rename as
        | { entityType: string; from: string; to: string; source: string }
        | undefined;
      const userMessage = input.userMessage as string | undefined;
      if (typeof turnId !== "string" || turnId.length === 0) {
        return {
          ok: false,
          error: {
            code: "INVALID_INPUT",
            message: "apply_rename requires a non-empty turnId.",
          },
        };
      }
      const turnCtx: ChangeContext = {
        ...(ctx ?? {}),
        turnId,
        manualEdit: true,
        // A1: this is the editor-computed (manual) rename path, so its records
        // are human-authored. Set explicitly AFTER the spread so an inherited
        // authorOrigin from `ctx` can't override the manualEdit truth here.
        // (A3 will restructure the rename op itself; the origin stamp is A1's.)
        authorOrigin: "human",
        ...(userMessage ? { userMessage } : {}),
      };

      // Deferred registry mutations (the "commit" of compile-all-then-commit-all): each
      // closure captures a validated, compiled entity and, when run, registers it +
      // records its changelog entry (under turnCtx) + announces the change. Nothing here
      // runs until every entity has passed validation.
      const commits: Array<() => Promise<void>> = [];
      const applied: Array<
        { entityType: string; name: string; action: string }
      > = [];
      const failures: Array<
        { entityType: string; name: string; code: string; message: string }
      > = [];

      // Validate + stage one upsert. `metaFromName` names the entity whose metadata
      // (schema/module/purpose/returnType/runtime) the write inherits — the entity
      // itself for a plain edit, or the OLD entity for a rename's new key (so a renamed
      // handler keeps its route schema). Compile + QC gate here; a failure is collected,
      // never thrown, so ALL failures surface at once and none mutate the registry.
      //
      // A3 — when `renamedFrom` is set, this upsert IS the entity-name rename: `name` is
      // the new key, `renamedFrom` (=== metaFromName) the old one. The new key inherits
      // the OLD entity's stable entityUid (so the metric reads one entity alive, not a
      // death + a birth), the old key is vacated in the SAME commit, and a SINGLE
      // action:"rename" record is emitted (keyed by the new name, carrying renamedFrom) —
      // never a create(new)+delete(old) pair. beforeSnapshot is the old entity so undo
      // re-registers it; afterSnapshot is the new one so redo re-applies the rename.
      const stageUpsert = async (
        entityType: string,
        name: string,
        source: string,
        metaFromName: string,
        renamedFrom?: string,
      ): Promise<void> => {
        const isRename = renamedFrom !== undefined;
        if (
          isRename &&
          (entityType === "handler" || entityType === "function" ||
            entityType === "test")
        ) {
          const reserved = reservedNameError(entityType, name);
          if (reserved) {
            failures.push({
              entityType,
              name,
              code: reserved.code,
              message: reserved.message,
            });
            return;
          }
        }
        // The context every record here rides on. A rename additionally stamps the
        // prior name; the preserved entityUid is injected centrally by the facade
        // resolver from the new key (registered with the carried uid) at record time.
        const recordCtx: ChangeContext = isRename
          ? { ...turnCtx, renamedFrom }
          : turnCtx;
        if (entityType === "handler") {
          const compiled = await compileRuntimeHandler(
            kernel,
            name,
            source,
            deps,
          );
          if (!compiled.ok) {
            failures.push({
              entityType,
              name,
              code: compiled.error?.code ?? "COMPILE_FAILED",
              message: compiled.error?.message ?? "compile failed",
            });
            return;
          }
          const qc = await runQC(source, "handler");
          if (!qc.passed) {
            failures.push({
              entityType,
              name,
              code: "QC_FAILED",
              message: formatIssues(qc.issues),
            });
            return;
          }
          const fn = compiled.data;
          const meta = kernel.handlers.get(metaFromName);
          const existing = kernel.handlers.get(name);
          const snapshotOf = (h: HandlerEntry) => ({
            name: h.name,
            source: h.source,
            schema: h.schema,
            module: h.module,
            purpose: h.purpose,
            runtimeId: h.runtimeId,
            language: h.language,
          });
          // A3: the rename's before-state is the OLD entity (metaFromName === from,
          // captured in `meta`), so undo re-registers it; a plain edit's is `existing`.
          const before = isRename
            ? (meta ? snapshotOf(meta) : null)
            : (existing ? snapshotOf(existing) : null);
          const action: ChangeAction = isRename
            ? "rename"
            : (before ? "update" : "create");
          const sourceRuntime = sourceRuntimeMetadata(kernel, meta);
          // A3: carry the metadata-source entity's uid onto the write — for a plain
          // edit metaFromName === name so it preserves the entity's own uid; for a
          // rename metaFromName === from so the new key inherits the old uid. Without
          // this the new key would mint a fresh uid and the metric would see a birth.
          const carriedUid = meta?.entityUid;
          const fromRevision = meta?.revision ?? 0;
          applied.push({ entityType, name, action });
          commits.push(async () => {
            kernel.handlers.register(
              name,
              source,
              fn,
              meta?.schema,
              meta?.module,
              sourceRuntime.runtimeId,
              sourceRuntime.language,
              meta?.purpose,
              undefined,
              carriedUid,
            );
            // A3: vacate the old key in the SAME commit — no separate delete record.
            // The new key is already registered (with the carried uid) so the facade
            // resolver stamps the preserved uid onto the rename record below.
            if (isRename) kernel.handlers.remove(renamedFrom!);
            await kernel.changelog.record({
              category: "handler",
              key: name,
              action,
              beforeSnapshot: before,
              afterSnapshot: {
                name,
                source,
                ...(meta?.schema ? { schema: meta.schema } : {}),
                ...(meta?.module ? { module: meta.module } : {}),
                ...(meta?.purpose ? { purpose: meta.purpose } : {}),
                ...sourceRuntime,
              },
              context: recordCtx,
            });
            kernel.notifyEntityChange({
              entityType: "handler",
              entityName: name,
              revision: kernel.handlers.get(name)?.revision ?? 0,
            });
            if (isRename) {
              kernel.notifyEntityChange({
                entityType: "handler",
                entityName: renamedFrom!,
                revision: fromRevision,
              });
            }
          });
        } else if (entityType === "function") {
          const compiled = await compileRuntimeFunction(
            kernel,
            name,
            source,
            deps,
          );
          if (!compiled.ok) {
            failures.push({
              entityType,
              name,
              code: compiled.error?.code ?? "COMPILE_FAILED",
              message: compiled.error?.message ?? "compile failed",
            });
            return;
          }
          const qc = await runQC(source, "function");
          if (!qc.passed) {
            failures.push({
              entityType,
              name,
              code: "QC_FAILED",
              message: formatIssues(qc.issues),
            });
            return;
          }
          const fn = compiled.data;
          const meta = kernel.functions.getEntry(metaFromName);
          const existing = kernel.functions.getEntry(name);
          const snapshotOf = (f: FunctionEntry) => ({
            name: f.name,
            source: f.source,
            module: f.module,
            returnType: f.returnType,
            purpose: f.purpose,
            runtimeId: f.runtimeId,
            language: f.language,
          });
          // A3: see the handler branch — the rename's before-state is the OLD entity.
          const before = isRename
            ? (meta ? snapshotOf(meta) : null)
            : (existing ? snapshotOf(existing) : null);
          const action: ChangeAction = isRename
            ? "rename"
            : (before ? "update" : "create");
          const sourceRuntime = sourceRuntimeMetadata(kernel, meta);
          // A3: carry the metadata-source entity's uid onto the write (see handler branch).
          const carriedUid = meta?.entityUid;
          const fromRevision = meta?.revision ?? 0;
          applied.push({ entityType, name, action });
          commits.push(async () => {
            kernel.functions.register(
              name,
              source,
              fn,
              meta?.module,
              meta?.returnType,
              sourceRuntime.runtimeId,
              sourceRuntime.language,
              meta?.purpose,
              undefined,
              carriedUid,
            );
            // A3: vacate the old key in the SAME commit — no separate delete record.
            if (isRename) kernel.functions.remove(renamedFrom!);
            await kernel.changelog.record({
              category: "function",
              key: name,
              action,
              beforeSnapshot: before,
              afterSnapshot: {
                name,
                source,
                ...(meta?.returnType ? { returnType: meta.returnType } : {}),
                ...(meta?.module ? { module: meta.module } : {}),
                ...(meta?.purpose ? { purpose: meta.purpose } : {}),
                ...sourceRuntime,
              },
              context: recordCtx,
            });
            kernel.notifyEntityChange({
              entityType: "function",
              entityName: name,
              revision: kernel.functions.getEntry(name)?.revision ?? 0,
            });
            if (isRename) {
              kernel.notifyEntityChange({
                entityType: "function",
                entityName: renamedFrom!,
                revision: fromRevision,
              });
            }
          });
        } else {
          failures.push({
            entityType,
            name,
            code: "UNSUPPORTED_ENTITY_TYPE",
            message:
              `apply_rename supports handler and function, not "${entityType}".`,
          });
        }
      };

      for (const e of editsInput) {
        await stageUpsert(e.entityType, e.name, e.source, e.name);
      }

      if (renameInput) {
        const { entityType, from, to, source } = renameInput;
        const fromEntry = entityType === "handler"
          ? kernel.handlers.get(from)
          : entityType === "function"
          ? kernel.functions.getEntry(from)
          : undefined;
        if (!fromEntry) {
          failures.push({
            entityType,
            name: from,
            code: "NOT_FOUND",
            message:
              `Cannot rename ${entityType} "${from}": it is not registered.`,
          });
        } else if (
          to !== from &&
          (kernel.handlers.get(to) || kernel.functions.getEntry(to))
        ) {
          // Collision guard: renaming onto an existing key would clobber it.
          failures.push({
            entityType,
            name: to,
            code: "RENAME_TARGET_EXISTS",
            message:
              `Cannot rename ${entityType} "${from}" to "${to}": an entity named "${to}" already exists.`,
          });
        } else if (to !== from) {
          // A3: stage the rename as ONE operation. `stageUpsert` with `renamedFrom`
          // registers the new key carrying the old entityUid, vacates the old key in
          // the same commit, and emits a single action:"rename" record — no
          // create(new)+delete(old) pair. Route rebinds stay separate below.
          await stageUpsert(entityType, to, source, from, from);
          // Rebind every route bound to the old handler name onto the new one — only
          // if the new key actually staged (no failure). These stay as their own
          // `update` records so undo_turn reverts the handlerName alongside the rename.
          if (entityType === "handler") {
            for (const r of kernel.routes.list()) {
              if (r.handlerName !== from) continue;
              const routeKey = `${r.method} ${r.path}`;
              const routeBefore = {
                method: r.method,
                path: r.path,
                handlerName: r.handlerName,
                ...(r.schema ? { schema: r.schema } : {}),
                ...(r.module ? { module: r.module } : {}),
              };
              applied.push({
                entityType: "route",
                name: routeKey,
                action: "update",
              });
              commits.push(async () => {
                kernel.routes.register(
                  r.method,
                  r.path,
                  to,
                  r.schema,
                  r.module,
                );
                await kernel.changelog.record({
                  category: "route",
                  key: routeKey,
                  action: "update",
                  beforeSnapshot: routeBefore,
                  afterSnapshot: {
                    method: r.method,
                    path: r.path,
                    handlerName: to,
                    ...(r.schema ? { schema: r.schema } : {}),
                    ...(r.module ? { module: r.module } : {}),
                  },
                  context: turnCtx,
                });
              });
            }
          }
        } else {
          // Degenerate rename to the same name ⇒ a plain edit; no uid carry, no
          // rename record, no route rebind.
          await stageUpsert(entityType, to, source, from);
        }
      }

      // The all-or-nothing gate: any compile/QC/collision failure ⇒ reject the WHOLE
      // rename, mutating nothing. The rejected entities ride in `data.failures` so the
      // LSP path can squiggle/toast them.
      if (failures.length > 0) {
        return {
          ok: false,
          data: { failures },
          error: {
            code: "RENAME_REJECTED",
            message: `Rename rejected: ${failures.length} entit${
              failures.length === 1 ? "y" : "ies"
            } failed validation (${
              failures.map((f) => `${f.name}: ${f.code}`).join("; ")
            }). Nothing was changed.`,
            suggestion:
              "Fix the reported entities and retry; the rename is applied atomically or not at all.",
          },
        };
      }

      // Commit: every entity validated, so run the staged mutations in order (upserts —
      // including the rename's new key — then route rebinds, then the old-key retire),
      // and rebuild once at the end.
      for (const commit of commits) await commit();
      rebuild();

      return {
        ok: true,
        data: {
          turnId,
          applied,
          message: `Renamed atomically: ${applied.length} change${
            applied.length === 1 ? "" : "s"
          } in one reversible turn.`,
        },
      };
    }

    case "rename_module": {
      const oldName = input.oldName as string;
      const newName = input.newName as string;
      if (!kernel.listModules().includes(oldName)) {
        return {
          ok: false,
          error: {
            code: "NOT_FOUND",
            message: `Module "${oldName}" not found.`,
          },
        };
      }
      const targets = await entitiesInModule(kernel, oldName);
      for (const target of targets) {
        const move = await moveEntityToModule(
          kernel,
          target.category,
          target.key,
          newName,
        );
        if (!move.ok) return move;
        await recordModuleMove(kernel, move.data, ctx);
      }
      rebuild();
      const count = targets.length;

      return {
        ok: true,
        data: {
          oldName,
          newName,
          entitiesUpdated: count,
          message:
            `Renamed module "${oldName}" to "${newName}" (${count} entities updated).`,
        },
      };
    }

    case "move_to_module": {
      const category = input.category as string;
      const key = input.key as string;
      const targetModule = (input.module as string) || undefined;
      if (!isModuleMoveCategory(category)) {
        return {
          ok: false,
          error: {
            code: "INVALID_CATEGORY",
            message: `Unknown category "${category}".`,
          },
        };
      }
      const move = await moveEntityToModule(
        kernel,
        category,
        key,
        targetModule,
      );
      if (!move.ok) return move;
      await recordModuleMove(kernel, move.data, ctx);
      rebuild();
      return {
        ok: true,
        data: {
          category,
          key,
          module: targetModule ?? null,
          message: `Moved ${category} "${key}" to module "${
            targetModule ?? "(ungrouped)"
          }"`,
        },
      };
    }

    // --- System ---

    case "set_system_prompt": {
      const instructions = input.instructions as string;
      const existing = kernel.configs.getEntry("_genie_custom_instructions");
      const before = existing
        ? { name: existing.name, value: existing.value }
        : null;

      kernel.configs.set("_genie_custom_instructions", instructions || null);

      await kernel.changelog.record({
        category: "config",
        key: "_genie_custom_instructions",
        action: before ? "update" : "create",
        beforeSnapshot: before,
        afterSnapshot: {
          name: "_genie_custom_instructions",
          value: instructions || null,
        },
        context: ctx,
      });

      return {
        ok: true,
        data: {
          message: instructions
            ? "Custom instructions set."
            : "Custom instructions cleared.",
        },
      };
    }

    // --- Export ---

    case "export_project": {
      const includeEnvFile = input.includeEnvFile as boolean | undefined;
      const includeSeedData = input.includeSeedData as boolean | undefined;
      const includeManifest = input.includeManifest as boolean | undefined;
      const out = input.out as string | undefined;
      const force = input.force === true;
      if (!kernel.runtime.exportProject) {
        return {
          ok: false,
          error: {
            code: "UNSUPPORTED_RUNTIME",
            message:
              `Runtime "${kernel.runtimeId}" does not support project export.`,
          },
        };
      }
      const projectDir = kernel.projectDir;
      if (!projectDir) {
        return {
          ok: false,
          error: {
            code: "NO_PROJECT",
            message: "No project directory available.",
          },
        };
      }

      // Resolve the write target before exporting: an export is expensive, and a
      // target we are going to refuse should be refused first. `out` arrives from
      // an agent tool call, so it is contained inside the project directory —
      // an unconstrained absolute path here would be a write-anywhere primitive
      // driven by a prompt. Default matches where the build scripts already look.
      const version = getVersion(projectDir);
      let outDir: string | null = null;
      if (out !== undefined) {
        const root = resolve(projectDir);
        const resolved = resolve(root, out);
        if (resolved !== root && !resolved.startsWith(root + sep)) {
          return {
            ok: false,
            error: {
              code: "EXPORT_OUT_ESCAPES_PROJECT",
              message:
                `Export target must stay inside the project directory: ${out}`,
            },
          };
        }
        if (resolved === root) {
          return {
            ok: false,
            error: {
              code: "EXPORT_OUT_IS_PROJECT_ROOT",
              message:
                "Refusing to write an export over the project directory itself.",
            },
          };
        }
        // Refuse a non-empty target rather than merging over it: a merge would
        // leave a since-deleted entity's file behind and the export would no
        // longer match the registry. Same policy as the CLI's prepareExplicitOut.
        if (existsSync(resolved)) {
          const occupied = !statSync(resolved).isDirectory() ||
            readdirSync(resolved).length > 0;
          if (occupied && !force) {
            return {
              ok: false,
              error: {
                code: "EXPORT_OUT_NOT_EMPTY",
                message:
                  `Export target already exists and is not empty: ${resolved} (pass force: true to replace it).`,
              },
            };
          }
          if (occupied) rmSync(resolved, { recursive: true, force: true });
        }
        outDir = resolved;
      }

      // Start from the headless build defaults rather than a bare object, so an
      // MCP export carries the same migrations/reference-seeds/docs set as
      // `opentide export`. Passing only the two secret/seed toggles used to leave
      // includeMigrations false, which silently produced an export with no
      // migrations/ directory at all.
      const { files } = await kernel.runtime.exportProject(kernel, {
        ...DEFAULT_BUILD_OPTIONS,
        includeEnvFile: includeEnvFile ?? false,
        includeSeedData: includeSeedData ?? false,
        includeManifest: includeManifest ?? false,
        projectName: readProjectManifestName(projectDir),
        projectVersion: version,
      });

      if (outDir) {
        mkdirSync(outDir, { recursive: true });
        writeExportFiles(outDir, files);
        return {
          ok: true,
          data: {
            outDir,
            fileCount: files.length,
            files: files.map((f) => f.path),
            projectVersion: version,
            includeEnvFile: includeEnvFile ?? false,
            includeSeedData: includeSeedData ?? false,
            includeManifest: includeManifest ?? false,
            message: `Project exported to ${outDir} (${files.length} files).`,
          },
        };
      }

      return {
        ok: true,
        data: {
          fileCount: files.length,
          files: files.map((f) => f.path),
          projectVersion: version,
          message:
            "Project exported. Download from the Export button in the command palette or GET /api/export, or pass `out` to write the tree to disk.",
        },
      };
    }

    case "export_data": {
      const projectDir = kernel.projectDir;
      if (!projectDir) {
        return {
          ok: false,
          error: {
            code: "NO_PROJECT",
            message: "No project directory available.",
          },
        };
      }

      try {
        const result = await exportDataFixture(kernel.db, projectDir, {
          name: input.name as string | undefined,
          tables: input.tables as string[] | undefined,
        });
        return {
          ok: true,
          data: {
            path: result.dir,
            files: result.files,
            tables: result.manifest.tables,
            rowCount: result.manifest.tables.reduce(
              (sum, table) => sum + table.rowCount,
              0,
            ),
            message: `Exported data fixture to ${result.dir}.`,
          },
        };
      } catch (err) {
        return {
          ok: false,
          error: { code: "EXPORT_DATA_ERROR", message: errorMessage(err) },
        };
      }
    }

    case "import_data": {
      const projectDir = kernel.projectDir;
      if (!projectDir) {
        return {
          ok: false,
          error: {
            code: "NO_PROJECT",
            message: "No project directory available.",
          },
        };
      }

      try {
        const result = await importDataFixture(kernel.db, projectDir, {
          name: input.name as string | undefined,
          tables: input.tables as string[] | undefined,
          mode: input.mode as "truncate" | "append" | undefined,
        });
        await recordDataRewrite(
          kernel,
          "import_data",
          result.tables.map((t) => t.tableName),
          {
            fixture: input.name ?? null,
            mode: input.mode ?? "truncate",
            rows: result.imported,
          },
          ctx,
        );
        return {
          ok: true,
          data: {
            imported: result.imported,
            tables: result.tables,
            message: `Imported ${result.imported} rows from data fixture.`,
          },
        };
      } catch (err) {
        return {
          ok: false,
          error: { code: "IMPORT_DATA_ERROR", message: errorMessage(err) },
        };
      }
    }

    case "reset_data": {
      try {
        const result = await resetDataTables(
          kernel.db,
          input.tables as string[] | undefined,
        );
        await recordDataRewrite(kernel, "reset_data", result.tables, {
          tables: result.reset,
        }, ctx);
        return {
          ok: true,
          data: {
            reset: result.reset,
            tables: result.tables,
            message: `Reset ${result.reset} local data table${
              result.reset === 1 ? "" : "s"
            }.`,
          },
        };
      } catch (err) {
        return {
          ok: false,
          error: { code: "RESET_DATA_ERROR", message: errorMessage(err) },
        };
      }
    }

    case "generate_project_docs": {
      const projectDir = kernel.projectDir;
      if (!projectDir) {
        return {
          ok: false,
          error: {
            code: "NO_PROJECT",
            message: "No project directory available.",
          },
        };
      }

      const requestedFiles = (input.files as string[] | undefined) ??
        ["README.md", "AGENT.md"];
      const projectName = input.projectName as string | undefined;
      const written: string[] = [];

      for (const file of requestedFiles) {
        const content = file === "README.md"
          ? await generateReadme(kernel, projectName)
          : await generateAgentMd(kernel, projectName);
        await writeRecordedProjectFile(
          kernel,
          projectDir,
          normalize(resolve(projectDir, file)),
          content,
          ctx,
        );
        written.push(file);
      }

      return {
        ok: true,
        data: {
          files: written,
          message: `Generated ${written.join(" and ")} in project directory.`,
        },
      };
    }

    case "write_project_file": {
      const projectDir = kernel.projectDir;
      if (!projectDir) {
        return {
          ok: false,
          error: {
            code: "NO_PROJECT",
            message: "No project directory available.",
          },
        };
      }

      const relPath = input.path as string;
      const content = input.content as string;

      const resolved = normalize(resolve(projectDir, relPath));
      if (resolved !== projectDir && !resolved.startsWith(projectDir + "/")) {
        return {
          ok: false,
          error: {
            code: "INVALID_PATH",
            message: "Path must be within the project directory.",
          },
        };
      }

      try {
        await writeRecordedProjectFile(
          kernel,
          projectDir,
          resolved,
          content,
          ctx,
        );
        return {
          ok: true,
          data: {
            path: relPath,
            size: content.length,
            message: `File "${relPath}" written to project directory.`,
          },
        };
      } catch (err) {
        return {
          ok: false,
          error: { code: "WRITE_ERROR", message: errorMessage(err) },
        };
      }
    }

    // --- Branches ---

    case "create_branch": {
      const branchName = input.name as string;
      const branch = await kernel.branches.create(branchName, kernel);

      await kernel.changelog.record({
        category: "branch",
        key: branchName,
        action: "create",
        beforeSnapshot: null,
        afterSnapshot: { name: branchName, snapshotId: branch.snapshotId },
        context: ctx,
        undoable: false,
      });

      return {
        ok: true,
        data: {
          ...branch,
          message: `Branch "${branchName}" created and activated.`,
        },
      };
    }

    case "switch_branch": {
      const branchName = input.name as string;
      const result = await kernel.branches.switch(branchName, kernel, rebuild);
      if (!result.ok) {
        return {
          ok: false,
          error: { code: "SWITCH_FAILED", message: result.error },
        };
      }

      await kernel.changelog.record({
        category: "branch",
        key: branchName,
        action: "restore",
        beforeSnapshot: null,
        afterSnapshot: null,
        context: ctx,
        undoable: false,
      });

      return {
        ok: true,
        data: {
          name: branchName,
          message: `Switched to branch "${branchName}".`,
        },
      };
    }

    case "list_branches":
      return {
        ok: true,
        data: {
          branches: kernel.branches.serialize(),
          active: kernel.branches.getActive(),
        },
      };

    case "delete_branch": {
      const branchName = input.name as string;
      const removed = kernel.branches.delete(branchName, kernel);
      if (!removed) {
        return {
          ok: false,
          error: {
            code: "NOT_FOUND",
            message: `Branch "${branchName}" not found.`,
          },
        };
      }

      await kernel.changelog.record({
        category: "branch",
        key: branchName,
        action: "delete",
        beforeSnapshot: null,
        afterSnapshot: null,
        context: ctx,
        undoable: false,
      });

      return {
        ok: true,
        data: { name: branchName, message: `Branch "${branchName}" deleted.` },
      };
    }

    // --- Tasks (docs/opentide-task-forks-plan.md) ---

    case "start_task":
      return await startTask(kernel, {
        title: input.title as string,
        claims: (input.claims as string[] | undefined) ?? [],
      });

    case "list_tasks":
      return listTasks(kernel);

    case "merge_task":
      return await mergeTask(kernel, input.task_id as string, rebuild);

    case "discard_task":
      return await discardTaskFork(kernel, input.task_id as string);

    // --- Control ---

    case "get_kernel_status":
      return {
        ok: true,
        data: {
          routes: kernel.routes.list().length,
          handlers: kernel.handlers.list().length,
          functions: kernel.functions.list().length,
          schemas: (await kernel.db.listSchemas()).length,
          configKeys: kernel.configs.list().length,
          tests: kernel.tests.list().length,
          packages: (kernel.runtime.listPackages?.(kernel) ?? []).length,
          recentErrors: kernel.log.query({ level: "error", limit: 5 }).length,
          recentRequests: kernel.requestLog.recent(5).length,
          changes: await kernel.changelog.count(),
        },
      };

    // The registries live in memory and load from the state directory, so a session that
    // mutates them and never flushes leaves nothing behind. Every existing flush hangs off
    // the IDE (the control server's REST routes, the agent-loop's per-step checkpoint) or
    // off git (git_status / git_commit / git_push), and a clean unload. A headless MCP
    // session that does none of those can define and remove entities for hours with no
    // durable write. This is the explicit verb for that case.
    case "flush_project_state": {
      try {
        flushKernelProjectState(kernel);
      } catch (err) {
        return gitToolError(err);
      }
      return {
        ok: true,
        data: {
          stateDir: getProjectPaths(requireProjectDir(kernel)).stateDir,
          routes: kernel.routes.list().length,
          handlers: kernel.handlers.list().length,
          functions: kernel.functions.list().length,
          message: "Project state written to disk.",
        },
      };
    }

    case "take_snapshot": {
      const meta = await kernel.snapshots.save(
        kernel,
        (input.description as string) ?? "",
      );
      return { ok: true, data: meta };
    }

    case "list_snapshots":
      return { ok: true, data: kernel.snapshots.list() };

    case "restore_snapshot": {
      const result = await kernel.snapshots.restore(
        input.id as string,
        kernel,
        rebuild,
      );
      if (!result.ok) {
        return {
          ok: false,
          error: { code: "RESTORE_FAILED", message: result.error },
        };
      }

      await kernel.changelog.record({
        category: "snapshot",
        key: input.id as string,
        action: "restore",
        beforeSnapshot: null,
        afterSnapshot: null,
        context: ctx,
        undoable: false,
      });

      return {
        ok: true,
        data: { message: `Snapshot "${input.id}" restored.` },
      };
    }

    // --- Environment Variables ---

    case "set_env": {
      const key = input.key as string | undefined ??
        input.name as string | undefined;
      if (!key) {
        return {
          ok: false,
          error: { code: "MISSING_KEY", message: "A key is required." },
        };
      }
      const value = input.value as string;
      const existing = kernel.envVars.get(key);
      const before = existing
        ? { key: existing.key, value: existing.value }
        : null;

      kernel.envVars.define(key, value);

      await kernel.changelog.record({
        category: "env_var",
        key,
        action: before ? "update" : "create",
        beforeSnapshot: before,
        afterSnapshot: { key, value },
        context: ctx,
      });

      return {
        ok: true,
        data: { message: `Environment variable "${key}" set.` },
      };
    }

    case "get_env": {
      const key = input.key as string | undefined ??
        input.name as string | undefined;
      if (!key) {
        return {
          ok: false,
          error: { code: "MISSING_KEY", message: "A key is required." },
        };
      }
      const resolved = kernel.envVars.resolve(key) ?? kernel.env.get(key);
      if (resolved === undefined) {
        return {
          ok: false,
          error: {
            code: "NOT_FOUND",
            message: `Environment variable "${key}" not found.`,
          },
        };
      }
      return { ok: true, data: { name: key, value: resolved } };
    }

    case "list_env": {
      const vars = kernel.envVars.list();
      const data = vars.map((v) => ({
        name: v.key,
        value: kernel.envVars.resolve(v.key),
        status: kernel.envVars.status(v.key),
      }));
      return { ok: true, data };
    }

    case "delete_env": {
      const key = input.key as string | undefined ??
        input.name as string | undefined;
      if (!key) {
        return {
          ok: false,
          error: { code: "MISSING_KEY", message: "A key is required." },
        };
      }
      const existing = kernel.envVars.get(key);
      if (!existing) {
        return {
          ok: false,
          error: {
            code: "NOT_FOUND",
            message: `Environment variable "${key}" not found.`,
          },
        };
      }

      kernel.envVars.remove(key);

      await kernel.changelog.record({
        category: "env_var",
        key,
        action: "delete",
        beforeSnapshot: { key: existing.key, value: existing.value },
        afterSnapshot: null,
        context: ctx,
      });

      return {
        ok: true,
        data: { message: `Environment variable "${key}" deleted.` },
      };
    }

    case "define_env_var": {
      const key = input.key as string;
      const value = input.value as string | undefined;
      const description = input.description as string | undefined;
      // `clearValue` folds the former clear_env_var_value verb: drop the explicit
      // value and revert to the .env fallback.
      const clearValue = input.clearValue === true;
      const existing = kernel.envVars.get(key);
      const before = existing
        ? {
          key: existing.key,
          value: existing.value,
          description: existing.description,
        }
        : null;

      const entry = kernel.envVars.define(key, value, description);
      if (clearValue) {
        await kernel.envVars.clearValue(key);
      }

      await kernel.changelog.record({
        category: "env_var",
        key,
        action: before ? "update" : "create",
        beforeSnapshot: before,
        afterSnapshot: {
          key,
          value: kernel.envVars.get(key)?.value,
          description: entry.description,
        },
        context: ctx,
      });

      return {
        ok: true,
        data: {
          key,
          value: kernel.envVars.get(key)?.value,
          description: entry.description,
          status: kernel.envVars.status(key),
          message: `Env var "${key}" defined.`,
        },
      };
    }

    case "get_env_var": {
      const key = input.key as string;
      const entry = kernel.envVars.get(key);
      if (!entry) {
        return {
          ok: false,
          error: { code: "NOT_FOUND", message: `Env var "${key}" not found.` },
        };
      }
      return {
        ok: true,
        data: {
          key: entry.key,
          value: entry.value,
          description: entry.description,
          resolvedValue: kernel.envVars.resolve(key),
          status: kernel.envVars.status(key),
        },
      };
    }

    case "list_env_vars": {
      const envVars = kernel.envVars.list();
      const envData = envVars.map((v) => ({
        key: v.key,
        description: v.description,
        status: kernel.envVars.status(v.key),
        createdAt: v.createdAt,
        updatedAt: v.updatedAt,
      }));
      return { ok: true, data: envData };
    }

    case "delete_env_var": {
      const key = input.key as string;
      const existing = kernel.envVars.get(key);
      if (!existing) {
        return {
          ok: false,
          error: { code: "NOT_FOUND", message: `Env var "${key}" not found.` },
        };
      }

      kernel.envVars.remove(key);

      await kernel.changelog.record({
        category: "env_var",
        key,
        action: "delete",
        beforeSnapshot: {
          key: existing.key,
          value: existing.value,
          description: existing.description,
        },
        afterSnapshot: null,
        context: ctx,
      });

      return { ok: true, data: { key, message: `Env var "${key}" deleted.` } };
    }

    case "set_env_var_value": {
      const key = input.key as string;
      const value = input.value as string;
      const existing = await kernel.envVars.get(key);
      if (!existing) {
        return {
          ok: false,
          error: {
            code: "NOT_FOUND",
            message:
              `Env var "${key}" not found. Define it first with define_env_var.`,
          },
        };
      }

      const beforeValue = existing.value;
      await kernel.envVars.setValue(key, value);

      await kernel.changelog.record({
        category: "env_var",
        key,
        action: "update",
        beforeSnapshot: { key, value: beforeValue },
        afterSnapshot: { key, value },
        context: ctx,
      });

      return {
        ok: true,
        data: { key, message: `Env var "${key}" value set.` },
      };
    }

    case "clear_env_var_value": {
      const key = input.key as string;
      const existing = await kernel.envVars.get(key);
      if (!existing) {
        return {
          ok: false,
          error: { code: "NOT_FOUND", message: `Env var "${key}" not found.` },
        };
      }

      const beforeValue = existing.value;
      await kernel.envVars.clearValue(key);

      await kernel.changelog.record({
        category: "env_var",
        key,
        action: "update",
        beforeSnapshot: { key, value: beforeValue },
        afterSnapshot: { key, value: null },
        context: ctx,
      });

      return {
        ok: true,
        data: {
          key,
          status: await kernel.envVars.status(key),
          message: `Env var "${key}" value cleared. Will read from .env file.`,
        },
      };
    }

    // --- Secrets ---

    case "define_secret": {
      const key = input.key as string;
      const description = input.description as string | undefined;
      // `value` / `clearValue` fold the former set_secret_value / clear_secret_value
      // verbs: set an explicit value, or drop it to read from the process env.
      const value = input.value as string | undefined;
      const clearValue = input.clearValue === true;
      const existing = kernel.secrets.get(key);
      const before = existing
        ? { key: existing.key, description: existing.description }
        : null;

      const entry = kernel.secrets.define(key, description);
      if (clearValue) {
        kernel.secrets.clearValue(key);
      } else if (value !== undefined) {
        kernel.secrets.setValue(key, value);
      }

      await kernel.changelog.record({
        category: "secret",
        key,
        action: before ? "update" : "create",
        beforeSnapshot: before,
        afterSnapshot: { key, description: entry.description },
        context: ctx,
      });

      return {
        ok: true,
        data: {
          key,
          description: entry.description,
          status: kernel.secrets.status(key),
          message: `Secret "${key}" defined.`,
        },
      };
    }

    case "get_secret": {
      const key = input.key as string;
      const entry = kernel.secrets.get(key);
      if (!entry) {
        return {
          ok: false,
          error: { code: "NOT_FOUND", message: `Secret "${key}" not found.` },
        };
      }
      return {
        ok: true,
        data: {
          key: entry.key,
          description: entry.description,
          hasExplicitValue: entry.value !== undefined,
          status: kernel.secrets.status(key),
        },
      };
    }

    case "list_secrets":
      return {
        ok: true,
        data: kernel.secrets.list().map((s) => ({
          key: s.key,
          description: s.description,
          status: kernel.secrets.status(s.key),
          createdAt: s.createdAt,
          updatedAt: s.updatedAt,
        })),
      };

    case "delete_secret": {
      const key = input.key as string;
      const existing = kernel.secrets.get(key);
      if (!existing) {
        return {
          ok: false,
          error: { code: "NOT_FOUND", message: `Secret "${key}" not found.` },
        };
      }

      kernel.secrets.remove(key);

      await kernel.changelog.record({
        category: "secret",
        key,
        action: "delete",
        beforeSnapshot: {
          key: existing.key,
          description: existing.description,
        },
        afterSnapshot: null,
        context: ctx,
      });

      return { ok: true, data: { key, message: `Secret "${key}" deleted.` } };
    }

    case "set_secret_value": {
      const key = input.key as string;
      const value = input.value as string;
      const existing = kernel.secrets.get(key);
      if (!existing) {
        return {
          ok: false,
          error: {
            code: "NOT_FOUND",
            message:
              `Secret "${key}" not found. Define it first with define_secret.`,
          },
        };
      }

      const hadValue = existing.value !== undefined;
      kernel.secrets.setValue(key, value);

      await kernel.changelog.record({
        category: "secret",
        key,
        action: "update",
        beforeSnapshot: { key, hasValue: hadValue },
        afterSnapshot: { key, hasValue: true },
        context: ctx,
      });

      return { ok: true, data: { key, message: `Secret "${key}" value set.` } };
    }

    case "clear_secret_value": {
      const key = input.key as string;
      const existing = kernel.secrets.get(key);
      if (!existing) {
        return {
          ok: false,
          error: { code: "NOT_FOUND", message: `Secret "${key}" not found.` },
        };
      }

      const hadValue = existing.value !== undefined;
      kernel.secrets.clearValue(key);

      await kernel.changelog.record({
        category: "secret",
        key,
        action: "update",
        beforeSnapshot: { key, hasValue: hadValue },
        afterSnapshot: { key, hasValue: false },
        context: ctx,
      });

      return {
        ok: true,
        data: {
          key,
          status: kernel.secrets.status(key),
          message: `Secret "${key}" value cleared. Will read from env.`,
        },
      };
    }

    // --- Browser ---

    case "screenshot_app": {
      const path = (input.path as string) ?? "/";
      const selector = input.selector as string | undefined;
      const width = input.width as number | undefined;
      const height = input.height as number | undefined;
      const fullPage = input.fullPage as boolean | undefined;

      try {
        const result = await screenshotApp(kernel.appPort, path, {
          selector,
          width,
          height,
          fullPage,
        });
        const filePath = await saveScreenshot(kernel, result.png);
        return {
          ok: true,
          data: {
            title: result.title,
            url: result.url,
            mode: result.mode,
            screenshot: filePath,
            consoleMessages: result.consoleMessages,
            pageErrors: result.pageErrors,
          },
          _images: [{ png: result.png }],
        };
      } catch (err) {
        return {
          ok: false,
          error: { code: "BROWSER_ERROR", message: errorMessage(err) },
        };
      }
    }

    case "test_app": {
      const path = (input.path as string) ?? "/";
      const steps = (input.steps as TestStep[]) ?? [];
      const width = input.width as number | undefined;
      const height = input.height as number | undefined;

      try {
        const result = await testApp(kernel.appPort, path, steps, {
          width,
          height,
        });
        const images: Array<{ png: Uint8Array }> = [{ png: result.finalPng }];
        const screenshots: string[] = [];
        for (const r of result.results) {
          if (r.screenshotPng) {
            images.push({ png: r.screenshotPng });
            screenshots.push(await saveScreenshot(kernel, r.screenshotPng));
            delete r.screenshotPng;
          }
        }
        const finalPath = await saveScreenshot(kernel, result.finalPng);
        return {
          ok: true,
          data: {
            allPassed: result.allPassed,
            title: result.title,
            url: result.url,
            mode: result.mode,
            results: result.results,
            screenshots: [finalPath, ...screenshots],
            consoleMessages: result.consoleMessages,
            pageErrors: result.pageErrors,
          },
          _images: images,
        };
      } catch (err) {
        return {
          ok: false,
          error: { code: "BROWSER_ERROR", message: errorMessage(err) },
        };
      }
    }

    case "browser_status": {
      try {
        const status = await browserStatus();
        if (!status.available) {
          return {
            ok: false,
            error: {
              code: "BROWSER_UNAVAILABLE",
              message: status.error ?? "Browser unavailable.",
            },
          };
        }
        return { ok: true, data: status };
      } catch (err) {
        return {
          ok: false,
          error: { code: "BROWSER_ERROR", message: errorMessage(err) },
        };
      }
    }

    case "get_platform_docs": {
      const topic = input.topic as string;
      const doc = getDoc(topic);
      if (!doc) {
        return {
          ok: false,
          error: {
            code: "NOT_FOUND",
            message: `Unknown doc topic "${topic}". Available: ${
              listTopics().join(", ")
            }`,
          },
        };
      }
      return {
        ok: true,
        data: {
          topic: doc.topic,
          title: doc.title,
          related: doc.related,
          content: doc.content,
        },
      };
    }

    case "list_projects": {
      const sessionLimit = Number(input.sessionLimit ?? 10);
      const projects = await listProjectMentionTargets({
        projectPath: kernel.projectDir,
        kernel,
        sessions: kernel.sessions,
      }, sessionLimit);
      return {
        ok: true,
        data: {
          projects,
          count: projects.length,
          context: projects.map(formatProjectContext).join("\n\n"),
        },
      };
    }

    case "get_project_context": {
      const project = resolveProject({
        projectPath: input.project_path as string | undefined,
        projectName: input.project_name as string | undefined,
      }, kernel.projectDir);
      if (!project) {
        return {
          ok: false,
          error: { code: "PROJECT_NOT_FOUND", message: "Project not found" },
        };
      }
      const summary = await getProjectSummary(project, {
        projectPath: kernel.projectDir,
        kernel,
        sessions: kernel.sessions,
      }, {
        includeSessions: input.include_sessions !== false,
        sessionLimit: Number(input.sessionLimit ?? 20),
      });
      return {
        ok: true,
        data: {
          project: summary,
          context: formatProjectContext(summary),
        },
      };
    }

    case "get_session_context": {
      const sessionId = input.session_id as string | undefined;
      if (!sessionId) {
        return {
          ok: false,
          error: { code: "INVALID_INPUT", message: "session_id is required" },
        };
      }
      const project = resolveProject({
        projectPath: input.project_path as string | undefined,
        projectName: input.project_name as string | undefined,
      }, kernel.projectDir);
      if (!project) {
        return {
          ok: false,
          error: { code: "PROJECT_NOT_FOUND", message: "Project not found" },
        };
      }
      const session = await getSessionContext(project, sessionId, {
        projectPath: kernel.projectDir,
        kernel,
        sessions: kernel.sessions,
      }, Number(input.messageLimit ?? 50));
      if (!session) {
        return {
          ok: false,
          error: { code: "SESSION_NOT_FOUND", message: "Session not found" },
        };
      }
      return {
        ok: true,
        data: {
          ...session,
          context: formatSessionContext(session),
        },
      };
    }

    case "list_current_session_pins": {
      if (!ctx?.sessionId) {
        return {
          ok: false,
          error: { code: "NO_SESSION", message: "No active session" },
        };
      }
      const pins = await getPinnedMessageInfos(
        kernel.sessions,
        "session",
        ctx.sessionId,
      );
      return {
        ok: true,
        data: {
          pins,
          context: formatPinnedMessagesContext(
            "Pinned session messages",
            pins,
          ),
        },
      };
    }

    case "list_current_project_pins": {
      const pins = await getPinnedMessageInfos(kernel.sessions, "project");
      return {
        ok: true,
        data: {
          pins,
          context: formatPinnedMessagesContext(
            "Pinned project messages",
            pins,
          ),
        },
      };
    }

    case "summarize_session": {
      const sessionId = (input.session_id as string | undefined) ??
        ctx?.sessionId;
      if (!sessionId) {
        return {
          ok: false,
          error: {
            code: "NO_SESSION",
            message: "No active session to summarize",
          },
        };
      }
      const result = await summarizeSession(kernel, {
        sessionId,
        kind: normalizeSummaryKind(input.kind),
        throughMessageId: input.throughMessageId as number | undefined,
        store: input.store === undefined ? true : Boolean(input.store),
        refresh: input.refresh === undefined ? false : Boolean(input.refresh),
        requester: "agent",
      });
      if (!result) {
        return {
          ok: false,
          error: { code: "SESSION_NOT_FOUND", message: "Session not found" },
        };
      }
      return { ok: true, data: result };
    }

    case "rename_session": {
      const sessionId = input.session_id as string | undefined;
      const newName = input.name as string;
      if (!newName) {
        return {
          ok: false,
          error: { code: "INVALID_INPUT", message: "name is required" },
        };
      }
      if (!sessionId) {
        return {
          ok: false,
          error: { code: "NO_SESSION", message: "No active session to rename" },
        };
      }
      await kernel.sessions.renameSession(sessionId, newName);
      return {
        ok: true,
        data: {
          sessionId,
          name: newName,
          message: `Session renamed to "${newName}"`,
        },
      };
    }

    case "manage_sessions": {
      const action = input.action as string | undefined;
      if (
        action !== "list" && action !== "search" && action !== "rename" &&
        action !== "end" && action !== "archive" && action !== "unarchive"
      ) {
        return {
          ok: false,
          error: {
            code: "INVALID_INPUT",
            message:
              "action must be list, search, rename, end, archive, or unarchive",
          },
        };
      }

      if (action === "list") {
        const limit = sessionToolLimit(input);
        const rawOffset = Number(input.offset ?? 0);
        const offset = Number.isFinite(rawOffset)
          ? Math.max(Math.trunc(rawOffset), 0)
          : 0;
        const includeArchived = Boolean(input.include_archived);
        const sessions = await kernel.sessions.listSessions(limit, offset, {
          includeArchived,
        });
        return {
          ok: true,
          data: {
            action,
            sessions: sessions.map(compactSession),
            count: sessions.length,
            limit,
            offset,
            includeArchived,
          },
        };
      }

      if (action === "search") {
        const query = String(input.query ?? "").trim();
        if (!query) {
          return {
            ok: false,
            error: { code: "INVALID_INPUT", message: "query is required" },
          };
        }
        const limit = sessionToolLimit(input);
        const includeArchived = input.include_archived === undefined
          ? true
          : Boolean(input.include_archived);
        const candidateLimit = Math.max(limit * 5, 100);
        const [sessions, matchingMessages] = await Promise.all([
          kernel.sessions.listSessions(candidateLimit, 0, { includeArchived }),
          kernel.sessions.searchMessages(query, { limit: candidateLimit }),
        ]);
        const messageSessionIds = new Set(
          matchingMessages.map((message) => message.sessionId),
        );
        const matches = sessions
          .filter((session) =>
            sessionMatchesText(session, query) ||
            messageSessionIds.has(session.id)
          )
          .slice(0, limit);
        return {
          ok: true,
          data: {
            action,
            query,
            sessions: matches.map(compactSession),
            count: matches.length,
            includeArchived,
          },
        };
      }

      const defaultsToCurrent = action === "rename" || action === "end";
      const sessionId = (input.session_id as string | undefined) ??
        (defaultsToCurrent ? ctx?.sessionId : undefined);
      if (!sessionId) {
        return {
          ok: false,
          error: {
            code: "NO_SESSION",
            message: defaultsToCurrent
              ? `No active session to ${action}`
              : "session_id is required",
          },
        };
      }
      const session = await kernel.sessions.getSession(sessionId);
      if (!session) {
        return {
          ok: false,
          error: { code: "SESSION_NOT_FOUND", message: "Session not found" },
        };
      }

      if (action === "rename") {
        const newName = String(input.name ?? "").trim();
        if (!newName) {
          return {
            ok: false,
            error: { code: "INVALID_INPUT", message: "name is required" },
          };
        }
        await kernel.sessions.renameSession(sessionId, newName);
        return {
          ok: true,
          data: {
            action,
            sessionId,
            name: newName,
            session: compactSession({ ...session, name: newName }),
            message: `Session renamed to "${newName}"`,
          },
        };
      }

      if (action === "end") {
        await kernel.sessions.endSession(sessionId);
        return {
          ok: true,
          data: {
            action,
            sessionId,
            message: "Session ended",
          },
        };
      }

      if (action === "archive") {
        await kernel.sessions.archiveSession(sessionId);
      } else {
        await kernel.sessions.unarchiveSession(sessionId);
      }
      const updated = await kernel.sessions.getSession(sessionId);
      return {
        ok: true,
        data: {
          action,
          sessionId,
          session: updated ? compactSession(updated) : null,
          message: action === "archive"
            ? `Session archived: ${session.name}`
            : `Session unarchived: ${session.name}`,
        },
      };
    }

    default:
      return {
        ok: false,
        error: { code: "UNKNOWN_TOOL", message: `Unknown tool: ${name}` },
      };
  }
}

// A3: restoring one side of a rename must also vacate the OTHER name. A rename
// record holds two names — its key (the new name) and context.renamedFrom (the old
// one); a snapshot restores exactly one of them, so the other must be removed or an
// undo/redo would leave a stale duplicate of the entity under both names. Returns the
// name to vacate, or undefined for any non-rename record.
function changeSummary(entry: ChangeRecord) {
  return {
    id: entry.id,
    category: entry.category,
    key: entry.key,
    action: entry.action,
  };
}

// The store moves the cursor as it hands entries out. If an apply fails, the
// cursor goes back to just past the last entry that did apply, so the failed
// entry is still the next one to undo or redo.
async function applyChangelogEntries(
  kernel: Kernel,
  entries: ChangeRecord[],
  side: "beforeSnapshot" | "afterSnapshot",
  cursorBefore: number | null,
  rebuild: () => void,
): Promise<{ ok: true } | { ok: false; error: string }> {
  for (const [i, entry] of entries.entries()) {
    const snapshot = entry[side];
    const result = await applySnapshot(
      entry.category,
      entry.key,
      snapshot,
      kernel,
      rebuild,
      renameVacateKey(entry, snapshot),
      entry.context,
    );
    if (result.ok) continue;
    const previous = entries[i - 1];
    const cursor = !previous
      ? cursorBefore
      : side === "beforeSnapshot"
      ? entry.id
      : previous.id;
    await kernel.changelog.restoreCursor(cursor);
    return {
      ok: false,
      error: result.error ?? `Change #${entry.id} could not be applied.`,
    };
  }
  return { ok: true };
}

function renameVacateKey(
  entry: ChangeRecord,
  snapshot: unknown,
): string | undefined {
  if (entry.action !== "rename") return undefined;
  const from = entry.context?.renamedFrom;
  if (!from) return undefined;
  const restoredName = (snapshot as { name?: string } | null)?.name;
  // beforeSnapshot restores `from` ⇒ vacate the new key (undo); afterSnapshot
  // restores the new key ⇒ vacate `from` (redo).
  return restoredName === from ? entry.key : from;
}

// Re-index the source-backed codebase and refresh the cached graph so
// GET /api/codebase and the framework overlay reflect on-disk edits. Best-effort:
// a failed re-index is logged, never thrown (the file write already succeeded).
// Returns the fresh summary, or null when there is no project or indexing failed.
// A full re-index is acceptable for v1 (docs/project-import-strategy.md Slice 5).
export async function reindexSourceBackedCodebase(
  kernel: Kernel,
): Promise<CodebaseGraphSummary | null> {
  if (!kernel.projectDir) return null;
  try {
    const { graph, discovery } = await indexSourceBackedCodebase({
      projectId: kernel.projectDir,
      rootPath: kernel.projectDir,
    });
    kernel.codebaseGraph = graph;
    return summarizeCodebaseGraph(graph, discovery);
  } catch (err) {
    kernel.log.log(
      "warn",
      "system",
      `Re-index after source-backed edit failed: ${errorMessage(err)}`,
    );
    return null;
  }
}

// Bulk data rewrites (fixture import, reset) can't be undone from a snapshot, but
// they still belong to the changeset that made them.
async function recordDataRewrite(
  kernel: Kernel,
  verb: "import_data" | "reset_data",
  tables: string[],
  detail: Record<string, unknown>,
  ctx: ChangeContext | null,
): Promise<void> {
  await kernel.changelog.record({
    category: "sql",
    key: verb,
    action: "execute",
    beforeSnapshot: null,
    afterSnapshot: { verb, tables, ...detail },
    context: ctx,
    undoable: false,
  });
}

async function readTextIfExists(path: string): Promise<string | null> {
  try {
    return await Deno.readTextFile(path);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return null;
    throw err;
  }
}

// Writes a project file outside the text-file editor (generated docs, agent-written
// files) and records it with the same whole-file snapshots apply_project_file uses.
async function writeRecordedProjectFile(
  kernel: Kernel,
  projectDir: string,
  fullPath: string,
  content: string,
  ctx: ChangeContext | null,
): Promise<void> {
  const key = relative(projectDir, fullPath).split(sep).join("/");
  const before = await readTextIfExists(fullPath);
  await Deno.mkdir(dirname(fullPath), { recursive: true });
  await Deno.writeTextFile(fullPath, content);
  await kernel.changelog.record({
    category: "module",
    key,
    action: before === null ? "create" : "update",
    beforeSnapshot: before === null ? null : { path: key, content: before },
    afterSnapshot: { path: key, content },
    context: {
      ...ctx,
      sourceBacked: true,
      projectFile: true,
      userMessage: ctx?.userMessage ?? "Project file write",
    },
    undoable: canRestoreSourceSnapshot(projectDir, key),
  });
}

// Deletes a project file and records it the same way, so undo writes it back.
// No tool reaches this: a task merge is the only caller. A file that's already
// gone is a no-op.
export async function removeRecordedProjectFile(
  kernel: Kernel,
  projectDir: string,
  relPath: string,
  ctx: ChangeContext | null,
): Promise<void> {
  const fullPath = normalize(resolve(projectDir, relPath));
  if (!fullPath.startsWith(projectDir + sep)) {
    throw new Error(`"${relPath}" is outside the project directory.`);
  }
  const before = await readTextIfExists(fullPath);
  if (before === null) return;
  await Deno.remove(fullPath);
  const key = relative(projectDir, fullPath).split(sep).join("/");
  await kernel.changelog.record({
    category: "module",
    key,
    action: "delete",
    beforeSnapshot: { path: key, content: before },
    afterSnapshot: null,
    context: { ...ctx, sourceBacked: true, projectFile: true },
    undoable: canRestoreSourceSnapshot(projectDir, key),
  });
}

async function applySnapshot(
  category: string,
  key: string,
  snapshot: unknown,
  kernel: Kernel,
  rebuild: () => void,
  vacateKey?: string,
  context?: ChangeContext | null,
): Promise<{ ok: boolean; error?: string }> {
  const deps = await kernel.compileDeps();
  switch (category) {
    case "handler": {
      if (snapshot === null) {
        kernel.handlers.remove(key);
        rebuild();
      } else {
        const { name, source, schema, module, runtimeId, language, purpose } =
          snapshot as {
            name: string;
            source: string;
            schema?: RouteSchema;
            module?: string;
            runtimeId?: string;
            language?: string;
            purpose?: string;
          };
        const result = await compileRuntimeHandler(kernel, name, source, deps);
        if (!result.ok) {
          return {
            ok: false,
            error:
              `Failed to compile handler "${name}": ${result.error?.message}`,
          };
        }
        kernel.handlers.register(
          name,
          source,
          result.data,
          schema,
          module,
          runtimeId ?? kernel.runtimeId,
          language ?? kernel.runtime.defaultLanguage,
          purpose,
        );
        // A3: undo/redo of a rename restores one name and vacates the other.
        if (vacateKey && vacateKey !== name) kernel.handlers.remove(vacateKey);
        rebuild();
      }
      return { ok: true };
    }

    case "function": {
      if (snapshot === null) {
        kernel.functions.remove(key);
      } else {
        const {
          name,
          source,
          module,
          returnType,
          runtimeId,
          language,
          purpose,
        } = snapshot as {
          name: string;
          source: string;
          module?: string;
          returnType?: string;
          runtimeId?: string;
          language?: string;
          purpose?: string;
        };
        const result = await compileRuntimeFunction(kernel, name, source, deps);
        if (!result.ok) {
          return {
            ok: false,
            error:
              `Failed to compile function "${name}": ${result.error?.message}`,
          };
        }
        kernel.functions.register(
          name,
          source,
          result.data,
          module,
          returnType,
          runtimeId ?? kernel.runtimeId,
          language ?? kernel.runtime.defaultLanguage,
          purpose,
        );
        // A3: undo/redo of a rename restores one name and vacates the other.
        if (vacateKey && vacateKey !== name) kernel.functions.remove(vacateKey);
      }
      return { ok: true };
    }

    case "route": {
      if (snapshot === null) {
        const [method, ...pathParts] = key.split(" ");
        kernel.routes.unregister(method!, pathParts.join(" "));
      } else {
        const { method, path, handlerName, schema, module } = snapshot as {
          method: string;
          path: string;
          handlerName: string;
          schema?: RouteSchema;
          module?: string;
        };
        kernel.routes.register(method, path, handlerName, schema, module);
      }
      rebuild();
      return { ok: true };
    }

    case "config": {
      if (snapshot === null) {
        kernel.configs.delete(key);
      } else {
        const { name, value, description } = snapshot as {
          name: string;
          value: unknown;
          description?: string;
        };
        kernel.configs.set(name, value, description);
      }
      return { ok: true };
    }

    case "asset": {
      if (snapshot === null) {
        kernel.assets.remove(key);
      } else {
        const asset = snapshot as AssetSnapshot;
        const content = assetSnapshotBytes(kernel, asset);
        if (!content) {
          return {
            ok: false,
            error:
              `Asset "${key}" bytes are not in the changelog or the blob store; nothing was restored.`,
          };
        }
        kernel.assets.register(
          asset.name,
          content,
          asset.mimeType,
          asset.module,
        );
      }
      rebuild();
      return { ok: true };
    }

    case "template": {
      if (snapshot === null) {
        kernel.templates.remove(key);
      } else {
        const { name, content, module } = snapshot as {
          name: string;
          content: string;
          module?: string;
        };
        kernel.templates.register(name, content, module);
      }
      return { ok: true };
    }

    case "test": {
      if (snapshot === null) {
        kernel.tests.remove(key);
      } else {
        const { name, source, module, changesetId, runtimeId, language } =
          snapshot as {
            name: string;
            source: string;
            module?: string;
            changesetId?: string;
            runtimeId?: string;
            language?: string;
            verification?: TestVerificationMetadata;
          };
        const result = await compileRuntimeTest(kernel, name, source, deps);
        if (!result.ok) {
          return {
            ok: false,
            error: `Failed to compile test "${name}": ${result.error?.message}`,
          };
        }
        kernel.tests.register(
          name,
          source,
          result.data,
          module,
          changesetId,
          runtimeId ?? kernel.runtimeId,
          language ?? kernel.runtime.defaultLanguage,
          (snapshot as { verification?: TestVerificationMetadata })
            .verification,
        );
      }
      return { ok: true };
    }

    case "dev_view": {
      if (snapshot === null) {
        kernel.devViews.remove(key);
      } else {
        const { name, targetType, title, source, module, runtimeId, language } =
          snapshot as {
            name: string;
            targetType: string;
            title: string;
            source: string;
            module?: string;
            runtimeId?: string;
            language?: string;
          };
        const result = await compileRuntimeDevView(kernel, name, source, deps);
        if (!result.ok) {
          return {
            ok: false,
            error:
              `Failed to compile dev view "${name}": ${result.error?.message}`,
          };
        }
        kernel.devViews.register(
          name,
          targetType,
          title,
          source,
          result.data,
          false,
          module,
          runtimeId ?? kernel.runtimeId,
          language ?? kernel.runtime.defaultLanguage,
        );
      }
      return { ok: true };
    }

    case "dev_tool": {
      if (snapshot === null) {
        kernel.devTools.remove(key);
      } else {
        const { name, description, args, source, module, runtimeId, language } =
          snapshot as {
            name: string;
            description: string;
            args: Array<
              {
                name: string;
                type: string;
                description: string;
                required: boolean;
              }
            >;
            source: string;
            module?: string;
            runtimeId?: string;
            language?: string;
          };
        const result = await compileRuntimeDevTool(
          kernel,
          name,
          source,
          args,
          deps,
        );
        if (!result.ok) {
          return {
            ok: false,
            error:
              `Failed to compile dev tool "${name}": ${result.error?.message}`,
          };
        }
        kernel.devTools.register(
          name,
          description,
          args,
          source,
          result.data,
          module,
          runtimeId ?? kernel.runtimeId,
          language ?? kernel.runtime.defaultLanguage,
        );
      }
      return { ok: true };
    }

    case "secret": {
      if (snapshot === null) {
        kernel.secrets.remove(key);
      } else {
        const { key: k, description } = snapshot as {
          key: string;
          description?: string;
        };
        kernel.secrets.define(k, description);
      }
      return { ok: true };
    }

    case "schema": {
      // Only a module move is a snapshot: DDL undo goes through migrations.
      const entry = snapshot as
        | { module?: string; moduleOnly?: boolean }
        | null;
      if (!entry?.moduleOnly) {
        return {
          ok: false,
          error:
            `Schema "${key}" changes can't be undone from the changelog. Use the migration rollback.`,
        };
      }
      const moved = await kernel.db.setSchemaModule(key, entry.module);
      return moved.ok
        ? { ok: true }
        : { ok: false, error: moved.error.message };
    }

    case "env_var": {
      if (snapshot === null) {
        kernel.envVars.remove(key);
        return { ok: true };
      }
      // value-only records (set/clear_env_var_value) carry no description;
      // define() keeps the existing one when it is undefined.
      const { value, description } = snapshot as {
        value?: string | null;
        description?: string;
      };
      kernel.envVars.define(key, undefined, description);
      if (typeof value === "string") kernel.envVars.setValue(key, value);
      else kernel.envVars.clearValue(key);
      return { ok: true };
    }

    case "type": {
      if (snapshot === null) {
        kernel.types.remove(key);
      } else {
        const { name, fields, description, module } = snapshot as {
          name: string;
          fields: TypeFieldDef[];
          description?: string;
          module?: string;
        };
        kernel.types.register(name, fields, description, module);
      }
      return { ok: true };
    }

    case "audit": {
      if (snapshot === null) {
        kernel.customAudits.remove(key);
        return { ok: true };
      }
      const { name, description, prompt, module } = snapshot as {
        name: string;
        description: string;
        prompt?: string;
        module?: string;
      };
      if (prompt === undefined) {
        return {
          ok: false,
          error:
            `Audit "${name}" was recorded without its prompt and can't be restored.`,
        };
      }
      kernel.customAudits.register(name, description, prompt, module);
      return { ok: true };
    }

    case "module": {
      // Source-backed file edits (project-import Slice 5) ride the `module`
      // category, tagged with context.sourceBacked. Undo/redo re-applies the stored
      // whole-file snapshot to disk (write content, or delete when null), then
      // re-indexes so the graph/overlay track the reverted file. Registry `module`
      // records (a grouping label) carry no sourceBacked flag and remain un-undoable.
      if (!context?.sourceBacked) {
        return {
          ok: false,
          error:
            `Cannot undo/redo changes to category "${category}". Use snapshots instead.`,
        };
      }
      if (!kernel.projectDir) {
        return {
          ok: false,
          error:
            "No project is loaded to apply a source-backed file change against.",
        };
      }
      const restored = writeSourceSnapshot(
        kernel.projectDir,
        key,
        asSourceFileSnapshot(snapshot),
      );
      if (!restored.ok) {
        return { ok: false, error: restored.error.message };
      }
      if (readProjectMode(kernel.projectDir) === PROJECT_MODE_SOURCE_BACKED) {
        await reindexSourceBackedCodebase(kernel);
      }
      return { ok: true };
    }

    default:
      return {
        ok: false,
        error:
          `Cannot undo/redo changes to category "${category}". Use snapshots instead.`,
      };
  }
}
