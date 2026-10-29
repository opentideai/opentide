// @layer core — durable documents for what a tool call produced: a changeset's
// plan and the screenshots a tool returned. Tool dispatch captures them for every
// client, so they don't depend on which agent made the call.
import type { Changeset, Result } from "./types.ts";
import {
  type DocumentRecord,
  type DocumentRef,
  type DocumentStore,
  PLAN_DOCUMENT_KIND,
  PLAN_DOCUMENT_SOURCE,
  SCREENSHOT_DOCUMENT_KIND,
  SCREENSHOT_DOCUMENT_SOURCE,
} from "./documents.ts";

// The store operations a capture needs.
export type CaptureStore = Pick<
  DocumentStore,
  "findBySource" | "update" | "create" | "recordUniqueRef"
>;

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
  store: CaptureStore,
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
// ledger/evidence ref citing the head (plan §8/§11, Slice C-rich). Called from tool
// dispatch on any result carrying `_images`, so every client's screenshots are kept. The bytes
// are stored VERBATIM (DocumentStore.create accepts Uint8Array; content-addressing dedupes
// identical shots). ADDITIVE provenance, same contract as the item docs: the doc is found by
// its ORIGIN (metadata.source=SCREENSHOT_DOCUMENT_SOURCE + sourceId=<composite key>), so a
// re-dispatch rediscovers/updates the SAME doc and recordUniqueRef re-points the single ref
// at the head. Best-effort: returns the store Result (never throws for the store's own
// errors) so the caller degrades a provenance-write failure (e.g. PROJECT_REQUIRED with no
// project loaded) to a debug log without sinking the turn.
export async function captureScreenshotEvidenceDocument(
  store: CaptureStore,
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
