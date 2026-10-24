// Test fixture (Feature B / B1b): a stand-in for a spawned `opentide serve` child
// that emits a valid ChildReadyLine to stdout — interleaved with human log lines,
// to prove the supervisor's line parser ignores non-JSON — then sleeps until it is
// killed. Used by supervisor_test.ts via a fixture SpawnFn so the real stdout
// piping + kill path is exercised without booting a kernel. NOT production code.

import { formatReadyLine } from "../handshake.ts";

function argValue(flag: string): string | undefined {
  const idx = Deno.args.indexOf(flag);
  return idx >= 0 ? Deno.args[idx + 1] : undefined;
}

const port = Number(argValue("--port") ?? "0");
const project = argValue("--project") ?? "";

// Human log lines around the frame — the supervisor must skip these and match only
// the structured ready line.
console.log("OpenTide starting...");
console.log(`  Control server listening on :${port}`);
await Deno.stdout.write(
  new TextEncoder().encode(
    formatReadyLine({
      genie: "ready",
      controlPort: port,
      appPort: null,
      pid: Deno.pid,
      project,
    }),
  ),
);
console.log("Kernel running. Press Ctrl+C to stop.");

// Sleep until SIGTERM/SIGKILL. A never-resolving promise keeps the process alive
// while holding no resources; the supervisor kills it on stop/shutdown.
await new Promise<never>(() => {});
