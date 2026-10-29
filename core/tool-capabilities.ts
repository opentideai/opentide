// Tool-capability contracts (OpenTide §3.3). `tools/dispatch.ts` is core (L1) but
// a handful of tool handlers need behavior owned by a higher layer: audits and
// changeset governance (verification, L2). Rather than import upward, dispatch reads the handlers off the
// Kernel's composition (composition.ts) via the getters below; the composition
// root supplies the concrete implementations (cli/assembly.ts).
//
// This mirrors the store-factory seam (composition.ts): core declares the
// contract and the getter, the composition carries the implementation, and no
// core module ever imports the verification/agent functions directly.
import type { Kernel } from "./registries.ts";
import type { CompositionContext } from "./composition.ts";
import type { ChangeRecord } from "./changelog.ts";
import type {
  AgentAuditConfig,
  ChangeClass,
  Changeset,
  ChangesetPlan,
  ChangesetReadiness,
  PackageInput,
  PackageSecurityResult,
  ProportionalVerification,
  ReadinessEnforcement,
  VerificationTier,
} from "./types.ts";

// The verification-owned tool handlers (audits + changeset governance).
export interface VerificationToolHandlers {
  // A category's audit configuration, built-in or custom, for review packets.
  auditConfig(category: string, kernel: Kernel): AgentAuditConfig | undefined;
  auditCategories(kernel: Kernel): string[];
  auditPackages(packages: PackageInput[]): Promise<PackageSecurityResult>;
  formatChangesetContext(changeset: Changeset, changes: ChangeRecord[]): string;
  stripChangeSnapshots(change: ChangeRecord): ChangeRecord;
  checkChangesetReadiness(
    changeset: Changeset,
    currentFingerprints?: Record<string, string>,
    enforcement?: ReadinessEnforcement,
  ): ChangesetReadiness;
  validateChangesetPlan(plan: ChangesetPlan): string | null;
  // Proportional verification (verification/change-class.ts). `resolveChangeClass`
  // adjudicates the agent's declared tier into a kernel ChangeClass and, for the
  // light lane, authors the acceptance criterion + planned check the agent no longer
  // has to; `verifyChangeClass` re-adjudicates it at the completion gate against the
  // changeset's actual ChangeRecords.
  resolveChangeClass(
    declared: VerificationTier | undefined,
    plan: ChangesetPlan,
    mode: ProportionalVerification,
  ): { changeClass: ChangeClass; plan: ChangesetPlan; issue: string | null };
  verifyChangeClass(
    current: ChangeClass | undefined,
    records: readonly ChangeRecord[],
  ): ChangeClass;
}

const NO_HANDLERS =
  "No tool handlers in the Kernel's composition — assemble them via the " +
  "composition root (cli/assembly.ts; testComposition() in tests) before " +
  "dispatching.";

export function verificationTools(
  composition: CompositionContext,
): VerificationToolHandlers {
  if (!composition.verificationTools) throw new Error(NO_HANDLERS);
  return composition.verificationTools;
}

// Non-throwing introspection: whether a capability class is assembled. Used by
// the outbound MCP projection (mcp-projection.ts) to hide tool verbs whose
// handlers are entirely absent, instead of advertising a tool that would throw
// on call. (A model-backed tool whose handler IS registered but has no API key
// degrades gracefully at call time — that is orthogonal to registration.)
export function hasVerificationTools(composition: CompositionContext): boolean {
  return composition.verificationTools !== null;
}

// Which upper-layer capability class a tool verb requires: `verification` = the
// verb's dispatch path calls verificationTools() (audits + changeset
// governance). The server calls no agent, so that is the only class.
export type ToolCapability = "verification";

// Authoritative, per-verb capability requirement — the single source of truth
// for which handler class a tool verb needs, co-located with the getters it
// mirrors. A verb listed here is one whose dispatch path calls the matching
// getter and therefore throws NO_HANDLERS when that layer is absent; the
// outbound MCP projection (mcp-projection.ts) reads this to hide such verbs from
// an assembly that cannot run them, so the advertised list can never drift from
// what the running assembly can dispatch.
//
// tools/dispatch.ts is the ground truth; a drift guard (mcp-projection_test.ts)
// derives the getter call-sites from that source and asserts this map matches
// them in both directions, so a new capability-gated verb cannot silently desync.
export const TOOL_CAPABILITY_REQUIREMENTS: Readonly<
  Record<string, ToolCapability>
> = {
  request_review: "verification",
  check_package_security: "verification",
  get_changeset_context: "verification",
  check_changeset_readiness: "verification",
  create_changeset: "verification",
  update_changeset_plan: "verification",
  amend_changeset_plan: "verification",
  complete_changeset: "verification",
  record_verification_run: "verification",
};

// Whether the capability a verb requires is assembled in this build. A verb with
// no declared requirement is always available (read verbs, and plain mutation
// verbs whose only gate is the changeset store + the dispatch CHANGESET_REQUIRED
// backstop). Non-throwing, like hasVerificationTools(), so the projection
// advertises exactly the callable surface.
export function isToolCapabilityAvailable(
  composition: CompositionContext,
  name: string,
): boolean {
  return !TOOL_CAPABILITY_REQUIREMENTS[name] ||
    hasVerificationTools(composition);
}
