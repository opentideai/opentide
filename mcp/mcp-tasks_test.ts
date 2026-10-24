import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { getProjectPaths, markProjectAsFork } from "../core/project-manager.ts";
import type { ProjectContext } from "../core/project-loader.ts";
import { dispatchTool } from "../core/tools/dispatch.ts";
import {
  createOk,
  inFork,
  testOpts,
  withMainProject,
} from "../core/tasks/task-fixtures_test.ts";
import type {
  TaskMerge,
  TaskRecord,
  TaskWithOverlaps,
} from "../shared/tasks.ts";
import { taskConnect } from "./mcp-connect.ts";
import { dispatchMcpTool, type McpToolResult } from "./mcp-projection.ts";

function text(result: McpToolResult): string {
  const [first] = result.content;
  assert(first?.type === "text");
  return first.text;
}

async function call<T>(
  main: ProjectContext,
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  const result = await dispatchMcpTool(name, args, main.kernel, main.rebuild);
  assert(!result.isError, `${name}: ${text(result)}`);
  return JSON.parse(text(result)) as T;
}

async function refusal(
  main: ProjectContext,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  const result = await dispatchMcpTool(name, args, main.kernel, main.rebuild);
  assert(result.isError, `${name} should have been refused`);
  return text(result);
}

Deno.test({
  ...testOpts,
  name: "task verbs over MCP: list, merge and discard a fork",
  fn: () =>
    withMainProject(async (main) => {
      const { task } = await createOk(main.kernel, "Route a", [
        "handler:routeA",
      ]);
      await inFork(task.path, async (fork) => {
        const r = await dispatchTool(
          "define_handler",
          {
            name: "routeA",
            source: `function routeA() { return new Response("a"); }`,
            duplicateJustification: "Test fixture.",
          },
          fork.kernel,
          fork.rebuild,
          { manualEdit: true },
        );
        assert(r.ok, JSON.stringify(r.error));
      });

      const listed = await call<TaskWithOverlaps[]>(main, "list_tasks", {});
      assertEquals(listed.map((t) => [t.id, t.status]), [[task.id, "open"]]);

      const merged = await call<TaskMerge>(main, "merge_task", {
        task_id: task.id,
      });
      assert(
        merged.applied.some((c) =>
          c.op === "create" && c.category === "handlers" && c.key === "routeA"
        ),
        JSON.stringify(merged),
      );
      assert(main.kernel.handlers.get("routeA"), "the handler is on main");
      assertEquals(merged.task.status, "merged");

      const discarded = await call<TaskRecord>(main, "discard_task", {
        task_id: task.id,
      });
      assertEquals(discarded.status, "merged");
      assert(discarded.discardedAt);
      assert(!existsSync(task.path));

      assertStringIncludes(
        await refusal(main, "merge_task", { task_id: "task_nope" }),
        "TASK_NOT_FOUND",
      );
    }),
});

Deno.test({
  ...testOpts,
  name: "start_task over MCP is refused inside a fork",
  fn: () =>
    withMainProject(async (main) => {
      const manifest = getProjectPaths(main.entry.path).manifest;
      const manifestText = readFileSync(manifest, "utf-8");
      markProjectAsFork(main.entry.path, {
        parentPath: "/elsewhere/main",
        taskId: "task_parent",
        title: "parent",
        createdAt: new Date().toISOString(),
      });
      try {
        const refused = await refusal(main, "start_task", { title: "x" });
        assertStringIncludes(refused, "TASK_IN_FORK");
        assertStringIncludes(refused, "/elsewhere/main");
      } finally {
        writeFileSync(manifest, manifestText);
      }
    }),
});

Deno.test("taskConnect runs Claude Code in the fork with only its server", () => {
  const connect = taskConnect("/tmp/forks/it's here");
  const server = connect.mcpServers.opentide as {
    type: string;
    args: string[];
  };
  assertEquals(server.type, "stdio");
  assertEquals(server.args.slice(-2), ["--project", "/tmp/forks/it's here"]);
  assert(
    connect.claudeCode.startsWith(`cd '/tmp/forks/it'\\''s here' && claude `),
    connect.claudeCode,
  );
  assert(connect.claudeCode.endsWith(" --strict-mcp-config"));
  assertStringIncludes(connect.claudeCode, '--mcp-config \'{"mcpServers":');
});
