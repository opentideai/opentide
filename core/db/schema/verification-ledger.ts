import { index, pgTable, text } from "drizzle-orm/pg-core";

// Phase 5A: a dedicated, unbounded ledger of kernel-minted attestations.
//
// Attestations remain authoritative in each changeset's `plan.attestations`
// (append-only, File+DB parity). This table is a DERIVED read-index that
// `recordAttestation` dual-writes and a one-time backfill seeds, so the
// verification overview can query the full history without the old
// 100-changeset aggregation cap. One row per attestation; `id` is the
// attestation id, making dual-write and backfill idempotent (upsert-by-id).
// Columns mirror `Attestation` plus the changeset it was minted in.
export const genieVerificationLedgerTable = pgTable(
  "_genie_verification_ledger",
  {
    id: text("id").primaryKey(),
    changesetId: text("changeset_id").notNull(),
    changesetTitle: text("changeset_title").notNull(),
    kind: text("kind").notNull(),
    status: text("status").notNull(),
    fingerprint: text("fingerprint").notNull(),
    scope: text("scope").notNull(),
    checkId: text("check_id"),
    summary: text("summary").notNull(),
    toolCallId: text("tool_call_id"),
    turnId: text("turn_id"),
    principalId: text("principal_id"),
    producer: text("producer"),
    reviewer: text("reviewer"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("verification_ledger_scope_idx").on(table.scope),
    index("verification_ledger_kind_idx").on(table.kind),
    index("verification_ledger_created_at_idx").on(table.createdAt),
  ],
);
