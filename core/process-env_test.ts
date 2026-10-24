import { assertEquals } from "@std/assert";
import { readEnv } from "./process-env.ts";

function withEnv(vars: Record<string, string | undefined>, fn: () => void) {
  const before = Object.fromEntries(
    Object.keys(vars).map((k) => [k, Deno.env.get(k)]),
  );
  const apply = (v: Record<string, string | undefined>) => {
    for (const [k, val] of Object.entries(v)) {
      if (val === undefined) Deno.env.delete(k);
      else Deno.env.set(k, val);
    }
  };
  apply(vars);
  try {
    fn();
  } finally {
    apply(before);
  }
}

Deno.test("readEnv prefers OPENTIDE_*, falls back to GENIE_*", () => {
  withEnv({ OPENTIDE_ENV_PROBE: undefined, GENIE_ENV_PROBE: "old" }, () => {
    assertEquals(readEnv("OPENTIDE_ENV_PROBE"), "old");
  });
  withEnv({ OPENTIDE_ENV_PROBE: "new", GENIE_ENV_PROBE: "old" }, () => {
    assertEquals(readEnv("OPENTIDE_ENV_PROBE"), "new");
  });
  withEnv({ OPENTIDE_ENV_PROBE: "", GENIE_ENV_PROBE: "old" }, () => {
    assertEquals(readEnv("OPENTIDE_ENV_PROBE"), "");
  });
});

Deno.test("readEnv leaves other names alone", () => {
  withEnv({ ENV_PROBE: undefined, GENIE_ENV_PROBE: "old" }, () => {
    assertEquals(readEnv("ENV_PROBE"), undefined);
  });
});
