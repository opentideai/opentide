// @layer agent-loop — the open agentic orchestration loop (streaming, tool dispatch,
// changeset-lifecycle driving, session/context assembly). Carries no agent-facing
// intelligence: the system prompt, model choice, and approval heuristic arrive via an
// injected ChatIntelligence brain (core/chat-intelligence.ts). Must not import agent/.
import type { Kernel } from "../core/registries.ts";
import type { ChatIntelligence } from "../core/chat-intelligence.ts";
import { AGENT_TOOLS } from "../core/tools/definitions.ts";
import { checkToolArgs, formatArgIssues } from "../core/tools/validate-args.ts";
import {
  dispatchTool,
  flushKernelProjectState,
  isMutationTool,
  runExportTypeCheck,
  runKernelTests,
} from "../core/tools/dispatch.ts";
import { gitCommit, GitProjectError } from "../core/git.ts";
import { checkProjectAwareReadiness } from "../core/project-readiness.ts";
import { computeCoverage } from "../core/coverage.ts";
import { testApp } from "../core/browser.ts";
import type {
  ChangeContext,
  ChangeRecord,
  TurnGroup,
} from "../core/changelog.ts";
import { SessionManager } from "../core/sessions.ts";
import type { MCPManager } from "../core/mcp.ts";
import type {
  ModelUsageRecord,
  RecordModelUsageInput,
  Result,
  Session,
  StoredMessage,
  TurnUsage,
} from "../core/types.ts";
// The neutral transport seam (multi-model harness, Stage 3a). agent-loop imports
// ONLY the L1 contract types here — never a concrete ModelProvider impl or a
// provider SDK; the impl is injected by the composition root (D1, lint:layers).
import type {
  ModelProvider,
  NeutralContentBlock,
  NeutralMessage,
  NeutralReasoningBlock,
  NeutralTool,
  NeutralToolResultBlock,
  ProviderStopReason,
  TurnRequest,
} from "../core/model-provider.ts";
// Value import (the semantic provider-error codes) — agent-loop compares against
// CONTEXT_LENGTH_EXCEEDED to drive Slice 5 recovery. These live in L1 core, NOT in
// providers/, precisely so the loop can read them without importing the provider layer
// (lint:layers).
import {
  modelVisibleToolOutput,
  PROVIDER_ERROR_CODES,
  wireVisibleToolOutput,
} from "../core/model-provider.ts";
import { toNeutralTools } from "../core/tools/schema-adapt.ts";
import type { CurrentUser } from "../core/auth.ts";
import type {
  ChatEvent,
  ChatEventHandler,
  ChatRuntime,
  InProgressDetail,
  InProgressState,
} from "../core/chat-contract.ts";
import { canReadUserSession, localUser } from "../core/auth.ts";
import {
  computeProviderModelCost,
  contextOccupancyTokens,
} from "../core/usage.ts";
import {
  getModelForRoleRequest,
  type ModelProviderId,
  type ModelRole,
  providerFor,
} from "../core/config.ts";
import {
  type ContextPressure,
  contextWindowFor,
  effectiveInputBudget,
  estimatedContextPressure,
  estimateTokens,
  maxOutputTokensFor,
  modelInputCapacity,
} from "../core/context-window.ts";
import { summarizeSession } from "../core/session-summary.ts";
import {
  CACHE_STABLE_PREFIX_MESSAGES,
  CacheCompositionTracer,
  type PendingCacheTrace,
} from "../core/cache-composition.ts";
import { getProjectPaths } from "../core/project-manager.ts";
import {
  decodeBase64,
  encodeBase64,
  errorMessage,
  stripModelContextContent,
} from "../core/util.ts";
import {
  AUTOCOMPACT_RETAINED_TURNS,
  BROWSER_GATE_ATTEMPTS,
  CACHE_COLD_PREFIX_IDLE_MS,
  CHAT_CONTEXT_TRUNCATE_DEFAULT,
  CONTEXT_AUTOCOMPACT_MESSAGE,
  CONTEXT_LENGTH_HARD_FLOOR_MESSAGE,
  CONTEXT_NUDGE_MESSAGE,
  CONTEXT_PRUNE_MIN_RESULT_BYTES,
  CONTEXT_PRUNE_NOTICE,
  CONTEXT_PRUNE_REARM_GROWTH,
  CONTEXT_RETAIN_TOOL_RESULTS,
  CONTEXT_SAFETY_MARGIN,
  getAgentModel,
  getKernelSettings,
  MAX_CONTEXT_RECOVERY_ATTEMPTS,
  MAX_OUTPUT_TRUNCATED_MESSAGE,
  MAX_TURN_CONTINUATIONS,
  MODEL_UNCONFIGURED_MESSAGE,
  TURN_CONTINUATION_NOTICE,
  TURN_CONTINUATION_PROMPT,
} from "../core/config.ts";
import {
  type GateOutcome,
  isPendingStep,
  type PlanStep,
  runPlan,
  stepCommitMessage,
} from "./step-orchestrator.ts";
import { sortRoutes } from "../core/types.ts";

// Whether an approved plan is worth driving as a per-step loop. Per-step execution
// exists to give each step a FRESH bounded context, so with one remaining step it
// buys nothing and costs an extra full system-prompt + tool-schema prefix for the
// same work. A single-step plan runs inline in the approval turn instead.
export function hasMultipleSteps(changeset: Changeset): boolean {
  return changeset.plan.steps.filter((step) => isPendingStep(step.status))
    .length > 1;
}
import type { Changeset } from "../verification/changesets.ts";
import { createTimestampedId } from "../core/ids.ts";
import {
  buildWorkItemPayload,
  encodeWorkItemMessage,
} from "../core/work-items.ts";
import {
  formatPinnedMessagesContext,
  getPinnedMessageInfos,
} from "../core/project-context.ts";
import {
  ATTACHMENT_DOCUMENT_SOURCE,
  type DocumentRecord,
  type DocumentRef,
  type DocumentRefRole,
  type DocumentStore,
  PLAN_DOCUMENT_KIND,
  PLAN_DOCUMENT_SOURCE,
  SCREENSHOT_DOCUMENT_KIND,
  SCREENSHOT_DOCUMENT_SOURCE,
} from "../core/documents.ts";

const AGENT_TOOLS_BY_NAME = new Map(AGENT_TOOLS.map((t) => [t.name, t]));

export interface WireAttachment {
  name: string;
  type: string;
  data: string;
}

// The tool-count ceiling handed to a turn: our AGENT_TOOLS plus MCP tools up to this
// budget. A named constant so the loop's tool assembly never drifts on the limit.
const MAX_AGENT_TOOLS = 128;

// The changeset-lifecycle tools: when a turn calls any of these, the agent is driving
// the changeset itself, so the loop's structural step auto-advance / auto-complete
// safety net stays dormant (it only fires for builder-tool-only turns). Shared by both
// loops' step-advance tail so the two never drift on the set.
const CHANGESET_LIFECYCLE_TOOLS: ReadonlySet<string> = new Set([
  "create_changeset",
  "update_changeset_plan",
  "amend_changeset_plan",
  "update_changeset_step",
  "complete_changeset",
  "abandon_changeset",
  "adopt_changeset",
]);

// The plan-authoring subset of the changeset tools: their results carry a `_changeset`
// whose plan-message id the loop anchors onto the changeset. Shared by the inline
// changeset handler and the segment-anchoring tail.
const CHANGESET_PLAN_TOOLS: ReadonlySet<string> = new Set([
  "create_changeset",
  "update_changeset_plan",
  "amend_changeset_plan",
]);

// A user turn's wire content blocks: a text block or a base64 image/document block.
// These were the Anthropic beta Managed-Agents block shapes; defined locally now that
// the loop reaches the model only through the ModelProvider seam (no SDK import). The
// local loop maps them to NeutralContentBlock via toNeutralContentBlocks — the base64
// subset the builders below produce.
type UserContentBlock =
  | { type: "text"; text: string }
  | {
    type: "image";
    source: { type: "base64"; media_type: string; data: string };
  }
  | {
    type: "document";
    source: { type: "base64"; media_type: string; data: string };
    title?: string;
  };

type UserContentBlocks = UserContentBlock[];

export type ChatTurnModelRole = Extract<ModelRole, "agent" | "planning">;

export function selectChatTurnModelRole(opts: {
  changeset: Changeset | null;
  approvalStarted: boolean;
}): ChatTurnModelRole {
  if (opts.changeset?.status === "planning" && !opts.approvalStarted) {
    return "planning";
  }
  return "agent";
}

type SessionNameGenerator = (
  firstUserMessage: string,
  log: Kernel["log"],
  opts?: {
    sessionId?: string | null;
    recordUsage?: (
      input: RecordModelUsageInput,
    ) => Promise<ModelUsageRecord>;
  },
) => Promise<string>;

export function decodeBase64Utf8(base64: string): string {
  return new TextDecoder().decode(decodeBase64(base64));
}

export function buildUserContentBlocks(
  content: string,
  attachments?: WireAttachment[],
): UserContentBlocks {
  const blocks: UserContentBlock[] = [];

  if (attachments && attachments.length > 0) {
    const inventory = attachments.map((att, index) =>
      `${index + 1}. ${att.name} (${att.type})`
    ).join("\n");
    blocks.push({
      type: "text",
      text: `The user attached file(s) to this message:\n${inventory}\n\n` +
        `If an attached image or screenshot is relevant to the request, ` +
        `inspect the visual content directly and mention what you see before ` +
        `relying on code, logs, or other tools.`,
    });

    for (const att of attachments) {
      if (att.type.startsWith("image/")) {
        blocks.push({
          type: "image",
          source: { type: "base64", media_type: att.type, data: att.data },
        });
      } else if (att.type === "application/pdf") {
        blocks.push({
          type: "document",
          source: { type: "base64", media_type: att.type, data: att.data },
          title: att.name,
        });
      } else {
        const decoded = decodeBase64Utf8(att.data);
        blocks.push({
          type: "text",
          text:
            `<attachment name="${att.name}" type="${att.type}">\n${decoded}\n</attachment>`,
        });
      }
    }
  }

  blocks.push({ type: "text", text: content });
  return blocks;
}

// Map the wire user content blocks (text/image/document shapes) onto the provider-neutral
// NeutralContentBlock union the client-side loop holds in its NeutralMessage[] (multi-model
// harness). The JSON-Schema-free payloads transfer verbatim — text stays text, a base64
// image/document keeps its media type + data — so a turn's content reaches any
// ModelProvider unchanged. A block of an unrecognized shape is skipped rather than
// mis-sent.
export function toNeutralContentBlocks(
  blocks: UserContentBlocks,
): NeutralContentBlock[] {
  const out: NeutralContentBlock[] = [];
  for (const block of blocks as UserContentBlock[]) {
    if (block.type === "text") {
      out.push({ type: "text", text: block.text });
    } else if (block.type === "image" && block.source.type === "base64") {
      out.push({
        type: "image",
        mediaType: block.source.media_type,
        data: block.source.data,
      });
    } else if (block.type === "document" && block.source.type === "base64") {
      out.push({
        type: "document",
        mediaType: block.source.media_type,
        data: block.source.data,
        ...(block.title ? { title: block.title } : {}),
      });
    }
  }
  return out;
}

// A turn's document @-mention as it arrives on the wire. Unlike every other mention
// type the client sends an UNRESOLVED marker (@[document:id]); the backend resolves it
// (D5). `versionHash` pins an exact version; omitted → the current head.
export interface WireDocumentRef {
  id: string;
  versionHash?: string;
}

// What a resolved mention yields: the content block(s) fed to the model for THIS turn
// and the exact version cited, so the caller can record a message-role mention ref.
export interface ResolvedDocumentMention {
  blocks: UserContentBlock[];
  resolved: Array<{ documentId: string; versionHash: string }>;
}

// Resolve a turn's document mentions server-side into content blocks (Tier-1, §7/§12).
// text/* & text/html → text block fed as SOURCE (not rendered); image/* → image block;
// application/pdf → document block. Unresolvable refs are skipped (a missing doc must
// not sink the turn). Recording the message ref is the caller's job (it needs the
// stored message id) via DocumentStore.recordRef against `resolved`.
export async function resolveDocumentMentions(
  store: DocumentStore,
  refs: WireDocumentRef[],
): Promise<ResolvedDocumentMention> {
  const blocks: UserContentBlock[] = [];
  const resolved: Array<{ documentId: string; versionHash: string }> = [];

  for (const ref of refs) {
    const read = await store.readContentBytes(ref.id, ref.versionHash);
    if (!read.ok) continue;
    const { document, version, bytes } = read.data;
    const mime = version.mime;

    if (mime.startsWith("image/")) {
      blocks.push({
        type: "image",
        source: { type: "base64", media_type: mime, data: encodeBase64(bytes) },
      });
    } else if (mime === "application/pdf") {
      blocks.push({
        type: "document",
        source: { type: "base64", media_type: mime, data: encodeBase64(bytes) },
        title: document.name,
      });
    } else {
      blocks.push({
        type: "text",
        text: `<document name="${document.name}" id="${document.id}" ` +
          `version="${version.versionHash}">\n` +
          `${new TextDecoder().decode(bytes)}\n</document>`,
      });
    }
    resolved.push({
      documentId: document.id,
      versionHash: version.versionHash,
    });
  }

  return { blocks, resolved };
}

// Reload recovery (§8/§10). A message's attachment bytes are dropped from the
// text-only reload path (formatRecentMessagesForContext strips `<attachments>`), but
// the Phase-3 message/attachment refs make them durable: given a stored message id,
// look up its `attachment` refs and resolve them back into content blocks (text →
// text source, image → image, pdf → document) via the same resolveDocumentMentions
// machinery. Each ref cites the exact version the agent saw, so recovery is byte-exact
// (D2). Unresolvable refs are skipped. This is the completing half of the dropped-bytes
// fix; the prompt-injection wiring onto the reload turn is deferred to Slice A.2 (it
// needs a content-block channel on reload, which the text system-prompt path lacks).
export async function resolveMessageAttachments(
  store: DocumentStore,
  messageId: number | string,
): Promise<ResolvedDocumentMention> {
  const refs = await store.listRefsByTarget(
    "message",
    String(messageId),
    "attachment",
  );
  const wire: WireDocumentRef[] = refs.map((ref) => ({
    id: ref.documentId,
    versionHash: ref.versionHash ?? undefined,
  }));
  return await resolveDocumentMentions(store, wire);
}

// Render a changeset's plan as a self-contained markdown document — the durable,
// human-readable capture of title + summary + steps (D4, Slice B). Deterministic (no
// timestamps or ids), so an unchanged re-plan content-addresses to the same blob and
// DocumentStore.update dedupes it to a no-op.
export function renderChangesetPlanDocument(cs: Changeset): string {
  const lines = [`# ${cs.title}`];
  const summary = cs.plan.summary.trim();
  if (summary) lines.push("", summary);
  if (cs.plan.steps.length > 0) {
    lines.push("", "## Steps", "");
    cs.plan.steps.forEach((step, index) => {
      lines.push(`${index + 1}. ${step.description}`);
    });
  }
  return `${lines.join("\n")}\n`;
}

// Capture a changeset's plan as a versioned agent document + a single changeset/plan
// ref citing the head (D4, minimal — plan §8, Slice B). ADDITIVE provenance: the jsonb
// `plan` on _genie_changesets stays authoritative; this is a durable, versioned pointer
// beside it. The plan doc is found by its ORIGIN — metadata.source=PLAN_DOCUMENT_SOURCE
// + sourceId=<changeset id> — NOT via the changeset/plan ref, so the pass is idempotent
// per changeset even if a prior ref write failed: a re-plan always rediscovers and
// updates the SAME doc instead of minting a duplicate. First plan → create() a
// session-scoped doc stamped with that origin; RE-PLAN (update/amend) → update() the
// same doc, minting a new immutable version and moving the head (D2) while versions
// accumulate but the doc does not. recordUniqueRef then re-points the single
// changeset/plan ref at the new head (atomically), so listRefsByTarget("changeset", id,
// "plan") always returns exactly one live ref — and a lost ref self-heals on the next
// capture. Best-effort: returns the store Result (never throws for the store's own
// errors) so the caller can degrade a provenance-write failure (e.g. PROJECT_REQUIRED
// with no project loaded) to a debug log without sinking the turn or blocking the
// changeset lifecycle.
export async function captureChangesetPlanDocument(
  store: DocumentStore,
  cs: Changeset,
): Promise<Result<DocumentRef>> {
  const content = renderChangesetPlanDocument(cs);
  const sessionId = cs.sessionId ?? undefined;

  const existing = await store.findBySource(PLAN_DOCUMENT_SOURCE, cs.id, {
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
      name: `Plan: ${cs.title}`,
      kind: PLAN_DOCUMENT_KIND,
      content,
      scope: "session",
      sessionId,
      createdBy: "agent",
      metadata: {
        source: PLAN_DOCUMENT_SOURCE,
        sourceId: cs.id,
        title: cs.title,
      },
    });
    if (!created.ok) return created;
    doc = created.data;
  }

  return await store.recordUniqueRef({
    documentId: doc.id,
    refType: "changeset",
    refId: cs.id,
    role: "plan",
    versionHash: doc.currentVersionHash,
    sessionId,
  });
}

// The stable, composite origin key for one screenshot BLOB produced by a tool call (Slice
// C-rich, SECONDARY). The producing tool-call id is the natural stable origin — but a single
// tool call can return an ARRAY of images, so the per-image index is composed in to keep
// each shot a distinct target. Like the run-evidence key, this ONE key is used both as the
// doc's metadata.sourceId (findBySource rediscovery) AND the ledger ref's refId
// (listRefsByTarget resolution), so a re-dispatch of the same tool call is a clean per-image
// no-op rather than a second doc or duplicate ref.
export function screenshotEvidenceLedgerKey(
  toolCallId: string,
  imageIndex: number,
): string {
  return `${toolCallId}:image:${imageIndex}`;
}

// Capture one screenshot PNG blob as a versioned agent image/png document + a single
// ledger/evidence ref citing the head (plan §8/§11, Slice C-rich — SECONDARY, agent-loop
// `_images` seam). This is a DIFFERENT seam from the core evidence-item capture: the raw
// bytes only exist here, in the open loop's tool-result handler, where DocumentStore is
// already wired as `this.kernel.documents` — so no helper is forced across both. The bytes
// are stored VERBATIM (DocumentStore.create accepts Uint8Array; content-addressing dedupes
// identical shots). ADDITIVE provenance, same contract as the item docs: the doc is found by
// its ORIGIN (metadata.source=SCREENSHOT_DOCUMENT_SOURCE + sourceId=<composite key>), so a
// re-dispatch rediscovers/updates the SAME doc and recordUniqueRef re-points the single ref
// at the head. Best-effort: returns the store Result (never throws for the store's own
// errors) so the caller degrades a provenance-write failure (e.g. PROJECT_REQUIRED with no
// project loaded) to a debug log without sinking the turn.
export async function captureScreenshotEvidenceDocument(
  store: DocumentStore,
  toolCallId: string,
  imageIndex: number,
  png: Uint8Array,
  sessionId: string | undefined,
): Promise<Result<DocumentRef>> {
  const ledgerKey = screenshotEvidenceLedgerKey(toolCallId, imageIndex);

  const existing = await store.findBySource(
    SCREENSHOT_DOCUMENT_SOURCE,
    ledgerKey,
    { sessionId },
  );

  let doc: DocumentRecord;
  if (existing) {
    const updated = await store.update(existing.id, {
      content: png,
      createdBy: "agent",
    });
    if (!updated.ok) return updated;
    doc = updated.data;
  } else {
    const created = await store.create({
      name: `Screenshot: ${ledgerKey}`,
      kind: SCREENSHOT_DOCUMENT_KIND,
      content: png,
      scope: "session",
      sessionId,
      createdBy: "agent",
      metadata: {
        source: SCREENSHOT_DOCUMENT_SOURCE,
        sourceId: ledgerKey,
        title: `Screenshot ${ledgerKey}`,
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

function truncateForContext(
  content: string,
  limit = CHAT_CONTEXT_TRUNCATE_DEFAULT,
): string {
  if (content.length <= limit) return content;
  return content.slice(0, limit - 24).trimEnd() + "\n...[truncated]";
}

function summarizeChangeRecord(change: ChangeRecord): string {
  return `${change.action} ${change.category}:${change.key} (#${change.id})`;
}

function summarizeChangeRecords(changes: ChangeRecord[], limit = 8): string {
  const listed = changes.slice(0, limit).map(summarizeChangeRecord);
  if (changes.length > listed.length) {
    listed.push(`... ${changes.length - listed.length} more change(s)`);
  }
  return listed.join(", ");
}

function summarizeChangesetSteps(cs: Changeset, limit = 4): string {
  const steps = cs.plan.steps.slice(0, limit).map((step) =>
    `[${step.status}] ${truncateForContext(step.description, 180)}`
  );
  if (cs.plan.steps.length > steps.length) {
    steps.push(`... ${cs.plan.steps.length - steps.length} more step(s)`);
  }
  return steps.join("; ");
}

function moduleSuffix(module: string | undefined): string {
  return module ? ` [${module}]` : "";
}

function summarizeLimited(lines: string[], limit: number): string[] {
  if (lines.length <= limit) return lines;
  return [...lines.slice(0, limit), `- ... ${lines.length - limit} more`];
}

function summarizeRouteSchema(
  schema: { summary?: string; tags?: string[] } | undefined,
): string {
  if (!schema) return " no schema";
  const parts = ["schema"];
  if (schema.summary) parts.push(truncateForContext(schema.summary, 80));
  if (schema.tags?.length) parts.push(`tags=${schema.tags.join(",")}`);
  return ` ${parts.join("; ")}`;
}

function summarizeSourceEntry(
  entry: {
    name: string;
    module?: string;
    purpose?: string;
    runtimeId?: string;
    language?: string;
    returnType?: string;
  },
): string {
  const parts = [`- ${entry.name}${moduleSuffix(entry.module)}`];
  if (entry.purpose) parts.push(`: ${truncateForContext(entry.purpose, 120)}`);
  const metadata = [
    entry.returnType ? `returns ${entry.returnType}` : "",
    entry.language,
    entry.runtimeId,
  ].filter(Boolean).join(", ");
  if (metadata) parts.push(` (${metadata})`);
  return parts.join("");
}

export async function formatCurrentAppMapForContext(
  kernel: Kernel,
): Promise<string> {
  const routes = sortRoutes(kernel.routes.list());
  const handlers = kernel.handlers.list().toSorted((a, b) =>
    a.name.localeCompare(b.name)
  );
  const functions = kernel.functions.list().toSorted((a, b) =>
    a.name.localeCompare(b.name)
  );
  const templates = kernel.templates.list().toSorted((a, b) =>
    a.name.localeCompare(b.name)
  );
  const assets = kernel.assets.list().toSorted((a, b) =>
    a.name.localeCompare(b.name)
  );
  const configs = kernel.configs.list().toSorted((a, b) =>
    a.name.localeCompare(b.name)
  );
  const types = kernel.types.serialize().toSorted((a, b) =>
    a.name.localeCompare(b.name)
  );
  const tests = kernel.tests.list().toSorted((a, b) =>
    a.name.localeCompare(b.name)
  );
  const modules = kernel.listModules();
  const schemas = (await kernel.db.listSchemas()).toSorted((a, b) =>
    a.tableName.localeCompare(b.tableName)
  );
  const recentRequests = kernel.requestLog.recent(5);

  const hasAppEntities = routes.length || handlers.length || functions.length ||
    schemas.length || templates.length || assets.length || configs.length ||
    types.length || tests.length || modules.length;
  if (!hasAppEntities) return "";

  const lines = [
    "Use this current app map before choosing inspection tools. It is metadata, not full source.",
    "Prefer targeted get_* source tools for entities named here; use query_database only for row data in listed schemas.",
  ];

  if (modules.length) lines.push(`modules: ${modules.join(", ")}`);

  if (routes.length) {
    lines.push("routes:");
    lines.push(
      ...summarizeLimited(
        routes.map((r) =>
          `- ${r.method} ${r.path} -> ${r.handlerName}${
            moduleSuffix(r.module)
          };${summarizeRouteSchema(r.schema)}`
        ),
        40,
      ),
    );
  }

  if (handlers.length) {
    lines.push("handlers:");
    lines.push(...summarizeLimited(handlers.map(summarizeSourceEntry), 50));
  }

  if (functions.length) {
    lines.push("functions:");
    lines.push(...summarizeLimited(functions.map(summarizeSourceEntry), 60));
  }

  if (schemas.length) {
    lines.push("schemas:");
    lines.push(...summarizeLimited(
      schemas.map((s) => {
        const cols = s.columns.map((c) =>
          `${c.name}:${c.type}${c.primaryKey ? " pk" : ""}${
            c.nullable ? " nullable" : ""
          }`
        ).join(", ");
        return `- ${s.tableName}${moduleSuffix(s.module)} (${cols})`;
      }),
      40,
    ));
  }

  if (templates.length) {
    lines.push("templates:");
    lines.push(
      ...summarizeLimited(
        templates.map((t) =>
          `- ${t.name}${moduleSuffix(t.module)} (${t.content.length} chars)`
        ),
        40,
      ),
    );
  }

  if (assets.length) {
    lines.push("assets:");
    lines.push(
      ...summarizeLimited(
        assets.map((a) =>
          `- ${a.name}${
            moduleSuffix(a.module)
          } (${a.mimeType}, ${a.size} bytes)`
        ),
        40,
      ),
    );
  }

  if (configs.length) {
    lines.push("configs:");
    lines.push(
      ...summarizeLimited(
        configs.map((c) =>
          `- ${c.name}${moduleSuffix(c.module)} (${c.type})${
            c.description ? `: ${truncateForContext(c.description, 100)}` : ""
          }`
        ),
        40,
      ),
    );
  }

  if (types.length) {
    lines.push("types:");
    lines.push(
      ...summarizeLimited(
        types.map((t) =>
          `- ${t.name}${moduleSuffix(t.module)} (${t.fields.length} fields)${
            t.description ? `: ${truncateForContext(t.description, 100)}` : ""
          }`
        ),
        40,
      ),
    );
  }

  if (tests.length) {
    lines.push("tests:");
    lines.push(
      ...summarizeLimited(
        tests.map((t) =>
          `- ${t.name}${moduleSuffix(t.module)}${
            t.lastResult
              ? ` (${t.lastResult.passed ? "passed" : "failed"})`
              : ""
          }`
        ),
        50,
      ),
    );
  }

  if (recentRequests.length) {
    lines.push("recent requests:");
    lines.push(
      ...recentRequests.map((r) =>
        `- ${r.method} ${r.path} -> ${r.status} (${Math.round(r.durationMs)}ms)`
      ),
    );
  }

  return lines.join("\n");
}

export function formatProjectHistoryForContext(
  source: { turns: TurnGroup[]; changesets: Changeset[] },
  opts: { turnLimit?: number; changesetLimit?: number } = {},
): string {
  const turnLimit = opts.turnLimit ?? 5;
  const changesetLimit = opts.changesetLimit ?? 6;
  const turns = source.turns.slice(0, turnLimit);
  const changesets = source.changesets.slice(0, changesetLimit);
  if (turns.length === 0 && changesets.length === 0) return "";

  const lines = [
    "Use this recent project history to understand why entities changed before editing existing code.",
    "History is evidence, not a hard constraint: current user requirements, current code, and validation still win.",
  ];

  if (changesets.length > 0) {
    lines.push("recent changesets:");
    for (const cs of changesets) {
      const summary = truncateForContext(
        cs.plan.summary || cs.description || "",
        280,
      );
      lines.push(
        `- ${cs.id} [${cs.status}] ${cs.title}` +
          (summary ? `; summary: ${summary}` : "") +
          (cs.plan.steps.length
            ? `; steps: ${summarizeChangesetSteps(cs)}`
            : ""),
      );
    }
  }

  if (turns.length > 0) {
    lines.push("recent turns:");
    for (const turn of turns) {
      const message = turn.userMessage
        ? truncateForContext(turn.userMessage, 260).replace(/\s+/g, " ")
        : "(no user message)";
      const changes = summarizeChangeRecords(turn.changes);
      const rationale = turn.changes.find((change) => change.rationale)
        ?.rationale;
      lines.push(
        `- ${turn.turnId} at ${turn.createdAt}` +
          (turn.changesetId ? `; changeset: ${turn.changesetId}` : "") +
          `; user: ${message}; changes: ${changes}` +
          (rationale ? `; why: ${truncateForContext(rationale, 220)}` : ""),
      );
    }
  }

  lines.push(
    "For relevant existing entities, use search_changes by key/module and get_change or get_changeset_context before planning risky edits.",
  );

  return lines.join("\n");
}

export function formatRecentMessagesForContext(
  messages: StoredMessage[],
  limit = 16,
): string {
  const recent = messages
    .filter((m) =>
      m.role === "user" || m.role === "assistant" || m.kind === "shell"
    )
    .slice(-limit)
    .map((m) => {
      const text = truncateForContext(stripModelContextContent(m.content));
      let tools = "";
      if (m.toolCalls) {
        try {
          const calls = JSON.parse(m.toolCalls) as Array<{ name?: string }>;
          const names = calls.map((c) => c.name).filter(Boolean);
          if (names.length) tools = `\n[tool calls: ${names.join(", ")}]`;
        } catch { /* ignore malformed historical tool metadata */ }
      }
      const body = text || tools.trim() || "(no text)";
      const label = m.kind === "shell" ? "shell" : m.role;
      return `#${m.id} ${label}:\n${body}${text ? tools : ""}`;
    });

  return recent.join("\n\n");
}

export function hasSessionContextToReload(
  session: Pick<Session, "summary" | "focus"> | null | undefined,
  messages: StoredMessage[],
): boolean {
  if (session?.summary?.trim() || session?.focus?.trim()) return true;
  return messages.some((m) => {
    if (m.role !== "user" && m.role !== "assistant" && m.kind !== "shell") {
      return false;
    }
    return Boolean(stripModelContextContent(m.content) || m.toolCalls);
  });
}

// ChatEvent / ChatEventHandler / ChatRuntime are the core chat contract
// (chat-contract.ts). Re-exported so existing importers keep resolving them here.
export type { ChatEvent, ChatEventHandler } from "../core/chat-contract.ts";

// Why a single streaming turn stopped — bookkeeping for runTurn's return value.
// Purely descriptive: it records which break the stream loop took (or how the
// turn ended) without influencing control flow.
export type TurnStopReason =
  | "end_turn"
  | "retries_exhausted"
  | "awaiting_approval"
  | "cancelled"
  // The model ran out of output budget mid-answer and the loop could not resume it
  // within MAX_TURN_CONTINUATIONS. Distinct from "end_turn" precisely because the
  // answer is INCOMPLETE: collapsing the two is what let a truncated turn present
  // itself as a finished one.
  | "max_tokens"
  | "error";

// Map a provider's normalized stop reason onto the loop's descriptive TurnStopReason
// (multi-model harness, Stage 3a). `requires_action` never reaches here as terminal —
// the loop consumes it by dispatching tools and looping — so it and a missing stop
// settle as a completed turn. `error` and `max_tokens` are each distinct: a turn the
// provider cut off at the output ceiling is truncated, not complete, and the loop
// only reaches this mapping for it once its continuations are spent.
function mapProviderStop(stop: ProviderStopReason | null): TurnStopReason {
  if (stop === "error") return "error";
  if (stop === "max_tokens") return "max_tokens";
  return "end_turn";
}

// Live context-window pressure after a turn (context-hardening plan, Slice 2).
// occupancy is the caller-summed input token total — input + cacheRead +
// cacheCreation, per the plan's occupancy nuance (cached tokens are billed cheap
// but still occupy the window). budget is the model's effective input budget
// (core/context-window.ts, Slice 1); pressure is the ratio, guarded so a
// non-positive budget (already over) reads as fully pressured rather than dividing.
function computeContextPressure(
  occupancy: number,
  model: string,
): ContextPressure {
  const contextWindow = contextWindowFor(model);
  const budget = effectiveInputBudget(model);
  const pressure = budget > 0 ? occupancy / budget : 1;
  return {
    occupancy,
    budget,
    pressure,
    model,
    contextWindow,
    outputReservation: maxOutputTokensFor(model),
    safetyMargin: CONTEXT_SAFETY_MARGIN,
    source: "provider",
  };
}

// Defensive parse of the session metadata JSON string (mirrors
// parseSessionMetadata in core/session-summary.ts): malformed / non-object JSON
// degrades to {} so a read-modify-write of the two context keys never throws or
// clobbers on bad data.
function parseSessionMetadata(
  metadata: string | null,
): Record<string, unknown> {
  if (!metadata) return {};
  try {
    const parsed: unknown = JSON.parse(metadata);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function writeLastContextMetadata(
  metadata: Record<string, unknown>,
  pressure: ContextPressure,
  model: string,
  measuredAt: string,
): void {
  metadata.lastContextTokens = pressure.occupancy;
  metadata.lastContextOccupancyTokens = pressure.occupancy;
  metadata.lastContextBudget = pressure.budget;
  metadata.lastContextPressure = pressure.pressure;
  metadata.lastContextModel = model;
  metadata.lastContextMeasuredAt = measuredAt;
  metadata.lastContextWindow = pressure.contextWindow;
  metadata.lastContextOutputReservation = pressure.outputReservation;
  metadata.lastContextSafetyMargin = pressure.safetyMargin;
  metadata.lastContextSource = pressure.source;
}

function clearLastContextMetadata(metadata: Record<string, unknown>): void {
  delete metadata.lastContextTokens;
  delete metadata.lastContextOccupancyTokens;
  delete metadata.lastContextBudget;
  delete metadata.lastContextPressure;
  delete metadata.lastContextModel;
  delete metadata.lastContextMeasuredAt;
  delete metadata.lastContextWindow;
  delete metadata.lastContextOutputReservation;
  delete metadata.lastContextSafetyMargin;
  delete metadata.lastContextSource;
}

// A finite number from an unknown metadata field, else null (used for the compaction
// boundary summarizedThroughMessageId, which may be absent/malformed on old sessions).
function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// The setup-produced inputs sendMessage hands runTurn: the composed user content,
// the event sink, the acting user, and the approval/active-changeset state resolved
// before the turn. Everything else runTurn needs is instance state. Exported so the
// per-step orchestrator (step-orchestrator.ts) can build a step turn's inputs and
// call the runner it receives as a bound dependency.
export interface RunTurnOptions {
  content: string;
  storedContent?: string;
  contentBlocks: UserContentBlocks;
  onEvent?: ChatEventHandler;
  user?: CurrentUser;
  // Whether this turn is the approval that flips the changeset into progress.
  approvalStarted: boolean;
  // The in-progress changeset for this turn, if any.
  activeWorkCs: Changeset | null;
  // Unresolved document @-mentions (Tier-1, §7). Resolved server-side into content
  // blocks for this turn only and recorded as message-role mention refs.
  documentRefs?: WireDocumentRef[];
  // The turn's raw attachments (Phase 3 Slice A, §8/§10). The bytes reach the model
  // live via contentBlocks; these are additionally persisted as session-scoped
  // documents + message/attachment refs so the bytes survive reload (the §1 bug).
  attachments?: WireAttachment[];
}

// The setup-produced inputs sendMessage hands runTurn (multi-model harness). The retained
// NeutralMessage[] (this.localMessages) is the turn memory, so — unlike RunTurnOptions —
// no per-turn content blocks are threaded here: the caller has already appended the user
// turn to the array. What remains are the assembled TurnRequest pieces (system/tools/model)
// plus the approval/changeset state and event sink resolved before the turn.
interface LocalTurnOptions {
  content: string;
  storedContent?: string;
  onEvent?: ChatEventHandler;
  user?: CurrentUser;
  approvalStarted: boolean;
  activeWorkCs: Changeset | null;
  system: string;
  tools: NeutralTool[];
  model: string;
  modelRole: ChatTurnModelRole;
  // Resolved document @-mentions for this turn (Tier-1, §7). The content blocks were
  // already prepended to the retained user message by sendMessage; these are the exact
  // versions cited, recorded as message-role mention refs once the durable user message
  // is stored.
  documentMentions?: Array<{ documentId: string; versionHash: string }>;
  // The turn's raw attachments (Phase 3 Slice A, §8/§10). The bytes reach the model live
  // via the retained user message; these are additionally persisted as session-scoped
  // documents + message/attachment refs so the bytes survive reload (the §1 bug).
  attachments?: WireAttachment[];
}

interface ContextPreflightResult {
  ok: boolean;
  system: string;
  tools: NeutralTool[];
  model: string;
}

// One tool call the loop recorded during a turn: the tool name, its input, and (once
// dispatched) its result. The recurring accumulator shape shared by both loops.
type ToolCallRecord = { name: string; input: unknown; result?: unknown };

function compactToolResult(result: unknown): unknown {
  if (result === undefined) return undefined;
  if (result === null) return { omitted: true, type: "null" };
  if (Array.isArray(result)) {
    return { omitted: true, type: "array", length: result.length };
  }
  if (typeof result === "object") {
    const keys = Object.keys(result as Record<string, unknown>);
    return {
      omitted: true,
      type: "object",
      keys: keys.slice(0, 8),
      keyCount: keys.length,
    };
  }
  if (typeof result === "string") {
    return { omitted: true, type: "string", length: result.length };
  }
  return { omitted: true, type: typeof result };
}

// One edit a planned trim WOULD make, held as data so the whole plan can be priced
// before a single byte is mutated. That ordering is the point: a trim's cost is the
// cache rewrite it forces, which is a function of what survives it, so the gate needs
// both "how much would this reclaim" and "how much would this invalidate" BEFORE
// committing to either.
type ContextTrimEdit =
  | {
    kind: "stub_tool_result";
    block: NeutralToolResultBlock;
    output: Record<string, unknown>;
  }
  | {
    kind: "drop_reasoning";
    message: NeutralMessage;
    content: NeutralContentBlock[];
  };

// What one in-turn trim would achieve: tokens reclaimed (the same chars/4 currency the
// pre-turn estimator uses), and the two block counts behind it. All three ride the
// diagnostic, because they are the only way to tell "the trim fired once and worked"
// from "the trim fires every request and costs more than it saves".
interface ContextTrimPlan {
  edits: ContextTrimEdit[];
  tokensReclaimed: number;
  blocksPruned: number;
  reasoningBlocksDropped: number;
}

// A single tool_result's cheap token estimate, measured exactly as the pre-turn
// estimator measures it (wire-visible output, chars/4), so reclaimed tokens are in the
// same currency as the occupancy a prune is trying to lower.
function toolResultTokens(block: NeutralToolResultBlock): number {
  return estimateTokens([{ role: "tool", content: [block] }]);
}

function isPrunedOutput(output: unknown): boolean {
  return !!output && typeof output === "object" && !Array.isArray(output) &&
    (output as Record<string, unknown>).pruned === true;
}

// The wire size of a tool result, for the "don't bother" floor. JSON length in chars,
// which is the byte count for everything but non-ASCII payloads — close enough for a
// 2 KB threshold, and it measures the WIRE shape (post-_changeset strip) so the floor
// compares against what is actually being re-sent.
function wireResultBytes(output: unknown): number {
  try {
    return JSON.stringify(wireVisibleToolOutput(output) ?? "")?.length ?? 0;
  } catch {
    return 0;
  }
}

// The stub that replaces a pruned result. `ok` is carried over verbatim — it is the
// field readers key on to tell a failed call from a successful one — and the
// compactToolResult keys (type, key names, lengths) tell the model WHAT it saw, so it
// can re-call the tool if it turns out to need the detail back.
function stubPrunedOutput(previous: unknown): Record<string, unknown> {
  const ok =
    previous && typeof previous === "object" && !Array.isArray(previous)
      ? (previous as Record<string, unknown>).ok
      : undefined;
  return {
    ...(ok === undefined ? {} : { ok }),
    pruned: true,
    ...(compactToolResult(previous) as Record<string, unknown> | undefined),
  };
}

// Mid-turn context ceiling (agent cost reduction, §4.7 + §4.8). The pre-turn guard
// (prepareContextPreflight) measures occupancy ONCE per sendMessage; a single turn then
// makes dozens of provider requests, each re-sending a context that only grows. This
// PLANS two reclaims over that context and mutates NOTHING:
//
//   §4.7 — replace the OLDEST tool results with the stub compactToolResult already
//          produces for the in-progress view, keeping the most recent `keepRecent`
//          intact, so an early 400 KB list_functions stops being re-read and re-billed.
//   §4.8 — drop reasoning blocks belonging to turns that have already SETTLED.
//          Anthropic only requires thinking blocks to round-trip within the assistant
//          turn that owns the tool_use; once that turn is behind us they are dead
//          weight, measured at 13.7% of the context and 19.4% of cache writes (§8).
//
// Planning is separate from applying because a trim's cost — the cache rewrite it
// forces — can only be priced against what would survive it. maybeTrimContextInTurn
// prices the plan and decides; applyContextTrim commits it.
//
// Invariants, in order of how badly they bite:
//   - NEVER delete a tool_result message or block. Anthropic rejects a tool_use with no
//     matching tool_result, and toModelMessages pairs the two by toolCallId. Stubbing
//     keeps the pairing; deleting shows up as a provider 400 weeks later. (Reasoning
//     blocks carry no such pairing — they ARE deleted, and only from settled turns.)
//   - Edits are applied IN PLACE — `block.output` rewritten, `message.content`
//     reassigned. Nothing here rebuilds a message, because runTurn's overflow recovery
//     identity-checks the triggering user message (`this.localMessages.includes(...)`);
//     a .map() that rebuilt messages would break that silently. User messages are never
//     touched at all, and neither is message 0 (see CACHE_STABLE_PREFIX_MESSAGES).
//   - Persistence is unaffected. The transcript is written by flushSegment /
//     ToolCallRecord, independently of localMessages, so no stub ever reaches the DB.
//
// Skipped, for tool results: anything already pruned, every block in the LAST tool-role
// message (the results the model is about to reason about), and anything under
// CONTEXT_PRUNE_MIN_RESULT_BYTES — stubbing a 40-byte run_tests result invalidates the
// cached prefix from that point on and reclaims nothing.
//
// `completedTurnEnd` is the index of the first message belonging to the LIVE turn:
// reasoning is only droppable strictly before it. Pass 0 to plan no reasoning drop at
// all; pass null for `keepRecent` to plan no tool-result stubbing.
function planContextTrim(
  messages: NeutralMessage[],
  opts: { keepRecent: number | null; completedTurnEnd: number },
): ContextTrimPlan {
  const edits: ContextTrimEdit[] = [];
  let tokensReclaimed = 0;
  let blocksPruned = 0;
  let reasoningBlocksDropped = 0;

  if (opts.keepRecent !== null) {
    const all: Array<
      { message: NeutralMessage; block: NeutralToolResultBlock }
    > = [];
    // From CACHE_STABLE_PREFIX_MESSAGES, not 0: message 0 sits inside the one cache
    // entry a mid-conversation mutation leaves alive, so it is never a trim target.
    for (const message of messages.slice(CACHE_STABLE_PREFIX_MESSAGES)) {
      if (message.role !== "tool") continue;
      for (const block of message.content) {
        if (block.type === "tool_result") all.push({ message, block });
      }
    }
    // Recency is counted in BLOCKS from the end, but the last tool-role message is
    // protected as a unit: a request that fired 20 parallel tools would otherwise have
    // part of its own freshly-appended results stubbed before the model ever read them.
    const lastToolMessage = all.at(-1)?.message;
    const prunable = all.slice(0, Math.max(0, all.length - opts.keepRecent));

    for (const { message, block } of prunable) {
      if (message === lastToolMessage) continue;
      if (isPrunedOutput(block.output)) continue;
      if (wireResultBytes(block.output) < CONTEXT_PRUNE_MIN_RESULT_BYTES) {
        continue;
      }
      const output = stubPrunedOutput(block.output);
      const reclaimed = toolResultTokens(block) -
        toolResultTokens({ ...block, output });
      if (reclaimed <= 0) continue;
      edits.push({ kind: "stub_tool_result", block, output });
      tokensReclaimed += reclaimed;
      blocksPruned++;
    }
  }

  for (
    let i = CACHE_STABLE_PREFIX_MESSAGES;
    i < Math.min(opts.completedTurnEnd, messages.length);
    i++
  ) {
    const message = messages[i];
    if (!message || message.role !== "assistant") continue;
    if (!message.content.some((b) => b.type === "reasoning")) continue;
    const content = message.content.filter((b) => b.type !== "reasoning");
    const dropped = message.content.length - content.length;
    edits.push({ kind: "drop_reasoning", message, content });
    tokensReclaimed +=
      estimateTokens([{ role: "assistant", content: message.content }]) -
      estimateTokens([{ role: "assistant", content }]);
    reasoningBlocksDropped += dropped;
  }

  return { edits, tokensReclaimed, blocksPruned, reasoningBlocksDropped };
}

function applyContextTrim(plan: ContextTrimPlan): void {
  for (const edit of plan.edits) {
    if (edit.kind === "stub_tool_result") edit.block.output = edit.output;
    else edit.message.content = edit.content;
  }
}

// What a trim would force the provider to re-write, in the same chars/4 currency as
// tokensReclaimed. The number does NOT depend on where the earliest edit lands: the
// cache breakpoints sit on the last tool schema, message 0 and the LAST message, with
// nothing in between (CACHE_STABLE_PREFIX_MESSAGES, mirrored in core/cache-composition
// and pinned by providers/cache-breakpoint-parity_test.ts), so touching message 1 and
// touching message 30 invalidate exactly the same extent. §8 measured it to the token:
// after the prune at request 1 the cache read fell to 52,149 — the session's first
// write, i.e. tools + system + message 0 survived and everything after it was rewritten.
//
// Post-trim, because that is what gets written: the tail as it stands, less whatever
// the trim would take out of it.
function prefixRewriteTokens(
  messages: NeutralMessage[],
  tokensReclaimed: number,
): number {
  return Math.max(
    0,
    estimateTokens(messages.slice(CACHE_STABLE_PREFIX_MESSAGES)) -
      tokensReclaimed,
  );
}

function toolCallsForInProgressState(
  calls: ToolCallRecord[],
  detail: InProgressDetail,
): ToolCallRecord[] {
  if (detail === "full") return calls.map((call) => ({ ...call }));
  return calls.map((call) => ({
    name: call.name,
    input: call.input,
    ...(call.result !== undefined
      ? { result: compactToolResult(call.result) }
      : {}),
  }));
}

// The outcome of one streaming turn. `usage` is the recorded TurnUsage, or null
// when no session was active (or the turn was cancelled before recording). Exported
// so the per-step orchestrator can inspect a step turn's stop reason and text.
export interface TurnResult {
  turnId: string;
  stopReason: TurnStopReason;
  fullText: string;
  toolCalls: ToolCallRecord[];
  usage: TurnUsage | null;
}

export class ChatOrchestrator implements ChatRuntime {
  private kernel: Kernel;
  private sessions: SessionManager;
  private mcpManager: MCPManager;
  private rebuild: () => void;
  private brain: ChatIntelligence;
  private model: string;
  // The injected transport seam (multi-model harness). The composition root injects a
  // concrete ModelProvider that drives the client-side loop. Mirrors the brain above.
  private provider: ModelProvider;
  // The client-side conversation state for the local loop (D2): a single local
  // NeutralMessage[] that IS the turn memory. An approval pause just stops iterating and
  // RETAINS this array; the next sendMessage appends to it and resumes — no rebuild.
  private localMessages: NeutralMessage[] = [];
  // Recovered prior-session context (summary/focus/pins/recent conversation) folded into
  // the system prompt after a resume/compact, when the retained array is reset to empty.
  // Held on the instance so it persists for the session's lifetime, while new turns
  // accumulate in localMessages — the local analogue of the Managed agent's rebuilt
  // system-prompt context. Cleared when the session is cleared or a fresh one starts.
  private recoveredContext: string | null = null;
  // One-shot arming for the Slice 3 context nudge: flipped true when a completed turn
  // first crosses CONTEXT_NUDGE_RATIO so the context_warning fires at most once, and
  // reset (resetContextWindowState) whenever the session's localMessages are reset
  // to a fresh window — clearContext / compactSession / resumeSession — or a turn
  // drops back under the ratio, so the next crossing re-arms.
  private contextNudged = false;
  // Compaction-loop brake (agent cost reduction, §4.6). Set when a pre-turn
  // auto-compaction ran and left the re-estimated occupancy STILL at or above the
  // auto-compact threshold — i.e. the post-compaction floor (summary +
  // AUTOCOMPACT_RETAINED_TURNS raw turns, folded into the system prompt) does not
  // fit under the working budget. At the old ~868k budget that never happened; at
  // 200k a single work turn's tail can be bigger than the whole budget. Without
  // this the guard fires again next turn, summarizes again, bills again, and makes
  // no progress. Cleared as soon as occupancy actually drops back under the
  // threshold — that is the re-arm.
  private autoCompactIneffective = false;
  // Arm-once for in-turn pruning (agent cost reduction, §4.7): the occupancy measured
  // at the last prune in this window, 0 when none has fired. A prune rewrites the
  // middle of the cached prefix, so the next one waits for CONTEXT_PRUNE_REARM_GROWTH
  // more occupancy rather than firing again on the following request — same arm-once
  // shape as contextNudged, and reset with it whenever the window is reset. Pruning
  // lowers the occupancy the turn tail persists, which is what re-arms the Slice-5
  // autoCompactIneffective brake above: freeing space is exactly the condition that
  // brake waits for.
  private lastPrunedAtOccupancy = 0;
  // Wall-clock ms when the last provider request of this session FINISHED — the moment
  // its cache entry was last touched, since a read refreshes the TTL as surely as a
  // write does. Read only by dropSettledReasoningIfPrefixCold, to tell a warm prefix
  // (mutating it costs a full rewrite) from an expired one (the rewrite is already
  // happening). 0 until the first request completes, which reads as "unknown, do
  // nothing". Deliberately NOT reset with the context window: it is a fact about the
  // provider's cache, not about our message array.
  private lastProviderRequestAt = 0;
  // The model the last provider request went to. A model change invalidates the
  // provider's cache outright — entries are keyed per model — so it is the second way
  // the prefix goes cold, and the one that also makes dropping settled reasoning a
  // CORRECTNESS fix: reasoning captured under one model must not be replayed into a
  // request to another. ai-sdk-shared's replay filter is provider-scoped
  // (block.provider === providerId), so it does not catch opus → sonnet on its own.
  private lastProviderRequestModel: string | null = null;
  private turnCount = 0;
  // Per-request cache-composition trace (agent cost reduction, §8), lazily built
  // on first use and only when the setting is on AND a project dir is loaded (the
  // trace writes into that project's history dir). Null = not tracing; every call
  // site is guarded, so the instrument is absent, not inert, when off.
  private cacheTracer: CacheCompositionTracer | null = null;
  private cacheTracerDir: string | null = null;
  private currentSessionId: string | null = null;
  private autoNameEligibleSessionIds = new Set<string>();
  private onTurnComplete?: () => void;
  private cancelledFlag = false;
  private inProgressText = "";
  private inProgressToolCalls: Array<
    { name: string; input: unknown; result?: unknown }
  > = [];
  private inProgressSegmentText = "";
  private inProgressSegmentToolCalls: Array<
    { name: string; input: unknown; result?: unknown }
  > = [];
  private inProgressBusy = false;
  private sessionNameGenerator: SessionNameGenerator;

  constructor(
    kernel: Kernel,
    rebuild: () => void,
    mcpManager: MCPManager,
    brain: ChatIntelligence,
    // The transport seam, injected by the composition root. Drives every turn; the
    // provider reads its API key lazily per request, so a key change needs no rebuild.
    provider: ModelProvider,
    sessionNameGenerator: SessionNameGenerator = SessionManager.generateName,
  ) {
    this.kernel = kernel;
    this.sessions = kernel.sessions;
    this.mcpManager = mcpManager;
    this.rebuild = rebuild;
    this.brain = brain;
    this.provider = provider;
    this.sessionNameGenerator = sessionNameGenerator;
    // The user-configured model (may be the DEFAULT_MODEL_ID sentinel); the brain
    // resolves the sentinel to the effective request model at turn time.
    this.model = getAgentModel();
  }

  setOnTurnComplete(cb: () => void): void {
    this.onTurnComplete = cb;
  }

  abort(): void {
    this.cancelledFlag = true;
  }

  getInProgressState(
    detail: InProgressDetail = "compact",
  ): InProgressState | null {
    if (!this.inProgressBusy) return null;
    return {
      // Whole-turn compatibility fields for older clients. These retain every
      // assistant delta/tool call seen during the turn, even after a segment is stored.
      text: this.inProgressText,
      toolCalls: toolCallsForInProgressState(this.inProgressToolCalls, detail),
      // Current-segment recovery fields. These contain only the unpersisted assistant
      // segment since the last assistant message_stored event.
      segmentText: this.inProgressSegmentText,
      segmentToolCalls: toolCallsForInProgressState(
        this.inProgressSegmentToolCalls,
        detail,
      ),
    };
  }

  // The provider reads its API key lazily on every request (providers/*), so a key
  // change is picked up by the next turn with nothing to reconfigure here. Retained on
  // the ChatRuntime contract for the control server's key-change hook.
  reloadApiKey(): Promise<void> {
    return Promise.resolve();
  }

  // Refresh the user-configured model. The local loop resolves it (brain.resolveModel)
  // at the start of each turn, so updating the field is the whole operation — no agent
  // to recreate.
  reloadModel(): Promise<void> {
    this.model = getAgentModel();
    return Promise.resolve();
  }

  // The trace sink for this turn, or null when tracing is off / no project is
  // loaded. Resolved per turn (not cached across turns) so flipping the setting or
  // switching projects takes effect on the next turn without a restart.
  private resolveCacheTracer(): CacheCompositionTracer | null {
    if (!getKernelSettings().cacheCompositionTrace) {
      this.cacheTracer = null;
      return null;
    }
    const projectDir = this.kernel.projectDir;
    if (!projectDir) return null;
    const historyDir = getProjectPaths(projectDir).historyDir;
    if (!this.cacheTracer || this.cacheTracerDir !== historyDir) {
      this.cacheTracer = new CacheCompositionTracer(historyDir);
      this.cacheTracerDir = historyDir;
    }
    return this.cacheTracer;
  }

  private async getPromptOpts(sessionId?: string | null) {
    const skills = await this.kernel.skills.listEnabled();
    const secrets = this.kernel.secrets.list().map((s) => ({
      key: s.key,
      description: s.description,
      status: this.kernel.secrets.status(s.key),
    }));
    return {
      customInstructions:
        (this.kernel.configs.get("_genie_custom_instructions") as string) ??
          undefined,
      skills: skills.map((s) => ({ name: s.name, prompt: s.prompt })),
      secrets,
      residentDocuments: await this.getResidentDocuments(sessionId),
    };
  }

  // The session's Tier-2 working set as prompt-ready blocks (docs/document-store-plan.md
  // §5): each pinned doc's head content + the exact version hash cited. Feeds both the
  // system-prompt path (getPromptOpts → composePrompt) and the per-turn user-message
  // path (withLocalConversationContext), so a doc pinned mid-session reaches the model
  // even before the agent is next rebuilt.
  private async getResidentDocuments(
    sessionId?: string | null,
  ): Promise<Array<{ name: string; versionHash: string; content: string }>> {
    if (!sessionId) return [];
    const ids = await this.kernel.documents.listPinned(sessionId);
    const out: Array<{ name: string; versionHash: string; content: string }> =
      [];
    for (const id of ids) {
      const read = await this.kernel.documents.readContent(id);
      if (read.ok) {
        out.push({
          name: read.data.document.name,
          versionHash: read.data.version.versionHash,
          content: read.data.content,
        });
      }
    }
    return out;
  }

  // The trailing user message(s) with no assistant turn after them — a still-unanswered
  // question at the tail of the retained array. Used by applyCompaction to carry a
  // pending question across a compaction verbatim (returns the SAME message objects, so
  // callers can dedup by reference). Empty when the last turn was an assistant reply.
  private trailingUnansweredUserMessages(
    messages: NeutralMessage[],
  ): NeutralMessage[] {
    let lastAssistant = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]?.role === "assistant") {
        lastAssistant = i;
        break;
      }
    }
    return messages.slice(lastAssistant + 1).filter((m) => m.role === "user");
  }

  private async buildSystemPrompt(
    opts?: {
      sessionId?: string | null;
      heading?: string;
      extraSections?: string[];
      includeRecent?: boolean;
      user?: CurrentUser;
    },
  ): Promise<string> {
    const sessionId = opts?.sessionId ?? this.currentSessionId;
    const parts = [
      this.brain.baseSystemPrompt(await this.getPromptOpts(sessionId)),
    ];
    const extraSections = opts?.extraSections?.filter((s) => s.trim()) ?? [];
    if (extraSections.length > 0) {
      parts.push(extraSections.join("\n\n"));
    }
    const context = await this.buildRecoveredContext(sessionId, opts);
    if (context) parts.push(context);
    return parts.join("\n\n");
  }

  // The prior-session context sections (summary, focus, pinned project/session messages,
  // recent conversation) rendered under a single heading — or "" when there is nothing to
  // recover or the session is unreadable. On a resume/compact the local loop stores this
  // as `recoveredContext` and folds it into the system prompt so a session's prior work
  // survives the retained array being reset (the Managed path reloaded it into the rebuilt
  // agent's system prompt instead).
  private async buildRecoveredContext(
    sessionId: string | null,
    opts?: {
      heading?: string;
      includeRecent?: boolean;
      // Cap on the raw recent turns carried past the summary (default: the
      // formatRecentMessagesForContext default of 16). Auto-compaction passes
      // AUTOCOMPACT_RETAINED_TURNS so a self-healing compact carries only a few.
      recentLimit?: number;
      user?: CurrentUser;
    },
  ): Promise<string> {
    if (!sessionId) return "";
    const session = await this.sessions.getSession(sessionId);
    const effectiveUser = opts?.user ?? localUser();
    if (session && !canReadUserSession(effectiveUser, session)) return "";

    const includeRecent = opts?.includeRecent ?? true;
    let recent = "";
    if (includeRecent) {
      // In-place compaction records a boundary (summarizedThroughMessageId): the summary
      // already covers everything up to it, so the raw "recent conversation" must be
      // drawn only from messages AFTER the boundary — otherwise the summary's context
      // reduction is undone by re-including the turns it summarized. No boundary (never
      // compacted) ⇒ all messages, unchanged behavior.
      const boundary = numberOrNull(
        parseSessionMetadata(session?.metadata ?? null)
          .summarizedThroughMessageId,
      );
      const all = await this.sessions.getMessages(sessionId);
      const postBoundary = boundary === null
        ? all
        : all.filter((m) => m.id > boundary);
      recent = formatRecentMessagesForContext(postBoundary, opts?.recentLimit);
    }
    const contextParts: string[] = [];
    if (session?.summary) {
      contextParts.push(`## Session Summary\n${session.summary}`);
    }
    if (session?.focus) {
      contextParts.push(`## Current Focus\n${session.focus}`);
    }
    const [sessionPins, projectPins] = await Promise.all([
      getPinnedMessageInfos(this.sessions, "session", sessionId),
      this.getReadableProjectPins(opts?.user),
    ]);
    if (projectPins.length > 0) {
      contextParts.push(
        `## Pinned Project Messages\n${
          formatPinnedMessagesContext("Pinned project messages", projectPins)
        }`,
      );
    }
    if (sessionPins.length > 0) {
      contextParts.push(
        `## Pinned Session Messages\n${
          formatPinnedMessagesContext("Pinned session messages", sessionPins)
        }`,
      );
    }
    if (recent) {
      contextParts.push(`## Recent Conversation\n${recent}`);
    }
    if (contextParts.length === 0) return "";
    return `## ${opts?.heading ?? "Continuing Session Context"}\n\n` +
      contextParts.join("\n\n");
  }

  // The client-side loop composes its system prompt and tool set fresh on every turn
  // (see sendMessage), so there is no agent to build up front. Retained on the
  // ChatRuntime contract for the control server's startup ordering.
  initialize(): Promise<void> {
    return Promise.resolve();
  }

  private async ensureCurrentSession(
    onEvent?: ChatEventHandler,
    user?: CurrentUser,
  ): Promise<Session> {
    const effectiveUser = user ?? localUser();
    if (this.currentSessionId) {
      const existing = await this.sessions.getSession(this.currentSessionId);
      if (
        existing && !existing.archived &&
        canReadUserSession(effectiveUser, existing)
      ) {
        return existing;
      }
      this.currentSessionId = null;
      await this.clearContext();
    }

    const localSession = await this.sessions.createSession(undefined, {
      ownerUserId: effectiveUser.id,
      userProfile: user,
    });
    this.currentSessionId = localSession.id;
    if (localSession.name === "New Session") {
      this.autoNameEligibleSessionIds.add(localSession.id);
    }
    onEvent?.({
      type: "session_started",
      sessionId: localSession.id,
      sessionName: localSession.name,
    });
    return localSession;
  }

  private async discardUnreadableCurrentSession(
    user?: CurrentUser,
  ): Promise<void> {
    if (!this.currentSessionId) return;
    const session = await this.sessions.getSession(this.currentSessionId);
    if (
      session && !session.archived &&
      canReadUserSession(user ?? localUser(), session)
    ) {
      return;
    }
    this.currentSessionId = null;
    await this.clearContext();
  }

  private async getReadableProjectPins(
    user?: CurrentUser,
  ): Promise<Awaited<ReturnType<typeof getPinnedMessageInfos>>> {
    const pins = await getPinnedMessageInfos(this.sessions, "project");
    const effectiveUser = user ?? localUser();
    const out = [];
    for (const pin of pins) {
      const session = await this.sessions.getSession(pin.sessionId);
      if (session && canReadUserSession(effectiveUser, session)) out.push(pin);
    }
    return out;
  }

  private async getActiveChangesetForTurn(): Promise<Changeset | null> {
    const scoped = await this.kernel.changesets.getActive(
      this.currentSessionId ?? undefined,
    );
    if (scoped) return scoped;

    // Compatibility for changesets created before session IDs were recorded.
    const global = await this.kernel.changesets.getActive();
    return global?.sessionId == null ? global : null;
  }

  private async getChangesetForTurn(
    changesetId?: string,
  ): Promise<Changeset | null> {
    if (!changesetId) return await this.getActiveChangesetForTurn();

    const cs = await this.kernel.changesets.get(changesetId);
    if (!cs) throw new Error(`Changeset "${changesetId}" not found`);
    if (
      this.currentSessionId && cs.sessionId &&
      cs.sessionId !== this.currentSessionId
    ) {
      throw new Error("Changeset is not in the current session");
    }
    return cs;
  }

  private withActiveChangesetContext(content: string, cs: Changeset): string {
    const steps = cs.plan.steps.map((s, index) =>
      `${index + 1}. [${s.status}] ${s.description}`
    ).join("\n");
    const instruction = cs.status === "in_progress"
      ? `This changeset is approved and in progress. Continue executing ` +
        `this exact existing changeset. Ignore unrelated prior session work. ` +
        `Do not create a new changeset for this work.`
      : cs.status === "approved"
      ? `This changeset has been approved but work has not started yet. ` +
        `Continue executing this exact existing changeset. Do not create a ` +
        `new changeset for this work.`
      : `This changeset is still awaiting approval. Do not call modification ` +
        `tools yet. If the user is revising the plan, update this changeset; ` +
        `if the user clearly approves, wait for the system to start it before ` +
        `making changes.`;
    return `${content}\n\n<active_changeset>\n` +
      `id: ${cs.id}\n` +
      `status: ${cs.status}\n` +
      `title: ${cs.title}\n` +
      `summary: ${cs.plan.summary}\n` +
      `steps:\n${steps || "(none)"}\n\n` +
      `${instruction}\n` +
      `</active_changeset>`;
  }

  private async prepareChangesetForTurn(
    content: string,
    cs: Changeset | null,
    approvalDecision?: boolean,
  ): Promise<{ changeset: Changeset | null; approvalStarted: boolean }> {
    if (!cs) return { changeset: null, approvalStarted: false };
    if (cs.status === "in_progress") {
      return { changeset: cs, approvalStarted: false };
    }
    if (cs.status === "approved") {
      return {
        changeset: await this.kernel.changesets.startWork(cs.id),
        approvalStarted: false,
      };
    }
    if (
      cs.status === "planning" &&
      (approvalDecision ?? await this.isApprovalForChangeset(content, cs))
    ) {
      await this.kernel.changesets.approve(cs.id);
      return {
        changeset: await this.kernel.changesets.startWork(cs.id),
        approvalStarted: true,
      };
    }
    return { changeset: cs, approvalStarted: false };
  }

  private isApprovalForChangeset(
    content: string,
    cs: Changeset,
  ): Promise<boolean> {
    return Promise.resolve(this.brain.isApprovalMessage(content, {
      changeset: cs,
      sessionId: this.currentSessionId,
      recordUsage: (input) => this.sessions.recordModelUsage(input),
    }));
  }

  private resolveChatTurnModel(
    role: ChatTurnModelRole,
  ): string | undefined {
    const model = getModelForRoleRequest(role);
    if (model) return model;
    return role === "agent" ? this.brain.resolveModel(this.model) : undefined;
  }

  // The tools handed to one turn: our AGENT_TOOLS plus MCP tools up to the budget,
  // adapted to the provider-neutral NeutralTool shape (schema body verbatim). The single
  // tool set the client-side loop exposes on every turn (multi-model harness).
  private buildNeutralTools(): NeutralTool[] {
    const mcpTools = this.mcpManager.getCustomTools();
    const remainingMcpSlots = Math.max(0, MAX_AGENT_TOOLS - AGENT_TOOLS.length);
    return toNeutralTools([
      ...AGENT_TOOLS,
      ...mcpTools.slice(0, remainingMcpSlots),
    ]);
  }

  // The per-turn system prompt: the brain's base prompt (skills, secrets, custom
  // instructions, resident/pinned docs) plus any recovered prior-session context folded
  // in after a resume/compact reset the retained array.
  private async localSystemPrompt(): Promise<string> {
    const base = this.brain.baseSystemPrompt(
      await this.getPromptOpts(this.currentSessionId),
    );
    return this.recoveredContext ? `${base}\n\n${this.recoveredContext}` : base;
  }

  // The client-side agentic loop's entry point (multi-model harness, D2). It ensures a
  // local kernel session, resolves the turn's changeset (consulting the brain's approval
  // decision to flip planning→in_progress), appends the user message to the retained
  // NeutralMessage[], assembles the TurnRequest, and drives runTurn. No
  // agent/environment/provider-session lifecycle exists — the array is the memory, so
  // pause/resume needs no rebuild. perStepExecution routes an approval to the per-step
  // driver (runApprovedPlan); everything else runs as a single whole turn.
  async sendMessage(
    content: string,
    onEvent?: ChatEventHandler,
    attachments?: WireAttachment[],
    storedContent?: string,
    changesetId?: string,
    user?: CurrentUser,
    documentRefs?: WireDocumentRef[],
  ): Promise<string> {
    await this.discardUnreadableCurrentSession(user);

    await this.ensureCurrentSession(onEvent, user);

    const activeCs = await this.getChangesetForTurn(changesetId);
    const approvalDecision = activeCs?.status === "planning"
      ? await this.isApprovalForChangeset(content, activeCs)
      : false;
    const modelRole = selectChatTurnModelRole({
      changeset: activeCs,
      approvalStarted: approvalDecision,
    });
    // D9: refuse to start a turn with no model rather than shipping a dead id.
    const model = this.resolveChatTurnModel(modelRole);
    if (!model) throw new Error(MODEL_UNCONFIGURED_MESSAGE);

    this.cancelledFlag = false;
    this.inProgressBusy = true;
    this.inProgressText = "";
    this.inProgressToolCalls = [];
    this.inProgressSegmentText = "";
    this.inProgressSegmentToolCalls = [];

    const preparedCs = await this.prepareChangesetForTurn(
      content,
      activeCs,
      approvalDecision,
    );
    const turnCs = preparedCs.changeset;
    const activeWorkCs = turnCs?.status === "in_progress" ? turnCs : null;

    // Per-step execution (G7): when this message is the approval that just flipped a plan
    // into progress, drive one turn per step (runApprovedPlan, bound to the step runner)
    // instead of a single turn. Checked before the user message is seeded into the retained
    // array, since the per-step path anchors the approval message itself and each step turn
    // manages its own array.
    if (
      getKernelSettings().perStepExecution &&
      preparedCs.approvalStarted && activeWorkCs &&
      hasMultipleSteps(activeWorkCs)
    ) {
      return await this.runApprovedPlan({
        content,
        storedContent,
        onEvent,
        user,
        activeWorkCs,
      });
    }

    // Tier-1 @-mentions (§7): resolve the turn's document refs server-side into content
    // blocks fed to the model for THIS turn only, prepended before the user's message (as
    // attachments are). The resolved versions are threaded to runTurn to record a
    // message-role mention ref once the durable message is stored.
    const mention = documentRefs?.length
      ? await resolveDocumentMentions(this.kernel.documents, documentRefs)
      : { blocks: [], resolved: [] };

    // The array is the memory (D2), so the user message is NOT re-wrapped in reconstructed
    // local history; only the active-changeset framing is folded in (the system prompt
    // still carries skills/secrets/instructions/pins).
    const agentContent = turnCs
      ? this.withActiveChangesetContext(content, turnCs)
      : content;
    const contentBlocks = buildUserContentBlocks(agentContent, attachments);
    const turnBlocks = mention.blocks.length > 0
      ? [...mention.blocks, ...contentBlocks]
      : contentBlocks;
    const incomingUserMessage: NeutralMessage = {
      role: "user",
      content: toNeutralContentBlocks(turnBlocks),
    };

    // Pre-turn context guard (context-hardening plan, Slice 4). Estimate the same
    // request shape the provider will receive — system prompt, retained messages,
    // incoming resolved user content, and tool schemas — before sending it.
    const preflight = await this.prepareContextPreflight(
      model,
      incomingUserMessage,
      onEvent,
      user,
    );
    if (!preflight.ok) {
      this.inProgressBusy = false;
      this.inProgressSegmentText = "";
      this.inProgressSegmentToolCalls = [];
      onEvent?.({ type: "message_complete" });
      this.onTurnComplete?.();
      return "";
    }

    this.localMessages.push(incomingUserMessage);

    const result = await this.runTurn({
      content,
      storedContent,
      onEvent,
      user,
      approvalStarted: preparedCs.approvalStarted,
      activeWorkCs,
      system: preflight.system,
      tools: preflight.tools,
      model: preflight.model,
      modelRole,
      documentMentions: mention.resolved,
      attachments,
    });
    return result.fullText;
  }

  // One client-side turn (D2/D3): consume provider.streamTurn over the retained
  // NeutralMessage[], translate each ProviderEvent → ChatEvent through onEvent (buffering
  // thinking_delta, flushed once at thinking_end), accumulate the assistant message, and
  // — on a requires_action stop — dispatch each tool via dispatchTool, append
  // NeutralToolResultBlocks, and loop until a terminal stop. The approval pause is reduced
  // to its D2 essence: STOP iterating and RETAIN the array (no session teardown/rebuild).
  private async runTurn(opts: LocalTurnOptions): Promise<TurnResult> {
    const {
      content,
      storedContent,
      onEvent,
      user,
      activeWorkCs,
      approvalStarted,
      system,
      tools,
      model,
      modelRole,
      documentMentions,
      attachments,
    } = opts;
    const provider = this.provider!;

    // Slice 5 reactive-recovery snapshot (context-hardening plan). The turn's triggering
    // user message is the one sendMessage just pushed onto the retained array, so at
    // runTurn entry it is localMessages.at(-1). On a CONTEXT_LENGTH_EXCEEDED overflow the
    // recovery path calls autoCompactSession — which EMPTIES localMessages — so it must
    // re-seed this exact message onto the fresh array, else the retry would re-request an
    // empty conversation (the dropped intermediate history survives as summary +
    // recent-turns in recoveredContext). `currentSystem` starts as the system prompt
    // assembled from the OLD recoveredContext and is rebuilt after a compaction so the
    // retry carries the fresh summary; `contextRecoveryAttempts` caps recovery at one.
    const triggeringUserMessage = this.localMessages.at(-1) ?? null;
    // Where the LIVE turn begins in the retained array — the boundary §4.8 trims up to.
    // Recomputed on demand rather than captured, because overflow recovery empties and
    // re-seeds localMessages mid-turn, which moves it. A message that is somehow no
    // longer in the array returns 0, which disables the reasoning drop entirely: the
    // fail-safe direction is "keep everything".
    const liveTurnStartIndex = (): number => {
      if (!triggeringUserMessage) return 0;
      const index = this.localMessages.indexOf(triggeringUserMessage);
      return index < 0 ? 0 : index;
    };
    // §4.8's free firing path, taken once per turn before the first request: if the
    // provider's cached prefix has already expired, the next request rewrites it
    // whatever we do, so settled turns' reasoning goes now at zero cost.
    this.dropSettledReasoningIfPrefixCold(
      liveTurnStartIndex(),
      Date.now(),
      model,
    );
    let currentSystem = system;
    let contextRecoveryAttempts = 0;
    // Output-ceiling continuations spent on this turn (see MAX_TURN_CONTINUATIONS).
    let continuationAttempts = 0;

    const turnId = createTimestampedId("turn");
    const turnIndex = this.turnCount++;
    const changeContext: ChangeContext = {
      userMessage: content,
      turnId,
      turnIndex,
    };
    if (this.currentSessionId) changeContext.sessionId = this.currentSessionId;
    if (activeWorkCs) changeContext.changesetId = activeWorkCs.id;

    // Persist + anchor the user message (mirrors runTurn) so the local kernel session
    // stays coherent for reload/auto-name. The retained array already holds the user
    // turn for the model; this is the durable DB row.
    if (this.currentSessionId) {
      const userMsg = await this.sessions.addMessage({
        sessionId: this.currentSessionId,
        role: "user",
        content: storedContent ?? content,
        turnId,
        authorUserId: user?.id ?? null,
      });
      onEvent?.({
        type: "message_stored",
        role: "user",
        messageId: userMsg.id,
      });
      this.startAutoNameForFirstUserMessage(
        turnIndex,
        this.currentSessionId,
        content,
        onEvent,
      );
      // Record a message-role mention ref per resolved @-mention (§7/§8 — G5), citing the
      // exact version shown to the model so provenance resolves to fixed bytes (D2).
      for (const r of documentMentions ?? []) {
        await this.recordMessageRef(
          r.documentId,
          userMsg.id,
          "mention",
          r.versionHash,
          this.currentSessionId,
        );
      }
      // Persist the turn's attachments as durable session-scoped documents + refs (§8/§10)
      // so their bytes survive reload — the bytes already reached the model live via the
      // retained user message. Additive: a persistence failure never sinks the turn.
      await this.persistAttachmentDocuments(
        attachments,
        userMsg.id,
        this.currentSessionId,
      );
      if (approvalStarted && activeWorkCs) {
        try {
          const updated = await this.kernel.changesets.setApprovalMessageId(
            activeWorkCs.id,
            userMsg.id,
          );
          onEvent?.({ type: "changeset_updated", changeset: updated });
        } catch {
          // Approval proceeds even if the chat anchor is unavailable.
        }
      }
    }

    let fullText = "";
    const toolCallsAccum: ToolCallRecord[] = [];
    let stopReason: TurnStopReason = "end_turn";
    let finalUsage: TurnUsage | null = null;

    // The turn's persisted assistant segments (message id + the tool calls that segment
    // carried), accumulated across every provider request so the tail can anchor work /
    // plan message ids onto the changeset exactly as runTurn does (Stage 3d — G6). The
    // local-loop analogue of runTurn's `assistantSegments`. `flushSegment` persists one
    // segment (when a local session is active and the segment is non-empty), records it,
    // and emits message_stored — the local counterpart of runTurn's flushAssistantSegment.
    const assistantSegments: Array<
      { messageId: number; toolCalls: ToolCallRecord[] }
    > = [];
    const flushSegment = async (
      text: string,
      calls: ToolCallRecord[],
    ): Promise<number | null> => {
      if (!this.currentSessionId) return null;
      if (text.trim().length === 0 && calls.length === 0) return null;
      const msg = await this.sessions.addMessage({
        sessionId: this.currentSessionId,
        role: "assistant",
        content: text.trimEnd(),
        toolCalls: calls.length > 0 ? calls : undefined,
        turnId,
      });
      assistantSegments.push({ messageId: msg.id, toolCalls: [...calls] });
      onEvent?.({
        type: "message_stored",
        role: "assistant",
        messageId: msg.id,
      });
      this.inProgressSegmentText = "";
      this.inProgressSegmentToolCalls = [];
      return msg.id;
    };
    // Whole-turn usage accumulator (multi-model harness, Stage 3c parity). A turn can
    // make MORE than one provider request (every requires_action tool round-trip loops
    // back for another streamTurn), and each request emits its own turn_usage. The
    // durable turn_usage must cover the WHOLE turn, so — mirroring the Managed path's
    // running span totals (runTurn's total*Tokens) — sum every request's tokens here
    // rather than keeping only the last (which would drop the first request's large
    // cached-prefix input). costUsd is recomputed loop-side over the summed tokens +
    // the resolved model, exactly as runTurn's tail does, so cost attributes to this
    // turn's model regardless of what the provider reported per request.
    let sawUsage = false;
    let accInputTokens = 0;
    let accOutputTokens = 0;
    let accCacheCreationTokens = 0;
    let accCacheReadTokens = 0;
    let observedUsageProvider: ModelProviderId | null = null;
    // Context OCCUPANCY (context-hardening) is a different quantity from the cost
    // accumulators above: it is the CURRENT context size, not the whole-turn sum.
    // A turn makes one provider request per tool round-trip, each re-sending the
    // entire (growing) context — so summing every request's input tokens counts the
    // static prefix (system prompt + tool schemas) once per round-trip and inflates
    // occupancy N-fold. The last request of a turn already carries the whole
    // conversation + all tool results, so its input categories ARE the current
    // occupancy; capture them with `=` (last-wins), not `+=`.
    let lastReqInputTokens = 0;
    let lastReqCacheCreationTokens = 0;
    let lastReqCacheReadTokens = 0;
    const turnStartedAt = new Date();
    // Cost-doc §8 measurement: the per-request cache-composition trace, off unless the
    // cacheCompositionTrace setting is on. Resolved once per turn; null = not
    // tracing. It observes the same `req` the provider is handed and nothing else.
    const cacheTracer = this.resolveCacheTracer();
    cacheTracer?.beginTurn();

    try {
      // Each iteration is one provider request; a requires_action stop loops back with
      // the appended tool results until a terminal stop (or an approval pause).
      while (true) {
        if (this.cancelledFlag) break;
        const controller = new AbortController();
        const req: TurnRequest = {
          model,
          system: currentSystem,
          messages: this.localMessages,
          tools,
        };
        // Measured BEFORE the request goes out, so the split describes exactly the
        // bytes this request sends; committed when that request's usage arrives.
        let pendingCacheTrace: PendingCacheTrace | null = cacheTracer
          ? cacheTracer.snapshot({
            request: req,
            turnId,
            sessionId: this.currentSessionId,
            supportsCaching: this.provider.supportsCaching,
            at: new Date(),
          })
          : null;

        let assistantText = "";
        const assistantToolUses: Array<
          { id: string; name: string; input: unknown }
        > = [];
        let thinkingBuffer = "";
        // Reasoning blocks the provider captured this request, carried on
        // message_complete for same-model replay (Stage 3b). Folded into the assistant
        // NeutralMessage below so the next streamTurn re-sends the thinking+signature
        // blocks unchanged. Fake providers emit none, so this stays empty for them.
        let reasoningBlocks: NeutralReasoningBlock[] = [];
        let providerStop: ProviderStopReason | null = null;
        let errored = false;
        // Slice 5: capture the error's semantic code + message but DEFER surfacing it —
        // the terminal handler below decides whether a CONTEXT_LENGTH_EXCEEDED overflow
        // is recoverable (auto-compact + retry, no user-facing error) or must surface.
        let errorCode: string | null = null;
        let errorText = "";

        for await (const event of provider.streamTurn(req, controller.signal)) {
          if (this.cancelledFlag) {
            controller.abort();
            break;
          }
          switch (event.type) {
            case "text_delta": {
              if (event.text) {
                fullText += event.text;
                assistantText += event.text;
                this.inProgressText = fullText;
                this.inProgressSegmentText += event.text;
                onEvent?.({ type: "text_delta", text: event.text });
              }
              break;
            }
            case "thinking_start": {
              thinkingBuffer = "";
              onEvent?.({ type: "thinking_start" });
              break;
            }
            case "thinking_delta": {
              // Buffered, not forwarded: PROVIDER_EVENT_CHAT_TARGET maps thinking_delta
              // to BUFFERED_NO_CHAT_EVENT — the contract has no live per-delta event.
              thinkingBuffer += event.text;
              break;
            }
            case "thinking_end": {
              // Single flush of the buffered reasoning at the boundary.
              onEvent?.(
                thinkingBuffer
                  ? { type: "thinking_end", text: thinkingBuffer }
                  : { type: "thinking_end" },
              );
              thinkingBuffer = "";
              break;
            }
            case "tool_use_start": {
              const id = event.toolCallId ?? createTimestampedId("call");
              assistantToolUses.push({
                id,
                name: event.toolName,
                input: event.toolInput,
              });
              onEvent?.({
                type: "tool_use_start",
                toolName: event.toolName,
                toolInput: event.toolInput,
              });
              break;
            }
            case "tool_use_end": {
              // Our loop synthesizes tool_use_end after dispatch (below); this handles a
              // provider that runs its own tools and reports the result inline.
              onEvent?.({ type: "tool_use_end", toolResult: event.toolResult });
              break;
            }
            case "model_request_usage": {
              observedUsageProvider = event.provider ?? observedUsageProvider;
              // Stamp the loop's turn/session identity onto the live per-request
              // counter (parity with runTurn's ModelRequestUsage, which sets both);
              // the provider leaves them blank since only the loop knows them.
              const usage: TurnUsage = this.currentSessionId
                ? {
                  ...event.usage,
                  turnId,
                  sessionId: this.currentSessionId,
                  provider: event.provider,
                }
                : { ...event.usage, provider: event.provider };
              onEvent?.({ type: "model_request_usage", usage });
              break;
            }
            case "turn_usage": {
              observedUsageProvider = event.provider ?? observedUsageProvider;
              // One request's totals — accumulate into the whole-turn sum (see above);
              // finalUsage is (re)built from the accumulators in the tail.
              sawUsage = true;
              accInputTokens += event.usage.inputTokens;
              accOutputTokens += event.usage.outputTokens;
              accCacheCreationTokens += event.usage.cacheCreationInputTokens;
              accCacheReadTokens += event.usage.cacheReadInputTokens;
              // Last-wins for occupancy (current context size — see the tracker's
              // declaration above); the final request's totals win.
              lastReqInputTokens = event.usage.inputTokens;
              lastReqCacheCreationTokens = event.usage.cacheCreationInputTokens;
              lastReqCacheReadTokens = event.usage.cacheReadInputTokens;
              // When this request touched the provider's cache entry, and which model
              // it touched (§4.8's cold-prefix check). Stamped per request, not turn.
              this.lastProviderRequestAt = Date.now();
              this.lastProviderRequestModel = model;
              // Cost-doc §8: this is the one statement where per-request usage exists
              // before being summed away. Pair it with the composition measured at
              // request time and append the line.
              if (cacheTracer && pendingCacheTrace) {
                cacheTracer.commit(pendingCacheTrace, {
                  ...event.usage,
                  provider: event.provider ?? event.usage.provider,
                });
                pendingCacheTrace = null;
              }
              break;
            }
            case "message_complete": {
              if (event.reasoning) reasoningBlocks = event.reasoning;
              providerStop = event.stopReason;
              break;
            }
            case "error": {
              // Deferred (Slice 5): do NOT surface here — the terminal handler after the
              // stream decides recover-vs-surface. Capture the code + message for it.
              errorCode = event.error.code;
              errorText = event.error.message;
              errored = true;
              break;
            }
          }
          if (providerStop !== null || errored) break;
        }

        // A request that errored or was cancelled emits no turn_usage, so its
        // composition would otherwise be lost. Record it with null usage — a
        // failed request still sent its context, and its absence from the trace
        // would silently under-count the turn.
        if (cacheTracer && pendingCacheTrace) {
          cacheTracer.commit(pendingCacheTrace, null);
          pendingCacheTrace = null;
        }

        if (this.cancelledFlag) break;

        // Reactive context-length recovery (context-hardening plan, Slice 5). When a
        // request overflows the model's real window despite the Slice-4 pre-turn
        // estimate (chars/4 under-counts, or cached-prefix drift pushed it over), the
        // provider returns CONTEXT_LENGTH_EXCEEDED. Instead of dying with an opaque
        // error, auto-compact ONCE and retry the turn on the fresh window. Guarded on the
        // Slice-4 autoCompactEnabled setting — with the guard off, a context-length error
        // surfaces as an error rather than silently recovering.
        if (errored) {
          const isContextOverflow =
            errorCode === PROVIDER_ERROR_CODES.CONTEXT_LENGTH_EXCEEDED;
          if (isContextOverflow) {
            this.logContextDiagnostic(
              "warn",
              "Provider reported context length overflow",
              estimatedContextPressure(req),
              { recoveryAttempts: contextRecoveryAttempts },
            );
          }
          if (
            isContextOverflow &&
            contextRecoveryAttempts < MAX_CONTEXT_RECOVERY_ATTEMPTS &&
            getKernelSettings().autoCompactEnabled
          ) {
            contextRecoveryAttempts++;
            // Do NOT commit the failed request's (empty) assistant message or set
            // stopReason = "error". autoCompactSession self-summarizes, resets
            // localMessages, switches session, and emits session_compacted (Slice 4).
            await this.autoCompactSession(onEvent, user);
            // Re-seed the triggering user message onto the now-fresh array — a naive
            // retry would send an empty conversation (autoCompactSession emptied it).
            // applyCompaction now re-seeds trailing unanswered user messages itself (the
            // triggering message is one), so only push if it isn't already there — else
            // the retry would send the question twice.
            if (
              triggeringUserMessage &&
              !this.localMessages.includes(triggeringUserMessage)
            ) {
              this.localMessages.push(triggeringUserMessage);
            }
            // Rebuild the system prompt so the retry carries the fresh summary (the old
            // `system` was assembled from the pre-compaction recoveredContext).
            currentSystem = await this.localSystemPrompt();
            const postRecoveryPressure = estimatedContextPressure({
              model,
              system: currentSystem,
              messages: this.localMessages,
              tools,
            });
            this.logContextDiagnostic(
              postRecoveryPressure.pressure >= 1 ? "error" : "info",
              "Context pressure re-estimated after overflow recovery compaction",
              postRecoveryPressure,
              { recoveryAttempts: contextRecoveryAttempts },
            );
            if (postRecoveryPressure.pressure >= 1) {
              onEvent?.({
                type: "error",
                text: CONTEXT_LENGTH_HARD_FLOOR_MESSAGE,
              });
              stopReason = "error";
              break;
            }
            continue;
          }
          // Not recovered — surface the error now (deferred from the stream handler so a
          // recoverable overflow never flashes a user-facing error). The hard-floor case
          // (a single payload that still overflows AFTER one compaction, e.g. a huge
          // pinned doc) gets a specific, actionable message instead of the generic one;
          // stopReason settles to "error" at the terminal blocks below.
          const hardFloor = isContextOverflow &&
            contextRecoveryAttempts >= MAX_CONTEXT_RECOVERY_ATTEMPTS;
          if (hardFloor) {
            this.logContextDiagnostic(
              "error",
              "Provider context overflow reached hard floor",
              estimatedContextPressure(req),
              { recoveryAttempts: contextRecoveryAttempts },
            );
          }
          onEvent?.({
            type: "error",
            text: hardFloor ? CONTEXT_LENGTH_HARD_FLOOR_MESSAGE : errorText,
          });
        }

        // Commit the assistant turn to the retained array (text + any tool_use blocks)
        // BEFORE dispatch so the next provider call sees the model's own message.
        const assistantBlocks: NeutralContentBlock[] = [];
        // Reasoning blocks lead the assistant message: Anthropic (and same-model replay)
        // require thinking blocks before text/tool_use.
        for (const r of reasoningBlocks) assistantBlocks.push(r);
        if (assistantText) {
          assistantBlocks.push({ type: "text", text: assistantText });
        }
        for (const tu of assistantToolUses) {
          assistantBlocks.push({
            type: "tool_use",
            id: tu.id,
            name: tu.name,
            input: tu.input,
          });
        }
        if (assistantBlocks.length > 0) {
          this.localMessages.push({
            role: "assistant",
            content: assistantBlocks,
          });
        }

        // Truncated at the output ceiling: the model ran out of budget MID-ANSWER, so
        // this is not a finished turn even though it looks like one (no tool calls, a
        // clean stop). Resume it instead of settling: the partial assistant message is
        // already committed above, so persist its segment and append a continuation
        // user turn — the retained messages CANNOT end on the assistant role, since
        // trailing-assistant prefills are rejected on current Claude models. Bounded by
        // MAX_TURN_CONTINUATIONS, and scoped to the no-tool-call case: a turn that DID
        // finalize a tool call already continues via its tool round-trip, and hijacking
        // it here would strand that call undispatched. (A tool call truncated mid-JSON
        // never finalizes into an assistantToolUse, so it lands in this branch.)
        if (
          !errored && providerStop === "max_tokens" &&
          assistantToolUses.length === 0 &&
          continuationAttempts < MAX_TURN_CONTINUATIONS
        ) {
          continuationAttempts++;
          await flushSegment(assistantText, []);
          this.localMessages.push({
            role: "user",
            content: [{ type: "text", text: TURN_CONTINUATION_PROMPT }],
          });
          onEvent?.({
            type: "text_delta",
            text: `\n\n${TURN_CONTINUATION_NOTICE}\n\n`,
          });
          continue;
        }

        // Terminal: no tool calls requested — the assistant turn is the final answer.
        if (assistantToolUses.length === 0) {
          await flushSegment(assistantText, []);
          stopReason = errored ? "error" : mapProviderStop(providerStop);
          // A turn that stayed truncated after its continuations were spent must say
          // so — silence here is what made a cut-off turn indistinguishable from a
          // complete one.
          if (stopReason === "max_tokens") {
            onEvent?.({ type: "error", text: MAX_OUTPUT_TRUNCATED_MESSAGE });
          }
          break;
        }

        // requires_action: dispatch each tool via the UNCHANGED dispatchTool, emit
        // tool_use_end, and append the results as a tool-role message so the next
        // provider call sees them. `segmentText`/`segmentCalls` are this request's
        // pending assistant segment; `flushPending` persists it at each work-item /
        // plan-anchor boundary (so the anchored message follows its own segment, exactly
        // as runTurn's flushAssistantSegment does) and once more at the request's end.
        const resultBlocks: NeutralToolResultBlock[] = [];
        let segmentText = assistantText;
        let segmentCalls: ToolCallRecord[] = [];
        const flushPending = async (): Promise<number | null> => {
          const id = await flushSegment(segmentText, segmentCalls);
          segmentText = "";
          segmentCalls = [];
          return id;
        };
        let changesetNeedsApproval = false;
        for (const tu of assistantToolUses) {
          const result = await this.dispatchLocalTool(tu, changeContext);
          const visibleResult = modelVisibleToolOutput(result);
          const call: ToolCallRecord = {
            name: tu.name,
            input: tu.input,
            result: visibleResult,
          };
          segmentCalls.push(call);
          toolCallsAccum.push(call);
          this.inProgressToolCalls = [...toolCallsAccum];
          this.inProgressSegmentToolCalls = [...segmentCalls];
          onEvent?.({
            type: "tool_use_end",
            toolName: tu.name,
            toolResult: visibleResult,
          });
          this.emitSessionEventIfAny(tu.name, visibleResult, onEvent);
          // Work item for a successful mutation tool (G4): flushes the pending segment
          // first so the work-item message follows the tool's own assistant segment.
          await this.emitWorkItemForMutation({
            toolName: tu.name,
            toolInput: tu.input,
            toolCallId: tu.id,
            result: visibleResult,
            turnId,
            flush: async () => {
              await flushPending();
            },
            onEvent,
          });
          // Changeset lifecycle event + plan-message anchoring (G6): mirrors runTurn's
          // inline block (flush → addPlanMessageId → emit → capture plan doc).
          if (
            await this.handleLocalChangesetEvent({
              call,
              flush: flushPending,
              changeContext,
              onEvent,
            })
          ) {
            changesetNeedsApproval = true;
          }
          // Screenshot evidence capture (G6) for a tool result carrying image bytes.
          await this.captureLocalScreenshots(tu.id, result);
          // Wire payload: strip the loop-private side channels (`_changeset` is a
          // verbatim duplicate of `data`, `_changesetEvent` is a routing tag) that the
          // IDE-facing `visibleResult` above still needs. Filter the raw `result`, NOT
          // `call.result` — handleLocalChangesetEvent ran at the top of this iteration
          // and may have rewritten `call.result` with the plan-anchored changeset;
          // `visibleResult` is a separate binding it does not touch, so the model has
          // always received the pre-anchor result. Reading `call.result` here would
          // silently change that.
          resultBlocks.push({
            type: "tool_result",
            toolCallId: tu.id,
            output: wireVisibleToolOutput(result),
          });
        }

        // Flush any assistant segment this request left pending (its text and/or the
        // tools that did not force an earlier flush), then commit the tool results.
        await flushPending();
        this.localMessages.push({ role: "tool", content: resultBlocks });
        // Mid-turn context ceiling (§4.7/§4.8). AFTER appending, not before sending:
        // the same bytes go on this wire either way, but measuring here means the next
        // iteration's provider counters report the effect.
        this.maybeTrimContextInTurn({
          model,
          appended: resultBlocks,
          completedTurnEnd: liveTurnStartIndex(),
          lastReqInputTokens,
          lastReqCacheCreationTokens,
          lastReqCacheReadTokens,
          onEvent,
        });

        if (changesetNeedsApproval) {
          // D2 upside: pause = STOP + RETAIN. No provider-session teardown/rebuild —
          // stop iterating; the retained localMessages resume on the next sendMessage.
          // The changeset-anchoring tail below still runs (mirroring runTurn, which
          // reaches its tail on the approval break) before the turn settles.
          onEvent?.({
            type: "text_delta",
            text: "\n\n*Waiting for your approval before proceeding.*",
          });
          stopReason = "awaiting_approval";
          break;
        }

        if (errored) {
          stopReason = "error";
          break;
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      onEvent?.({ type: "error", text: `Stream error: ${msg}` });
      stopReason = "error";
    }

    if (this.cancelledFlag) {
      this.cancelledFlag = false;
      this.inProgressBusy = false;
      this.inProgressSegmentText = "";
      this.inProgressSegmentToolCalls = [];
      onEvent?.({ type: "message_complete" });
      return {
        turnId,
        stopReason: "cancelled",
        fullText,
        toolCalls: toolCallsAccum,
        usage: null,
      };
    }

    // Changeset tail, in the same order as runTurn (shared helpers): structural step
    // auto-advance / auto-complete (G3), then anchor each persisted assistant segment's
    // message id onto the changeset (G6). Runs on the approval-pause break too, matching
    // runTurn — a paused propose turn still emits its plan-anchor changeset_updated.
    await this.advanceChangesetSteps(changeContext, toolCallsAccum, onEvent);
    if (this.currentSessionId) {
      await this.anchorSegmentMessages(
        changeContext,
        assistantSegments,
        onEvent,
      );
    }

    // Record the final turn usage, summed across every provider request this turn made,
    // stamped with the loop's turn/session identity and its own wall-clock span — the
    // field-for-field mirror of runTurn's tail (whole-turn totals, model = the resolved
    // request model, cost recomputed over the summed tokens by the turn's end time).
    if (this.currentSessionId && sawUsage) {
      const turnEndedAt = new Date();
      const provider = observedUsageProvider ?? providerFor(model);
      const cost = computeProviderModelCost({
        provider,
        model,
        inputTokens: accInputTokens,
        outputTokens: accOutputTokens,
        cacheCreationInputTokens: accCacheCreationTokens,
        cacheReadInputTokens: accCacheReadTokens,
        asOf: turnEndedAt,
      });
      const turnUsage: TurnUsage = {
        turnId,
        sessionId: this.currentSessionId,
        model,
        startedAt: turnStartedAt.toISOString(),
        endedAt: turnEndedAt.toISOString(),
        durationMs: turnEndedAt.getTime() - turnStartedAt.getTime(),
        inputTokens: accInputTokens,
        outputTokens: accOutputTokens,
        cacheCreationInputTokens: accCacheCreationTokens,
        cacheReadInputTokens: accCacheReadTokens,
        toolCallsCount: toolCallsAccum.length,
        provider,
        pricingStatus: cost.pricingStatus,
        costUsd: cost.costUsd ?? 0,
      };
      await this.sessions.recordTurnUsage(turnUsage);
      await this.sessions.recordModelUsage({
        id: `model_usage_${turnId}_chat_turn`,
        sessionId: this.currentSessionId,
        turnId,
        changesetId: changeContext.changesetId ?? null,
        provider,
        model,
        role: modelRole,
        caller: "chat_turn",
        startedAt: turnStartedAt,
        endedAt: turnEndedAt,
        durationMs: turnUsage.durationMs,
        usage: {
          inputTokens: accInputTokens,
          outputTokens: accOutputTokens,
          cacheCreationInputTokens: accCacheCreationTokens,
          cacheReadInputTokens: accCacheReadTokens,
        },
        toolCallsCount: toolCallsAccum.length,
      });
      finalUsage = turnUsage;
      onEvent?.({ type: "turn_usage", usage: turnUsage });

      // Context-window pressure (context-hardening plan, Slice 2), a transient
      // sibling of turn_usage. occupancy sums the LAST request's three input
      // categories (cached tokens still occupy the window) — the current context
      // size, NOT the whole-turn sum, which would count the static prefix once per
      // tool round-trip (see the lastReq* declaration). The IDE meter (Slice 3)
      // renders this without recomputing window math. Persist it onto the session
      // metadata too so the signal survives the loop resetting localMessages on
      // reload — the metadata column is a shared JSON object, so read-modify-write
      // it and pass the current summary back unchanged (updateSummaryMetadata sets
      // both columns).
      const occupancy = contextOccupancyTokens({
        inputTokens: lastReqInputTokens,
        cacheCreationInputTokens: lastReqCacheCreationTokens,
        cacheReadInputTokens: lastReqCacheReadTokens,
      });
      const contextPressure = computeContextPressure(occupancy, model);
      onEvent?.({ type: "context_pressure", contextPressure });

      // Slice 3 nudge: the first completed turn to cross the nudge ratio emits one
      // non-blocking context_warning (same payload as context_pressure + human copy);
      // arm-once via contextNudged. A turn that reports pressure back under the ratio
      // (e.g. after a mid-session compact) re-arms so the next crossing fires again.
      // Slice 6: the threshold is the resolved contextNudgeRatio setting (file → env →
      // constant), not the bare constant, so it is tunable without a rebuild.
      if (contextPressure.pressure >= getKernelSettings().contextNudgeRatio) {
        if (!this.contextNudged) {
          this.contextNudged = true;
          onEvent?.({
            type: "context_warning",
            contextPressure,
            text: CONTEXT_NUDGE_MESSAGE,
          });
        }
      } else {
        this.contextNudged = false;
      }

      const session = await this.sessions.getSession(this.currentSessionId);
      if (session) {
        const metadata = parseSessionMetadata(session.metadata);
        writeLastContextMetadata(
          metadata,
          contextPressure,
          model,
          turnEndedAt.toISOString(),
        );
        await this.sessions.updateSummaryMetadata(
          this.currentSessionId,
          session.summary,
          JSON.stringify(metadata),
        );
      }
    }

    // Turn-tail completion safety net (shared with runTurn), after usage so a
    // changeset_completed follows the durable turn_usage exactly as the Managed path.
    if (this.currentSessionId) {
      await this.completeChangesetIfReady(changeContext, onEvent);
    }

    this.inProgressBusy = false;
    this.inProgressSegmentText = "";
    this.inProgressSegmentToolCalls = [];
    onEvent?.({ type: "message_complete" });
    this.onTurnComplete?.();
    return {
      turnId,
      stopReason,
      fullText,
      toolCalls: toolCallsAccum,
      usage: this.currentSessionId ? finalUsage : null,
    };
  }

  // Dispatch one tool for the local loop, mirroring the Managed path's routing: MCP
  // tools go to the MCP manager; everything else to the UNCHANGED dispatchTool (D6),
  // with the same session-id defaulting for session-local tools. Returns the raw
  // result (never throws — a thrown error becomes an { ok:false } result).
  private async dispatchLocalTool(
    tu: { id: string; name: string; input: unknown },
    changeContext: ChangeContext,
  ): Promise<unknown> {
    if (this.mcpManager.isMcpTool(tu.name)) {
      try {
        return await this.mcpManager.callTool(
          tu.name,
          tu.input as Record<string, unknown>,
        );
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }
    try {
      const toolInput = tu.input as Record<string, unknown>;
      if (
        (tu.name === "rename_session" || tu.name === "summarize_session") &&
        !toolInput.session_id && this.currentSessionId
      ) {
        toolInput.session_id = this.currentSessionId;
      }
      if (
        tu.name === "manage_sessions" && toolInput.action === "rename" &&
        !toolInput.session_id && this.currentSessionId
      ) {
        toolInput.session_id = this.currentSessionId;
      }
      // A wrong argument name is otherwise silently dropped by dispatch; refuse
      // it with the key that was meant, as the MCP face does.
      const definition = AGENT_TOOLS_BY_NAME.get(tu.name);
      const checked = definition
        ? checkToolArgs(tu.name, definition.input_schema, toolInput)
        : { args: toolInput, issues: [] };
      if (checked.issues.length > 0) {
        return {
          ok: false,
          error: {
            code: "INVALID_ARGUMENTS",
            message: formatArgIssues(tu.name, checked.issues),
          },
        };
      }
      return await dispatchTool(
        tu.name,
        checked.args,
        this.kernel,
        this.rebuild,
        { ...changeContext, toolCallId: tu.id },
      );
    } catch (err) {
      return {
        ok: false,
        error: {
          code: "DISPATCH_ERROR",
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }
  }

  private emitSessionEventIfAny(
    name: string,
    result: unknown,
    onEvent?: ChatEventHandler,
  ): void {
    const toolResult = result as {
      ok?: boolean;
      data?: { action?: unknown; sessionId?: unknown; name?: unknown };
    } | undefined;
    if (!toolResult || toolResult.ok === false) return;
    if (
      name !== "rename_session" &&
      !(name === "manage_sessions" && toolResult.data?.action === "rename")
    ) {
      return;
    }
    const sessionId = toolResult.data?.sessionId;
    const sessionName = toolResult.data?.name;
    if (typeof sessionId !== "string" || typeof sessionName !== "string") {
      return;
    }
    onEvent?.({ type: "session_renamed", sessionId, sessionName });
  }

  // Build a work-item bubble for a successful mutation tool: look up the changelog
  // record this tool call produced, flush the caller's pending assistant segment (so the
  // work-item message follows it, matching message ordering), store the work-item
  // message, fold the rationale into the change's workblock metadata, anchor the work
  // message onto the changeset (emitting changeset_updated), and emit work_item_created.
  // Shared by the whole-turn and per-step runners so they never drift on work-item
  // assembly (multi-model harness — closes gap G4). `flush` persists the caller's pending
  // assistant segment and is invoked ONLY when a changelog record is found, so it never
  // over-flushes. Best-effort: a failure here never sinks the turn (the changelog stays
  // authoritative); the caller is not required to wrap it.
  private async emitWorkItemForMutation(opts: {
    toolName: string;
    toolInput: unknown;
    toolCallId: string;
    result: unknown;
    turnId: string;
    flush: () => Promise<void>;
    onEvent?: ChatEventHandler;
  }): Promise<void> {
    const { toolName, toolInput, toolCallId, result, turnId, flush, onEvent } =
      opts;
    if (!this.currentSessionId) return;
    if (!isMutationTool(toolName)) return;
    if ((result as Record<string, unknown>)?.ok === false) return;
    try {
      const records = await this.kernel.changelog.list({ turnId });
      const change = records.find((r) => r.context?.toolCallId === toolCallId);
      if (!change) return;
      await flush();
      const workItem = buildWorkItemPayload(toolName, toolInput, change);
      const stored = await this.sessions.addMessage({
        sessionId: this.currentSessionId,
        role: "assistant",
        content: encodeWorkItemMessage(workItem),
        turnId,
      });
      const updatedChange = await this.kernel.changelog.updateWorkblockMetadata(
        change.id,
        {
          rationale: workItem.rationale.why,
          implementation: workItem.rationale.implementation,
          workMessageId: stored.id,
        },
      ) ?? change;
      workItem.change = updatedChange;
      if (change.changesetId) {
        await this.kernel.changesets.addWorkMessageId(
          change.changesetId,
          stored.id,
        ).catch(() => {});
        const updated = await this.kernel.changesets.get(change.changesetId);
        if (updated) {
          onEvent?.({ type: "changeset_updated", changeset: updated });
        }
      }
      onEvent?.({
        type: "work_item_created",
        messageId: stored.id,
        workItem,
      });
    } catch {
      // Work-item rendering is best-effort; the changelog remains authoritative.
    }
  }

  // Capture each screenshot PNG a tool result carries (`_images`) as a durable,
  // versioned image/png document + one ledger/evidence ref (Slice C-rich, Stage 3d —
  // closes gap G6's screenshot half for the local loop). The Managed path does this
  // inline while building the model's image content blocks; the local loop feeds the
  // raw result to the provider adapter, so the capture is factored out here and driven
  // from the local tool loop. Best-effort — a provenance-persistence failure never
  // alters the turn (each image is guarded independently).
  private async captureLocalScreenshots(
    toolCallId: string,
    result: unknown,
  ): Promise<void> {
    const images = (result as Record<string, unknown> | undefined)?._images as
      | Array<{ png: Uint8Array }>
      | undefined;
    if (!images?.length) return;
    for (let i = 0; i < images.length; i++) {
      try {
        const captured = await captureScreenshotEvidenceDocument(
          this.kernel.documents,
          toolCallId,
          i,
          images[i]!.png,
          this.currentSessionId ?? undefined,
        );
        if (!captured.ok) {
          this.kernel.log.log(
            "debug",
            "agent",
            `Screenshot for tool call "${toolCallId}" not captured as a ` +
              `document: ${captured.error.code} (${captured.error.message})`,
          );
        }
      } catch (err) {
        this.kernel.log.log(
          "warn",
          "agent",
          `Capturing screenshot for tool call "${toolCallId}" failed: ${
            errorMessage(err)
          }`,
        );
      }
    }
  }

  // Handle the changeset lifecycle event a plan/changeset tool's result carries, mirroring
  // runTurn's inline changeset block (Stage 3d — closes gap G6's inline half for the local
  // loop). For a plan tool it flushes the pending assistant segment to obtain a message id,
  // anchors that id onto the changeset (addPlanMessageId), rewrites the tool result to carry
  // the anchored changeset, then emits the changeset lifecycle event, tracks the active
  // changesetId on the change context, and captures the plan document (best-effort). Returns
  // whether the turn should pause for approval (a freshly created changeset or an amended
  // plan). `flush` persists the caller's pending assistant segment and returns its message id.
  private async handleLocalChangesetEvent(opts: {
    call: ToolCallRecord;
    flush: () => Promise<number | null>;
    changeContext: ChangeContext;
    onEvent?: ChatEventHandler;
  }): Promise<boolean> {
    const { call, flush, changeContext, onEvent } = opts;
    let toolResult = call.result as Record<string, unknown> | undefined;
    if (!toolResult?._changesetEvent) return false;

    const planTool = CHANGESET_PLAN_TOOLS.has(call.name);
    const messageId = await flush();
    let changeset = toolResult._changeset;
    const csId = (changeset as { id?: unknown } | undefined)?.id;
    if (planTool && messageId !== null && typeof csId === "string") {
      try {
        changeset = await this.kernel.changesets.addPlanMessageId(
          csId,
          messageId,
        );
        const rewritten = {
          ...toolResult,
          data: changeset,
          _changeset: changeset,
        };
        call.result = rewritten;
        toolResult = rewritten;
      } catch {
        // The plan remains persisted even if the chat anchor update fails.
      }
    }
    onEvent?.({
      type: toolResult._changesetEvent as ChatEvent["type"],
      changeset,
    });
    const cs = changeset as { id?: string; status?: string } | undefined;
    if (
      cs?.id &&
      (cs.status === "in_progress" || cs.status === "completed") &&
      !changeContext.changesetId
    ) {
      changeContext.changesetId = cs.id;
    } else if (
      cs?.id && cs.status !== "in_progress" &&
      cs.status !== "completed" &&
      changeContext.changesetId === cs.id
    ) {
      delete changeContext.changesetId;
    }
    if (planTool) {
      const planCs = changeset as Changeset | undefined;
      if (planCs?.id) {
        try {
          const captured = await captureChangesetPlanDocument(
            this.kernel.documents,
            planCs,
          );
          if (!captured.ok) {
            this.kernel.log.log(
              "debug",
              "agent",
              `Changeset "${planCs.id}" plan not captured as a document: ` +
                `${captured.error.code} (${captured.error.message})`,
            );
          }
        } catch (err) {
          this.kernel.log.log(
            "warn",
            "agent",
            `Capturing changeset "${planCs.id}" plan failed: ${
              errorMessage(err)
            }`,
          );
        }
      }
    }
    const wouldPause = toolResult._changesetEvent === "changeset_created" ||
      call.name === "amend_changeset_plan";
    // Proportional verification: a freshly created LIGHT-lane changeset is approved by
    // the kernel and started inline, so the turn continues into the work instead of
    // stopping for a round-trip. The consent this rests on is not "the model said it
    // was small" — it is the dispatch gate, which refuses any out-of-budget verb for
    // this changeset's whole lifetime. The changeset is still created, still rendered,
    // still in the changelog, still undoable.
    //
    // Amendments are deliberately excluded: an amendment means the scope GREW, which is
    // precisely when a person should look at it.
    if (
      wouldPause && toolResult._changesetEvent === "changeset_created" &&
      await this.autoApproveLightChangeset(
        changeset as Changeset | undefined,
        changeContext,
        onEvent,
      )
    ) {
      return false;
    }
    return wouldPause;
  }

  // Approve + start a light-lane changeset without a human round-trip, when policy
  // allows. Returns whether it did. Best-effort: any failure falls back to the normal
  // pause, because failing closed here costs a round-trip while failing open would
  // start unapproved work.
  private async autoApproveLightChangeset(
    changeset: Changeset | undefined,
    changeContext: ChangeContext,
    onEvent?: ChatEventHandler,
  ): Promise<boolean> {
    if (!changeset?.id || changeset.status !== "planning") return false;
    const cls = changeset.plan.changeClass;
    if (cls?.effective !== "light" || cls.escalated) return false;
    if (getKernelSettings().proportionalVerification === "never") return false;
    try {
      await this.kernel.changesets.approve(changeset.id);
      const started = await this.kernel.changesets.startWork(changeset.id);
      // Record that the kernel approved this, and WHY. `approvalMessageId` is left
      // null on purpose — a kernel auto-approval must never be recorded as a human one.
      const stamped = await this.kernel.changesets.recordChangeClass(
        started.id,
        { ...cls, autoApproved: true },
      );
      changeContext.changesetId = stamped.id;
      onEvent?.({ type: "changeset_updated", changeset: stamped });
      return true;
    } catch (err) {
      this.kernel.log.log(
        "warn",
        "agent",
        `Auto-approving light changeset "${changeset.id}" failed; falling back ` +
          `to manual approval: ${errorMessage(err)}`,
      );
      return false;
    }
  }

  // Structural step auto-advance / auto-complete safety net (Stage 3d — closes gap G3).
  // When a builder-tool-only turn ran against an in-progress changeset, advance as many
  // pending steps as builder tool kinds fired and, once every step is settled and the
  // readiness gate passes, complete + aggregate the changeset. Dormant when the agent
  // drove the changeset itself (any CHANGESET_LIFECYCLE_TOOLS call). Shared by the whole-
  // turn and per-step runners so they never drift. Best-effort — never rethrows.
  private async advanceChangesetSteps(
    changeContext: ChangeContext,
    toolCalls: ToolCallRecord[],
    onEvent?: ChatEventHandler,
  ): Promise<void> {
    if (!changeContext.changesetId || toolCalls.length === 0) return;
    if (toolCalls.some((t) => CHANGESET_LIFECYCLE_TOOLS.has(t.name))) return;
    const builderToolTypes = new Set(
      toolCalls
        .filter((t) =>
          !CHANGESET_LIFECYCLE_TOOLS.has(t.name) &&
          (t.result as Record<string, unknown>)?.ok !== false
        )
        .map((t) => t.name),
    );
    if (builderToolTypes.size === 0) return;
    try {
      const cs = await this.kernel.changesets.get(changeContext.changesetId);
      if (!cs || cs.status !== "in_progress") return;
      const pending = cs.plan.steps.filter((s) => s.status === "pending");
      const toAdvance = Math.min(builderToolTypes.size, pending.length);
      let updated = cs;
      for (let i = 0; i < toAdvance; i++) {
        updated = await this.kernel.changesets.updateStep(
          cs.id,
          pending[i]!.id,
          "done",
        );
      }
      onEvent?.({ type: "changeset_updated", changeset: updated });
      if (
        updated.plan.steps.every((s) =>
          s.status === "done" || s.status === "skipped"
        ) && (await checkProjectAwareReadiness(this.kernel, updated)).passed
      ) {
        const completed = await this.kernel.changesets.complete(updated.id);
        const aggregated = await this.kernel.changesets.aggregate(
          completed.id,
          this.kernel.sessions,
          this.kernel.changelog,
        );
        onEvent?.({ type: "changeset_completed", changeset: aggregated });
      }
    } catch {
      // Structural advance is a safety net, never a turn-breaker.
    }
  }

  // Anchor each persisted assistant segment's message id onto the active changeset
  // (Stage 3d — closes gap G6's tail half). Work segments (any tool call) get a
  // work-message anchor; plan-tool segments additionally re-anchor their plan-message id.
  // Extracted verbatim from runTurn's tail (behavior-identical) so both loops emit the
  // same anchoring changeset_updated/changeset_completed events. Best-effort per segment.
  private async anchorSegmentMessages(
    changeContext: ChangeContext,
    segments: Array<{ messageId: number; toolCalls: ToolCallRecord[] }>,
    onEvent?: ChatEventHandler,
  ): Promise<void> {
    if (changeContext.changesetId) {
      for (const segment of segments) {
        if (segment.toolCalls.length === 0) continue;
        try {
          const updated = await this.kernel.changesets.addWorkMessageId(
            changeContext.changesetId,
            segment.messageId,
          );
          onEvent?.({
            type: updated.status === "completed"
              ? "changeset_completed"
              : "changeset_updated",
            changeset: updated,
          });
        } catch {
          // The response can still render even if a changeset anchor fails.
        }
      }
    }
    for (const segment of segments) {
      const planChangesetIds = new Set<string>();
      for (const toolCall of segment.toolCalls) {
        if (!CHANGESET_PLAN_TOOLS.has(toolCall.name)) continue;
        const result = toolCall.result as
          | { _changeset?: { id?: unknown }; data?: { id?: unknown } }
          | undefined;
        const id = result?._changeset?.id ?? result?.data?.id;
        if (typeof id === "string") planChangesetIds.add(id);
      }
      for (const id of planChangesetIds) {
        try {
          const updated = await this.kernel.changesets.addPlanMessageId(
            id,
            segment.messageId,
          );
          onEvent?.({ type: "changeset_updated", changeset: updated });
        } catch {
          // The plan remains persisted even if the chat anchor update fails.
        }
      }
    }
  }

  // The turn-tail changeset completion (Stage 3d — closes gap G3's completion half).
  // Once every step is settled and readiness passes, complete + aggregate the changeset
  // and emit changeset_completed — the safety net that guarantees a finished changeset is
  // never left in_progress. Extracted verbatim from runTurn's tail (behavior-identical)
  // and shared by both loops.
  private async completeChangesetIfReady(
    changeContext: ChangeContext,
    onEvent?: ChatEventHandler,
  ): Promise<void> {
    if (!changeContext.changesetId) return;
    try {
      let cs = await this.kernel.changesets.get(changeContext.changesetId);
      if (
        cs?.status === "in_progress" &&
        cs.plan.steps.every((s) =>
          s.status === "done" || s.status === "skipped"
        ) &&
        (await checkProjectAwareReadiness(this.kernel, cs)).passed
      ) {
        cs = await this.kernel.changesets.complete(cs.id);
      }
      if (cs?.status === "completed") {
        const updated = await this.kernel.changesets.aggregate(
          changeContext.changesetId,
          this.kernel.sessions,
          this.kernel.changelog,
        );
        onEvent?.({ type: "changeset_completed", changeset: updated });
      }
    } catch {
      // aggregation is best-effort
    }
  }

  // Drive an approved plan as a per-step loop (perStepExecution). Preserves the
  // plan-level approval UX — the approval message is stored and pinned to the
  // changeset exactly as the single-turn path does inside runTurn — then hands the
  // in-progress changeset to the open step orchestrator. The orchestrator advances
  // step status structurally and completes the changeset; each step runs as its own
  // usage-recording turn (via runTurn) against a fresh session. Intermediate
  // per-step `message_complete` events are swallowed so the UI stays busy across the
  // whole plan; one final `message_complete` fires when the plan settles.
  private async runApprovedPlan(opts: {
    content: string;
    storedContent?: string;
    onEvent?: ChatEventHandler;
    user?: CurrentUser;
    activeWorkCs: Changeset;
  }): Promise<string> {
    const { content, storedContent, onEvent, user, activeWorkCs } = opts;

    // Approval anchoring: mirror runTurn's approvalStarted block so the user's
    // approval bubble is stored and linked to the changeset (planning→in_progress
    // UX) even though the approval itself no longer runs as a single model turn.
    if (this.currentSessionId) {
      const userMsg = await this.sessions.addMessage({
        sessionId: this.currentSessionId,
        role: "user",
        content: storedContent ?? content,
        authorUserId: user?.id ?? null,
      });
      onEvent?.({
        type: "message_stored",
        role: "user",
        messageId: userMsg.id,
      });
      try {
        const updated = await this.kernel.changesets.setApprovalMessageId(
          activeWorkCs.id,
          userMsg.id,
        );
        onEvent?.({ type: "changeset_updated", changeset: updated });
      } catch {
        // Approval can still proceed even if the chat anchor is unavailable.
      }
    }

    // Swallow the per-step message_complete events; emit a single one after the plan.
    const stepEvents: ChatEventHandler | undefined = onEvent
      ? (event) => {
        if (event.type === "message_complete") return;
        onEvent(event);
      }
      : undefined;

    // Bind the step runner + fresh-context primitive to the loop (G7). Each step runs via
    // runStepTurn on a freshly cleared retained array. runPlan itself — step advancement,
    // gates, repair, completion — is the SAME open code.
    const fullText = await runPlan(activeWorkCs, {
      runTurn: (o) => this.runStepTurn(o),
      changesets: this.kernel.changesets,
      sessions: this.kernel.sessions,
      changelog: this.kernel.changelog,
      brain: this.brain,
      onEvent: stepEvents,
      isCancelled: () => this.cancelledFlag,
      startFreshStepSession: () => this.startFreshStepSession(),
      checkReadiness: (changeset) =>
        checkProjectAwareReadiness(this.kernel, changeset),
      gates: {
        checkExportTypes: () => this.gateExportTypes(),
        runTests: () => this.gateTests(),
        checkCoverage: (created) => this.gateCoverage(created),
        checkBrowser: () => this.gateBrowser(),
      },
      commitStep: (step, stepIndex) => this.commitStep(step, stepIndex),
    });

    this.inProgressBusy = false;
    onEvent?.({ type: "message_complete" });
    return fullText;
  }

  // The per-step runner (G7): the RunTurnOptions-shaped adapter runPlan drives. Seeds the
  // step's user message into the (freshly cleared) retained array, assembles the base
  // system/tools/model, then runs one bounded step turn via runTurn. Uses the base system
  // prompt (no recovered context) so each step's window stays bounded — the step prompt
  // seeds its own context. activeWorkCs is null (runPlan owns advancement + completion),
  // so the turn tail's step-advance/complete stays dormant.
  private async runStepTurn(o: RunTurnOptions): Promise<TurnResult> {
    const modelRole: ChatTurnModelRole = "agent";
    const model = this.resolveChatTurnModel(modelRole);
    if (!model) throw new Error(MODEL_UNCONFIGURED_MESSAGE);
    this.localMessages.push({
      role: "user",
      content: toNeutralContentBlocks(o.contentBlocks),
    });
    const system = this.brain.baseSystemPrompt(
      await this.getPromptOpts(this.currentSessionId),
    );
    return await this.runTurn({
      content: o.content,
      storedContent: o.storedContent,
      onEvent: o.onEvent,
      user: o.user,
      approvalStarted: o.approvalStarted,
      activeWorkCs: o.activeWorkCs,
      system,
      tools: this.buildNeutralTools(),
      model,
      modelRole,
    });
  }

  // Clear the retained NeutralMessage[] so each plan step runs with bounded context (the
  // step prompt seeds it). The array IS the memory (D2), so clearing it is the whole
  // operation.
  private startFreshStepSession(): Promise<void> {
    this.localMessages = [];
    return Promise.resolve();
  }

  // Deterministic gate executors bound into the step orchestrator (Stage 4). Each maps
  // a kernel-side ToolResult onto the loop's neutral GateOutcome, folding the tool's
  // summary/issues into the diagnostics that seed a repair sub-turn. They live here (not
  // in the open orchestrator) because the executors are kernel-side and must be injected,
  // keeping step-orchestrator.ts free of any core/tools import.
  private async gateExportTypes(): Promise<GateOutcome> {
    const result = await runExportTypeCheck(this.kernel);
    if (!result.ok) {
      return {
        passed: false,
        diagnostics: result.error?.message ?? "Gate execution failed.",
      };
    }
    const data = result.data!;
    if (data.ok) return { passed: true, diagnostics: "" };
    const issues = data.issues
      .map((issue) =>
        `${issue.file}:${issue.line}:${issue.column} ${issue.code} ${issue.message}`
      )
      .join("\n");
    return { passed: false, diagnostics: `${data.summary}\n${issues}`.trim() };
  }

  private async gateTests(): Promise<GateOutcome> {
    const result = await runKernelTests(this.kernel);
    if (!result.ok) {
      return {
        passed: false,
        diagnostics: result.error?.message ?? "Gate execution failed.",
      };
    }
    const data = result.data!;
    if (data.failed === 0) return { passed: true, diagnostics: "" };
    const failures = data.results
      .filter((test) => !test.passed)
      .map((test) => `${test.name}: ${test.error ?? "failed"}`)
      .join("\n");
    return {
      passed: false,
      diagnostics: `${data.summary}\n${failures}`.trim(),
    };
  }

  // Coverage gate (Stage 6): a code step must have a test for each handler/function it
  // created. `createdEntities` (handler:<name> / function:<name>) is the step's own new
  // code, computed loop-side from its toolCalls — so this gate has NO pre-existing-debt
  // trap: it fails only on the step's own untested creations, never on legacy debt, and
  // its diagnostics name exactly which entity needs a test (so a repair sub-turn is
  // actionable). A step that created no testable code (empty keys) passes trivially.
  // computeCoverage attaches tests to handlers/functions transitively, so a route with
  // no test surfaces as its untested handler — routes need no separate key here.
  private async gateCoverage(createdEntities: string[]): Promise<GateOutcome> {
    if (createdEntities.length === 0) return { passed: true, diagnostics: "" };
    const report = await computeCoverage(this.kernel);
    const untested = new Set(report.untested);
    const missing = createdEntities.filter((key) => untested.has(key));
    if (missing.length === 0) return { passed: true, diagnostics: "" };
    const list = missing.map((key) => `- ${key}`).join("\n");
    return {
      passed: false,
      diagnostics:
        `These entities created in this step have no test covering them:\n${list}\n\n` +
        `Write a test for each with define_test and run it, then this step is complete.`,
    };
  }

  // Browser smoke gate (Stage 6): load the app root and report browser infra failures
  // or page errors as blocking diagnostics. Page errors are retried up to
  // BROWSER_GATE_ATTEMPTS so a single transient load-timing artifact does not halt a
  // step; browser launch failures fail immediately because browser support is a
  // required agent capability.
  private async gateBrowser(): Promise<GateOutcome> {
    for (let attempt = 0; attempt < BROWSER_GATE_ATTEMPTS; attempt++) {
      let pageErrors: string[];
      try {
        const result = await testApp(this.kernel.appPort, "/", []);
        pageErrors = result.pageErrors;
      } catch (err) {
        return {
          passed: false,
          diagnostics: `Browser verification could not run:\n${
            errorMessage(err)
          }`,
        };
      }
      if (pageErrors.length === 0) return { passed: true, diagnostics: "" };
      if (attempt === BROWSER_GATE_ATTEMPTS - 1) {
        return {
          passed: false,
          diagnostics: `The app loaded but reported page errors:\n${
            pageErrors.join("\n")
          }`,
        };
      }
    }
    return { passed: true, diagnostics: "" };
  }

  // Stage 5 — durable per-step checkpoint. Bound into runPlan as the `commitStep` thunk:
  // after a step passes its gate and is marked done, commit the project's on-disk state as
  // "step N: <desc>" so each passing step is a rollback boundary and a mid-plan restart
  // resumes from the first pending step with the last good commit intact. Lives here (not
  // in the open orchestrator) because git is kernel-side and must be injected, keeping
  // step-orchestrator.ts free of any core/git.ts import. Fully guarded — git is a
  // checkpoint, never a step-breaker (§7 risk #4) — so it never rethrows into the loop:
  //   • no project dir loaded → no-op (a BYO-key / no-project run simply has no checkpoints);
  //   • NOTHING_TO_COMMIT (schema-only steps with no file delta) → swallowed silently;
  //   • any other GitProjectError (or unexpected error) → logged and swallowed.
  // Mirrors the git_commit tool's call shape (core/tools/dispatch.ts): the flush persists
  // in-memory project state to disk before staging so the commit captures the step's work.
  private commitStep(step: PlanStep, stepIndex: number): Promise<void> {
    const projectDir = this.kernel.projectDir;
    if (!projectDir) return Promise.resolve();
    const message = stepCommitMessage(step, stepIndex);
    try {
      gitCommit(
        projectDir,
        message,
        () => flushKernelProjectState(this.kernel),
      );
      this.kernel.log.log("info", "agent", `Checkpoint committed: ${message}`);
    } catch (err) {
      if (err instanceof GitProjectError && err.code === "NOTHING_TO_COMMIT") {
        // Schema-only / no-delta step: nothing to checkpoint. Expected, not a failure.
        this.kernel.log.log(
          "debug",
          "agent",
          `No file delta to checkpoint for "${message}"; continuing.`,
        );
      } else {
        // Any other git failure (not a repository, bad message, git binary missing) must
        // not break execution — log and continue; the prior commit stays the last good
        // checkpoint that bounds any rollback.
        const detail = err instanceof Error ? err.message : String(err);
        this.kernel.log.log(
          "warn",
          "agent",
          `Step checkpoint commit failed for "${message}": ${detail}`,
        );
      }
    }
    return Promise.resolve();
  }

  // Record one message-role document ref against the stored user message, citing the
  // exact version the agent saw so provenance resolves to fixed bytes (D2). Shared by
  // the Tier-1 @-mention path (role=mention) and the attachment-persistence path
  // (role=attachment) so the two never drift on the ref shape.
  private recordMessageRef(
    documentId: string,
    messageId: number,
    role: Extract<DocumentRefRole, "mention" | "attachment">,
    versionHash: string,
    sessionId: string,
  ): Promise<unknown> {
    return this.kernel.documents.recordRef({
      documentId,
      refType: "message",
      refId: String(messageId),
      role,
      versionHash,
      sessionId,
    });
  }

  // Persist a turn's attachments as session-scoped documents + message/attachment refs
  // (§8/§10). Each attachment instance is its own message-scoped document
  // (createdBy:"user", kind = the mime, metadata.source = attachment tag); the
  // content-addressed store dedupes identical blobs, so re-sending the same file costs
  // no extra bytes. Purely additive durability — never lets a persistence failure sink
  // the turn: with no project loaded create() returns PROJECT_REQUIRED, which (like any
  // store error) is logged at debug and skipped, falling back to today's behavior.
  private async persistAttachmentDocuments(
    attachments: WireAttachment[] | undefined,
    messageId: number,
    sessionId: string,
  ): Promise<void> {
    if (!attachments?.length) return;
    for (const att of attachments) {
      try {
        const created = await this.kernel.documents.create({
          name: att.name,
          kind: att.type,
          content: decodeBase64(att.data),
          scope: "session",
          sessionId,
          createdBy: "user",
          metadata: { source: ATTACHMENT_DOCUMENT_SOURCE },
        });
        if (!created.ok) {
          this.kernel.log.log(
            "debug",
            "agent",
            `Attachment "${att.name}" not persisted as a document: ` +
              `${created.error.code} (${created.error.message})`,
          );
          continue;
        }
        await this.recordMessageRef(
          created.data.id,
          messageId,
          "attachment",
          created.data.currentVersionHash,
          sessionId,
        );
      } catch (err) {
        this.kernel.log.log(
          "warn",
          "agent",
          `Persisting attachment "${att.name}" failed: ${errorMessage(err)}`,
        );
      }
    }
  }

  getCurrentSessionId(): string | null {
    return this.currentSessionId;
  }

  clearCurrentSession(): void {
    if (this.currentSessionId) {
      this.autoNameEligibleSessionIds.delete(this.currentSessionId);
    }
    this.currentSessionId = null;
  }

  // Drop the local turn memory (the retained NeutralMessage[] IS the context, D2) and any
  // recovered prior-session context, so the next turn starts a fresh window. The Managed
  // path deleted a server-side provider session here; the local loop just clears state.
  clearContext(): Promise<void> {
    this.localMessages = [];
    this.recoveredContext = null;
    this.turnCount = 0;
    this.resetContextWindowState();
    return Promise.resolve();
  }

  // Re-arm the per-window one-shot context state: the Slice 3 nudge and the §4.7
  // in-turn prune brake. Called wherever the retained window (localMessages) is reset
  // to a fresh session — clearContext / compactSession / resumeSession — so the next
  // crossing of CONTEXT_NUDGE_RATIO warns again and the fresh window's first prune
  // isn't blocked by the old window's occupancy.
  private resetContextWindowState(): void {
    this.contextNudged = false;
    this.lastPrunedAtOccupancy = 0;
  }

  async clearSession(
    user?: CurrentUser,
  ): Promise<{ newSessionId: string | null }> {
    if (this.currentSessionId) {
      const session = await this.sessions.getSession(this.currentSessionId);
      if (session && canReadUserSession(user ?? localUser(), session)) {
        await this.sessions.endSession(this.currentSessionId);
      }
      this.autoNameEligibleSessionIds.delete(this.currentSessionId);
    }

    await this.clearContext();
    this.currentSessionId = null;
    return { newSessionId: null };
  }

  async compactSession(
    summary: string,
    user?: CurrentUser,
  ): Promise<{ sessionId: string }> {
    if (!this.currentSessionId) throw new Error("No active session");

    const session = await this.sessions.getSession(this.currentSessionId);
    if (!session) throw new Error("Session not found");
    if (!canReadUserSession(user ?? localUser(), session)) {
      throw new Error("Forbidden");
    }

    // Manual /compact: caller-supplied summary, compacted in place (same session).
    return await this.applyCompaction({ session, summary, user });
  }

  // The shared compaction mechanics behind BOTH the manual /compact (compactSession)
  // and the pre-turn auto-compact (autoCompactSession). Compaction is IN PLACE: it keeps
  // the SAME session, the SAME visible transcript, does NOT rename, and does NOT create a
  // new session. It reduces only the MODEL's context — the retained localMessages and the
  // recoveredContext folded into the system prompt — never the persisted transcript.
  //
  // This is safe because resume/load never rehydrates the stored DB messages into
  // localMessages; context is always reconstructed as summary + post-boundary recent
  // turns. We persist a boundary (summarizedThroughMessageId = the latest message id) so
  // that reconstruction only carries turns AFTER the summary, and reset the persisted
  // pressure so the reactive auto-compact gate doesn't immediately re-fire on the shrunk
  // window. The old "new session per compaction" design proliferated near-empty
  // "(compacted) (compacted)" sessions and wiped the visible transcript — this replaces it.
  private async applyCompaction(opts: {
    session: Session;
    summary: string;
    recentLimit?: number;
    user?: CurrentUser;
  }): Promise<{ sessionId: string }> {
    const { session, summary, recentLimit, user } = opts;
    const sessionId = this.currentSessionId;
    if (!sessionId) throw new Error("No active session");

    // Preserve any trailing user message(s) the assistant has not yet answered — a
    // pending question is the tail of the retained array with no assistant turn after
    // it. Without this it survives only as paraphrased summary, which is the "compaction
    // hid my question" symptom. Re-seed them verbatim onto the reset array below so the
    // model still answers them.
    const pendingUserMessages = this.trailingUnansweredUserMessages(
      this.localMessages,
    );

    // Boundary = the latest message id at compaction time; the summary covers through it.
    const existing = await this.sessions.getMessages(sessionId);
    const boundary = existing.length > 0
      ? existing[existing.length - 1]!.id
      : 0;

    // Read-modify-write the session metadata: record the boundary + reset the persisted
    // context signal (the shrunk window must not immediately re-trip the 95% gate). Fetch
    // fresh — the auto path's summarizeSession(store:true) may have just written metadata.
    const fresh = await this.sessions.getSession(sessionId);
    const metadata = parseSessionMetadata(
      fresh?.metadata ?? session.metadata ?? null,
    );
    metadata.summarizedThroughMessageId = boundary;
    metadata.summarizedAt = new Date().toISOString();
    clearLastContextMetadata(metadata);
    await this.sessions.updateSummaryMetadata(
      sessionId,
      summary,
      JSON.stringify(metadata),
    );

    // A single de-emphasized timeline marker; the IDE renders the "[Compacted session
    // summary]: " prefix as a collapsible card. Pins already live in this session — no
    // re-copy. Focus is untouched (same session).
    await this.sessions.addMessage({
      sessionId,
      role: "system",
      content: `[Compacted session summary]: ${summary}`,
    });

    this.localMessages = [...pendingUserMessages];
    this.resetContextWindowState();
    this.recoveredContext = await this.buildRecoveredContext(sessionId, {
      heading: "Continuing Compacted Session Context",
      includeRecent: true,
      recentLimit,
      user,
    });

    return { sessionId };
  }

  // The gate in front of a mid-turn context trim (agent cost reduction, §4.7 + §4.8),
  // called once per tool round-trip. Cheap when it declines, which is most requests.
  //
  // Two thresholds, and they answer different questions.
  //
  // 1. Occupancy — "is this turn actually in trouble?" The provider's EXACT counts for
  //    the request that just completed (cached tokens are billed cheap but still occupy
  //    the window) plus a chars/4 estimate for the results appended since. Provider
  //    numbers are preferred wherever they exist: chars/4 UNDER-counts dense JSON,
  //    which is precisely the content being hunted. A provider that reports no usage
  //    leaves the counters at 0, so the estimate alone has to clear the ratio —
  //    fail-safe, it declines.
  // 2. Rewrite ratio — "is this trim worth what it costs?" A trim invalidates the
  //    cached prefix, so it pays its rewrite ONCE and collects its saving on every
  //    request that follows. §8 measured the two prunes on turn_mu0zfxi7 and found the
  //    second was a $0.36 LOSS because it fired at request 24 of 35. How many requests
  //    remain is not observable here and must not be guessed; CONTEXT_PRUNE_MAX_REWRITE_
  //    RATIO fixes the assumption instead (a ceiling of C assumes 12.5 x C remaining).
  // 3. Safety pressure — "is this turn about to be REJECTED?" The same occupancy over
  //    the model's real input capacity (modelInputCapacity) instead of the working
  //    budget, because those are two different walls: on claude-opus-5 the budget is a
  //    cost ceiling with 932k of capacity behind it, on claude-haiku-4-5 the budget IS
  //    the capacity. Past CONTEXT_PRUNE_SAFETY_RATIO the cost question stops mattering
  //    — both 1 and 2 are bypassed and the trim happens. A $0.50 rewrite beats a
  //    failed turn. On a large-window model this tier is dormant by construction.
  private maybeTrimContextInTurn(opts: {
    model: string;
    appended: NeutralToolResultBlock[];
    completedTurnEnd: number;
    lastReqInputTokens: number;
    lastReqCacheCreationTokens: number;
    lastReqCacheReadTokens: number;
    onEvent?: ChatEventHandler;
  }): void {
    const settings = getKernelSettings();
    // Same master switch as the pre-turn guard: one setting turns context management
    // off, including this.
    if (!settings.autoCompactEnabled) return;

    const appendedTokens = estimateTokens([
      { role: "tool", content: opts.appended },
    ]);
    const occupancy = contextOccupancyTokens({
      inputTokens: opts.lastReqInputTokens,
      cacheCreationInputTokens: opts.lastReqCacheCreationTokens,
      cacheReadInputTokens: opts.lastReqCacheReadTokens,
    }) + appendedTokens;
    // source reads "provider" because that is where all but appendedResultTokens of
    // this number came from; the diagnostic carries the estimated part separately.
    const pressure = computeContextPressure(occupancy, opts.model);

    // The safety tier. capacity > 0 for every model the resolver can produce; the
    // guard is for a hand-edited window small enough to go non-positive, and reads
    // the same way computeContextPressure's does — no capacity at all is maximum
    // pressure, so trim. That degrades to trimming every request, which is survivable
    // because the plan runs out of things to reclaim and the gate below returns.
    const capacity = modelInputCapacity(opts.model);
    const safetyPressure = capacity > 0 ? occupancy / capacity : 1;
    const forced = safetyPressure >= settings.contextPruneSafetyRatio;

    if (!forced && pressure.pressure < settings.contextPruneRatio) return;

    // Arm-once. A trim rewrites the middle of the prefix, so it costs one cache write
    // from message 1 onward. That trade only holds if the rewrite happens ONCE — so
    // demand real growth since the last one instead of firing again next request.
    // Not at the wall, though: there, trimming every request is the cheap outcome.
    if (
      !forced &&
      this.lastPrunedAtOccupancy > 0 &&
      occupancy < this.lastPrunedAtOccupancy * CONTEXT_PRUNE_REARM_GROWTH
    ) {
      return;
    }

    // Dry run: plan everything, price it, THEN decide. §4.8's reasoning drop rides in
    // the same plan on purpose — the rewrite is already being paid, so folding it in is
    // free and makes the rewrite itself smaller.
    const plan = planContextTrim(this.localMessages, {
      keepRecent: CONTEXT_RETAIN_TOOL_RESULTS,
      completedTurnEnd: opts.completedTurnEnd,
    });
    // Nothing old and big enough to reclaim: don't arm the brake, don't claim a trim.
    // The walk re-runs next request, which is cheap — everything large is gone.
    if (plan.edits.length === 0 || plan.tokensReclaimed <= 0) return;

    const rewriteTokens = prefixRewriteTokens(
      this.localMessages,
      plan.tokensReclaimed,
    );
    const rewriteRatio = rewriteTokens / plan.tokensReclaimed;
    if (!forced && rewriteRatio > settings.contextPruneMaxRewriteRatio) {
      // Worth a line: this is the evidence for whether the ceiling is tuned right, and
      // it only ever fires on a request that already cleared occupancy and the brake.
      this.logContextDiagnostic(
        "info",
        "Declined a mid-turn context trim: rewrite cost exceeds the reclaim",
        pressure,
        {
          tokensReclaimed: plan.tokensReclaimed,
          rewriteTokens,
          rewriteRatio,
          maxRewriteRatio: settings.contextPruneMaxRewriteRatio,
          blocksPruned: plan.blocksPruned,
          reasoningBlocksDropped: plan.reasoningBlocksDropped,
        },
      );
      return;
    }

    applyContextTrim(plan);
    this.lastPrunedAtOccupancy = occupancy;
    // What the trim could NOT reclaim. When the safety tier fired and this is still
    // over capacity, the next request is going to be rejected and there is nothing
    // left in this design to stop it — mid-turn compaction is the real answer and it
    // is deliberately out of scope. So: say so, loudly, at the one moment the case is
    // observable, rather than letting it show up later as an unexplained provider 400.
    const residualOccupancy = occupancy - plan.tokensReclaimed;
    const stillOverCapacity = forced && residualOccupancy > capacity;
    this.logContextDiagnostic(
      stillOverCapacity ? "warn" : "info",
      stillOverCapacity
        ? "Safety trim could not reclaim enough — the next request may still overflow"
        : "Trimmed context mid-turn",
      pressure,
      {
        tokensReclaimed: plan.tokensReclaimed,
        rewriteTokens,
        rewriteRatio,
        blocksPruned: plan.blocksPruned,
        reasoningBlocksDropped: plan.reasoningBlocksDropped,
        appendedResultTokens: appendedTokens,
        keepRecent: CONTEXT_RETAIN_TOOL_RESULTS,
        threshold: settings.contextPruneRatio,
        forced,
        capacity,
        safetyPressure,
        safetyThreshold: settings.contextPruneSafetyRatio,
        residualOccupancy,
      },
    );
    opts.onEvent?.({
      type: "text_delta",
      text: `\n\n${CONTEXT_PRUNE_NOTICE}\n\n`,
    });
  }

  // §4.8's other firing path, and the only one that costs nothing at all: drop settled
  // turns' reasoning at the START of a turn, but ONLY when the provider's cached prefix
  // has already expired. Every prefix mutation forces a rewrite; when the entry is gone
  // the rewrite is happening regardless, so removing dead weight first makes it smaller
  // and every later read cheaper, for free. That is the whole gate — no ratio test,
  // because there is no cost to weigh.
  //
  // Cold is inferred two ways. From the wall clock: Anthropic's default ephemeral
  // entry lives 5 minutes and every read refreshes it, so CACHE_COLD_PREFIX_IDLE_MS of
  // silence since the last request means it is gone; the slack in that constant makes
  // a wrong guess fall on the "still warm, do nothing" side. And from the model: cache
  // entries are per-model, so a switch mid-session strands the old one regardless of
  // timing.
  //
  // Tool results are deliberately NOT touched here. They are the model's working
  // memory and stubbing them loses detail it may still need; reasoning from a turn that
  // has already settled is not memory the model can act on — the provider requires it
  // round-tripped only within the assistant turn that owns the tool_use.
  private dropSettledReasoningIfPrefixCold(
    completedTurnEnd: number,
    now: number,
    model: string,
  ): void {
    if (!getKernelSettings().autoCompactEnabled) return;
    if (this.lastProviderRequestAt <= 0) return;
    // Two ways the entry is gone: it timed out, or the model changed under it. The
    // second is not just free — it is the one case where carrying settled reasoning
    // forward is also WRONG, since the blocks were captured under a different model.
    const idleMs = now - this.lastProviderRequestAt;
    const modelChanged = this.lastProviderRequestModel !== null &&
      this.lastProviderRequestModel !== model;
    if (!modelChanged && idleMs < CACHE_COLD_PREFIX_IDLE_MS) return;

    const plan = planContextTrim(this.localMessages, {
      keepRecent: null,
      completedTurnEnd,
    });
    if (plan.edits.length === 0) return;
    applyContextTrim(plan);
    this.kernel.log.log(
      "info",
      "agent",
      "Dropped settled turns' reasoning while the cache prefix was cold",
      {
        metadata: {
          tokensReclaimed: plan.tokensReclaimed,
          reasoningBlocksDropped: plan.reasoningBlocksDropped,
          idleMs,
          coldAfterMs: CACHE_COLD_PREFIX_IDLE_MS,
          modelChanged,
          model,
        },
      },
    );
  }

  private logContextDiagnostic(
    level: "info" | "warn" | "error",
    message: string,
    pressure: ContextPressure,
    extra: Record<string, unknown> = {},
  ): void {
    this.kernel.log.log(level, "agent", message, {
      metadata: {
        model: pressure.model,
        occupancy: pressure.occupancy,
        budget: pressure.budget,
        pressure: pressure.pressure,
        contextWindow: pressure.contextWindow,
        outputReservation: pressure.outputReservation,
        safetyMargin: pressure.safetyMargin,
        source: pressure.source,
        ...extra,
      },
    });
  }

  private async estimatePreparedRequest(
    model: string,
    incomingUserMessage: NeutralMessage,
  ): Promise<
    { pressure: ContextPressure; system: string; tools: NeutralTool[] }
  > {
    const system = await this.localSystemPrompt();
    const tools = this.buildNeutralTools();
    const pressure = estimatedContextPressure({
      model,
      system,
      messages: [...this.localMessages, incomingUserMessage],
      tools,
    });
    return { pressure, system, tools };
  }

  // The pre-turn auto-compaction guard (context-hardening plan, Slice 4). It estimates
  // the exact request shape the provider will receive: system prompt, retained messages,
  // incoming user content after mention/attachment expansion, and tool schemas.
  private async prepareContextPreflight(
    model: string,
    incomingUserMessage: NeutralMessage,
    onEvent?: ChatEventHandler,
    user?: CurrentUser,
  ): Promise<ContextPreflightResult> {
    const prepared = await this.estimatePreparedRequest(
      model,
      incomingUserMessage,
    );

    const kernelSettings = getKernelSettings();
    if (!kernelSettings.autoCompactEnabled || !this.currentSessionId) {
      return {
        ok: true,
        system: prepared.system,
        tools: prepared.tools,
        model,
      };
    }

    const reactivePressure = await this.lastContextPressure(model);
    const reactive = reactivePressure >=
      kernelSettings.contextAutoCompactRatio;
    const proactive = prepared.pressure.pressure >=
      kernelSettings.contextAutoCompactRatio;

    if (!reactive && !proactive) {
      // Under the threshold again — re-arm the brake below.
      this.autoCompactIneffective = false;
      return {
        ok: true,
        system: prepared.system,
        tools: prepared.tools,
        model,
      };
    }

    // A previous compaction already proved it can't get this session under the
    // threshold (the retained tail alone exceeds the working budget). Compacting
    // again would summarize, bill, and change nothing, so let the turn through
    // instead of looping. Re-arms above the moment occupancy drops back under.
    if (this.autoCompactIneffective) {
      // Still refuse to send a request the model cannot accept: the brake skips the
      // pointless re-summarize, not the hard floor.
      const doomed = prepared.pressure.pressure >= 1;
      this.logContextDiagnostic(
        doomed ? "error" : "warn",
        "Context still above the auto-compaction threshold, but compaction was already proven ineffective — not re-compacting",
        prepared.pressure,
        { trigger: reactive ? "reactive" : "proactive", reactivePressure },
      );
      if (doomed) {
        onEvent?.({ type: "error", text: CONTEXT_LENGTH_HARD_FLOOR_MESSAGE });
      }
      return {
        ok: !doomed,
        system: prepared.system,
        tools: prepared.tools,
        model,
      };
    }

    this.logContextDiagnostic(
      "warn",
      "Context auto-compaction threshold crossed before provider request",
      prepared.pressure,
      { trigger: reactive ? "reactive" : "proactive", reactivePressure },
    );

    const result = await this.autoCompactSession(onEvent, user);
    if (!result) {
      return {
        ok: true,
        system: prepared.system,
        tools: prepared.tools,
        model,
      };
    }

    this.logContextDiagnostic(
      "info",
      "Context auto-compaction completed before provider request",
      prepared.pressure,
      { sessionId: this.currentSessionId },
    );

    const postCompact = await this.estimatePreparedRequest(
      model,
      incomingUserMessage,
    );
    this.logContextDiagnostic(
      postCompact.pressure.pressure >= 1 ? "error" : "info",
      "Context pressure re-estimated after auto-compaction",
      postCompact.pressure,
      { sessionId: this.currentSessionId },
    );
    // Did compaction actually buy anything? If occupancy is still at or above the
    // threshold, the floor is the summary + retained turns themselves and another
    // pass would only bill for the same result — set the brake so the next turn
    // skips the guard rather than looping.
    if (
      postCompact.pressure.pressure >= kernelSettings.contextAutoCompactRatio
    ) {
      this.autoCompactIneffective = true;
      this.logContextDiagnostic(
        "warn",
        "Auto-compaction did not bring context under the threshold — disarming the pre-turn guard until occupancy drops",
        postCompact.pressure,
        {
          sessionId: this.currentSessionId,
          threshold: kernelSettings.contextAutoCompactRatio,
        },
      );
    }
    if (postCompact.pressure.pressure >= 1) {
      onEvent?.({ type: "error", text: CONTEXT_LENGTH_HARD_FLOOR_MESSAGE });
      return {
        ok: false,
        system: postCompact.system,
        tools: postCompact.tools,
        model,
      };
    }

    return {
      ok: true,
      system: postCompact.system,
      tools: postCompact.tools,
      model,
    };
  }

  // The last turn's persisted context pressure, or 0 when it is absent, malformed,
  // legacy/incomplete, or for a different model.
  private async lastContextPressure(model: string): Promise<number> {
    if (!this.currentSessionId) return 0;
    const session = await this.sessions.getSession(this.currentSessionId);
    const metadata = parseSessionMetadata(session?.metadata ?? null);
    const pressure = metadata.lastContextPressure;
    const occupancy = metadata.lastContextOccupancyTokens;
    const budget = metadata.lastContextBudget;
    const measuredModel = metadata.lastContextModel;
    const measuredAt = metadata.lastContextMeasuredAt;
    if (
      typeof pressure !== "number" || !Number.isFinite(pressure) ||
      typeof occupancy !== "number" || !Number.isFinite(occupancy) ||
      typeof budget !== "number" || !Number.isFinite(budget) ||
      typeof measuredAt !== "string" || measuredAt.trim().length === 0 ||
      measuredModel !== model
    ) {
      return 0;
    }
    return pressure;
  }

  // The pre-turn sibling of compactSession (Slice 4). Unlike the manual path it
  // (a) generates the handoff summary itself via summarizeSession instead of taking a
  // caller string, (b) carries the last AUTOCOMPACT_RETAINED_TURNS raw turns past the
  // summary for smoother continuity (includeRecent), and (c) emits a session_compacted
  // event so the IDE can switch to the fresh session and show the inline notice. Shares
  // applyCompaction with the manual path. Returns the new session id, or null when
  // there is no readable current session to compact.
  private async autoCompactSession(
    onEvent?: ChatEventHandler,
    user?: CurrentUser,
  ): Promise<{ newSessionId: string } | null> {
    if (!this.currentSessionId) return null;
    const session = await this.sessions.getSession(this.currentSessionId);
    if (!session) return null;
    if (!canReadUserSession(user ?? localUser(), session)) return null;

    // Self-generate the handoff summary (stored) — falling back to any existing
    // summary if the utility model is unavailable, so a compaction still proceeds.
    const summarized = await summarizeSession(this.kernel, {
      sessionId: this.currentSessionId,
      kind: "handoff",
      store: true,
      requester: "user",
      accountingCaller: "session_compaction",
    });
    const summary = summarized?.summary ?? session.summary ?? "";

    const compacted = await this.applyCompaction({
      session,
      summary,
      recentLimit: AUTOCOMPACT_RETAINED_TURNS,
      user,
    });

    // In-place: the SAME session id, name unchanged. The event tells the IDE to reload
    // the transcript (now carrying the compaction marker) and reset the meter — NOT to
    // switch sessions.
    onEvent?.({
      type: "session_compacted",
      sessionId: compacted.sessionId,
      sessionName: session.name,
      text: CONTEXT_AUTOCOMPACT_MESSAGE,
    });
    return { newSessionId: compacted.sessionId };
  }

  async resumeSession(
    targetSessionId: string,
    user?: CurrentUser,
  ): Promise<{ newSessionId: string }> {
    const effectiveUser = user ?? localUser();
    let target = await this.sessions.getSession(targetSessionId);
    if (!target) {
      const all = await this.sessions.listSessions(100);
      target = all.find((s) =>
        canReadUserSession(effectiveUser, s) &&
        s.name.toLowerCase().includes(targetSessionId.toLowerCase())
      ) ?? null;
    }
    if (!target) throw new Error(`Session "${targetSessionId}" not found`);
    if (!canReadUserSession(effectiveUser, target)) {
      throw new Error("Forbidden");
    }
    if (target.archived) {
      throw new Error("Archived sessions must be unarchived before resuming");
    }

    if (this.currentSessionId) {
      const current = await this.sessions.getSession(this.currentSessionId);
      if (
        current && !current.archived &&
        canReadUserSession(effectiveUser, current)
      ) {
        await this.sessions.endSession(this.currentSessionId);
      }
      this.autoNameEligibleSessionIds.delete(this.currentSessionId);
    }

    // Reset the retained turn memory and seed the target session's context (summary,
    // focus, pins, recent conversation) as the recovered context folded into the next
    // turn's system prompt — the local analogue of the Managed agent rebuild.
    this.localMessages = [];
    this.resetContextWindowState();
    this.recoveredContext = await this.buildRecoveredContext(target.id, {
      heading: "Resumed Session Context",
      user,
    });

    await this.sessions.reopenSession(target.id);
    this.currentSessionId = target.id;
    this.turnCount = 0;

    return { newSessionId: target.id };
  }

  private startAutoNameForFirstUserMessage(
    turnIndex: number,
    sessionId: string,
    userMessage: string,
    onEvent?: ChatEventHandler,
  ): void {
    if (turnIndex !== 0) return;
    if (!this.autoNameEligibleSessionIds.delete(sessionId)) return;
    try {
      const namePromise = this.sessionNameGenerator(
        userMessage,
        this.kernel.log,
        {
          sessionId,
          recordUsage: (input) => this.sessions.recordModelUsage(input),
        },
      );
      void this.finishAutoNameFirstUserMessage(sessionId, namePromise, onEvent);
    } catch (err) {
      this.kernel.log.log(
        "warn",
        "system",
        `session async auto-name failed: ${errorMessage(err)}`,
      );
    }
  }

  private async finishAutoNameFirstUserMessage(
    sessionId: string,
    namePromise: Promise<string>,
    onEvent?: ChatEventHandler,
  ): Promise<void> {
    try {
      const name = await namePromise;
      if (!name.trim()) return;
      const latest = await this.sessions.getSession(sessionId);
      if (
        !latest || latest.name !== "New Session" ||
        this.currentSessionId !== sessionId
      ) {
        return;
      }
      await this.sessions.renameSession(sessionId, name);
      onEvent?.({ type: "session_renamed", sessionId, sessionName: name });
    } catch (err) {
      this.kernel.log.log(
        "warn",
        "system",
        `session async auto-name failed: ${errorMessage(err)}`,
      );
    }
  }

  async close(): Promise<void> {
    if (this.currentSessionId) {
      await this.sessions.endSession(this.currentSessionId);
    }
  }
}
