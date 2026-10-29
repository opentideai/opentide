// The tool-capability seam (OpenTide §3.3): dispatch reads the verification
// tool handlers off the Kernel's composition. A coreOnlyComposition has none,
// so the getter throws; the open test composition returns them.
import { assertEquals, assertThrows } from "@std/assert";
import { verificationTools } from "./tool-capabilities.ts";
import { coreOnlyComposition } from "./composition.ts";
import { testComposition } from "../cli/test-composition.ts";

Deno.test("verificationTools() throws when the composition has no handlers", () => {
  assertThrows(
    () => verificationTools(coreOnlyComposition()),
    Error,
    "No tool handlers",
  );
});

Deno.test("the open composition returns the verification handlers", () => {
  const composition = testComposition();
  assertEquals(typeof verificationTools(composition).auditConfig, "function");
  assertEquals(
    typeof verificationTools(composition).validateChangesetPlan,
    "function",
  );
});
