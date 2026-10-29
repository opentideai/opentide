// @layer core — taking a project over from the serve process that holds it.
//
// One process owns a project at a time (project-lock.ts). When that process is
// a headless `opentide serve`, usually one an MCP bridge started for Claude Code
// or another client, Tide can ask it to let go and open the project itself. The
// holder closes the project (ending its MCP sessions), answers, and exits. Its
// clients' bridges then find the new holder and carry on (mcp/mcp-bridge.ts).
//
// The holder says whether it can be taken over in its lock record. Only a
// single-project serve does: a launcher-mode kernel has an IDE on it, and pulling
// a project out from under that IDE isn't a handover.
import {
  CONTROL_PROJECT_RELEASE_PATH,
  DEV_SERVER_HOST,
  PROJECT_TAKEOVER_POLL_MS,
  PROJECT_TAKEOVER_TIMEOUT_MS,
} from "./config.ts";
import {
  isProjectLockHeld,
  type ProjectLockHolder,
  readLockHolder,
} from "./project-lock.ts";
import { readServerToken } from "./server-token.ts";
import type { Result } from "./types.ts";
import { errorMessage } from "./util.ts";

// True when the process holding the project will hand it over on request.
export function canTakeOver(holder: ProjectLockHolder | null): boolean {
  return holder?.role === "serve" && holder.controlPort !== undefined &&
    holder.handover === true;
}

// The lock holder a refusal can offer to take over from, for the IDE's button.
export function takeoverCandidate(
  projectDir: string,
): { pid: number; process: string } | null {
  if (!isProjectLockHeld(projectDir)) return null;
  const holder = readLockHolder(projectDir);
  return holder && canTakeOver(holder)
    ? { pid: holder.pid, process: holder.process }
    : null;
}

export interface TakeoverOptions {
  timeoutMs?: number;
  pollMs?: number;
}

function fail(code: string, message: string): Result<never> {
  return { ok: false, error: { code, message } };
}

async function askToRelease(
  holder: ProjectLockHolder,
  token: string,
): Promise<Result<void>> {
  const url =
    `http://${DEV_SERVER_HOST}:${holder.controlPort}${CONTROL_PROJECT_RELEASE_PATH}`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) {
      await res.body?.cancel();
      return { ok: true, data: undefined };
    }
    const body = await res.json().catch(() => ({})) as {
      error?: string;
      code?: string;
    };
    return fail(
      body.code ?? "TAKEOVER_REFUSED",
      body.error ?? `The serve process answered ${res.status}.`,
    );
  } catch (err) {
    return fail(
      "TAKEOVER_UNREACHABLE",
      `Couldn't reach the serve process holding the project (pid ${holder.pid}): ${
        errorMessage(err)
      }`,
    );
  }
}

/**
 * Ask the serve process holding `projectDir` to close it, and wait until the
 * lock is free. The caller opens the project straight after: the holder's MCP
 * bridges wait a moment before looking for the new owner, so the caller wins.
 */
export async function takeOverProject(
  projectDir: string,
  opts: TakeoverOptions = {},
): Promise<Result<void>> {
  if (!isProjectLockHeld(projectDir)) return { ok: true, data: undefined };
  const holder = readLockHolder(projectDir);
  if (!holder || !canTakeOver(holder)) {
    return fail(
      "TAKEOVER_UNSUPPORTED",
      "The process holding this project can't hand it over. Close it there " +
        "and try again.",
    );
  }
  const token = readServerToken(projectDir);
  if (!token) {
    return fail(
      "TAKEOVER_UNSUPPORTED",
      "The serve process holding this project hasn't written its token yet.",
    );
  }
  const released = await askToRelease(holder, token);
  if (!released.ok) return released;

  const deadline = Date.now() + (opts.timeoutMs ?? PROJECT_TAKEOVER_TIMEOUT_MS);
  while (isProjectLockHeld(projectDir)) {
    if (Date.now() >= deadline) {
      return fail(
        "TAKEOVER_TIMEOUT",
        `The serve process (pid ${holder.pid}) agreed to close the project ` +
          `but still holds it.`,
      );
    }
    await new Promise((r) =>
      setTimeout(r, opts.pollMs ?? PROJECT_TAKEOVER_POLL_MS)
    );
  }
  return { ok: true, data: undefined };
}
