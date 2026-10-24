// The audit-provider seam (OpenTide §3.3): executeAudit runs through whatever
// provider the composition supplied to the Kernel; with none, audits fail
// gracefully. The provider is now a per-Kernel composition field (composition.ts)
// rather than a global, so each case builds a Kernel with the composition it wants.
import { assert, assertEquals } from "@std/assert";
import { Database } from "./db.ts";
import { Kernel } from "./registries.ts";
import type { AuditProvider } from "./audit-provider.ts";
import { executeAudit } from "../verification/audit-runner.ts";
import { testStoreComposition } from "../verification/test-stores.ts";
import type { AuditResult } from "./types.ts";

async function makeKernel(
  auditProvider: AuditProvider | null,
): Promise<{ kernel: Kernel; db: Database }> {
  const db = await Database.create({ driver: "pglite" });
  const composition = { ...testStoreComposition(), auditProvider };
  return { kernel: new Kernel(db, { composition }), db };
}

Deno.test("executeAudit without a provider returns a not-configured result", async () => {
  const { kernel, db } = await makeKernel(null);
  try {
    const result = await executeAudit("security", kernel);
    assertEquals(result.status, "error");
    assert(result.error?.includes("provider"));
    // The error result is still stored so the UI can surface it.
    assertEquals(kernel.audits.get(result.id)?.id, result.id);
  } finally {
    await db.close();
  }
});

Deno.test("executeAudit routes through the supplied provider", async () => {
  let seenCategory: string | null = null;
  const fake: AuditResult = {
    id: "audit-fake",
    category: "security",
    status: "complete",
    startedAt: "2026-01-01T00:00:00Z",
    completedAt: "2026-01-01T00:00:01Z",
    issues: [],
    summary: "ok",
    score: 100,
    metadata: {},
  };
  const { kernel, db } = await makeKernel((config) => {
    seenCategory = config.category;
    return Promise.resolve(fake);
  });
  try {
    const result = await executeAudit("security", kernel);
    assertEquals(seenCategory, "security"); // provider received the builtin config
    assertEquals(result.id, "audit-fake");
    assertEquals(kernel.audits.get("audit-fake")?.summary, "ok"); // stored
  } finally {
    await db.close();
  }
});
