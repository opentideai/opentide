import { assert, assertEquals } from "@std/assert";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { Kernel } from "../core/registries.ts";
import { Database } from "../core/db.ts";
import { AGENT_TOOLS } from "../core/tools/definitions.ts";
import {
  CORE_ONLY,
  TOOLSET_NAMES,
  toolsetOf,
  TOOLSETS,
} from "../core/tools/toolsets.ts";
import { testComposition } from "../cli/test-composition.ts";
import { createMcpServer } from "./mcp-server.ts";
import { MCP_ONLY_TOOLS, projectedMcpTools } from "./mcp-projection.ts";

const testOpts = { sanitizeResources: false, sanitizeOps: false };

Deno.test("every verb an agent can be offered is in a toolset", () => {
  const offered = [...AGENT_TOOLS.map((t) => t.name), ...MCP_ONLY_TOOLS];
  assertEquals(offered.filter((name) => toolsetOf(name) === null), []);
});

Deno.test("every name in a toolset is a verb an agent can be offered", () => {
  const offered = new Set([
    ...AGENT_TOOLS.map((t) => t.name),
    ...MCP_ONLY_TOOLS,
  ]);
  const named = TOOLSET_NAMES.flatMap((s) => [...TOOLSETS[s]]);
  assertEquals(named.filter((name) => !offered.has(name)), []);
});

Deno.test("core lists project_status first and nothing outside core", () => {
  const tools = projectedMcpTools(testComposition(), CORE_ONLY);
  assertEquals(tools[0]?.name, "project_status");
  assertEquals(tools.filter((t) => toolsetOf(t.name) !== "core"), []);
});

interface Connected {
  client: Client;
  listChanged: () => number;
  dispose: () => Promise<void>;
}

async function connect(toolsets: string | null): Promise<Connected> {
  const db = await Database.create({ driver: "pglite" });
  const kernel = new Kernel(db, { composition: testComposition() });
  const server = createMcpServer(
    { kernel, rebuild: () => {} },
    "stdio",
    toolsets,
  );
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "toolsets-test", version: "0.0.0" });
  let changes = 0;
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
    changes++;
  });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return {
    client,
    listChanged: () => changes,
    dispose: async () => {
      await client.close();
      await server.close();
      await db.close();
    },
  };
}

async function listed(client: Client): Promise<Set<string>> {
  return new Set(
    (await client.listTools()).tools.map((t: { name: string }) => t.name),
  );
}

function text(result: unknown): string {
  return (result as { content: Array<{ type: string; text?: string }> })
    .content.map((b) => b.text ?? "").join("\n");
}

// The notification is sent after the call's answer; give it a turn to land.
const settle = () => new Promise((r) => setTimeout(r, 10));

Deno.test({
  ...testOpts,
  name: "a connection that selects nothing lists core and refuses the rest",
  fn: async () => {
    const { client, dispose } = await connect(null);
    try {
      const names = await listed(client);
      assert(names.has("create_changeset"));
      assert(names.has("set_toolset"));
      assert(!names.has("git_push"));
      const refused = await client.callTool({
        name: "git_push",
        arguments: {},
      });
      assert(refused.isError);
      assert(text(refused).startsWith("Error [TOOLSET_OFF]: git_push"));
    } finally {
      await dispose();
    }
  },
});

Deno.test({
  ...testOpts,
  name: "a connection that asks for toolsets lists them",
  fn: async () => {
    const { client, dispose } = await connect("git,docs");
    try {
      const names = await listed(client);
      assert(names.has("git_push"));
      assert(names.has("document_write"));
      assert(!names.has("start_task"));
    } finally {
      await dispose();
    }
  },
});

Deno.test({
  ...testOpts,
  name: "set_toolset turns a toolset on and off and says the list changed",
  fn: async () => {
    const { client, listChanged, dispose } = await connect(null);
    try {
      const on = await client.callTool({
        name: "set_toolset",
        arguments: { toolset: "git", enabled: true },
      });
      assert(!on.isError, text(on));
      assertEquals(JSON.parse(text(on)), {
        toolsets: ["core", "git"],
        changed: true,
      });
      await settle();
      assertEquals(listChanged(), 1);
      assert((await listed(client)).has("git_status"));

      const again = await client.callTool({
        name: "set_toolset",
        arguments: { toolset: "git", enabled: true },
      });
      assertEquals(JSON.parse(text(again)).changed, false);
      await settle();
      assertEquals(listChanged(), 1);

      await client.callTool({
        name: "set_toolset",
        arguments: { toolset: "git", enabled: false },
      });
      await settle();
      assertEquals(listChanged(), 2);
      assert(!(await listed(client)).has("git_status"));
    } finally {
      await dispose();
    }
  },
});

Deno.test({
  ...testOpts,
  name: "set_toolset refuses core and names that aren't toolsets",
  fn: async () => {
    const { client, dispose } = await connect(null);
    try {
      const core = await client.callTool({
        name: "set_toolset",
        arguments: { toolset: "core", enabled: false },
      });
      assert(core.isError);
      const unknown = await client.callTool({
        name: "set_toolset",
        arguments: { toolset: "gti", enabled: true },
      });
      assert(unknown.isError);
    } finally {
      await dispose();
    }
  },
});

Deno.test({
  ...testOpts,
  name: "the instructions mention session tools only when sessions is on",
  fn: async () => {
    const without = await connect(null);
    const withSessions = await connect("sessions");
    try {
      assert(
        !without.client.getInstructions()?.includes("set_session_summary"),
      );
      assert(
        withSessions.client.getInstructions()?.includes("set_session_summary"),
      );
    } finally {
      await without.dispose();
      await withSessions.dispose();
    }
  },
});
