import { assertEquals } from "@std/assert";
import { Database } from "../core/db.ts";
import type { McpCallInput } from "../core/types.ts";
import { McpAuditManager } from "./mcp-audit.ts";

function call(toolName: string): McpCallInput {
  return {
    principalId: "local:test",
    toolName,
    sessionId: null,
    transport: "http",
    decision: "allow",
    reason: null,
    changesetId: null,
    argBytes: 2,
  };
}

Deno.test("mcp audit keeps the newest records, newest first", async () => {
  const db = await Database.create({ driver: "pglite" });
  try {
    const audit = new McpAuditManager(db.drizzle, 3);
    for (const name of ["a", "b", "c", "d", "e"]) {
      await audit.recordMcpCall(call(name));
    }
    const kept = await audit.list();
    assertEquals(kept.map((r) => r.toolName), ["e", "d", "c"]);
    assertEquals((await audit.list(1)).map((r) => r.toolName), ["e"]);
  } finally {
    await db.close();
  }
});
