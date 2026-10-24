export interface ShellCommandResult {
  command: string;
  cwd: string;
  ok: boolean;
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  truncated: boolean;
}

export interface RunShellCommandOptions {
  cwd: string;
  timeoutMs?: number;
  maxOutputChars?: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_OUTPUT_CHARS = 80_000;

function shellInvocation(command: string): { command: string; args: string[] } {
  if (Deno.build.os === "windows") {
    return { command: "cmd", args: ["/d", "/s", "/c", command] };
  }
  return {
    command: Deno.env.get("SHELL") || "/bin/sh",
    args: ["-lc", command],
  };
}

export function truncateMiddle(text: string, maxChars: number): {
  text: string;
  truncated: boolean;
} {
  if (text.length <= maxChars) return { text, truncated: false };
  const marker = "\n...[output truncated]...\n";
  const keep = Math.max(0, maxChars - marker.length);
  const head = Math.ceil(keep * 0.65);
  const tail = keep - head;
  return {
    text: `${text.slice(0, head)}${marker}${text.slice(text.length - tail)}`,
    truncated: true,
  };
}

export async function runShellCommand(
  commandText: string,
  opts: RunShellCommandOptions,
): Promise<ShellCommandResult> {
  const command = commandText.trim();
  if (!command) {
    return {
      command,
      cwd: opts.cwd,
      ok: false,
      exitCode: null,
      signal: null,
      stdout: "",
      stderr: "No command specified",
      durationMs: 0,
      timedOut: false,
      truncated: false,
    };
  }

  const started = performance.now();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputChars = opts.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
  const shell = shellInvocation(command);
  const proc = new Deno.Command(shell.command, {
    args: shell.args,
    cwd: opts.cwd,
    stdout: "piped",
    stderr: "piped",
  }).spawn();

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill("SIGTERM");
    } catch {
      // Process may already have exited.
    }
  }, timeoutMs);

  try {
    const output = await proc.output();
    const stdoutRaw = new TextDecoder().decode(output.stdout);
    const stderrRaw = new TextDecoder().decode(output.stderr);
    const stdout = truncateMiddle(stdoutRaw, maxOutputChars);
    const stderr = truncateMiddle(stderrRaw, maxOutputChars);
    return {
      command,
      cwd: opts.cwd,
      ok: output.success && !timedOut,
      exitCode: output.code,
      signal: output.signal,
      stdout: stdout.text,
      stderr: stderr.text,
      durationMs: Math.round(performance.now() - started),
      timedOut,
      truncated: stdout.truncated || stderr.truncated,
    };
  } catch (err) {
    return {
      command,
      cwd: opts.cwd,
      ok: false,
      exitCode: null,
      signal: null,
      stdout: "",
      stderr: err instanceof Error ? err.message : String(err),
      durationMs: Math.round(performance.now() - started),
      timedOut,
      truncated: false,
    };
  } finally {
    clearTimeout(timer);
  }
}

export function formatShellTranscript(result: ShellCommandResult): string {
  const lines = [
    `$ ${result.command}`,
    `cwd: ${result.cwd}`,
    `exit: ${result.exitCode === null ? "unknown" : result.exitCode}${
      result.signal ? ` (${result.signal})` : ""
    }${result.timedOut ? " (timed out)" : ""}`,
    `duration: ${result.durationMs}ms`,
  ];
  if (result.truncated) lines.push("output: truncated");
  lines.push("");

  if (result.stdout) {
    lines.push("stdout:", result.stdout.trimEnd(), "");
  }
  if (result.stderr) {
    lines.push("stderr:", result.stderr.trimEnd(), "");
  }
  if (!result.stdout && !result.stderr) lines.push("(no output)");

  return lines.join("\n").trimEnd();
}
