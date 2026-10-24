import { assert, assertEquals, assertExists } from "@std/assert";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { testComposition } from "../../cli/test-composition.ts";
import { deleteChangesetSnapshot } from "../changeset-snapshots.ts";
import { MAX_OPEN_TASKS, OPENTIDE_DB_URL_ENV } from "../config.ts";
import { startControlServer } from "../control-server.ts";
import {
  getProjectPaths,
  listProjects,
  markProjectAsFork,
  PROJECT_MODE_SOURCE_BACKED,
  readProjectMode,
  writeProjectMode,
} from "../project-manager.ts";
import {
  loadProject,
  type ProjectContext,
  unloadProject,
} from "../project-loader.ts";
import { dispatchTool } from "../tools/dispatch.ts";
import {
  createTaskFork,
  discardTaskFork,
  listTasks,
  updateTaskClaims,
} from "./fork.ts";
import {
  createOk,
  registerHandler,
  testOpts,
  withMainProject,
} from "./task-fixtures_test.ts";
import { readTasks, type TaskRecord, writeTasks } from "./task-store.ts";

// Opens a changeset on main and does some work in it: a handler, a column, a
// row, a file edit.
async function workInChangeset(main: ProjectContext): Promise<string> {
  const noop = () => {};
  const created = await dispatchTool(
    "create_changeset",
    {
      title: "Mid work",
      plan: {
        summary: "Half-done work.",
        steps: ["Do it"],
        acceptanceCriteria: ["Done."],
        verificationPlan: [{
          id: "check_done",
          claimIds: ["claim_0"],
          kind: "unit",
          description: "Done.",
        }],
      },
    },
    main.kernel,
    noop,
  );
  assert(created.ok, JSON.stringify(created.error));
  const id = (created.data as { id: string }).id;
  await main.kernel.changesets.approve(id);
  await main.kernel.changesets.startWork(id);
  for (
    const [verb, input] of [
      ["define_handler", {
        name: "midWork",
        source: `function midWork() { return new Response("mid"); }`,
        duplicateJustification: "Test fixture.",
      }],
      ["alter_schema", {
        tableName: "items",
        sql: "ALTER TABLE items ADD COLUMN note TEXT",
      }],
      ["execute_sql", { sql: "INSERT INTO items (name) VALUES ('during')" }],
      ["write_project_file", { path: "notes.md", content: "v2\n" }],
    ] as const
  ) {
    const r = await dispatchTool(verb, input, main.kernel, noop, {});
    assert(r.ok, `${verb}: ${JSON.stringify(r.error)}`);
  }
  return id;
}

async function columnNames(ctx: ProjectContext): Promise<string[]> {
  const rows = await ctx.db.query(
    "SELECT column_name FROM information_schema.columns WHERE table_name = 'items' ORDER BY column_name",
  );
  return rows.map((r) => String(r.column_name));
}

async function itemNames(ctx: ProjectContext): Promise<string[]> {
  const rows = await ctx.db.query("SELECT name FROM items ORDER BY id");
  return rows.map((r) => String(r.name));
}

Deno.test({
  ...testOpts,
  name:
    "a task fork runs beside main, starts with main's work, and stays apart",
  fn: () =>
    withMainProject(async (main) => {
      const { task } = await createOk(main.kernel, "Add totals");
      const forkPaths = getProjectPaths(task.path);
      const manifest = JSON.parse(readFileSync(forkPaths.manifest, "utf-8"));
      assertEquals(manifest.fork.taskId, task.id);
      assertEquals(manifest.fork.parentPath, main.entry.path);
      assertEquals("previewPort" in manifest, false);
      assert(existsSync(join(forkPaths.forkBaseDir, "state")));
      assert(!existsSync(join(task.path, ".git")));
      assert(!existsSync(join(task.path, ".opentide", "tasks.json")));

      const fork = await loadProject(task.path, {
        appPort: 0,
        composition: testComposition(),
      });
      try {
        fork.rebuild();
        assert(main.appServer.port > 0 && fork.appServer.port > 0);
        assert(fork.appServer.port !== main.appServer.port);
        for (const ctx of [main, fork]) {
          const res = await fetch(
            `http://127.0.0.1:${ctx.appServer.port}/total`,
          );
          assertEquals(await res.text(), "calcTotal");
        }
        assertEquals(
          listProjects().some((p) => p.path === task.path),
          false,
          "a fork never enters the project registry",
        );
        assertExists(fork.kernel.handlers.get("calcTotal"));
        assertEquals(await itemNames(fork), ["main row"]);

        await registerHandler(fork.kernel, "forkOnly");
        await fork.db.execute("INSERT INTO items (name) VALUES ($1)", [
          "fork row",
        ]);
        assertEquals(main.kernel.handlers.get("forkOnly"), undefined);
        assertEquals(await itemNames(main), ["main row"]);

        const busy = await discardTaskFork(main.kernel, task.id);
        assertEquals(busy.ok ? null : busy.error.code, "TASK_BUSY");
      } finally {
        await unloadProject(fork);
      }

      const discarded = await discardTaskFork(main.kernel, task.id);
      assert(discarded.ok);
      assertEquals(discarded.data.status, "discarded");
      assert(discarded.data.discardedAt);
      assert(!existsSync(task.path));
      const again = await discardTaskFork(main.kernel, task.id);
      assert(again.ok, "discard is idempotent");
    }),
});

Deno.test({
  ...testOpts,
  name: "task claims report overlaps both ways and never refuse",
  fn: () =>
    withMainProject(async (main) => {
      const first = await createOk(main.kernel, "Totals", [
        "handler:calcTotal",
      ]);
      assertEquals(first.overlaps, []);
      const second = await createOk(main.kernel, "Discounts", [
        "handler:calcTotal",
        "route:GET /api/discounts",
      ]);
      assertEquals(second.overlaps, [{
        taskId: first.task.id,
        title: "Totals",
        scopes: ["handler:calcTotal"],
      }]);
      const third = await createOk(main.kernel, "Docs", ["template:readme"]);
      assertEquals(third.overlaps, []);

      const listed = listTasks(main.kernel);
      assert(listed.ok);
      const byId = new Map(listed.data.map((t) => [t.id, t]));
      assertEquals(
        byId.get(first.task.id)?.overlaps.map((o) => o.taskId),
        [second.task.id],
        "a late claim shows up on the earlier task",
      );
      assertEquals(byId.get(third.task.id)?.overlaps, []);

      const moved = updateTaskClaims(main.kernel, second.task.id, [
        "handler:applyDiscount",
      ]);
      assert(moved.ok);
      assertEquals(moved.data.overlaps, []);

      const bad = updateTaskClaims(main.kernel, second.task.id, ["calcTotal"]);
      assertEquals(bad.ok ? null : bad.error.code, "INVALID_CLAIM");
    }),
});

Deno.test({
  ...testOpts,
  name:
    "task fork refusals: in a fork, source-backed, external DB, open-task limit",
  fn: () =>
    withMainProject(async (main) => {
      const dir = main.entry.path;
      const code = async () => {
        const r = await createTaskFork(main.kernel, { title: "x" });
        return r.ok ? null : r.error.code;
      };

      const manifest = getProjectPaths(dir).manifest;
      const manifestText = readFileSync(manifest, "utf-8");
      markProjectAsFork(dir, {
        parentPath: "/elsewhere/main",
        taskId: "task_parent",
        title: "parent",
        createdAt: new Date().toISOString(),
      });
      try {
        assertEquals(await code(), "TASK_IN_FORK");
      } finally {
        writeFileSync(manifest, manifestText);
      }

      const mode = readProjectMode(dir);
      writeProjectMode(dir, PROJECT_MODE_SOURCE_BACKED);
      assertEquals(await code(), "TASK_SOURCE_BACKED");
      writeProjectMode(dir, mode);

      Deno.env.set(OPENTIDE_DB_URL_ENV, "postgres://nowhere/none");
      try {
        assertEquals(await code(), "TASK_EXTERNAL_DB");
      } finally {
        Deno.env.delete(OPENTIDE_DB_URL_ENV);
      }

      const tasksFile = getProjectPaths(dir).tasksFile;
      const fake = (i: number): TaskRecord => ({
        id: `task_fake${i}`,
        title: `fake ${i}`,
        path: join(dir, "missing", String(i)),
        status: "open",
        createdAt: new Date().toISOString(),
        claims: [],
      });
      writeTasks(
        tasksFile,
        Array.from({ length: MAX_OPEN_TASKS }, (_, i) => fake(i)),
      );
      try {
        assertEquals(await code(), "TASK_LIMIT");
      } finally {
        writeTasks(tasksFile, []);
      }
      assertEquals(readTasks(tasksFile), []);
    }),
});

Deno.test({
  ...testOpts,
  name: "REST /api/tasks creates, lists, patches and discards a fork",
  fn: () =>
    withMainProject(async (main) => {
      const control = await startControlServer(main, 0);
      const base = `http://127.0.0.1:${control.server.addr.port}/api/tasks`;
      const json = (method: string, body: unknown): RequestInit => ({
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      try {
        const created = await fetch(
          base,
          json("POST", {
            title: "Totals",
            claims: ["handler:calcTotal"],
            serve: false,
          }),
        );
        assertEquals(created.status, 201);
        const { task } = await created.json() as { task: TaskRecord };

        const listed = await (await fetch(base)).json() as TaskRecord[];
        assertEquals(listed.map((t) => t.id), [task.id]);

        const patched = await fetch(
          `${base}/${task.id}`,
          json("PATCH", { claims: ["handler:other"] }),
        );
        assertEquals(
          (await patched.json() as { task: TaskRecord }).task.claims,
          ["handler:other"],
        );

        const missing = await fetch(`${base}/task_nope`, { method: "DELETE" });
        assertEquals(missing.status, 404);
        assertEquals((await missing.json()).code, "TASK_NOT_FOUND");

        const discarded = await fetch(`${base}/${task.id}`, {
          method: "DELETE",
        });
        assertEquals((await discarded.json()).status, "discarded");
      } finally {
        await control.server.shutdown();
      }
    }),
});

Deno.test({
  ...testOpts,
  name:
    "a fork cut mid-changeset starts from the changeset's start, with today's rows",
  fn: () =>
    withMainProject(async (main) => {
      writeFileSync(join(main.entry.path, "notes.md"), "v1\n");
      const changesetId = await workInChangeset(main);

      const { task } = await createOk(main.kernel, "Parallel");
      assertEquals(task.baseChangesetId, changesetId);
      const base = join(getProjectPaths(task.path).forkBaseDir, "state");
      assert(!existsSync(join(base, "handlers", "midWork.json")));
      assert(existsSync(join(base, "handlers", "calcTotal.json")));

      const fork = await loadProject(task.path, {
        appPort: 0,
        composition: testComposition(),
      });
      try {
        assertEquals(fork.kernel.handlers.get("midWork"), undefined);
        assertExists(fork.kernel.handlers.get("calcTotal"));
        assertEquals(await columnNames(fork), ["id", "name"]);
        assertEquals(await itemNames(fork), ["main row", "during"]);
        assertEquals(
          readFileSync(join(task.path, "notes.md"), "utf-8"),
          "v1\n",
        );
        assertEquals(await fork.kernel.activeChangesetId(), null);
      } finally {
        await unloadProject(fork);
      }

      assertExists(main.kernel.handlers.get("midWork"), "main keeps its work");
      assertEquals(await columnNames(main), ["id", "name", "note"]);
      assertEquals(
        readFileSync(join(main.entry.path, "notes.md"), "utf-8"),
        "v2\n",
      );
    }),
});

Deno.test({
  ...testOpts,
  name: "no start snapshot for the open changeset refuses the fork",
  fn: () =>
    withMainProject(async (main) => {
      const changesetId = await workInChangeset(main);
      deleteChangesetSnapshot(main.entry.path, changesetId);
      const r = await createTaskFork(main.kernel, { title: "x" });
      assertEquals(r.ok ? null : r.error.code, "TASK_NO_CLEAN_POINT");
    }),
});

Deno.test({
  ...testOpts,
  name:
    "GET /api/tasks/:id/diff flushes a live fork and reports what would merge",
  fn: () =>
    withMainProject(async (main) => {
      const { task } = await createOk(main.kernel, "Diff me");
      const fork = await loadProject(task.path, {
        appPort: 0,
        composition: testComposition(),
      });
      const forkControl = await startControlServer(fork, 0);
      const mainControl = await startControlServer(main, 0);
      const manual = { manualEdit: true };
      const noop = () => {};
      const write = async (
        ctx: ProjectContext,
        verb: string,
        input: Record<string, unknown>,
      ) => {
        const r = await dispatchTool(verb, input, ctx.kernel, noop, manual);
        assert(r.ok, `${verb}: ${JSON.stringify(r.error)}`);
      };
      try {
        await write(fork, "define_handler", {
          name: "forkOnly",
          source: `function forkOnly() { return new Response("f"); }`,
          duplicateJustification: "Test fixture.",
        });
        await write(fork, "define_handler", {
          name: "calcTotal",
          source: `function calcTotal() { return new Response("fork"); }`,
          duplicateJustification: "Test fixture.",
        });
        await write(fork, "alter_schema", {
          tableName: "items",
          sql: "ALTER TABLE items ADD COLUMN note TEXT",
        });
        await write(fork, "write_project_file", {
          path: "docs/fork.md",
          content: "fork\n",
        });
        await write(main, "define_handler", {
          name: "calcTotal",
          source: `function calcTotal() { return new Response("main"); }`,
          duplicateJustification: "Test fixture.",
        });

        const forkHandlerFile = join(
          getProjectPaths(task.path).stateDir,
          "handlers",
          "forkOnly.json",
        );
        assert(!existsSync(forkHandlerFile), "not flushed yet");
        const res = await fetch(
          `http://127.0.0.1:${mainControl.server.addr.port}/api/tasks/${task.id}/diff`,
        );
        assertEquals(res.status, 200);
        const diff = await res.json() as {
          apply: Array<{ category: string; key: string; op: string }>;
          conflicts: Array<{ category: string; key: string }>;
          blocked: boolean;
        };
        assertEquals(
          diff.apply.map((c) => `${c.op} ${c.category}:${c.key}`),
          [
            "alter schema:items",
            "create handlers:forkOnly",
            "create files:docs/fork.md",
          ],
        );
        assertEquals(
          diff.conflicts.map((c) => `${c.category}:${c.key}`),
          ["handlers:calcTotal"],
        );
        assertEquals(diff.blocked, true);
      } finally {
        await mainControl.server.shutdown();
        await forkControl.server.shutdown();
        await unloadProject(fork);
      }
    }),
});
