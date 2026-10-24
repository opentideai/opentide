import {
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
} from "drizzle-orm/pg-core";
import type { AuditIssue } from "../../types.ts";

export const genieAuditResultsTable = pgTable("_genie_audit_results", {
  id: text("id").primaryKey(),
  category: text("category").notNull(),
  status: text("status").notNull(),
  startedAt: text("started_at").notNull(),
  completedAt: text("completed_at"),
  issues: jsonb("issues").$type<AuditIssue[]>().notNull().default([]),
  summary: text("summary").notNull(),
  score: integer("score"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull()
    .default({}),
  error: text("error"),
  durationMs: integer("duration_ms"),
  model: text("model"),
  inputTokens: integer("input_tokens").default(0),
  outputTokens: integer("output_tokens").default(0),
  cacheCreationInputTokens: integer("cache_creation_input_tokens").default(0),
  cacheReadInputTokens: integer("cache_read_input_tokens").default(0),
  costUsd: real("cost_usd").default(0),
}, (table) => [
  index("audit_results_category_idx").on(table.category),
  index("audit_results_category_started_idx").on(
    table.category,
    table.startedAt,
  ),
]);
