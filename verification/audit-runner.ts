// @layer verification — audit categories and their configurations. The audit
// itself runs on the client's model, through request_review.
import type { Kernel } from "../core/registries.ts";
import type { AgentAuditConfig, AuditCategory } from "../core/types.ts";
import { BUILTIN_AUDIT_CATEGORIES } from "../core/types.ts";
import { BUILTIN_AUDIT_CONFIGS } from "./audit-configs.ts";

// A category's audit configuration: built-in, or a custom audit's prompt.
export function auditConfig(
  category: string,
  kernel: Kernel,
): AgentAuditConfig | undefined {
  const builtin = BUILTIN_AUDIT_CONFIGS[category as AuditCategory];
  if (builtin) return builtin;
  const custom = kernel.customAudits.get(category);
  return custom ? { category, systemPrompt: custom.prompt } : undefined;
}

export function auditCategories(kernel: Kernel): string[] {
  return [
    ...BUILTIN_AUDIT_CATEGORIES,
    ...kernel.customAudits.list().map((a) => a.name),
  ];
}
