import { assertEquals } from "@std/assert";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { LocalStateStore } from "./local-state.ts";
import { TEST_TMP_DIR } from "./test-home_test.ts";

Deno.test("local state stores UI metadata in an ignored cache file", async () => {
  const dir = await Deno.makeTempDir({
    dir: TEST_TMP_DIR,
    prefix: "genie-local-state-",
  });
  const path = join(dir, ".opentide", "caches", "local-state.json");
  const store = new LocalStateStore(path);

  try {
    assertEquals(store.get("nav_history"), null);

    store.set("nav_history", { entries: [null, "handler:hello"], cursor: 1 });
    store.set("editor_positions", { "handler:hello": { line: 10 } });

    assertEquals(existsSync(path), true);
    assertEquals(store.get("nav_history"), {
      entries: [null, "handler:hello"],
      cursor: 1,
    });

    store.delete("nav_history");
    assertEquals(store.get("nav_history"), null);
    assertEquals(store.get("editor_positions"), {
      "handler:hello": { line: 10 },
    });

    store.delete("editor_positions");
    assertEquals(existsSync(path), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
