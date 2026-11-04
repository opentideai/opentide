import { assertEquals } from "@std/assert";
import { startingToolsets } from "./project-toolsets.ts";
import { selectionNames } from "./tools/toolsets.ts";
import { getProjectPaths } from "./project-manager.ts";

function projectWith(manifest: Record<string, unknown>): string {
  const dir = Deno.makeTempDirSync();
  Deno.writeTextFileSync(
    getProjectPaths(dir).manifest,
    JSON.stringify({ name: "t", createdAt: "2026-11-04", ...manifest }),
  );
  return dir;
}

Deno.test("startingToolsets: requested, then opentide.json, then core", () => {
  const dir = projectWith({ toolsets: ["docs", "nope"] });
  try {
    const fromManifest = startingToolsets(dir, null);
    assertEquals(selectionNames(fromManifest.selection), ["core", "docs"]);
    assertEquals(fromManifest.unknown, ["nope"]);
    const requested = startingToolsets(dir, "git");
    assertEquals(selectionNames(requested.selection), ["core", "git"]);
    assertEquals(selectionNames(startingToolsets(null, null).selection), [
      "core",
    ]);
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test("startingToolsets adds source on a source-backed project", () => {
  const dir = projectWith({ mode: "source-backed" });
  try {
    assertEquals(selectionNames(startingToolsets(dir, null).selection), [
      "core",
      "source",
    ]);
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});
