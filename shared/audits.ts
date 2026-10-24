// @layer shared — L0, the OpenTide *open* wire contract for audit results: the
// shape the audit surface serves to the IDE (run/list audit endpoints). Type-only;
// imports NOTHING. The result shape is open — deterministic audits (verification)
// and model-backed audits (agent) both produce it, but the wire contract for
// displaying results is part of the open surface. Consumed by the Deno backend
// (re-exported from core/types.ts) and the IDE (`$shared` alias).

export type AuditSeverity = "critical" | "high" | "medium" | "low" | "info";

export type BuiltInAuditCategory =
  | "security"
  | "performance"
  | "seo"
  | "accessibility"
  | "code-quality";
// A built-in category or any custom category name. The `(string & {})` keeps the
// built-in literals as autocomplete hints while still accepting any string.
export type AuditCategory =
  | BuiltInAuditCategory
  // `string & Record<never, never>` is `string` that still shows the literals above
  // in autocomplete. The usual spelling is `string & {}`, which trips ban-types.
  | (string & Record<never, never>);

export type AuditStatus = "pending" | "running" | "complete" | "error";

export interface AuditIssue {
  severity: AuditSeverity;
  rule: string;
  message: string;
  entity?: string;
  line?: number;
  suggestion?: string;
}

export interface AuditResult {
  id: string;
  category: AuditCategory;
  status: AuditStatus;
  startedAt: string;
  completedAt: string | null;
  issues: AuditIssue[];
  summary: string;
  score: number | null;
  metadata: Record<string, unknown>;
  error?: string;
}
