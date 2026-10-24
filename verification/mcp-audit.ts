// @layer verification — the MCP call audit: one append-only row per inbound
// tool call, allowed or denied, naming the client, tool, session and transport.
// It answers "who called what"; the changelog and ledger answer "what changed".
// Argument and result contents are never stored, only the argument size, so the
// table is safe to keep and to hand to someone else.
import { desc, lte } from "drizzle-orm";
import type { DrizzleDb } from "../core/db/factory.ts";
import { genieMcpCallsTable } from "../core/db/schema/index.ts";
import { MCP_AUDIT_MAX_RECORDS } from "../core/config.ts";
import type {
  McpAuditStore,
  McpCallInput,
  McpCallRecord,
} from "../core/types.ts";

type McpCallRow = typeof genieMcpCallsTable.$inferSelect;

function rowToRecord(row: McpCallRow): McpCallRecord {
  return {
    ...row,
    transport: row.transport as McpCallRecord["transport"],
    decision: row.decision as McpCallRecord["decision"],
  };
}

export class McpAuditManager implements McpAuditStore {
  constructor(
    private readonly db: DrizzleDb,
    private readonly maxRecords = MCP_AUDIT_MAX_RECORDS,
  ) {}

  async recordMcpCall(call: McpCallInput): Promise<void> {
    const [row] = await this.db
      .insert(genieMcpCallsTable)
      .values({ ...call, createdAt: new Date().toISOString() })
      .returning();
    // Ids are serial, so everything at or below id - max is older than the
    // newest max rows.
    if (row && row.id > this.maxRecords) {
      await this.db
        .delete(genieMcpCallsTable)
        .where(lte(genieMcpCallsTable.id, row.id - this.maxRecords));
    }
  }

  async list(limit = this.maxRecords): Promise<McpCallRecord[]> {
    const rows = await this.db
      .select()
      .from(genieMcpCallsTable)
      .orderBy(desc(genieMcpCallsTable.id))
      .limit(limit);
    return rows.map(rowToRecord);
  }
}
