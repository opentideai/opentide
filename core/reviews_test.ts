// request_review / submit_review on the open composition: no model anywhere.
// The client's verdicts are typed in by hand, which is the point: whatever ran
// the review, the server checks the answer and records it the same way.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { Database } from "./db.ts";
import { Kernel } from "./registries.ts";
import { initCompiler, stopCompiler } from "./compiler.ts";
import { dispatchTool, type ToolResult } from "./tools/dispatch.ts";
import { testComposition } from "../cli/test-composition.ts";
import { checkChangesetReadiness } from "../verification/changesets.ts";
import { currentFingerprints } from "./fingerprint.ts";
import {
  type CriteriaPacket,
  CRITERION_COVERAGE_THRESHOLD,
  markCoverage,
  parseCriteriaVerdict,
  type RefutePacket,
} from "./reviews.ts";
import type { ProposedCriterion, VerificationClaim } from "./types.ts";

const testOpts = { sanitizeResources: false, sanitizeOps: false };
const noop = () => {};

async function withKernel(fn: (kernel: Kernel) => Promise<void>) {
  await initCompiler();
  const db = await Database.create({ driver: "pglite" });
  const kernel = new Kernel(db, { composition: testComposition() });
  try {
    await fn(kernel);
  } finally {
    await db.close();
    stopCompiler();
  }
}

function claim(
  id: string,
  text: string,
  priority: VerificationClaim["priority"] = "must",
): VerificationClaim {
  return { id, text, source: "agent", priority };
}

async function inProgress(
  kernel: Kernel,
  claims: VerificationClaim[],
): Promise<{ sessionId: string; changesetId: string }> {
  const session = await kernel.sessions.createSession("Reviews");
  const cs = await kernel.changesets.create({
    sessionId: session.id,
    title: "Orders",
    description: "Order totals.",
    plan: {
      summary: "s",
      steps: [{ id: "s1", description: "x", status: "done" }],
      acceptanceCriteria: claims,
      verificationPlan: [{
        id: "c0",
        claimIds: claims.map((c) => c.id),
        kind: "adversarial",
        description: "Adversarial review.",
      }],
    },
  });
  await kernel.changesets.approve(cs.id);
  await kernel.changesets.startWork(cs.id);
  return { sessionId: session.id, changesetId: cs.id };
}

function call(
  kernel: Kernel,
  name: string,
  args: Record<string, unknown>,
  ids: { sessionId: string; changesetId?: string },
): Promise<ToolResult> {
  return dispatchTool(name, args, kernel, noop, ids);
}

async function packet<T>(
  kernel: Kernel,
  args: Record<string, unknown>,
  ids: { sessionId: string; changesetId?: string },
): Promise<T> {
  const result = await call(kernel, "request_review", args, ids);
  assert(result.ok, JSON.stringify(result.error));
  return result.data as T;
}

const REFUTED = {
  refuted: true,
  confidence: "high",
  counterexample: "quantity=0 divides by zero",
  reasoning: "no guard",
};

function registerHandler(kernel: Kernel, name: string) {
  kernel.handlers.register(
    name,
    `async function ${name}(c: Context) { return c.json({}); }`,
    () => new Response("ok"),
  );
}

// --- refute --------------------------------------------------------------------

Deno.test({
  ...testOpts,
  name: "refute: the packet covers must claims and sends shared code once",
  fn: () =>
    withKernel(async (kernel) => {
      const ids = await inProgress(kernel, [
        claim("c1", "Totals never go negative."),
        claim("c2", "Dividing by quantity never throws."),
        claim("c3", "The header shows the logo.", "should"),
      ]);
      const p = await packet<RefutePacket>(kernel, { kind: "refute" }, ids);
      assertEquals(p.kind, "refute");
      assertEquals(p.changesetId, ids.changesetId);
      assertEquals(p.claims.map((c) => c.id), ["c1", "c2"]);
      assertEquals(Object.keys(p.contexts).length, 1);
      assertEquals(p.claims[0]!.contextId, p.claims[1]!.contextId);
      assertStringIncludes(p.response, "submit_review");
      assertEquals(p.reused, []);
    }),
});

Deno.test({
  ...testOpts,
  name:
    "refute: a confident counterexample blocks completion, marked as the client's",
  fn: () =>
    withKernel(async (kernel) => {
      const ids = await inProgress(kernel, [claim("c1", "Never throws.")]);
      const p = await packet<RefutePacket>(kernel, { kind: "refute" }, ids);
      const submitted = await call(kernel, "submit_review", {
        packet_id: p.packetId,
        verdict: { results: [{ claimId: "c1", ...REFUTED }] },
        reviewer: "test-model",
      }, ids);
      assert(submitted.ok, JSON.stringify(submitted.error));
      assertEquals(submitted._changesetEvent, "changeset_updated");
      const data = submitted.data as {
        changesetId: string;
        results: Array<
          { claimId: string; claimText: string; refuted: boolean }
        >;
      };
      assertEquals(data.changesetId, ids.changesetId);
      assertEquals(data.results[0]?.refuted, true);
      assertEquals(data.results[0]?.claimText, "Never throws.");

      const stored = (await kernel.changesets.get(ids.changesetId))!;
      const [att] = (stored.plan.attestations ?? []).filter((a) =>
        a.kind === "adversarial"
      );
      assertEquals(att?.status, "failed");
      assertEquals(att?.producer, "client");
      assertEquals(att?.reviewer, "test-model");
      const [row] = await kernel.changesets.listLedger({ kind: "adversarial" });
      assertEquals(row?.producer, "client");
      assertEquals(row?.reviewer, "test-model");

      const readiness = checkChangesetReadiness(
        stored,
        currentFingerprints(kernel, stored),
      );
      assert(readiness.errors.some((i) => i.code === "CLAIM_REFUTED"));

      const completed = await call(kernel, "complete_changeset", {
        changeset_id: ids.changesetId,
      }, ids);
      assertEquals(completed.ok, false);
      assertStringIncludes(completed.error!.message, "CLAIM_REFUTED");
    }),
});

Deno.test({
  ...testOpts,
  name: "refute: an unsure or vague counterexample does not refute",
  fn: () =>
    withKernel(async (kernel) => {
      const ids = await inProgress(kernel, [claim("c1", "Never throws.")]);
      const p = await packet<RefutePacket>(kernel, { kind: "refute" }, ids);
      const submitted = await call(kernel, "submit_review", {
        packet_id: p.packetId,
        verdict: {
          results: [
            { claimId: "c1", ...REFUTED, confidence: "medium" },
            { claimId: "c1", refuted: true, confidence: "high" },
          ],
        },
      }, ids);
      assert(submitted.ok);
      const stored = (await kernel.changesets.get(ids.changesetId))!;
      const atts = (stored.plan.attestations ?? []).filter((a) =>
        a.kind === "adversarial"
      );
      assertEquals(atts.map((a) => a.status), ["passed"]);
      assertEquals(atts[0]?.summary, "Survived 2 refutation attempt(s).");
    }),
});

Deno.test({
  ...testOpts,
  name: "refute: a fresh verdict is reused, and force reviews it again",
  fn: () =>
    withKernel(async (kernel) => {
      const ids = await inProgress(kernel, [claim("c1", "Never throws.")]);
      const first = await packet<RefutePacket>(kernel, { kind: "refute" }, ids);
      await call(kernel, "submit_review", {
        packet_id: first.packetId,
        verdict: {
          results: [{ claimId: "c1", refuted: false, confidence: "low" }],
        },
      }, ids);
      const again = await packet<RefutePacket>(kernel, { kind: "refute" }, ids);
      assertEquals(again.claims, []);
      assertEquals(again.reused.map((r) => r.claimId), ["c1"]);
      const forced = await packet<RefutePacket>(kernel, {
        kind: "refute",
        force: true,
      }, ids);
      assertEquals(forced.claims.map((c) => c.id), ["c1"]);
    }),
});

Deno.test({
  ...testOpts,
  name: "submit_review: a packet is answered once",
  fn: () =>
    withKernel(async (kernel) => {
      const ids = await inProgress(kernel, [claim("c1", "Never throws.")]);
      const p = await packet<RefutePacket>(kernel, { kind: "refute" }, ids);
      const verdict = {
        results: [{ claimId: "c1", refuted: false, confidence: "low" }],
      };
      const first = await call(kernel, "submit_review", {
        packet_id: p.packetId,
        verdict,
      }, ids);
      assert(first.ok);
      const second = await call(kernel, "submit_review", {
        packet_id: p.packetId,
        verdict,
      }, ids);
      assertEquals(second.error?.code, "REVIEW_PACKET_USED");
      const unknown = await call(kernel, "submit_review", {
        packet_id: "rvw_nope",
        verdict,
      }, ids);
      assertEquals(unknown.error?.code, "REVIEW_PACKET_NOT_FOUND");
    }),
});

Deno.test({
  ...testOpts,
  name: "submit_review: a verdict on code that has since changed is stale",
  fn: () =>
    withKernel(async (kernel) => {
      const ids = await inProgress(kernel, [claim("c1", "Never throws.")]);
      const p = await packet<RefutePacket>(kernel, { kind: "refute" }, ids);
      registerHandler(kernel, "changedSince");
      const result = await call(kernel, "submit_review", {
        packet_id: p.packetId,
        verdict: { results: [{ claimId: "c1", ...REFUTED }] },
      }, ids);
      assertEquals(result.error?.code, "STALE_REVIEW");
      const stored = (await kernel.changesets.get(ids.changesetId))!;
      assertEquals(stored.plan.attestations ?? [], []);
    }),
});

Deno.test({
  ...testOpts,
  name:
    "submit_review: a malformed verdict is refused and leaves the packet open",
  fn: () =>
    withKernel(async (kernel) => {
      const ids = await inProgress(kernel, [
        claim("c1", "Never throws."),
        claim("c2", "Never negative."),
      ]);
      const p = await packet<RefutePacket>(kernel, { kind: "refute" }, ids);
      const bad = [
        "refuted",
        { results: "no" },
        { results: [{ claimId: "c1", refuted: "yes", confidence: "high" }] },
        { results: [{ claimId: "c9", refuted: false, confidence: "low" }] },
        // c2 has no result.
        { results: [{ claimId: "c1", refuted: false, confidence: "low" }] },
      ];
      for (const verdict of bad) {
        const result = await call(kernel, "submit_review", {
          packet_id: p.packetId,
          verdict,
        }, ids);
        assertEquals(result.error?.code, "INVALID_VERDICT", String(verdict));
      }
      const good = await call(kernel, "submit_review", {
        packet_id: p.packetId,
        verdict: {
          results: [
            { claimId: "c1", refuted: false, confidence: "low" },
            { claimId: "c2", refuted: false, confidence: "low" },
          ],
        },
      }, ids);
      assert(good.ok, JSON.stringify(good.error));
    }),
});

// --- criteria ------------------------------------------------------------------

Deno.test({
  ...testOpts,
  name:
    "criteria: the packet carries the user's words, never the plan's criteria",
  fn: () =>
    withKernel(async (kernel) => {
      const ids = await inProgress(kernel, [
        claim("c1", "Order totals never go negative."),
      ]);
      await kernel.sessions.addMessage({
        sessionId: ids.sessionId,
        role: "user",
        content: "Make order totals correct for refunds.",
      });
      const p = await packet<CriteriaPacket>(kernel, { kind: "criteria" }, ids);
      assertEquals(p.request, "Make order totals correct for refunds.");
      assertEquals(p.requestFromUser, true);
      assert(!JSON.stringify(p).includes("never go negative"));
    }),
});

Deno.test({
  ...testOpts,
  name:
    "criteria: proposals are recorded with coverage, and gaps are reported, not blocked",
  fn: () =>
    withKernel(async (kernel) => {
      const ids = await inProgress(kernel, [
        claim("c1", "Order totals never go negative."),
      ]);
      const p = await packet<CriteriaPacket>(kernel, { kind: "criteria" }, ids);
      assertEquals(p.requestFromUser, false);
      const result = await call(kernel, "submit_review", {
        packet_id: p.packetId,
        verdict: {
          criteria: [
            { text: "Order totals never go negative.", priority: "must" },
            { text: "Refunding twice does not refund twice.", priority: "odd" },
          ],
        },
        reviewer: "test-model",
      }, ids);
      assert(result.ok, JSON.stringify(result.error));
      const stored = (await kernel.changesets.get(ids.changesetId))!;
      const proposals = stored.plan.independentCriteria ?? [];
      assertEquals(proposals[0]?.coveredBy, "c1");
      assertEquals(proposals[1]?.coveredBy, undefined);
      assertEquals(proposals[1]?.priority, "should");
      const [att] = (stored.plan.attestations ?? []).filter((a) =>
        a.kind === "criteria"
      );
      assertEquals(att?.status, "partial");
      assertEquals(att?.producer, "client");
      assertStringIncludes(
        att!.summary,
        "original request text was unavailable",
      );
      const readiness = checkChangesetReadiness(
        stored,
        currentFingerprints(kernel, stored),
      );
      assert(
        readiness.warnings.some((i) =>
          i.code === "UNCOVERED_INDEPENDENT_CRITERION"
        ),
      );
    }),
});

Deno.test({
  ...testOpts,
  name: "criteria: an answer that isn't a list records nothing",
  fn: () =>
    withKernel(async (kernel) => {
      const ids = await inProgress(kernel, [claim("c1", "Never throws.")]);
      const p = await packet<CriteriaPacket>(kernel, { kind: "criteria" }, ids);
      for (const verdict of [{}, { criteria: "none" }, { criteria: [{}] }]) {
        const result = await call(kernel, "submit_review", {
          packet_id: p.packetId,
          verdict,
        }, ids);
        assertEquals(result.error?.code, "INVALID_VERDICT");
      }
      const stored = (await kernel.changesets.get(ids.changesetId))!;
      assertEquals(stored.plan.independentCriteria, undefined);
    }),
});

// --- audit ---------------------------------------------------------------------

Deno.test({
  ...testOpts,
  name: "audit: unknown categories are refused",
  fn: () =>
    withKernel(async (kernel) => {
      const session = await kernel.sessions.createSession("Audit");
      const result = await call(kernel, "request_review", {
        kind: "audit",
        category: "vibes",
      }, { sessionId: session.id });
      assertEquals(result.error?.code, "INVALID_CATEGORY");
    }),
});

Deno.test({
  ...testOpts,
  name: "audit: a submitted audit is stored and attested like any other",
  fn: () =>
    withKernel(async (kernel) => {
      const ids = await inProgress(kernel, [claim("c1", "Never throws.")]);
      registerHandler(kernel, "listOrders");
      const result = await call(kernel, "request_review", {
        kind: "audit",
        category: "security",
      }, ids);
      assert(result.ok);
      const p = result.data as { packetId: string; context: string };
      assertStringIncludes(p.context, "listOrders");
      const submitted = await call(kernel, "submit_review", {
        packet_id: p.packetId,
        verdict: {
          issues: [{
            severity: "high",
            rule: "auth",
            message: "listOrders has no auth check.",
            entity: "handler:listOrders",
          }],
        },
      }, ids);
      assert(submitted.ok, JSON.stringify(submitted.error));
      const listed = await call(kernel, "list_audits", {
        category: "security",
      }, ids);
      const audits = listed.data as Array<{ issueCount: number }>;
      assertEquals(audits.map((a) => a.issueCount), [1]);
      const stored = (await kernel.changesets.get(ids.changesetId))!;
      const [att] = (stored.plan.attestations ?? []).filter((a) =>
        a.kind === "audit"
      );
      assertEquals(att?.status, "partial");
      assertEquals(att?.producer, "client");
    }),
});

// --- coverage: plain code, not a second model call -----------------------------

function proposalsOf(verdict: unknown): ProposedCriterion[] {
  const parsed = parseCriteriaVerdict(verdict);
  assert(parsed.ok);
  return parsed.data;
}

Deno.test("coverage: a matching acceptance criterion covers a proposal", () => {
  const [marked] = markCoverage(
    proposalsOf({
      criteria: [{
        text: "Submitting the order form twice creates one order.",
      }],
    }),
    [claim("clm_1", "Submitting the order form twice creates only one order.")],
  );
  assertEquals(marked!.coveredBy, "clm_1");
});

Deno.test("coverage: an unrelated criterion leaves the proposal uncovered", () => {
  const [marked] = markCoverage(
    proposalsOf({
      criteria: [{ text: "Deleting a customer removes their draft orders." }],
    }),
    [claim("clm_1", "The dashboard header renders the company logo.")],
  );
  assert(!marked!.coveredBy);
});

Deno.test("coverage: an empty plan leaves everything uncovered", () => {
  const marked = markCoverage(
    proposalsOf({
      criteria: [{ text: "Orders cannot go negative." }],
    }),
    [],
  );
  assert(!marked[0]!.coveredBy);
});

Deno.test("coverage: the best-matching claim wins, not the first", () => {
  const [marked] = markCoverage(
    proposalsOf({
      criteria: [{ text: "Refunding an order restores the stock count." }],
    }),
    [
      claim("clm_1", "The refund button is visible to admins."),
      claim("clm_2", "Refunding an order restores the stock count exactly."),
    ],
  );
  assertEquals(marked!.coveredBy, "clm_2");
});

Deno.test("coverage: stop words alone never constitute a match", () => {
  // Without stop-word filtering, two sentences made of "the/a/is/to" would look
  // identical and every proposal would read as covered.
  const [marked] = markCoverage(
    proposalsOf({
      criteria: [{ text: "The concurrent second caller is rejected." }],
    }),
    [claim("clm_1", "The user is able to do that with a form.")],
  );
  assert(!marked!.coveredBy);
});

Deno.test("coverage: a terse claim can still cover a wordy proposal", () => {
  // Normalising by the smaller set is what makes this work; plain Jaccard would
  // score it below threshold purely because the proposal is longer.
  const [marked] = markCoverage(
    proposalsOf({
      criteria: [{
        text:
          "When pagination reaches the final page the next control becomes disabled.",
      }],
    }),
    [claim("clm_1", "Pagination disables next on the final page.")],
  );
  assertEquals(marked!.coveredBy, "clm_1");
});

Deno.test("coverage: the threshold is a named constant, not a magic number", () => {
  assert(CRITERION_COVERAGE_THRESHOLD > 0 && CRITERION_COVERAGE_THRESHOLD <= 1);
});

// --- prompt shape -----------------------------------------------------------
