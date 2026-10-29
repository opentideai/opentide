import { assert, assertEquals } from "@std/assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import {
  captureChangesetPlanDocument,
  captureScreenshotEvidenceDocument,
  renderChangesetPlanDocument,
  screenshotEvidenceLedgerKey,
} from "./document-capture.ts";
import {
  PLAN_DOCUMENT_SOURCE,
  SCREENSHOT_DOCUMENT_SOURCE,
} from "./documents.ts";
import { genieDocumentRefsTable } from "./db/schema/index.ts";
import { Database } from "./db.ts";
import { Kernel } from "./registries.ts";
import type { Changeset } from "./types.ts";
import { testStoreComposition } from "../verification/test-stores.ts";
import { testComposition } from "../cli/test-composition.ts";
import { captureResultDocuments, dispatchTool } from "./tools/dispatch.ts";

// --- Slice B: changeset plan captured as a versioned document (D4, minimal) ---

// A minimal Changeset carrying only the fields captureChangesetPlanDocument reads
// (id, title, sessionId, plan.summary, plan.steps); the rest is filled to satisfy the
// type without cast, since Slice B does not touch changeset lifecycle behavior.
function fakePlanChangeset(over: {
  id: string;
  title?: string;
  sessionId?: string | null;
  summary?: string;
  steps?: Array<{ id: string; description: string }>;
}): Changeset {
  return {
    id: over.id,
    sessionId: over.sessionId ?? null,
    title: over.title ?? "Do the thing",
    description: null,
    status: "planning",
    plan: {
      summary: over.summary ?? "Summary.",
      steps: (over.steps ?? [{ id: "step_0", description: "First step" }]).map(
        (s) => ({ ...s, status: "pending" as const }),
      ),
    },
    planMessageIds: [],
    approvalMessageId: null,
    workMessageIds: [],
    toolCalls: null,
    reasoning: null,
    tokenUsage: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    completedAt: null,
    creatorUserId: null,
  };
}

Deno.test("renderChangesetPlanDocument is deterministic markdown of title + summary + steps", () => {
  const cs = fakePlanChangeset({
    id: "cs_r",
    title: "Implement tiers",
    summary: "Wire the three tiers.",
    steps: [
      { id: "step_0", description: "Add schema" },
      { id: "step_1", description: "Add store" },
    ],
  });
  const md = renderChangesetPlanDocument(cs);
  assertEquals(
    md,
    "# Implement tiers\n\nWire the three tiers.\n\n## Steps\n\n1. Add schema\n2. Add store\n",
  );
  // Deterministic: same plan renders byte-identical (→ content-addressed dedupe).
  assertEquals(renderChangesetPlanDocument(cs), md);
});

Deno.test("captureChangesetPlanDocument persists a plan doc + one changeset/plan ref; re-plan moves head, ref follows", async () => {
  const db = await Database.create({ driver: "pglite" });
  const kernel = new Kernel(db, { composition: testStoreComposition() });
  const projectDir = mkdtempSync(join(tmpdir(), "genie-chat-plan-"));
  kernel.projectDir = projectDir;
  try {
    const cs = fakePlanChangeset({
      id: "cs_1",
      title: "Implement tiers",
      sessionId: "sess_p",
      summary: "Wire the three tiers.",
      steps: [
        { id: "step_0", description: "Add schema" },
        { id: "step_1", description: "Add store" },
      ],
    });

    const first = await captureChangesetPlanDocument(kernel.documents, cs);
    assert(first.ok);

    // Exactly one changeset/plan ref, at the head, citing an agent-created plan doc.
    let refs = await kernel.documents.listRefsByTarget(
      "changeset",
      "cs_1",
      "plan",
    );
    assertEquals(refs.length, 1);
    const docId = refs[0]!.documentId;
    const doc1 = await kernel.documents.read(docId);
    assert(doc1.ok);
    const v1 = doc1.data.document.currentVersionHash;
    assertEquals(doc1.data.document.createdBy, "agent");
    assertEquals(doc1.data.document.metadata.source, PLAN_DOCUMENT_SOURCE);
    assertEquals(doc1.data.document.scope, "session");
    assertEquals(doc1.data.document.sessionId, "sess_p");
    assertEquals(refs[0]!.versionHash, v1);
    assertEquals(refs[0]!.sessionId, "sess_p");

    // The rendered markdown carries the title, summary, and steps.
    const content1 = await kernel.documents.readContent(docId);
    assert(content1.ok);
    assert(content1.data.content.includes("# Implement tiers"));
    assert(content1.data.content.includes("Wire the three tiers."));
    assert(content1.data.content.includes("Add schema"));

    // RE-PLAN: same changeset, edited plan → SAME doc, new immutable version, head moves.
    const replanned = fakePlanChangeset({
      id: "cs_1",
      title: "Implement tiers",
      sessionId: "sess_p",
      summary: "Wire the three tiers, revised.",
      steps: [
        { id: "step_0", description: "Add schema" },
        { id: "step_1", description: "Add store" },
        { id: "step_2", description: "Add tools" },
      ],
    });
    const second = await captureChangesetPlanDocument(
      kernel.documents,
      replanned,
    );
    assert(second.ok);

    refs = await kernel.documents.listRefsByTarget("changeset", "cs_1", "plan");
    assertEquals(refs.length, 1, "no duplicate refs accumulate across re-plan");
    assertEquals(refs[0]!.documentId, docId, "the SAME plan doc is updated");
    const doc2 = await kernel.documents.read(docId);
    assert(doc2.ok);
    assertEquals(
      doc2.data.versions.length,
      2,
      "a new immutable version was minted",
    );
    const v2 = doc2.data.document.currentVersionHash;
    assert(v1 !== v2, "the head moved");
    assertEquals(
      refs[0]!.versionHash,
      v2,
      "the changeset/plan ref cites the NEW head",
    );
    const content2 = await kernel.documents.readContent(docId);
    assert(content2.ok);
    assert(content2.data.content.includes("Add tools"));

    // An unchanged re-plan is a content-addressed no-op: no new version, one ref at head.
    const third = await captureChangesetPlanDocument(
      kernel.documents,
      replanned,
    );
    assert(third.ok);
    const doc3 = await kernel.documents.read(docId);
    assert(doc3.ok);
    assertEquals(
      doc3.data.versions.length,
      2,
      "identical bytes dedupe — no new version",
    );
    refs = await kernel.documents.listRefsByTarget("changeset", "cs_1", "plan");
    assertEquals(refs.length, 1);
    assertEquals(refs[0]!.versionHash, v2);
  } finally {
    await db.close();
    rmSync(projectDir, { recursive: true, force: true });
  }
});

Deno.test("captureChangesetPlanDocument is idempotent per changeset even if the ref is lost (no duplicate doc)", async () => {
  const db = await Database.create({ driver: "pglite" });
  const kernel = new Kernel(db, { composition: testStoreComposition() });
  const projectDir = mkdtempSync(join(tmpdir(), "genie-chat-plan-heal-"));
  kernel.projectDir = projectDir;
  try {
    const cs = fakePlanChangeset({
      id: "cs_h",
      title: "Heal",
      sessionId: "sess_h",
      summary: "First cut.",
    });
    const first = await captureChangesetPlanDocument(kernel.documents, cs);
    assert(first.ok);
    const docId = (await kernel.documents.listRefsByTarget(
      "changeset",
      "cs_h",
      "plan",
    ))[0]!.documentId;

    // Simulate a failed ref write after the doc was created: drop the plan ref, so
    // the changeset now has a doc but no backlink pointing at it.
    await db.drizzle.delete(genieDocumentRefsTable).where(and(
      eq(genieDocumentRefsTable.refType, "changeset"),
      eq(genieDocumentRefsTable.refId, "cs_h"),
      eq(genieDocumentRefsTable.role, "plan"),
    ));
    assertEquals(
      await kernel.documents.listRefsByTarget("changeset", "cs_h", "plan"),
      [],
    );

    // Re-plan: the doc is rediscovered by ORIGIN (not by the missing ref), UPDATED in
    // place, and the ref is restored — no second plan doc is minted.
    const replanned = fakePlanChangeset({
      id: "cs_h",
      title: "Heal",
      sessionId: "sess_h",
      summary: "Second cut, revised.",
    });
    const second = await captureChangesetPlanDocument(
      kernel.documents,
      replanned,
    );
    assert(second.ok);

    const docs = await kernel.documents.list({ sessionId: "sess_h" });
    assert(docs.ok);
    const planDocs = docs.data.filter((d) =>
      d.metadata.source === PLAN_DOCUMENT_SOURCE &&
      d.metadata.sourceId === "cs_h"
    );
    assertEquals(planDocs.length, 1, "no duplicate plan doc after a lost ref");
    assertEquals(
      planDocs[0]!.id,
      docId,
      "the original doc was updated in place",
    );

    const refs = await kernel.documents.listRefsByTarget(
      "changeset",
      "cs_h",
      "plan",
    );
    assertEquals(
      refs.length,
      1,
      "the single plan ref is restored on re-capture",
    );
    assertEquals(refs[0]!.documentId, docId);
    assertEquals(refs[0]!.versionHash, planDocs[0]!.currentVersionHash);
  } finally {
    await db.close();
    rmSync(projectDir, { recursive: true, force: true });
  }
});

Deno.test("captureChangesetPlanDocument degrades without a project (no throw, no ref)", async () => {
  const db = await Database.create({ driver: "pglite" });
  const kernel = new Kernel(db, { composition: testStoreComposition() });
  // No kernel.projectDir → a session-scoped create() returns PROJECT_REQUIRED.
  try {
    const cs = fakePlanChangeset({ id: "cs_np", sessionId: "sess_np" });
    const res = await captureChangesetPlanDocument(kernel.documents, cs);
    assert(!res.ok, "capture surfaces the store error instead of throwing");
    assertEquals(res.error.code, "PROJECT_REQUIRED");
    assertEquals(
      await kernel.documents.listRefsByTarget("changeset", "cs_np", "plan"),
      [],
    );
  } finally {
    await db.close();
  }
});

// --- Slice C-rich SECONDARY (plan §8/§11): screenshot PNG blobs captured as versioned
// image/png agent documents + one ledger/evidence ref each, at the open agent-loop `_images`
// seam. The raw bytes are stored VERBATIM (content-addressing dedupes identical shots). ---

// A PNG signature + a few bytes stands in for a real screenshot blob — the store keeps bytes
// verbatim, so any Uint8Array round-trips; the signature just makes the fixture recognisable.
function fakePngBytes(tag: number): Uint8Array {
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, tag]);
}

Deno.test("captureScreenshotEvidenceDocument persists an image/png doc that round-trips the exact PNG + one ledger/evidence ref", async () => {
  const db = await Database.create({ driver: "pglite" });
  const kernel = new Kernel(db, { composition: testStoreComposition() });
  const projectDir = mkdtempSync(join(tmpdir(), "genie-chat-shot-"));
  kernel.projectDir = projectDir;
  try {
    const png = fakePngBytes(1);
    const captured = await captureScreenshotEvidenceDocument(
      kernel.documents,
      "call_abc",
      0,
      png,
      "sess_s",
    );
    assert(captured.ok);
    assertEquals(captured.data.refType, "ledger");
    assertEquals(captured.data.role, "evidence");

    const key = screenshotEvidenceLedgerKey("call_abc", 0);
    assertEquals(captured.data.refId, key);

    const doc = await kernel.documents.findBySource(
      SCREENSHOT_DOCUMENT_SOURCE,
      key,
      { sessionId: "sess_s" },
    );
    assert(doc, "screenshot document should exist by origin");
    assertEquals(doc.kind, "image/png");
    assertEquals(doc.createdBy, "agent");
    assertEquals(doc.scope, "session");
    assertEquals(doc.metadata.sourceId, key);
    assertEquals(captured.data.versionHash, doc.currentVersionHash);

    // The blob round-trips byte-exact (the whole point of C-rich — the real bytes).
    const bytes = await kernel.documents.readContentBytes(doc.id);
    assert(bytes.ok);
    assertEquals(bytes.data.bytes, png);

    const refs = await kernel.documents.listRefsByTarget(
      "ledger",
      key,
      "evidence",
    );
    assertEquals(refs.length, 1);
    assertEquals(refs[0]!.documentId, doc.id);
  } finally {
    await db.close();
    rmSync(projectDir, { recursive: true, force: true });
  }
});

Deno.test("captureScreenshotEvidenceDocument is idempotent per (tool call, image index); distinct images are distinct docs", async () => {
  const db = await Database.create({ driver: "pglite" });
  const kernel = new Kernel(db, { composition: testStoreComposition() });
  const projectDir = mkdtempSync(join(tmpdir(), "genie-chat-shot-idem-"));
  kernel.projectDir = projectDir;
  try {
    const png0 = fakePngBytes(0);
    const png1 = fakePngBytes(1);

    // Same tool call, two images → two distinct targets.
    const a = await captureScreenshotEvidenceDocument(
      kernel.documents,
      "call_multi",
      0,
      png0,
      "sess_s",
    );
    const b = await captureScreenshotEvidenceDocument(
      kernel.documents,
      "call_multi",
      1,
      png1,
      "sess_s",
    );
    // Re-dispatch of image 0 — clean no-op, not a second doc.
    const aAgain = await captureScreenshotEvidenceDocument(
      kernel.documents,
      "call_multi",
      0,
      png0,
      "sess_s",
    );
    assert(a.ok && b.ok && aAgain.ok);

    const key0 = screenshotEvidenceLedgerKey("call_multi", 0);
    const key1 = screenshotEvidenceLedgerKey("call_multi", 1);

    const doc0 = await kernel.documents.findBySource(
      SCREENSHOT_DOCUMENT_SOURCE,
      key0,
      { sessionId: "sess_s" },
    );
    const doc1 = await kernel.documents.findBySource(
      SCREENSHOT_DOCUMENT_SOURCE,
      key1,
      { sessionId: "sess_s" },
    );
    assert(doc0 && doc1);
    assert(doc0.id !== doc1.id, "two images are distinct documents");

    assertEquals(
      (await kernel.documents.listRefsByTarget("ledger", key0, "evidence"))
        .length,
      1,
    );
    assertEquals(
      (await kernel.documents.listRefsByTarget("ledger", key1, "evidence"))
        .length,
      1,
    );
  } finally {
    await db.close();
    rmSync(projectDir, { recursive: true, force: true });
  }
});

Deno.test("captureScreenshotEvidenceDocument degrades without a project (no throw, no doc, no ref)", async () => {
  const db = await Database.create({ driver: "pglite" });
  const kernel = new Kernel(db, { composition: testStoreComposition() });
  // No kernel.projectDir → a session-scoped create() returns PROJECT_REQUIRED.
  try {
    const res = await captureScreenshotEvidenceDocument(
      kernel.documents,
      "call_np",
      0,
      fakePngBytes(9),
      "sess_np",
    );
    assert(!res.ok, "capture surfaces the store error instead of throwing");
    assertEquals(res.error.code, "PROJECT_REQUIRED");
    const key = screenshotEvidenceLedgerKey("call_np", 0);
    assertEquals(
      await kernel.documents.listRefsByTarget("ledger", key, "evidence"),
      [],
    );
  } finally {
    await db.close();
  }
});

// --- Tool dispatch captures them for every client ---

Deno.test("dispatch captures the plan of a created changeset and a result's screenshots", async () => {
  const db = await Database.create({ driver: "pglite" });
  const kernel = new Kernel(db, { composition: testComposition() });
  const projectDir = mkdtempSync(join(tmpdir(), "genie-capture-"));
  kernel.projectDir = projectDir;
  try {
    const session = await kernel.sessions.createSession("capture");
    const created = await dispatchTool(
      "create_changeset",
      {
        title: "Add a page",
        plan: {
          summary: "Add it.",
          steps: [{ id: "s1", description: "Add the page" }],
          acceptanceCriteria: [{
            id: "claim_0",
            text: "The page loads.",
            source: "agent",
            priority: "must",
          }],
          verificationPlan: [{
            id: "v1",
            claimIds: ["claim_0"],
            kind: "unit",
            description: "Load it.",
          }],
        },
      },
      kernel,
      () => {},
      { sessionId: session.id },
    );
    assert(created.ok, JSON.stringify(created));
    const changesetId = (created.data as { id: string }).id;
    const refs = await kernel.documents.listRefsByTarget(
      "changeset",
      changesetId,
      "plan",
    );
    assertEquals(refs.length, 1);

    // A result carrying images, as screenshot_app returns, with no tool call
    // id: an MCP client sends none, so the server mints the key.
    await captureResultDocuments(
      kernel,
      "screenshot_app",
      { ok: true, data: {}, _images: [{ png: fakePngBytes(3) }] },
      { sessionId: session.id },
    );
    const shots = await kernel.documents.list({});
    assert(shots.ok);
    assertEquals(
      shots.data.filter((d) =>
        d.metadata?.source === SCREENSHOT_DOCUMENT_SOURCE
      )
        .length,
      1,
    );
  } finally {
    await db.close();
    rmSync(projectDir, { recursive: true, force: true });
  }
});
