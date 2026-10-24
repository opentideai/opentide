import { assertEquals } from "@std/assert";
import {
  TARGET_DENO_SOURCE,
  TARGET_NODE,
} from "./production-build.ts";
import {
  DENO_LOCK_REFRESH_FAILED,
  type LockRefreshReport,
} from "./production-lock-refresh.ts";
import type { RefreshTargetKey } from "../shared/lock-refresh.ts";
import { projectLockRefreshReport } from "./production-lock-refresh-report.ts";

// Slice 7.2 (docs/production-output-hardening-plan.md → Milestone 7):
// projectLockRefreshReport is pure, total, never-throws, and deterministic — it
// PROJECTS the producer's LockRefreshReport onto the serializable LockRefreshResult
// wire DTO without regenerating a lock or re-hashing a byte. The producer↔gate
// round-trips are exercised by production-lock-refresh_test.ts; here we prove the
// projection in isolation.

// --- Both-refreshed happy path ------------------------------------------------

Deno.test("projectLockRefreshReport: both targets refreshed → ok, order preserved, no codes", () => {
  const report: LockRefreshReport = {
    ok: true,
    targets: [
      { target: TARGET_DENO_SOURCE, status: "refreshed", detail: "Refreshed deno.lock (5 specifiers); frozen-valid." },
      { target: TARGET_NODE, status: "refreshed", detail: "Refreshed package-lock.json (12 packages); frozen-valid." },
    ],
  };
  const dto = projectLockRefreshReport(report);

  assertEquals(dto.ok, true);
  assertEquals(dto.targets.map((t) => t.target), [
    TARGET_DENO_SOURCE,
    TARGET_NODE,
  ]);
  assertEquals(dto.targets.map((t) => t.status), ["refreshed", "refreshed"]);
  // No failure ⇒ no code field is serialized (omitted, not `code: undefined`).
  for (const t of dto.targets) {
    assertEquals("code" in t, false);
  }
});

// --- A skipped + a failed target ----------------------------------------------

Deno.test("projectLockRefreshReport: skipped + failed → ok false, failed carries its code", () => {
  const report: LockRefreshReport = {
    ok: false,
    targets: [
      { target: TARGET_DENO_SOURCE, status: "skipped", detail: "target not selected" },
      {
        target: TARGET_NODE,
        status: "failed",
        code: DENO_LOCK_REFRESH_FAILED,
        detail: "npm lock generation failed (exit code 1).",
      },
    ],
  };
  const dto = projectLockRefreshReport(report);

  assertEquals(dto.ok, false);
  assertEquals(dto.targets[0]!.status, "skipped");
  assertEquals("code" in dto.targets[0]!, false);
  assertEquals(dto.targets[1]!.status, "failed");
  assertEquals(dto.targets[1]!.code, DENO_LOCK_REFRESH_FAILED);
  assertEquals(dto.targets[1]!.detail, "npm lock generation failed (exit code 1).");
});

// --- Fresh objects, not the report's ------------------------------------------

Deno.test("projectLockRefreshReport: emits fresh objects the DTO owns", () => {
  const report: LockRefreshReport = {
    ok: true,
    targets: [
      { target: TARGET_DENO_SOURCE, status: "refreshed", detail: "ok" },
    ],
  };
  const dto = projectLockRefreshReport(report);
  assertEquals(dto.targets[0] === report.targets[0], false);
});

// --- Determinism --------------------------------------------------------------

Deno.test("projectLockRefreshReport: same report → byte-identical DTO", () => {
  const report: LockRefreshReport = {
    ok: false,
    targets: [
      { target: TARGET_DENO_SOURCE, status: "refreshed", detail: "ok" },
      { target: TARGET_NODE, status: "failed", code: "X", detail: "boom" },
    ],
  };
  assertEquals(
    JSON.stringify(projectLockRefreshReport(report)),
    JSON.stringify(projectLockRefreshReport(report)),
  );
});

// --- Target-key alignment pin -------------------------------------------------

Deno.test("RefreshTargetKey literals match the TARGET_* constants (single source of truth)", () => {
  // Compile-time: each refreshable TARGET_* constant must be assignable to
  // RefreshTargetKey (and binary is deliberately NOT — it has no lock).
  const deno: RefreshTargetKey = TARGET_DENO_SOURCE;
  const node: RefreshTargetKey = TARGET_NODE;
  // Runtime: the literal strings themselves.
  assertEquals([deno, node], ["deno-source", "node"]);
});
