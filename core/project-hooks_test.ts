import { assert, assertEquals } from "@std/assert";
import { type ProjectInitHook, runProjectInitHooks } from "./project-hooks.ts";
import { coreOnlyComposition } from "./composition.ts";
import type { Kernel } from "./registries.ts";

// The hooks under test ignore the kernel body, so a stub carrying just the
// composition (which is where the hooks now live) suffices.
function kernelWithHooks(initHooks: ProjectInitHook[]): Kernel {
  return {
    composition: { ...coreOnlyComposition(), initHooks },
  } as unknown as Kernel;
}

Deno.test("project init hooks run in composition order", async () => {
  const order: number[] = [];
  const kernel = kernelWithHooks([
    () => {
      order.push(1);
      return Promise.resolve();
    },
    () => {
      order.push(2);
      return Promise.resolve();
    },
  ]);
  await runProjectInitHooks(kernel);
  assertEquals(order, [1, 2]);
});

Deno.test("a throwing hook is best-effort and never aborts the rest", async () => {
  let ranAfter = false;
  const kernel = kernelWithHooks([
    () => Promise.reject(new Error("boom")),
    () => {
      ranAfter = true;
      return Promise.resolve();
    },
  ]);
  await runProjectInitHooks(kernel); // resolves despite the rejection
  assert(ranAfter);
});
