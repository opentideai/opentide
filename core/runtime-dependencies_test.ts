import { assert, assertEquals } from "@std/assert";
import { runtimeDependencies } from "./runtime-dependencies.ts";

Deno.test("runtimeDependencies excludes host-only root dependencies", () => {
  const names = runtimeDependencies().map((dependency) => dependency.name);
  for (
    const hostOnly of [
      "ai",
      "@ai-sdk/openai",
      "playwright",
      "typescript",
      "drizzle-kit",
    ]
  ) {
    assertEquals(names.includes(hostOnly), false);
  }
});

Deno.test("runtimeDependencies exposes exported runtime deps as non-importable", () => {
  const dependencies = runtimeDependencies();
  const byName = new Map(dependencies.map((dependency) => [
    dependency.name,
    dependency,
  ]));

  // Node-only: nothing the export emits imports Hono any more, and the Node artifact
  // declares it purely as @hono/node-server's peer.
  assertEquals(byName.get("hono")?.targets, ["node"]);
  assertEquals(byName.get("@electric-sql/pglite")?.targets, ["deno", "node"]);
  assertEquals(byName.get("@hono/node-server")?.targets, ["node"]);

  for (const dependency of dependencies) {
    assertEquals(dependency.appImportable, false);
    assert(dependency.reason.includes("packages.<name>"));
  }
});
