// @layer verification — audit dispatch. The model-backed audit runs through the
// audit-provider hook (audit-provider.ts); this module no longer imports the agent.
import type { Kernel } from "../core/registries.ts";
import type { AgentAuditConfig, AuditCategory, AuditResult } from "../core/types.ts";
import { BUILTIN_AUDIT_CATEGORIES } from "../core/types.ts";
import { BUILTIN_AUDIT_CONFIGS } from "./audit-configs.ts";

export async function executeAudit(
  category: AuditCategory,
  kernel: Kernel,
  _options?: Record<string, unknown>,
): Promise<AuditResult> {
  let config: AgentAuditConfig | undefined = BUILTIN_AUDIT_CONFIGS[category];

  if (!config) {
    const custom = kernel.customAudits.get(category);
    if (custom) config = { category, systemPrompt: custom.prompt };
  }

  if (!config) {
    const valid = [
      ...BUILTIN_AUDIT_CATEGORIES,
      ...kernel.customAudits.list().map((a) => a.name),
    ];
    const result = errorAuditResult(
      category,
      `Unknown audit category: ${category}`,
      `Unknown audit category "${category}". Valid categories: ${
        valid.join(", ")
      }`,
    );
    await kernel.audits.store(result);
    return result;
  }

  await kernel.audits.clearCategory(category);

  // With no provider supplied (headless / no agent assembled), audits can't run.
  const provider = kernel.composition.auditProvider;
  const result = provider ? await provider(config, kernel) : errorAuditResult(
    category,
    "Audit provider not configured",
    "No audit provider is registered — assemble the agent (set an API key) to run model-backed audits.",
  );
  await kernel.audits.store(result);
  return result;
}

// A stored error AuditResult (unknown category, or no provider configured).
function errorAuditResult(
  category: AuditCategory,
  summary: string,
  error: string,
): AuditResult {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    category,
    status: "error",
    startedAt: now,
    completedAt: now,
    issues: [],
    summary,
    score: null,
    metadata: {},
    error,
  };
}

