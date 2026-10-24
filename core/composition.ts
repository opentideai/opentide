// @layer core — the composition context (OpenTide §3.3). One object the
// composition root builds and threads through each Kernel, replacing the
// scattered global module-singletons (audit-provider, project-hooks,
// kernel-stores, tool-capabilities) that upper layers used to poke at startup.
//
// It holds only the *contracts* — every referenced type already lives in core —
// so this module never imports verification/agent. The concrete values are
// supplied by the composition layer (cli/assembly.ts), the one place allowed to
// reach up. A Kernel built without a composition gets coreOnlyComposition()
// (every seam absent), so core boots and serves standalone; touching an absent
// seam degrades (audits "not configured") or throws (changesets/audits store).
import type { DrizzleDb } from "./db/factory.ts";
import type {
  AuditStore,
  ChangesetPlan,
  ChangesetStore,
  McpAuditStore,
} from "./types.ts";
import type { AuditProvider } from "./audit-provider.ts";
import type { ProjectInitHook } from "./project-hooks.ts";
import type {
  AgentToolHandlers,
  VerificationToolHandlers,
} from "./tool-capabilities.ts";
import type { Kernel } from "./registries.ts";
import type { DiagnosticEntry } from "./language-service.ts";

// The Kernel's verification-governed store factories: core declares the
// contract, the composition supplies concrete managers (ChangesetManager /
// AuditManager) so core never imports the verification layer.
export type ChangesetStoreFactory = (
  storage: DrizzleDb | string,
) => ChangesetStore;
export type AuditStoreFactory = (db: DrizzleDb) => AuditStore;
export type McpAuditStoreFactory = (db: DrizzleDb) => McpAuditStore;

// Line-anchored verification diagnostics for the merged diagnostics stream
// (core/diagnostics.ts, docs/lsp-support-plan.md Stage 2). Core declares the
// contract; a composition may supply an implementation that projects selected
// verification/ findings which carry a line anchor into DiagnosticEntry shape
// (core stamps the `verify` source). This keeps core free of any verification
// import — same IoC seam as the store factories above. Null ⇒ verification
// contributes nothing to the merged stream, the common case today (few findings
// are line-anchored), so the mechanism and namespace exist ahead of the findings.
export type VerificationDiagnosticsProvider = (
  kernel: Kernel,
  entityType: string,
  entityName: string,
  content?: string,
) => DiagnosticEntry[] | Promise<DiagnosticEntry[]>;

// The changeset the LSP write path persists when a save is gated (Stage 4). The
// verification layer builds it (it owns changeset-plan construction and embeds the
// proposed edit) so lsp/ never assembles a governance plan itself — the same IoC
// discipline as verificationDiagnostics above. The server hands this straight to
// kernel.changesets.create (reachable from core, no verification import).
export interface SaveGateChangesetSpec {
  title: string;
  description?: string;
  plan: ChangesetPlan;
}

// The verdict a save-risk policy returns for one didSave (docs/lsp-support-plan.md
// Stage 4). It is the FULL governance decision, already folding in the active
// readinessEnforcement policy and which readiness codes that policy promotes — so
// the LSP server never reimplements the advisory/graduated/strict mapping (plan
// §8: "the LSP layer calls seams, it does not reimplement governance"). It just
// branches on `decision`:
//   - "allow" → persist transparently through the Stage 3 tool path. A `reason`
//     present here is an advisory warning (risky entity under an advisory policy):
//     the save still applies, but the editor is warned.
//   - "gate" → do NOT mutate the registry; the server creates `changeset` in its
//     gated (planning) status and reports "pending approval". `reason` explains why.
export interface SaveRiskVerdict {
  decision: "allow" | "gate";
  reason?: string;
  changeset?: SaveGateChangesetSpec;
}

// Risk-adaptive save policy (docs/lsp-support-plan.md Stage 4): given the entity
// and the proposed new source, decide whether the LSP write path may persist it
// transparently or must hold it as a pending changeset. Mirrors the
// verificationDiagnostics seam exactly — the decision logic lives in verification
// (formal-spec / attestation freshness × enforcement) and cannot be imported
// upward, so a composition injects it here. Null ⇒ every save is low-risk, which
// is precisely pure Stage 3 behavior (the read-only/core compositions and the
// Stage 0–3 tests are unaffected).
export type SaveRiskPolicy = (
  kernel: Kernel,
  entityType: string,
  entityName: string,
  source: string,
) => SaveRiskVerdict | Promise<SaveRiskVerdict>;

export interface CompositionContext {
  // Kernel store factories (verification's changeset/audit managers). Null ⇒
  // kernel.changesets/.audits throw (NO_STORE_FACTORY) on first use.
  changesetStoreFactory: ChangesetStoreFactory | null;
  auditStoreFactory: AuditStoreFactory | null;
  // The MCP call audit. Null ⇒ kernel.mcpAudit is null and calls go unrecorded.
  mcpAuditStoreFactory: McpAuditStoreFactory | null;
  // Model-backed audit (agent). Null ⇒ executeAudit returns "not configured".
  auditProvider: AuditProvider | null;
  // Capability tool handlers. Null ⇒ the verbs that need them throw on dispatch
  // and are hidden from the outbound MCP projection.
  verificationTools: VerificationToolHandlers | null;
  agentTools: AgentToolHandlers | null;
  // Line-anchored verification diagnostics contributed to the merged stream
  // (core/diagnostics.ts). Null ⇒ no `verify`-sourced diagnostics today.
  verificationDiagnostics: VerificationDiagnosticsProvider | null;
  // Risk-adaptive save decision for the LSP write path (Stage 4). Null ⇒ every
  // save is low-risk (pure Stage 3 tool-level persist).
  saveRiskPolicy: SaveRiskPolicy | null;
  // Project-load lifecycle hooks (e.g. verification's ledger seeding).
  initHooks: readonly ProjectInitHook[];
}

// The absent-safe empty composition: no verification, no agent. A Kernel with
// this boots and serves the core surface; every upper-layer seam is absent.
export function coreOnlyComposition(): CompositionContext {
  return {
    changesetStoreFactory: null,
    auditStoreFactory: null,
    mcpAuditStoreFactory: null,
    auditProvider: null,
    verificationTools: null,
    agentTools: null,
    verificationDiagnostics: null,
    saveRiskPolicy: null,
    initHooks: [],
  };
}
