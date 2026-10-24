import type { Kernel } from "./registries.ts";
import type { AppServer } from "./app-server.ts";
import type { Result } from "./types.ts";
import {
  PROJECT_MODE_SOURCE_BACKED,
  readProjectMode,
  readProjectRunConfig,
  type SourceBackedRunConfig,
} from "./project-manager.ts";
import {
  DEV_SERVER_HOST,
  DEV_SERVER_LOG_TAIL_LINES,
  DEV_SERVER_PORT_ENV,
  DEV_SERVER_PORT_PROBE_INTERVAL_MS,
  DEV_SERVER_STARTUP_TIMEOUT_MS,
  DEV_SERVER_STOP_GRACE_MS,
} from "./config.ts";
import {
  delay,
  killProcessTree,
  spawnLoginShellCommand,
} from "./process-tree.ts";

// Public status snapshot of the source-backed dev server (project import, Slice 3).
export interface DevServerStatus {
  running: boolean;
  // The child port the preview listener proxies to; null until detected.
  detectedPort: number | null;
  // The resolved command currently running (or last run); null if never started.
  command: string | null;
  cwd: string | null;
  pid: number | null;
  // Whether appServer.setProxy is currently pointed at this child.
  proxied: boolean;
  startedAt: string | null;
  // Bounded tail of the child's stdout/stderr (also mirrored to the kernel log).
  logTail: string[];
}

// Ports advertised in a dev-server banner line: an http(s) URL or a bare
// host:port on a loopback/any host. Used as the SECONDARY detection signal when
// the child ignores the PORT hint (e.g. Vite defaults to its own port).
const PORT_BANNER_RE =
  /(?:https?:\/\/)?(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]|\[::\]):(\d{2,5})\b/gi;

// Resolve the command Genie will spawn for a source-backed project, applying mode
// gating and the security rule "only a command from discovery or an explicitly
// confirmed one". Precedence: explicit (IDE/user-confirmed) → persisted run config
// → the `dev` command from the cached codebase graph. Registry-native projects are
// refused here so a caller can NEVER auto-spawn one. Pure + unit-testable.
export function resolveDevRunConfig(
  kernel: Kernel,
  projectDir: string,
  explicit?: Partial<SourceBackedRunConfig>,
): Result<SourceBackedRunConfig> {
  if (readProjectMode(projectDir) !== PROJECT_MODE_SOURCE_BACKED) {
    return {
      ok: false,
      error: {
        code: "MODE_NOT_SOURCE_BACKED",
        message:
          "Dev server is only available for source-backed (imported) projects.",
        suggestion:
          "Import the project and set its mode to source-backed before starting a dev server.",
      },
    };
  }

  const persisted = readProjectRunConfig(projectDir);
  const fromGraph = devCommandFromGraph(kernel);
  const command = explicit?.command ?? persisted?.command ?? fromGraph?.command;
  if (!command || command.trim() === "") {
    return {
      ok: false,
      error: {
        code: "DEV_COMMAND_UNKNOWN",
        message:
          "No dev command is configured and none was found in the codebase graph.",
        suggestion:
          "Run index_codebase to detect a `dev` script, or pass an explicit command to confirm one.",
      },
    };
  }

  const cwd = explicit?.cwd ?? persisted?.cwd ?? fromGraph?.cwd;
  const port = explicit?.port ?? persisted?.port;
  return {
    ok: true,
    data: {
      command,
      ...(cwd !== undefined ? { cwd } : {}),
      ...(port !== undefined ? { port } : {}),
    },
  };
}

function devCommandFromGraph(
  kernel: Kernel,
): { command: string; cwd?: string } | null {
  const dev = kernel.codebaseGraph?.commands.find((c) =>
    c.commandKind === "dev"
  );
  if (!dev) return null;
  return { command: dev.command, ...(dev.cwd ? { cwd: dev.cwd } : {}) };
}

// One per loaded project (held on the ProjectContext like appServer). Spawns the
// imported project's dev command natively, detects the port it bound, health-checks
// it, and points Genie's app-preview listener at it via appServer.setProxy. Tears
// the child (and its descendants) down deterministically on stop / project switch /
// kernel shutdown — no orphaned processes.
//
// Console/error capture into proxied HTML is handled by AppServer.setProxy itself
// (proxyHtmlWithConsole in app-server.ts splices the intercept script into proxied
// text/html), so an imported app's runtime console + errors reach the IDE preview
// exactly like a registry-native app's.
export class DevServerManager {
  private proc: Deno.ChildProcess | null = null;
  private detectedPort: number | null = null;
  private command: string | null = null;
  private cwd: string | null = null;
  private startedAt: string | null = null;
  private proxied = false;
  private stopping = false;
  private readonly logTail: string[] = [];
  private readonly bannerPorts = new Set<number>();

  constructor(
    private kernel: Kernel,
    private appServer: AppServer,
    private projectDir: string,
  ) {}

  get running(): boolean {
    return this.proc !== null;
  }

  status(): DevServerStatus {
    return {
      running: this.running,
      detectedPort: this.detectedPort,
      command: this.command,
      cwd: this.cwd,
      pid: this.proc?.pid ?? null,
      proxied: this.proxied,
      startedAt: this.startedAt,
      logTail: [...this.logTail],
    };
  }

  async start(config: SourceBackedRunConfig): Promise<Result<DevServerStatus>> {
    if (this.proc) {
      return {
        ok: false,
        error: {
          code: "DEV_SERVER_ALREADY_RUNNING",
          message: "The dev server is already running.",
          suggestion: "Stop it first, or call restart.",
        },
      };
    }

    const cwd = config.cwd ?? this.projectDir;
    // Hint the child which port to bind. When a fixed port is configured we use it;
    // otherwise we pick an OS-free port so detection is deterministic even if the
    // child honors PORT. Banner parsing remains the fallback for children that don't.
    const hintedPort = config.port ?? findFreePort();

    this.command = config.command;
    this.cwd = cwd;
    this.bannerPorts.clear();
    this.detectedPort = null;
    this.logTail.length = 0;

    let proc: Deno.ChildProcess;
    try {
      proc = spawnShellCommand(config.command, cwd, hintedPort);
    } catch (err) {
      this.command = null;
      this.cwd = null;
      return {
        ok: false,
        error: {
          code: "DEV_SERVER_SPAWN_FAILED",
          message: `Failed to spawn dev command: ${errText(err)}`,
        },
      };
    }

    this.proc = proc;
    this.stopping = false;
    this.startedAt = new Date().toISOString();
    this.log(
      "info",
      "system",
      `Dev server starting: ${config.command} (cwd ${cwd}, hint PORT=${hintedPort})`,
    );

    this.pipeStream(proc.stdout, "info");
    this.pipeStream(proc.stderr, "error");
    // A crash BEFORE readiness rejects the wait below; a crash AFTER we've declared
    // "up" is caught here so the proxy is cleared and state reset (no dead-port 502s).
    proc.status.then((s) => this.onExit(s)).catch(() => this.onExit(null));

    const port = await this.awaitReadyPort(hintedPort);
    if (port === null) {
      await this.killChild();
      const detail = this.recentLog();
      this.resetState();
      return {
        ok: false,
        error: {
          code: "DEV_SERVER_STARTUP_TIMEOUT",
          message:
            `Dev server did not bind an accepting port within ${DEV_SERVER_STARTUP_TIMEOUT_MS}ms.` +
            (detail ? ` Recent output: ${detail}` : ""),
          suggestion:
            "Check the command and that it honors the PORT env var, or configure a fixed port.",
        },
      };
    }

    this.detectedPort = port;
    this.appServer.setProxy(port);
    this.proxied = true;
    this.log(
      "info",
      "system",
      `Dev server ready on :${port} — proxying app preview`,
    );
    return { ok: true, data: this.status() };
  }

  async stop(): Promise<Result<DevServerStatus>> {
    if (!this.proc) {
      return { ok: true, data: this.status() };
    }
    if (this.proxied) {
      this.appServer.clearProxy();
      this.proxied = false;
    }
    await this.killChild();
    this.log("info", "system", "Dev server stopped");
    this.resetState();
    return { ok: true, data: this.status() };
  }

  async restart(
    config?: SourceBackedRunConfig,
  ): Promise<Result<DevServerStatus>> {
    const prev: SourceBackedRunConfig | null = this.command
      ? {
        command: this.command,
        ...(this.cwd ? { cwd: this.cwd } : {}),
        ...(this.detectedPort ? { port: this.detectedPort } : {}),
      }
      : null;
    const next = config ?? prev;
    if (!next) {
      return {
        ok: false,
        error: {
          code: "DEV_COMMAND_UNKNOWN",
          message: "No previous run config to restart from.",
          suggestion: "Call start with a command first.",
        },
      };
    }
    await this.stop();
    return await this.start(next);
  }

  // Teardown hook for project switch / kernel shutdown. Kills the child (and its
  // descendants) best-effort WITHOUT touching the app server — the caller is about
  // to shut the app server down anyway, so re-binding the built app is wasted work.
  async shutdown(): Promise<void> {
    if (!this.proc) return;
    this.stopping = true;
    await this.killChild();
    this.resetState();
  }

  // --- internals ---

  private async awaitReadyPort(hintedPort: number): Promise<number | null> {
    const deadline = Date.now() + DEV_SERVER_STARTUP_TIMEOUT_MS;
    while (Date.now() < deadline) {
      // The child may have crashed while we were waiting.
      if (!this.proc || this.stopping) return null;
      const candidates = [hintedPort, ...this.bannerPorts].filter(
        (p, i, arr) => arr.indexOf(p) === i,
      );
      for (const port of candidates) {
        if (await isPortAccepting(port)) return port;
      }
      await delay(DEV_SERVER_PORT_PROBE_INTERVAL_MS);
    }
    return null;
  }

  private pipeStream(
    stream: ReadableStream<Uint8Array>,
    level: "info" | "error",
  ): void {
    (async () => {
      const decoder = new TextDecoder();
      let buffer = "";
      for await (const chunk of stream) {
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) this.ingestLine(line, level);
      }
      if (buffer.trim()) this.ingestLine(buffer, level);
    })().catch(() => {});
  }

  private ingestLine(rawLine: string, level: "info" | "error"): void {
    const line = rawLine.trimEnd();
    if (!line) return;
    this.pushTail(line);
    this.log(level, "system", `[dev-server] ${line}`);
    for (const match of line.matchAll(PORT_BANNER_RE)) {
      const port = Number(match[1]);
      if (Number.isInteger(port) && port > 0 && port <= 65535) {
        this.bannerPorts.add(port);
      }
    }
  }

  private pushTail(line: string): void {
    this.logTail.push(line);
    if (this.logTail.length > DEV_SERVER_LOG_TAIL_LINES) {
      this.logTail.splice(0, this.logTail.length - DEV_SERVER_LOG_TAIL_LINES);
    }
  }

  private recentLog(): string {
    return this.logTail.slice(-5).join(" | ");
  }

  private log(
    level: "info" | "error",
    source: "system",
    message: string,
  ): void {
    this.kernel.log.log(level, source, message);
  }

  private onExit(status: Deno.CommandStatus | null): void {
    // An intentional stop()/shutdown() already nulls this.proc via killChild; only
    // an UNEXPECTED exit reaches here with the child still "current".
    if (this.stopping || !this.proc) return;
    const code = status?.code ?? "unknown";
    this.log(
      "error",
      "system",
      `Dev server exited unexpectedly (code ${code})`,
    );
    if (this.proxied) {
      this.appServer.clearProxy();
      this.proxied = false;
    }
    this.resetState();
  }

  private async killChild(): Promise<void> {
    const proc = this.proc;
    if (!proc) return;
    this.stopping = true;
    // Shared no-orphans teardown (core/process-tree.ts): descendants first, then
    // the root child, SIGTERM → grace → SIGKILL any survivor.
    await killProcessTree(proc, DEV_SERVER_STOP_GRACE_MS);
    this.proc = null;
  }

  private resetState(): void {
    this.proc = null;
    this.detectedPort = null;
    this.proxied = false;
    this.stopping = false;
    this.bannerPorts.clear();
  }
}

// Spawn the dev command through the login shell (core/process-tree.ts) so the
// user's PATH — nvm-installed node, deno, etc. — resolves exactly as in an
// interactive terminal. The child is confined to `cwd`; PORT is injected as the
// bind hint.
function spawnShellCommand(
  command: string,
  cwd: string,
  hintedPort: number,
): Deno.ChildProcess {
  return spawnLoginShellCommand(command, {
    cwd,
    env: { [DEV_SERVER_PORT_ENV]: String(hintedPort) },
    stdin: "null",
  });
}

async function isPortAccepting(port: number): Promise<boolean> {
  try {
    const conn = await Deno.connect({ hostname: DEV_SERVER_HOST, port });
    conn.close();
    return true;
  } catch {
    return false;
  }
}

function findFreePort(): number {
  const listener = Deno.listen({ hostname: DEV_SERVER_HOST, port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  listener.close();
  return port;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
