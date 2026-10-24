import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createProject } from "../core/project-manager.ts";
import { isProjectLockHeld, readLockHolder } from "../core/project-lock.ts";
import { parseTaskCommand, renderMerged } from "./task-commands.ts";
import { isolateHome } from "../core/test-home_test.ts";

isolateHome();

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const STOP_TIMEOUT_MS = 15_000;
const STOP_POLL_MS = 100;

Deno.test("parseTaskCommand reads start, list, merge and discard", () => {
  assertEquals(
    parseTaskCommand([
      "start",
      "--project",
      "p",
      "--title",
      "Totals",
      "--claim",
      "handler:a",
      "--claim",
      "route:GET /api/a",
    ]),
    {
      ok: true,
      command: {
        action: "start",
        projectPath: resolve("p"),
        title: "Totals",
        claims: ["handler:a", "route:GET /api/a"],
        client: "claude-code",
      },
    },
  );
  assertEquals(parseTaskCommand(["list", "-p", "p"]), {
    ok: true,
    command: { action: "list", projectPath: resolve("p") },
  });
  assertEquals(parseTaskCommand(["merge", "-p", "p", "task_1"]), {
    ok: true,
    command: { action: "merge", projectPath: resolve("p"), id: "task_1" },
  });
  assertEquals(parseTaskCommand(["discard", "-p", "p", "task_1"]), {
    ok: true,
    command: { action: "discard", projectPath: resolve("p"), id: "task_1" },
  });
});

Deno.test("renderMerged says what landed and why main's changeset is open", () => {
  const lines = renderMerged({
    task: {
      id: "task_1",
      title: "T",
      path: "/f",
      status: "merged",
      createdAt: "2026-10-20T00:00:00.000Z",
      claims: [],
    },
    outcome: "unverified",
    changesetId: "cs_1",
    applied: [{ category: "handlers", key: "a", op: "create" }],
    tests: { total: 2, passed: 1, failed: 1 },
    readiness: ["VERIFICATION_NOT_PASSING: failed."],
    notMerged: [{ kind: "rows", severity: "info", message: "Rows stay." }],
  });
  assertEquals(lines, [
    "Task task_1 applied, but main's changeset didn't pass its gate.",
    "Changeset: cs_1",
    "Applied 1:",
    "  create handlers:a",
    "Main's tests: 1/2 passed",
    "Not completed:",
    "  VERIFICATION_NOT_PASSING: failed.",
  ]);
});

Deno.test("parseTaskCommand refuses what it can't run", () => {
  for (
    const argv of [
      [],
      ["list"],
      ["start", "-p", "p"],
      ["discard", "-p", "p"],
      ["discard", "-p", "p", "a", "b"],
      ["merge", "-p", "p"],
      ["list", "-p", "p", "--nope"],
    ]
  ) {
    assertEquals(parseTaskCommand(argv).ok, false, argv.join(" "));
  }
});

async function denoDir(): Promise<string> {
  const { stdout } = await new Deno.Command("deno", {
    args: ["info", "--json"],
    stdout: "piped",
  }).output();
  return (JSON.parse(new TextDecoder().decode(stdout)) as { denoDir: string })
    .denoDir;
}

async function stopServe(projectDir: string): Promise<void> {
  const holder = readLockHolder(projectDir);
  if (!holder || !isProjectLockHeld(projectDir)) return;
  Deno.kill(holder.pid, "SIGTERM");
  const deadline = Date.now() + STOP_TIMEOUT_MS;
  while (isProjectLockHeld(projectDir) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, STOP_POLL_MS));
  }
}

Deno.test({
  name: "opentide task: start, list and discard against a real serve",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const home = await Deno.makeTempDir({ prefix: "genie-task-cli-home-" });
    const parent = await Deno.makeTempDir({ prefix: "genie-task-cli-" });
    // A fresh HOME keeps forks and config out of the real ~/.opentide; DENO_DIR
    // keeps the module cache, which would otherwise move with HOME.
    const env = { HOME: home, DENO_DIR: await denoDir() };
    const project = createProject(parent, "Task CLI").path;
    const run = async (...args: string[]) => {
      const { code, stdout, stderr } = await new Deno.Command("deno", {
        args: ["task", "opentide", "task", ...args, "--project", project],
        cwd: REPO_ROOT,
        env,
        stdout: "piped",
        stderr: "piped",
      }).output();
      const out = new TextDecoder().decode(stdout);
      const err = new TextDecoder().decode(stderr);
      assertEquals(code, 0, `task ${args.join(" ")}: ${err}`);
      return { out, err };
    };
    let forkPath: string | null = null;
    try {
      const first = await run("list");
      assertStringIncludes(first.err, "Started opentide serve");
      assertStringIncludes(first.out, "No tasks.");

      const started = await run(
        "start",
        "--title",
        "Totals",
        "--claim",
        "handler:calcTotal",
      );
      const id = started.out.match(/^Task (task_\w+):/m)?.[1];
      forkPath = started.out.match(/^Fork: (.+)$/m)?.[1] ?? null;
      assert(id && forkPath, started.out);
      assertStringIncludes(started.out, "Serve: pid ");
      assertStringIncludes(started.out, `"--project",\n`);
      assertStringIncludes(started.out, forkPath);
      assert(isProjectLockHeld(forkPath), "the fork's serve holds the fork");

      const listed = await run("list");
      assertStringIncludes(listed.out, `${id}  open  port `);
      assertStringIncludes(listed.out, "claims: handler:calcTotal");

      const discarded = await run("discard", id);
      assertStringIncludes(discarded.out, `Task ${id} discarded`);
      assert(!existsSync(forkPath), "fork deleted");
    } finally {
      if (forkPath) await stopServe(forkPath);
      await stopServe(project);
      await Deno.remove(parent, { recursive: true });
      await Deno.remove(home, { recursive: true });
    }
  },
});
