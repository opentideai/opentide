// @layer verification — audit result storage/scoring.
import { desc, eq, inArray } from "drizzle-orm";
import {
  genieAuditResultsTable,
  genieModelUsageTable,
  genieSessionsTable,
  genieTurnUsageTable,
} from "../core/db/schema/index.ts";
import type { DrizzleDb } from "../core/db/factory.ts";
import type {
  AuditCategory,
  AuditIssue,
  AuditResult,
  AuditStore,
} from "../core/types.ts";
import { AuditMap } from "./audits.ts";
import {
  computeAuditScore,
  formatAuditSummary,
} from "../core/audit-scoring.ts";
import {
  computeProviderModelCost,
  type ModelPricingKey,
} from "../core/usage.ts";
import { getKernelSettings, providerFor } from "../core/config.ts";

const AUDIT_SESSION_ID = "__audit__";

type AuditRow = typeof genieAuditResultsTable.$inferSelect;

function rowToResult(r: AuditRow): AuditResult {
  return {
    id: r.id,
    category: r.category as AuditCategory,
    status: r.status as AuditResult["status"],
    startedAt: r.startedAt,
    completedAt: r.completedAt ?? null,
    issues: (r.issues ?? []) as AuditIssue[],
    summary: r.summary,
    score: r.score ?? null,
    metadata: {
      ...(r.metadata as Record<string, unknown> ?? {}),
      model: r.model,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      cacheCreationInputTokens: r.cacheCreationInputTokens,
      cacheReadInputTokens: r.cacheReadInputTokens,
      durationMs: r.durationMs,
      costUsd: r.costUsd,
    },
    error: r.error ?? undefined,
  };
}

export class AuditManager implements AuditStore {
  private cache = new AuditMap();

  constructor(private db: DrizzleDb) {}

  async loadFromDb(): Promise<void> {
    const rows = await this.db
      .select()
      .from(genieAuditResultsTable)
      .orderBy(desc(genieAuditResultsTable.startedAt));

    this.cache.clear();
    for (const row of rows) {
      this.cache.store(rowToResult(row));
    }
  }

  async store(result: AuditResult): Promise<void> {
    const model = String(result.metadata?.model ?? "unknown");
    const inputTokens = Number(result.metadata?.inputTokens ?? 0);
    const outputTokens = Number(result.metadata?.outputTokens ?? 0);
    const cacheCreation = Number(
      result.metadata?.cacheCreationInputTokens ?? 0,
    );
    const cacheRead = Number(result.metadata?.cacheReadInputTokens ?? 0);
    const durationMs = Number(result.metadata?.durationMs ?? 0);
    // Re-cost against the audit's own recorded time (completion, else start), not
    // report-time now: this store path can run on backfilled/replayed results, and
    // a date-boxed intro price must be applied by when the usage happened.
    const usageAt = new Date(result.completedAt ?? result.startedAt);
    const metadataCostUsd = result.metadata?.costUsd;
    const hasMetadataCost = typeof metadataCostUsd === "number" &&
      Number.isFinite(metadataCostUsd);
    const hasUsageMetadata = "model" in result.metadata ||
      "inputTokens" in result.metadata ||
      "outputTokens" in result.metadata ||
      "cacheCreationInputTokens" in result.metadata ||
      "cacheReadInputTokens" in result.metadata;
    const provider = metadataProvider(result.metadata.provider) ??
      providerFor(model);
    const computedCost = hasUsageMetadata
      ? computeProviderModelCost({
        provider,
        model,
        inputTokens,
        outputTokens,
        cacheCreationInputTokens: cacheCreation,
        cacheReadInputTokens: cacheRead,
        asOf: usageAt,
      })
      : null;
    const pricingStatus = result.metadata?.pricingStatus === "priced" ||
        result.metadata?.pricingStatus === "unpriced"
      ? result.metadata.pricingStatus
      : computedCost?.pricingStatus;
    const costUsd = pricingStatus === "unpriced"
      ? 0
      : hasMetadataCost
      ? metadataCostUsd
      : computedCost?.costUsd ?? 0;
    const metadata = pricingStatus
      ? { ...result.metadata, provider, pricingStatus, costUsd }
      : hasUsageMetadata
      ? { ...result.metadata, provider }
      : result.metadata;
    const storedResult: AuditResult = { ...result, metadata };

    await this.db
      .insert(genieAuditResultsTable)
      .values({
        id: result.id,
        category: result.category,
        status: result.status,
        startedAt: result.startedAt,
        completedAt: result.completedAt,
        issues: result.issues,
        summary: result.summary,
        score: result.score,
        metadata,
        error: result.error,
        durationMs,
        model,
        inputTokens,
        outputTokens,
        cacheCreationInputTokens: cacheCreation,
        cacheReadInputTokens: cacheRead,
        costUsd,
      })
      .onConflictDoUpdate({
        target: genieAuditResultsTable.id,
        set: {
          status: result.status,
          completedAt: result.completedAt,
          issues: result.issues,
          summary: result.summary,
          score: result.score,
          metadata,
          error: result.error,
          durationMs,
          model,
          inputTokens,
          outputTokens,
          cacheCreationInputTokens: cacheCreation,
          cacheReadInputTokens: cacheRead,
          costUsd,
        },
      });

    if (result.status === "complete" && inputTokens > 0) {
      await this.recordUsage(
        result,
        model,
        inputTokens,
        outputTokens,
        cacheCreation,
        cacheRead,
        durationMs,
        costUsd,
      );
    }

    this.cache.store(storedResult);
    await this.pruneCategory(result.category);
  }

  get(id: string): AuditResult | undefined {
    return this.cache.get(id);
  }

  latest(category: AuditCategory): AuditResult | undefined {
    return this.cache.latest(category);
  }

  listByCategory(category: AuditCategory): AuditResult[] {
    return this.cache.listByCategory(category);
  }

  list(): AuditResult[] {
    return this.cache.list();
  }

  async clearCategory(category: AuditCategory): Promise<void> {
    const rows = await this.db
      .select({ id: genieAuditResultsTable.id })
      .from(genieAuditResultsTable)
      .where(eq(genieAuditResultsTable.category, category));

    if (rows.length > 0) {
      const ids = rows.map((r) => r.id);
      const turnIds = rows.map((r) => `audit-${r.id}`);
      await this.db.delete(genieModelUsageTable).where(
        inArray(genieModelUsageTable.auditResultId, ids),
      );
      await this.db.delete(genieTurnUsageTable).where(
        inArray(genieTurnUsageTable.turnId, turnIds),
      );
      await this.db.delete(genieAuditResultsTable).where(
        eq(genieAuditResultsTable.category, category),
      );
    }

    this.cache.clearCategory(category);
  }

  async removeIssue(auditId: string, issueIndex: number): Promise<boolean> {
    const result = this.cache.get(auditId);
    if (!result || issueIndex < 0 || issueIndex >= result.issues.length) {
      return false;
    }

    result.issues.splice(issueIndex, 1);
    result.score = computeAuditScore(result.issues);
    result.summary = formatAuditSummary(result.issues);

    await this.db
      .update(genieAuditResultsTable)
      .set({
        issues: result.issues,
        score: result.score,
        summary: result.summary,
      })
      .where(eq(genieAuditResultsTable.id, auditId));

    return true;
  }

  async clearIssues(auditId: string): Promise<boolean> {
    const result = this.cache.get(auditId);
    if (!result) return false;

    result.issues = [];
    result.score = 100;
    result.summary = "No issues found";

    await this.db
      .update(genieAuditResultsTable)
      .set({
        issues: [],
        score: 100,
        summary: "No issues found",
      })
      .where(eq(genieAuditResultsTable.id, auditId));

    return true;
  }

  async clear(): Promise<void> {
    await this.db.delete(genieTurnUsageTable).where(
      eq(genieTurnUsageTable.sessionId, AUDIT_SESSION_ID),
    );
    await this.db.delete(genieModelUsageTable).where(
      eq(genieModelUsageTable.caller, "audit"),
    );
    await this.db.delete(genieAuditResultsTable);
    this.cache.clear();
  }

  private async ensureAuditSession(): Promise<void> {
    await this.db
      .insert(genieSessionsTable)
      .values({
        id: AUDIT_SESSION_ID,
        name: "Audit Runs",
        startedAt: new Date().toISOString(),
        archived: true,
      })
      .onConflictDoNothing();
  }

  private async recordUsage(
    result: AuditResult,
    model: string,
    inputTokens: number,
    outputTokens: number,
    cacheCreation: number,
    cacheRead: number,
    durationMs: number,
    costUsd: number,
  ): Promise<void> {
    await this.ensureAuditSession();

    const turnId = `audit-${result.id}`;
    await this.db
      .insert(genieTurnUsageTable)
      .values({
        turnId,
        sessionId: AUDIT_SESSION_ID,
        model,
        startedAt: result.startedAt,
        endedAt: result.completedAt ?? result.startedAt,
        durationMs,
        inputTokens,
        outputTokens,
        cacheCreationInputTokens: cacheCreation,
        cacheReadInputTokens: cacheRead,
        toolCallsCount: 0,
        costUsd,
      })
      .onConflictDoUpdate({
        target: genieTurnUsageTable.turnId,
        set: {
          model,
          startedAt: result.startedAt,
          endedAt: result.completedAt ?? result.startedAt,
          durationMs,
          inputTokens,
          outputTokens,
          cacheCreationInputTokens: cacheCreation,
          cacheReadInputTokens: cacheRead,
          costUsd,
        },
      });
  }

  private async pruneCategory(category: AuditCategory): Promise<void> {
    const maxResults = getKernelSettings().maxAuditResults;
    const staleRows = await this.db
      .select({ id: genieAuditResultsTable.id })
      .from(genieAuditResultsTable)
      .where(eq(genieAuditResultsTable.category, category))
      .orderBy(desc(genieAuditResultsTable.startedAt))
      .offset(maxResults);

    if (staleRows.length === 0) return;

    const ids = staleRows.map((r) => r.id);
    const turnIds = ids.map((id) => `audit-${id}`);

    await this.db.delete(genieModelUsageTable).where(
      inArray(genieModelUsageTable.auditResultId, ids),
    );
    await this.db.delete(genieTurnUsageTable).where(
      inArray(genieTurnUsageTable.turnId, turnIds),
    );
    await this.db.delete(genieAuditResultsTable).where(
      inArray(genieAuditResultsTable.id, ids),
    );

    for (const id of ids) {
      this.cache.removeById(id);
    }
  }
}

function metadataProvider(
  value: unknown,
): ModelPricingKey["provider"] | undefined {
  return value === "anthropic" || value === "openai" ? value : undefined;
}
