import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
} from "drizzle-orm/pg-core";

// Document store (docs/document-store-plan.md §3). Three tables:
//   _genie_documents          — logical entity, mutable head pointer
//   _genie_document_versions  — immutable, content-addressed payload metadata
//   _genie_document_refs      — polymorphic backlinks ("used in")
// Payload BYTES live on disk (content-addressed blobs under artifactsDir/documents/
// or the user-level global root); these tables hold metadata only (D1). Mirrors the
// skills.ts / audits.ts shape (table + $type + re-export from index.ts).

// The document's metadata bag. Kept small and optional — richer indexing is later.
// `source` + `sourceId` together identify the entity a machine-minted doc was derived
// from (e.g. source="changeset-plan", sourceId=<changeset id>): they make the doc
// discoverable by its origin independent of any backlink ref, so a capture pass is
// idempotent per origin even if a prior ref write failed.
export interface DocumentMetadata {
  description?: string;
  tags?: string[];
  source?: string;
  sourceId?: string;
  title?: string;
}

// _genie_documents — the logical document (mutable head). current_version_hash
// points at the live version in _genie_document_versions; the head moves on update
// (D2) while old versions stay resolvable by their hash.
export const genieDocumentsTable = pgTable("_genie_documents", {
  id: text("id").primaryKey(),
  ownerUserId: text("owner_user_id").notNull().default("local_legacy"),
  // null = global / cross-project (see scope).
  projectId: text("project_id"),
  // null = project- or global-scoped (see scope).
  sessionId: text("session_id"),
  // enum: session | project | global (DOCUMENT_SCOPES). Selects the storage root.
  scope: text("scope").notNull(),
  // display name / @-mention handle.
  name: text("name").notNull(),
  // mime (text/markdown, text/html, image/png, application/pdf, …).
  kind: text("kind").notNull(),
  // head pointer -> _genie_document_versions.version_hash.
  currentVersionHash: text("current_version_hash").notNull(),
  // enum: user | agent (DOCUMENT_CREATORS).
  createdBy: text("created_by").notNull(),
  metadata: jsonb("metadata").$type<DocumentMetadata>().notNull().default({}),
  archived: boolean("archived").notNull().default(false),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  index("documents_scope_idx").on(table.scope),
  index("documents_session_id_idx").on(table.sessionId),
  index("documents_project_id_idx").on(table.projectId),
]);

// _genie_document_versions — immutable, content-addressed. version_hash (sha256 of
// content) is the PK, so the ledger/verification can cite an exact version and it
// always resolves to the exact bytes (D2). storage_path is the blob's path relative
// to the scope's documents root.
export const genieDocumentVersionsTable = pgTable("_genie_document_versions", {
  versionHash: text("version_hash").primaryKey(),
  documentId: text("document_id").notNull(),
  size: integer("size").notNull(),
  mime: text("mime").notNull(),
  storagePath: text("storage_path").notNull(),
  // enum: user | agent (DOCUMENT_CREATORS).
  createdBy: text("created_by").notNull(),
  // changelog line for this version (nullable).
  note: text("note"),
  createdAt: text("created_at").notNull(),
}, (table) => [
  index("document_versions_document_id_idx").on(table.documentId),
]);

// _genie_document_refs — the single source for "where is this used?" (panel
// backlinks, ledger provenance, GC refcounting). version_hash null = head/latest;
// set = pinned exact version.
export const genieDocumentRefsTable = pgTable("_genie_document_refs", {
  id: text("id").primaryKey(),
  documentId: text("document_id").notNull(),
  versionHash: text("version_hash"),
  // enum: message | changeset | ledger | log | working_set (DOCUMENT_REF_TYPES).
  refType: text("ref_type").notNull(),
  // the referencing row's id.
  refId: text("ref_id").notNull(),
  // enum: mention | attachment | plan | evidence | resident (DOCUMENT_REF_ROLES).
  role: text("role").notNull(),
  sessionId: text("session_id"),
  createdAt: text("created_at").notNull(),
}, (table) => [
  index("document_refs_document_id_idx").on(table.documentId),
  index("document_refs_ref_idx").on(table.refType, table.refId),
]);
