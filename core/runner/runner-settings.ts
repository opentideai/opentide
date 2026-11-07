// What a project lets its user-code runner do beyond the default, from
// `runner` in opentide.json:
//
//   "runner": { "net": ["localhost:5432", "api.stripe.com"], "ffi": true }
//
// `net` swaps open outbound for a list of the only hosts the runner can reach
// (./permissions.ts says what an entry may be). `ffi` allows native code, which
// Deno's permissions don't hold: with it on, the boundary is gone.
//
// Read at every spawn, so an edit takes effect at the runner's next start. A
// value of the wrong shape fails the spawn rather than fall back: the fallback
// is the default, and a project that asked for more wants to hear why it
// didn't get it.

import { readProjectManifestValue } from "../project-manager.ts";
import type { Result } from "../types.ts";
import { RUNNER_ERROR_CODES } from "./protocol.ts";

export interface RunnerSettings {
  net?: string[];
  ffi?: boolean;
}

export function readRunnerSettings(
  projectDir: string,
): Result<RunnerSettings> {
  return parseRunnerSettings(readProjectManifestValue(projectDir, "runner"));
}

export function parseRunnerSettings(value: unknown): Result<RunnerSettings> {
  if (value === undefined) return { ok: true, data: {} };
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return invalid("runner must be an object");
  }
  const { net, ffi, ...rest } = value as Record<string, unknown>;
  const unknownKey = Object.keys(rest)[0];
  if (unknownKey !== undefined) {
    return invalid(`runner.${unknownKey} isn't a runner setting`);
  }
  if (
    net !== undefined &&
    !(Array.isArray(net) && net.every((e) => typeof e === "string"))
  ) {
    return invalid("runner.net must be a list of strings");
  }
  if (ffi !== undefined && typeof ffi !== "boolean") {
    return invalid("runner.ffi must be true or false");
  }
  return { ok: true, data: { net, ffi } };
}

function invalid(message: string): Result<never> {
  return {
    ok: false,
    error: {
      code: RUNNER_ERROR_CODES.invalidSettings,
      message: `opentide.json: ${message}.`,
      suggestion:
        'Set "runner": { "net": ["localhost:5432"], "ffi": false }, or remove it.',
    },
  };
}

export const RUNNER_FFI_WARNING =
  "This project turns on ffi for its user-code runner (runner.ffi in opentide.json). Native code isn't held by Deno's permissions: it can read any file, reach the kernel and start processes.";
