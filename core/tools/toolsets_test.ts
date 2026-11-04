import { assert, assertEquals } from "@std/assert";
import {
  applySetToolset,
  CORE_ONLY,
  EVERY_TOOLSET,
  inListingOrder,
  parseToolsetList,
  parseToolsets,
  selectionNames,
  selects,
  SET_TOOLSET_TOOL,
  TOOLSET_NAMES,
  toolsetOf,
  toolsetOffMessage,
  TOOLSETS,
} from "./toolsets.ts";

Deno.test("no tool is in two toolsets", () => {
  const all = TOOLSET_NAMES.flatMap((s) => [...TOOLSETS[s]]);
  assertEquals(all.length, new Set(all).size);
});

Deno.test("parseToolsets always holds core and reports unknown names", () => {
  const { selection, unknown } = parseToolsets(["git", " docs ", "gti", ""]);
  assertEquals(selectionNames(selection), ["core", "docs", "git"]);
  assertEquals(unknown, ["gti"]);
});

Deno.test("parseToolsetList takes all", () => {
  assertEquals(
    selectionNames(parseToolsetList("all").selection),
    [...TOOLSET_NAMES],
  );
  assertEquals(selectionNames(parseToolsetList("").selection), ["core"]);
});

Deno.test("selects follows the tool's toolset", () => {
  assert(selects(CORE_ONLY, "create_changeset"));
  assert(!selects(CORE_ONLY, "git_push"));
  assert(selects(EVERY_TOOLSET, "git_push"));
  assert(!selects(EVERY_TOOLSET, "no_such_tool"));
  assertEquals(toolsetOf("git_push"), "git");
  assertEquals(toolsetOf("no_such_tool"), null);
});

Deno.test("applySetToolset turns a toolset on and off, idempotently", () => {
  const on = applySetToolset(CORE_ONLY, { toolset: "git", enabled: true });
  assert(on.ok && on.changed);
  assertEquals(selectionNames(on.selection), ["core", "git"]);
  const again = applySetToolset(on.selection, {
    toolset: "git",
    enabled: true,
  });
  assert(again.ok && !again.changed);
  const off = applySetToolset(on.selection, { toolset: "git", enabled: false });
  assert(off.ok && off.changed);
  assertEquals(selectionNames(off.selection), ["core"]);
});

Deno.test("applySetToolset refuses core, unknown names and a missing flag", () => {
  const core = applySetToolset(CORE_ONLY, { toolset: "core", enabled: false });
  assert(!core.ok && core.error.code === "TOOLSET_REQUIRED");
  const unknown = applySetToolset(CORE_ONLY, { toolset: "gti", enabled: true });
  assert(!unknown.ok && unknown.error.code === "UNKNOWN_TOOLSET");
  const flag = applySetToolset(CORE_ONLY, { toolset: "git" });
  assert(!flag.ok && flag.error.code === "INVALID_ARGUMENTS");
});

Deno.test("set_toolset offers every toolset but core", () => {
  const schema = SET_TOOLSET_TOOL.input_schema as {
    properties: { toolset: { enum: string[] } };
  };
  assertEquals(
    schema.properties.toolset.enum,
    TOOLSET_NAMES.filter((s) => s !== "core"),
  );
});

Deno.test("inListingOrder puts project_status and the changeset flow first", () => {
  const sorted = inListingOrder([
    { name: "git_push" },
    { name: "list_routes" },
    { name: "unknown_tool" },
    { name: "create_changeset" },
    { name: "project_status" },
  ]).map((t) => t.name);
  assertEquals(sorted, [
    "project_status",
    "create_changeset",
    "list_routes",
    "git_push",
    "unknown_tool",
  ]);
});

Deno.test("toolsetOffMessage names the toolset and both ways to turn it on", () => {
  const text = toolsetOffMessage("git_push", "git");
  assert(text.includes(`"git" toolset`));
  assert(text.includes("set_toolset"));
  assert(text.includes("opentide.json"));
});
