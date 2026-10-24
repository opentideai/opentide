// The Kernel store seam (OpenTide §3.3): changesets/audits are built per-Kernel
// from the composition's store factories. With a coreOnlyComposition the getters
// throw; with a store-bearing composition they build working, cached stores.
import { assertEquals, assertThrows } from "@std/assert";
import { Database } from "./db.ts";
import { Kernel } from "./registries.ts";
import { coreOnlyComposition } from "./composition.ts";
import { testStoreComposition } from "../verification/test-stores.ts";

Deno.test("kernel.changesets/.audits throw when the composition has no store factory", async () => {
  const db = await Database.create({ driver: "pglite" });
  const kernel = new Kernel(db, { composition: coreOnlyComposition() });
  try {
    assertThrows(() => kernel.changesets, Error, "No store factory");
    assertThrows(() => kernel.audits, Error, "No store factory");
  } finally {
    await db.close();
  }
});

Deno.test("a store-bearing composition builds working stores via the getters", async () => {
  const db = await Database.create({ driver: "pglite" });
  const kernel = new Kernel(db, { composition: testStoreComposition() });
  try {
    assertEquals(await kernel.changesets.list(), []);
    assertEquals(kernel.audits.list(), []);
    // The getter caches: same instance on repeat access.
    assertEquals(kernel.changesets, kernel.changesets);
  } finally {
    await db.close();
  }
});
