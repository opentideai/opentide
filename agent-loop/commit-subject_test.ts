// The IDE's commit button, as the agent runs it against a fake MCP transport.
//
// This file statically imports nothing that loads config.ts, and the
// unconfigured case runs first: config fixes its directory on first load, so
// it has to read the empty temp HOME (see model-refresh-hook_test). The rest
// stand a fake in for the model and never ask config for one.
import { assertEquals } from "@std/assert";
import type { ToolResult } from "../core/tools/dispatch.ts";
import type { GitProjectStatus } from "../shared/git.ts";

type CommitModule = typeof import("./commit-subject.ts");

async function load(): Promise<CommitModule> {
  return await import(`./commit-subject.ts?u=${crypto.randomUUID()}`);
}

function status(overrides: Partial<GitProjectStatus> = {}): GitProjectStatus {
  return {
    initialized: true,
    gitignoreExists: true,
    branch: "main",
    clean: false,
    dirty: true,
    changedCount: 2,
    untrackedCount: 1,
    files: [
      { path: "app.ts", index: "M", worktree: " ", untracked: false },
      { path: "CHANGELOG.md", index: "?", worktree: "?", untracked: true },
    ],
    projectState: { changedCount: 1, untrackedCount: 0 },
    latestCommit: null,
    remotes: [],
    hasRemote: false,
    canPush: false,
    pushReady: false,
    ahead: 0,
    behind: 0,
    ...overrides,
  };
}

// git_status and git_commit as serve answers them; records each call.
function fakeTools(): {
  calls: Array<[string, Record<string, unknown>]>;
  callTool(name: string, args: Record<string, unknown>): Promise<ToolResult>;
} {
  const calls: Array<[string, Record<string, unknown>]> = [];
  return {
    calls,
    callTool(name, args) {
      calls.push([name, args]);
      if (name === "git_status") {
        return Promise.resolve({ ok: true, data: status() });
      }
      const subject = typeof args.message === "string"
        ? args.message
        : "Update app.ts";
      return Promise.resolve({
        ok: true,
        data: status({
          clean: true,
          dirty: false,
          latestCommit: { hash: "abc", subject },
        }),
      });
    },
  };
}

Deno.test("with no model configured, nothing is asked of a provider", async () => {
  const home = await Deno.makeTempDir({ prefix: "opentide-commit-subject-" });
  const saved = ["HOME", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"].map((name) =>
    [name, Deno.env.get(name)] as const
  );
  try {
    Deno.env.set("HOME", home);
    Deno.env.delete("ANTHROPIC_API_KEY");
    Deno.env.delete("OPENAI_API_KEY");
    const { commitProject } = await load();
    const tools = fakeTools();
    const result = await commitProject(tools, "");
    assertEquals(tools.calls, [["git_commit", {}]]);
    assertEquals(
      (result.data as { messageGeneratedBy: string }).messageGeneratedBy,
      "fallback",
    );
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) Deno.env.delete(name);
      else Deno.env.set(name, value);
    }
    await Deno.remove(home, { recursive: true });
  }
});

Deno.test("a typed message is committed as typed, without a model", async () => {
  const { commitProject } = await load();
  const tools = fakeTools();
  const result = await commitProject(tools, "  Fix the thing ", {
    call: () => Promise.reject(new Error("no model for a typed message")),
  });
  assertEquals(tools.calls, [["git_commit", { message: "Fix the thing" }]]);
  assertEquals(result.ok, true);
  const data = result.data as { message: string; messageGeneratedBy: string };
  assertEquals(data.message, "Fix the thing");
  assertEquals(data.messageGeneratedBy, "user");
});

Deno.test("an empty message gets the model's subject from the status", async () => {
  const { commitProject } = await load();
  const tools = fakeTools();
  let seen = "";
  const { describeChanges } = await load();
  const result = await commitProject(tools, "", {
    call: ({ status }) => {
      seen = describeChanges(status);
      return Promise.resolve('"Add changelog."\nbody ignored');
    },
  });
  assertEquals(
    seen,
    "M  app.ts\n?? CHANGELOG.md\n(1 OpenTide state file(s) under .opentide/)",
  );
  assertEquals(tools.calls, [
    ["git_status", {}],
    ["git_commit", { message: "Add changelog" }],
  ]);
  const data = result.data as {
    message: string;
    messageGenerated: boolean;
    messageGeneratedBy: string;
    status: GitProjectStatus;
  };
  assertEquals(data.message, "Add changelog");
  assertEquals(data.messageGenerated, true);
  assertEquals(data.messageGeneratedBy, "model");
  assertEquals(data.status.clean, true);
});

Deno.test("a reply that won't do leaves the subject to git_commit", async () => {
  const { commitProject } = await load();
  const tools = fakeTools();
  const result = await commitProject(tools, undefined, {
    call: () => Promise.resolve("x".repeat(200)),
  });
  assertEquals(tools.calls.at(-1), ["git_commit", {}]);
  const data = result.data as { message: string; messageGeneratedBy: string };
  assertEquals(data.message, "Update app.ts");
  assertEquals(data.messageGeneratedBy, "fallback");
});

Deno.test("a failed commit comes back as the tool's error", async () => {
  const { commitProject } = await load();
  const failed: ToolResult = {
    ok: false,
    error: { code: "NOTHING_TO_COMMIT", message: "Nothing to commit." },
  };
  const result = await commitProject(
    { callTool: () => Promise.resolve(failed) },
    "Fix",
  );
  assertEquals(result, failed);
});
