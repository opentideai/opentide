// @layer verification — the verification-owned tool handlers (audits +
// changeset governance). This is the one place that gathers these functions into
// the tool-capability shape; the composition roots (cli/assembly.ts) carry them as
// the Kernel's composition.verificationTools so core's tools/dispatch.ts never
// depends upward on the verification layer (§3.2).
import type { VerificationToolHandlers } from "../core/tool-capabilities.ts";
import { auditCategories, auditConfig } from "./audit-runner.ts";
import { auditPackages } from "./audit-packages.ts";
import {
  formatChangesetContext,
  stripChangeSnapshots,
} from "./changeset-context.ts";
import {
  checkChangesetReadiness,
  validateChangesetPlan,
} from "./changesets.ts";
import { resolveChangeClass, verifyChangeClass } from "./change-class.ts";

export const defaultVerificationToolHandlers: VerificationToolHandlers = {
  auditConfig,
  auditCategories,
  auditPackages,
  formatChangesetContext,
  stripChangeSnapshots,
  checkChangesetReadiness,
  validateChangesetPlan,
  resolveChangeClass,
  verifyChangeClass,
};
