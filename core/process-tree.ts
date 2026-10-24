// Shared child-process lifecycle helpers: spawn a command through the login shell
// (so an nvm/deno-managed PATH resolves exactly as in an interactive terminal) and
// tree-kill a process together with all of its descendants, so a forking package
// manager (npm run dev → node, npm test → node → vitest) never leaves an orphan.
//
// Extracted verbatim from core/dev-server.ts (project import, Slice 3) so the
// source-command runner (Slice 6) reuses the exact same no-orphans teardown
// instead of re-deriving it. Both modules go through these helpers; the behavior
// is intentionally identical.

export interface SpawnLoginShellOptions {
  cwd: string;
  // Extra environment for the child. NOTE: when set, this REPLACES the inherited
  // environment (Deno.Command semantics) — pass a full env if the child needs the
  // ambient one. Callers that only add a hint (e.g. PORT) accept that trade-off.
  env?: Record<string, string>;
  stdin?: "null" | "inherit";
}

// Run `command` through the user's login shell (`$SHELL -lc` on POSIX, `cmd /c` on
// Windows) so PATH — nvm-installed node, deno, etc. — resolves like a real
// terminal. The child is confined to `cwd`; stdout/stderr are piped for streaming.
export function spawnLoginShellCommand(
  command: string,
  opts: SpawnLoginShellOptions,
): Deno.ChildProcess {
  const invocation = loginShellInvocation(command);
  return new Deno.Command(invocation.command, {
    args: invocation.args,
    cwd: opts.cwd,
    ...(opts.env ? { env: opts.env } : {}),
    stdout: "piped",
    stderr: "piped",
    stdin: opts.stdin ?? "null",
  }).spawn();
}

function loginShellInvocation(
  command: string,
): { command: string; args: string[] } {
  if (Deno.build.os === "windows") {
    return { command: "cmd", args: ["/d", "/s", "/c", command] };
  }
  return {
    command: Deno.env.get("SHELL") || "/bin/sh",
    args: ["-lc", command],
  };
}

// Tree-kill: SIGTERM the descendant tree (deepest → shallowest) then the root
// child, wait `graceMs` for a clean exit, and SIGKILL any survivor. Children-first
// so nothing re-parents to init. Best-effort (a missing pgrep degrades to the
// direct child only); resolves once the root child has been reaped.
export async function killProcessTree(
  proc: Deno.ChildProcess,
  graceMs: number,
): Promise<void> {
  const pid = proc.pid;
  const descendants = await collectDescendantPids(pid);
  const ordered = [...descendants.reverse(), pid];
  signalPids(ordered, "SIGTERM");

  const exited = await Promise.race([
    proc.status.then(() => true).catch(() => true),
    delay(graceMs).then(() => false),
  ]);
  if (!exited) {
    const survivors = [
      ...(await collectDescendantPids(pid)).reverse(),
      pid,
    ];
    signalPids(survivors, "SIGKILL");
    await proc.status.catch(() => {});
  }
  // Ensure the child's stdio is fully released so the process can be reaped.
  try {
    await proc.status;
  } catch { /* already reaped */ }
}

// Breadth-first walk of a process's descendants via `pgrep -P` (present on macOS
// and Linux). Killing the whole tree is how we avoid orphans when a package
// manager forks the real server. On a platform without pgrep this yields [] and
// callers fall back to killing the direct child only.
export async function collectDescendantPids(pid: number): Promise<number[]> {
  const all: number[] = [];
  const queue = [pid];
  while (queue.length > 0) {
    const current = queue.shift()!;
    let children: number[] = [];
    try {
      const out = await new Deno.Command("pgrep", {
        args: ["-P", String(current)],
        stdout: "piped",
        stderr: "null",
      }).output();
      children = new TextDecoder().decode(out.stdout)
        .split("\n")
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isInteger(n) && n > 0);
    } catch {
      // pgrep unavailable — best effort, direct child only.
    }
    for (const child of children) {
      all.push(child);
      queue.push(child);
    }
  }
  return all;
}

export function signalPids(pids: number[], signal: Deno.Signal): void {
  for (const pid of pids) {
    try {
      Deno.kill(pid, signal);
    } catch {
      // Already exited (ESRCH) or not permitted — nothing to do.
    }
  }
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
