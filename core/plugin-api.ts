// @layer core — what a closed plugin (Tide's brain, reviewers and auth) may use
// from the kernel, beyond the seam modules it implements. Tide's production code
// imports OpenTide only through this file and the entry modules listed in
// docs/two-repo-plan.md; tide/import-contract_test.ts enforces it.
//
// A change here is a change to OpenTide's plugin contract: a minor version bump,
// with a line in the release notes.
import { getTelemetrySettings } from "./config.ts";

// One-shot model calls by role.
export {
  callRoleModel,
  MODEL_UNCONFIGURED_MESSAGE,
  type ModelCallCost,
  modelCallCost,
  type ModelCallTokens,
  type ModelRole,
  roleModel,
  type RoleModelRequest,
  type RoleModelStatus,
  roleModelStatus,
} from "./role-model.ts";
export type {
  UtilityModelAccounting,
  UtilityModelCall,
} from "./utility-model.ts";

// Protocol constants open code also enforces.
export {
  DEFAULT_MODEL_ID,
  HANDOFF_MARKER,
  INDEPENDENT_CRITERIA_MAX,
  type ModelProviderId,
  REFUTE_ATTEMPTS_DEFAULT,
} from "./config.ts";

// Domain types the agents read and return.
export type {
  AuditIssue,
  AuditSeverity,
  Changeset,
  ChangesetReadiness,
  ChangesetStep,
  ModelUsageRecord,
  ProposedCriterion,
  RecordModelUsageInput,
  Result,
  VerificationClaim,
} from "./types.ts";

// The marker the loop wraps injected context in; the brain strips it.
export { stripModelContextContent } from "./util.ts";

// OpenTide's env var names (OPENTIDE_*, with the old GENIE_* still read).
export { readEnv } from "./process-env.ts";

// The local user, for an AuthProvider with login off.
export { type CurrentUser, localUser } from "./auth.ts";

// This installation's id, for an account service that ties logins to a machine.
export function getInstallationId(): string {
  return getTelemetrySettings().installationId;
}
