// Tool-capability contracts (OpenTide §3.3). `tools/dispatch.ts` is core (L1) but
// a handful of tool handlers need behavior owned by higher layers — deterministic
// audits + changeset governance (verification, L2) and adversarial refutation
// (agent, L3). Rather than import upward, dispatch reads the handlers off the
// Kernel's composition (composition.ts) via the getters below; the composition
// root supplies the concrete implementations (cli/assembly.ts for the open
// stack; tide/assembly.ts adds the agent's).
//
// This mirrors the store-factory seam (composition.ts): core declares the
// contract and the getter, the composition carries the implementation, and no
// core module ever imports the verification/agent functions directly.
import type { Kernel } from "./registries.ts";
import type { CompositionContext } from "./composition.ts";
import type { ChangeRecord } from "./changelog.ts";
import type {
  ImportClassifierRequest,
  ImportClassifierResult,
} from "./codebase/index.ts";
import type {
  AuditCategory,
  AuditResult,
  ChangeClass,
  Changeset,
  ChangesetPlan,
  ChangesetReadiness,
  ClaimRefutationResult,
  IndependentCriteriaResult,
  ModelUsageRecord,
  PackageInput,
  PackageSecurityResult,
  ProportionalVerification,
  ReadinessEnforcement,
  RecordModelUsageInput,
  VerificationClaim,
  VerificationTier,
} from "./types.ts";

// The verification-owned tool handlers (audits + changeset governance).
export interface VerificationToolHandlers {
  executeAudit(
    category: AuditCategory,
    kernel: Kernel,
    options?: Record<string, unknown>,
  ): Promise<AuditResult>;
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

// The agent-owned tool handlers. `opts` is narrowed to the fields dispatch
// actually passes so this contract stays free of the agent's model-injection
// vocabulary (RunRefutationOpts / RefuteModelCall, classifier call seams).
export interface AgentToolHandlers {
  // `changedScopes` are "category:key" scopes for the entities the changeset
  // actually touched (derived by the caller from the changelog). Optional so a
  // caller without changelog access still gets the formal-spec/test narrowing;
  // supplying it keeps the whole-project fallback out of the common path.
  buildClaimContext(
    kernel: Kernel,
    changeset: Changeset,
    claimId: string,
    changedScopes?: readonly string[],
  ): string;
  runClaimRefutation(
    kernel: Kernel,
    claim: VerificationClaim,
    contextCode: string,
    opts: {
      attempts?: number;
      sessionId?: string | null;
      changesetId?: string | null;
    },
  ): Promise<ClaimRefutationResult>;
  // The independent criteria author (agent/criteria-agent.ts). Deliberately takes
  // `request` and `contextCode` rather than reaching into the changeset for them:
  // what the reviewer is allowed to see is the caller's decision, and keeping it
  // in the signature makes "it never sees the agent's claims" checkable here.
  runIndependentCriteria(
    kernel: Kernel,
    changeset: Changeset,
    request: string,
    contextCode: string,
    opts: {
      sessionId?: string | null;
      changesetId?: string | null;
    },
  ): Promise<IndependentCriteriaResult>;
  // The source of the entities a changeset actually touched, for the criteria
  // reviewer's context. Shared with the refuter's changed-scope rung, so the two
  // gate calls present byte-identical code and share a cached prefix.
  buildChangedScopeContext(
    kernel: Kernel,
    scopes: readonly string[],
  ): string;
  runImportClassifier(
    request: ImportClassifierRequest,
    opts?: {
      sessionId?: string | null;
      turnId?: string | null;
      changesetId?: string | null;
      recordUsage?: (
        input: RecordModelUsageInput,
      ) => Promise<ModelUsageRecord>;
    },
  ): Promise<ImportClassifierResult>;
}

const NO_HANDLERS =
  "No tool handlers in the Kernel's composition — assemble them via the " +
  "composition root (cli/assembly.ts; testComposition() in tests) before " +
  "dispatching. Agent handlers exist only in the Tide assembly.";

export function verificationTools(
  composition: CompositionContext,
): VerificationToolHandlers {
  if (!composition.verificationTools) throw new Error(NO_HANDLERS);
  return composition.verificationTools;
}

export function agentTools(composition: CompositionContext): AgentToolHandlers {
  if (!composition.agentTools) throw new Error(NO_HANDLERS);
  return composition.agentTools;
}

// Non-throwing introspection: whether a capability class is assembled. Used by
// the outbound MCP projection (mcp-projection.ts) to hide tool verbs whose
// handlers are entirely absent, instead of advertising a tool that would throw
// on call. (A model-backed tool whose handler IS registered but has no API key
// degrades gracefully at call time — that is orthogonal to registration.)
export function hasVerificationTools(composition: CompositionContext): boolean {
  return composition.verificationTools !== null;
}

export function hasAgentTools(composition: CompositionContext): boolean {
  return composition.agentTools !== null;
}

// Whether a may-bill verb can actually spend the user's model API key under
// this assembly. run_audit's model audits need the audit provider; refutation,
// the gate's auto-refute and index_codebase's "assist" classifier need the agent.
// In an open (verification-only) assembly none of them reaches a model, so
// neither the listing nor the guidance may claim they bill.
export function canBillUnder(
  composition: CompositionContext,
  name: string,
): boolean {
  if (name === "run_audit") return composition.auditProvider !== null;
  return hasAgentTools(composition);
}

// Which upper-layer capability class a tool verb requires. `verification` = the
// verb's dispatch path calls verificationTools() (audits + changeset
// governance); `agent` = it calls agentTools() (adversarial refutation).
export type ToolCapability = "verification" | "agent";

// Authoritative, per-verb capability requirement — the single source of truth
// for which handler class a tool verb needs, co-located with the getters it
// mirrors. A verb listed here is one whose dispatch path calls the matching
// getter and therefore throws NO_HANDLERS when that layer is absent; the
// outbound MCP projection (mcp-projection.ts) reads this to hide such verbs from
// an assembly that cannot run them, so the advertised list can never drift from
// what the running assembly can dispatch. A verb's requirement is its
// unconditional, hard dependency: `complete_changeset` always calls
// verificationTools() (the readiness gate) and only *conditionally* reaches
// agentTools() (the settings-gated auto-refute), so it is declared `verification`
// — the open assembly carries verification alone and the gate simply skips the
// agent step, so that conditional reach never changes the gating outcome.
//
// tools/dispatch.ts is the ground truth; a drift guard (mcp-projection_test.ts)
// derives the getter call-sites from that source and asserts this map matches
// them in both directions, so a new capability-gated verb cannot silently desync.
export const TOOL_CAPABILITY_REQUIREMENTS: Readonly<
  Record<string, ToolCapability>
> = {
  refute_claims: "agent",
  run_audit: "verification",
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
// backstop). Non-throwing: mirrors hasVerificationTools()/hasAgentTools() so the
// projection advertises exactly the callable surface.
export function isToolCapabilityAvailable(
  composition: CompositionContext,
  name: string,
): boolean {
  const requirement = TOOL_CAPABILITY_REQUIREMENTS[name];
  if (!requirement) return true;
  return requirement === "verification"
    ? hasVerificationTools(composition)
    : hasAgentTools(composition);
}
