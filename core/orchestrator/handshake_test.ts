import { assertEquals } from "@std/assert";
import {
  type ChildReadyLine,
  formatReadyLine,
  isChildReadyLine,
  isOrchestratedChild,
  OPENTIDE_ORCHESTRATED_ENV,
  OPENTIDE_ORCHESTRATED_ON,
} from "./handshake.ts";

const SAMPLE: ChildReadyLine = {
  genie: "ready",
  controlPort: 3101,
  appPort: null,
  pid: 48213,
  project: "/abs/path/to/project",
};

Deno.test("formatReadyLine emits exactly one newline-terminated JSON frame", () => {
  const out = formatReadyLine(SAMPLE);
  assertEquals(out.endsWith("\n"), true);
  // Exactly one line (one trailing newline, no embedded ones).
  assertEquals(out.split("\n").filter((l) => l.length > 0).length, 1);
  assertEquals(JSON.parse(out), SAMPLE);
});

Deno.test("isChildReadyLine accepts a valid frame and rejects junk", () => {
  assertEquals(isChildReadyLine(SAMPLE), true);
  assertEquals(isChildReadyLine({ ...SAMPLE, appPort: 52189 }), true);
  // A regular human log line parsed as JSON would fail these.
  assertEquals(isChildReadyLine(null), false);
  assertEquals(isChildReadyLine("Control server listening on :3101"), false);
  assertEquals(isChildReadyLine({ genie: "starting" }), false);
  // Missing the numeric fields the supervisor relies on.
  assertEquals(isChildReadyLine({ genie: "ready" }), false);
  assertEquals(
    isChildReadyLine({ genie: "ready", controlPort: "3101", pid: 1 }),
    false,
  );
});

Deno.test("format→parse→guard round-trips a real frame", () => {
  const parsed: unknown = JSON.parse(formatReadyLine(SAMPLE));
  assertEquals(isChildReadyLine(parsed), true);
});

Deno.test("isOrchestratedChild honors the env sentinel", () => {
  const prev = Deno.env.get(OPENTIDE_ORCHESTRATED_ENV);
  try {
    Deno.env.delete(OPENTIDE_ORCHESTRATED_ENV);
    assertEquals(isOrchestratedChild(), false);
    Deno.env.set(OPENTIDE_ORCHESTRATED_ENV, OPENTIDE_ORCHESTRATED_ON);
    assertEquals(isOrchestratedChild(), true);
    // Only the exact sentinel counts.
    Deno.env.set(OPENTIDE_ORCHESTRATED_ENV, "true");
    assertEquals(isOrchestratedChild(), false);
  } finally {
    if (prev === undefined) Deno.env.delete(OPENTIDE_ORCHESTRATED_ENV);
    else Deno.env.set(OPENTIDE_ORCHESTRATED_ENV, prev);
  }
});
