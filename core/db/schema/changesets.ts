import { integer, jsonb, pgTable, text } from "drizzle-orm/pg-core";

interface ChangesetStep {
  id: string;
  description: string;
  status: "pending" | "in_progress" | "done" | "skipped";
}

interface ChangesetPlan {
  summary: string;
  steps: ChangesetStep[];
  acceptanceCriteria?: unknown[];
  verificationPlan?: unknown[];
  verificationRuns?: unknown[];
  // Kernel-minted verification attestations (provenance + freshness). Stored in
  // the `plan` jsonb column — no dedicated table in Phase 1.
  attestations?: unknown[];
}

interface TokenUsage {
  // Uncached input tokens only; cache write/read are separate billable buckets.
  inputTokens: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  outputTokens: number;
  costUsd: number | null;
  pricingStatus?: "priced" | "unpriced" | "estimated_legacy";
  unpricedCalls?: number;
  unpricedInputTokens?: number;
  unpricedOutputTokens?: number;
  durationMs: number;
}

export const genieChangesetsTable = pgTable("_genie_changesets", {
  id: text("id").primaryKey(),
  sessionId: text("session_id"),
  title: text("title").notNull(),
  description: text("description"),
  status: text("status").notNull().default("planning"),
  plan: jsonb("plan").$type<ChangesetPlan>(),
  planMessageIds: jsonb("plan_message_ids").$type<number[]>(),
  approvalMessageId: integer("approval_message_id"),
  workMessageIds: jsonb("work_message_ids").$type<number[]>(),
  toolCalls: jsonb("tool_calls").$type<unknown[]>(),
  reasoning: jsonb("reasoning").$type<unknown[]>(),
  tokenUsage: jsonb("token_usage").$type<TokenUsage>(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  completedAt: text("completed_at"),
  creatorUserId: text("creator_user_id"),
});
