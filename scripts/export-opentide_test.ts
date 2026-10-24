import { assert, assertEquals } from "@std/assert";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  MIRROR_DOCS,
  mirrorDenoJson,
  writeOpenTree,
} from "./export-opentide.ts";

// The tree is cut from HEAD, so it needs a git checkout; the open-standalone
// gate runs the open tests in a plain copy.
const inGitCheckout = new Deno.Command("git", {
  args: ["rev-parse", "--is-inside-work-tree"],
  cwd: new URL(".", import.meta.url),
  stdout: "null",
  stderr: "null",
}).outputSync().success;

Deno.test("mirrorDenoJson keeps only tasks whose paths are in the tree", () => {
  const tree = new Set(["cli/cli.ts", "core"]);
  const { json, droppedTasks } = mirrorDenoJson(
    {
      tasks: {
        opentide: "deno run --allow-read cli/cli.ts",
        kernel: "deno run --allow-read tide/main.ts",
        test: "deno test --allow-read",
        check: "deno check core/ tide/",
      },
      exclude: ["auth"],
      imports: { hono: "npm:hono@4" },
    },
    (path) => tree.has(path.replace(/\/$/, "")),
  );
  assertEquals(Object.keys(json.tasks ?? {}).sort(), ["opentide", "test"]);
  assertEquals(droppedTasks.sort(), ["check", "kernel"]);
  assertEquals(json.exclude, undefined);
  assertEquals(json.license, "Apache-2.0");
  assertEquals(json.imports, { hono: "npm:hono@4" });
});

Deno.test({
  name: "writeOpenTree: the open set, the shipped docs and the README",
  ignore: !inGitCheckout,
}, async () => {
  const dest = await Deno.makeTempDir({ prefix: "opentide-tree-test-" });
  try {
    await writeOpenTree(dest);
    for (const path of ["README.md", ".gitignore", "LICENSE", "cli/cli.ts"]) {
      assert(existsSync(join(dest, path)), `missing ${path}`);
    }
    for (const doc of MIRROR_DOCS) assert(existsSync(join(dest, doc)), doc);
    assertEquals(readdirSync(join(dest, "docs")).length, MIRROR_DOCS.length);
    for (
      const closed of ["agent", "tide", "auth", "ide", "desktop", "mirror"]
    ) {
      assert(!existsSync(join(dest, closed)), `${closed}/ leaked`);
    }
    const tasks = JSON.parse(await Deno.readTextFile(join(dest, "deno.json")))
      .tasks as Record<string, string>;
    assert(tasks.opentide);
    assert(!tasks.kernel, "the Tide kernel task leaked");
  } finally {
    await Deno.remove(dest, { recursive: true });
  }
});
