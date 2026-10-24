// @layer verification — audit results store. Scoring primitives live in the core
// audit-scoring.ts; imported here for AuditMap's own use.
import type { AuditCategory, AuditResult } from "../core/types.ts";
import { getKernelSettings } from "../core/config.ts";
import {
  computeAuditScore,
  formatAuditSummary,
} from "../core/audit-scoring.ts";

const MAX_RESULTS_PER_CATEGORY = getKernelSettings().maxAuditResults;

export class AuditMap {
  private results = new Map<string, AuditResult>();
  private latestByCategory = new Map<AuditCategory, AuditResult>();

  store(result: AuditResult): void {
    this.results.set(result.id, result);

    const current = this.latestByCategory.get(result.category);
    if (!current || result.startedAt > current.startedAt) {
      this.latestByCategory.set(result.category, result);
    }

    this.pruneCategory(result.category);
  }

  get(id: string): AuditResult | undefined {
    return this.results.get(id);
  }

  latest(category: AuditCategory): AuditResult | undefined {
    return this.latestByCategory.get(category);
  }

  listByCategory(category: AuditCategory): AuditResult[] {
    return [...this.results.values()]
      .filter((r) => r.category === category)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  list(): AuditResult[] {
    return [...this.results.values()]
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  clearCategory(category: AuditCategory): void {
    for (const [id, r] of this.results) {
      if (r.category === category) this.results.delete(id);
    }
    this.latestByCategory.delete(category);
  }

  removeIssue(auditId: string, issueIndex: number): boolean {
    const result = this.results.get(auditId);
    if (!result || issueIndex < 0 || issueIndex >= result.issues.length) {
      return false;
    }
    result.issues.splice(issueIndex, 1);
    result.score = computeAuditScore(result.issues);
    result.summary = formatAuditSummary(result.issues);
    return true;
  }

  clearIssues(auditId: string): boolean {
    const result = this.results.get(auditId);
    if (!result) return false;
    result.issues = [];
    result.score = 100;
    result.summary = "No issues found";
    return true;
  }

  removeById(id: string): boolean {
    const result = this.results.get(id);
    if (!result) return false;
    this.results.delete(id);
    const latest = this.latestByCategory.get(result.category);
    if (latest?.id === id) {
      const remaining = this.listByCategory(result.category);
      if (remaining.length > 0) {
        this.latestByCategory.set(result.category, remaining[0]!);
      } else {
        this.latestByCategory.delete(result.category);
      }
    }
    return true;
  }

  clear(): void {
    this.results.clear();
    this.latestByCategory.clear();
  }

  private pruneCategory(category: AuditCategory): void {
    const catResults = this.listByCategory(category);
    if (catResults.length <= MAX_RESULTS_PER_CATEGORY) return;
    for (const old of catResults.slice(MAX_RESULTS_PER_CATEGORY)) {
      this.results.delete(old.id);
    }
  }
}
