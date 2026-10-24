// @layer core — the audit-provider contract (OpenTide §3.3). The model-backed
// audit (audit-agent, L3) is supplied per-Kernel via the composition context
// (composition.ts); verification's audit-runner calls
// kernel.composition.auditProvider instead of importing the agent. With none
// supplied (headless / no agent assembled), audits return a "not configured"
// result rather than failing.
import type { Kernel } from "./registries.ts";
import type { AgentAuditConfig, AuditResult } from "./types.ts";

export type AuditProvider = (
  config: AgentAuditConfig,
  kernel: Kernel,
) => Promise<AuditResult>;
