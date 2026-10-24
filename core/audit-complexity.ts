// @layer core — deterministic complexity metric consumed by core qc; NOT a
// verification audit (deviation from §6's audit-* blanket, see layers.ts).
import type { Kernel } from "./registries.ts";
import type { AuditIssue, AuditSeverity } from "./types.ts";
import { computeAuditScore, formatAuditSummary } from "./audit-scoring.ts";

export interface ComplexityMetrics {
  name: string;
  kind: "handler" | "function";
  cyclomaticComplexity: number;
  lineCount: number;
  maxNestingDepth: number;
  parameterCount: number;
}

const DECISION_POINTS = /\b(?:if|else\s+if|case|for|while|do|catch)\b/g;
const LOGICAL_OPS = /&&|\|\||\?\?/g;
const TERNARY = /[^?]\?[^?:]+:/g;

const COMPLEXITY_THRESHOLDS: Array<{ max: number; severity: AuditSeverity }> = [
  { max: 10, severity: "info" },
  { max: 20, severity: "medium" },
  { max: 30, severity: "high" },
  { max: Infinity, severity: "critical" },
];

function stripStringsAndComments(source: string): string {
  return source
    .replace(/\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/`(?:[^`\\]|\\.)*`/g, "``");
}

function countMatches(source: string, pattern: RegExp): number {
  const matches = source.match(pattern);
  return matches?.length ?? 0;
}

// Only count braces that open a control-flow / function block — a brace after
// `)` or `=>`, or following else/do/try/finally. Object literals and
// destructuring (`{` after `=`, `(`, `,`, `:`, `[`, `return`) no longer
// inflate the depth. A stack tracks which braces counted so `}` decrements
// correctly. The outer function body is discounted via `- 1`, as before.
function computeMaxNestingDepth(source: string): number {
  let maxDepth = 0;
  let currentDepth = 0;
  const counted: boolean[] = [];
  const blockKeyword = /(?:\belse|\bdo|\btry|\bfinally)\s*$/;
  let prevNonSpace = "";
  for (let i = 0; i < source.length; i++) {
    const ch = source[i]!;
    if (ch === "{") {
      const isBlock = prevNonSpace === ")" || prevNonSpace === ">" ||
        blockKeyword.test(source.slice(0, i));
      counted.push(isBlock);
      if (isBlock) {
        currentDepth++;
        if (currentDepth > maxDepth) maxDepth = currentDepth;
      }
    } else if (ch === "}") {
      if (counted.pop()) currentDepth = Math.max(0, currentDepth - 1);
    }
    if (!/\s/.test(ch)) prevNonSpace = ch;
  }
  return Math.max(0, maxDepth - 1);
}

function countParameters(source: string): number {
  const fnMatch = source.match(
    /(?:async\s+)?function\s*\w*\s*\(([^)]*)\)|(?:async\s+)?\(([^)]*)\)\s*(?:=>|:)/,
  );
  if (!fnMatch) return 0;
  const params = fnMatch[1] ?? fnMatch[2] ?? "";
  if (params.trim() === "") return 0;
  return params.split(",").length;
}

export function calculateComplexity(
  source: string,
  name: string,
  kind: "handler" | "function",
): ComplexityMetrics {
  const stripped = stripStringsAndComments(source);
  const decisions = countMatches(stripped, DECISION_POINTS);
  const logicalOps = countMatches(stripped, LOGICAL_OPS);
  const ternaries = countMatches(stripped, TERNARY);

  return {
    name,
    kind,
    cyclomaticComplexity: 1 + decisions + logicalOps + ternaries,
    lineCount: source.split("\n").length,
    maxNestingDepth: computeMaxNestingDepth(stripped),
    parameterCount: countParameters(source),
  };
}

function severityForComplexity(cc: number): AuditSeverity {
  for (const t of COMPLEXITY_THRESHOLDS) {
    if (cc <= t.max) return t.severity;
  }
  return "critical";
}

export interface ComplexityResult {
  issues: AuditIssue[];
  summary: string;
  score: number;
  entityCount: number;
  metrics: ComplexityMetrics[];
}

export function auditComplexity(kernel: Kernel): ComplexityResult {
  const issues: AuditIssue[] = [];
  const allMetrics: ComplexityMetrics[] = [];

  function auditEntity(
    source: string,
    name: string,
    kind: "handler" | "function",
  ) {
    const metrics = calculateComplexity(source, name, kind);
    allMetrics.push(metrics);
    const entity = `${kind}:${name}`;

    if (metrics.cyclomaticComplexity > 10) {
      issues.push({
        severity: severityForComplexity(metrics.cyclomaticComplexity),
        rule: "high-complexity",
        message:
          `Cyclomatic complexity ${metrics.cyclomaticComplexity} (${metrics.lineCount} lines, max nesting ${metrics.maxNestingDepth})`,
        entity,
        suggestion: "Extract complex logic into smaller functions",
      });
    }

    if (metrics.maxNestingDepth > 4) {
      issues.push({
        severity: metrics.maxNestingDepth > 6 ? "high" : "medium",
        rule: "deep-nesting",
        message:
          `Nesting depth ${metrics.maxNestingDepth} (max recommended: 4)`,
        entity,
        suggestion: "Use early returns or extract nested blocks into functions",
      });
    }

    if (metrics.parameterCount > 5) {
      issues.push({
        severity: "low",
        rule: "too-many-parameters",
        message: `${metrics.parameterCount} parameters (max recommended: 5)`,
        entity,
        suggestion: "Group related parameters into an options object",
      });
    }
  }

  for (const h of kernel.handlers.list()) {
    auditEntity(h.source, h.name, "handler");
  }
  for (const f of kernel.functions.list()) {
    auditEntity(f.source, f.name, "function");
  }

  const score = computeAuditScore(issues);
  const summary = issues.length === 0
    ? `All ${allMetrics.length} entities have acceptable complexity`
    : formatAuditSummary(issues);

  return {
    issues,
    summary,
    score,
    entityCount: allMetrics.length,
    metrics: allMetrics,
  };
}

export function checkComplexity(
  source: string,
): { level: "warning"; message: string } | null {
  const stripped = stripStringsAndComments(source);
  const decisions = countMatches(stripped, DECISION_POINTS);
  const logicalOps = countMatches(stripped, LOGICAL_OPS);
  const ternaries = countMatches(stripped, TERNARY);
  const cc = 1 + decisions + logicalOps + ternaries;

  if (cc > 20) {
    return {
      level: "warning",
      message:
        `Cyclomatic complexity is ${cc} (recommended max: 20). Consider splitting into smaller functions.`,
    };
  }
  return null;
}
