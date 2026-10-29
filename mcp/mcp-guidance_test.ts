// What the MCP face TELLS a headless agent: refusals that name the next call
// instead of "wait for the user", amendments that do not strand the changeset,
// the server instructions, the prompts, and billed-tool marking. Behaviour that
// only exists to steer an external agent lives here; the wire mechanics of the
// surface stay in mcp-projection_test.ts.
import {
  assert,
  assertEquals,
  assertFalse,
  assertStringIncludes,
} from "@std/assert";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Kernel } from "../core/registries.ts";
import { Database } from "../core/db.ts";
import type { ChangeContext } from "../core/changelog.ts";
import { dispatchTool } from "../core/tools/dispatch.ts";
import { dispatchMcpTool, projectedMcpTools } from "./mcp-projection.ts";
import { unadvertisedToolMentions } from "./test-guidance.ts";
import {
  CUSTOM_INSTRUCTIONS_CONFIG,
  generalGuide,
  INSTRUCTIONS_MAX_CHARS,
} from "../core/agent-guide.ts";
import { getProjectPaths } from "../core/project-manager.ts";
import { join } from "node:path";
import { createMcpServer, type McpServerDeps } from "./mcp-server.ts";
import { testComposition } from "../cli/test-composition.ts";

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

function mcpContext(sessionId: string): ChangeContext {
  return { sessionId, userMessage: "External MCP agent" };
}

async function connectMcpClient(
  deps: McpServerDeps,
): Promise<{ client: Client; dispose: () => Promise<void> }> {
  const server = createMcpServer(deps);
  const [clientTransport, serverTransport] = InMemoryTransport
    .createLinkedPair();
  const client = new Client({ name: "mcp-test-client", version: "0.0.0" });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return {
    client,
    dispose: async () => {
      await client.close();
      await server.close();
    },
  };
}

function text(result: { content: unknown }): string {
  return (result.content as Array<{ type: string; text?: string }>)
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("\n");
}

const ORPHAN_HANDLER = {
  name: "orphan",
  source: `async function orphan(c: any) { return c.json({}); }`,
};

function lightPlan() {
  return {
    summary: "Tweak a label",
    steps: ["Edit the label"],
  };
}

// --- Stage 1: refusals that name the next call ---

Deno.test({
  ...testOpts,
  name: "MCP: CHANGESET_REQUIRED names create_changeset and never says wait",
  fn: async () => {
    await withKernel(async (kernel) => {
      const result = await dispatchMcpTool(
        "define_handler",
        ORPHAN_HANDLER,
        kernel,
        noop,
        mcpContext("mcp:no-changeset"),
      );
      assertEquals(result.isError, true);
      const body = text(result);
      assertStringIncludes(body, "CHANGESET_REQUIRED");
      assertStringIncludes(body, "create_changeset");
      assertFalse(/wait|STOP|user/i.test(body), body);
    });
  },
});

Deno.test({
  ...testOpts,
  name: "IDE: core CHANGESET_REQUIRED text is unchanged by the MCP overlay",
  fn: async () => {
    await withKernel(async (kernel) => {
      const result = await dispatchTool(
        "define_handler",
        ORPHAN_HANDLER,
        kernel,
        noop,
        { sessionId: "ide-session", userMessage: "ide" },
      );
      assertFalse(result.ok);
      assertStringIncludes(result.error?.suggestion ?? "", "wait for the user");
    });
  },
});

Deno.test({
  ...testOpts,
  name:
    "MCP: CHANGE_CLASS_EXCEEDED says amend, then retry — and amend unblocks it",
  fn: async () => {
    await withKernel(async (kernel) => {
      const sessionId = "mcp:light-lane";
      const created = await dispatchMcpTool(
        "create_changeset",
        { title: "Light", plan: lightPlan(), change_class: "light" },
        kernel,
        noop,
        mcpContext(sessionId),
      );
      assertEquals(created.isError, undefined, text(created));
      const changeset = JSON.parse(
        (created.content[1] as { text: string }).text,
      ) as { id: string };

      // A schema is outside the light lane.
      const refused = await dispatchMcpTool(
        "define_schema",
        {
          tableName: "widgets",
          sql: "CREATE TABLE widgets (id SERIAL PRIMARY KEY)",
        },
        kernel,
        noop,
        mcpContext(sessionId),
      );
      assertEquals(refused.isError, true);
      const body = text(refused);
      assertStringIncludes(body, "CHANGE_CLASS_EXCEEDED");
      assertStringIncludes(body, "amend_changeset_plan");
      assertFalse(/STOP|user must approve/i.test(body), body);

      const amended = await dispatchMcpTool(
        "amend_changeset_plan",
        {
          changeset_id: changeset.id,
          summary_addendum: "Needs a widgets table after all.",
          steps: ["Add the widgets table"],
        },
        kernel,
        noop,
        mcpContext(sessionId),
      );
      assertEquals(amended.isError, undefined, text(amended));
      assertStringIncludes(text(amended), "amended, auto-approved and started");
      const after = await kernel.changesets.get(changeset.id);
      assertEquals(after?.status, "in_progress");
      assertEquals(after?.plan.changeClass?.effective, "standard");

      const retried = await dispatchMcpTool(
        "define_schema",
        {
          tableName: "widgets",
          sql: "CREATE TABLE widgets (id SERIAL PRIMARY KEY)",
        },
        kernel,
        noop,
        mcpContext(sessionId),
      );
      assertEquals(retried.isError, undefined, text(retried));
    });
  },
});

Deno.test({
  ...testOpts,
  name: "MCP: amend_changeset_plan description promises auto re-approval",
  fn: async () => {
    await withKernel(async (kernel) => {
      const { client, dispose } = await connectMcpClient({
        kernel,
        rebuild: noop,
      });
      try {
        const { tools } = await client.listTools();
        const amend = (tools as Array<{ name: string; description?: string }>)
          .find((t) => t.name === "amend_changeset_plan");
        assert(amend);
        assertStringIncludes(amend.description ?? "", "automatically");
      } finally {
        await dispose();
      }
    });
  },
});

// --- Stage 3: server instructions ---

async function instructionsFor(kernel: Kernel): Promise<string> {
  const { client, dispose } = await connectMcpClient({ kernel, rebuild: noop });
  try {
    return client.getInstructions() ?? "";
  } finally {
    await dispose();
  }
}

Deno.test({
  ...testOpts,
  name:
    "MCP: instructions carry the ownership and work-loop rules, no cost rules",
  fn: async () => {
    await withKernel(async (kernel) => {
      const text = await instructionsFor(kernel);
      assertStringIncludes(text, ".opentide/state");
      assertStringIncludes(text, "project_status");
      assertStringIncludes(text, "create_changeset");
      // Nothing on the open surface bills, so there is no cost section; the
      // Tide assembly's is checked in tide/mcp-guidance_test.ts.
      assertFalse(text.includes("refute_claims"));
      assert(
        text.length <= INSTRUCTIONS_MAX_CHARS,
        `instructions are ${text.length} characters; Claude Code cuts at ${INSTRUCTIONS_MAX_CHARS}`,
      );
      assertFalse(text.includes("This project"));
    });
  },
});

Deno.test({
  ...testOpts,
  name: "MCP: project rules are appended when they fit, pointed at when not",
  fn: async () => {
    await withKernel(async (kernel) => {
      kernel.configs.set(CUSTOM_INSTRUCTIONS_CONFIG, "Run testZ last.");
      const short = await instructionsFor(kernel);
      assertStringIncludes(short, "This project\n\nRun testZ last.");

      kernel.configs.set(CUSTOM_INSTRUCTIONS_CONFIG, "x".repeat(3000));
      const long = await instructionsFor(kernel);
      assert(long.length <= INSTRUCTIONS_MAX_CHARS);
      assertStringIncludes(long, "projectRules");

      const status = await dispatchMcpTool(
        "project_status",
        {},
        kernel,
        noop,
        mcpContext("mcp:rules"),
      );
      const data = JSON.parse(text(status)) as { projectRules: string };
      assertEquals(data.projectRules.length, 3000);
    });
  },
});

Deno.test({
  ...testOpts,
  name: "MCP: project_status returns the enabled skills",
  fn: async () => {
    await withKernel(async (kernel) => {
      await kernel.skills.create("tone", "House voice", "Write plainly.");
      const off = await kernel.skills.create("old", "Retired", "Ignore me.");
      await kernel.skills.update(off.id, { enabled: false });
      const status = await dispatchMcpTool(
        "project_status",
        {},
        kernel,
        noop,
        mcpContext("mcp:skills"),
      );
      const data = JSON.parse(text(status)) as {
        skills: Array<{ name: string; description: string; prompt: string }>;
      };
      assertEquals(data.skills, [{
        name: "tone",
        description: "House voice",
        prompt: "Write plainly.",
      }]);
    });
  },
});

// Every snake_case word in the guidance is either a real tool or a known
// argument/placeholder — so renaming a verb cannot leave the guidance pointing
// at a tool that no longer exists. The Tide assembly is held to the same rule in
// tide/mcp-guidance_test.ts.
Deno.test({
  ...testOpts,
  name: "MCP: every tool the instructions and prompts name is advertised",
  fn: () => {
    assertEquals(unadvertisedToolMentions(testComposition()), []);
  },
});

// --- Stage 4: project_status ---

Deno.test({
  ...testOpts,
  name: "MCP: project_status on a clean kernel is ok and reports the surface",
  fn: async () => {
    await withKernel(async (kernel) => {
      const result = await dispatchMcpTool(
        "project_status",
        {},
        kernel,
        noop,
        mcpContext("mcp:status"),
      );
      assertEquals(result.isError, undefined, text(result));
      const data = JSON.parse(text(result)) as {
        verdict: string;
        problems: string[];
        activeChangeset: unknown;
        surface: { version: string; fingerprint: string; toolCount: number };
      };
      assertEquals(data.verdict, "ok", data.problems.join("\n"));
      assertEquals(data.activeChangeset, null);
      assertEquals(
        data.surface.toolCount,
        projectedMcpTools(testComposition()).length,
      );
      assert(data.surface.fingerprint);
    });
  },
});

Deno.test({
  ...testOpts,
  name: "MCP: project_status reports the active changeset and its steps",
  fn: async () => {
    await withKernel(async (kernel) => {
      const sessionId = "mcp:status-active";
      const created = await dispatchMcpTool(
        "create_changeset",
        {
          title: "Two steps",
          plan: { summary: "s", steps: ["one", "two"] },
          change_class: "light",
        },
        kernel,
        noop,
        mcpContext(sessionId),
      );
      const changeset = JSON.parse(
        (created.content[1] as { text: string }).text,
      ) as { id: string; plan: { steps: Array<{ id: string }> } };
      await dispatchMcpTool(
        "update_changeset_step",
        {
          changeset_id: changeset.id,
          step_id: changeset.plan.steps[0]!.id,
          status: "done",
        },
        kernel,
        noop,
        mcpContext(sessionId),
      );
      const result = await dispatchMcpTool(
        "project_status",
        {},
        kernel,
        noop,
        mcpContext(sessionId),
      );
      const data = JSON.parse(text(result)) as {
        activeChangeset: { id: string; steps: { done: number; total: number } };
        next: string;
      };
      assertEquals(data.activeChangeset.id, changeset.id);
      assertEquals(data.activeChangeset.steps, { done: 1, total: 2 });
      assertStringIncludes(data.next, changeset.id);
    });
  },
});

Deno.test({
  ...testOpts,
  name: "MCP: project_status says stop on a consistency error",
  fn: async () => {
    await withKernel(async (kernel) => {
      const dir = await Deno.makeTempDir({ prefix: "opentide-status-" });
      try {
        const { stateDir } = getProjectPaths(dir);
        await Deno.mkdir(stateDir, { recursive: true });
        await Deno.writeTextFile(join(stateDir, "routes.json"), "{broken");
        kernel.projectDir = dir;
        const result = await dispatchMcpTool(
          "project_status",
          {},
          kernel,
          noop,
          mcpContext("mcp:status-stop"),
        );
        const data = JSON.parse(text(result)) as {
          verdict: string;
          problems: string[];
          next: string;
        };
        assertEquals(data.verdict, "stop");
        assert(data.problems.some((p) => p.startsWith("Consistency error")));
        assertStringIncludes(data.next, "change nothing");
      } finally {
        kernel.projectDir = null;
        await Deno.remove(dir, { recursive: true });
      }
    });
  },
});

// --- Stage 5: what costs money ---

// The open assembly has no audit provider and no agent, so nothing it
// advertises can reach a model: no description may claim to bill and the guide
// carries no cost section. The Tide side (every billed verb marked) is in
// tide/mcp-guidance_test.ts.
Deno.test({
  ...testOpts,
  name: "MCP: the open surface claims no billing anywhere",
  fn: () => {
    for (const tool of projectedMcpTools(testComposition())) {
      assertFalse(
        tool.description.includes("BILLS"),
        `${tool.name} runs no model on the server, so must not say it bills`,
      );
    }
    assertFalse(generalGuide().includes("bill"));
  },
});

Deno.test({
  ...testOpts,
  name: "MCP: a must criterion gets a billing warning at create time",
  fn: async () => {
    await withKernel(async (kernel) => {
      const created = await dispatchMcpTool(
        "create_changeset",
        {
          title: "Must",
          plan: {
            summary: "s",
            steps: [],
            acceptanceCriteria: [
              { id: "claim_hard", text: "x", priority: "must" },
              { id: "claim_soft", text: "y", priority: "should" },
            ],
            verificationPlan: [{
              id: "check_both",
              claimIds: ["claim_hard", "claim_soft"],
              kind: "unit",
              description: "d",
            }],
          },
        },
        kernel,
        noop,
        mcpContext("mcp:must"),
      );
      const body = text(created);
      assertStringIncludes(body, 'claim_hard is priority "must"');
      assertFalse(body.includes("claim_soft is"));
    });
  },
});

// --- Stage 2 over the wire ---

Deno.test({
  ...testOpts,
  name: "MCP: a wrong argument name is refused with the right one",
  fn: async () => {
    await withKernel(async (kernel) => {
      const result = await dispatchMcpTool(
        "query_database",
        { query: "select 1" },
        kernel,
        noop,
        mcpContext("mcp:args"),
      );
      assertEquals(result.isError, true);
      assertStringIncludes(text(result), "INVALID_ARGUMENTS");
      assertStringIncludes(text(result), "did you mean `sql`");
    });
  },
});

Deno.test({
  ...testOpts,
  name: "MCP: a camelCase changeset id is accepted, not refused",
  fn: async () => {
    await withKernel(async (kernel) => {
      const result = await dispatchMcpTool(
        "check_changeset_readiness",
        { changesetId: "cs_missing" },
        kernel,
        noop,
        mcpContext("mcp:camel"),
      );
      assertFalse(text(result).includes("INVALID_ARGUMENTS"), text(result));
      assertFalse(text(result).includes('"undefined"'), text(result));
    });
  },
});

// --- Stage 6: prompts ---

Deno.test({
  ...testOpts,
  name: "MCP: prompts are listed and render with their arguments",
  fn: async () => {
    await withKernel(async (kernel) => {
      const { client, dispose } = await connectMcpClient({
        kernel,
        rebuild: noop,
      });
      try {
        const { prompts } = await client.listPrompts();
        assertEquals(
          (prompts as Array<{ name: string }>).map((p) => p.name),
          ["start", "change", "land", "recover"],
        );
        const change = await client.getPrompt({
          name: "change",
          arguments: { goal: "add a dark mode toggle" },
        });
        const first = change.messages[0] as {
          content: { type: string; text: string };
        };
        assertStringIncludes(first.content.text, "add a dark mode toggle");
        assertStringIncludes(first.content.text, '"priority": "should"');
      } finally {
        await dispose();
      }
    });
  },
});
