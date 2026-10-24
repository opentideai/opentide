// @layer shared — L0, the OpenTide *open* wire contract for the changelog surface:
// the per-change records the kernel tracks and the per-turn grouping the IDE
// renders (GET /api/changelog/turns). Type-only; imports NOTHING (self-contained).
// The changelog is core (tracked regardless of whether an agent is configured), so
// these shapes are open. Consumed by the Deno backend (re-exported from
// core/changelog.ts) and the IDE (`$shared` alias).

export type ChangeCategory =
  | "handler"
  | "function"
  | "route"
  | "config"
  | "schema"
  | "sql"
  | "snapshot"
  | "dev_view"
  | "dev_tool"
  | "asset"
  | "template"
  | "branch"
  | "package"
  | "test"
  | "secret"
  | "env_var"
  | "module"
  | "audit"
  | "type";
export type ChangeAction =
  | "create"
  | "update"
  | "delete"
  | "execute"
  | "restore"
  // A3 — a rename is its own operation, NOT a delete(old)+create(new) pair: the
  // entity's stable entityUid is carried across the name change and ONE record is
  // emitted, keyed by the new name, carrying context.renamedFrom. This lets Entity
  // Survival Rate read a rename as the same entity alive (not a death + a birth).
  | "rename";

export interface ChangeContext {
  userMessage?: string;
  toolCallId?: string;
  turnId?: string;
  turnIndex?: number;
  changesetId?: string;
  sessionId?: string;
  manualEdit?: boolean;
  // --- Stream A additions (ride in the existing jsonb `context` column — no
  // DB migration). See docs/stream-a-data-foundation-plan.md. ---
  // A1 — binary authorship of THIS change. "mixed" is never stamped; it is
  // derived at the entity level from history (see entityAuthorship in
  // core/changelog.ts). A missing value means "unknown" and must never be
  // silently treated as "ai".
  authorOrigin?: "ai" | "human";
  // A2 — stable identity of the entity this change touched, threaded through the
  // whole lifecycle so create/update/… records share one id. Injected centrally
  // by the Changelog facade from the registry entry's entityUid (resolved by
  // this record's category+key), so record sites don't set it by hand.
  entityUid?: string;
  // A3 — the prior name of the entity on an action:"rename" record. The record
  // is keyed by the NEW name and carries the preserved entityUid; this field is
  // the only place the old name survives. It is a local-only entity name and must
  // never be copied into an episode log or export projection as free text.
  renamedFrom?: string;
  // Slice 5 (source-backed editing) — marks a change whose target is an on-disk
  // project file rather than a kernel registry entity. It rides the existing
  // `module` category (no new ChangeCategory, so the wire contract + MCP surface
  // stay stable) and is distinguished only by this flag: `key` is the project-
  // root-relative POSIX path and the before/after snapshots are whole-file
  // { path, content } records. Absent ⇒ a normal registry change. See
  // docs/project-import-strategy.md "Slice 5" and core/codebase/source-edit.ts.
  sourceBacked?: boolean;
  // Project text-file authoring uses the same whole-file snapshot undo path as
  // source-backed edits, but is available to registry-native projects too.
  projectFile?: boolean;
  // Who drove the change from outside the kernel: `local:<client>` for an MCP
  // client (mcp/mcp-server.ts), taken from its initialize clientInfo. A label,
  // not an identity: every holder of the server token is the same principal.
  // Absent for the IDE's own agent and manual edits.
  principalId?: string;
}

// One recorded change (an undoable registry mutation) as served to the IDE.
export interface ChangeRecord {
  id: number;
  category: ChangeCategory;
  key: string;
  action: ChangeAction;
  beforeSnapshot: unknown;
  afterSnapshot: unknown;
  context: ChangeContext | null;
  createdAt: string;
  undoable: boolean;
  turnId: string | null;
  changesetId: string | null;
  rationale: string | null;
  implementation: string | null;
  workMessageId: number | null;
  actorUserId?: string | null;
}

// A turn's changes grouped under the user message that drove them. This is the
// base shape; the /api/changelog/turns endpoint enriches each with per-turn usage
// and the originating message id (the IDE extends this with those fields).
export interface TurnGroup {
  turnId: string;
  userMessage: string | null;
  turnIndex: number | null;
  createdAt: string;
  changes: ChangeRecord[];
  changesetId: string | null;
}
