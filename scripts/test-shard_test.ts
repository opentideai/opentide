import { assert, assertEquals } from "@std/assert";
import { join } from "node:path";
import { assignShards, listTestFiles } from "./test-shard.ts";

Deno.test("assignShards puts every file in exactly one shard, balanced by time", () => {
  const timings = { "a_test.ts": 300, "b_test.ts": 100, "c_test.ts": 100 };
  const files = ["a_test.ts", "b_test.ts", "c_test.ts", "new_test.ts"];
  const shards = assignShards(files, timings, 2);
  assertEquals(shards.flat().sort(), files);
  // The 300s file alone; the rest (100 + 100 + median 100) together.
  assertEquals(shards[0], ["a_test.ts"]);
  assertEquals(shards[1], ["b_test.ts", "c_test.ts", "new_test.ts"]);
});

Deno.test("assignShards: more shards than files leaves some empty", () => {
  const shards = assignShards(["a_test.ts"], {}, 3);
  assertEquals(shards.flat(), ["a_test.ts"]);
  assertEquals(shards.filter((s) => s.length === 0).length, 2);
});

Deno.test("listTestFiles finds test files and honours deno.json exclude", () => {
  const root = Deno.makeTempDirSync({ prefix: "test-shard-" });
  try {
    for (const dir of ["core", "auth", "node_modules/x"]) {
      Deno.mkdirSync(join(root, dir), { recursive: true });
    }
    for (
      const file of [
        "core/a_test.ts",
        "core/a.ts",
        "core/b.test.ts",
        "auth/c_test.ts",
        "node_modules/x/d_test.ts",
      ]
    ) Deno.writeTextFileSync(join(root, file), "");
    Deno.writeTextFileSync(
      join(root, "deno.json"),
      JSON.stringify({ exclude: ["auth/"] }),
    );
    assertEquals(listTestFiles(root), ["core/a_test.ts", "core/b.test.ts"]);
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("the recorded timings name test files that exist", () => {
  const timings: Record<string, number> = JSON.parse(
    Deno.readTextFileSync(new URL("./test-timings.json", import.meta.url)),
  );
  const root = new URL("..", import.meta.url).pathname;
  const files = new Set(listTestFiles(root));
  const stale = Object.keys(timings).filter((f) => !files.has(f));
  // A removed or renamed test leaves a stale entry; refresh the file then.
  assert(stale.length <= 5, `stale timings: ${stale.join(", ")}`);
});
