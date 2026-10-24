// @layer verification — verification/changeset-context HTTP routes, mounted into
// the core app via the route-mount hook (OpenTide §3.3) so the control server no
// longer imports verification logic.
import type { Hono } from "hono";
import type { CoreRouteContext } from "../core/route-mount.ts";
import { buildVerificationOverview } from "./verification-overview.ts";
import { formatChangesetContext } from "./changeset-context.ts";
import type { AttestationKind, LedgerQuery } from "../core/types.ts";
import { checkProjectAwareReadiness } from "../core/project-readiness.ts";
import { checkChangesetReadiness } from "./changesets.ts";
import { currentFingerprints } from "../core/fingerprint.ts";

export function mountVerificationRoutes(
  app: Hono,
  core: CoreRouteContext,
): void {
  app.post("/api/context/changeset", async (c) => {
    const guard = core.requireKernel(c);
    if (guard) return guard;
    const body = await c.req.json<{ changesetId?: string }>().catch(() => null);
    if (!body?.changesetId) {
      return c.json({ error: "changesetId is required" }, 400);
    }
    const k = core.kernel();
    const changeset = await k.changesets.get(body.changesetId);
    if (!changeset) return c.json({ error: "Changeset not found" }, 404);
    const changes = await k.changelog.listByChangeset(changeset.id);
    return c.json({
      changeset,
      changes,
      context: formatChangesetContext(changeset, changes),
    });
  });

  app.get("/api/verification/overview", async (c) => {
    const guard = core.requireKernel(c);
    if (guard) return guard;
    const overview = await buildVerificationOverview(core.kernel());
    return c.json({ ...overview, generatedAt: new Date().toISOString() });
  });

  // Searchable, paginated view of the full attestation ledger (Phase 5A removed
  // the 100-changeset cap). Filters: scope, kind, since (ISO), limit, offset.
  app.get("/api/verification/ledger", async (c) => {
    const guard = core.requireKernel(c);
    if (guard) return guard;
    const q = c.req.query();
    const query: LedgerQuery = {};
    if (q.scope) query.scope = q.scope;
    if (q.kind) query.kind = q.kind as AttestationKind;
    if (q.since) query.since = q.since;
    const limit = Number(q.limit);
    if (Number.isFinite(limit) && limit > 0) query.limit = limit;
    const offset = Number(q.offset);
    if (Number.isFinite(offset) && offset > 0) query.offset = offset;
    const entries = await core.kernel().changesets.listLedger(query);
    return c.json({
      entries,
      count: entries.length,
      query,
      generatedAt: new Date().toISOString(),
    });
  });

  // The readiness gate as a read-only verdict — the same check the completion
  // path enforces (dispatch.ts complete_changeset), computed with the SAME
  // current fingerprints + enforcement setting so the preview matches reality.
  // Read-only: unlike completion it does not first mint fresh formal-spec /
  // adversarial attestations, so it is a lower bound — a passing preview can
  // still surface a fresh issue at actual completion if an entity has drifted.
  app.get("/api/changesets/:id/readiness", async (c) => {
    const guard = core.requireKernel(c);
    if (guard) return guard;
    const k = core.kernel();
    const changeset = await k.changesets.get(c.req.param("id"));
    if (!changeset) return c.json({ error: "Changeset not found" }, 404);
    const readiness = await checkProjectAwareReadiness(
      k,
      changeset,
      undefined,
      undefined,
      (enforcement) =>
        checkChangesetReadiness(
          changeset,
          currentFingerprints(k, changeset),
          enforcement,
        ),
    );
    return c.json(readiness);
  });
}
