// The runner a project's kernel starts: a child Deno under the flags from
// ./permissions.ts, with the project's env. The bridge (./runner-adapter.ts)
// starts it on first use, by when the project's env and secrets are loaded,
// and again after every respawn, so each spawn reads them afresh.
//
// The child's lock is its own, in its scratch dir, seeded at each spawn with a
// copy of OpenTide's: its imports resolve as the kernel's do, and what it
// records goes nowhere the kernel reads.

import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { RUNNER_BUNDLE_FILE } from "../config.ts";
import {
  denoToolchainFailure,
  resolveDenoToolchain,
} from "../deno-toolchain.ts";
import type { Result } from "../types.ts";
import { errorMessage } from "../util.ts";
import type { RunnerStart } from "./runner-adapter.ts";
import { failure } from "./peer.ts";
import {
  hostInterfaceAddresses,
  runnerEnv,
  runnerPermissionFlags,
} from "./permissions.ts";
import { RUNNER_ERROR_CODES } from "./protocol.ts";
import {
  denoCacheDirs,
  openTideConfigPath,
  RunnerHost,
  runnerScriptPath,
} from "./runner-host.ts";

const RUNNER_LOCK_FILE = "deno.lock";

export interface ProjectRunnerPaths {
  // The only place the runner can write, and its TMPDIR.
  scratchDir: string;
  // Where a compiled build writes the bundled runner out to. Outside the
  // scratch dir, so a runner can't rewrite what the next one runs.
  bundledScript: string;
}

// What the child runs: runner-main.ts from source, pinned to OpenTide's
// deno.json; or, in a compiled build, which has no sources on disk, the
// bundled copy, which has no imports left to configure.
export type RunnerEntry =
  | { kind: "source"; script: string; configFile: string; lockSeed: string }
  | { kind: "bundle"; bundle: URL };

export function runnerEntry(
  standalone: boolean = Deno.build.standalone,
): RunnerEntry {
  return standalone
    ? {
      kind: "bundle",
      bundle: new URL(`./${RUNNER_BUNDLE_FILE}`, import.meta.url),
    }
    : {
      kind: "source",
      script: runnerScriptPath(),
      configFile: openTideConfigPath(),
      lockSeed: new URL("../../deno.lock", import.meta.url).pathname,
    };
}

export function projectRunnerStart(
  paths: ProjectRunnerPaths,
  projectEnv: () => Record<string, string>,
  entry: RunnerEntry = runnerEntry(),
): RunnerStart {
  return async (peer) => {
    const deno = resolveDenoToolchain();
    if (!deno.ok) {
      return failure(
        RUNNER_ERROR_CODES.startFailed,
        denoToolchainFailure("The user-code runner needs Deno", deno.error),
      );
    }
    const caches = await cacheDirs(deno.data);
    if (!caches.ok) return caches;
    const prepared = await prepare(paths, entry);
    if (!prepared.ok) return prepared;
    const flags = runnerPermissionFlags({
      cacheDirs: [caches.data.denoDir, caches.data.npmCache],
      scratchDir: paths.scratchDir,
      configFile: entry.kind === "source" ? entry.configFile : undefined,
      lockFile: join(paths.scratchDir, RUNNER_LOCK_FILE),
      interfaceAddresses: hostInterfaceAddresses(),
    });
    if (!flags.ok) return flags;
    return await RunnerHost.spawn({
      spec: {
        command: deno.data,
        args: ["run", ...flags.data, prepared.data],
        env: runnerEnv(projectEnv(), {
          denoDir: caches.data.denoDir,
          scratchDir: paths.scratchDir,
        }),
        cwd: paths.scratchDir,
      },
      peer,
    });
  };
}

// The scratch dir and the runner's lock, and the script to run.
async function prepare(
  paths: ProjectRunnerPaths,
  entry: RunnerEntry,
): Promise<Result<string>> {
  const lock = join(paths.scratchDir, RUNNER_LOCK_FILE);
  try {
    await mkdir(paths.scratchDir, { recursive: true });
    if (entry.kind === "source") {
      await copyFile(entry.lockSeed, lock);
      return { ok: true, data: entry.script };
    }
    await rm(lock, { force: true });
    await writeFile(paths.bundledScript, await readFile(entry.bundle));
    return { ok: true, data: paths.bundledScript };
  } catch (err) {
    return failure(
      RUNNER_ERROR_CODES.startFailed,
      `The user-code runner couldn't be set up: ${errorMessage(err)}`,
    );
  }
}

// `deno info` once per toolchain: the cache dirs don't move while we run.
const knownCacheDirs = new Map<
  string,
  Promise<Result<{ denoDir: string; npmCache: string }>>
>();

function cacheDirs(
  deno: string,
): Promise<Result<{ denoDir: string; npmCache: string }>> {
  let dirs = knownCacheDirs.get(deno);
  if (!dirs) {
    dirs = denoCacheDirs(deno);
    knownCacheDirs.set(deno, dirs);
    void dirs.then((r) => {
      if (!r.ok) knownCacheDirs.delete(deno);
    });
  }
  return dirs;
}
