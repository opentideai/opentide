// Phase 6 gate (OpenTide §3.3): the layer seams compose cleanly when present and
// are absent-safe when not. One parametric harness boots a Kernel under the open
// assemblies — core-only, core+verification — and asserts the surface each
// exposes: what throws, what degrades, and which tool verbs the MCP projection
// advertises. Because every seam now travels on the Kernel's composition, an
// assembly is just a CompositionContext — no global state to set up or tear down.
import {
  assert,
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { Database } from "../core/db.ts";
import { Kernel } from "../core/registries.ts";
import {
  type CompositionContext,
  coreOnlyComposition,
} from "../core/composition.ts";
import { verificationOnlyComposition } from "../cli/assembly.ts";
import { executeAudit } from "../verification/audit-runner.ts";
import { dispatchMcpTool, projectedMcpTools } from "../mcp/mcp-projection.ts";
import { TOOL_CAPABILITY_REQUIREMENTS } from "../core/tool-capabilities.ts";

const noop = () => {};

// The capability-gated verbs, split by which layer each requires — the harness
// asserts advertisement against exactly these, derived from the single registry.
const GATED_VERBS = Object.keys(TOOL_CAPABILITY_REQUIREMENTS);
const VERIFICATION_VERBS = GATED_VERBS.filter(
  (v) => TOOL_CAPABILITY_REQUIREMENTS[v] === "verification",
);
const AGENT_VERBS = GATED_VERBS.filter(
  (v) => TOOL_CAPABILITY_REQUIREMENTS[v] === "agent",
);

async function withKernel(
  composition: CompositionContext,
  fn: (kernel: Kernel) => Promise<void>,
): Promise<void> {
  const db = await Database.create({ driver: "pglite" });
  const kernel = new Kernel(db, { composition });
  try {
    await fn(kernel);
  } finally {
    await db.close();
  }
}

function advertisedVerbs(composition: CompositionContext): Set<string> {
  return new Set(projectedMcpTools(composition).map((t) => t.name));
}

// core-only: the Kernel boots and serves the core surface, but the
// verification-governed stores are absent (they throw on touch) and every
// capability-gated verb is hidden from the MCP projection.
Deno.test("core-only assembly: stores throw, all capability verbs hidden, dispatch degrades", async () => {
  const composition = coreOnlyComposition();
  await withKernel(composition, async (kernel) => {
    assertThrows(() => kernel.changesets, Error, "No store factory");
    assertThrows(() => kernel.audits, Error, "No store factory");

    const advertised = advertisedVerbs(composition);
    for (const verb of GATED_VERBS) {
      assert(!advertised.has(verb), `${verb} should be hidden in core-only`);
    }
    // An ungated read verb stays advertised — core still serves it.
    assert(advertised.has("list_routes"), "ungated read verb should remain");

    // Dispatching a hidden verb returns a clean not-available result, not a throw.
    const result = await dispatchMcpTool("run_audit", {}, kernel, noop);
    assertEquals(result.isError, true);
    const block = result.content[0];
    assert(block?.type === "text");
    assertStringIncludes(block.text, "not available");
  });
});

// core+verification: stores work and deterministic verification (changeset
// governance, audits infrastructure) is advertised, but the agent's verbs are
// hidden and the model-backed audit degrades to "not configured" — the executable
// proof that model audits + refutation live entirely in the agent assembly.
Deno.test("core+verification assembly: stores work, verification advertised, agent absent, model audit not configured", async () => {
  const composition = verificationOnlyComposition();
  await withKernel(composition, async (kernel) => {
    assertEquals(await kernel.changesets.list(), []);
    assertEquals(kernel.audits.list(), []);

    const advertised = advertisedVerbs(composition);
    for (const verb of VERIFICATION_VERBS) {
      assert(
        advertised.has(verb),
        `${verb} should be advertised with verification`,
      );
    }
    for (const verb of AGENT_VERBS) {
      assert(
        !advertised.has(verb),
        `${verb} (agent) should be hidden with no agent`,
      );
    }

    const result = await executeAudit("security", kernel);
    assertEquals(result.status, "error");
    assert(
      result.error?.includes("provider"),
      "model audit must report the provider is not configured",
    );
  });
});

// The full assembly (every capability verb advertised) is the closed Tide stack;
// its case lives in tide/assembly_test.ts.
