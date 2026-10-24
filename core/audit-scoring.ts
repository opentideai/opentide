// @layer core — deterministic audit scoring primitives. Pure functions over
// audit issues (no model, no config), consumed by core qc/audit-complexity and
// by the verification/agent audit machinery, so they live in core.
import type { AuditResult } from "./types.ts";

export function computeAuditScore(issues: AuditResult["issues"]): number {
  let score = 100;
  for (const issue of issues) {
    switch (issue.severity) {
      case "critical":
        score -= 20;
        break;
      case "high":
        score -= 10;
        break;
      case "medium":
        score -= 5;
        break;
      case "low":
        score -= 2;
        break;
    }
  }
  return Math.max(0, score);
}

export function formatAuditSummary(issues: AuditResult["issues"]): string {
  if (issues.length === 0) return "No issues found";
  const counts: Record<string, number> = {};
  for (const i of issues) {
    counts[i.severity] = (counts[i.severity] ?? 0) + 1;
  }
  const parts: string[] = [];
  for (const sev of ["critical", "high", "medium", "low", "info"] as const) {
    if (counts[sev]) parts.push(`${counts[sev]} ${sev}`);
  }
  return parts.join(", ");
}
