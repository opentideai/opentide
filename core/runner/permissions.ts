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
//
// A project can change two of these in opentide.json (./runner-settings.ts):
// `runner.net` swaps open outbound for a list of the only hosts it may reach,
// which is how it gets at a local database; `runner.ffi` allows native code,
// which voids all of the above.
//
// Deno's deny always beats its allow, even a specific allow against a
// host-wide deny (measured, Deno 2.9.8), and the lists are fixed at spawn. So
// "open, except this machine" and "this machine, except our ports" can't be
// combined: a project gets one or the other.

import type { Result } from "../types.ts";
import { RUNNER_KERNEL_PORTS, RUNNER_LOOPBACK_DENY_HOSTS } from "../config.ts";
import { RUNNER_ERROR_CODES } from "./protocol.ts";

const LOOPBACK_ALIASES: readonly string[] = RUNNER_LOOPBACK_DENY_HOSTS;
const MAX_PORT = 65_535;

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
  // Absent: outbound is open and only this machine is denied. A list of
  // `host` or `host:port`: the only places the runner can reach.
  net?: readonly string[];
  // Native code, which Deno's permissions don't hold.
  ffi?: boolean;
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
  const net = netFlags(input);
  if (!net.ok) return net;
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
      ...net.data,
      ...(input.ffi ? ["--allow-ffi"] : []),
    ],
  };
}

interface NetEntry {
  host: string;
  port?: number;
}

// Open outbound with this machine denied; or, given a list, that list, with
// loopback and each of this machine's addresses still denied whole unless an
// entry names it, and then still denied on the kernel's ports.
function netFlags(input: RunnerPermissionInput): Result<string[]> {
  const machine = input.interfaceAddresses.filter((a) => !isLoopback(a));
  if (!input.net) {
    return {
      ok: true,
      data: [
        "--allow-net",
        `--deny-net=${unique([...LOOPBACK_ALIASES, ...machine]).join(",")}`,
      ],
    };
  }
  const entries: NetEntry[] = [];
  for (const raw of input.net) {
    const entry = parseNetEntry(raw, machine);
    if (!entry.ok) return entry;
    entries.push(entry.data);
  }
  const allow = unique(
    entries.flatMap((e) =>
      LOOPBACK_ALIASES.includes(e.host)
        ? LOOPBACK_ALIASES.map((h) => `${h}:${e.port}`)
        : [e.port === undefined ? e.host : `${e.host}:${e.port}`]
    ),
  );
  const groups = [LOOPBACK_ALIASES, ...machine.map((a) => [a])];
  const deny = groups.flatMap((hosts) =>
    entries.some((e) => hosts.includes(e.host))
      ? hosts.flatMap((h) => RUNNER_KERNEL_PORTS.map((p) => `${h}:${p}`))
      : hosts
  );
  return {
    ok: true,
    data: [
      ...(allow.length > 0 ? [`--allow-net=${allow.join(",")}`] : []),
      `--deny-net=${unique(deny).join(",")}`,
    ],
  };
}

// `host` or `host:port`, the host written as a URL writes it. One on loopback
// or this machine needs a port, and not one of the kernel's.
function parseNetEntry(raw: string, machine: string[]): Result<NetEntry> {
  const refuse = (why: string, suggestion: string): Result<NetEntry> => ({
    ok: false,
    error: {
      code: RUNNER_ERROR_CODES.invalidSettings,
      message: `runner.net entry ${JSON.stringify(raw)} ${why}.`,
      suggestion,
    },
  });
  const match = /^(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9.-]+)(?::(\d{1,5}))?$/.exec(
    raw,
  );
  if (!match) {
    return refuse(
      "isn't a host or host:port",
      'Write "api.example.com", "localhost:5432" or "[::1]:6379": no scheme, path or wildcard.',
    );
  }
  const host = match[1]!;
  const port = match[2] === undefined ? undefined : Number(match[2]);
  const canonical = canonicalHost(host);
  if (canonical !== host) {
    return refuse(
      "isn't written the way Deno matches it",
      canonical ? `Write the host as ${canonical}.` : "Use a host name or IP.",
    );
  }
  if (host.endsWith(".localhost") || host.startsWith("[::ffff:")) {
    return refuse(
      "is another name for loopback",
      `Write it as localhost${port === undefined ? ":<port>" : `:${port}`}.`,
    );
  }
  if (port !== undefined && (port < 1 || port > MAX_PORT)) {
    return refuse("has no such port", `Use a port from 1 to ${MAX_PORT}.`);
  }
  if (isLoopback(host) || machine.includes(host)) {
    if (port === undefined) {
      return refuse(
        "opens every port on this machine, the kernel's included",
        `Name the port: ${host}:5432, say.`,
      );
    }
    if ((RUNNER_KERNEL_PORTS as readonly number[]).includes(port)) {
      return refuse(
        "is one of the kernel's own ports",
        "User code reaches the kernel through its own API, not over the network.",
      );
    }
  }
  return { ok: true, data: { host, port } };
}

function canonicalHost(host: string): string | null {
  try {
    return new URL(`http://${host}`).hostname;
  } catch {
    return null;
  }
}

function isLoopback(host: string): boolean {
  return LOOPBACK_ALIASES.includes(host) || host.startsWith("127.");
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
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
