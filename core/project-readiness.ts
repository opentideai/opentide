import type {
  Changeset,
  ChangesetReadiness,
  ChangesetReadinessIssue,
  ReadinessEnforcement,
} from "./types.ts";
import { currentFingerprints } from "./fingerprint.ts";
import { getKernelSettings } from "./config.ts";
import type { Kernel } from "./registries.ts";
import { doctorProject, type DoctorReport } from "./project-doctor.ts";
import { docsDriftIssues, readDocsDrift } from "./docs-drift.ts";
import { verificationTools } from "./tool-capabilities.ts";

function consistencyIssue(
  code: string,
  message: string,
  action: string,
  severity: ChangesetReadinessIssue["severity"],
): ChangesetReadinessIssue {
  return { code, message, action, severity };
}

export function addProjectConsistencyToReadiness(
  readiness: ChangesetReadiness,
  report: DoctorReport,
): ChangesetReadiness {
  const errors = [...readiness.errors];
  const warnings = [...readiness.warnings];
  if (report.errors.length > 0) {
    const first = report.errors[0]!;
    errors.push(consistencyIssue(
      "PROJECT_CONSISTENCY_ERRORS",
      `Project consistency check found ${report.errors.length} error(s). First issue: ${first.code}: ${first.message}`,
      "Call project_status to see the consistency errors, fix them, then run check_changeset_readiness again.",
      "error",
    ));
  } else if (report.warnings.length > 0) {
    const first = report.warnings[0]!;
    warnings.push(consistencyIssue(
      "PROJECT_CONSISTENCY_WARNINGS",
      `Project consistency check found ${report.warnings.length} warning(s). First warning: ${first.code}: ${first.message}`,
      "Call project_status and review the consistency warnings before completing the changeset.",
      "warning",
    ));
  }

  return resummarize({
    ...readiness,
    errors,
    warnings,
    checks: {
      ...readiness.checks,
      projectConsistencyErrors: report.errors.length,
      projectConsistencyWarnings: report.warnings.length,
    },
  });
}

/**
 * Recompute `passed` and `summary` from the issue lists. Shared so every fold that appends
 * to errors/warnings reports the same counts — a warning added without this would be
 * returned but not counted in the summary line the agent reads.
 */
function resummarize(readiness: ChangesetReadiness): ChangesetReadiness {
  const passed = readiness.errors.length === 0;
  const summary = passed
    ? readiness.warnings.length === 0
      ? "Changeset is ready to complete."
      : `Changeset is ready to complete with ${readiness.warnings.length} warning(s).`
    : `Changeset is not ready: ${readiness.errors.length} error(s), ${readiness.warnings.length} warning(s).`;
  return { ...readiness, passed, summary };
}

/**
 * Fold AGENT.md drift in as advisory warnings. Never errors: the doc is not the app, and a
 * stale markdown file must not stand between a verified changeset and completion. It is
 * reported at the gate because that is the one moment the agent is already looking at what
 * the change did, and regenerating is a single call away.
 */
export function addDocsDriftToReadiness(
  readiness: ChangesetReadiness,
  issues: ChangesetReadinessIssue[],
): ChangesetReadiness {
  if (issues.length === 0) return readiness;
  return resummarize({
    ...readiness,
    warnings: [...readiness.warnings, ...issues],
  });
}

export async function checkProjectAwareReadiness(
  kernel: Kernel,
  changeset: Changeset,
  enforcement: ReadinessEnforcement = getKernelSettings().readinessEnforcement,
  report?: DoctorReport,
  baseReadiness?: (enforcement: ReadinessEnforcement) => ChangesetReadiness,
): Promise<ChangesetReadiness> {
  const base = baseReadiness
    ? baseReadiness(enforcement)
    : verificationTools(kernel.composition).checkChangesetReadiness(
      changeset,
      currentFingerprints(kernel, changeset),
      enforcement,
    );
  if (!kernel.projectDir) return base;
  const withConsistency = addProjectConsistencyToReadiness(
    base,
    report ?? await doctorProject(kernel.projectDir, kernel.db),
  );
  return addDocsDriftToReadiness(
    withConsistency,
    docsDriftIssues(readDocsDrift(kernel)),
  );
}
