import { assert, assertEquals } from "@std/assert";
import { rmSync } from "node:fs";
import { Database } from "../core/db.ts";
import { Kernel } from "../core/registries.ts";
import { testStoreComposition } from "./test-stores.ts";
import type { ChangesetPlan, FormalSpecEnforcement } from "../core/types.ts";
import { defaultSaveRiskPolicy } from "./save-risk.ts";
import { TEST_TMP_DIR } from "../core/test-home_test.ts";

const testOpts = { sanitizeResources: false, sanitizeOps: false };

async function withKernel(
  fn: (kernel: Kernel) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({
    dir: TEST_TMP_DIR,
    prefix: "tideide-save-risk-",
  });
  const db = await Database.create({ driver: "pglite" });
  const kernel = new Kernel(db, { composition: testStoreComposition() });
  kernel.projectDir = dir;
  try {
    await fn(kernel);
  } finally {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

// A valid plan (create() asserts one) carrying one formal spec over `scope`.
function planWithSpec(
  scope: string,
  enforcement: FormalSpecEnforcement,
): ChangesetPlan {
  return {
    summary: "governs an entity",
    steps: [{ id: "s1", description: "change it", status: "pending" }],
    acceptanceCriteria: [
      { id: "c1", text: "invariant holds", source: "user", priority: "must" },
    ],
    verificationPlan: [
      {
        id: "v1",
        claimIds: ["c1"],
        kind: "invariant",
        description: "check it",
      },
    ],
    formalSpecs: [
      {
        id: "spec1",
        claimIds: ["c1"],
        technique: "exhaustive-switch",
        scope,
        statement: "the balance never goes negative",
        enforcement,
      },
    ],
  };
}

Deno.test(
  "no covering formal spec ⇒ transparent allow, no reason",
  testOpts,
  async () => {
    await withKernel(async (kernel) => {
      const verdict = await defaultSaveRiskPolicy(
        kernel,
        "handler",
        "getUsers",
        "x",
      );
      // Early return before any enforcement read ⇒ config-independent.
      assertEquals(verdict.decision, "allow");
      assertEquals(verdict.reason, undefined);
      assertEquals(verdict.changeset, undefined);
    });
  },
);

Deno.test(
  "a hard-enforced spec over the entity is a risk signal",
  testOpts,
  async () => {
    await withKernel(async (kernel) => {
      await kernel.changesets.create({
        title: "governs processOrder",
        plan: planWithSpec("handler:processOrder", "hard"),
      });
      const verdict = await defaultSaveRiskPolicy(
        kernel,
        "handler",
        "processOrder",
        "x",
      );
      // Config-independent: whatever the ambient enforcement, a covered edit is either
      // gated (graduated/strict) or allowed-with-a-warning (advisory) — never a silent,
      // reason-less allow.
      const flagged = verdict.decision === "gate" ||
        verdict.reason !== undefined;
      assert(flagged, "expected the hard spec to be flagged as risk");
      if (verdict.decision === "gate") {
        assert(verdict.changeset, "a gate verdict must carry a changeset spec");
      }
    });
  },
);

Deno.test(
  "a soft-enforced spec is not gating risk ⇒ transparent allow",
  testOpts,
  async () => {
    await withKernel(async (kernel) => {
      await kernel.changesets.create({
        title: "soft-governs processOrder",
        plan: planWithSpec("handler:processOrder", "soft"),
      });
      const verdict = await defaultSaveRiskPolicy(
        kernel,
        "handler",
        "processOrder",
        "x",
      );
      // Soft specs only warn; they are filtered out before the enforcement read, so the
      // verdict is a clean allow regardless of policy.
      assertEquals(verdict.decision, "allow");
      assertEquals(verdict.reason, undefined);
    });
  },
);

Deno.test(
  "a spec scoped to a different entity does not flag this save",
  testOpts,
  async () => {
    await withKernel(async (kernel) => {
      await kernel.changesets.create({
        title: "governs processOrder",
        plan: planWithSpec("handler:processOrder", "hard"),
      });
      // Editing a DIFFERENT entity: the scope does not match.
      const verdict = await defaultSaveRiskPolicy(
        kernel,
        "handler",
        "getUsers",
        "x",
      );
      assertEquals(verdict.decision, "allow");
      assertEquals(verdict.reason, undefined);
    });
  },
);
