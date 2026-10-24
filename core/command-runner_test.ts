import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { rmSync } from "node:fs";
import { Kernel } from "./registries.ts";
import { Database } from "./db.ts";
import { CommandRunner, resolveProjectCommand } from "./command-runner.ts";
import {
  createProject,
  PROJECT_MODE_SOURCE_BACKED,
  removeProject,
  writeProjectMode,
} from "./project-manager.ts";
import {
  type CodebaseGraph,
  createEmptyCodebaseGraph,
  type ProjectCommand,
} from "./codebase/types.ts";
import { collectDescendantPids, delay } from "./process-tree.ts";
import { isolateHome } from "./test-home_test.ts";

isolateHome();

const testOpts = { sanitizeResources: false, sanitizeOps: false };

function pidAlive(pid: number): boolean {
  try {
    Deno.kill(pid, "SIGCONT");
    return true;
  } catch {
    return false;
  }
}

function testCommand(cwd: string, command: string): ProjectCommand {
  return {
    id: "command:test:test",
    kind: "command",
    name: "test",
    commandKind: "test",
    command,
    cwd,
    packageManager: "npm",
    source: { pluginId: "test", method: "manifest", inferred: false },
    confidence: 0.95,
    locations: [{ file: "package.json", startLine: 1, startColumn: 1 }],
  };
}

function graphWith(
  rootPath: string,
  commands: ProjectCommand[],
): CodebaseGraph {
  const graph = createEmptyCodebaseGraph(rootPath, rootPath);
  graph.commands.push(...commands);
  return graph;
}

// A source-backed project whose graph exposes a single `test` command = `command`.
async function setup(command: string): Promise<{
  runner: CommandRunner;
  kernel: Kernel;
  dir: string;
  cleanup: () => Promise<void>;
}> {
  const dir = await Deno.makeTempDir({
    dir: "/private/tmp",
    prefix: "tideide-command-runner-",
  });
  const db = await Database.create({ driver: "pglite" });
  const kernel = new Kernel(db);
  const entry = createProject(dir, "Imported App");
  writeProjectMode(entry.path, PROJECT_MODE_SOURCE_BACKED);
  kernel.codebaseGraph = graphWith(entry.path, [
    testCommand(entry.path, command),
  ]);
  const runner = new CommandRunner(kernel, entry.path);
  return {
    runner,
    kernel,
    dir: entry.path,
    cleanup: async () => {
      await runner.shutdown();
      await db.close();
      removeProject(dir);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

Deno.test({
  ...testOpts,
  name: "resolveProjectCommand: mode gating, missing graph, and allow-list",
  fn: async () => {
    const dir = await Deno.makeTempDir({
      dir: "/private/tmp",
      prefix: "tideide-command-resolve-",
    });
    const db = await Database.create({ driver: "pglite" });
    const kernel = new Kernel(db);
    try {
      const entry = createProject(dir, "Native App"); // defaults to registry-native
      kernel.codebaseGraph = graphWith(entry.path, [
        testCommand(entry.path, "echo hi"),
      ]);

      // Registry-native is refused even with a matching command in the graph.
      const gated = resolveProjectCommand(kernel, entry.path, { kind: "test" });
      assertEquals(gated.ok, false);
      if (!gated.ok) assertEquals(gated.error.code, "MODE_NOT_SOURCE_BACKED");

      writeProjectMode(entry.path, PROJECT_MODE_SOURCE_BACKED);

      // A command kind not present in the graph is refused (allow-list).
      const missing = resolveProjectCommand(kernel, entry.path, {
        kind: "build",
      });
      assertEquals(missing.ok, false);
      if (!missing.ok) assertEquals(missing.error.code, "COMMAND_NOT_FOUND");

      // An unknown explicit id is refused too.
      const badId = resolveProjectCommand(kernel, entry.path, {
        id: "command:nope",
      });
      assertEquals(badId.ok, false);
      if (!badId.ok) assertEquals(badId.error.code, "COMMAND_NOT_FOUND");

      // Resolves by kind and by exact id.
      const byKind = resolveProjectCommand(kernel, entry.path, {
        kind: "test",
      });
      assert(byKind.ok);
      if (byKind.ok) assertEquals(byKind.data.command, "echo hi");
      const byId = resolveProjectCommand(kernel, entry.path, {
        id: "command:test:test",
      });
      assert(byId.ok);
      if (byId.ok) assertEquals(byId.data.commandKind, "test");

      // No graph yet ⇒ NO_GRAPH.
      kernel.codebaseGraph = null;
      const noGraph = resolveProjectCommand(kernel, entry.path, {
        kind: "test",
      });
      assertEquals(noGraph.ok, false);
      if (!noGraph.ok) assertEquals(noGraph.error.code, "NO_GRAPH");
    } finally {
      await db.close();
      removeProject(dir);
      rmSync(dir, { recursive: true, force: true });
    }
  },
});

Deno.test({
  ...testOpts,
  name: "CommandRunner: a passing command surfaces ok + exit 0 + transcript",
  fn: async () => {
    const { runner, cleanup } = await setup("echo hello-from-test");
    try {
      const run = await runner.run({ kind: "test" });
      assert(run.ok);
      if (!run.ok) return;
      assertEquals(run.data.ok, true);
      assertEquals(run.data.exitCode, 0);
      assertEquals(run.data.commandKind, "test");
      assertStringIncludes(run.data.stdout, "hello-from-test");
      assertStringIncludes(run.data.transcript, "hello-from-test");
      assertEquals(runner.running, false);
    } finally {
      await cleanup();
    }
  },
});

Deno.test({
  ...testOpts,
  name:
    "CommandRunner: a failing command surfaces ok:false + exit code, not a throw",
  fn: async () => {
    const { runner, cleanup } = await setup("echo boom 1>&2; exit 3");
    try {
      const run = await runner.run({ kind: "test" });
      assert(run.ok, "run resolves a Result, never throws");
      if (!run.ok) return;
      assertEquals(run.data.ok, false);
      assertEquals(run.data.exitCode, 3);
      assertStringIncludes(run.data.stderr, "boom");
    } finally {
      await cleanup();
    }
  },
});

Deno.test({
  ...testOpts,
  name: "CommandRunner: refuses a concurrent run (COMMAND_ALREADY_RUNNING)",
  fn: async () => {
    const { runner, cleanup } = await setup("sleep 30");
    try {
      const first = runner.run({ kind: "test" }, { timeoutMs: 30_000 });
      await delay(100);
      const second = await runner.run({ kind: "test" });
      assertEquals(second.ok, false);
      if (!second.ok) {
        assertEquals(second.error.code, "COMMAND_ALREADY_RUNNING");
      }
      await runner.cancel();
      await first;
    } finally {
      await cleanup();
    }
  },
});

Deno.test({
  ...testOpts,
  name:
    "CommandRunner: timeout terminates the command and leaves no descendant",
  fn: async () => {
    const { runner, cleanup } = await setup("sleep 30");
    try {
      const run = runner.run({ kind: "test" }, { timeoutMs: 400 });
      const pid = runner.status().pid;
      assert(pid !== null, "a child pid should be recorded while running");
      await delay(150);
      const descendants = await collectDescendantPids(pid!);
      const result = await run;
      assert(result.ok);
      if (!result.ok) return;
      assertEquals(result.data.timedOut, true);
      assertEquals(result.data.ok, false);
      assertEquals(pidAlive(pid!), false);
      for (const d of descendants) {
        assertEquals(pidAlive(d), false, `descendant ${d} should be dead`);
      }
    } finally {
      await cleanup();
    }
  },
});

Deno.test({
  ...testOpts,
  name: "CommandRunner: cancel kills the whole process tree",
  fn: async () => {
    const { runner, cleanup } = await setup("sleep 30");
    try {
      const run = runner.run({ kind: "test" }, { timeoutMs: 30_000 });
      const pid = runner.status().pid;
      assert(pid !== null);
      await delay(150);
      const descendants = await collectDescendantPids(pid!);
      const canceled = await runner.cancel();
      assert(canceled.ok);
      const result = await run;
      assert(result.ok);
      if (!result.ok) return;
      assertEquals(result.data.canceled, true);
      assertEquals(result.data.ok, false);
      assertEquals(pidAlive(pid!), false);
      for (const d of descendants) {
        assertEquals(pidAlive(d), false, `descendant ${d} should be dead`);
      }
    } finally {
      await cleanup();
    }
  },
});
