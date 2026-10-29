// @layer core — single-writer guard for a project's on-disk state.
//
// PGlite is an in-process Postgres. Nothing stops two OS processes from opening
// the same data directory at once, and when they do, two Postgres instances write
// the same files and the database is destroyed. This is not theoretical: it is how
// a project gets corrupted when an MCP server already has it open and someone
// starts a second kernel against the same path.
//
// Postgres's own `postmaster.pid` cannot prevent it. PGlite writes one, but the
// pid it records is the sentinel `-42` and the data directory it names is the
// WASM-internal `/pglite/data` — neither identifies a host process, so there is
// nothing to check for liveness. That is why openPgliteClient treats a leftover
// `postmaster.pid` as unconditionally stale and deletes it: from PGlite's own
// point of view that is correct, because an in-process postmaster cannot outlive
// its process. The flaw was never that reasoning — it was that nothing above it
// asked whether a DIFFERENT process was already using the directory.
//
// So the guard lives here instead, and uses an OS advisory lock rather than a pid
// file. The kernel holds an exclusive lock on `.opentide/kernel.lock` for as long
// as the project is open. The operating system releases it when the process exits
// — including when it is killed or crashes — so there is no stale-lock state to
// detect, clean up, or get wrong. A pid file would reintroduce exactly the
// liveness question this design exists to avoid.
import { adoptLegacyProjectLayout, projectStateDir } from "./project-layout.ts";
import { join } from "node:path";
import { mkdirSync, readFileSync } from "node:fs";
import { errorMessage } from "./util.ts";
import type { Result } from "./types.ts";

export const PROJECT_LOCK_FILE = "kernel.lock";

// Written into the lock file purely so a refusal can name who is holding it. The
// OS lock is the authority; this is diagnostics, and it is never trusted for a
// liveness decision.
export interface ProjectLockHolder {
  pid: number;
  startedAt: string;
  // The entrypoint that took the lock ("kernel", "mcp", …), so the message can
  // tell a user which of their processes to look at.
  process: string;
  // Set once the holder knows what it is serving. A `serve` holder with a
  // controlPort accepts MCP at that port; an `mcp` holder is a standalone MCP
  // server and nothing can attach to it.
  role?: ProjectLockRole;
  controlPort?: number;
  // Set by a serve that closes the project when asked (core/project-handover.ts).
  handover?: boolean;
}

export type ProjectLockRole = "serve" | "mcp";

export interface ProjectLockAdvert {
  role: ProjectLockRole;
  controlPort?: number;
  handover?: boolean;
}

export interface ProjectLock {
  // Rewrites the holder record with what this process serves. Best-effort, like
  // the original stamp: the OS lock is the authority, the record is a pointer.
  advertise(advert: ProjectLockAdvert): void;
  // Releases the lock and closes the file. Idempotent — a double release (close
  // path running twice, a test's finally after an explicit release) is a no-op
  // rather than a crash on an already-closed descriptor.
  release(): void;
}

function lockPath(projectDir: string): string {
  return join(projectStateDir(projectDir), PROJECT_LOCK_FILE);
}

// Best-effort read of whoever currently holds the lock, for the error message.
// Returns null when the file is absent, empty, or not the shape we wrote — none
// of which changes the outcome, only how well the refusal reads.
export function readLockHolder(projectDir: string): ProjectLockHolder | null {
  try {
    const raw = readFileSync(lockPath(projectDir), "utf-8").trim();
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ProjectLockHolder>;
    return typeof parsed.pid === "number"
      ? {
        pid: parsed.pid,
        startedAt: typeof parsed.startedAt === "string"
          ? parsed.startedAt
          : "an unknown time",
        process: typeof parsed.process === "string"
          ? parsed.process
          : "a Genie process",
        ...(parsed.role === "serve" || parsed.role === "mcp"
          ? { role: parsed.role }
          : {}),
        ...(typeof parsed.controlPort === "number"
          ? { controlPort: parsed.controlPort }
          : {}),
        ...(parsed.handover === true ? { handover: true } : {}),
      }
      : null;
  } catch {
    return null;
  }
}

// True when some process holds the project lock right now. The record can
// outlive its writer (kill -9 skips every cleanup), so a caller deciding whether
// to trust it asks the OS instead. Probes with a shared lock, released at once,
// and never writes the record.
export function isProjectLockHeld(projectDir: string): boolean {
  let file: Deno.FsFile;
  try {
    file = Deno.openSync(lockPath(projectDir), { read: true });
  } catch {
    return false; // no lock file: nobody has ever held it
  }
  try {
    const free = file.tryLockSync(false);
    if (free) file.unlockSync();
    return !free;
  } catch {
    return false;
  } finally {
    file.close();
  }
}

function describeHolder(holder: ProjectLockHolder | null): string {
  return holder
    ? `${holder.process} (pid ${holder.pid}, since ${holder.startedAt})`
    : "another Genie process";
}

// Truncate first: a previous record is longer or shorter than this one, and a
// partial overwrite would leave trailing bytes that break the JSON parse.
function writeHolder(file: Deno.FsFile, holder: ProjectLockHolder): void {
  try {
    file.truncateSync(0);
    file.seekSync(0, Deno.SeekMode.Start);
    file.writeSync(new TextEncoder().encode(JSON.stringify(holder)));
    file.syncSync();
  } catch {
    // Diagnostics only. Failing to record who we are must not fail the open —
    // we hold the lock, which is the part that matters.
  }
}

/**
 * Take exclusive ownership of a project's on-disk state for this process.
 *
 * Fails with PROJECT_ALREADY_OPEN rather than corrupting the database. The
 * caller must treat that as fatal for the open: continuing past it is precisely
 * the bug this prevents.
 *
 * `processName` identifies the entrypoint in the refusal message ("kernel",
 * "mcp", "lsp", …) — it has no bearing on the locking itself.
 */
export function acquireProjectLock(
  projectDir: string,
  processName = "kernel",
): Result<ProjectLock> {
  // The lock is the first thing written under the state dir; a fresh .opentide/
  // holding only the lock would stop an old .tideide/ from ever being adopted.
  adoptLegacyProjectLayout(projectDir);
  const path = lockPath(projectDir);
  try {
    mkdirSync(projectStateDir(projectDir), { recursive: true });
  } catch (err) {
    return {
      ok: false,
      error: {
        code: "PROJECT_LOCK_UNAVAILABLE",
        message: `Could not prepare the project lock directory: ${
          errorMessage(err)
        }`,
      },
    };
  }

  let file: Deno.FsFile;
  try {
    file = Deno.openSync(path, { create: true, write: true, read: true });
  } catch (err) {
    return {
      ok: false,
      error: {
        code: "PROJECT_LOCK_UNAVAILABLE",
        message: `Could not open the project lock: ${errorMessage(err)}`,
      },
    };
  }

  // tryLockSync, never lockSync: blocking here would hang the open behind a
  // process that may hold the project for hours, with no way for the user to
  // tell the difference between "starting" and "wedged".
  let acquired = false;
  try {
    acquired = file.tryLockSync(true);
  } catch (err) {
    file.close();
    return {
      ok: false,
      error: {
        code: "PROJECT_LOCK_UNAVAILABLE",
        message: `Could not lock the project: ${errorMessage(err)}`,
      },
    };
  }

  if (!acquired) {
    // Read the holder BEFORE closing our handle, then report who it is.
    const holder = readLockHolder(projectDir);
    file.close();
    return {
      ok: false,
      error: {
        code: "PROJECT_ALREADY_OPEN",
        message:
          `This project is already open in ${
            describeHolder(holder)
          }. Opening ` +
          `it twice would run two Postgres instances against the same data ` +
          `directory and corrupt the database.`,
        suggestion:
          "Use the process that already has it open, or stop that process and " +
          "try again. The lock is released automatically when it exits.",
      },
    };
  }

  // Stamp who we are, for the next process's refusal message.
  let holder: ProjectLockHolder = {
    pid: Deno.pid,
    startedAt: new Date().toISOString(),
    process: processName,
  };
  writeHolder(file, holder);

  let released = false;
  return {
    ok: true,
    data: {
      advertise(advert) {
        if (released) return;
        holder = { ...holder, ...advert };
        writeHolder(file, holder);
      },
      release() {
        if (released) return;
        released = true;
        try {
          file.unlockSync();
        } catch { /* the close below releases it regardless */ }
        try {
          file.close();
        } catch { /* already closed */ }
      },
    },
  };
}
