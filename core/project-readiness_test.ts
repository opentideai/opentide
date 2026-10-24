import { assertEquals } from "@std/assert";
import { addProjectConsistencyToReadiness } from "./project-readiness.ts";
import type { ChangesetReadiness } from "./types.ts";
import type { DoctorReport } from "./project-doctor.ts";

function readiness(): ChangesetReadiness {
  return {
    passed: true,
    changesetId: "cs_1",
    status: "in_progress",
    summary: "Changeset is ready to complete.",
    errors: [],
    warnings: [],
    skipped: [],
    checks: {
      acceptanceCriteria: 1,
      verificationPlan: 1,
      verificationRuns: 1,
      incompleteSteps: 0,
      latestVerificationStatus: "passed",
      evidence: 1,
      claimResults: 1,
      formalSpecs: 0,
      formalSpecsVerified: 0,
      attestations: 0,
      staleAttestations: 0,
      claimsRefuted: 0,
      mustClaimsReviewed: 0,
      projectConsistencyErrors: 0,
      projectConsistencyWarnings: 0,
    },
  };
}

function report(
  errors: DoctorReport["errors"] = [],
  warnings: DoctorReport["warnings"] = [],
): DoctorReport {
  return {
    ok: errors.length === 0,
    errors,
    warnings,
    counts: {
      stateFiles: 0,
      schemas: 0,
      schemaMigrations: 0,
      sessions: 0,
      messages: 0,
      usageRecords: 0,
      changesets: 0,
      changelogRecords: 0,
    },
    sync: {
      shareable: [],
      localOnly: [],
      dataIgnoredByGit: null,
    },
  };
}

Deno.test("project consistency errors block readiness", () => {
  const decorated = addProjectConsistencyToReadiness(
    readiness(),
    report([{
      severity: "error",
      code: "SCHEMA_MIGRATION_ORPHAN",
      path: ".opentide/state/schemas/migrations/agent_events.json",
      message: 'Migration references missing schema "agent_events".',
    }]),
  );

  assertEquals(decorated.passed, false);
  assertEquals(decorated.errors.at(-1)?.code, "PROJECT_CONSISTENCY_ERRORS");
  assertEquals(decorated.checks.projectConsistencyErrors, 1);
});

Deno.test("project consistency warnings stay advisory", () => {
  const decorated = addProjectConsistencyToReadiness(
    readiness(),
    report([], [{
      severity: "warning",
      code: "DATA_NOT_GIT_IGNORED",
      path: "data",
      message: "Local project data is not ignored by Git.",
    }]),
  );

  assertEquals(decorated.passed, true);
  assertEquals(decorated.warnings.at(-1)?.code, "PROJECT_CONSISTENCY_WARNINGS");
  assertEquals(decorated.checks.projectConsistencyWarnings, 1);
});
