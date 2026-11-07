// The Deno flags and environment a project's runner is spawned with. This is
// the boundary: the runner holds no API keys, can't spawn processes, can't
// reach the kernel or anything else on loopback, and can write only its own
// scratch dir.
//
// What it can read is only Deno's caches (npm packages read their own files)
// and its scratch dir. Not the project dir: that holds .opentide/kernel.token,
// .env, data/ and history/. User code reaches the project through the kernel.
//
// It gets no write on DENO_DIR. Deno's own loader fills the cache without any
// JS permission, and the kernel loads its npm code from that cache, so a
// writable cache would be a way back into the kernel.

import type { Result } from "../types.ts";
import { RUNNER_LOOPBACK_DENY_HOSTS } from "../config.ts";
import { RUNNER_ERROR_CODES } from "./protocol.ts";

export interface RunnerPermissionInput {
  // Read-only: Deno's cache dirs (DENO_DIR and the npm cache).
  cacheDirs: string[];
  // Read and write: the runner's scratch dir, also its TMPDIR.
  scratchDir: string;
  // OpenTide's own deno.json, so a project's deno.json never configures the
  // runner's imports. Absent for the bundled runner, which has none to
  // configure: it runs with --no-config.
  configFile?: string;
  // The lock file the runner resolves and records its imports in.
  lockFile?: string;
  // Every address on this machine's interfaces, read by the kernel at spawn.
  interfaceAddresses: string[];
}

export function runnerPermissionFlags(
  input: RunnerPermissionInput,
): Result<string[]> {
  const readable = [...new Set([...input.cacheDirs, input.scratchDir])];
  const paths = [...readable, input.configFile ?? "", input.lockFile ?? ""];
  const withComma = paths.find((p) => p.includes(","));
  if (withComma) {
    return {
      ok: false,
      error: {
        code: RUNNER_ERROR_CODES.invalidPath,
        message:
          `Deno permission lists are comma-separated; ${withComma} has a comma.`,
        suggestion: "Move the project or DENO_DIR to a path without a comma.",
      },
    };
  }
  const denyHosts = [
    ...new Set([...RUNNER_LOOPBACK_DENY_HOSTS, ...input.interfaceAddresses]),
  ];
  return {
    ok: true,
    data: [
      "--no-prompt",
      input.configFile ? `--config=${input.configFile}` : "--no-config",
      ...(input.lockFile ? [`--lock=${input.lockFile}`] : []),
      `--allow-read=${readable.join(",")}`,
      `--allow-write=${input.scratchDir}`,
      // The environment is cleared at spawn, so all of it is the project's.
      "--allow-env",
      "--allow-net",
      `--deny-net=${denyHosts.join(",")}`,
    ],
  };
}

// The runner's whole environment. Spawned with clearEnv, so nothing of the
// kernel's own environment (exported API keys included) gets through. The
// runtime's two vars win over a project var of the same name.
export function runnerEnv(
  projectEnv: Record<string, string>,
  runtime: { denoDir: string; scratchDir: string },
): Record<string, string> {
  return {
    ...projectEnv,
    DENO_DIR: runtime.denoDir,
    TMPDIR: runtime.scratchDir,
  };
}

// The machine's interface addresses in the form --deny-net takes: IPv6
// bracketed, with its zone id dropped.
export function hostInterfaceAddresses(
  interfaces: Deno.NetworkInterfaceInfo[] = Deno.networkInterfaces(),
): string[] {
  return [
    ...new Set(
      interfaces.map((i) =>
        i.family === "IPv6" ? `[${i.address.split("%")[0]}]` : i.address
      ),
    ),
  ];
}
