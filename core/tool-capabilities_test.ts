// The tool-capability seam (OpenTide §3.3): dispatch reads verification/agent
// tool handlers off the Kernel's composition. A coreOnlyComposition has none, so
// the getters throw; the open test composition returns the verification ones
// and still throws for the agent's (tide/tool-capabilities_test.ts covers the
// full composition).
import { assertEquals, assertThrows } from "@std/assert";
import { agentTools, verificationTools } from "./tool-capabilities.ts";
import { coreOnlyComposition } from "./composition.ts";
import { testComposition } from "../cli/test-composition.ts";

Deno.test("verificationTools()/agentTools() throw when the composition has no handlers", () => {
  const composition = coreOnlyComposition();
  assertThrows(() => verificationTools(composition), Error, "No tool handlers");
  assertThrows(() => agentTools(composition), Error, "No tool handlers");
});

Deno.test("the open composition returns verification handlers and no agent ones", () => {
  const composition = testComposition();
  assertEquals(typeof verificationTools(composition).executeAudit, "function");
  assertEquals(
    typeof verificationTools(composition).validateChangesetPlan,
    "function",
  );
  assertThrows(() => agentTools(composition), Error, "No tool handlers");
});
