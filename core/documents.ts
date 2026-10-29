import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { and, desc, eq } from "drizzle-orm";
import type { DrizzleDb } from "./db/factory.ts";
import {
  type DocumentMetadata,
  genieDocumentRefsTable,
  genieDocumentsTable,
  genieDocumentVersionsTable,
} from "./db/schema/index.ts";
import type { Result } from "./types.ts";
import { createTimestampedId } from "./ids.ts";
import {
  DOCUMENT_BLOB_FILE_MODE,
  DOCUMENT_ID_PREFIX,
  DOCUMENT_REF_ID_PREFIX,
  DOCUMENT_STORAGE_DIRNAME,
  DOCUMENT_UPLOAD_MAX_BYTES,
  DOCUMENT_WORKING_SET_MAX_TOKENS,
  estimateTokensFromBytes,
  getTideDir,
} from "./config.ts";
import { getProjectPaths } from "./project-manager.ts";
import { blobHash, writeBlobIfMissing as writeBlob } from "./blob-store.ts";
// Reuse the codebase index's byte cap rather than forking a parallel `512 * 1024`
// constant — the two file subsystems share conventions (plan §4/§13).
import { DEFAULT_MAX_FILE_BYTES } from "./codebase/source-index.ts";

export type { DocumentMetadata };

// --- Domain enums (plan §3). Kept here, co-located with the store, as the single
// source of the string literals the schema columns and dispatch validate against. ---

export const DOCUMENT_SCOPES = ["session", "project", "global"] as const;
export type DocumentScope = (typeof DOCUMENT_SCOPES)[number];

// Scope visibility ladder (plan §9 — "promote scope"). Promotion is one-way UP:
// session (narrowest) → project → global (widest). The rank orders the ladder so
// promoteScope can reject a demotion and treat same-rank as an idempotent no-op.
const SCOPE_RANK: Record<DocumentScope, number> = {
  session: 0,
  project: 1,
  global: 2,
};

export const DOCUMENT_CREATORS = ["user", "agent"] as const;
export type DocumentCreator = (typeof DOCUMENT_CREATORS)[number];

export const DOCUMENT_REF_TYPES = [
  "message",
  "changeset",
  "ledger",
  "log",
  "working_set",
] as const;
export type DocumentRefType = (typeof DOCUMENT_REF_TYPES)[number];

export const DOCUMENT_REF_ROLES = [
  "mention",
  "attachment",
  "plan",
  "evidence",
  "resident",
] as const;
export type DocumentRefRole = (typeof DOCUMENT_REF_ROLES)[number];

// metadata.source tag stamped on documents minted from a chat message's attachment
// (Phase 3 Slice A, plan §8/§10) — distinguishes attachment-backed docs from
// agent-authored plans and user uploads without a schema change.
export const ATTACHMENT_DOCUMENT_SOURCE = "attachment";

// metadata.source tag + kind for the document minted from a changeset's plan (Phase 3
// Slice B, plan §8 / D4, minimal). The plan is rendered as markdown; the tag
// distinguishes plan-capture docs from attachment-backed docs and user uploads without
// a schema change. ADDITIVE provenance — the jsonb `plan` on _genie_changesets stays
// authoritative; the changeset/plan ref is a durable, versioned pointer beside it.
export const PLAN_DOCUMENT_SOURCE = "changeset-plan";
export const PLAN_DOCUMENT_KIND = "text/markdown";

// metadata.source tag + kind for the document minted from a kernel attestation (Phase 3
// Slice C-minimal, plan §8 — ledger evidence). The attestation (kind/status/scope/
// fingerprint/summary) is rendered as markdown; the tag distinguishes attestation-evidence
// docs from plan-capture docs, attachment-backed docs, and user uploads without a schema
// change. ADDITIVE provenance — the _genie_verification_ledger row (and the attestation
// embedded in the changeset plan jsonb) stays authoritative; the ledger/evidence ref is a
// durable, versioned, byte-exact pointer beside it.
export const EVIDENCE_DOCUMENT_SOURCE = "attestation";
export const EVIDENCE_DOCUMENT_KIND = "text/markdown";

// metadata.source tag + kind for the document minted from a single
// record_verification_run EVIDENCE ITEM (Phase 3 Slice C-rich, plan §8/§11 — the
// C-rich reading of ledger evidence: capture the actual evidence bytes, not just the
// attestation). Each VerificationEvidence item's textual output (kind/status/checkId/
// summary + optional data) is rendered as markdown; the tag distinguishes run-evidence
// docs from the C-minimal attestation-evidence docs (source="attestation"), plan-capture
// docs, attachment-backed docs, and user uploads without a schema change. ADDITIVE
// provenance — the _genie_verification_ledger row + the changeset's plan.evidence jsonb
// stay authoritative; the doc + ledger/evidence ref are a durable, versioned, byte-exact
// pointer beside them. CRITICAL: unlike a kernel-minted attestation id (globally unique,
// append-only), an evidence item's id is agent-supplied and defaults to evidence_${index}
// — NOT stable or globally unique across runs/changesets. So the origin key stamped as
// metadata.sourceId (and reused as the ledger ref's refId) is the COMPOSITE
// `${changesetId}:${evidence.id}` — see runEvidenceLedgerKey in tools/dispatch.ts — which
// makes it stable per (changeset, item) and collision-free across changesets that each
// carry an evidence_0.
export const RUN_EVIDENCE_DOCUMENT_SOURCE = "verification-run-evidence";
export const RUN_EVIDENCE_DOCUMENT_KIND = "text/markdown";

// metadata.source tag + kind for the document minted from a screenshot BLOB produced by a
// viz/screenshot tool (Phase 3 Slice C-rich, SECONDARY deliverable — plan §8/§11). The raw
// PNG bytes are stored verbatim (content-addressing dedupes identical shots); the tag
// distinguishes screenshot-evidence docs from the markdown run-evidence docs. Captured by
// tool dispatch from any result carrying `_images` — see core/document-capture.ts — and
// cited by a ledger/evidence ref keyed on the producing tool-call id. ADDITIVE provenance,
// same contract as the item docs.
export const SCREENSHOT_DOCUMENT_SOURCE = "screenshot";
export const SCREENSHOT_DOCUMENT_KIND = "image/png";

// metadata.source tag + kind for the document minted from a forensically-valuable log()
// entry (Phase 3 Slice D — log refs, plan §8/§11: "relevant log() entries carry a doc id").
// The entry's rendered bytes (level/source/route/message + fenced stack + fenced json
// metadata) are stored as markdown; the tag distinguishes log-evidence docs from the other
// evidence sources above without a schema change (DOCUMENT_REF_TYPES already carries "log").
// ADDITIVE provenance — the KernelLog ring buffer + its on-disk snapshot stay authoritative;
// the doc + log/evidence ref are a durable, byte-exact pointer beside them, and the minted
// doc id is stamped back into the entry's metadata.documentId. CRITICAL: a LogEntry.id is a
// per-buffer nextId that resets to 1 on clear() and is retained only for the most-recent
// ~500 entries — NOT globally unique or stable across a restart — so it is unusable as an
// origin key. The origin key stamped as metadata.sourceId (and reused as the log ref's
// refId) is instead a COMPOSITE, content-stable `${source}:${route ?? ""}:<contentHash>` —
// see logEvidenceKey in app-server.ts — so a re-emit of the same forensic payload reuses the
// one doc rather than minting a duplicate, and a buffer-reset id can never collide.
export const LOG_EVIDENCE_DOCUMENT_SOURCE = "log-evidence";
export const LOG_EVIDENCE_DOCUMENT_KIND = "text/markdown";

export const INTERNAL_PROVENANCE_DOCUMENT_SOURCES = new Set<string>([
  PLAN_DOCUMENT_SOURCE,
  EVIDENCE_DOCUMENT_SOURCE,
  RUN_EVIDENCE_DOCUMENT_SOURCE,
  SCREENSHOT_DOCUMENT_SOURCE,
  LOG_EVIDENCE_DOCUMENT_SOURCE,
]);

// The largest content payload the store accepts (bytes). Shared with the codebase
// index (plan §4/§13).
export const DOCUMENT_MAX_CONTENT_BYTES = DEFAULT_MAX_FILE_BYTES;

// --- Public shapes ---

export interface DocumentRecord {
  id: string;
  ownerUserId: string;
  projectId: string | null;
  sessionId: string | null;
  scope: DocumentScope;
  name: string;
  kind: string;
  currentVersionHash: string;
  createdBy: DocumentCreator;
  metadata: DocumentMetadata;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface DocumentVersion {
  versionHash: string;
  documentId: string;
  size: number;
  mime: string;
  storagePath: string;
  createdBy: DocumentCreator;
  note: string | null;
  createdAt: string;
}

export interface DocumentRef {
  id: string;
  documentId: string;
  refType: DocumentRefType;
  refId: string;
  role: DocumentRefRole;
  versionHash: string | null;
  sessionId: string | null;
  createdAt: string;
}

export interface DocumentWithVersions {
  document: DocumentRecord;
  versions: DocumentVersion[];
}

export interface DocumentContent {
  document: DocumentRecord;
  version: DocumentVersion;
  content: string;
}

export interface CreateDocumentInput {
  name: string;
  kind: string;
  content: string | Uint8Array;
  scope: DocumentScope;
  ownerUserId?: string;
  projectId?: string | null;
  sessionId?: string | null;
  createdBy?: DocumentCreator;
  metadata?: DocumentMetadata;
  note?: string;
}

export interface UpdateDocumentInput {
  content: string | Uint8Array;
  createdBy?: DocumentCreator;
  note?: string;
}

// The backlink-writer input shared by recordRef (append-only) and recordUniqueRef
// (single-ref upsert). versionHash pins the exact cited version (D2); null = head.
export interface RecordRefInput {
  documentId: string;
  refType: DocumentRefType;
  refId: string;
  role: DocumentRefRole;
  versionHash?: string | null;
  sessionId?: string | null;
}

export interface ListDocumentsFilter {
  scope?: DocumentScope;
  sessionId?: string;
  projectId?: string;
  includeArchived?: boolean;
  includeInternal?: boolean;
}

const DEFAULT_OWNER = "local_legacy";
const DEFAULT_CREATOR: DocumentCreator = "agent";

// --- Path helpers (plan §4). Blobs are content-addressed and sharded
// <hash[0:2]>/<hash>; the storage ROOT depends on the doc's scope. ---

export function projectDocumentsDir(projectDir: string): string {
  return join(
    getProjectPaths(projectDir).artifactsDir,
    DOCUMENT_STORAGE_DIRNAME,
  );
}

export function globalDocumentsDir(): string {
  return join(getTideDir(), DOCUMENT_STORAGE_DIRNAME);
}

function toBytes(content: string | Uint8Array): Uint8Array {
  return typeof content === "string"
    ? new TextEncoder().encode(content)
    : content;
}

function rowToDocument(
  r: typeof genieDocumentsTable.$inferSelect,
): DocumentRecord {
  return {
    id: r.id,
    ownerUserId: r.ownerUserId,
    projectId: r.projectId,
    sessionId: r.sessionId,
    scope: r.scope as DocumentScope,
    name: r.name,
    kind: r.kind,
    currentVersionHash: r.currentVersionHash,
    createdBy: r.createdBy as DocumentCreator,
    metadata: r.metadata,
    archived: r.archived,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

function isInternalProvenanceDocument(d: DocumentRecord): boolean {
  return typeof d.metadata.source === "string" &&
    INTERNAL_PROVENANCE_DOCUMENT_SOURCES.has(d.metadata.source);
}

function rowToRef(r: typeof genieDocumentRefsTable.$inferSelect): DocumentRef {
  return {
    id: r.id,
    documentId: r.documentId,
    refType: r.refType as DocumentRefType,
    refId: r.refId,
    role: r.role as DocumentRefRole,
    versionHash: r.versionHash,
    sessionId: r.sessionId,
    createdAt: r.createdAt,
  };
}

function rowToVersion(
  r: typeof genieDocumentVersionsTable.$inferSelect,
): DocumentVersion {
  return {
    versionHash: r.versionHash,
    documentId: r.documentId,
    size: r.size,
    mime: r.mime,
    storagePath: r.storagePath,
    createdBy: r.createdBy as DocumentCreator,
    note: r.note,
    createdAt: r.createdAt,
  };
}

// The content-addressed blob store + document metadata (plan §3/§4). Immutable
// versions + a mutable head pointer (D2): update = new version + blob, head moves,
// old versions stay resolvable by hash; identical bytes dedupe.
export class DocumentStore {
  // resolveProjectDir returns the active project dir (null = no project loaded),
  // used to derive the project/session-scoped blob root. globalRootOverride lets
  // tests relocate the global root off the real ~/.config/opentide.
  constructor(
    private readonly db: DrizzleDb,
    private readonly resolveProjectDir: () => string | null,
    private readonly globalRootOverride?: string,
  ) {}

  private scopeRoot(scope: DocumentScope): Result<string> {
    if (scope === "global") {
      return {
        ok: true,
        data: this.globalRootOverride ?? globalDocumentsDir(),
      };
    }
    const projectDir = this.resolveProjectDir();
    if (!projectDir) {
      return {
        ok: false,
        error: {
          code: "PROJECT_REQUIRED",
          message:
            `A ${scope}-scoped document needs a loaded project; none is open.`,
          suggestion:
            'Open a project first, or create the document with scope "global".',
        },
      };
    }
    return { ok: true, data: projectDocumentsDir(projectDir) };
  }

  // Content-addressed write: the blob's name IS its sha256, so writing is a pure
  // upsert — if the file already exists the bytes are identical, so we skip the
  // write (dedupe). Global-root blobs get 0o600 (secrets-adjacent, §4).
  private writeBlobIfMissing(
    root: string,
    scope: DocumentScope,
    hash: string,
    bytes: Uint8Array,
  ): string {
    return writeBlob(
      root,
      hash,
      bytes,
      scope === "global" ? DOCUMENT_BLOB_FILE_MODE : undefined,
    );
  }

  async create(input: CreateDocumentInput): Promise<Result<DocumentRecord>> {
    if (!DOCUMENT_SCOPES.includes(input.scope)) {
      return invalidEnum("scope", input.scope, DOCUMENT_SCOPES);
    }
    const createdBy = input.createdBy ?? DEFAULT_CREATOR;
    if (!DOCUMENT_CREATORS.includes(createdBy)) {
      return invalidEnum("createdBy", createdBy, DOCUMENT_CREATORS);
    }
    if (!input.name.trim()) {
      return {
        ok: false,
        error: { code: "INVALID_NAME", message: "Document name is required." },
      };
    }

    const bytes = toBytes(input.content);
    const capped = capCheck(bytes, input.kind);
    if (!capped.ok) return capped;

    const root = this.scopeRoot(input.scope);
    if (!root.ok) return root;

    const hash = blobHash(bytes);
    const storagePath = this.writeBlobIfMissing(
      root.data,
      input.scope,
      hash,
      bytes,
    );

    const now = new Date().toISOString();
    const id = createTimestampedId(DOCUMENT_ID_PREFIX);

    // The version row is content-addressed (version_hash PK). Two documents with
    // identical bytes would collide on the PK — onConflictDoNothing keeps the
    // first-writer's row; the blob is shared and always ensured present above, so
    // resolution by hash stays correct regardless of which doc "owns" the row.
    await this.db
      .insert(genieDocumentVersionsTable)
      .values({
        versionHash: hash,
        documentId: id,
        size: bytes.length,
        mime: input.kind,
        storagePath,
        createdBy,
        note: input.note ?? null,
        createdAt: now,
      })
      .onConflictDoNothing();

    const rows = await this.db
      .insert(genieDocumentsTable)
      .values({
        id,
        ownerUserId: input.ownerUserId ?? DEFAULT_OWNER,
        projectId: input.projectId ?? null,
        sessionId: input.sessionId ?? null,
        scope: input.scope,
        name: input.name,
        kind: input.kind,
        currentVersionHash: hash,
        createdBy,
        metadata: input.metadata ?? {},
        archived: false,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    return { ok: true, data: rowToDocument(rows[0]!) };
  }

  // A new immutable version + blob; the head moves (D2). Identical bytes to the
  // current head is a true no-op dedupe — no new row, no blob rewrite, head stays.
  async update(
    id: string,
    input: UpdateDocumentInput,
  ): Promise<Result<DocumentRecord>> {
    const existing = await this.getDocument(id);
    if (!existing) return notFound(id);
    if (existing.archived) {
      return {
        ok: false,
        error: {
          code: "DOCUMENT_ARCHIVED",
          message: `Document "${id}" is archived and cannot be updated.`,
        },
      };
    }
    const createdBy = input.createdBy ?? DEFAULT_CREATOR;
    if (!DOCUMENT_CREATORS.includes(createdBy)) {
      return invalidEnum("createdBy", createdBy, DOCUMENT_CREATORS);
    }

    const bytes = toBytes(input.content);
    const capped = capCheck(bytes, existing.kind);
    if (!capped.ok) return capped;

    const hash = blobHash(bytes);
    if (hash === existing.currentVersionHash) {
      // Identical bytes → dedupe: nothing changes.
      return { ok: true, data: existing };
    }

    const root = this.scopeRoot(existing.scope);
    if (!root.ok) return root;

    const storagePath = this.writeBlobIfMissing(
      root.data,
      existing.scope,
      hash,
      bytes,
    );

    const now = new Date().toISOString();
    // onConflictDoNothing covers reverting to a prior version of THIS doc (the
    // hash's row already exists) as well as cross-doc content collisions.
    await this.db
      .insert(genieDocumentVersionsTable)
      .values({
        versionHash: hash,
        documentId: id,
        size: bytes.length,
        mime: existing.kind,
        storagePath,
        createdBy,
        note: input.note ?? null,
        createdAt: now,
      })
      .onConflictDoNothing();

    const rows = await this.db
      .update(genieDocumentsTable)
      .set({ currentVersionHash: hash, updatedAt: now })
      .where(eq(genieDocumentsTable.id, id))
      .returning();

    return { ok: true, data: rowToDocument(rows[0]!) };
  }

  // Soft archive (D2/§4 — immutable provenance means we tombstone the logical doc,
  // never hard-delete cited blobs).
  async archive(id: string): Promise<Result<DocumentRecord>> {
    const existing = await this.getDocument(id);
    if (!existing) return notFound(id);
    const now = new Date().toISOString();
    const rows = await this.db
      .update(genieDocumentsTable)
      .set({ archived: true, updatedAt: now })
      .where(eq(genieDocumentsTable.id, id))
      .returning();
    return { ok: true, data: rowToDocument(rows[0]!) };
  }

  // Promote a document up the scope ladder (session → project → global, plan §9).
  // One-way UP only: a demotion is rejected, and promoting to the current scope is an
  // idempotent no-op success. The blob ROOT is scope-derived (§4): session and project
  // share the project root, while global lives under the global store. So a session→
  // project promotion is metadata-only (same root), whereas a →global promotion must
  // copy every version's blob into the global root FIRST — copy-before-flip, so if a
  // copy throws the scope is unchanged and the old root still resolves (safe rollback).
  // Version rows store only the RELATIVE, content-addressed storagePath, so they never
  // change; we copy the blob FILES and flip the doc row.
  async promoteScope(
    id: string,
    target: DocumentScope,
  ): Promise<Result<DocumentRecord>> {
    const existing = await this.getDocument(id);
    if (!existing) return notFound(id);
    if (!DOCUMENT_SCOPES.includes(target)) {
      return invalidEnum("scope", target, DOCUMENT_SCOPES);
    }
    if (existing.archived) {
      return {
        ok: false,
        error: {
          code: "DOCUMENT_ARCHIVED",
          message: `Document "${id}" is archived and cannot be promoted.`,
        },
      };
    }
    if (SCOPE_RANK[target] < SCOPE_RANK[existing.scope]) {
      return {
        ok: false,
        error: {
          code: "INVALID_SCOPE_PROMOTION",
          message:
            "Scope promotion is one-way up (session → project → global); cannot demote " +
            `"${existing.scope}" to "${target}".`,
        },
      };
    }
    if (SCOPE_RANK[target] === SCOPE_RANK[existing.scope]) {
      // Already at that scope — idempotent no-op, no write.
      return { ok: true, data: existing };
    }

    const sourceRoot = this.scopeRoot(existing.scope);
    if (!sourceRoot.ok) return sourceRoot;
    const targetRoot = this.scopeRoot(target);
    if (!targetRoot.ok) return targetRoot;

    // Copy blobs BEFORE flipping the row. Only needed when the roots differ (the →global
    // case — session and project share a root, so those promotions are metadata-only).
    if (targetRoot.data !== sourceRoot.data) {
      for (const version of await this.listVersions(id)) {
        const abs = join(sourceRoot.data, version.storagePath);
        if (!existsSync(abs)) {
          return {
            ok: false,
            error: {
              code: "BLOB_MISSING",
              message:
                `Blob for version "${version.versionHash}" is missing on disk; cannot promote.`,
            },
          };
        }
        // Content-addressed → idempotent, and re-stamps 0o600 for the global root.
        this.writeBlobIfMissing(
          targetRoot.data,
          target,
          version.versionHash,
          new Uint8Array(readFileSync(abs)),
        );
      }
    }

    const now = new Date().toISOString();
    // Promoting away from session always clears sessionId; →global also clears projectId
    // (global docs aren't project-bound); session→project keeps projectId as-is.
    const rows = await this.db
      .update(genieDocumentsTable)
      .set({
        scope: target,
        sessionId: null,
        projectId: target === "global" ? null : existing.projectId,
        updatedAt: now,
      })
      .where(eq(genieDocumentsTable.id, id))
      .returning();
    return { ok: true, data: rowToDocument(rows[0]!) };
  }

  private async getDocument(id: string): Promise<DocumentRecord | null> {
    const rows = await this.db
      .select()
      .from(genieDocumentsTable)
      .where(eq(genieDocumentsTable.id, id))
      .limit(1);
    return rows[0] ? rowToDocument(rows[0]) : null;
  }

  async listVersions(id: string): Promise<DocumentVersion[]> {
    const rows = await this.db
      .select()
      .from(genieDocumentVersionsTable)
      .where(eq(genieDocumentVersionsTable.documentId, id))
      .orderBy(desc(genieDocumentVersionsTable.createdAt));
    return rows.map(rowToVersion);
  }

  // Metadata + version list (document_query action=read).
  async read(id: string): Promise<Result<DocumentWithVersions>> {
    const document = await this.getDocument(id);
    if (!document) return notFound(id);
    const versions = await this.listVersions(id);
    return { ok: true, data: { document, versions } };
  }

  async list(
    filter: ListDocumentsFilter = {},
  ): Promise<Result<DocumentRecord[]>> {
    const clauses = [];
    if (filter.scope) clauses.push(eq(genieDocumentsTable.scope, filter.scope));
    if (filter.sessionId) {
      clauses.push(eq(genieDocumentsTable.sessionId, filter.sessionId));
    }
    if (filter.projectId) {
      clauses.push(eq(genieDocumentsTable.projectId, filter.projectId));
    }
    if (!filter.includeArchived) {
      clauses.push(eq(genieDocumentsTable.archived, false));
    }
    const rows = await this.db
      .select()
      .from(genieDocumentsTable)
      .where(clauses.length ? and(...clauses) : undefined)
      .orderBy(desc(genieDocumentsTable.updatedAt));
    const data = rows.map(rowToDocument);
    return {
      ok: true,
      data: filter.includeInternal === false
        ? data.filter((d) => !isInternalProvenanceDocument(d))
        : data,
    };
  }

  // Substring/metadata match over name + metadata (plan §12 — Phase 1 search is a
  // simple filter; full-text/semantic is a later revisit).
  async search(
    query: string,
    filter: ListDocumentsFilter = {},
  ): Promise<Result<DocumentRecord[]>> {
    const listed = await this.list(filter);
    if (!listed.ok) return listed;
    const needle = query.trim().toLowerCase();
    if (!needle) return listed;
    const matches = listed.data.filter((d) => {
      const haystack = [
        d.name,
        d.metadata.title ?? "",
        d.metadata.description ?? "",
        ...(d.metadata.tags ?? []),
      ].join(" ").toLowerCase();
      return haystack.includes(needle);
    });
    return { ok: true, data: matches };
  }

  // Resolve raw blob bytes for the head (versionHash omitted) or an exact version.
  // The bytes-first primitive: text readers decode utf-8 (readContent); binary
  // consumers (Tier-1 image/pdf mention blocks — §7) base64 the bytes directly.
  async readContentBytes(
    id: string,
    versionHash?: string,
  ): Promise<
    Result<
      { document: DocumentRecord; version: DocumentVersion; bytes: Uint8Array }
    >
  > {
    const document = await this.getDocument(id);
    if (!document) return notFound(id);

    const targetHash = versionHash ?? document.currentVersionHash;
    const versionRows = await this.db
      .select()
      .from(genieDocumentVersionsTable)
      .where(eq(genieDocumentVersionsTable.versionHash, targetHash))
      .limit(1);
    const versionRow = versionRows[0];
    if (!versionRow) {
      return {
        ok: false,
        error: {
          code: "VERSION_NOT_FOUND",
          message: `No version "${targetHash}" for document "${id}".`,
        },
      };
    }
    const version = rowToVersion(versionRow);

    const root = this.scopeRoot(document.scope);
    if (!root.ok) return root;
    const abs = join(root.data, version.storagePath);
    if (!existsSync(abs)) {
      return {
        ok: false,
        error: {
          code: "BLOB_MISSING",
          message: `Blob for version "${targetHash}" is missing on disk.`,
        },
      };
    }
    return {
      ok: true,
      data: { document, version, bytes: new Uint8Array(readFileSync(abs)) },
    };
  }

  // Resolve blob content as utf-8 text for the head or an exact version.
  async readContent(
    id: string,
    versionHash?: string,
  ): Promise<Result<DocumentContent>> {
    const raw = await this.readContentBytes(id, versionHash);
    if (!raw.ok) return raw;
    return {
      ok: true,
      data: {
        document: raw.data.document,
        version: raw.data.version,
        content: new TextDecoder().decode(raw.data.bytes),
      },
    };
  }

  // The stored byte size of a version's blob (no blob read — metadata only).
  private async versionSize(versionHash: string): Promise<number> {
    const rows = await this.db
      .select({ size: genieDocumentVersionsTable.size })
      .from(genieDocumentVersionsTable)
      .where(eq(genieDocumentVersionsTable.versionHash, versionHash))
      .limit(1);
    return rows[0]?.size ?? 0;
  }

  // The session working set's estimated token cost — the per-doc sum of the head
  // version's byte size run through estimateTokensFromBytes (D3, §5). Metadata only.
  async residentTokenCost(sessionId: string): Promise<number> {
    const ids = await this.listPinned(sessionId);
    let tokens = 0;
    for (const id of ids) {
      const doc = await this.getDocument(id);
      if (doc) {
        tokens += estimateTokensFromBytes(
          await this.versionSize(doc.currentVersionHash),
        );
      }
    }
    return tokens;
  }

  // Toggle Tier-2 working-set membership (document_pin). Persists the
  // _genie_document_refs row (ref_type=working_set, role=resident); prompt injection
  // is handled by prompt-compose. Adding a doc that would push the session's resident
  // total past DOCUMENT_WORKING_SET_MAX_TOKENS fails with WORKING_SET_BUDGET_EXCEEDED
  // and leaves the set unchanged — deterministic, no silent eviction (D3, §5).
  // Idempotent per (doc, session): re-pinning an already-resident doc is a no-op and
  // skips the budget check (it is already counted).
  async setPinned(
    id: string,
    pinned: boolean,
    sessionId: string,
  ): Promise<Result<{ id: string; pinned: boolean }>> {
    const document = await this.getDocument(id);
    if (!document) return notFound(id);

    const where = and(
      eq(genieDocumentRefsTable.documentId, id),
      eq(genieDocumentRefsTable.refType, "working_set"),
      eq(genieDocumentRefsTable.refId, sessionId),
    );

    if (!pinned) {
      await this.db.delete(genieDocumentRefsTable).where(where);
      return { ok: true, data: { id, pinned: false } };
    }

    const existing = await this.db
      .select()
      .from(genieDocumentRefsTable)
      .where(where)
      .limit(1);
    if (existing[0]) {
      // Already resident — idempotent, already within budget.
      return { ok: true, data: { id, pinned: true } };
    }

    const addedCost = estimateTokensFromBytes(
      await this.versionSize(document.currentVersionHash),
    );
    const currentCost = await this.residentTokenCost(sessionId);
    if (currentCost + addedCost > DOCUMENT_WORKING_SET_MAX_TOKENS) {
      return {
        ok: false,
        error: {
          code: "WORKING_SET_BUDGET_EXCEEDED",
          message:
            `Pinning "${id}" (~${addedCost} tokens) would push the working set to ` +
            `~${
              currentCost + addedCost
            } tokens, past the ${DOCUMENT_WORKING_SET_MAX_TOKENS}-token cap.`,
          suggestion:
            "Release a resident document first with document_pin({ pinned: false }), then pin this one.",
        },
      };
    }

    await this.db.insert(genieDocumentRefsTable).values({
      id: createTimestampedId(DOCUMENT_REF_ID_PREFIX),
      documentId: id,
      versionHash: null,
      refType: "working_set",
      refId: sessionId,
      role: "resident",
      sessionId,
      createdAt: new Date().toISOString(),
    });
    return { ok: true, data: { id, pinned: true } };
  }

  // Generic backlink writer (docs/document-store-plan.md §8). Phase 2 uses it for the
  // Tier-1 @-mention path (ref_type=message, role=mention); Phase 3 reuses it for
  // changeset/ledger/log refs. Records the exact version cited so provenance resolves
  // to fixed bytes (D2). Append-only — the right primitive for backlinks where a target
  // legitimately accumulates many refs (a message with several attachments). Returns
  // the persisted ref.
  async recordRef(input: RecordRefInput): Promise<Result<DocumentRef>> {
    const invalid = this.validateRefInput(input);
    if (invalid) return invalid;
    const document = await this.getDocument(input.documentId);
    if (!document) return notFound(input.documentId);
    return { ok: true, data: await this.insertRef(input) };
  }

  // Upsert the single ref for a (refType, refId, role) target — used where the target
  // must cite exactly ONE live version (changeset→plan, D4 / §8, Slice B): re-planning
  // moves the plan doc's head, and the ref must FOLLOW it without accumulating one row
  // per re-plan. Deletes any existing refs for the tuple, then inserts the fresh one, so
  // listRefsByTarget(refType, refId, role) returns exactly one live ref at the current
  // head. Same delete-then-insert shape as setPinned's membership toggle; recordRef
  // stays the append-only variant.
  async recordUniqueRef(input: RecordRefInput): Promise<Result<DocumentRef>> {
    const invalid = this.validateRefInput(input);
    if (invalid) return invalid;
    const document = await this.getDocument(input.documentId);
    if (!document) return notFound(input.documentId);
    // Atomic so the delete and the insert land together — a mid-op failure never
    // leaves the target with zero refs (nor two).
    const ref = await this.db.transaction(async (tx) => {
      await tx
        .delete(genieDocumentRefsTable)
        .where(and(
          eq(genieDocumentRefsTable.refType, input.refType),
          eq(genieDocumentRefsTable.refId, input.refId),
          eq(genieDocumentRefsTable.role, input.role),
        ));
      const rows = await tx
        .insert(genieDocumentRefsTable)
        .values(buildRefRow(input))
        .returning();
      return rowToRef(rows[0]!);
    });
    return { ok: true, data: ref };
  }

  private validateRefInput(input: RecordRefInput): Result<never> | null {
    if (!DOCUMENT_REF_TYPES.includes(input.refType)) {
      return invalidEnum("refType", input.refType, DOCUMENT_REF_TYPES);
    }
    if (!DOCUMENT_REF_ROLES.includes(input.role)) {
      return invalidEnum("role", input.role, DOCUMENT_REF_ROLES);
    }
    return null;
  }

  private async insertRef(input: RecordRefInput): Promise<DocumentRef> {
    const rows = await this.db
      .insert(genieDocumentRefsTable)
      .values(buildRefRow(input))
      .returning();
    return rowToRef(rows[0]!);
  }

  // Find the newest live (non-archived) document minted from a given origin
  // (metadata.source + metadata.sourceId), narrowed by the optional filter. Lets a
  // capture pass rediscover the doc it owns by WHAT IT IS rather than via a backlink
  // ref, so the pass stays idempotent per origin even if a prior ref write failed.
  async findBySource(
    source: string,
    sourceId: string,
    filter: ListDocumentsFilter = {},
  ): Promise<DocumentRecord | null> {
    const listed = await this.list(filter); // newest-first, archived excluded
    if (!listed.ok) return null;
    return listed.data.find((d) =>
      d.metadata.source === source && d.metadata.sourceId === sourceId
    ) ?? null;
  }

  // The current Tier-2 working set for a session (membership rows).
  async listPinned(sessionId: string): Promise<string[]> {
    const rows = await this.db
      .select({ documentId: genieDocumentRefsTable.documentId })
      .from(genieDocumentRefsTable)
      .where(and(
        eq(genieDocumentRefsTable.refType, "working_set"),
        eq(genieDocumentRefsTable.refId, sessionId),
      ));
    return rows.map((r) => r.documentId);
  }

  // Backlinks for a document ("used in").
  async listRefs(id: string): Promise<DocumentRef[]> {
    const rows = await this.db
      .select()
      .from(genieDocumentRefsTable)
      .where(eq(genieDocumentRefsTable.documentId, id))
      .orderBy(desc(genieDocumentRefsTable.createdAt));
    return rows.map(rowToRef);
  }

  // The inverse of listRefs: refs pointing AT a referencing row (by refType + refId,
  // index-backed via document_refs_ref_idx), optionally narrowed to one role. The
  // reload path uses this to recover a message's `attachment` documents (§8/§10) —
  // given a stored message id, find the docs it carries and resolve their bytes.
  async listRefsByTarget(
    refType: DocumentRefType,
    refId: string,
    role?: DocumentRefRole,
  ): Promise<DocumentRef[]> {
    const clauses = [
      eq(genieDocumentRefsTable.refType, refType),
      eq(genieDocumentRefsTable.refId, refId),
    ];
    if (role) clauses.push(eq(genieDocumentRefsTable.role, role));
    const rows = await this.db
      .select()
      .from(genieDocumentRefsTable)
      .where(and(...clauses))
      .orderBy(desc(genieDocumentRefsTable.createdAt));
    return rows.map(rowToRef);
  }
}

// The insert values for a document ref row. Shared by the plain (recordRef) and the
// transactional single-ref (recordUniqueRef) writers so their row shape never drifts.
function buildRefRow(input: RecordRefInput) {
  return {
    id: createTimestampedId(DOCUMENT_REF_ID_PREFIX),
    documentId: input.documentId,
    versionHash: input.versionHash ?? null,
    refType: input.refType,
    refId: input.refId,
    role: input.role,
    sessionId: input.sessionId ?? null,
    createdAt: new Date().toISOString(),
  };
}

// The byte cap is kind-aware (Slice 9): text content stays on the small text cap
// (source/markdown parity), while uploaded binary blobs (images, PDFs) get the
// larger DOCUMENT_UPLOAD_MAX_BYTES. The message names the cap that actually applied.
function capCheck(bytes: Uint8Array, kind: string): Result<void> {
  const cap = kind.startsWith("text/")
    ? DOCUMENT_MAX_CONTENT_BYTES
    : DOCUMENT_UPLOAD_MAX_BYTES;
  if (bytes.length > cap) {
    return {
      ok: false,
      error: {
        code: "CONTENT_TOO_LARGE",
        message:
          `Document content is ${bytes.length} bytes; the cap is ${cap}.`,
      },
    };
  }
  return { ok: true, data: undefined };
}

function notFound(id: string): Result<never> {
  return {
    ok: false,
    error: {
      code: "DOCUMENT_NOT_FOUND",
      message: `No document with id "${id}".`,
    },
  };
}

function invalidEnum(
  field: string,
  value: string,
  allowed: readonly string[],
): Result<never> {
  return {
    ok: false,
    error: {
      code: "INVALID_ENUM",
      message: `Invalid ${field} "${value}". Valid values: ${
        allowed.join(", ")
      }.`,
    },
  };
}
