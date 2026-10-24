import { index, integer, pgTable, serial, text } from "drizzle-orm/pg-core";

// One row per inbound MCP tool call, allowed or denied (verification/
// mcp-audit.ts). Who called what, never with what: argument and result contents
// are not stored, only their size. Pruned to MCP_AUDIT_MAX_RECORDS.
export const genieMcpCallsTable = pgTable(
  "_genie_mcp_calls",
  {
    id: serial("id").primaryKey(),
    principalId: text("principal_id").notNull(),
    toolName: text("tool_name").notNull(),
    sessionId: text("session_id"),
    transport: text("transport").notNull(),
    decision: text("decision").notNull(),
    reason: text("reason"),
    changesetId: text("changeset_id"),
    argBytes: integer("arg_bytes").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [index("mcp_calls_created_at_idx").on(table.createdAt)],
);
