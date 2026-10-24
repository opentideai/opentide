import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { existsSync } from "node:fs";
import { startControlServer } from "../control-server.ts";
import { getProjectPaths } from "../project-manager.ts";
import type { ProjectContext } from "../project-loader.ts";
import { dispatchTool } from "../tools/dispatch.ts";
import {
  createOk,
  inFork,
  testOpts,
  withMainProject,
} from "./task-fixtures_test.ts";
import { discardTaskFork } from "./fork.ts";
import { mergeTask, packageVersion, type TaskMerge } from "./task-merge.ts";
import { readTasks, type TaskRecord } from "./task-store.ts";

const noop = () => {};

async function work(
  ctx: ProjectContext,
  verb: string,
  input: Record<string, unknown>,
): Promise<void> {
  const r = await dispatchTool(verb, input, ctx.kernel, noop, {
    manualEdit: true,
  });
  assert(r.ok, `${verb}: ${JSON.stringify(r.error)}`);
}

function handler(name: string, body: string) {
  return {
    name,
    source: `function ${name}() { return new Response("${body}"); }`,
    duplicateJustification: "Test fixture.",
  };
}

// A handler, its route and a test, the way an agent would land them in a fork.
async function landRoute(
  fork: ProjectContext,
  name: string,
  path: string,
  testBody = "assertEquals(1, 1);",
): Promise<void> {
  await work(fork, "define_handler", handler(name, name));
  await work(fork, "register_route", {
    method: "GET",
    path,
    handlerName: name,
  });
  const test = `test${name[0]!.toUpperCase()}${name.slice(1)}`;
  await work(fork, "define_test", {
    name: test,
    source: `async function ${test}() { ${testBody} }`,
  });
  // What the readiness check's docs-drift warning tells every agent to do.
  await work(fork, "generate_project_docs", { files: ["AGENT.md"] });
}

async function mergeOk(
  main: ProjectContext,
  id: string,
): Promise<TaskMerge> {
  const r = await mergeTask(main.kernel, id, main.rebuild);
  assert(r.ok, JSON.stringify(!r.ok && r.error));
  return r.data;
}

function taskById(main: ProjectContext, id: string): TaskRecord | undefined {
  return readTasks(getProjectPaths(main.entry.path).tasksFile)
    .find((t) => t.id === id);
}

Deno.test("packageVersion reads the version off a specifier", () => {
  assertEquals(packageVersion("npm:marked@5.1.0"), "5.1.0");
  assertEquals(packageVersion("npm:@scope/pkg@^2"), "^2");
  assertEquals(packageVersion("npm:@scope/pkg"), undefined);
  assertEquals(packageVersion("marked"), undefined);
});

Deno.test({
  ...testOpts,
  name: "two forks with different handlers both merge, under task principals",
  fn: () =>
    withMainProject(async (main) => {
      const a = (await createOk(main.kernel, "Route a")).task;
      const b = (await createOk(main.kernel, "Route b")).task;
      await inFork(a.path, async (fork) => {
        await landRoute(fork, "routeA", "/api/a");
        const [last] = await fork.kernel.changelog.entityHistory(
          "handler",
          "routeA",
          1,
        );
        await fork.kernel.changelog.updateWorkblockMetadata(last!.id, {
          rationale: "Callers need /api/a.",
        });
      });
      await inFork(b.path, (fork) => landRoute(fork, "routeB", "/api/b"));

      const mergedA = await mergeOk(main, a.id);
      assertEquals(mergedA.outcome, "merged", JSON.stringify(mergedA));
      assertEquals(mergedA.tests, { total: 1, passed: 1, failed: 0 });
      assertEquals(
        mergedA.applied.map((c) => `${c.op} ${c.category}:${c.key}`),
        [
          "create handlers:routeA",
          "create routes:GET /api/a",
          "create tests:testRouteA",
          "regenerate files:AGENT.md",
        ],
      );
      const mergedB = await mergeOk(main, b.id);
      assertEquals(mergedB.outcome, "merged", JSON.stringify(mergedB));
      assertEquals(mergedB.tests?.total, 2, "main's tests, not the fork's");

      for (const path of ["/api/a", "/api/b"]) {
        assert(main.kernel.routes.get("GET", path), path);
      }
      const agentMd = await Deno.readTextFile(
        `${main.entry.path}/AGENT.md`,
      );
      assertStringIncludes(agentMd, "GET /api/a");
      assertStringIncludes(agentMd, "GET /api/b");
      const csA = await main.kernel.changesets.get(mergedA.changesetId);
      assertEquals(csA?.status, "completed");
      assertEquals(taskById(main, a.id)?.status, "merged");
      assertEquals(taskById(main, a.id)?.mergeChangesetId, csA?.id);
      assert(existsSync(a.path), "the fork stays until discard");

      const records = await main.kernel.changelog.listByChangeset(
        mergedA.changesetId,
      );
      assert(records.length >= 3);
      for (const r of records) {
        assertEquals(r.context?.principalId, `task:${a.id}`);
      }
      const handlerRecord = records.find((r) =>
        r.category === "handler" && r.key === "routeA"
      );
      assertEquals(handlerRecord?.rationale, "Callers need /api/a.");
      const routeRecord = records.find((r) => r.category === "route");
      assertStringIncludes(routeRecord?.rationale ?? "", a.id);

      const discarded = await discardTaskFork(main.kernel, a.id);
      assert(discarded.ok);
      assertEquals(discarded.data.status, "merged", "discard keeps the merge");
      assert(discarded.data.discardedAt, "and says the fork is gone");
      assert(!existsSync(a.path));
    }),
});

Deno.test({
  ...testOpts,
  name:
    "POST /api/tasks/:id/merge refuses a second fork that changed the same handler",
  fn: () =>
    withMainProject(async (main) => {
      const a = (await createOk(main.kernel, "Edit total a")).task;
      const b = (await createOk(main.kernel, "Edit total b")).task;
      await inFork(a.path, async (fork) => {
        await work(fork, "define_handler", handler("calcTotal", "a"));
        await landRoute(fork, "checkA", "/api/check-a");
      });
      await inFork(b.path, async (fork) => {
        await work(fork, "define_handler", handler("calcTotal", "b"));
      });
      assertEquals((await mergeOk(main, a.id)).outcome, "merged");

      const control = await startControlServer(main, 0);
      try {
        const res = await fetch(
          `http://127.0.0.1:${control.server.addr.port}/api/tasks/${b.id}/merge`,
          { method: "POST" },
        );
        assertEquals(res.status, 409);
        const body = await res.json() as {
          code: string;
          error: string;
          suggestion?: string;
        };
        assertEquals(body.code, "TASK_MERGE_BLOCKED");
        assertStringIncludes(body.error, "conflict handlers:calcTotal");
        assertStringIncludes(body.suggestion ?? "", `Discard task ${b.id}`);
      } finally {
        await control.server.shutdown();
      }
      assertEquals(taskById(main, b.id)?.status, "open");
      assertEquals(await main.kernel.activeChangesetId(), null);
    }),
});

Deno.test({
  ...testOpts,
  name: "a schema alter merges and main keeps its rows",
  fn: () =>
    withMainProject(async (main) => {
      const { task } = await createOk(main.kernel, "Add note");
      await inFork(task.path, async (fork) => {
        await work(fork, "alter_schema", {
          tableName: "items",
          sql: "ALTER TABLE items ADD COLUMN note TEXT",
        });
        await fork.db.execute("INSERT INTO items (name) VALUES ('fork row')");
        await landRoute(fork, "notes", "/api/notes");
      });
      const merged = await mergeOk(main, task.id);
      assertEquals(merged.outcome, "merged", JSON.stringify(merged));
      assertEquals(merged.applied[0], {
        category: "schema",
        key: "items",
        op: "alter",
      });
      const columns = await main.db.query(
        "SELECT column_name FROM information_schema.columns WHERE table_name = 'items' ORDER BY column_name",
      );
      assertEquals(columns.map((r) => r.column_name), ["id", "name", "note"]);
      const rows = await main.db.query("SELECT name FROM items ORDER BY id");
      assertEquals(rows.map((r) => r.name), ["main row"]);
      assert(merged.notMerged.some((n) => n.kind === "rows"));
    }),
});

Deno.test({
  ...testOpts,
  name: "a failing test on main leaves the merge changeset in progress",
  fn: () =>
    withMainProject(async (main) => {
      const { task } = await createOk(main.kernel, "Broken");
      await inFork(
        task.path,
        (fork) =>
          landRoute(fork, "broken", "/api/broken", "assertEquals(1, 2);"),
      );
      const merged = await mergeOk(main, task.id);
      assertEquals(merged.outcome, "unverified");
      assertEquals(merged.tests?.failed, 1);
      assert(
        merged.readiness?.some((line) =>
          line.includes("VERIFICATION_NOT_PASSING")
        ),
        JSON.stringify(merged.readiness),
      );
      const cs = await main.kernel.changesets.get(merged.changesetId);
      assertEquals(cs?.status, "in_progress");
      assert(main.kernel.routes.get("GET", "/api/broken"), "the work landed");
    }),
});

Deno.test({
  ...testOpts,
  name: "a fork with a changeset open refuses the merge",
  fn: () =>
    withMainProject(async (main) => {
      const { task } = await createOk(main.kernel, "Busy");
      await inFork(task.path, async (fork) => {
        const r = await dispatchTool(
          "create_changeset",
          {
            title: "Unfinished",
            plan: {
              summary: "Not done.",
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
          fork.kernel,
          noop,
        );
        assert(r.ok, JSON.stringify(r.error));
      });
      const r = await mergeTask(main.kernel, task.id, main.rebuild);
      assertEquals(r.ok ? null : r.error.code, "TASK_BUSY");
      assertEquals(taskById(main, task.id)?.status, "open");
    }),
});
