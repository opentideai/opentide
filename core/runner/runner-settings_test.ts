import { assert, assertEquals } from "@std/assert";
import { RUNNER_ERROR_CODES } from "./protocol.ts";
import { parseRunnerSettings } from "./runner-settings.ts";

Deno.test("no runner key is the default", () => {
  assertEquals(parseRunnerSettings(undefined), { ok: true, data: {} });
});

Deno.test("net and ffi are read as given", () => {
  const result = parseRunnerSettings({ net: ["localhost:5432"], ffi: true });
  assert(result.ok);
  assertEquals(result.data, { net: ["localhost:5432"], ffi: true });
});

Deno.test("a runner value of the wrong shape is refused, not ignored", () => {
  for (
    const bad of [
      null,
      "on",
      [],
      { net: "localhost:5432" },
      { net: [5432] },
      { ffi: "yes" },
      { allowNet: ["localhost:5432"] },
    ]
  ) {
    const result = parseRunnerSettings(bad);
    assert(!result.ok, JSON.stringify(bad));
    assertEquals(result.error.code, RUNNER_ERROR_CODES.invalidSettings);
  }
});
