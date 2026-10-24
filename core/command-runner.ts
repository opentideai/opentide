import type { Kernel } from "./registries.ts";
import type { Result } from "./types.ts";
import type { ProjectCommand } from "./codebase/types.ts";
import {
  PROJECT_MODE_SOURCE_BACKED,
  readProjectMode,
} from "./project-manager.ts";
import {
  SOURCE_COMMAND_LOG_TAIL_LINES,
  SOURCE_COMMAND_MAX_OUTPUT_CHARS,
  SOURCE_COMMAND_STOP_GRACE_MS,
  SOURCE_COMMAND_TIMEOUT_MS,
} from "./config.ts";
import { killProcessTree, spawnLoginShellCommand } from "./process-tree.ts";
import {
  formatShellTranscript,
  type ShellCommandResult,
  truncateMiddle,
} from "./shell.ts";

// Selects one runnable command from the codebase graph's allow-list, by its exact
// node id or by kind (test/build/lint/typecheck/format/dev/install). Never a raw
// caller-supplied string — the runner only ever executes a command materialized
// into graph.commands, mirroring the dev server's resolveDevRunConfig posture.
export interface CommandSelector {
  id?: string;
  kind?: ProjectCommand["commandKind"];
}

export interface CommandRunResult {
  selector: CommandSelector;
  commandKind: ProjectCommand["commandKind"];
  commandName: string;
  // The exact command text that ran (from graph.commands, never caller input).
  command: string;
  cwd: string;
  ok: boolean;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  canceled: boolean;
  truncated: boolean;
  durationMs: number;
  startedAt: string;
  stdout: string;
  stderr: string;
  // Rendered via core/shell.ts formatShellTranscript for a consistent transcript.
  transcript: string;
}

export interface CommandRunnerStatus {
  running: boolean;
  command: string | null;
  commandKind: string | null;
  commandName: string | null;
  cwd: string | null;
  pid: number | null;
  startedAt: string | null;
  logTail: string[];
}

// Resolve a CommandSelector to the concrete ProjectCommand from the cached codebase
// graph, applying the same security rule the dev server uses: mode-gated (a
// registry-native project can never run one) and allow-listed (only a command that
// discovery materialized into graph.commands). Pure + unit-testable. Semantic error
// codes: MODE_NOT_SOURCE_BACKED, NO_GRAPH, COMMAND_NOT_FOUND.
export function resolveProjectCommand(
  kernel: Kernel,
  projectDir: string,
  selector: CommandSelector,
): Result<ProjectCommand> {
  if (readProjectMode(projectDir) !== PROJECT_MODE_SOURCE_BACKED) {
    return {
      ok: false,
      error: {
        code: "MODE_NOT_SOURCE_BACKED",
        message:
          "Project commands can only be run for source-backed (imported) projects.",
        suggestion:
          "Import the project and set its mode to source-backed before running commands.",
      },
    };
  }

  const graph = kernel.codebaseGraph;
  if (!graph) {
    return {
      ok: false,
      error: {
        code: "NO_GRAPH",
        message: "The project has not been indexed yet.",
        suggestion: "Run index_codebase first, then list runnable commands.",
      },
    };
  }

  const command = selector.id
    ? graph.commands.find((c) => c.id === selector.id)
    : selector.kind
    ? findCommandByKind(graph.commands, selector.kind)
    : undefined;

  if (!command) {
    const requested = selector.id ?? selector.kind ?? "(none)";
    return {
      ok: false,
      error: {
        code: "COMMAND_NOT_FOUND",
        message:
          `No runnable command "${requested}" is present in the codebase graph.`,
        suggestion:
          "List commands via GET /api/commands and run one by its kind or id.",
      },
    };
  }
  return { ok: true, data: command };
}

// Prefer a command whose script name equals the kind (e.g. the `test` script over
// a `test:unit` variant), else the first of that kind.
function findCommandByKind(
  commands: ProjectCommand[],
  kind: ProjectCommand["commandKind"],
): ProjectCommand | undefined {
  const matches = commands.filter((c) => c.commandKind === kind);
  return matches.find((c) => c.name === kind) ?? matches[0];
}

// Runs one discovered project command at a time, streaming its output into the
// kernel structured log and tearing the child (+ descendants) down on
// cancel/timeout/shutdown so a forking package manager (npm test → node → vitest)
// leaves no orphan. One per loaded project, held on the ProjectContext beside the
// dev server. Result<T> across the boundary — never throws.
//
// It does NOT use core/shell.ts runShellCommand directly: that buffers to
// completion, exposes no cancel handle, and its timeout only SIGTERMs the direct
// child (leaving descendants). This mirrors DevServerManager instead — spawning via
// the shared login-shell + process-tree helpers — while reusing shell.ts's
// ShellCommandResult shape + formatShellTranscript for the rendered transcript.
export class CommandRunner {
  private proc: Deno.ChildProcess | null = null;
  private command: ProjectCommand | null = null;
  private cwd: string | null = null;
  private startedAt: string | null = null;
  private canceled = false;
  private readonly logTail: string[] = [];

  constructor(
    private kernel: Kernel,
    private projectDir: string,
  ) {}

  get running(): boolean {
    return this.proc !== null;
  }

  status(): CommandRunnerStatus {
    return {
      running: this.running,
      command: this.command?.command ?? null,
      commandKind: this.command?.commandKind ?? null,
      commandName: this.command?.name ?? null,
      cwd: this.cwd,
      pid: this.proc?.pid ?? null,
      startedAt: this.startedAt,
      logTail: [...this.logTail],
    };
  }

  async run(
    selector: CommandSelector,
    opts: { timeoutMs?: number } = {},
  ): Promise<Result<CommandRunResult>> {
    const resolved = resolveProjectCommand(
      this.kernel,
      this.projectDir,
      selector,
    );
    if (!resolved.ok) return resolved;
    if (this.proc) {
      return {
        ok: false,
        error: {
          code: "COMMAND_ALREADY_RUNNING",
          message: "Another project command is already running.",
          suggestion: "Wait for it to finish, or cancel it first.",
        },
      };
    }

    const command = resolved.data;
    const cwd = command.cwd ?? this.projectDir;
    const timeoutMs = opts.timeoutMs ?? SOURCE_COMMAND_TIMEOUT_MS;

    this.command = command;
    this.cwd = cwd;
    this.canceled = false;
    this.startedAt = new Date().toISOString();
    this.logTail.length = 0;

    let proc: Deno.ChildProcess;
    try {
      proc = spawnLoginShellCommand(command.command, { cwd, stdin: "null" });
    } catch (err) {
      this.resetState();
      return {
        ok: false,
        error: {
          code: "COMMAND_SPAWN_FAILED",
          message: `Failed to spawn command: ${errText(err)}`,
        },
      };
    }

    this.proc = proc;
    const started = performance.now();
    this.log("info", `Command started: ${command.command} (cwd ${cwd})`);

    const stdoutParts: string[] = [];
    const stderrParts: string[] = [];
    const stdoutDone = this.pipe(proc.stdout, "info", stdoutParts);
    const stderrDone = this.pipe(proc.stderr, "error", stderrParts);

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      this.log("error", `Command timed out after ${timeoutMs}ms — terminating`);
      killProcessTree(proc, SOURCE_COMMAND_STOP_GRACE_MS).catch(() => {});
    }, timeoutMs);

    const status = await proc.status.catch(() => null);
    clearTimeout(timer);
    await Promise.all([stdoutDone, stderrDone]);

    const canceled = this.canceled;
    const durationMs = Math.round(performance.now() - started);
    const stdout = truncateMiddle(
      stdoutParts.join(""),
      SOURCE_COMMAND_MAX_OUTPUT_CHARS,
    );
    const stderr = truncateMiddle(
      stderrParts.join(""),
      SOURCE_COMMAND_MAX_OUTPUT_CHARS,
    );
    const exitCode = status?.code ?? null;
    const signal = status?.signal ?? null;
    const ok = Boolean(status?.success) && !timedOut && !canceled;
    const startedAt = this.startedAt ?? new Date().toISOString();

    const shellResult: ShellCommandResult = {
      command: command.command,
      cwd,
      ok,
      exitCode,
      signal,
      stdout: stdout.text,
      stderr: stderr.text,
      durationMs,
      timedOut,
      truncated: stdout.truncated || stderr.truncated,
    };

    this.log(
      ok ? "info" : "error",
      `Command finished: exit ${exitCode ?? "unknown"}${
        timedOut ? " (timed out)" : ""
      }${canceled ? " (canceled)" : ""} in ${durationMs}ms`,
    );
    this.resetState();

    return {
      ok: true,
      data: {
        selector,
        commandKind: command.commandKind,
        commandName: command.name,
        command: command.command,
        cwd,
        ok,
        exitCode,
        signal,
        timedOut,
        canceled,
        truncated: shellResult.truncated,
        durationMs,
        startedAt,
        stdout: stdout.text,
        stderr: stderr.text,
        transcript: formatShellTranscript(shellResult),
      },
    };
  }

  // Stop the running command and kill its descendant tree. Idempotent — a no-op
  // (ok) when nothing is running. The in-flight run() observes proc.status
  // resolving and finalizes the CommandRunResult with canceled: true.
  async cancel(): Promise<Result<CommandRunnerStatus>> {
    if (!this.proc) return { ok: true, data: this.status() };
    this.canceled = true;
    this.log("info", "Command canceled — terminating process tree");
    await killProcessTree(this.proc, SOURCE_COMMAND_STOP_GRACE_MS);
    return { ok: true, data: this.status() };
  }

  // Teardown for project switch / kernel shutdown — kill the child tree so nothing
  // is orphaned. Mirrors DevServerManager.shutdown.
  async shutdown(): Promise<void> {
    if (!this.proc) return;
    this.canceled = true;
    await killProcessTree(this.proc, SOURCE_COMMAND_STOP_GRACE_MS);
    this.resetState();
  }

  // --- internals ---

  private pipe(
    stream: ReadableStream<Uint8Array>,
    level: "info" | "error",
    parts: string[],
  ): Promise<void> {
    return (async () => {
      const decoder = new TextDecoder();
      let buffer = "";
      let captured = 0;
      // Cap raw capture at ~2× the display budget so truncateMiddle has head+tail
      // to work with without holding an unbounded transcript in memory.
      const captureCap = SOURCE_COMMAND_MAX_OUTPUT_CHARS * 2;
      for await (const chunk of stream) {
        const text = decoder.decode(chunk, { stream: true });
        if (captured < captureCap) {
          parts.push(text);
          captured += text.length;
        }
        buffer += text;
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
    this.kernel.log.log(level, "system", `[command] ${line}`);
  }

  private pushTail(line: string): void {
    this.logTail.push(line);
    if (this.logTail.length > SOURCE_COMMAND_LOG_TAIL_LINES) {
      this.logTail.splice(
        0,
        this.logTail.length - SOURCE_COMMAND_LOG_TAIL_LINES,
      );
    }
  }

  private log(level: "info" | "error", message: string): void {
    this.kernel.log.log(level, "system", `[command] ${message}`);
  }

  private resetState(): void {
    this.proc = null;
    this.canceled = false;
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
