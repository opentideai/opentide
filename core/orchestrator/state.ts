// @layer core — the orchestrator's persisted state model (Feature B / B1b).
//
// The supervisor persists the RUNNING SET so a boot can re-spawn it (decision #5):
// which projects should be running, the last control port each used, and the last
// observed exit — the minimum needed to reconstruct desiredState across an
// orchestrator restart. Live values (actualState, the child handle, stdout reader)
// stay in memory (supervisor.ts) and are NOT persisted. The file is a sibling of
// the project registry at getTideDir()/orchestrator.json, written with the shared
// atomic-json primitive (atomic tmp+rename write, corruption-quarantine read).
// See docs/orchestrator-design.md §5.

import { readEnv } from "../process-env.ts";
import { join } from "node:path";
import { getTideDir, OPENTIDE_ORCHESTRATOR_STATE_PATH_ENV } from "../config.ts";
import { readJsonQuarantine, writeJsonAtomic } from "../atomic-json.ts";

// Filename of the orchestrator state file, sibling to registry.json in getTideDir().
export const ORCHESTRATOR_STATE_FILE = "orchestrator.json";

// The schema version the on-disk file carries. Bump only on an incompatible shape
// change; a mismatched/absent version is treated as corrupt → empty (never migrate
// silently, never brick boot).
export const ORCHESTRATOR_STATE_VERSION = 1;

// What the reconciler drives a child toward. Only these two states persist;
// transient in-memory states (starting/crashed/failed) are never written here.
export type DesiredState = "running" | "stopped";

// A child's last observed process exit, surfaced in the dashboard (B3).
export interface ChildExit {
  code: number | null; // Deno.CommandStatus.code
  signal: string | null; // Deno.CommandStatus.signal (e.g. "SIGTERM")
  at: string; // ISO 8601
}

// The persisted per-project record. Only fields the orchestrator must RECONSTRUCT
// across a restart belong here; live values stay in memory (§5.1).
export interface OrchestratorProjectRecord {
  // Absolute path; the identity key. At most one running child per path (the
  // PGlite data-dir lock, plan line 550) — the reconciler enforces it.
  projectPath: string;
  // What the reconciler drives toward.
  desiredState: DesiredState;
  // Last assigned control port (the routing key). A boot re-spawn PREFERS it for
  // URL stability but must re-verify it is free and fall through to reallocation.
  controlPort?: number;
  // Last child pid — advisory only. The process is gone after an orchestrator
  // restart, so a persisted pid is treated as stale on boot.
  pid?: number;
  lastStartedAt?: string; // ISO 8601
  lastExit?: ChildExit | null; // last observed exit, for the dashboard
  // DISPLAY ONLY, non-authoritative (§3.5) — the live app port is read from the
  // child's /api/project/preview-port, never from here.
  lastKnownAppPort?: number | null;
}

export interface OrchestratorState {
  version: typeof ORCHESTRATOR_STATE_VERSION;
  projects: OrchestratorProjectRecord[];
}

// The empty state a fresh install (or a quarantined-corrupt file) degrades to.
export function emptyOrchestratorState(): OrchestratorState {
  return { version: ORCHESTRATOR_STATE_VERSION, projects: [] };
}

// Absolute path of the live state file (sibling of registry.json). A
// OPENTIDE_ORCHESTRATOR_STATE_PATH env override wins when set — the seam an
// integration test (or a side-by-side orchestrator) uses to redirect at a temp
// file without touching the real ~/.config/opentide/orchestrator.json. Callers
// that already hold their own path pass it to the read/write helpers directly.
export function getOrchestratorStatePath(): string {
  const override = readEnv(OPENTIDE_ORCHESTRATOR_STATE_PATH_ENV);
  if (override) return override;
  return join(getTideDir(), ORCHESTRATOR_STATE_FILE);
}

// Read + validate the state file, degrading to an empty running set (and
// quarantining the bad file) on absence, parse error, or a structurally-wrong
// shape — a corrupt state file must never brick orchestrator boot (§5, §6.3).
// Path-parameterized so tests never touch the real ~/.config/opentide file.
export function readOrchestratorState(path: string): OrchestratorState {
  return readJsonQuarantine(path, emptyOrchestratorState, normalizeState);
}

// Persist the state atomically (tmp + rename). Only running/stopped desiredState
// and the reconstruct-only fields are written (the caller builds the records).
export function writeOrchestratorState(
  path: string,
  state: OrchestratorState,
): void {
  writeJsonAtomic(path, state);
}

// Validate + normalize a parsed value into an OrchestratorState, or return null
// (→ quarantine + empty) when the top-level shape is wrong. Individual malformed
// records are DROPPED rather than nuking the whole file, so one bad entry can't
// lose the rest of the running set.
function normalizeState(raw: unknown): OrchestratorState | null {
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  if (obj.version !== ORCHESTRATOR_STATE_VERSION) return null;
  if (!Array.isArray(obj.projects)) return null;
  const projects: OrchestratorProjectRecord[] = [];
  for (const entry of obj.projects) {
    const record = normalizeRecord(entry);
    if (record) projects.push(record);
  }
  return { version: ORCHESTRATOR_STATE_VERSION, projects };
}

function isDesiredState(v: unknown): v is DesiredState {
  return v === "running" || v === "stopped";
}

function normalizeExit(v: unknown): ChildExit | null | undefined {
  if (v === null) return null;
  if (typeof v !== "object") return undefined;
  const e = v as Record<string, unknown>;
  const code = typeof e.code === "number" ? e.code : null;
  const signal = typeof e.signal === "string" ? e.signal : null;
  const at = typeof e.at === "string" ? e.at : undefined;
  if (at === undefined) return undefined;
  return { code, signal, at };
}

// A record needs at least a projectPath (identity) and a valid desiredState;
// anything else is dropped. Optional fields are copied only when well-typed.
function normalizeRecord(raw: unknown): OrchestratorProjectRecord | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.projectPath !== "string" || r.projectPath.length === 0) {
    return null;
  }
  if (!isDesiredState(r.desiredState)) return null;
  const record: OrchestratorProjectRecord = {
    projectPath: r.projectPath,
    desiredState: r.desiredState,
  };
  if (typeof r.controlPort === "number") record.controlPort = r.controlPort;
  if (typeof r.pid === "number") record.pid = r.pid;
  if (typeof r.lastStartedAt === "string") {
    record.lastStartedAt = r.lastStartedAt;
  }
  const exit = normalizeExit(r.lastExit);
  if (exit !== undefined) record.lastExit = exit;
  if (typeof r.lastKnownAppPort === "number" || r.lastKnownAppPort === null) {
    record.lastKnownAppPort = r.lastKnownAppPort;
  }
  return record;
}
