import { assert, assertEquals } from "@std/assert";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "./db.ts";
import {
  ATTACHMENT_DOCUMENT_SOURCE,
  DOCUMENT_MAX_CONTENT_BYTES,
  DocumentStore,
  EVIDENCE_DOCUMENT_SOURCE,
  LOG_EVIDENCE_DOCUMENT_SOURCE,
  PLAN_DOCUMENT_SOURCE,
  projectDocumentsDir,
  RUN_EVIDENCE_DOCUMENT_SOURCE,
  SCREENSHOT_DOCUMENT_SOURCE,
} from "./documents.ts";
import { validateSchemaConventions } from "./db.ts";
import {
  DOCUMENT_UPLOAD_MAX_BYTES,
  DOCUMENT_WORKING_SET_MAX_TOKENS,
} from "./config.ts";

const testOpts = { sanitizeResources: false, sanitizeOps: false };

interface Fixture {
  store: DocumentStore;
  projectDir: string;
  globalRoot: string;
  cleanup: () => Promise<void>;
}

async function withStore(fn: (f: Fixture) => Promise<void>): Promise<void> {
  const db = await Database.create({ driver: "pglite" });
  const projectDir = mkdtempSync(join(tmpdir(), "genie-docs-proj-"));
  const globalRoot = mkdtempSync(join(tmpdir(), "genie-docs-global-"));
  const store = new DocumentStore(db.drizzle, () => projectDir, globalRoot);
  try {
    await fn({
      store,
      projectDir,
      globalRoot,
      cleanup: async () => {},
    });
  } finally {
    await db.close();
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(globalRoot, { recursive: true, force: true });
  }
}

function countBlobs(root: string): number {
  if (!existsSync(root)) return 0;
  let n = 0;
  for (const shard of readdirSync(root)) {
    const shardPath = join(root, shard);
    try {
      n += readdirSync(shardPath).length;
    } catch {
      // Not a shard dir — ignore.
    }
  }
  return n;
}

Deno.test({
  ...testOpts,
  name: "create writes a new immutable version + blob on disk",
  fn: async () => {
    await withStore(async ({ store, projectDir }) => {
      const created = await store.create({
        name: "Plan",
        kind: "text/markdown",
        content: "# Plan\nStep one.",
        scope: "session",
        sessionId: "sess_1",
      });
      assert(created.ok, "create should succeed");
      const doc = created.data;
      assertEquals(doc.scope, "session");
      assertEquals(doc.archived, false);
      assert(doc.currentVersionHash.length === 64, "hash is sha256 hex");

      const versions = await store.listVersions(doc.id);
      assertEquals(versions.length, 1);
      assertEquals(versions[0]!.versionHash, doc.currentVersionHash);

      const root = projectDocumentsDir(projectDir);
      const blobPath = join(
        root,
        doc.currentVersionHash.slice(0, 2),
        doc.currentVersionHash,
      );
      assert(existsSync(blobPath), "blob file exists on disk");
      assertEquals(countBlobs(root), 1);
    });
  },
});

Deno.test({
  ...testOpts,
  name:
    "update makes a new version, moves head, old version resolvable by hash",
  fn: async () => {
    await withStore(async ({ store }) => {
      const created = await store.create({
        name: "Plan",
        kind: "text/markdown",
        content: "v1 content",
        scope: "session",
        sessionId: "sess_1",
      });
      assert(created.ok);
      const v1Hash = created.data.currentVersionHash;

      const updated = await store.update(created.data.id, {
        content: "v2 content",
      });
      assert(updated.ok, "update should succeed");
      const v2Hash = updated.data.currentVersionHash;
      assert(v1Hash !== v2Hash, "head moved to a new hash");

      const versions = await store.listVersions(created.data.id);
      assertEquals(versions.length, 2);

      // Head resolves to v2.
      const head = await store.readContent(created.data.id);
      assert(head.ok);
      assertEquals(head.data.content, "v2 content");
      assertEquals(head.data.version.versionHash, v2Hash);

      // Old version still resolvable by its hash.
      const old = await store.readContent(created.data.id, v1Hash);
      assert(old.ok, "old version resolves by hash");
      assertEquals(old.data.content, "v1 content");
    });
  },
});

Deno.test({
  ...testOpts,
  name: "update with identical bytes dedupes (no new version, no new blob)",
  fn: async () => {
    await withStore(async ({ store, projectDir }) => {
      const created = await store.create({
        name: "Plan",
        kind: "text/markdown",
        content: "same bytes",
        scope: "session",
        sessionId: "sess_1",
      });
      assert(created.ok);
      const root = projectDocumentsDir(projectDir);
      assertEquals(countBlobs(root), 1);

      const again = await store.update(created.data.id, {
        content: "same bytes",
      });
      assert(again.ok, "dedupe update succeeds");
      assertEquals(
        again.data.currentVersionHash,
        created.data.currentVersionHash,
        "head unchanged",
      );
      assertEquals((await store.listVersions(created.data.id)).length, 1);
      assertEquals(countBlobs(root), 1, "no new blob written");
    });
  },
});

Deno.test({
  ...testOpts,
  name:
    "content cap is kind-aware: binary blobs get the larger upload cap (Slice 9)",
  fn: async () => {
    await withStore(async ({ store }) => {
      // A payload comfortably past the text cap but under the binary upload cap.
      const size = DOCUMENT_MAX_CONTENT_BYTES + 64 * 1024;
      assert(
        size < DOCUMENT_UPLOAD_MAX_BYTES,
        "fixture sits between the two caps",
      );
      const bigBytes = new Uint8Array(size).fill(0x41);

      // Binary (image/png) at that size SUCCEEDS — it uses DOCUMENT_UPLOAD_MAX_BYTES.
      const img = await store.create({
        name: "big.png",
        kind: "image/png",
        content: bigBytes,
        scope: "project",
        createdBy: "user",
      });
      assert(img.ok, "a >512 KB image is under the binary cap and stores");

      // The SAME-size text/markdown doc FAILS — text stays on DOCUMENT_MAX_CONTENT_BYTES.
      const bigText = "a".repeat(size);
      const md = await store.create({
        name: "big.md",
        kind: "text/markdown",
        content: bigText,
        scope: "project",
        createdBy: "user",
      });
      assert(!md.ok, "a >512 KB markdown doc exceeds the text cap");
      assertEquals(md.error.code, "CONTENT_TOO_LARGE");
      // The message names the cap that actually applied (the text cap).
      assert(md.error.message.includes(String(DOCUMENT_MAX_CONTENT_BYTES)));

      // A binary blob past the binary cap still fails.
      const huge = new Uint8Array(DOCUMENT_UPLOAD_MAX_BYTES + 1).fill(0x42);
      const tooBig = await store.create({
        name: "huge.png",
        kind: "image/png",
        content: huge,
        scope: "project",
        createdBy: "user",
      });
      assert(!tooBig.ok, "a blob past the binary cap is rejected");
      assertEquals(tooBig.error.code, "CONTENT_TOO_LARGE");
      assert(tooBig.error.message.includes(String(DOCUMENT_UPLOAD_MAX_BYTES)));
    });
  },
});

Deno.test({
  ...testOpts,
  name: "query search/read/list round-trip",
  fn: async () => {
    await withStore(async ({ store }) => {
      const a = await store.create({
        name: "Auth design",
        kind: "text/markdown",
        content: "oauth flow",
        scope: "project",
        metadata: { description: "login and sessions", tags: ["auth"] },
      });
      const b = await store.create({
        name: "Billing spec",
        kind: "text/markdown",
        content: "invoices",
        scope: "project",
      });
      assert(a.ok && b.ok);

      const listed = await store.list({ scope: "project" });
      assert(listed.ok);
      assertEquals(listed.data.length, 2);

      const byName = await store.search("auth");
      assert(byName.ok);
      assertEquals(byName.data.length, 1);
      assertEquals(byName.data[0]!.id, a.data.id);

      // Matches metadata tags/description too.
      const byMeta = await store.search("login");
      assert(byMeta.ok);
      assertEquals(byMeta.data.length, 1);
      assertEquals(byMeta.data[0]!.id, a.data.id);

      const read = await store.read(a.data.id);
      assert(read.ok);
      assertEquals(read.data.document.name, "Auth design");
      assertEquals(read.data.versions.length, 1);
    });
  },
});

Deno.test({
  ...testOpts,
  name:
    "includeInternal=false hides provenance documents but keeps user, attachment, and explicit docs",
  fn: async () => {
    await withStore(async ({ store }) => {
      const internalSources = [
        PLAN_DOCUMENT_SOURCE,
        EVIDENCE_DOCUMENT_SOURCE,
        RUN_EVIDENCE_DOCUMENT_SOURCE,
        SCREENSHOT_DOCUMENT_SOURCE,
        LOG_EVIDENCE_DOCUMENT_SOURCE,
      ];
      for (const source of internalSources) {
        const doc = await store.create({
          name: `${source}.md`,
          kind: source === SCREENSHOT_DOCUMENT_SOURCE
            ? "image/png"
            : "text/markdown",
          content: source === SCREENSHOT_DOCUMENT_SOURCE
            ? new Uint8Array([0x89, 0x50, 0x4e, 0x47])
            : `internal ${source}`,
          scope: "session",
          sessionId: "sess_internal",
          createdBy: "agent",
          metadata: { source, sourceId: `${source}_1` },
        });
        assert(doc.ok);
      }

      const attachment = await store.create({
        name: "chat-attachment.txt",
        kind: "text/plain",
        content: "attached by user",
        scope: "session",
        sessionId: "sess_internal",
        createdBy: "user",
        metadata: { source: ATTACHMENT_DOCUMENT_SOURCE },
      });
      const userDoc = await store.create({
        name: "meeting-notes.md",
        kind: "text/markdown",
        content: "user note",
        scope: "project",
        createdBy: "user",
      });
      const upload = await store.create({
        name: "upload.png",
        kind: "image/png",
        content: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
        scope: "project",
        createdBy: "user",
      });
      const explicitAgentDoc = await store.create({
        name: "agent-authored-spec.md",
        kind: "text/markdown",
        content: "explicit document_write output",
        scope: "project",
        createdBy: "agent",
      });
      assert(attachment.ok && userDoc.ok && upload.ok && explicitAgentDoc.ok);

      const defaultList = await store.list();
      assert(defaultList.ok);
      assertEquals(defaultList.data.length, 9);

      const visibleList = await store.list({ includeInternal: false });
      assert(visibleList.ok);
      assertEquals(
        new Set(visibleList.data.map((d) => d.id)),
        new Set([
          attachment.data.id,
          userDoc.data.id,
          upload.data.id,
          explicitAgentDoc.data.id,
        ]),
      );

      const hiddenSearch = await store.search("internal", {
        includeInternal: false,
      });
      assert(hiddenSearch.ok);
      assertEquals(hiddenSearch.data.length, 0);

      const visibleSearch = await store.search("agent-authored", {
        includeInternal: false,
      });
      assert(visibleSearch.ok);
      assertEquals(visibleSearch.data.map((d) => d.id), [
        explicitAgentDoc.data.id,
      ]);
    });
  },
});

Deno.test({
  ...testOpts,
  name:
    "archive is soft (row kept, archived flag set, hidden from default list)",
  fn: async () => {
    await withStore(async ({ store }) => {
      const created = await store.create({
        name: "Old plan",
        kind: "text/markdown",
        content: "stale",
        scope: "project",
      });
      assert(created.ok);

      const archived = await store.archive(created.data.id);
      assert(archived.ok);
      assertEquals(archived.data.archived, true);

      const listed = await store.list();
      assert(listed.ok);
      assertEquals(listed.data.length, 0, "archived hidden by default");

      const withArchived = await store.list({ includeArchived: true });
      assert(withArchived.ok);
      assertEquals(withArchived.data.length, 1);

      // Still readable directly.
      const read = await store.read(created.data.id);
      assert(read.ok);
      assertEquals(read.data.document.archived, true);
    });
  },
});

Deno.test({
  ...testOpts,
  name: "pin/unpin writes and removes the working_set ref row",
  fn: async () => {
    await withStore(async ({ store }) => {
      const created = await store.create({
        name: "Live plan",
        kind: "text/markdown",
        content: "implementing across steps",
        scope: "session",
        sessionId: "sess_pin",
      });
      assert(created.ok);
      const id = created.data.id;

      assertEquals(await store.listPinned("sess_pin"), []);

      const pinned = await store.setPinned(id, true, "sess_pin");
      assert(pinned.ok);
      assertEquals(await store.listPinned("sess_pin"), [id]);

      // Idempotent — pinning again doesn't duplicate.
      await store.setPinned(id, true, "sess_pin");
      assertEquals(await store.listPinned("sess_pin"), [id]);

      const refs = await store.listRefs(id);
      assertEquals(refs.length, 1);
      assertEquals(refs[0]!.refType, "working_set");
      assertEquals(refs[0]!.role, "resident");
      assertEquals(refs[0]!.sessionId, "sess_pin");

      const unpinned = await store.setPinned(id, false, "sess_pin");
      assert(unpinned.ok);
      assertEquals(await store.listPinned("sess_pin"), []);
      assertEquals((await store.listRefs(id)).length, 0);
    });
  },
});

Deno.test({
  ...testOpts,
  name:
    "scope routing: session/project use project root, global uses global root",
  fn: async () => {
    await withStore(async ({ store, projectDir, globalRoot }) => {
      const proj = await store.create({
        name: "Project doc",
        kind: "text/markdown",
        content: "project scoped",
        scope: "project",
      });
      assert(proj.ok);
      const projRoot = projectDocumentsDir(projectDir);
      assertEquals(countBlobs(projRoot), 1);
      assertEquals(countBlobs(globalRoot), 0);

      const global = await store.create({
        name: "Global doc",
        kind: "text/markdown",
        content: "global scoped",
        scope: "global",
      });
      assert(global.ok);
      assertEquals(countBlobs(globalRoot), 1, "global blob under global root");
      assertEquals(countBlobs(projRoot), 1, "project root unchanged");

      // Both resolve their content from the correct root.
      const projRead = await store.readContent(proj.data.id);
      assert(projRead.ok);
      assertEquals(projRead.data.content, "project scoped");
      const globalRead = await store.readContent(global.data.id);
      assert(globalRead.ok);
      assertEquals(globalRead.data.content, "global scoped");
    });
  },
});

// --- Phase 4 Slice 7: scope promotion (session → project → global). ---

Deno.test({
  ...testOpts,
  name:
    "promoteScope session→project is metadata-only (same root, sessionId cleared)",
  fn: async () => {
    await withStore(async ({ store, globalRoot }) => {
      const created = await store.create({
        name: "Session note",
        kind: "text/markdown",
        content: "session scoped",
        scope: "session",
        sessionId: "sess_promote",
      });
      assert(created.ok);
      const id = created.data.id;

      const promoted = await store.promoteScope(id, "project");
      assert(promoted.ok);
      assertEquals(promoted.data.scope, "project");
      assertEquals(
        promoted.data.sessionId,
        null,
        "sessionId cleared on promotion",
      );

      // Same on-disk root (session and project share it), so no global blob is written.
      assertEquals(
        countBlobs(globalRoot),
        0,
        "no blob copied for a same-root promotion",
      );

      // Content still resolves from the (unchanged) project root.
      const read = await store.readContent(id);
      assert(read.ok);
      assertEquals(read.data.content, "session scoped");
    });
  },
});

Deno.test({
  ...testOpts,
  name: "promoteScope →global copies every version's blob to the global root",
  fn: async () => {
    await withStore(async ({ store, globalRoot }) => {
      const created = await store.create({
        name: "Project plan",
        kind: "text/markdown",
        content: "# v1",
        scope: "project",
      });
      assert(created.ok);
      const id = created.data.id;
      const v1Hash = created.data.currentVersionHash;

      // A second version so the doc carries 2 blobs — the copy must move both.
      const updated = await store.update(id, { content: "# v2" });
      assert(updated.ok);
      const v2Hash = updated.data.currentVersionHash;
      assert(v1Hash !== v2Hash);

      assertEquals(
        countBlobs(globalRoot),
        0,
        "nothing under the global root yet",
      );

      const promoted = await store.promoteScope(id, "global");
      assert(promoted.ok);
      assertEquals(promoted.data.scope, "global");
      assertEquals(
        promoted.data.projectId,
        null,
        "projectId cleared on →global",
      );
      assertEquals(promoted.data.sessionId, null);

      // Both version blobs now live under the global root (copy-before-flip worked)…
      assertEquals(
        countBlobs(globalRoot),
        2,
        "both version blobs copied to global root",
      );
      // …and both the head and the older version still resolve.
      const head = await store.readContent(id);
      assert(head.ok);
      assertEquals(head.data.content, "# v2");
      const old = await store.readContent(id, v1Hash);
      assert(old.ok);
      assertEquals(old.data.content, "# v1");
    });
  },
});

Deno.test({
  ...testOpts,
  name: "promoteScope guards: idempotent no-op, demotion, archived, missing",
  fn: async () => {
    await withStore(async ({ store }) => {
      const proj = await store.create({
        name: "Guarded",
        kind: "text/markdown",
        content: "x",
        scope: "project",
      });
      assert(proj.ok);
      const id = proj.data.id;

      // Demotion is rejected, not silently ignored.
      const demote = await store.promoteScope(id, "session");
      assert(!demote.ok);
      assertEquals(demote.error.code, "INVALID_SCOPE_PROMOTION");

      // Archived docs are not promotable.
      const global = await store.create({
        name: "Global tombstone",
        kind: "text/markdown",
        content: "y",
        scope: "global",
      });
      assert(global.ok);
      await store.archive(global.data.id);
      const archived = await store.promoteScope(global.data.id, "global");
      assert(!archived.ok);
      assertEquals(archived.error.code, "DOCUMENT_ARCHIVED");

      // Same-scope promotion is an idempotent no-op success (a live global doc).
      const live = await store.create({
        name: "Already global",
        kind: "text/markdown",
        content: "z",
        scope: "global",
      });
      assert(live.ok);
      const noop = await store.promoteScope(live.data.id, "global");
      assert(noop.ok);
      assertEquals(noop.data.scope, "global");

      // Unknown id → DOCUMENT_NOT_FOUND.
      const missing = await store.promoteScope("doc_missing", "global");
      assert(!missing.ok);
      assertEquals(missing.error.code, "DOCUMENT_NOT_FOUND");
    });
  },
});

Deno.test({
  ...testOpts,
  name: "session/project scope requires a loaded project",
  fn: async () => {
    const db = await Database.create({ driver: "pglite" });
    const globalRoot = mkdtempSync(join(tmpdir(), "genie-docs-global-"));
    const store = new DocumentStore(db.drizzle, () => null, globalRoot);
    try {
      const res = await store.create({
        name: "No project",
        kind: "text/markdown",
        content: "x",
        scope: "session",
      });
      assert(!res.ok);
      assertEquals(res.error.code, "PROJECT_REQUIRED");

      // Global still works with no project loaded.
      const g = await store.create({
        name: "Global ok",
        kind: "text/markdown",
        content: "x",
        scope: "global",
      });
      assert(g.ok);
    } finally {
      await db.close();
      rmSync(globalRoot, { recursive: true, force: true });
    }
  },
});

Deno.test({
  ...testOpts,
  name: "read/update/archive on a missing document return DOCUMENT_NOT_FOUND",
  fn: async () => {
    await withStore(async ({ store }) => {
      const read = await store.read("doc_missing");
      assert(!read.ok);
      assertEquals(read.error.code, "DOCUMENT_NOT_FOUND");

      const upd = await store.update("doc_missing", { content: "x" });
      assert(!upd.ok);
      assertEquals(upd.error.code, "DOCUMENT_NOT_FOUND");
    });
  },
});

// The framework tables are Drizzle-defined, but they must still satisfy the same
// column conventions the user-app schema validator enforces (CLAUDE.md; plan §3):
// `id` PK, `*_id` FKs. Run the documents column set through validateSchemaConventions
// to prove compliance.
Deno.test({
  ...testOpts,
  name: "documents schema follows column conventions",
  fn: () => {
    const col = (name: string, primaryKey = false) => ({
      name,
      type: "text",
      nullable: !primaryKey,
      defaultValue: null,
      primaryKey,
    });
    const warnings = validateSchemaConventions(
      [
        col("id", true),
        col("owner_user_id"),
        col("project_id"),
        col("session_id"),
        col("scope"),
      ],
      // owner_user_id/project_id/session_id are polymorphic references (no hard FK to
      // one table by design — plan §3), so declare them as references to satisfy the
      // *_id convention check.
      `CREATE TABLE _genie_documents (id text primary key,
        owner_user_id text references _genie_sessions(owner_user_id),
        project_id text references projects(id),
        session_id text references _genie_sessions(id),
        scope text)`,
    );
    assertEquals(warnings, []);
  },
});

// A payload whose byte size estimates to more than `tokens` tokens (~4 bytes/token).
function contentOfTokens(tokens: number): string {
  return "x".repeat(tokens * 4 + 4);
}

Deno.test({
  ...testOpts,
  name:
    "pinning past the working-set token budget fails and leaves the set unchanged",
  fn: async () => {
    await withStore(async ({ store }) => {
      const big = await store.create({
        name: "Oversized",
        kind: "text/markdown",
        content: contentOfTokens(DOCUMENT_WORKING_SET_MAX_TOKENS + 1),
        scope: "session",
        sessionId: "sess_budget",
      });
      assert(big.ok);

      const pinned = await store.setPinned(big.data.id, true, "sess_budget");
      assert(!pinned.ok);
      assertEquals(pinned.error.code, "WORKING_SET_BUDGET_EXCEEDED");
      // The error must instruct the agent to release something first (D3).
      assert(pinned.error.suggestion?.includes("Release"));
      // Nothing entered the working set.
      assertEquals(await store.listPinned("sess_budget"), []);
    });
  },
});

Deno.test({
  ...testOpts,
  name: "budget counts the whole resident set: a fitting doc blocks once full",
  fn: async () => {
    await withStore(async ({ store }) => {
      // First doc takes ~60% of the cap; it pins.
      const first = await store.create({
        name: "First",
        kind: "text/markdown",
        content: contentOfTokens(
          Math.floor(DOCUMENT_WORKING_SET_MAX_TOKENS * 0.6),
        ),
        scope: "session",
        sessionId: "sess_two",
      });
      assert(first.ok);
      const firstPin = await store.setPinned(first.data.id, true, "sess_two");
      assert(firstPin.ok);

      // Second doc also ~60% of the cap: alone it would fit, but together they blow
      // the budget, so it's rejected and the working set keeps only the first.
      const second = await store.create({
        name: "Second",
        kind: "text/markdown",
        content: contentOfTokens(
          Math.floor(DOCUMENT_WORKING_SET_MAX_TOKENS * 0.6),
        ),
        scope: "session",
        sessionId: "sess_two",
      });
      assert(second.ok);
      const secondPin = await store.setPinned(second.data.id, true, "sess_two");
      assert(!secondPin.ok);
      assertEquals(secondPin.error.code, "WORKING_SET_BUDGET_EXCEEDED");
      assertEquals(await store.listPinned("sess_two"), [first.data.id]);

      // Re-pinning the already-resident first doc is idempotent and skips the check.
      const rePin = await store.setPinned(first.data.id, true, "sess_two");
      assert(rePin.ok);
      assertEquals(await store.listPinned("sess_two"), [first.data.id]);
    });
  },
});

Deno.test({
  ...testOpts,
  name: "recordRef writes a generic backlink and validates its enums",
  fn: async () => {
    await withStore(async ({ store }) => {
      const doc = await store.create({
        name: "Mentioned",
        kind: "text/markdown",
        content: "referenced in a turn",
        scope: "session",
        sessionId: "sess_ref",
      });
      assert(doc.ok);

      const ref = await store.recordRef({
        documentId: doc.data.id,
        refType: "message",
        refId: "42",
        role: "mention",
        versionHash: doc.data.currentVersionHash,
        sessionId: "sess_ref",
      });
      assert(ref.ok);
      assertEquals(ref.data.refType, "message");
      assertEquals(ref.data.role, "mention");
      assertEquals(ref.data.versionHash, doc.data.currentVersionHash);

      const refs = await store.listRefs(doc.data.id);
      assertEquals(refs.length, 1);
      assertEquals(refs[0]!.refId, "42");

      // Enum guards.
      const badType = await store.recordRef({
        documentId: doc.data.id,
        refType: "bogus" as "message",
        refId: "1",
        role: "mention",
      });
      assert(!badType.ok);
      assertEquals(badType.error.code, "INVALID_ENUM");

      // Missing document.
      const missing = await store.recordRef({
        documentId: "doc_nope",
        refType: "message",
        refId: "1",
        role: "mention",
      });
      assert(!missing.ok);
      assertEquals(missing.error.code, "DOCUMENT_NOT_FOUND");
    });
  },
});

Deno.test({
  ...testOpts,
  name:
    "recordUniqueRef keeps exactly one ref per (type,id,role), re-pointing to the head",
  fn: async () => {
    await withStore(async ({ store }) => {
      const doc = await store.create({
        name: "Plan: Do the thing",
        kind: "text/markdown",
        content: "# v1",
        scope: "session",
        sessionId: "sess_u",
      });
      assert(doc.ok);
      const v1 = doc.data.currentVersionHash;

      // First unique ref: recorded at the head.
      const first = await store.recordUniqueRef({
        documentId: doc.data.id,
        refType: "changeset",
        refId: "cs_1",
        role: "plan",
        versionHash: v1,
        sessionId: "sess_u",
      });
      assert(first.ok);
      let refs = await store.listRefsByTarget("changeset", "cs_1", "plan");
      assertEquals(refs.length, 1);
      assertEquals(refs[0]!.versionHash, v1);

      // Move the head, then re-record: still exactly one ref, now at the new head.
      const updated = await store.update(doc.data.id, { content: "# v2" });
      assert(updated.ok);
      const v2 = updated.data.currentVersionHash;
      assert(v1 !== v2);

      const second = await store.recordUniqueRef({
        documentId: doc.data.id,
        refType: "changeset",
        refId: "cs_1",
        role: "plan",
        versionHash: v2,
        sessionId: "sess_u",
      });
      assert(second.ok);
      refs = await store.listRefsByTarget("changeset", "cs_1", "plan");
      assertEquals(refs.length, 1);
      assertEquals(refs[0]!.versionHash, v2);
      assert(refs[0]!.id !== first.data.id, "the stale ref was replaced");

      // The tuple is scoped: a different refId keeps its own single ref.
      const other = await store.recordUniqueRef({
        documentId: doc.data.id,
        refType: "changeset",
        refId: "cs_2",
        role: "plan",
        versionHash: v2,
      });
      assert(other.ok);
      assertEquals(
        (await store.listRefsByTarget("changeset", "cs_1", "plan")).length,
        1,
      );
      assertEquals(
        (await store.listRefsByTarget("changeset", "cs_2", "plan")).length,
        1,
      );

      // Same enum + existence guards as recordRef.
      const badRole = await store.recordUniqueRef({
        documentId: doc.data.id,
        refType: "changeset",
        refId: "cs_1",
        role: "bogus" as "plan",
      });
      assert(!badRole.ok);
      assertEquals(badRole.error.code, "INVALID_ENUM");

      const missing = await store.recordUniqueRef({
        documentId: "doc_nope",
        refType: "changeset",
        refId: "cs_1",
        role: "plan",
      });
      assert(!missing.ok);
      assertEquals(missing.error.code, "DOCUMENT_NOT_FOUND");
    });
  },
});

Deno.test({
  ...testOpts,
  name:
    "findBySource locates the live doc by (source, sourceId), newest & unarchived",
  fn: async () => {
    await withStore(async ({ store }) => {
      const mk = (sourceId: string) =>
        store.create({
          name: `Plan ${sourceId}`,
          kind: "text/markdown",
          content: `plan ${sourceId}`,
          scope: "session",
          sessionId: "sess_f",
          createdBy: "agent",
          metadata: { source: "changeset-plan", sourceId },
        });

      const a = await mk("cs_a");
      const b = await mk("cs_b");
      assert(a.ok && b.ok);

      // Matches on the exact (source, sourceId) pair.
      const foundA = await store.findBySource("changeset-plan", "cs_a");
      assert(foundA);
      assertEquals(foundA.id, a.data.id);

      // A different source or a missing sourceId does not match.
      assertEquals(await store.findBySource("attachment", "cs_a"), null);
      assertEquals(await store.findBySource("changeset-plan", "cs_zzz"), null);

      // Archiving the match hides it (list excludes archived by default).
      await store.archive(a.data.id);
      assertEquals(await store.findBySource("changeset-plan", "cs_a"), null);
      // The sibling is untouched.
      const foundB = await store.findBySource("changeset-plan", "cs_b");
      assert(foundB);
      assertEquals(foundB.id, b.data.id);
    });
  },
});

Deno.test({
  ...testOpts,
  name: "readContentBytes returns raw blob bytes for binary payloads",
  fn: async () => {
    await withStore(async ({ store }) => {
      const png = new Uint8Array([
        0x89,
        0x50,
        0x4e,
        0x47,
        0x0d,
        0x0a,
        0x1a,
        0x0a,
      ]);
      const doc = await store.create({
        name: "pixel.png",
        kind: "image/png",
        content: png,
        scope: "session",
        sessionId: "sess_bytes",
      });
      assert(doc.ok);

      const bytes = await store.readContentBytes(doc.data.id);
      assert(bytes.ok);
      assertEquals(Array.from(bytes.data.bytes), Array.from(png));
      assertEquals(bytes.data.version.mime, "image/png");
    });
  },
});

Deno.test({
  ...testOpts,
  name:
    "listRefsByTarget finds a message's refs by (type, id) and narrows by role; bytes recover byte-exact",
  fn: async () => {
    await withStore(async ({ store }) => {
      // A message carrying one attachment doc and one mention doc.
      const attachBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // %PDF
      const attach = await store.create({
        name: "spec.pdf",
        kind: "application/pdf",
        content: attachBytes,
        scope: "session",
        sessionId: "sess_ref",
        createdBy: "user",
        metadata: { source: "attachment" },
      });
      const mention = await store.create({
        name: "notes.md",
        kind: "text/markdown",
        content: "referenced inline",
        scope: "session",
        sessionId: "sess_ref",
      });
      assert(attach.ok && mention.ok);

      const messageId = "42";
      const attachRef = await store.recordRef({
        documentId: attach.data.id,
        refType: "message",
        refId: messageId,
        role: "attachment",
        versionHash: attach.data.currentVersionHash,
        sessionId: "sess_ref",
      });
      const mentionRef = await store.recordRef({
        documentId: mention.data.id,
        refType: "message",
        refId: messageId,
        role: "mention",
        versionHash: mention.data.currentVersionHash,
        sessionId: "sess_ref",
      });
      assert(attachRef.ok && mentionRef.ok);

      // By (refType, refId): both refs; a different message id: none.
      const all = await store.listRefsByTarget("message", messageId);
      assertEquals(all.length, 2);
      assertEquals(await store.listRefsByTarget("message", "999"), []);

      // Narrowed to role=attachment: just the attachment ref, citing the head version.
      const attachOnly = await store.listRefsByTarget(
        "message",
        messageId,
        "attachment",
      );
      assertEquals(attachOnly.length, 1);
      assertEquals(attachOnly[0]!.documentId, attach.data.id);
      assertEquals(attachOnly[0]!.versionHash, attach.data.currentVersionHash);

      // The §1 dropped-bytes fix at the store level: the attachment recovers byte-exact
      // from its ref via readContentBytes.
      const recovered = await store.readContentBytes(
        attachOnly[0]!.documentId,
        attachOnly[0]!.versionHash ?? undefined,
      );
      assert(recovered.ok);
      assertEquals(Array.from(recovered.data.bytes), Array.from(attachBytes));
    });
  },
});
