// The MCP server owns a PGlite data directory, and PGlite's emscripten filesystem has
// no working fsync — so nothing a session writes is actually on the files until a
// checkpoint runs, and the checkpoint runs in unloadProject. A signal that kills the
// process without reaching unloadProject therefore does not cost the recent writes, it
// costs the whole directory: the next start fails with PgliteCorruptError and the only
// way back is a restore from a backup.
//
// SIGINT and SIGTERM were handled from the start. SIGHUP was not, and its default
// action is immediate death — which is what a closed terminal window, a dropped SSH
// session or a departing parent process sends. This spawns the real server and pins
// that it now shuts down cleanly instead.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createProject, removeProject } from "../core/project-manager.ts";
import { isolateHome } from "../core/test-home_test.ts";

isolateHome();

const READY = "MCP server ready on stdio";
const CLOSED = "saved & closed";

// Generous: this boots esbuild and an in-process Postgres before it says READY.
const READY_TIMEOUT_MS = 120_000;
// Shutdown itself must be quick — a shutdown that hangs gets escalated to SIGKILL by
// whoever is waiting, which is the unclean exit this whole path exists to avoid.
const EXIT_TIMEOUT_MS = 60_000;

// The server is chatty and long-lived, so stderr is drained by ONE background task
// into a bounded tail rather than raced read-by-read: overlapping read() calls on a
// single reader do not interleave the way a Promise.race suggests, and keeping every
// chunk to re-scan it is quadratic in a stream that runs for the life of the process.
const TAIL_LIMIT = 64 * 1024;

class StderrTail {
  #text = "";
  #done = false;

  constructor(stream: ReadableStream<Uint8Array>) {
    void (async () => {
      const decoder = new TextDecoder();
      try {
        for await (const chunk of stream) {
          this.#text = (this.#text + decoder.decode(chunk, { stream: true }))
            .slice(-TAIL_LIMIT);
        }
      } catch {
        /* the process went away mid-read; `done` is what callers check */
      } finally {
        this.#done = true;
      }
    })();
  }

  get text(): string {
    return this.#text;
  }

  // Resolves true as soon as the marker shows up, false if the stream ends or the
  // deadline passes without it.
  async waitFor(marker: string, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.#text.includes(marker)) return true;
      if (this.#done) return this.#text.includes(marker);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return this.#text.includes(marker);
  }
}

Deno.test({
  name:
    "the MCP server unloads the project on SIGHUP rather than dying on the spot",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const parent = mkdtempSync(join(tmpdir(), "genie-mcp-sighup-"));
    // A real registered project, because the point is the real shutdown path: the
    // server refuses to serve a directory that is not one.
    const projectDir = createProject(parent, "sighup probe").path;
    const child = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--allow-net",
        "--allow-read",
        "--allow-write",
        "--allow-env",
        "--allow-ffi",
        "--allow-run",
        "--allow-sys",
        new URL("./mcp-main.ts", import.meta.url).pathname,
        "--project",
        projectDir,
        // The in-process server: this is its shutdown path, not the bridge's.
        "--standalone",
      ],
      cwd: new URL("..", import.meta.url).pathname,
      // stdout is the JSON-RPC channel and is redirected to stderr by the server
      // itself; every log line we care about arrives on stderr.
      stdin: "piped",
      stdout: "null",
      stderr: "piped",
    }).spawn();

    const stderr = new StderrTail(child.stderr);
    let exited = false;
    try {
      assert(
        await stderr.waitFor(READY, READY_TIMEOUT_MS),
        `server never became ready. stderr tail:\n${stderr.text}`,
      );

      child.kill("SIGHUP");

      // The clean path logs this from unloadProject, AFTER the checkpoint and the
      // database close. Its absence is the bug: an unhandled SIGHUP kills the process
      // between two writes with the data directory still owed a checkpoint.
      const closedCleanly = await stderr.waitFor(CLOSED, EXIT_TIMEOUT_MS);
      assertStringIncludes(stderr.text, CLOSED);
      assert(closedCleanly);

      const status = await Promise.race([
        child.status.then((s) => ({ timedOut: false as const, status: s })),
        new Promise<{ timedOut: true }>((resolve) =>
          setTimeout(() => resolve({ timedOut: true }), EXIT_TIMEOUT_MS)
        ),
      ]);
      assert(!status.timedOut, "SIGHUP must not hang the shutdown");
      exited = true;
      // Exit code 0 from the handler's own Deno.exit(0). An unhandled SIGHUP would
      // terminate by signal instead, which is exactly what must not happen.
      assertEquals(status.status.signal, null);
      assertEquals(status.status.code, 0);
    } finally {
      try {
        child.stdin.close();
      } catch { /* already closed by the shutdown */ }
      if (!exited) {
        try {
          child.kill("SIGKILL");
        } catch { /* already gone */ }
        await child.status.catch(() => undefined);
      }
      removeProject(projectDir);
      rmSync(parent, { recursive: true, force: true });
    }
  },
});
