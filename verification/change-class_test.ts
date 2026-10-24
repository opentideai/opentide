import { assert, assertEquals } from "@std/assert";
import {
  classifyChangeRecords,
  resolveChangeClass,
  SKIP_LIGHT_TIER,
  TIER_POLICIES,
  tierPolicy,
  verifyChangeClass,
} from "./change-class.ts";
import {
  LIGHT_TIER_MAX_ENTITIES,
  LIGHT_TIER_MAX_STEPS,
} from "../core/config.ts";
import type { ChangeRecord } from "../core/changelog.ts";
import type { ChangesetPlan } from "../core/types.ts";

// A minimal ChangeRecord — only category/action/key are read by the classifier.
function rec(
  category: ChangeRecord["category"],
  key: string,
  action: ChangeRecord["action"] = "update",
): ChangeRecord {
  return {
    id: 1,
    category,
    key,
    action,
    beforeSnapshot: null,
    afterSnapshot: null,
    context: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    undoable: true,
    turnId: null,
    changesetId: "cs_1",
    rationale: null,
    implementation: null,
    workMessageId: null,
  };
}

function plan(over: Partial<ChangesetPlan> = {}): ChangesetPlan {
  return {
    summary: "Remove the 76px margin from the header.",
    steps: [{ id: "step_0", description: "Edit the stylesheet", status: "pending" }],
    ...over,
  };
}

// --- classifyChangeRecords ---

Deno.test("classifyChangeRecords: light surfaces stay light", () => {
  assertEquals(
    classifyChangeRecords([rec("asset", "styles.css"), rec("template", "page")]),
    "light",
  );
  // Handlers and functions are light-eligible: the line is blast radius, not
  // "is it code" — a bad handler is caught by the tests and typecheck that still run.
  assertEquals(classifyChangeRecords([rec("handler", "getTodos")]), "light");
  assertEquals(classifyChangeRecords([]), "light");
});

Deno.test("classifyChangeRecords: one structural change escalates the whole set", () => {
  assertEquals(
    classifyChangeRecords([rec("asset", "styles.css"), rec("schema", "todos")]),
    "standard",
  );
  assertEquals(classifyChangeRecords([rec("route", "GET /todos")]), "standard");
  assertEquals(classifyChangeRecords([rec("secret", "STRIPE_KEY")]), "standard");
  assertEquals(
    classifyChangeRecords([rec("handler", "getTodos", "delete")]),
    "standard",
  );
});

Deno.test("classifyChangeRecords: exceeding the entity budget escalates", () => {
  const light = Array.from(
    { length: LIGHT_TIER_MAX_ENTITIES },
    (_, i) => rec("asset", `a${i}.css`),
  );
  assertEquals(classifyChangeRecords(light), "light");
  assertEquals(
    classifyChangeRecords([...light, rec("asset", "one-too-many.css")]),
    "standard",
  );
  // The budget counts DISTINCT entities — editing one file repeatedly is one entity.
  assertEquals(
    classifyChangeRecords([
      rec("asset", "styles.css"),
      rec("asset", "styles.css"),
      rec("asset", "styles.css"),
      rec("asset", "styles.css"),
    ]),
    "light",
  );
});

// --- resolveChangeClass ---

Deno.test("resolveChangeClass: auto honors a coherent light declaration and synthesizes ceremony", () => {
  const result = resolveChangeClass("light", plan(), "auto");
  assertEquals(result.issue, null);
  assertEquals(result.changeClass.effective, "light");
  assertEquals(result.changeClass.escalated, false);
  // The kernel authored the criterion and the planned check, so the agent did not
  // have to write ceremony for a margin tweak — but the changeset genuinely has both.
  assertEquals(result.plan.acceptanceCriteria?.length, 1);
  assertEquals(result.plan.verificationPlan?.length, 1);
  assertEquals(result.plan.verificationPlan?.[0]?.kind, "manifest");
  // `should`, not `must` — this is what mechanically keeps the adversarial pass out
  // of the completion gate, which filters on `must`.
  assertEquals(result.plan.acceptanceCriteria?.[0]?.priority, "should");
  assertEquals(result.plan.acceptanceCriteria?.[0]?.source, "inferred");
  // The synthesized check is mapped to the synthesized claim.
  assertEquals(
    result.plan.verificationPlan?.[0]?.claimIds,
    [result.plan.acceptanceCriteria?.[0]?.id],
  );
});

Deno.test("resolveChangeClass: an undeclared changeset is standard under auto", () => {
  const result = resolveChangeClass(undefined, plan(), "auto");
  assertEquals(result.changeClass.effective, "standard");
  assertEquals(result.changeClass.escalated, false);
  assertEquals(result.issue, null);
  // No ceremony is synthesized for standard work — the agent authors it.
  assertEquals(result.plan.acceptanceCriteria, undefined);
});

Deno.test("resolveChangeClass: never disables the lane even for a declared-light plan", () => {
  const result = resolveChangeClass("light", plan(), "never");
  assertEquals(result.changeClass.effective, "standard");
  assertEquals(result.plan.acceptanceCriteria, undefined);
  assertEquals(result.issue, null);
});

Deno.test("resolveChangeClass: always applies the lane without a declaration", () => {
  const result = resolveChangeClass(undefined, plan(), "always");
  assertEquals(result.changeClass.effective, "light");
  assertEquals(result.plan.verificationPlan?.[0]?.kind, "manifest");
});

Deno.test("resolveChangeClass: rejects an incoherent light declaration rather than downgrading silently", () => {
  // Formal specs target handlers/functions and are discharged by the full gate.
  const withSpec = resolveChangeClass(
    "light",
    plan({
      formalSpecs: [{
        id: "spec_0",
        claimIds: ["claim_0"],
        technique: "exhaustive-switch",
        scope: "handler:processOrder",
        statement: "every action is handled",
        enforcement: "hard",
      }],
    }),
    "auto",
  );
  assert(withSpec.issue !== null);
  assertEquals(withSpec.changeClass.effective, "standard");

  // A must-claim IS a request for adversarial review.
  const withMust = resolveChangeClass(
    "light",
    plan({
      acceptanceCriteria: [{
        id: "claim_0",
        text: "Checkout never double-charges.",
        source: "user",
        priority: "must",
      }],
    }),
    "auto",
  );
  assert(withMust.issue !== null);
  assertEquals(withMust.changeClass.effective, "standard");

  // Too many steps is too much work for one synthesized criterion to cover.
  const tooLong = resolveChangeClass(
    "light",
    plan({
      steps: Array.from({ length: LIGHT_TIER_MAX_STEPS + 1 }, (_, i) => ({
        id: `step_${i}`,
        description: `Step ${i}`,
        status: "pending" as const,
      })),
    }),
    "auto",
  );
  assert(tooLong.issue !== null);
  assertEquals(tooLong.changeClass.effective, "standard");
});

Deno.test("resolveChangeClass: always falls back silently on an incoherent plan", () => {
  // Under `always` the agent did not choose the lane, so an ineligible plan is not
  // its mistake to fix — no issue is surfaced, the changeset is just standard.
  const result = resolveChangeClass(
    undefined,
    plan({
      acceptanceCriteria: [{
        id: "claim_0",
        text: "Checkout never double-charges.",
        source: "user",
        priority: "must",
      }],
    }),
    "always",
  );
  assertEquals(result.issue, null);
  assertEquals(result.changeClass.effective, "standard");
});

// --- verifyChangeClass ---

Deno.test("verifyChangeClass: confirms a light declaration the changelog agrees with", () => {
  const declared = resolveChangeClass("light", plan(), "auto").changeClass;
  const verified = verifyChangeClass(declared, [rec("asset", "styles.css")]);
  assertEquals(verified.effective, "light");
  assertEquals(verified.escalated, false);
});

Deno.test("verifyChangeClass: escalates and names the offending entity", () => {
  const declared = resolveChangeClass("light", plan(), "auto").changeClass;
  const verified = verifyChangeClass(declared, [
    rec("asset", "styles.css"),
    rec("schema", "todos"),
  ]);
  assertEquals(verified.effective, "standard");
  assertEquals(verified.escalated, true);
  assertEquals(verified.declared, "light");
  // The user must be able to see WHY, not just that it happened.
  assert(verified.reason.includes("schema:todos"));
});

Deno.test("verifyChangeClass: entity-count overflow reports the count, not a scope", () => {
  const declared = resolveChangeClass("light", plan(), "auto").changeClass;
  const many = Array.from(
    { length: LIGHT_TIER_MAX_ENTITIES + 1 },
    (_, i) => rec("asset", `a${i}.css`),
  );
  const verified = verifyChangeClass(declared, many);
  assertEquals(verified.effective, "standard");
  assertEquals(verified.escalated, true);
  assert(verified.reason.includes(String(LIGHT_TIER_MAX_ENTITIES + 1)));
});

Deno.test("verifyChangeClass: a standard declaration is never escalated or re-derived", () => {
  const verified = verifyChangeClass(undefined, [rec("schema", "todos")]);
  assertEquals(verified.effective, "standard");
  assertEquals(verified.escalated, false);
});

// --- policy table ---

Deno.test("TIER_POLICIES: light relaxes exactly what the lane is meant to relax", () => {
  const light = tierPolicy("light");
  assertEquals(light.allowsAutoApprove, true);
  assertEquals(light.synthesizesPlan, true);
  // The adversarial pass is the expensive model call the lane exists to avoid.
  assertEquals(light.runsAdversarialRefutation, false);
  // Only the model-dependent signals are waived; every deterministic check stays
  // hard. Both entries need a model verdict to clear, which is the whole criterion
  // for membership — a deterministic code must never be added here.
  assertEquals([...light.waivedReadinessCodes], [
    "MUST_CLAIM_UNREVIEWED",
    "UNCOVERED_INDEPENDENT_CRITERION",
    "PRIORITY_DOWNGRADED",
  ]);
  assertEquals(light.skipReason, SKIP_LIGHT_TIER);

  const standard = tierPolicy("standard");
  assertEquals(standard.allowsAutoApprove, false);
  assertEquals(standard.synthesizesPlan, false);
  assertEquals(standard.runsAdversarialRefutation, true);
  assertEquals(standard.waivedReadinessCodes.size, 0);
  assertEquals(Object.keys(TIER_POLICIES).sort(), ["light", "standard"]);
});
