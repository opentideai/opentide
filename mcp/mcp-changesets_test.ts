import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { Kernel } from "../core/registries.ts";
import { Database } from "../core/db.ts";
import { coreOnlyComposition } from "../core/composition.ts";
import { testComposition } from "../cli/test-composition.ts";
import { dispatchMcpTool, projectedMcpTools } from "./mcp-projection.ts";
import { APPROVE_CHANGESET } from "./mcp-changesets.ts";
import type { Changeset } from "../core/types.ts";

const testOpts = { sanitizeResources: false, sanitizeOps: false };
const noop = () => {};

async function withKernel<T>(fn: (kernel: Kernel) => Promise<T>): Promise<T> {
  const db = await Database.create({ driver: "pglite" });
  const kernel = new Kernel(db, { composition: testComposition() });
  try {
    return await fn(kernel);
  } finally {
    await db.close();
  }
}

function call(
  kernel: Kernel,
  name: string,
  args: Record<string, unknown>,
  sessionId?: string,
) {
  return dispatchMcpTool(
    name,
    args,
    kernel,
    noop,
    sessionId ? { sessionId, userMessage: "External MCP agent" } : undefined,
  );
}

// The data block: the first text block that parses as JSON.
function data<T>(result: Awaited<ReturnType<typeof call>>): T {
  assertEquals(result.isError, undefined, JSON.stringify(result.content));
  for (const block of result.content) {
    if (block.type !== "text") continue;
    try {
      return JSON.parse(block.text) as T;
    } catch {
      // A note before the data.
    }
  }
  throw new Error("no JSON block");
}

function errorText(result: Awaited<ReturnType<typeof call>>): string {
  assertEquals(result.isError, true);
  const block = result.content[0];
  assert(block?.type === "text");
  return block.text;
}

const standardPlan = {
  title: "Add a page",
  plan: {
    summary: "Add a page.",
    steps: ["Add the handler", "Add the route", "Add a test"],
    acceptanceCriteria: [{
      id: "claim_0",
      text: "The page loads.",
      priority: "should",
    }],
    verificationPlan: [{
      id: "v1",
      claimIds: ["claim_0"],
      kind: "unit",
      description: "Load the page.",
    }],
  },
};

const lightPlan = {
  title: "Fix a label",
  change_class: "light",
  plan: { summary: "Fix the label.", steps: ["Change the label"] },
};

Deno.test({
  ...testOpts,
  name: "approve_changeset is listed on the MCP face only with changesets",
  fn: () => {
    const listed = (names: string[]) => names.includes(APPROVE_CHANGESET);
    assert(listed(projectedMcpTools(testComposition()).map((t) => t.name)));
    assert(
      !listed(projectedMcpTools(coreOnlyComposition()).map((t) => t.name)),
    );
  },
});

Deno.test({
  ...testOpts,
  name: "await_approval leaves a plan in planning until approve_changeset",
  fn: async () => {
    await withKernel(async (kernel) => {
      const session = await kernel.sessions.createSession("client");
      const created = data<Changeset>(
        await call(kernel, "create_changeset", {
          ...standardPlan,
          await_approval: true,
        }, session.id),
      );
      assertEquals(created.status, "planning");

      const active = data<{ changeset: Changeset | null }>(
        await call(kernel, "get_changeset", {}, session.id),
      );
      assertEquals(active.changeset?.id, created.id);
      assertEquals(active.changeset?.status, "planning");

      const started = data<Changeset>(
        await call(
          kernel,
          APPROVE_CHANGESET,
          { changeset_id: created.id },
          session.id,
        ),
      );
      assertEquals(started.status, "in_progress");
      assertEquals(started.plan.changeClass?.autoApproved, undefined);

      // Approving again is harmless: it is already started.
      const again = data<Changeset>(
        await call(
          kernel,
          APPROVE_CHANGESET,
          { changeset_id: created.id },
          session.id,
        ),
      );
      assertEquals(again.status, "in_progress");
    });
  },
});

Deno.test({
  ...testOpts,
  name: "without await_approval an MCP plan still starts at once",
  fn: async () => {
    await withKernel(async (kernel) => {
      const session = await kernel.sessions.createSession("client");
      const created = data<Changeset>(
        await call(kernel, "create_changeset", standardPlan, session.id),
      );
      assertEquals(created.status, "in_progress");
    });
  },
});

Deno.test({
  ...testOpts,
  name: "approve_changeset's light lane starts light work only, and says so",
  fn: async () => {
    await withKernel(async (kernel) => {
      const session = await kernel.sessions.createSession("client");
      const standard = data<Changeset>(
        await call(kernel, "create_changeset", {
          ...standardPlan,
          await_approval: true,
        }, session.id),
      );
      assertStringIncludes(
        errorText(
          await call(kernel, APPROVE_CHANGESET, {
            changeset_id: standard.id,
            light_lane: true,
          }, session.id),
        ),
        "NOT_LIGHT_LANE",
      );
      assertEquals(
        (await kernel.changesets.get(standard.id))?.status,
        "planning",
      );
      await kernel.changesets.abandon(standard.id);

      const light = data<Changeset>(
        await call(kernel, "create_changeset", {
          ...lightPlan,
          await_approval: true,
        }, session.id),
      );
      assertEquals(light.plan.changeClass?.effective, "light");
      const started = data<Changeset>(
        await call(kernel, APPROVE_CHANGESET, {
          changeset_id: light.id,
          light_lane: true,
        }, session.id),
      );
      assertEquals(started.status, "in_progress");
      assertEquals(started.plan.changeClass?.autoApproved, true);
      assertEquals(started.approvalMessageId ?? null, null);
    });
  },
});

Deno.test({
  ...testOpts,
  name: "get_changeset and approve_changeset refuse what isn't there",
  fn: async () => {
    await withKernel(async (kernel) => {
      assertStringIncludes(
        errorText(
          await call(kernel, "get_changeset", { changeset_id: "cs_nope" }),
        ),
        "CHANGESET_NOT_FOUND",
      );
      assertStringIncludes(
        errorText(
          await call(kernel, APPROVE_CHANGESET, { changeset_id: "cs_nope" }),
        ),
        "CHANGESET_NOT_FOUND",
      );
      const session = await kernel.sessions.createSession("client");
      const none = data<{ changeset: Changeset | null }>(
        await call(kernel, "get_changeset", {}, session.id),
      );
      assertEquals(none.changeset, null);
    });
  },
});

Deno.test({
  ...testOpts,
  name: "approve_changeset is refused where changesets aren't installed",
  fn: async () => {
    const db = await Database.create({ driver: "pglite" });
    try {
      const kernel = new Kernel(db, { composition: coreOnlyComposition() });
      assertStringIncludes(
        errorText(
          await call(kernel, APPROVE_CHANGESET, { changeset_id: "cs_x" }),
        ),
        "not available",
      );
    } finally {
      await db.close();
    }
  },
});
