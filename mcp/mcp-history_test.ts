import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { Kernel } from "../core/registries.ts";
import { Database } from "../core/db.ts";
import { testComposition } from "../cli/test-composition.ts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { dispatchMcpTool, projectedMcpTools } from "./mcp-projection.ts";
import { createMcpServer } from "./mcp-server.ts";
import { initCompiler, stopCompiler } from "../core/compiler.ts";
import { MCP_TURN_META_KEY } from "../core/config.ts";
import {
  APPEND_SESSION_MESSAGES,
  LINK_SESSION_MESSAGE,
  MAX_APPENDED_MESSAGES,
  OPEN_SESSION,
  RECORD_USAGE,
  type SessionBinding,
  SET_SESSION_SUMMARY,
  turnContextFrom,
} from "./mcp-history.ts";

const testOpts = { sanitizeResources: false, sanitizeOps: false };
const noop = () => {};

async function withKernel<T>(fn: (kernel: Kernel) => Promise<T>): Promise<T> {
  const db = await Database.create({ driver: "pglite" });
  const kernel = new Kernel(db, { composition: testComposition() });
  try {
    return await fn(kernel);
  } finally {
    await db.close();
  }
}

function call(
  kernel: Kernel,
  name: string,
  args: Record<string, unknown>,
  sessionId?: string,
  binding?: SessionBinding,
) {
  return dispatchMcpTool(
    name,
    args,
    kernel,
    noop,
    sessionId ? { sessionId, userMessage: "External MCP agent" } : undefined,
    binding,
  );
}

// Records what open_session binds, as the MCP server's binding does.
function recordingBinding(): SessionBinding & { bound: string[] } {
  const bound: string[] = [];
  return { bound, bind: (id) => bound.push(id) };
}

function json(
  result: Awaited<ReturnType<typeof call>>,
): Record<string, unknown> {
  assertEquals(result.isError, undefined, JSON.stringify(result.content));
  const block = result.content[0];
  assert(block?.type === "text");
  return JSON.parse(block.text);
}

function errorText(result: Awaited<ReturnType<typeof call>>): string {
  assertEquals(result.isError, true);
  const block = result.content[0];
  assert(block?.type === "text");
  return block.text;
}

const plan = {
  summary: "Add a page.",
  steps: [{ id: "s1", description: "Add it", status: "pending" as const }],
  acceptanceCriteria: [{
    id: "claim_0",
    text: "The page loads.",
    source: "agent" as const,
    priority: "must" as const,
  }],
  verificationPlan: [{
    id: "v1",
    claimIds: ["claim_0"],
    kind: "unit" as const,
    description: "Load the page.",
  }],
};

Deno.test({
  ...testOpts,
  name: "history verbs are listed on the MCP face",
  fn: () => {
    const names = new Set(
      projectedMcpTools(testComposition()).map((t) => t.name),
    );
    for (
      const verb of [
        OPEN_SESSION,
        APPEND_SESSION_MESSAGES,
        LINK_SESSION_MESSAGE,
        SET_SESSION_SUMMARY,
        RECORD_USAGE,
      ]
    ) {
      assert(names.has(verb), `${verb} should be listed`);
    }
  },
});

Deno.test({
  ...testOpts,
  name: "append_session_messages stores messages and links changes and anchors",
  fn: async () => {
    await withKernel(async (kernel) => {
      const session = await kernel.sessions.createSession("mcp client");
      const changeset = await kernel.changesets.create({
        sessionId: session.id,
        title: "Page",
        plan,
      });
      const change = await kernel.changelog.record({
        category: "handler",
        key: "page",
        action: "create",
        beforeSnapshot: null,
        afterSnapshot: { source: "x" },
        context: { sessionId: session.id, changesetId: changeset.id },
      });

      const append = (messages: unknown[]) =>
        call(kernel, APPEND_SESSION_MESSAGES, { messages }, session.id);

      // Approving before the changeset is approved keeps the message and
      // says why the anchor didn't take.
      const early = json(
        await append([
          { role: "user", content: "add a page" },
          {
            role: "assistant",
            content: "Plan: add it",
            plan_for: changeset.id,
          },
          { role: "user", content: "looks right", approves: changeset.id },
        ]),
      );
      await kernel.changesets.approve(changeset.id);
      await kernel.changesets.startWork(changeset.id);
      const late = json(
        await append([
          { role: "user", content: "go", approves: changeset.id },
          {
            role: "assistant",
            content: "Added the page",
            turn_id: "turn-1",
            change_ids: [change.id, 999_999],
          },
        ]),
      );
      const ids = [
        ...(early.messageIds as number[]),
        ...(late.messageIds as number[]),
      ];
      assertEquals(ids.length, 5);
      assertEquals(early.warnings, [
        `approves ${changeset.id}: Changeset "${changeset.id}" status changed concurrently`,
      ]);
      assertEquals(late.warnings, ["change 999999: not found"]);

      const stored = await kernel.sessions.getMessages(session.id);
      assertEquals(stored.map((m) => m.content), [
        "add a page",
        "Plan: add it",
        "looks right",
        "go",
        "Added the page",
      ]);

      const linked = await kernel.changelog.get(change.id);
      assertEquals(linked?.workMessageId, ids[4]);
      const anchored = await kernel.changesets.get(changeset.id);
      assertEquals(anchored?.planMessageIds, [ids[1]]);
      assertEquals(anchored?.approvalMessageId, ids[3]);
      assertEquals(anchored?.workMessageIds, [ids[4]]);
    });
  },
});

Deno.test({
  ...testOpts,
  name: "link_session_message links a stored message to changes and changesets",
  fn: async () => {
    await withKernel(async (kernel) => {
      const session = await kernel.sessions.createSession("mcp client");
      const changeset = await kernel.changesets.create({
        sessionId: session.id,
        title: "Page",
        plan,
      });
      const change = await kernel.changelog.record({
        category: "handler",
        key: "page",
        action: "create",
        beforeSnapshot: null,
        afterSnapshot: { source: "x" },
        context: { sessionId: session.id, changesetId: changeset.id },
      });
      const [planMsg, approval, work, note] = json(
        await call(kernel, APPEND_SESSION_MESSAGES, {
          messages: [
            { role: "assistant", content: "Plan: add it" },
            { role: "user", content: "go" },
            { role: "assistant", content: "Added the page" },
            { role: "assistant", content: "Checked it" },
          ],
        }, session.id),
      ).messageIds as number[];
      const link = (args: Record<string, unknown>) =>
        call(kernel, LINK_SESSION_MESSAGE, args, session.id);

      const planned = json(
        await link({ message_id: planMsg, plan_for: changeset.id }),
      );
      assertEquals(
        (planned.changesets as Array<{ planMessageIds: number[] }>)[0]
          ?.planMessageIds,
        [planMsg],
      );
      await kernel.changesets.approve(changeset.id);
      await kernel.changesets.startWork(changeset.id);
      json(await link({ message_id: approval, approves: changeset.id }));
      const linked = json(
        await link({
          message_id: work,
          changes: [{
            id: change.id,
            rationale: "The user asked for it.",
            implementation: "A handler and a route.",
          }],
        }),
      );
      const changes = linked.changes as Array<Record<string, unknown>>;
      assertEquals(changes[0]?.workMessageId, work);
      assertEquals(changes[0]?.rationale, "The user asked for it.");
      json(await link({ message_id: note, work_for: changeset.id }));

      const anchored = await kernel.changesets.get(changeset.id);
      assertEquals(anchored?.planMessageIds, [planMsg]);
      assertEquals(anchored?.approvalMessageId, approval);
      assertEquals(anchored?.workMessageIds, [work, note]);
      const record = await kernel.changelog.get(change.id);
      assertEquals(record?.implementation, "A handler and a route.");
    });
  },
});

Deno.test({
  ...testOpts,
  name: "link_session_message refuses another session's message and bad input",
  fn: async () => {
    await withKernel(async (kernel) => {
      const mine = await kernel.sessions.createSession("mine");
      const theirs = await kernel.sessions.createSession("theirs");
      const [theirMessage] = json(
        await call(kernel, APPEND_SESSION_MESSAGES, {
          messages: [{ role: "user", content: "hi" }],
        }, theirs.id),
      ).messageIds as number[];
      assertStringIncludes(
        errorText(
          await call(
            kernel,
            LINK_SESSION_MESSAGE,
            { message_id: theirMessage, work_for: "cs_x" },
            mine.id,
          ),
        ),
        "MESSAGE_NOT_FOUND",
      );
      assertStringIncludes(
        errorText(
          await call(kernel, LINK_SESSION_MESSAGE, {
            message_id: theirMessage,
            changes: [{ id: "one" }],
          }, theirs.id),
        ),
        "changes[0].id must be an integer",
      );
    });
  },
});

Deno.test({
  ...testOpts,
  name: "append_session_messages refuses bad input and calls without a session",
  fn: async () => {
    await withKernel(async (kernel) => {
      const session = await kernel.sessions.createSession("mcp client");
      assertStringIncludes(
        errorText(
          await call(kernel, APPEND_SESSION_MESSAGES, {
            messages: [{ role: "user", content: "hi" }],
          }),
        ),
        "NO_SESSION",
      );
      const tooMany = Array.from(
        { length: MAX_APPENDED_MESSAGES + 1 },
        () => ({ role: "user", content: "x" }),
      );
      assertStringIncludes(
        errorText(
          await call(
            kernel,
            APPEND_SESSION_MESSAGES,
            { messages: tooMany },
            session.id,
          ),
        ),
        "at most",
      );
      assertEquals((await kernel.sessions.getMessages(session.id)).length, 0);
    });
  },
});

Deno.test({
  ...testOpts,
  name: "set_session_summary replaces the calling session's summary",
  fn: async () => {
    await withKernel(async (kernel) => {
      const session = await kernel.sessions.createSession("mcp client");
      json(
        await call(
          kernel,
          SET_SESSION_SUMMARY,
          { summary: "first" },
          session.id,
        ),
      );
      json(
        await call(
          kernel,
          SET_SESSION_SUMMARY,
          { summary: "Added notes." },
          session.id,
        ),
      );
      const updated = await kernel.sessions.getSession(session.id);
      assertEquals(updated?.summary, "Added notes.");
    });
  },
});

Deno.test({
  ...testOpts,
  name: "set_session_summary merges metadata and keeps the summary",
  fn: async () => {
    await withKernel(async (kernel) => {
      const session = await kernel.sessions.createSession("mcp client");
      await kernel.sessions.updateSummaryMetadata(
        session.id,
        "kept",
        JSON.stringify({ a: 1, b: 2 }),
      );
      json(
        await call(
          kernel,
          SET_SESSION_SUMMARY,
          { metadata: { b: null, c: 3 } },
          session.id,
        ),
      );
      const updated = await kernel.sessions.getSession(session.id);
      assertEquals(updated?.summary, "kept");
      assertEquals(JSON.parse(updated?.metadata ?? "null"), { a: 1, c: 3 });
      assertStringIncludes(
        errorText(await call(kernel, SET_SESSION_SUMMARY, {}, session.id)),
        "summary, metadata or both",
      );
    });
  },
});

Deno.test({
  ...testOpts,
  name: "open_session starts, resumes and reopens sessions, and binds them",
  fn: async () => {
    await withKernel(async (kernel) => {
      const binding = recordingBinding();
      const started = json(
        await call(
          kernel,
          OPEN_SESSION,
          {
            name: "chat",
            visibility: "private",
            owner: { id: "user-1", display_name: "Ada" },
          },
          undefined,
          binding,
        ),
      ).session as { id: string; visibility: string; ownerUserId: string };
      assertEquals(started.visibility, "private");
      assertEquals(started.ownerUserId, "user-1");

      const plain = json(
        await call(kernel, OPEN_SESSION, { name: "other" }, undefined, binding),
      ).session as { visibility: string };
      assertEquals(plain.visibility, "project");

      await kernel.sessions.endSession(started.id);
      const resumed = json(
        await call(
          kernel,
          OPEN_SESSION,
          { session_id: started.id },
          undefined,
          binding,
        ),
      ).session as { id: string; endedAt: string | null };
      assertEquals(resumed.id, started.id);
      assertEquals(resumed.endedAt, null);
      assertEquals(binding.bound.length, 3);
      assertEquals(binding.bound[2], started.id);

      assertStringIncludes(
        errorText(
          await call(
            kernel,
            OPEN_SESSION,
            { session_id: "nope" },
            undefined,
            binding,
          ),
        ),
        "SESSION_NOT_FOUND",
      );
      assertStringIncludes(
        errorText(await call(kernel, OPEN_SESSION, {})),
        "NO_CONNECTION",
      );
    });
  },
});

Deno.test({
  ...testOpts,
  name: "append_session_messages keeps tool calls and the author",
  fn: async () => {
    await withKernel(async (kernel) => {
      const session = await kernel.sessions.createSession("mcp client");
      json(
        await call(kernel, APPEND_SESSION_MESSAGES, {
          messages: [
            { role: "user", content: "hi", author_user_id: "user-1" },
            {
              role: "assistant",
              content: "listed",
              tool_calls: [{ name: "list_routes", input: {}, result: [] }],
            },
          ],
        }, session.id),
      );
      const [user, assistant] = await kernel.sessions.getMessages(session.id);
      assertEquals(user?.authorUserId, "user-1");
      assertEquals(JSON.parse(assistant?.toolCalls ?? "null"), [
        { name: "list_routes", input: {}, result: [] },
      ]);
    });
  },
});

Deno.test({
  ...testOpts,
  name: "turnContextFrom reads the turn from a call's _meta",
  fn: () => {
    assertEquals(
      turnContextFrom({
        [MCP_TURN_META_KEY]: {
          turn_id: "turn-1",
          turn_index: 2,
          tool_call_id: "tc-1",
          user_message: "add a page",
        },
      }),
      {
        turnId: "turn-1",
        turnIndex: 2,
        toolCallId: "tc-1",
        userMessage: "add a page",
      },
    );
    assertEquals(
      turnContextFrom({ [MCP_TURN_META_KEY]: { turn_index: 1 } }),
      {},
    );
    assertEquals(turnContextFrom(undefined), {});
  },
});

Deno.test({
  ...testOpts,
  name:
    "over a connection, open_session moves later calls and _meta stamps the turn",
  fn: async () => {
    await initCompiler();
    try {
      await withKernel(async (kernel) => {
        const server = createMcpServer({ kernel, rebuild: noop });
        const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
        const client = new Client({ name: "history-test", version: "0.0.0" });
        await Promise.all([
          server.connect(serverSide),
          client.connect(clientSide),
        ]);
        try {
          const opened = await client.callTool({
            name: OPEN_SESSION,
            arguments: { name: "bound" },
          });
          const sessionId = (JSON.parse(
            (opened.content as Array<{ text: string }>)[0]!.text,
          ) as { session: { id: string } }).session.id;
          // open_session didn't start a session of its own first.
          assertEquals((await kernel.sessions.listSessions(10)).length, 1);

          await client.callTool({
            name: "create_changeset",
            arguments: { title: "Bound", plan },
          });
          await client.callTool({
            name: "define_handler",
            arguments: {
              name: "bound",
              source:
                `async function bound(c: any) { return c.json({ ok: true }); }`,
            },
            _meta: {
              [MCP_TURN_META_KEY]: {
                turn_id: "turn-7",
                turn_index: 0,
                tool_call_id: "tc-7",
                user_message: "add a handler",
              },
            },
          });
          const [change] = await kernel.changelog.list({ limit: 1 });
          assertEquals(change?.context?.sessionId, sessionId);
          assertEquals(change?.context?.turnId, "turn-7");
          assertEquals(change?.context?.toolCallId, "tc-7");
          assertEquals(change?.context?.userMessage, "add a handler");
        } finally {
          await client.close();
          await server.close();
        }
      });
    } finally {
      stopCompiler();
    }
  },
});

Deno.test({
  ...testOpts,
  name: "record_usage writes the ledger, and a turn's calls add up",
  fn: async () => {
    await withKernel(async (kernel) => {
      const session = await kernel.sessions.createSession("mcp client");
      const base = {
        model: "claude-sonnet-5-5",
        started_at: "2026-10-27T10:00:00.000Z",
        ended_at: "2026-10-27T10:00:05.000Z",
        input_tokens: 100,
        output_tokens: 20,
        turn_id: "turn-1",
      };
      const first = json(await call(kernel, RECORD_USAGE, base, session.id));
      const record = await kernel.sessions.getModelUsage(
        first.usageId as string,
      );
      assertEquals(record?.sessionId, session.id);
      assertEquals(record?.caller, "mcp_client");

      json(
        await call(kernel, RECORD_USAGE, {
          ...base,
          cache_read_tokens: 50,
          tool_calls: 3,
        }, session.id),
      );
      const second = json(
        await call(kernel, RECORD_USAGE, { ...base, id: "u-2" }, session.id),
      );
      assertEquals(second.usageId, "u-2");
      const turn = second.turn as { inputTokens: number };
      assertEquals(turn.inputTokens, 300);
      assertEquals(
        (await kernel.sessions.getTurnUsage("turn-1"))?.cacheReadInputTokens,
        50,
      );

      assertStringIncludes(
        errorText(
          await call(kernel, RECORD_USAGE, {
            ...base,
            input_tokens: -1,
          }, session.id),
        ),
        "non-negative",
      );
    });
  },
});

Deno.test({
  ...testOpts,
  name: "reads leave no session behind; the first write starts one",
  fn: async () => {
    await initCompiler();
    try {
      await withKernel(async (kernel) => {
        const server = createMcpServer({ kernel, rebuild: noop });
        const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
        const client = new Client({ name: "reader", version: "0.0.0" });
        await Promise.all([
          server.connect(serverSide),
          client.connect(clientSide),
        ]);
        try {
          await client.callTool({ name: "project_status", arguments: {} });
          await client.callTool({
            name: "get_session_context",
            arguments: { session_id: "session_missing" },
          });
          await client.callTool({
            name: "manage_sessions",
            arguments: { action: "list" },
          });
          await client.callTool({
            name: "list_current_project_pins",
            arguments: {},
          });
          assertEquals(await kernel.sessions.listSessions(10), []);

          await client.callTool({
            name: "create_changeset",
            arguments: { title: "Write", plan },
          });
          const sessions = await kernel.sessions.listSessions(10);
          assertEquals(sessions.length, 1);
          assertStringIncludes(sessions[0]!.name, "reader (MCP)");
        } finally {
          await client.close();
        }
      });
    } finally {
      stopCompiler();
    }
  },
});
