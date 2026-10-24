// @layer verification — audit HTTP routes, mounted into the core app via the
// route-mount hook (OpenTide §3.3) so the control server no longer imports audit
// logic. The model-backed run goes through executeAudit → the audit-provider hook.
import type { Hono } from "hono";
import type { CoreRouteContext } from "../core/route-mount.ts";
import { executeAudit } from "./audit-runner.ts";
import { BUILTIN_AUDIT_CONFIGS } from "./audit-configs.ts";
import type { AuditCategory } from "../core/types.ts";
import { BUILTIN_AUDIT_CATEGORIES } from "../core/types.ts";

export function mountAuditRoutes(app: Hono, core: CoreRouteContext): void {
  app.get("/api/audits", (c) => {
    const guard = core.requireKernel(c);
    if (guard) return guard;
    const category = c.req.query("category") as AuditCategory | undefined;
    const audits = core.kernel().audits;
    return c.json(category ? audits.listByCategory(category) : audits.list());
  });

  app.get("/api/audits/latest", (c) => {
    const guard = core.requireKernel(c);
    if (guard) return guard;
    const k = core.kernel();
    const latest: Record<string, unknown> = {};
    const allCategories = [
      ...BUILTIN_AUDIT_CATEGORIES,
      ...k.customAudits.list().map((a) => a.name),
    ];
    for (const cat of allCategories) {
      latest[cat] = k.audits.latest(cat) ?? null;
    }
    return c.json(latest);
  });

  app.get("/api/audits/configs", (c) => {
    const guard = core.requireKernel(c);
    if (guard) return guard;
    const configs: Record<string, { prompt: string; builtin: boolean }> = {};
    for (const [key, cfg] of Object.entries(BUILTIN_AUDIT_CONFIGS)) {
      configs[key] = { prompt: cfg.systemPrompt, builtin: true };
    }
    for (const custom of core.kernel().customAudits.list()) {
      configs[custom.name] = { prompt: custom.prompt, builtin: false };
    }
    return c.json(configs);
  });

  app.get("/api/audits/:id", (c) => {
    const guard = core.requireKernel(c);
    if (guard) return guard;
    const result = core.kernel().audits.get(c.req.param("id"));
    if (!result) {
      return c.json({
        error: true,
        code: "NOT_FOUND",
        message: "Audit result not found",
      }, 404);
    }
    return c.json(result);
  });

  app.post("/api/audits/run", async (c) => {
    const guard = core.requireKernel(c);
    if (guard) return guard;
    const k = core.kernel();
    const body = await c.req.json() as {
      category: string;
      options?: Record<string, unknown>;
    };
    const allCategories = [
      ...BUILTIN_AUDIT_CATEGORIES,
      ...k.customAudits.list().map((a) => a.name),
    ];
    if (!allCategories.includes(body.category)) {
      return c.json({
        error: true,
        code: "INVALID_CATEGORY",
        message: `Unknown audit category "${body.category}"`,
      }, 400);
    }
    const started = performance.now();
    core.track("audit_run_started", { category: body.category });
    try {
      const result = await executeAudit(
        body.category as AuditCategory,
        k,
        body.options,
      );
      core.track("audit_run_completed", {
        category: body.category,
        status: result.status,
        issue_count: result.issues.length,
        duration_ms: Math.round(performance.now() - started),
      });
      return c.json(result);
    } catch (err) {
      core.track("audit_run_completed", {
        category: body.category,
        status: "failed",
        issue_count: 0,
        duration_ms: Math.round(performance.now() - started),
      });
      throw err;
    }
  });

  app.delete("/api/audits", async (c) => {
    const guard = core.requireKernel(c);
    if (guard) return guard;
    await core.kernel().audits.clear();
    return c.json({ ok: true });
  });

  app.delete("/api/audits/:id/issues/:index", async (c) => {
    const guard = core.requireKernel(c);
    if (guard) return guard;
    const k = core.kernel();
    const auditId = c.req.param("id");
    const index = Number(c.req.param("index"));
    if (!await k.audits.removeIssue(auditId, index)) {
      return c.json({
        error: true,
        code: "NOT_FOUND",
        message: "Audit or issue not found",
      }, 404);
    }
    return c.json({ ok: true, result: k.audits.get(auditId) });
  });

  app.delete("/api/audits/:id/issues", async (c) => {
    const guard = core.requireKernel(c);
    if (guard) return guard;
    const k = core.kernel();
    const auditId = c.req.param("id");
    if (!await k.audits.clearIssues(auditId)) {
      return c.json({
        error: true,
        code: "NOT_FOUND",
        message: "Audit not found",
      }, 404);
    }
    return c.json({ ok: true, result: k.audits.get(auditId) });
  });
}
