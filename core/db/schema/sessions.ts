import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  serial,
  text,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const genieSessionsTable = pgTable("_genie_sessions", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  startedAt: text("started_at").notNull(),
  endedAt: text("ended_at"),
  summary: text("summary"),
  focus: text("focus"),
  metadata: text("metadata"),
  archived: boolean("archived").notNull().default(false),
  ownerUserId: text("owner_user_id").notNull().default("local_legacy"),
  visibility: text("visibility").notNull().default("private"),
});

export const genieMessagesTable = pgTable("_genie_messages", {
  id: serial("id").primaryKey(),
  sessionId: text("session_id").notNull().references(
    () => genieSessionsTable.id,
    { onDelete: "cascade" },
  ),
  role: text("role").notNull(),
  kind: text("kind").notNull().default("chat"),
  content: text("content").notNull(),
  toolCalls: text("tool_calls"),
  pinned: boolean("pinned").notNull().default(false),
  projectPinned: boolean("project_pinned").notNull().default(false),
  turnId: text("turn_id"),
  createdAt: text("created_at").notNull(),
  authorUserId: text("author_user_id"),
}, (table) => [
  index("messages_content_search_idx").using(
    "gin",
    sql`to_tsvector('english', ${table.content})`,
  ),
  index("messages_session_id_idx").on(table.sessionId),
]);

export const genieTurnUsageTable = pgTable("_genie_turn_usage", {
  turnId: text("turn_id").primaryKey(),
  sessionId: text("session_id").notNull().references(
    () => genieSessionsTable.id,
    { onDelete: "cascade" },
  ),
  model: text("model").notNull(),
  startedAt: text("started_at").notNull(),
  endedAt: text("ended_at").notNull(),
  durationMs: integer("duration_ms").notNull(),
  inputTokens: integer("input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  cacheCreationInputTokens: integer("cache_creation_input_tokens").notNull()
    .default(0),
  cacheReadInputTokens: integer("cache_read_input_tokens").notNull().default(0),
  toolCallsCount: integer("tool_calls_count").notNull().default(0),
  costUsd: real("cost_usd").notNull().default(0),
});

export const genieModelUsageTable = pgTable("_genie_model_usage", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").references(
    () => genieSessionsTable.id,
    { onDelete: "cascade" },
  ),
  turnId: text("turn_id"),
  auditResultId: text("audit_result_id"),
  changesetId: text("changeset_id"),
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  role: text("role").notNull(),
  caller: text("caller").notNull(),
  startedAt: text("started_at").notNull(),
  endedAt: text("ended_at").notNull(),
  durationMs: integer("duration_ms").notNull().default(0),
  inputTokens: integer("input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  cacheCreationInputTokens: integer("cache_creation_input_tokens").notNull()
    .default(0),
  cacheReadInputTokens: integer("cache_read_input_tokens").notNull().default(0),
  toolCallsCount: integer("tool_calls_count").notNull().default(0),
  costUsd: real("cost_usd"),
  pricingStatus: text("pricing_status").notNull(),
  pricingProvider: text("pricing_provider"),
  pricingModel: text("pricing_model"),
  pricingVerifiedAt: text("pricing_verified_at"),
  pricingSource: text("pricing_source"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull()
    .default({}),
}, (table) => [
  index("model_usage_session_id_idx").on(table.sessionId),
  index("model_usage_turn_id_idx").on(table.turnId),
  index("model_usage_started_at_idx").on(table.startedAt),
]);
