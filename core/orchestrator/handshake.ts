// @layer core — the child↔orchestrator handshake contract (Feature B / B1a).
// When the orchestrator spawns a per-project `opentide serve` child it sets
// OPENTIDE_ORCHESTRATED so the serve root emits ONE structured ChildReadyLine to
// stdout after the control server is listening and the project is loaded; the
// supervisor (B1b) parses that line to learn the child is up. Kept
// dependency-free so the emitter (cli/main.ts) and the future reader share one
// definition. See docs/orchestrator-design.md §3.

import { readEnv } from "../process-env.ts";

// Env var the orchestrator sets on a spawned child to request the ready line.
// A plain `deno task kernel` / `opentide serve` run leaves it unset and stays
// pure human logs — the frame is opt-in, not unconditional.
export const OPENTIDE_ORCHESTRATED_ENV = "OPENTIDE_ORCHESTRATED";
// The truthy sentinel value for OPENTIDE_ORCHESTRATED_ENV.
export const OPENTIDE_ORCHESTRATED_ON = "1";

// The single structured line a child serve-root emits once, post-bind.
export interface ChildReadyLine {
  // Discriminant. Always the literal "ready". Match on this.
  genie: "ready";
  // The bound control port. Confirms the value the orchestrator assigned.
  controlPort: number;
  // The bound app-preview port IF already listening, else null. The app server
  // is late-bound (an empty project has none at boot), so this is best-effort
  // and is NEVER the authoritative source — the supervisor reads the live value
  // from the child's GET /api/project/preview-port instead.
  appPort: number | null;
  // The child OS process id. Confirms Deno.Command's child.pid.
  pid: number;
  // The absolute project path this child loaded.
  project: string;
}

// True when this process was spawned by the orchestrator and should emit the
// ready line. A direct run (env unset) returns false and emits nothing.
export function isOrchestratedChild(): boolean {
  return readEnv(OPENTIDE_ORCHESTRATED_ENV) === OPENTIDE_ORCHESTRATED_ON;
}

// Serialize a ready line as exactly one newline-terminated stdout frame, so it
// is a single parseable line regardless of surrounding human logs.
export function formatReadyLine(line: ChildReadyLine): string {
  return JSON.stringify(line) + "\n";
}

// Type guard the supervisor uses on each parsed stdout line (B1b). Matches on
// the "ready" discriminant plus the two numeric fields it relies on.
export function isChildReadyLine(v: unknown): v is ChildReadyLine {
  return typeof v === "object" && v !== null &&
    (v as { genie?: unknown }).genie === "ready" &&
    typeof (v as { controlPort?: unknown }).controlPort === "number" &&
    typeof (v as { pid?: unknown }).pid === "number";
}
