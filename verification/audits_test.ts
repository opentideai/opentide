import { assertEquals } from "@std/assert";
import { AuditMap } from "./audits.ts";
import {
  computeAuditScore,
  formatAuditSummary,
} from "../core/audit-scoring.ts";
import type { AuditIssue, AuditResult } from "../core/types.ts";

Deno.test("AuditMap store and retrieve", () => {
  const map = new AuditMap();
  const result: AuditResult = {
    id: "test-1",
    category: "security",
    status: "complete",
    startedAt: "2026-01-01T00:00:00Z",
    completedAt: "2026-01-01T00:00:01Z",
    issues: [],
    summary: "No issues found",
    score: 100,
    metadata: {},
  };
  map.store(result);
  assertEquals(map.get("test-1"), result);
  assertEquals(map.get("nonexistent"), undefined);
});

Deno.test("AuditMap latest returns most recent by category", () => {
  const map = new AuditMap();
  const older: AuditResult = {
    id: "old",
    category: "security",
    status: "complete",
    startedAt: "2026-01-01T00:00:00Z",
    completedAt: "2026-01-01T00:00:01Z",
    issues: [],
    summary: "No issues",
    score: 100,
    metadata: {},
  };
  const newer: AuditResult = {
    id: "new",
    category: "security",
    status: "complete",
    startedAt: "2026-01-02T00:00:00Z",
    completedAt: "2026-01-02T00:00:01Z",
    issues: [{ severity: "high", rule: "test", message: "test" }],
    summary: "1 high",
    score: 90,
    metadata: {},
  };
  map.store(older);
  map.store(newer);
  assertEquals(map.latest("security")?.id, "new");
  assertEquals(map.latest("performance"), undefined);
});

Deno.test("AuditMap listByCategory filters correctly", () => {
  const map = new AuditMap();
  map.store({
    id: "s1",
    category: "security",
    status: "complete",
    startedAt: "2026-01-01T00:00:00Z",
    completedAt: "2026-01-01T00:00:01Z",
    issues: [],
    summary: "",
    score: 100,
    metadata: {},
  });
  map.store({
    id: "p1",
    category: "performance",
    status: "complete",
    startedAt: "2026-01-01T00:00:00Z",
    completedAt: "2026-01-01T00:00:01Z",
    issues: [],
    summary: "",
    score: 100,
    metadata: {},
  });
  map.store({
    id: "s2",
    category: "security",
    status: "complete",
    startedAt: "2026-01-02T00:00:00Z",
    completedAt: "2026-01-02T00:00:01Z",
    issues: [],
    summary: "",
    score: 100,
    metadata: {},
  });

  const securityResults = map.listByCategory("security");
  assertEquals(securityResults.length, 2);
  assertEquals(securityResults[0]!.id, "s2");

  const perfResults = map.listByCategory("performance");
  assertEquals(perfResults.length, 1);
});

Deno.test("AuditMap list returns all sorted descending", () => {
  const map = new AuditMap();
  map.store({
    id: "a",
    category: "security",
    status: "complete",
    startedAt: "2026-01-01T00:00:00Z",
    completedAt: null,
    issues: [],
    summary: "",
    score: null,
    metadata: {},
  });
  map.store({
    id: "b",
    category: "performance",
    status: "complete",
    startedAt: "2026-01-03T00:00:00Z",
    completedAt: null,
    issues: [],
    summary: "",
    score: null,
    metadata: {},
  });
  map.store({
    id: "c",
    category: "seo",
    status: "complete",
    startedAt: "2026-01-02T00:00:00Z",
    completedAt: null,
    issues: [],
    summary: "",
    score: null,
    metadata: {},
  });

  const all = map.list();
  assertEquals(all.length, 3);
  assertEquals(all[0]!.id, "b");
  assertEquals(all[1]!.id, "c");
  assertEquals(all[2]!.id, "a");
});

Deno.test("AuditMap clear empties all results", () => {
  const map = new AuditMap();
  map.store({
    id: "x",
    category: "security",
    status: "complete",
    startedAt: "2026-01-01T00:00:00Z",
    completedAt: null,
    issues: [],
    summary: "",
    score: null,
    metadata: {},
  });
  assertEquals(map.list().length, 1);
  map.clear();
  assertEquals(map.list().length, 0);
});

Deno.test("computeAuditScore calculates correctly", () => {
  const issues: AuditIssue[] = [
    { severity: "critical", rule: "a", message: "a" },
    { severity: "high", rule: "b", message: "b" },
    { severity: "medium", rule: "c", message: "c" },
    { severity: "low", rule: "d", message: "d" },
    { severity: "info", rule: "e", message: "e" },
  ];
  assertEquals(computeAuditScore(issues), 100 - 20 - 10 - 5 - 2);
  assertEquals(computeAuditScore([]), 100);
});

Deno.test("computeAuditScore floors at 0", () => {
  const issues: AuditIssue[] = Array.from({ length: 10 }, (_, i) => ({
    severity: "critical" as const,
    rule: `rule-${i}`,
    message: `msg-${i}`,
  }));
  assertEquals(computeAuditScore(issues), 0);
});

Deno.test("formatAuditSummary groups by severity", () => {
  const issues: AuditIssue[] = [
    { severity: "high", rule: "a", message: "a" },
    { severity: "high", rule: "b", message: "b" },
    { severity: "low", rule: "c", message: "c" },
  ];
  assertEquals(formatAuditSummary(issues), "2 high, 1 low");
  assertEquals(formatAuditSummary([]), "No issues found");
});
