import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { checkChangesetReadiness } from "../../verification/changesets.ts";
import { testComposition } from "../../cli/test-composition.ts";
import { verificationOnlyComposition } from "../../cli/assembly.ts";
import type { CompositionContext } from "../../core/composition.ts";
import {
  APP_AUTH_GATE_CONFIG,
  setKernelSettings,
  setRecommendedModels,
} from "../config.ts";
import { setUtilityModelCallForTest } from "../utility-model.ts";
import { decodeBase64, encodeBase64 } from "../util.ts";
import {
  ATTACHMENT_DOCUMENT_SOURCE,
  type DocumentRecord,
} from "../documents.ts";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { findDeadCode } from "../analysis.ts";
import { Kernel } from "../registries.ts";
import { Database } from "../db.ts";
import {
  captureAttestationEvidenceDocument,
  captureRunEvidenceDocument,
  captureRunEvidenceDocuments,
  dispatchTool,
  isMutationTool,
  MODIFICATION_TOOLS,
  READ_ONLY_TOOLS,
  runEvidenceLedgerKey,
  runKernelTests,
} from "./dispatch.ts";
import {
  EVIDENCE_DOCUMENT_SOURCE,
  RUN_EVIDENCE_DOCUMENT_SOURCE,
} from "../documents.ts";
import { blastRadiusReport, buildKnowledgeGraph } from "../knowledge-graph.ts";
import { mcpSessionMetadata } from "../session-liveness.ts";
import { initCompiler, stopCompiler } from "../compiler.ts";
import { AssertionError } from "../types.ts";
import { AGENT_TOOLS, CUSTOM_TOOLS } from "./definitions.ts";
import {
  IMPORT_CLASSIFIER_PLUGIN_ID,
  type ImportClassifierRequest,
} from "../codebase/index.ts";
import { TEST_TMP_DIR } from "../test-home_test.ts";

const testOpts = { sanitizeResources: false, sanitizeOps: false };

async function withKernel<T>(
  fn: (kernel: Kernel) => Promise<T>,
  composition: CompositionContext = testComposition(),
): Promise<T> {
  await initCompiler();
  const db = await Database.create({ driver: "pglite" });
  const kernel = new Kernel(db, { composition });
  try {
    return await fn(kernel);
  } finally {
    await db.close();
    stopCompiler();
  }
}

const noop = () => {};

function registryEntityCounts(kernel: Kernel): Record<string, number> {
  return {
    routes: kernel.routes.list().length,
    handlers: kernel.handlers.list().length,
    functions: kernel.functions.list().length,
    tests: kernel.tests.list().length,
    configs: kernel.configs.list().length,
    templates: kernel.templates.list().length,
    assets: kernel.assets.list().length,
    packages: kernel.packages.list().length,
    env: kernel.env.list().length,
    secrets: kernel.secrets.list().length,
    devViews: kernel.devViews.list().length,
    devTools: kernel.devTools.list().length,
    customAudits: kernel.customAudits.list().length,
    types: kernel.types.list().length,
  };
}

async function writeTinySourceProject(root: string): Promise<void> {
  await Deno.writeTextFile(
    join(root, "package.json"),
    JSON.stringify({
      scripts: { test: "vitest" },
      dependencies: { express: "^5.0.0" },
    }),
  );
  await Deno.writeTextFile(join(root, "package-lock.json"), "{}");
  await Deno.mkdir(join(root, "src"));
  await Deno.writeTextFile(
    join(root, "src", "index.ts"),
    "export const value = 1;",
  );
}

function seedModelCache(home: string, model: string, provider: string): void {
  const dir = join(home, ".config", "opentide");
  Deno.mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "models-cache.json"),
    JSON.stringify({
      models: [{ id: model, label: model, provider }],
      cachedAt: new Date().toISOString(),
    }),
  );
}

function runGit(projectDir: string, args: string[]): void {
  const result = new Deno.Command("git", {
    args,
    cwd: projectDir,
    stdout: "null",
    stderr: "piped",
  }).outputSync();
  if (!result.success) {
    throw new Error(new TextDecoder().decode(result.stderr));
  }
}

async function withTempHomeAndProviderEnv(
  opts: { anthropic?: string; openai?: string },
  fn: () => Promise<void>,
): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "genie-dispatch-test-"));
  const oldHome = Deno.env.get("HOME");
  const oldAnthropic = Deno.env.get("ANTHROPIC_API_KEY");
  const oldOpenai = Deno.env.get("OPENAI_API_KEY");
  try {
    Deno.env.set("HOME", home);
    if (opts.anthropic === undefined) Deno.env.delete("ANTHROPIC_API_KEY");
    else Deno.env.set("ANTHROPIC_API_KEY", opts.anthropic);
    if (opts.openai === undefined) Deno.env.delete("OPENAI_API_KEY");
    else Deno.env.set("OPENAI_API_KEY", opts.openai);
    await fn();
  } finally {
    if (oldHome === undefined) Deno.env.delete("HOME");
    else Deno.env.set("HOME", oldHome);
    if (oldAnthropic === undefined) Deno.env.delete("ANTHROPIC_API_KEY");
    else Deno.env.set("ANTHROPIC_API_KEY", oldAnthropic);
    if (oldOpenai === undefined) Deno.env.delete("OPENAI_API_KEY");
    else Deno.env.set("OPENAI_API_KEY", oldOpenai);
    rmSync(home, { recursive: true, force: true });
  }
}

const REGISTER_LIST_ITEMS = (kernel: Kernel) =>
  kernel.handlers.register(
    "listItems",
    "async function listItems(c: Context) { return c.json({ items: [] }); }",
    () => new Response("ok"),
    undefined,
    "items",
    undefined,
    "typescript",
    "List items.",
  );

Deno.test({
  ...testOpts,
  name: "list_handlers summarizes handlers without their source",
  fn: async () => {
    await withKernel(async (kernel) => {
      REGISTER_LIST_ITEMS(kernel);

      const result = await dispatchTool("list_handlers", {}, kernel, noop);

      assertEquals(result.ok, true);
      const handlers = result.data as Array<{
        name: string;
        source?: string;
        module?: string;
        language?: string;
        purpose?: string;
        hasSchema?: boolean;
        sourceLines?: number;
      }>;
      assertEquals(handlers.length, 1);
      assertEquals(handlers[0]?.name, "listItems");
      assertEquals(handlers[0]?.source, undefined);
      assertEquals(handlers[0]?.sourceLines, 1);
      assertEquals(handlers[0]?.hasSchema, false);
      assertEquals(handlers[0]?.module, "items");
      assertEquals(handlers[0]?.language, "typescript");
      assertEquals(handlers[0]?.purpose, "List items.");
    });
  },
});

Deno.test({
  ...testOpts,
  name: "list_handlers({name}) returns one handler's source and metadata",
  fn: async () => {
    await withKernel(async (kernel) => {
      REGISTER_LIST_ITEMS(kernel);

      const result = await dispatchTool(
        "list_handlers",
        { name: "listItems" },
        kernel,
        noop,
      );

      assertEquals(result.ok, true);
      const handler = result.data as {
        name: string;
        source: string;
        module?: string;
        language?: string;
        purpose?: string;
      };
      assertEquals(handler.name, "listItems");
      assertStringIncludes(handler.source ?? "", "function listItems");
      assertEquals(handler.module, "items");
      assertEquals(handler.language, "typescript");
      assertEquals(handler.purpose, "List items.");

      const missing = await dispatchTool(
        "list_handlers",
        { name: "nope" },
        kernel,
        noop,
      );
      assertEquals(missing.ok, false);
      assertEquals(missing.error?.code, "NOT_FOUND");
    });
  },
});

Deno.test({
  ...testOpts,
  name: "list_functions summarizes functions; {name} returns one source",
  fn: async () => {
    await withKernel(async (kernel) => {
      kernel.functions.register(
        "slugify",
        "function slugify(s: string) {\n  return s.toLowerCase();\n}",
        (...args: unknown[]) => String(args[0]),
        "common",
        "string",
        undefined,
        undefined,
        "Slugify a string.",
      );

      const list = await dispatchTool("list_functions", {}, kernel, noop);
      assertEquals(list.ok, true);
      const fns = list.data as Array<{
        name: string;
        source?: string;
        returnType?: string;
        module?: string;
        purpose?: string;
        sourceLines?: number;
      }>;
      assertEquals(fns.length, 1);
      assertEquals(fns[0]?.name, "slugify");
      assertEquals(fns[0]?.source, undefined);
      assertEquals(fns[0]?.sourceLines, 3);
      assertEquals(fns[0]?.returnType, "string");
      assertEquals(fns[0]?.module, "common");
      assertEquals(fns[0]?.purpose, "Slugify a string.");

      const one = await dispatchTool(
        "list_functions",
        { name: "slugify" },
        kernel,
        noop,
      );
      assertEquals(one.ok, true);
      const fn = one.data as { name: string; source: string };
      assertEquals(fn.name, "slugify");
      assertStringIncludes(fn.source ?? "", "function slugify");

      const missing = await dispatchTool(
        "list_functions",
        { name: "nope" },
        kernel,
        noop,
      );
      assertEquals(missing.ok, false);
      assertEquals(missing.error?.code, "NOT_FOUND");
    });
  },
});

Deno.test({
  ...testOpts,
  name: "list_types summarizes types; {name} returns the full definition",
  fn: async () => {
    await withKernel(async (kernel) => {
      kernel.types.register(
        "Todo",
        [
          { name: "id", type: "string" },
          { name: "title", type: "string" },
        ],
        "A todo item.",
        "todos",
      );

      const list = await dispatchTool("list_types", {}, kernel, noop);
      assertEquals(list.ok, true);
      const types = list.data as Array<{
        name: string;
        description?: string;
        module?: string;
        fieldCount?: number;
        fields?: unknown[];
      }>;
      assertEquals(types.length, 1);
      assertEquals(types[0]?.name, "Todo");
      assertEquals(types[0]?.fields, undefined);
      assertEquals(types[0]?.fieldCount, 2);
      assertEquals(types[0]?.description, "A todo item.");
      assertEquals(types[0]?.module, "todos");

      const one = await dispatchTool(
        "list_types",
        { name: "Todo" },
        kernel,
        noop,
      );
      assertEquals(one.ok, true);
      const type = one.data as { name: string; fields: unknown[] };
      assertEquals(type.name, "Todo");
      assertEquals(type.fields.length, 2);

      const missing = await dispatchTool(
        "list_types",
        { name: "nope" },
        kernel,
        noop,
      );
      assertEquals(missing.ok, false);
      assertEquals(missing.error?.code, "NOT_FOUND");
    });
  },
});

Deno.test({
  ...testOpts,
  name: "doctor_project reports current project health",
  fn: async () => {
    await withKernel(async (kernel) => {
      const projectDir = await Deno.makeTempDir({
        dir: TEST_TMP_DIR,
        prefix: "tideide-dispatch-doctor-",
      });
      kernel.projectDir = projectDir;
      try {
        writeFileSync(
          join(projectDir, "opentide.json"),
          JSON.stringify({
            name: "Doctor",
            createdAt: "2026-01-01T00:00:00.000Z",
          }) + "\n",
        );
        const result = await dispatchTool("doctor_project", {}, kernel, noop);
        assertEquals(result.ok, true);
        const data = result.data as { ok: boolean; errors: unknown[] };
        assertEquals(data.ok, true);
        assertEquals(data.errors.length, 0);
      } finally {
        rmSync(projectDir, { recursive: true, force: true });
      }
    });
  },
});

Deno.test({
  ...testOpts,
  name: "data fixture tools export, reset, and import local rows",
  fn: async () => {
    await withKernel(async (kernel) => {
      const projectDir = await Deno.makeTempDir({
        dir: TEST_TMP_DIR,
        prefix: "tideide-dispatch-fixtures-",
      });
      kernel.projectDir = projectDir;
      try {
        await kernel.db.defineSchema(
          "items",
          "CREATE TABLE items (id SERIAL PRIMARY KEY, name TEXT NOT NULL)",
        );
        await kernel.db.execute("INSERT INTO items (name) VALUES ($1)", [
          "one",
        ]);

        const exported = await dispatchTool(
          "export_data",
          { name: "seed" },
          kernel,
          noop,
        );
        assertEquals(exported.ok, true);
        assertEquals(
          existsSync(join(projectDir, "fixtures", "seed", "items.json")),
          true,
        );

        const reset = await dispatchTool("reset_data", {}, kernel, noop);
        assertEquals(reset.ok, true);
        assertEquals(
          Number(
            (await kernel.db.query("SELECT COUNT(*) AS count FROM items"))[0]!
              .count,
          ),
          0,
        );

        const imported = await dispatchTool(
          "import_data",
          { name: "seed" },
          kernel,
          noop,
        );
        assertEquals(imported.ok, true);
        const rows = await kernel.db.query("SELECT name FROM items");
        assertEquals(rows[0]?.name, "one");
      } finally {
        rmSync(projectDir, { recursive: true, force: true });
      }
    });
  },
});

Deno.test({
  ...testOpts,
  name: "regression: set_env rejects missing key",
  fn: async () => {
    await withKernel(async (kernel) => {
      const result = await dispatchTool(
        "set_env",
        { value: "test" },
        kernel,
        noop,
      );
      assertEquals(result.ok, false);
      assertEquals(result.error?.code, "MISSING_KEY");
    });
  },
});

Deno.test({
  ...testOpts,
  name: "regression: get_env rejects missing key",
  fn: async () => {
    await withKernel(async (kernel) => {
      const result = await dispatchTool("get_env", {}, kernel, noop);
      assertEquals(result.ok, false);
      assertEquals(result.error?.code, "MISSING_KEY");
    });
  },
});

Deno.test({
  ...testOpts,
  name: "regression: delete_env rejects missing key",
  fn: async () => {
    await withKernel(async (kernel) => {
      const result = await dispatchTool("delete_env", {}, kernel, noop);
      assertEquals(result.ok, false);
      assertEquals(result.error?.code, "MISSING_KEY");
    });
  },
});

Deno.test({
  ...testOpts,
  name: "set_env accepts key parameter",
  fn: async () => {
    await withKernel(async (kernel) => {
      const result = await dispatchTool(
        "set_env",
        { key: "TEST_VAR", value: "hello" },
        kernel,
        noop,
      );
      assertEquals(result.ok, true);
    });
  },
});

Deno.test({
  ...testOpts,
  name: "set_env accepts name parameter as fallback",
  fn: async () => {
    await withKernel(async (kernel) => {
      const result = await dispatchTool(
        "set_env",
        { name: "LEGACY_VAR", value: "world" },
        kernel,
        noop,
      );
      assertEquals(result.ok, true);
    });
  },
});

Deno.test({
  ...testOpts,
  name: "set_config rejects non-JSON-serializable values",
  fn: async () => {
    await withKernel(async (kernel) => {
      const result = await dispatchTool(
        "set_config",
        { name: "BAD_CONFIG", value: { nested: undefined } },
        kernel,
        noop,
      );

      assertEquals(result.ok, false);
      assertEquals(result.error?.code, "INVALID_CONFIG_VALUE");
      assertStringIncludes(result.error?.message ?? "", "JSON-serializable");
    });
  },
});

Deno.test({
  ...testOpts,
  name: "summarize_session returns fresh cached summary for current session",
  fn: async () => {
    await withKernel(async (kernel) => {
      const session = await kernel.sessions.createSession("Summary Session");
      const msg = await kernel.sessions.addMessage({
        sessionId: session.id,
        role: "user",
        content: "Plan the next implementation step.",
      });
      await kernel.sessions.updateSummaryMetadata(
        session.id,
        "Cached handoff summary",
        JSON.stringify({
          summaryKind: "handoff",
          summarizedThroughMessageId: msg.id,
        }),
      );

      const result = await dispatchTool(
        "summarize_session",
        {},
        kernel,
        noop,
        { sessionId: session.id },
      );

      assertEquals(result.ok, true);
      const data = result.data as {
        summary: string;
        generatedBy: string;
        stored: boolean;
      };
      assertEquals(data.summary, "Cached handoff summary");
      assertEquals(data.generatedBy, "cached");
      assertEquals(data.stored, true);
    });
  },
});

Deno.test({
  ...testOpts,
  name: "summarize_session rejects when no session is available",
  fn: async () => {
    await withKernel(async (kernel) => {
      const result = await dispatchTool("summarize_session", {}, kernel, noop);
      assertEquals(result.ok, false);
      assertEquals(result.error?.code, "NO_SESSION");
      assertStringIncludes(result.error?.message ?? "", "No active session");
    });
  },
});

Deno.test({
  ...testOpts,
  name: "manage_sessions renames the current session by default",
  fn: async () => {
    await withKernel(async (kernel) => {
      const session = await kernel.sessions.createSession("Old Name");

      const result = await dispatchTool(
        "manage_sessions",
        { action: "rename", name: "Preview URL Sync" },
        kernel,
        noop,
        { sessionId: session.id },
      );

      assertEquals(result.ok, true);
      const updated = await kernel.sessions.getSession(session.id);
      assertEquals(updated?.name, "Preview URL Sync");
      assertEquals(
        (result.data as { sessionId?: string; name?: string }).sessionId,
        session.id,
      );
      assertEquals(
        (result.data as { sessionId?: string; name?: string }).name,
        "Preview URL Sync",
      );
    });
  },
});

Deno.test({
  ...testOpts,
  name: "manage_sessions searches, archives, and unarchives sessions",
  fn: async () => {
    await withKernel(async (kernel) => {
      const session = await kernel.sessions.createSession("Toolbar Regression");
      await kernel.sessions.addMessage({
        sessionId: session.id,
        role: "user",
        content: "The preview panel URL should follow client navigation.",
      });

      const search = await dispatchTool(
        "manage_sessions",
        { action: "search", query: "client navigation" },
        kernel,
        noop,
      );
      assertEquals(search.ok, true);
      const searchData = search.data as {
        sessions: Array<{ id: string; name: string }>;
      };
      assertEquals(searchData.sessions[0]?.id, session.id);

      const archive = await dispatchTool(
        "manage_sessions",
        { action: "archive", session_id: session.id },
        kernel,
        noop,
      );
      assertEquals(archive.ok, true);
      assertEquals(
        (await kernel.sessions.getSession(session.id))?.archived,
        true,
      );

      const unarchive = await dispatchTool(
        "manage_sessions",
        { action: "unarchive", session_id: session.id },
        kernel,
        noop,
      );
      assertEquals(unarchive.ok, true);
      assertEquals(
        (await kernel.sessions.getSession(session.id))?.archived,
        false,
      );
    });
  },
});

Deno.test({
  ...testOpts,
  name: "create_changeset associates the current session",
  fn: async () => {
    await withKernel(async (kernel) => {
      const session = await kernel.sessions.createSession("Approval Session");

      const result = await dispatchTool(
        "create_changeset",
        {
          title: "Fix approval flow",
          plan: {
            summary: "Keep the approved changeset attached to the session.",
            steps: ["Create the changeset"],
            acceptanceCriteria: [
              "The changeset is attached to the active session.",
            ],
            verificationPlan: [{
              id: "check_session",
              claimIds: ["claim_0"],
              kind: "unit",
              description: "Assert the created changeset session id.",
            }],
          },
        },
        kernel,
        noop,
        { sessionId: session.id },
      );

      assertEquals(result.ok, true);
      const cs = result.data as { id: string; sessionId: string | null };
      assertEquals(cs.sessionId, session.id);

      const active = await kernel.changesets.getActive(session.id);
      assertEquals(active?.id, cs.id);
    });
  },
});

const ONE_STEP_PLAN = {
  summary: "Add one thing.",
  steps: ["Do the thing"],
  acceptanceCriteria: ["The thing exists."],
  verificationPlan: [{
    id: "check_thing",
    claimIds: ["claim_0"],
    kind: "unit",
    description: "Assert the thing exists.",
  }],
};

Deno.test({
  ...testOpts,
  name: "a second session's create_changeset gets CHANGESET_ACTIVE",
  fn: async () => {
    await withKernel(async (kernel) => {
      const a = await kernel.sessions.createSession("Claude Code (MCP)");
      const b = await kernel.sessions.createSession("Codex (MCP)");
      const create = (sessionId: string) =>
        dispatchTool(
          "create_changeset",
          { title: `Work for ${sessionId}`, plan: ONE_STEP_PLAN },
          kernel,
          noop,
          { sessionId },
        );

      const held = await create(a.id);
      assertEquals(held.ok, true);
      const heldId = (held.data as { id: string }).id;

      const refused = await create(b.id);
      assertEquals(refused.ok, false);
      assertEquals(refused.error?.code, "CHANGESET_ACTIVE");
      assert(refused.error?.message.includes(heldId));
      assert(refused.error?.message.includes("Claude Code (MCP)"));
      // B's project_status says the project is taken, and by whom.
      const status = await dispatchTool(
        "project_status",
        {},
        kernel,
        noop,
        { sessionId: b.id },
      );
      const statusData = status.data as {
        activeChangeset: unknown;
        heldElsewhere: { id: string; session: string | null } | null;
        next: string;
      };
      assertEquals(statusData.activeChangeset, null);
      assertEquals(statusData.heldElsewhere?.id, heldId);
      assertEquals(statusData.heldElsewhere?.session, "Claude Code (MCP)");
      assert(statusData.next.includes("CHANGESET_ACTIVE"));

      // A's plan survives B's attempt; before, B's create abandoned it.
      assertEquals((await kernel.changesets.get(heldId))?.status, "planning");

      // B can't abandon A's changeset either; that is a person's call.
      const steal = await dispatchTool(
        "abandon_changeset",
        { changeset_id: heldId },
        kernel,
        noop,
        { sessionId: b.id },
      );
      assertEquals(steal.error?.code, "CHANGESET_NOT_OWNED");

      // B no longer sees A's changeset as its own.
      const readiness = await dispatchTool(
        "check_changeset_readiness",
        {},
        kernel,
        noop,
        { sessionId: b.id },
      );
      assertEquals(readiness.error?.code, "NO_ACTIVE_CHANGESET");

      const own = await dispatchTool(
        "abandon_changeset",
        { changeset_id: heldId },
        kernel,
        noop,
        { sessionId: a.id },
      );
      assertEquals(own.ok, true);
      assertEquals((await create(b.id)).ok, true);
    });
  },
});

Deno.test({
  ...testOpts,
  name:
    "amend_changeset_plan appends scope and blocks mutations until reapproval",
  fn: async () => {
    await withKernel(async (kernel) => {
      const session = await kernel.sessions.createSession("Amend Session");
      const create = await dispatchTool(
        "create_changeset",
        {
          title: "Build base flow",
          plan: {
            summary: "Build the approved base flow.",
            steps: ["Define the base type"],
            acceptanceCriteria: [{
              id: "claim_base",
              text: "The base flow is available.",
              source: "agent",
              priority: "must",
            }],
            verificationPlan: [{
              id: "check_base",
              claimIds: ["claim_base"],
              kind: "unit",
              description: "Run the base flow test.",
            }],
          },
        },
        kernel,
        noop,
        { sessionId: session.id },
      );
      assertEquals(create.ok, true);
      const cs = create.data as { id: string };
      await kernel.changesets.approve(cs.id);
      await kernel.changesets.startWork(cs.id);

      const context = { sessionId: session.id, changesetId: cs.id };
      const amended = await dispatchTool(
        "amend_changeset_plan",
        {
          changeset_id: cs.id,
          summary_addendum: "Also support the extra flow.",
          steps: ["Define the extra type"],
          acceptanceCriteria: [{
            id: "claim_extra",
            text: "The extra flow is available.",
            source: "user",
            priority: "must",
          }],
          verificationPlan: [{
            id: "check_extra",
            claimIds: ["claim_extra"],
            kind: "unit",
            description: "Run the extra flow test.",
          }],
        },
        kernel,
        noop,
        context,
      );
      assertEquals(amended.ok, true);
      const amendedCs = amended.data as {
        status: string;
        plan: { steps: unknown[]; acceptanceCriteria?: Array<{ id: string }> };
      };
      assertEquals(amendedCs.status, "planning");
      assertEquals(amendedCs.plan.steps.length, 2);
      assertEquals(
        amendedCs.plan.acceptanceCriteria?.at(-1)?.id,
        "claim_extra",
      );

      const rejected = await dispatchTool(
        "define_type",
        {
          name: "ExtraType",
          fields: [{ name: "id", type: "integer" }],
        },
        kernel,
        noop,
        context,
      );
      assertEquals(rejected.ok, false);
      assertEquals(rejected.error?.code, "CHANGESET_REQUIRED");

      await kernel.changesets.approve(cs.id);
      await kernel.changesets.startWork(cs.id);
      const accepted = await dispatchTool(
        "define_type",
        {
          name: "ExtraType",
          fields: [{ name: "id", type: "integer" }],
        },
        kernel,
        noop,
        context,
      );
      assertEquals(accepted.ok, true);
    });
  },
});

Deno.test({
  ...testOpts,
  name:
    "mutation guard scopes implicit active changesets to the current session",
  fn: async () => {
    await withKernel(async (kernel) => {
      const sessionA = await kernel.sessions.createSession("Session A");
      const sessionB = await kernel.sessions.createSession("Session B");
      const cs = await kernel.changesets.create({
        sessionId: sessionA.id,
        title: "Session A work",
        plan: {
          summary: "Only session A may use this changeset.",
          steps: [{
            id: "s1",
            description: "Define a type",
            status: "pending",
          }],
          acceptanceCriteria: [{
            id: "claim_session_scope",
            text: "Only the owning session can use the implicit changeset.",
            source: "agent",
            priority: "must",
          }],
          verificationPlan: [{
            id: "check_session_scope",
            claimIds: ["claim_session_scope"],
            kind: "unit",
            description:
              "Attempt a mutation from a different session and expect rejection.",
          }],
        },
      });
      await kernel.changesets.approve(cs.id);
      await kernel.changesets.startWork(cs.id);

      const rejected = await dispatchTool(
        "define_type",
        {
          name: "RejectedType",
          fields: [{ name: "id", type: "integer" }],
        },
        kernel,
        noop,
        { sessionId: sessionB.id },
      );
      assertEquals(rejected.ok, false);
      assertEquals(rejected.error?.code, "CHANGESET_REQUIRED");

      const context: { sessionId: string; changesetId?: string } = {
        sessionId: sessionA.id,
      };
      const accepted = await dispatchTool(
        "define_type",
        {
          name: "AcceptedType",
          fields: [{ name: "id", type: "integer" }],
        },
        kernel,
        noop,
        context,
      );
      assertEquals(accepted.ok, true);
      assertEquals(context.changesetId, cs.id);
    });
  },
});

Deno.test({
  ...testOpts,
  name: "define_function stores purpose and blocks semantic duplicates",
  fn: async () => {
    await withKernel(async (kernel) => {
      const first = await dispatchTool(
        "define_function",
        {
          name: "validateEmail",
          source:
            "function validateEmail(email: string): boolean { return email.includes('@'); }",
          module: "auth",
          purpose: "Validate an email address.",
          returnType: "boolean",
        },
        kernel,
        noop,
        { manualEdit: true },
      );
      assertEquals(first.ok, true);
      assertEquals(
        kernel.functions.getEntry("validateEmail")?.purpose,
        "Validate an email address.",
      );

      const duplicate = await dispatchTool(
        "define_function",
        {
          name: "isValidEmail",
          source:
            "function isValidEmail(email: string): boolean { return email.includes('@'); }",
          module: "auth",
          purpose: "Validate an email address.",
          returnType: "boolean",
        },
        kernel,
        noop,
        { manualEdit: true },
      );

      assertEquals(duplicate.ok, false);
      assertEquals(duplicate.error?.code, "POSSIBLE_DUPLICATE_ENTITY");
      const data = duplicate.data as {
        candidates: Array<{ name: string; reasons: string[] }>;
      };
      assertEquals(data.candidates[0]?.name, "validateEmail");
      assertEquals(
        data.candidates[0]?.reasons.includes("similar normalized names"),
        true,
      );
    });
  },
});

Deno.test({
  ...testOpts,
  name: "define_function allows same-name update without self-blocking",
  fn: async () => {
    await withKernel(async (kernel) => {
      const input = {
        name: "validateEmail",
        source:
          "function validateEmail(email: string): boolean { return email.includes('@'); }",
        module: "auth",
        purpose: "Validate an email address.",
        returnType: "boolean",
      };
      assertEquals(
        (await dispatchTool("define_function", input, kernel, noop, {
          manualEdit: true,
        })).ok,
        true,
      );

      const update = await dispatchTool(
        "define_function",
        {
          ...input,
          source:
            "function validateEmail(email: string): boolean { return email.trim().includes('@'); }",
        },
        kernel,
        noop,
        { manualEdit: true },
      );

      assertEquals(update.ok, true);
    });
  },
});

Deno.test({
  ...testOpts,
  name: "define_function blocks exact implementation duplicate without purpose",
  fn: async () => {
    await withKernel(async (kernel) => {
      const first = await dispatchTool(
        "define_function",
        {
          name: "foo",
          source:
            "function foo(value: string): string { return value.trim(); }",
          returnType: "string",
        },
        kernel,
        noop,
        { manualEdit: true },
      );
      assertEquals(first.ok, true);

      const duplicate = await dispatchTool(
        "define_function",
        {
          name: "bar",
          source:
            "function bar(value: string): string { return value.trim(); }",
          returnType: "string",
        },
        kernel,
        noop,
        { manualEdit: true },
      );

      assertEquals(duplicate.ok, false);
      assertEquals(duplicate.error?.code, "POSSIBLE_DUPLICATE_ENTITY");
      const data = duplicate.data as {
        candidates: Array<{ name: string; reasons: string[] }>;
      };
      assertEquals(data.candidates[0]?.name, "foo");
      assertEquals(
        data.candidates[0]?.reasons.includes("exact implementation match"),
        true,
      );
    });
  },
});

Deno.test({
  ...testOpts,
  name: "duplicateJustification overrides function duplicate and is recorded",
  fn: async () => {
    await withKernel(async (kernel) => {
      await dispatchTool(
        "define_function",
        {
          name: "validateEmail",
          source:
            "function validateEmail(email: string): boolean { return email.includes('@'); }",
          module: "auth",
          purpose: "Validate an email address.",
          returnType: "boolean",
        },
        kernel,
        noop,
        { manualEdit: true },
      );

      const override = await dispatchTool(
        "define_function",
        {
          name: "checkEmail",
          source:
            "function checkEmail(email: string): boolean { return email.includes('@'); }",
          module: "auth",
          purpose: "Validate an email address.",
          returnType: "boolean",
          duplicateJustification:
            "Keep a compatibility wrapper for an external plugin.",
        },
        kernel,
        noop,
        { manualEdit: true },
      );

      assertEquals(override.ok, true);
      const [record] = await kernel.changelog.list({
        category: "function",
        key: "checkEmail",
        limit: 1,
      });
      const after = record?.afterSnapshot as {
        duplicateJustification?: string;
        duplicateCandidates?: Array<{ name: string }>;
      };
      assertEquals(
        after.duplicateJustification,
        "Keep a compatibility wrapper for an external plugin.",
      );
      assertEquals(after.duplicateCandidates?.[0]?.name, "validateEmail");
    });
  },
});

Deno.test({
  ...testOpts,
  name: "define_handler blocks equivalent handler duplicate",
  fn: async () => {
    await withKernel(async (kernel) => {
      const first = await dispatchTool(
        "define_handler",
        {
          name: "createTodo",
          source:
            "async function createTodo(c) { const body = await c.req.json(); return c.json({ todo: body }, 201); }",
          module: "todos",
          purpose: "Create a todo from a JSON request.",
          schema: { summary: "Create a todo", tags: ["todos"] },
        },
        kernel,
        noop,
        { manualEdit: true },
      );
      assertEquals(first.ok, true);

      const duplicate = await dispatchTool(
        "define_handler",
        {
          name: "addTodo",
          source:
            "async function addTodo(c) { const body = await c.req.json(); return c.json({ todo: body }, 201); }",
          module: "todos",
          purpose: "Create a todo from a JSON request.",
          schema: { summary: "Create a todo", tags: ["todos"] },
        },
        kernel,
        noop,
        { manualEdit: true },
      );

      assertEquals(duplicate.ok, false);
      assertEquals(duplicate.error?.code, "POSSIBLE_DUPLICATE_ENTITY");
    });
  },
});

Deno.test({
  ...testOpts,
  name: "find_similar_entities returns read-only candidates",
  fn: async () => {
    await withKernel(async (kernel) => {
      await dispatchTool(
        "define_function",
        {
          name: "validateEmail",
          source:
            "function validateEmail(email: string): boolean { return email.includes('@'); }",
          module: "auth",
          purpose: "Validate an email address.",
          returnType: "boolean",
        },
        kernel,
        noop,
        { manualEdit: true },
      );

      const result = await dispatchTool(
        "find_similar_entities",
        {
          kind: "function",
          name: "checkEmail",
          source:
            "function checkEmail(email: string): boolean { return email.includes('@'); }",
          module: "auth",
          purpose: "Validate an email address.",
        },
        kernel,
        noop,
      );

      assertEquals(result.ok, true);
      const data = result.data as { candidates: Array<{ name: string }> };
      assertEquals(data.candidates[0]?.name, "validateEmail");
      assertEquals(kernel.functions.getEntry("checkEmail"), undefined);
    });
  },
});

Deno.test({
  ...testOpts,
  name: "get_changeset_context returns compact changeset details",
  fn: async () => {
    await withKernel(async (kernel) => {
      const created = await dispatchTool(
        "create_changeset",
        {
          title: "Explain approval flow",
          plan: {
            summary: "Expose changesets as mentionable history items.",
            steps: ["Add mention context", "Add agent retrieval tool"],
            acceptanceCriteria: ["Changeset context can be retrieved."],
            verificationPlan: [{
              id: "check_context",
              claimIds: ["claim_0"],
              kind: "unit",
              description:
                "Assert get_changeset_context returns the compact details.",
            }],
          },
        },
        kernel,
        noop,
      );
      assertEquals(created.ok, true);
      const cs = created.data as { id: string };

      await kernel.changelog.record({
        category: "handler",
        key: "approveChangeset",
        action: "update",
        beforeSnapshot: { name: "approveChangeset", source: "before" },
        afterSnapshot: { name: "approveChangeset", source: "after" },
        context: { changesetId: cs.id },
      });

      const result = await dispatchTool(
        "get_changeset_context",
        { changeset_id: cs.id },
        kernel,
        noop,
      );

      assertEquals(result.ok, true);
      const data = result.data as {
        context: string;
        changesetId: string;
        status: string;
        stepCount: number;
        changes: Array<{ beforeSnapshot: unknown; afterSnapshot: unknown }>;
      };
      assertStringIncludes(data.context, 'changeset "Explain approval flow"');
      assertStringIncludes(data.context, 'update handler "approveChangeset"');
      assertEquals(data.changes.length, 1);
      assertEquals(data.changes[0]?.beforeSnapshot, null);
      assertEquals(data.changes[0]?.afterSnapshot, null);
      // §4.3: the raw `changeset` object is gone — it duplicated `context` as JSON.
      // Unlike the mutation verbs this result carries NO `_changeset` side channel,
      // so `context` is the sole carrier and has to hold everything the agent acts
      // on: step ids, criterion ids + priority, planned check ids.
      assertEquals("changeset" in data, false);
      assertEquals(data.changesetId, cs.id);
      assertEquals(data.status, "planning");
      assertEquals(data.stepCount, 2);
      assertStringIncludes(
        data.context,
        "- [pending] step_0: Add mention context",
      );
      assertStringIncludes(data.context, "acceptance criteria:");
      assertStringIncludes(
        data.context,
        "- [should] claim_0: Changeset context can be retrieved.",
      );
      assertStringIncludes(data.context, "planned checks:");
      assertStringIncludes(
        data.context,
        "- check_context (unit): Assert get_changeset_context returns the compact details.",
      );
    });
  },
});

Deno.test({
  ...testOpts,
  name: "upload_text_asset records text snapshots for changelog diffs",
  fn: async () => {
    await withKernel(async (kernel) => {
      const first = await dispatchTool(
        "upload_text_asset",
        {
          name: "app.css",
          content: "body { color: red; }\n",
          mimeType: "text/css",
        },
        kernel,
        noop,
        { manualEdit: true },
      );
      assertEquals(first.ok, true);

      const second = await dispatchTool(
        "upload_text_asset",
        {
          name: "app.css",
          content: "body { color: blue; }\n",
          mimeType: "text/css",
        },
        kernel,
        noop,
        { manualEdit: true },
      );
      assertEquals(second.ok, true);

      const [record] = await kernel.changelog.list({
        category: "asset",
        key: "app.css",
        limit: 1,
      });
      const before = record?.beforeSnapshot as {
        contentBase64?: string;
        mimeType?: string;
      };
      const after = record?.afterSnapshot as {
        contentBase64?: string;
        mimeType?: string;
      };

      assertEquals(before.mimeType, "text/css");
      assertEquals(after.mimeType, "text/css");
      assertEquals(atob(before.contentBase64 ?? ""), "body { color: red; }\n");
      assertEquals(atob(after.contentBase64 ?? ""), "body { color: blue; }\n");
    });
  },
});

Deno.test({
  ...testOpts,
  name:
    "list_assets can read named text asset content without exposing binary content",
  fn: async () => {
    await withKernel(async (kernel) => {
      kernel.assets.register(
        "appearance.js",
        new TextEncoder().encode("document.body.dataset.theme = 'dark';\n"),
        "application/javascript",
      );
      kernel.assets.register(
        "logo.png",
        new Uint8Array([137, 80, 78, 71]),
        "image/png",
      );

      const listed = await dispatchTool("list_assets", {}, kernel, noop);
      assertEquals(listed.ok, true);
      const assets = listed.data as Array<{ name: string; content?: string }>;
      assertEquals(assets.map((a) => a.name).sort(), [
        "appearance.js",
        "logo.png",
      ]);
      assertEquals(assets.some((a) => "content" in a), false);

      const metadata = await dispatchTool(
        "list_assets",
        { name: "appearance.js" },
        kernel,
        noop,
      );
      assertEquals(metadata.ok, true);
      assertEquals(
        (metadata.data as { name: string; content?: string }).name,
        "appearance.js",
      );
      assertEquals(
        "content" in (metadata.data as Record<string, unknown>),
        false,
      );

      const withContent = await dispatchTool(
        "list_assets",
        { name: "appearance.js", includeContent: true },
        kernel,
        noop,
      );
      assertEquals(withContent.ok, true);
      assertEquals(
        (withContent.data as { content: string }).content,
        "document.body.dataset.theme = 'dark';\n",
      );

      const binary = await dispatchTool(
        "list_assets",
        { name: "logo.png", includeContent: true },
        kernel,
        noop,
      );
      assertEquals(binary.ok, false);
      assertEquals(binary.error?.code, "ASSET_CONTENT_UNAVAILABLE");
    });
  },
});

Deno.test({
  ...testOpts,
  name: "list_assets validates named content reads",
  fn: async () => {
    await withKernel(async (kernel) => {
      const missingName = await dispatchTool(
        "list_assets",
        { includeContent: true },
        kernel,
        noop,
      );
      assertEquals(missingName.ok, false);
      assertEquals(missingName.error?.code, "NAME_REQUIRED");

      const missingAsset = await dispatchTool(
        "list_assets",
        { name: "missing.css" },
        kernel,
        noop,
      );
      assertEquals(missingAsset.ok, false);
      assertEquals(missingAsset.error?.code, "NOT_FOUND");
    });
  },
});

Deno.test("approve_changeset is not exposed to the model", () => {
  assertEquals(
    CUSTOM_TOOLS.some((tool) => tool.name === "approve_changeset"),
    false,
  );
});

Deno.test("agent tool list stays within provider limit", () => {
  assertEquals(AGENT_TOOLS.length <= 128, true);
  assertEquals(AGENT_TOOLS.some((tool) => tool.name === "list_assets"), true);
  assertEquals(AGENT_TOOLS.some((tool) => tool.name === "get_asset"), false);
  assertEquals(
    AGENT_TOOLS.some((tool) => tool.name === "manage_sessions"),
    true,
  );
});

// Per D9 the tool description is where the handler ABI is AUTHORITATIVELY taught:
// an OSS user driving the MCP server with their own model never sees the closed
// system prompt, so anything the ABI depends on that lives only there is not
// actually part of the contract. Descriptions are deliberately excluded from
// mcpSurfaceFingerprint, so this text can move without a surface-version bump —
// which is exactly why it needs a test of its own to stop it rotting back.
Deno.test("define_handler teaches the framework-free ABI and no framework", () => {
  const description =
    CUSTOM_TOOLS.find((t) => t.name === "define_handler")?.description ?? "";
  assertStringIncludes(description, "(req: Request, ctx: HandlerContext)");
  assertStringIncludes(description, "ctx.params");
  assertStringIncludes(description, "the kernel owns routing");
  for (const banned of ["Hono", "hono", "Context 'c'", "c.json", "c.req"]) {
    assertEquals(
      description.includes(banned),
      false,
      `define_handler description still mentions ${banned}`,
    );
  }
});

Deno.test("define_schema tool description forbids bundled DDL", () => {
  const tool = CUSTOM_TOOLS.find((t) => t.name === "define_schema");
  assertStringIncludes(tool?.description ?? "", "exactly one CREATE TABLE");
  assertStringIncludes(tool?.description ?? "", "alter_schema");

  const properties = tool?.input_schema.properties as
    | Record<string, { description?: string }>
    | undefined;
  assertStringIncludes(
    properties?.sql?.description ?? "",
    "Exactly one CREATE TABLE",
  );
});

Deno.test("record_verification_run tool description distinguishes evidence ids", () => {
  const tool = CUSTOM_TOOLS.find((t) => t.name === "record_verification_run");
  const properties = tool?.input_schema.properties as
    | Record<string, { description?: string }>
    | undefined;

  assertStringIncludes(properties?.evidence?.description ?? "", "checkId");
  assertStringIncludes(
    properties?.evidence?.description ?? "",
    "attestationId",
  );
  assertStringIncludes(
    properties?.claimResults?.description ?? "",
    "evidence[].id",
  );
  assertStringIncludes(
    properties?.claimResults?.description ?? "",
    "do not put verificationPlan checkId values or attestationId values here",
  );
});

Deno.test("mutation tools expose work item rationale fields", () => {
  const tool = CUSTOM_TOOLS.find((t) => t.name === "define_function");
  const properties = tool?.input_schema.properties as
    | Record<string, unknown>
    | undefined;

  assertEquals(properties?.rationale != null, true);
  assertEquals(properties?.implementation != null, true);
});

Deno.test("work item rationale fields match mutation tool gate", () => {
  const rationaleTools = CUSTOM_TOOLS.filter((tool) => {
    const properties = tool.input_schema.properties as
      | Record<string, unknown>
      | undefined;
    return properties?.rationale != null || properties?.implementation != null;
  }).map((tool) => tool.name).toSorted();
  const exposedMutationTools = CUSTOM_TOOLS.filter((tool) =>
    MODIFICATION_TOOLS.has(tool.name)
  ).map((tool) => tool.name).toSorted();

  assertEquals(rationaleTools, exposedMutationTools);
  for (const name of rationaleTools) {
    assertEquals(isMutationTool(name), true);
  }
});

Deno.test("git tools are exposed outside the changeset mutation gate", () => {
  for (
    const name of [
      "git_status",
      "git_init",
      "git_add_tide_gitignore",
      "git_set_remote",
      "git_commit",
      "git_push",
    ]
  ) {
    assertEquals(CUSTOM_TOOLS.some((tool) => tool.name === name), true);
    assertEquals(MODIFICATION_TOOLS.has(name), false);
    assertEquals(isMutationTool(name), false);
  }
  const gitCommitTool = CUSTOM_TOOLS.find((tool) => tool.name === "git_commit");
  assertEquals(
    ((gitCommitTool?.input_schema.required as string[] | undefined) ?? [])
      .includes("message"),
    false,
  );
});

Deno.test({
  ...testOpts,
  name:
    "git_commit with a changeset_id commits OpenTide's paths, not the user's",
  fn: async () => {
    await withKernel(async (kernel) => {
      const projectDir = await Deno.makeTempDir({
        dir: TEST_TMP_DIR,
        prefix: "genie-dispatch-git-scoped-",
      });
      try {
        kernel.projectDir = projectDir;
        runGit(projectDir, ["init"]);
        runGit(projectDir, ["config", "user.email", "tide-test@example.com"]);
        runGit(projectDir, ["config", "user.name", "Tide Test"]);
        writeFileSync(join(projectDir, "opentide.json"), "{}\n");
        writeFileSync(join(projectDir, "notes.txt"), "the user's own\n");

        const noMessage = await dispatchTool(
          "git_commit",
          { changeset_id: "cs_scoped" },
          kernel,
          noop,
        );
        assertEquals(noMessage.error?.code, "INVALID_INPUT");

        const result = await dispatchTool(
          "git_commit",
          { changeset_id: "cs_scoped", message: "Step 1" },
          kernel,
          noop,
        );
        assertEquals(result.ok, true, JSON.stringify(result.error));
        assertEquals((result.data as { committed: boolean }).committed, true);
        const listed = new Deno.Command("git", {
          args: ["show", "--name-only", "--format=", "HEAD"],
          cwd: projectDir,
          stdout: "piped",
        }).outputSync();
        const files = new TextDecoder().decode(listed.stdout).trim()
          .split("\n");
        assert(files.includes("opentide.json"), files.join(", "));
        assert(!files.includes("notes.txt"), files.join(", "));

        const again = await dispatchTool(
          "git_commit",
          { changeset_id: "cs_scoped", message: "Step 2" },
          kernel,
          noop,
        );
        assertEquals(again.data, { committed: false });
      } finally {
        rmSync(projectDir, { recursive: true, force: true });
      }
    });
  },
});

Deno.test({
  ...testOpts,
  name: "git_commit with no message calls no model, even with one configured",
  fn: async () => {
    await withTempHomeAndProviderEnv({ openai: "sk-openai-test" }, async () => {
      const home = Deno.env.get("HOME")!;
      seedModelCache(home, "gpt-5-mini", "openai");
      setRecommendedModels({ utility: "gpt-5-mini" });
      let modelCalls = 0;
      const restoreModelCall = setUtilityModelCallForTest((req) => {
        modelCalls += 1;
        return Promise.resolve({
          text: "Add project config",
          provider: "openai",
          model: req.model,
          usage: {
            inputTokens: 12,
            outputTokens: 4,
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: 0,
          },
        });
      });
      try {
        await withKernel(async (kernel) => {
          const projectDir = await Deno.makeTempDir({
            dir: TEST_TMP_DIR,
            prefix: "genie-dispatch-git-",
          });
          try {
            kernel.projectDir = projectDir;
            runGit(projectDir, ["init"]);
            runGit(projectDir, [
              "config",
              "user.email",
              "tide-test@example.com",
            ]);
            runGit(projectDir, ["config", "user.name", "Tide Test"]);
            writeFileSync(join(projectDir, "opentide.json"), "{}\n");
            const session = await kernel.sessions.createSession("Git");
            const changesetId = "cs_git_dispatch";

            const result = await dispatchTool(
              "git_commit",
              {},
              kernel,
              noop,
              { sessionId: session.id, changesetId },
            );

            assertEquals(result.ok, true, JSON.stringify(result.error));
            assertEquals(modelCalls, 0);
            assertEquals(
              await kernel.sessions.getModelUsagesForChangeset(changesetId),
              [],
            );
          } finally {
            rmSync(projectDir, { recursive: true, force: true });
          }
        });
      } finally {
        restoreModelCall();
      }
    });
  },
});

Deno.test({
  ...testOpts,
  name: "approve_changeset is not callable through dispatch",
  fn: async () => {
    await withKernel(async (kernel) => {
      const result = await dispatchTool(
        "approve_changeset",
        { changeset_id: "cs_test" },
        kernel,
        noop,
      );
      assertEquals(result.ok, false);
      assertEquals(result.error?.code, "UNKNOWN_TOOL");
    });
  },
});

// B1c: register the canonical knowledge-graph fixture (route→handler→fnA→fnB, fnA
// reads config "flag") so the tool's answers agree with the graph module and API.
function registerBlastFixture(kernel: Kernel): void {
  kernel.functions.register("fnB", "function fnB(){ return 1; }", () => 1);
  kernel.functions.register(
    "fnA",
    'function fnA(){ return functions.call("fnB") + config.get("flag"); }',
    () => 1,
  );
  kernel.handlers.register(
    "h",
    'async function h(c){ return functions.call("fnA"); }',
    () => Promise.resolve(new Response()),
    undefined,
    "m",
  );
  kernel.routes.register("GET", "/x", "h", undefined, "m");
}

Deno.test({
  ...testOpts,
  name: "blast_radius dispatch matches the graph module and is read-only",
  fn: async () => {
    await withKernel(async (kernel) => {
      registerBlastFixture(kernel);

      const before = buildKnowledgeGraph(kernel).nodeCount;
      const result = await dispatchTool(
        "blast_radius",
        { category: "function", name: "fnB" },
        kernel,
        noop,
      );
      assertEquals(result.ok, true);
      // Shared helper ⇒ dispatch returns exactly what a direct projection would.
      const expected = blastRadiusReport(
        buildKnowledgeGraph(kernel),
        "function",
        "fnB",
      );
      assertEquals(result.data, expected);
      assertEquals(expected.counts, { direct: 1, transitive: 3 });

      // A non-graph-node category (a test) → empty + zero, still ok: true.
      const nonNode = await dispatchTool(
        "blast_radius",
        { category: "test", name: "whatever" },
        kernel,
        noop,
      );
      assertEquals(nonNode.ok, true);
      assertEquals(nonNode.data, {
        direct: [],
        transitive: [],
        counts: { direct: 0, transitive: 0 },
      });

      // Read-only invariant: the queries did not grow or mutate the graph.
      assertEquals(buildKnowledgeGraph(kernel).nodeCount, before);
    });
  },
});

Deno.test({
  ...testOpts,
  name: "index_codebase summarizes a source project and caches the graph",
  fn: async () => {
    await withKernel(async (kernel) => {
      const root = await Deno.makeTempDir({ prefix: "genie-index-tool-" });
      try {
        await Deno.writeTextFile(
          join(root, "package.json"),
          JSON.stringify({
            scripts: { test: "vitest" },
            dependencies: { express: "^5.0.0" },
          }),
        );
        await Deno.writeTextFile(join(root, "package-lock.json"), "{}");
        await Deno.mkdir(join(root, "src"));
        await Deno.writeTextFile(
          join(root, "src", "index.ts"),
          "export const value = 1;",
        );

        // Nothing cached until the first index.
        assertEquals(kernel.codebaseGraph, null);

        const result = await dispatchTool(
          "index_codebase",
          { rootPath: root },
          kernel,
          noop,
        );
        assertEquals(result.ok, true);
        const data = result.data as {
          counts: { files: number };
          packageManager: string;
          frameworks: string[];
          plugins: string[];
        };
        assertEquals(data.packageManager, "npm");
        assertEquals(data.frameworks, ["express"]);
        assertEquals(data.counts.files, 1);

        // The full graph is cached on the kernel and matches the summary counts
        // (the API serves exactly this).
        assert(kernel.codebaseGraph !== null);
        assertEquals(kernel.codebaseGraph!.files.length, data.counts.files);
        assertEquals(
          kernel.codebaseGraph!.files.map((f) => f.path),
          ["src/index.ts"],
        );
      } finally {
        await Deno.remove(root, { recursive: true });
      }
    });
  },
});

// index_codebase in "assist" mode leaves the classification to the client:
// request_review kind "imports", then submit_review.
async function withIndexedForClassification(
  fn: (kernel: Kernel, sessionId: string) => Promise<void>,
): Promise<void> {
  await withKernel(async (kernel) => {
    const root = await Deno.makeTempDir({ prefix: "genie-index-assist-" });
    try {
      await writeTinySourceProject(root);
      const session = await kernel.sessions.createSession("Import");
      const result = await dispatchTool(
        "index_codebase",
        { rootPath: root, classification: "assist" },
        kernel,
        noop,
        { sessionId: session.id },
      );
      assertEquals(result.ok, true);
      const data = result.data as {
        classification: { status: string };
        counts: { files: number };
      };
      assertEquals(data.classification.status, "review_owed");
      assertEquals(data.counts.files, 1);
      await fn(kernel, session.id);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });
}

async function importsPacket(kernel: Kernel, sessionId: string) {
  const result = await dispatchTool(
    "request_review",
    { kind: "imports" },
    kernel,
    noop,
    { sessionId },
  );
  assert(result.ok, JSON.stringify(result.error));
  return result.data as {
    packetId: string;
    request: ImportClassifierRequest;
  };
}

const CLASSIFICATION = {
  facts: [{
    kind: "import-strategy",
    name: "import strategy",
    value: { mode: "source-backed-overlay" },
    confidence: 0.93,
  }],
  mappings: [],
  diagnostics: [{ severity: "warning", message: "Ambiguous auth middleware." }],
  candidateEntities: [{
    entityType: "handler",
    name: "listUsers",
    confidence: 0.82,
    rationale: "Candidate only; do not materialize.",
    locations: [{ file: "src/index.ts", startLine: 1, startColumn: 14 }],
    sourceExcerpt: "export const value = 1;",
  }],
};

function hasClassifier(kernel: Kernel): boolean {
  return kernel.codebaseGraph!.plugins.some((plugin) =>
    plugin.pluginId === IMPORT_CLASSIFIER_PLUGIN_ID
  );
}

Deno.test({
  ...testOpts,
  name:
    "index_codebase assist leaves the classification owed; a submitted one merges into the graph",
  fn: async () => {
    await withIndexedForClassification(async (kernel, sessionId) => {
      assertEquals(hasClassifier(kernel), false);
      const before = registryEntityCounts(kernel);
      const packet = await importsPacket(kernel, sessionId);
      assertEquals(packet.request.graphSummary.counts.files, 1);

      const submitted = await dispatchTool(
        "submit_review",
        {
          packet_id: packet.packetId,
          verdict: CLASSIFICATION,
          reviewer: "claude-import-test",
        },
        kernel,
        noop,
        { sessionId },
      );
      assert(submitted.ok, JSON.stringify(submitted.error));
      assertEquals(
        (submitted.data as { classification: { status: string } })
          .classification.status,
        "completed",
      );

      const graph = kernel.codebaseGraph!;
      assert(
        graph.facts.some((fact) =>
          fact.source.pluginId === IMPORT_CLASSIFIER_PLUGIN_ID &&
          fact.source.method === "agent" &&
          fact.name === "import strategy"
        ),
      );
      assert(
        graph.diagnostics.some((diagnostic) =>
          diagnostic.source.pluginId === IMPORT_CLASSIFIER_PLUGIN_ID &&
          diagnostic.message === "Ambiguous auth middleware."
        ),
      );
      assert(
        graph.plugins.some((plugin) =>
          plugin.pluginId === IMPORT_CLASSIFIER_PLUGIN_ID &&
          plugin.status === "completed"
        ),
      );
      const candidate = graph.facts.find((fact) =>
        fact.factKind === "candidate-entity" &&
        fact.source.pluginId === IMPORT_CLASSIFIER_PLUGIN_ID
      );
      assertEquals(candidate?.confidence, 0.82);
      assertEquals(
        (candidate?.value as { sourceExcerpt?: string }).sourceExcerpt,
        "export const value = 1;",
      );
      // A classification describes; it never writes registry entities.
      assertEquals(registryEntityCounts(kernel), before);
    });
  },
});

Deno.test({
  ...testOpts,
  name: "an imports packet goes stale when the codebase is indexed again",
  fn: async () => {
    await withIndexedForClassification(async (kernel, sessionId) => {
      const packet = await importsPacket(kernel, sessionId);
      const root = kernel.codebaseGraph!.rootPath;
      await dispatchTool("index_codebase", { rootPath: root }, kernel, noop);
      const submitted = await dispatchTool(
        "submit_review",
        {
          packet_id: packet.packetId,
          verdict: CLASSIFICATION,
        },
        kernel,
        noop,
        { sessionId },
      );
      assertEquals(submitted.error?.code, "STALE_REVIEW");
      assertEquals(hasClassifier(kernel), false);
    });
  },
});

Deno.test({
  ...testOpts,
  name: "a classification that isn't one is refused and the graph is untouched",
  fn: async () => {
    await withIndexedForClassification(async (kernel, sessionId) => {
      const packet = await importsPacket(kernel, sessionId);
      for (const verdict of ["facts", { facts: "none" }]) {
        const submitted = await dispatchTool(
          "submit_review",
          {
            packet_id: packet.packetId,
            verdict,
          },
          kernel,
          noop,
          { sessionId },
        );
        assertEquals(submitted.error?.code, "INVALID_VERDICT");
      }
      assertEquals(hasClassifier(kernel), false);
    });
  },
});

Deno.test({
  ...testOpts,
  name: "request_review imports needs an assist-mode index first",
  fn: async () => {
    await withKernel(async (kernel) => {
      const result = await dispatchTool(
        "request_review",
        { kind: "imports" },
        kernel,
        noop,
      );
      assertEquals(result.error?.code, "NO_INDEX_TO_CLASSIFY");
    });
  },
});

Deno.test({
  ...testOpts,
  name: "index_codebase errors without a rootPath or loaded project",
  fn: async () => {
    await withKernel(async (kernel) => {
      const result = await dispatchTool("index_codebase", {}, kernel, noop);
      assertEquals(result.ok, false);
      assertEquals(result.error?.code, "NO_PROJECT");
      assertEquals(kernel.codebaseGraph, null);
    });
  },
});

Deno.test("index_codebase is exposed as an agent tool", () => {
  assert(CUSTOM_TOOLS.some((tool) => tool.name === "index_codebase"));
  assert(AGENT_TOOLS.some((tool) => tool.name === "index_codebase"));
});

Deno.test("blast_radius is registered read-only and is a known custom tool", () => {
  assert(READ_ONLY_TOOLS.has("blast_radius"));
  assert(CUSTOM_TOOLS.some((tool) => tool.name === "blast_radius"));
  assert(AGENT_TOOLS.some((tool) => tool.name === "blast_radius"));
});

Deno.test("check_export_types is exposed as an agent tool", () => {
  assertEquals(
    AGENT_TOOLS.some((tool) => tool.name === "check_export_types"),
    true,
  );
});

Deno.test({
  ...testOpts,
  name: "check_export_types requires a project directory",
  fn: async () => {
    await withKernel(async (kernel) => {
      const result = await dispatchTool("check_export_types", {}, kernel, noop);
      assertEquals(result.ok, false);
      assertEquals(result.error?.code, "NO_PROJECT");
    });
  },
});

Deno.test({
  ...testOpts,
  name: "check_export_types returns structured export diagnostics",
  fn: async () => {
    await withKernel(async (kernel) => {
      const projectDir = await Deno.makeTempDir({
        dir: TEST_TMP_DIR,
        prefix: "tideide-dispatch-export-check-",
      });
      kernel.projectDir = projectDir;
      try {
        kernel.handlers.register(
          "servePage",
          "async function servePage(c) { return c.json({ ok: true }); }",
          () => Promise.resolve(new Response()),
        );
        kernel.routes.register("GET", "/", "servePage");

        const result = await dispatchTool(
          "check_export_types",
          {},
          kernel,
          noop,
        );

        assertEquals(result.ok, true);
        const data = result.data as {
          ok: boolean;
          output: string;
          fileCount: number;
          summary: string;
          issues: Array<{
            severity: string;
            code: string;
            file: string;
            line: number;
            column: number;
            snippet?: string;
          }>;
        };
        assertEquals(data.ok, false);
        assertEquals(data.summary, "Export type check found 1 issue.");
        assertEquals(data.issues.length, 1);
        assertEquals(data.issues[0]?.severity, "error");
        assertEquals(data.issues[0]?.code, "TS7006");
        assertEquals(
          data.issues[0]?.file.endsWith("handlers/servePage.ts"),
          true,
        );
        assertEquals(typeof data.issues[0]?.line, "number");
        assertEquals(typeof data.issues[0]?.column, "number");
        assertStringIncludes(data.issues[0]?.snippet ?? "", "servePage");
      } finally {
        rmSync(projectDir, { recursive: true, force: true });
      }
    });
  },
});

Deno.test({
  ...testOpts,
  name: "manage_sessions end closes the calling session by default",
  fn: async () => {
    await withKernel(async (kernel) => {
      const session = await kernel.sessions.createSession("to end");
      const result = await dispatchTool(
        "manage_sessions",
        { action: "end" },
        kernel,
        noop,
        { sessionId: session.id },
      );
      assertEquals(result.ok, true);
      const ended = await kernel.sessions.getSession(session.id);
      assertEquals(typeof ended?.endedAt, "string");

      const none = await dispatchTool(
        "manage_sessions",
        { action: "end" },
        kernel,
        noop,
      );
      assertEquals(none.ok, false);
      assertEquals(none.error?.code, "NO_SESSION");
    });
  },
});

Deno.test({
  ...testOpts,
  name: "list_tests filters by claim_id and returns verification metadata",
  fn: async () => {
    await withKernel(async (kernel) => {
      const pass = async () => {};
      kernel.tests.register(
        "claimedTest",
        "async function claimedTest() {}",
        pass,
        undefined,
        "cs-1",
        undefined,
        undefined,
        { claimIds: ["c1"], kind: "unit" },
      );
      kernel.tests.register(
        "otherTest",
        "async function otherTest() {}",
        pass,
        undefined,
        undefined,
        undefined,
        undefined,
        { claimIds: ["c2"] },
      );
      kernel.tests.register("plainTest", "async function plainTest() {}", pass);

      const filtered = await dispatchTool(
        "list_tests",
        { claim_id: "c1" },
        kernel,
        noop,
      );
      assertEquals(filtered.ok, true);
      const rows = filtered.data as Array<Record<string, unknown>>;
      assertEquals(rows.map((r) => r.name), ["claimedTest"]);
      assertEquals(rows[0]?.changesetId, "cs-1");
      assertEquals(rows[0]?.verification, { claimIds: ["c1"], kind: "unit" });

      const all = await dispatchTool("list_tests", {}, kernel, noop);
      const names = (all.data as Array<{ name: string }>).map((r) => r.name);
      assertEquals(names.length >= 3, true);
      const plain = (all.data as Array<Record<string, unknown>>).find((r) =>
        r.name === "plainTest"
      );
      assertEquals(plain && "verification" in plain, false);
    });
  },
});

Deno.test({
  ...testOpts,
  name: "get_code_context serves the project, scopes, a changeset or a claim",
  fn: async () => {
    await withKernel(async (kernel) => {
      const ok = () => new Response();
      kernel.handlers.register("changed", "const a = 'changed-src';", ok);
      kernel.handlers.register("untouched", "const b = 'untouched-src';", ok);
      kernel.tests.register(
        "claimTest",
        "async function claimTest() { 'claim-test-src'; }",
        async () => {},
        undefined,
        undefined,
        undefined,
        undefined,
        { claimIds: ["claim_0"] },
      );
      const session = await kernel.sessions.createSession("ctx");
      const changeset = await kernel.changesets.create({
        sessionId: session.id,
        title: "Ctx",
        plan: {
          summary: "Change a handler.",
          steps: [{ id: "s1", description: "Change it", status: "pending" }],
          acceptanceCriteria: [{
            id: "claim_0",
            text: "It works.",
            source: "agent",
            priority: "must",
          }],
          verificationPlan: [{
            id: "v1",
            claimIds: ["claim_0"],
            kind: "unit",
            description: "Test it.",
          }],
        },
      });
      await kernel.changelog.record({
        category: "handler",
        key: "changed",
        action: "update",
        beforeSnapshot: null,
        afterSnapshot: { source: "x" },
        context: { sessionId: session.id, changesetId: changeset.id },
      });
      const context = async (input: Record<string, unknown>) => {
        const result = await dispatchTool(
          "get_code_context",
          input,
          kernel,
          noop,
        );
        assertEquals(result.ok, true, JSON.stringify(result));
        return (result.data as { context: string }).context;
      };

      const project = await context({});
      assertStringIncludes(project, "changed-src");
      assertStringIncludes(project, "untouched-src");

      const scoped = await context({ scopes: ["handler:untouched"] });
      assertStringIncludes(scoped, "untouched-src");
      assert(!scoped.includes("changed-src"));

      const touched = await context({ changeset_id: changeset.id });
      assertStringIncludes(touched, "changed-src");
      assert(!touched.includes("untouched-src"));

      const claim = await context({
        changeset_id: changeset.id,
        claim_id: "claim_0",
      });
      assertStringIncludes(claim, "claim-test-src");

      const orphan = await dispatchTool(
        "get_code_context",
        { claim_id: "claim_0" },
        kernel,
        noop,
      );
      assertEquals(orphan.error?.code, "INVALID_INPUT");
      const missing = await dispatchTool(
        "get_code_context",
        { changeset_id: "cs-missing" },
        kernel,
        noop,
      );
      assertEquals(
        missing.error?.code,
        "CHANGESET_NOT_FOUND",
      );
    });
  },
});

Deno.test({
  ...testOpts,
  name: "run_tests returns ranAt and stores assertion error metadata",
  fn: async () => {
    await withKernel(async (kernel) => {
      kernel.tests.register(
        "failingAssertionTest",
        "async function failingAssertionTest() { assertEquals(1, 2); }",
        async () => {
          throw new AssertionError("Expected 2, got 1");
        },
      );

      const result = await dispatchTool(
        "run_tests",
        { pattern: "failingAssertionTest" },
        kernel,
        noop,
      );

      assertEquals(result.ok, true);
      const data = result.data as {
        passed: number;
        failed: number;
        total: number;
        results: Array<{
          name: string;
          passed: boolean;
          error?: string;
          errorName?: string;
          durationMs: number;
          ranAt: string;
        }>;
      };
      assertEquals(data.total, 1);
      assertEquals(data.passed, 0);
      assertEquals(data.failed, 1);
      assertEquals(data.results[0]?.name, "failingAssertionTest");
      assertEquals(data.results[0]?.passed, false);
      assertEquals(data.results[0]?.error, "Expected 2, got 1");
      assertEquals(data.results[0]?.errorName, "AssertionError");
      assertEquals(typeof data.results[0]?.durationMs, "number");
      assertEquals(typeof data.results[0]?.ranAt, "string");

      const lastResult = kernel.tests.get("failingAssertionTest")?.lastResult;
      assertEquals(lastResult?.passed, false);
      assertEquals(lastResult?.error, "Expected 2, got 1");
      assertEquals(lastResult?.errorName, "AssertionError");
      assertEquals(lastResult?.ranAt, data.results[0]?.ranAt);
    });
  },
});

Deno.test({
  ...testOpts,
  name: "define_test records verification metadata",
  fn: async () => {
    await withKernel(async (kernel) => {
      const cs = await kernel.changesets.create({
        title: "Test verification metadata",
        plan: {
          summary: "Register a test with proof metadata.",
          steps: [{
            id: "step_0",
            description: "Define a test.",
            status: "pending",
          }],
          acceptanceCriteria: [{
            id: "claim_test_verification",
            text: "Test definitions can store verification metadata.",
            source: "agent",
            priority: "must",
          }],
          verificationPlan: [{
            id: "check_test_verification",
            claimIds: ["claim_test_verification"],
            kind: "unit",
            description:
              "Define a test with verification metadata and assert it is stored.",
          }],
        },
      });
      await kernel.changesets.approve(cs.id);
      await kernel.changesets.startWork(cs.id);
      const context = { changesetId: cs.id };

      const first = await dispatchTool(
        "define_test",
        {
          name: "testProofClaim",
          source: "async function testProofClaim() { assertEquals(1, 1); }",
          verification: {
            claimIds: ["claim_feature"],
            kind: "unit",
            description: "Feature claim is covered by a unit assertion.",
            generatedFrom: "check_unit_feature",
          },
        },
        kernel,
        noop,
        context,
      );
      assertEquals(first.ok, true);
      assertEquals(kernel.tests.get("testProofClaim")?.verification, {
        claimIds: ["claim_feature"],
        kind: "unit",
        description: "Feature claim is covered by a unit assertion.",
        generatedFrom: "check_unit_feature",
      });

      const updated = await dispatchTool(
        "define_test",
        {
          name: "testProofClaim",
          source: "async function testProofClaim() { assertNotEquals(1, 2); }",
        },
        kernel,
        noop,
        context,
      );
      assertEquals(updated.ok, true);
      assertEquals(kernel.tests.get("testProofClaim")?.verification?.claimIds, [
        "claim_feature",
      ]);
    });
  },
});

Deno.test({
  ...testOpts,
  name: "runKernelTests emits progress events in execution order",
  fn: async () => {
    await withKernel(async (kernel) => {
      kernel.tests.register(
        "test_first",
        "async function test_first() {}",
        async () => {},
      );
      kernel.tests.register(
        "test_second",
        "async function test_second() {}",
        async () => {},
      );

      const events: string[] = [];
      const result = await runKernelTests(kernel, undefined, (event) => {
        if (event.type === "cleared") {
          events.push(`cleared:${event.names.join(",")}`);
        } else if (event.type === "started") {
          events.push(`started:${event.name}`);
        } else if (event.type === "result") {
          events.push(`result:${event.result.name}:${event.result.passed}`);
        }
      });

      assertEquals(result.ok, true);
      assertEquals(events, [
        "cleared:test_first,test_second",
        "started:test_first",
        "result:test_first:true",
        "started:test_second",
        "result:test_second:true",
      ]);
    });
  },
});

Deno.test({
  ...testOpts,
  name: "runKernelTests exposes dynamic appUrl and getAppPort helpers",
  fn: async () => {
    await withKernel(async (kernel) => {
      const server = Deno.serve(
        { hostname: "127.0.0.1", port: 0, onListen: () => {} },
        (req) => {
          const url = new URL(req.url);
          return Response.json({ path: url.pathname, port: url.port });
        },
      );
      kernel.appPort = server.addr.port;

      try {
        const source = `
async function test_dynamicPreviewUrl() {
  const res = await fetch(appUrl("/dynamic-port"));
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.path, "/dynamic-port");
  assertEquals(Number(body.port), getAppPort());
        }
`;
        const deps = await kernel.compileDeps();
        const compileTest = kernel.runtime.compileTest;
        if (!compileTest) throw new Error("test runtime unavailable");
        const compiled = await compileTest(
          "test_dynamicPreviewUrl",
          source,
          deps,
        );
        if (!compiled.ok) throw new Error(compiled.error.message);
        kernel.tests.register("test_dynamicPreviewUrl", source, compiled.data);

        const result = await runKernelTests(kernel, "test_dynamicPreviewUrl");

        assertEquals(result.ok, true);
        assertEquals(result.data?.failed, 0);
        assertEquals(result.data?.passed, 1);
      } finally {
        await server.shutdown();
      }
    });
  },
});

Deno.test({
  ...testOpts,
  name: "runKernelTests can be cancelled with an abort signal",
  fn: async () => {
    await withKernel(async (kernel) => {
      kernel.tests.register(
        "test_slow",
        "async function test_slow() {}",
        () => new Promise<void>((resolve) => setTimeout(resolve, 100)),
      );
      const controller = new AbortController();

      await assertRejects(
        () =>
          runKernelTests(kernel, undefined, (event) => {
            if (event.type === "started") controller.abort();
          }, controller.signal),
        Error,
        "Test run cancelled",
      );
    });
  },
});

Deno.test({
  ...testOpts,
  name: "runKernelTests uses the configured per-test timeout",
  fn: async () => {
    const home = mkdtempSync(join(tmpdir(), "genie-run-tests-timeout-"));
    const oldHome = Deno.env.get("HOME");
    try {
      Deno.env.set("HOME", home);
      setKernelSettings({ testTimeoutMs: 1_000 });

      await withKernel(async (kernel) => {
        kernel.tests.register(
          "test_timeout_setting",
          "async function test_timeout_setting() {}",
          () => new Promise<void>((resolve) => setTimeout(resolve, 1_500)),
        );

        const result = await runKernelTests(
          kernel,
          "test_timeout_setting",
        );

        assertEquals(result.ok, true);
        assertEquals(result.data?.failed, 1);
        assertEquals(
          result.data?.results[0]?.error,
          "Test timed out after 1s",
        );
        assertEquals(
          kernel.tests.get("test_timeout_setting")?.lastResult?.error,
          "Test timed out after 1s",
        );
      });
    } finally {
      if (oldHome === undefined) Deno.env.delete("HOME");
      else Deno.env.set("HOME", oldHome);
      rmSync(home, { recursive: true, force: true });
    }
  },
});

Deno.test({
  ...testOpts,
  name: "create_changeset requires acceptance criteria and verification plan",
  fn: async () => {
    await withKernel(async (kernel) => {
      const result = await dispatchTool(
        "create_changeset",
        {
          title: "Incomplete plan",
          plan: {
            summary: "Missing durable verification metadata.",
            steps: ["Implement feature"],
          },
        },
        kernel,
        noop,
      );

      assertEquals(result.ok, false);
      assertEquals(result.error?.code, "INVALID_CHANGESET_PLAN");
      assertStringIncludes(
        result.error?.message ?? "",
        "acceptance criterion",
      );
    });
  },
});

Deno.test({
  ...testOpts,
  name: "create_changeset preserves formal spec discriminant",
  fn: async () => {
    await withKernel(async (kernel) => {
      const result = await dispatchTool(
        "create_changeset",
        {
          title: "Handle actions",
          plan: {
            summary: "Handle every action variant.",
            steps: ["Add exhaustive action handling"],
            acceptanceCriteria: [{
              id: "claim_actions",
              text: "Action variants are handled exhaustively.",
              source: "user",
              priority: "must",
            }],
            verificationPlan: [{
              id: "check_actions",
              claimIds: ["claim_actions"],
              kind: "invariant",
              description: "Verify the discriminated union guard.",
            }],
            formalSpecs: [{
              id: "spec_actions",
              claimIds: ["claim_actions"],
              technique: "discriminated-union",
              scope: "function:handleAction",
              discriminant: "action.type",
              statement: "Action handling switches over the discriminant.",
              enforcement: "hard",
            }],
          },
        },
        kernel,
        noop,
      );

      assertEquals(result.ok, true);
      const cs = result.data as {
        plan: { formalSpecs?: Array<{ discriminant?: string }> };
      };
      assertEquals(cs.plan.formalSpecs?.[0]?.discriminant, "action.type");
    });
  },
});

Deno.test({
  ...testOpts,
  name: "record_verification_run appends proof evidence to a changeset",
  fn: async () => {
    await withKernel(async (kernel) => {
      const created = await dispatchTool(
        "create_changeset",
        {
          title: "Add proof",
          plan: {
            summary: "Plan with verification",
            steps: ["Implement feature"],
            acceptanceCriteria: [
              {
                id: "claim_feature",
                text: "Feature behavior is present.",
                source: "user",
                priority: "must",
              },
            ],
            verificationPlan: [
              {
                id: "check_tests",
                claimIds: ["claim_feature"],
                kind: "unit",
                description: "Run targeted unit test.",
              },
            ],
          },
        },
        kernel,
        noop,
      );
      assertEquals(created.ok, true);
      const changeset = created.data as { id: string };

      const recorded = await dispatchTool(
        "record_verification_run",
        {
          changeset_id: changeset.id,
          status: "passed",
          summary: "Verified with targeted unit test.",
          evidence: [
            {
              id: "evidence_tests",
              kind: "test_result",
              status: "passed",
              summary: "testFeature passed.",
              checkId: "check_tests",
            },
          ],
          claimResults: [
            {
              claimId: "claim_feature",
              status: "passed",
              evidenceIds: ["evidence_tests"],
            },
          ],
          residualRisks: [],
        },
        kernel,
        noop,
      );

      assertEquals(recorded.ok, true);
      const updated = await kernel.changesets.get(changeset.id);
      assertEquals(updated?.plan.acceptanceCriteria?.[0]?.id, "claim_feature");
      assertEquals(updated?.plan.verificationPlan?.[0]?.id, "check_tests");
      assertEquals(updated?.plan.verificationRuns?.length, 1);
      assertEquals(updated?.plan.verificationRuns?.[0]?.status, "passed");
      assertEquals(
        updated?.plan.verificationRuns?.[0]?.evidence[0]?.id,
        "evidence_tests",
      );
      assertEquals(
        updated?.plan.verificationRuns?.[0]?.claimResults[0]?.claimId,
        "claim_feature",
      );
      // §4.3: `data` is the acknowledgement, not the changeset. The full object is
      // still on `_changeset` for the IDE — dropping that without un-slimming `data`
      // makes changeset-timeline.ts return null and the card vanish with no error.
      assertEquals(recorded.data, {
        id: changeset.id,
        // The changeset's status, not the run's — this one was never started, which
        // is also why the hint is blocked. The hint is the cheap synchronous gate
        // verdict; complete_changeset still runs the project-aware one for real.
        status: "planning",
        runId: updated?.plan.verificationRuns?.[0]?.id,
        claimResults: [{ claimId: "claim_feature", status: "passed" }],
        evidenceCount: 1,
        readinessHint: "blocked: CHANGESET_NOT_IN_PROGRESS, INCOMPLETE_STEPS",
      });
      assertEquals(
        (recorded as { _changeset?: { plan?: { steps?: unknown } } })._changeset
          ?.plan?.steps,
        updated?.plan.steps,
      );
    });
  },
});

Deno.test({
  ...testOpts,
  name: "check_changeset_readiness reports missing verification actions",
  fn: async () => {
    await withKernel(async (kernel) => {
      const created = await dispatchTool(
        "create_changeset",
        {
          title: "Readiness check",
          plan: {
            summary: "Plan with verification metadata",
            steps: ["Implement feature"],
            acceptanceCriteria: [{
              id: "claim_feature",
              text: "Feature behavior is present.",
              source: "user",
              priority: "must",
            }],
            verificationPlan: [{
              id: "check_tests",
              claimIds: ["claim_feature"],
              kind: "unit",
              description: "Run targeted unit test.",
            }],
          },
        },
        kernel,
        noop,
      );
      assertEquals(created.ok, true);
      const changeset = created.data as {
        id: string;
        plan: { steps: Array<{ id: string }> };
      };
      await kernel.changesets.approve(changeset.id);
      await kernel.changesets.startWork(changeset.id);
      await kernel.changesets.updateStep(
        changeset.id,
        changeset.plan.steps[0]!.id,
        "done",
      );

      const checked = await dispatchTool(
        "check_changeset_readiness",
        { changeset_id: changeset.id },
        kernel,
        noop,
      );

      assertEquals(checked.ok, true);
      const data = checked.data as {
        passed: boolean;
        errors: Array<{ code: string; action: string }>;
      };
      assertEquals(data.passed, false);
      assertEquals(
        data.errors.some((issue) =>
          issue.code === "MISSING_VERIFICATION_RUN" &&
          issue.action.includes("record_verification_run")
        ),
        true,
      );
    });
  },
});

Deno.test({
  ...testOpts,
  name: "check_changeset_readiness passes after verification is recorded",
  fn: async () => {
    await withKernel(async (kernel) => {
      const created = await dispatchTool(
        "create_changeset",
        {
          title: "Readiness pass",
          plan: {
            summary: "Plan with verification metadata",
            steps: ["Implement feature"],
            acceptanceCriteria: [{
              id: "claim_feature",
              text: "Feature behavior is present.",
              source: "user",
              priority: "must",
            }],
            verificationPlan: [{
              id: "check_tests",
              claimIds: ["claim_feature"],
              kind: "unit",
              description: "Run targeted unit test.",
            }],
          },
        },
        kernel,
        noop,
      );
      assertEquals(created.ok, true);
      const changeset = created.data as {
        id: string;
        plan: { steps: Array<{ id: string }> };
      };
      await kernel.changesets.approve(changeset.id);
      await kernel.changesets.startWork(changeset.id);
      await kernel.changesets.updateStep(
        changeset.id,
        changeset.plan.steps[0]!.id,
        "done",
      );

      const recorded = await dispatchTool(
        "record_verification_run",
        {
          changeset_id: changeset.id,
          status: "passed",
          summary: "Verified with targeted unit test.",
          evidence: [{
            id: "evidence_tests",
            kind: "test_result",
            status: "passed",
            summary: "testFeature passed.",
            checkId: "check_tests",
          }],
          claimResults: [{
            claimId: "claim_feature",
            status: "passed",
            evidenceIds: ["evidence_tests"],
          }],
          residualRisks: [],
        },
        kernel,
        noop,
      );
      assertEquals(recorded.ok, true);

      const checked = await dispatchTool(
        "check_changeset_readiness",
        { changeset_id: changeset.id },
        kernel,
        noop,
      );

      assertEquals(checked.ok, true);
      const data = checked.data as {
        passed: boolean;
        summary: string;
        errors: unknown[];
      };
      assertEquals(data.passed, true);
      assertEquals(data.errors.length, 0);
      assertStringIncludes(data.summary, "ready");
    });
  },
});

Deno.test({
  ...testOpts,
  name: "record_verification_run requires evidence and claim results",
  fn: async () => {
    await withKernel(async (kernel) => {
      const created = await dispatchTool(
        "create_changeset",
        {
          title: "Add proof",
          plan: {
            summary: "Plan with verification",
            steps: ["Implement feature"],
            acceptanceCriteria: ["Feature behavior is present."],
            verificationPlan: [{
              id: "check_tests",
              claimIds: ["claim_0"],
              kind: "unit",
              description: "Run targeted unit test.",
            }],
          },
        },
        kernel,
        noop,
      );
      assertEquals(created.ok, true);
      const changeset = created.data as { id: string };

      const recorded = await dispatchTool(
        "record_verification_run",
        {
          changeset_id: changeset.id,
          status: "passed",
          summary: "No evidence.",
          evidence: [],
          claimResults: [],
          residualRisks: [],
        },
        kernel,
        noop,
      );

      assertEquals(recorded.ok, false);
      assertEquals(recorded.error?.code, "INVALID_VERIFICATION_RUN");
      assertStringIncludes(recorded.error?.message ?? "", "evidence");
    });
  },
});

Deno.test({
  ...testOpts,
  name:
    "record_verification_run rejects claim evidence references that are not evidence ids",
  fn: async () => {
    await withKernel(async (kernel) => {
      const created = await dispatchTool(
        "create_changeset",
        {
          title: "Add proof",
          plan: {
            summary: "Plan with verification",
            steps: ["Implement feature"],
            acceptanceCriteria: [{
              id: "claim_feature",
              text: "Feature behavior is present.",
              source: "user",
              priority: "must",
            }],
            verificationPlan: [{
              id: "check_tests",
              claimIds: ["claim_feature"],
              kind: "unit",
              description: "Run targeted unit test.",
            }],
          },
        },
        kernel,
        noop,
      );
      assertEquals(created.ok, true);
      const changeset = created.data as { id: string };

      const baseInput = {
        changeset_id: changeset.id,
        status: "passed",
        summary: "Verified with targeted unit test.",
        evidence: [{
          id: "evidence_tests",
          kind: "unit",
          status: "passed",
          summary: "testFeature passed.",
          checkId: "check_tests",
          attestationId: "att_tests",
        }],
        residualRisks: [],
      };

      const cases: Array<[string, string]> = [
        ["check_tests", "not verificationPlan checkId values"],
        ["att_tests", "not attestationId values"],
        ["missing_evidence", "reference missing evidence item"],
      ];

      for (const [evidenceId, expectedMessage] of cases) {
        const recorded = await dispatchTool(
          "record_verification_run",
          {
            ...baseInput,
            claimResults: [{
              claimId: "claim_feature",
              status: "passed",
              evidenceIds: [evidenceId],
            }],
          },
          kernel,
          noop,
        );

        assertEquals(recorded.ok, false);
        assertEquals(recorded.error?.code, "INVALID_VERIFICATION_RUN");
        assertStringIncludes(recorded.error?.message ?? "", expectedMessage);
      }

      assertEquals(
        (await kernel.changesets.get(changeset.id))?.plan.verificationRuns
          ?.length ?? 0,
        0,
      );
    });
  },
});

Deno.test({
  ...testOpts,
  name:
    "record_verification_run accepts claim evidence references to evidence ids",
  fn: async () => {
    await withKernel(async (kernel) => {
      const created = await dispatchTool(
        "create_changeset",
        {
          title: "Add proof",
          plan: {
            summary: "Plan with verification",
            steps: ["Implement feature"],
            acceptanceCriteria: [{
              id: "claim_feature",
              text: "Feature behavior is present.",
              source: "user",
              priority: "must",
            }],
            verificationPlan: [{
              id: "check_tests",
              claimIds: ["claim_feature"],
              kind: "unit",
              description: "Run targeted unit test.",
            }],
          },
        },
        kernel,
        noop,
      );
      assertEquals(created.ok, true);
      const changeset = created.data as { id: string };

      const recorded = await dispatchTool(
        "record_verification_run",
        {
          changeset_id: changeset.id,
          status: "passed",
          summary: "Verified with targeted unit test.",
          evidence: [{
            id: "evidence_tests",
            kind: "unit",
            status: "passed",
            summary: "testFeature passed.",
            checkId: "check_tests",
            attestationId: "att_tests",
          }],
          claimResults: [{
            claimId: "claim_feature",
            status: "passed",
            evidenceIds: ["evidence_tests"],
          }],
          residualRisks: [],
        },
        kernel,
        noop,
      );

      assertEquals(recorded.ok, true);
      assertEquals(
        (await kernel.changesets.get(changeset.id))?.plan.verificationRuns
          ?.length,
        1,
      );
    });
  },
});

Deno.test({
  ...testOpts,
  name: "complete_changeset requires a recorded verification run",
  fn: async () => {
    // A verification-only assembly (no agent): the readiness gate is a
    // verification concern, so this isolates it from the optional agent-backed
    // auto-refute — which keeps the test hermetic regardless of whether an API
    // key sits in ambient config (no agent ⇒ the gate's auto-refute never fires).
    await withKernel(async (kernel) => {
      const created = await dispatchTool(
        "create_changeset",
        {
          title: "Complete with proof",
          plan: {
            summary: "Plan with required verification metadata.",
            steps: ["Implement feature"],
            acceptanceCriteria: ["Feature behavior is present."],
            verificationPlan: [{
              id: "check_tests",
              claimIds: ["claim_0"],
              kind: "unit",
              description: "Run targeted unit test.",
            }],
          },
        },
        kernel,
        noop,
      );
      assertEquals(created.ok, true);
      const changeset = created.data as { id: string };
      await kernel.changesets.approve(changeset.id);
      await kernel.changesets.startWork(changeset.id);

      const completed = await dispatchTool(
        "complete_changeset",
        { changeset_id: changeset.id },
        kernel,
        noop,
      );

      assertEquals(completed.ok, false);
      assertEquals(completed.error?.code, "INCOMPLETE_VERIFICATION");
      assertStringIncludes(completed.error?.message ?? "", "verification run");
    }, verificationOnlyComposition());
  },
});

Deno.test({
  ...testOpts,
  name: "complete_changeset persists aggregated token usage",
  fn: async () => {
    await withKernel(async (kernel) => {
      const session = await kernel.sessions.createSession("Usage Changeset");
      const created = await dispatchTool(
        "create_changeset",
        {
          title: "Complete with usage",
          plan: {
            summary: "Plan with token usage.",
            steps: ["Implement feature"],
            acceptanceCriteria: ["Feature behavior is present."],
            verificationPlan: [{
              id: "check_tests",
              claimIds: ["claim_0"],
              kind: "unit",
              description: "Run targeted unit test.",
            }],
          },
        },
        kernel,
        noop,
      );
      assertEquals(created.ok, true);
      const changeset = created.data as {
        id: string;
        plan: { steps: Array<{ id: string }> };
      };

      await kernel.changesets.approve(changeset.id);
      await kernel.changesets.startWork(changeset.id);
      await kernel.changesets.updateStep(
        changeset.id,
        changeset.plan.steps[0]!.id,
        "done",
      );
      await kernel.changesets.recordVerificationRun(changeset.id, {
        status: "passed",
        summary: "Verified with targeted unit test.",
        evidence: [{
          id: "evidence_tests",
          kind: "test_result",
          status: "passed",
          summary: "testFeature passed.",
          checkId: "check_tests",
          createdAt: "2026-09-11T10:00:02.000Z",
        }],
        claimResults: [{
          claimId: "claim_0",
          status: "passed",
          evidenceIds: ["evidence_tests"],
        }],
        residualRisks: [],
      });
      await kernel.changelog.record({
        category: "handler",
        key: "completeUsage",
        action: "update",
        beforeSnapshot: null,
        afterSnapshot: { source: "export function completeUsage() {}" },
        context: {
          turnId: "turn_usage_complete",
          changesetId: changeset.id,
          userMessage: "complete with usage",
        },
      });
      await kernel.sessions.recordModelUsage({
        sessionId: session.id,
        turnId: "turn_usage_complete",
        changesetId: changeset.id,
        provider: "anthropic",
        model: "usage-test-model",
        role: "agent",
        caller: "chat_turn",
        startedAt: "2026-09-11T10:00:00.000Z",
        endedAt: "2026-09-11T10:00:02.000Z",
        usage: {
          inputTokens: 1200,
          outputTokens: 300,
          cacheCreationInputTokens: 200,
          cacheReadInputTokens: 4000,
        },
      });

      const completed = await dispatchTool(
        "complete_changeset",
        { changeset_id: changeset.id },
        kernel,
        noop,
        { sessionId: session.id, changesetId: changeset.id },
      );

      assertEquals(completed.ok, true);
      // §4.3: the success payload is an acknowledgement, not the aggregate. Usage is
      // read from the store (and from `_changeset`, which the IDE resolves first).
      // `stateFlushed` reports whether the registries reached disk: completion flushes
      // best-effort, and a silent failure there is the difference between work that
      // survives the process and work that does not. False here because this kernel has
      // no projectDir, so there is no state directory to write.
      assertEquals(completed.data, {
        id: changeset.id,
        status: "completed",
        title: "Complete with usage",
        stepCount: 1,
        completedAt: (await kernel.changesets.get(changeset.id))?.completedAt,
        stateFlushed: false,
        commit: { committed: false, reason: "no_project" },
      });
      const expectedUsage = {
        inputTokens: 1200,
        cacheCreationInputTokens: 200,
        cacheReadInputTokens: 4000,
        outputTokens: 300,
        costUsd: 0,
        pricingStatus: "unpriced" as const,
        unpricedCalls: 1,
        unpricedInputTokens: 1200,
        unpricedOutputTokens: 300,
        durationMs: 2000,
      };
      const stored = await kernel.changesets.get(changeset.id);
      assertEquals(stored?.tokenUsage, expectedUsage);
      assertEquals(
        (completed as { _changeset?: { tokenUsage?: unknown } })._changeset
          ?.tokenUsage,
        expectedUsage,
      );
    }, verificationOnlyComposition());
  },
});

Deno.test({
  ...testOpts,
  name: "complete_changeset blocks project consistency errors",
  fn: async () => {
    await withKernel(async (kernel) => {
      const projectDir = mkdtempSync(join(tmpdir(), "tideide-readiness-"));
      try {
        kernel.projectDir = projectDir;
        writeFileSync(
          join(projectDir, "opentide.json"),
          JSON.stringify({
            name: "Consistency",
            createdAt: "2026-01-01T00:00:00.000Z",
          }) + "\n",
        );
        const migrationsDir = join(
          projectDir,
          ".opentide",
          "state",
          "schemas",
          "migrations",
        );
        Deno.mkdirSync(migrationsDir, { recursive: true });
        writeFileSync(
          join(migrationsDir, "agent_events.json"),
          JSON.stringify(
            [{
              id: 1,
              tableName: "agent_events",
              version: 1,
              sql: "CREATE TABLE agent_events (id SERIAL PRIMARY KEY)",
              reverseSql: 'DROP TABLE IF EXISTS "agent_events"',
              reversible: true,
              columnsBefore: [],
              columnsAfter: [],
              appliedAt: "2026-01-01T00:00:00.000Z",
              rolledBackAt: null,
              turnId: null,
            }],
            null,
            2,
          ) + "\n",
        );

        const created = await dispatchTool(
          "create_changeset",
          {
            title: "Complete with consistency issue",
            plan: {
              summary: "Plan with required verification metadata.",
              steps: ["Implement feature"],
              acceptanceCriteria: ["Feature behavior is present."],
              verificationPlan: [{
                id: "check_tests",
                claimIds: ["claim_0"],
                kind: "unit",
                description: "Run targeted unit test.",
              }],
            },
          },
          kernel,
          noop,
        );
        assertEquals(created.ok, true);
        const changeset = created.data as {
          id: string;
          plan: { steps: Array<{ id: string }> };
        };
        await kernel.changesets.approve(changeset.id);
        await kernel.changesets.startWork(changeset.id);
        await kernel.changesets.updateStep(
          changeset.id,
          changeset.plan.steps[0]!.id,
          "done",
        );
        const recorded = await dispatchTool(
          "record_verification_run",
          {
            changeset_id: changeset.id,
            status: "passed",
            summary: "Verified with targeted unit test.",
            evidence: [{
              id: "evidence_tests",
              kind: "test_result",
              status: "passed",
              summary: "testFeature passed.",
              checkId: "check_tests",
            }],
            claimResults: [{
              claimId: "claim_0",
              status: "passed",
              evidenceIds: ["evidence_tests"],
            }],
            residualRisks: [],
          },
          kernel,
          noop,
        );
        assertEquals(recorded.ok, true);

        const completed = await dispatchTool(
          "complete_changeset",
          { changeset_id: changeset.id },
          kernel,
          noop,
        );

        assertEquals(completed.ok, false);
        assertEquals(completed.error?.code, "INCOMPLETE_VERIFICATION");
        assertStringIncludes(
          completed.error?.message ?? "",
          "PROJECT_CONSISTENCY_ERRORS",
        );
      } finally {
        rmSync(projectDir, { recursive: true, force: true });
      }
    }, verificationOnlyComposition());
  },
});

Deno.test({
  ...testOpts,
  name: "remove_* tools require an approved changeset",
  fn: async () => {
    await withKernel(async (kernel) => {
      kernel.types.register("Thing", [{ name: "id", type: "string" }]);
      kernel.devViews.register(
        "thingView",
        "Thing",
        "Thing",
        "function thingView() { return { type: 'stack', children: [] }; }",
        () => ({ type: "stack", children: [] }),
      );
      kernel.devTools.register(
        "thingTool",
        "Tool",
        [],
        "function thingTool() { return {}; }",
        () => ({}),
      );
      kernel.tests.register(
        "thingTest",
        "async function thingTest() {}",
        async () => {},
      );
      kernel.customAudits.register("thingAudit", "Audit", "Review the app.");

      for (
        const [tool, input] of [
          ["remove_type", { name: "Thing" }],
          ["remove_dev_view", { name: "thingView" }],
          ["remove_dev_tool", { name: "thingTool" }],
          ["remove_test", { name: "thingTest" }],
          ["remove_audit", { name: "thingAudit" }],
          ["define_audit", {
            name: "newAudit",
            description: "Audit",
            prompt: "Review the app.",
          }],
        ] as const
      ) {
        assertEquals(isMutationTool(tool), true);
        const result = await dispatchTool(tool, input, kernel, noop);
        assertEquals(result.ok, false);
        assertEquals(result.error?.code, "CHANGESET_REQUIRED");
      }
    });
  },
});

Deno.test({
  ...testOpts,
  name:
    "create_changeset ignores agent-supplied attestations (provenance guard)",
  fn: async () => {
    await withKernel(async (kernel) => {
      const session = await kernel.sessions.createSession("Guard Session");
      const result = await dispatchTool(
        "create_changeset",
        {
          title: "Attempt to inject proof",
          plan: {
            summary: "Try to smuggle a fake attestation.",
            steps: ["Do the work"],
            acceptanceCriteria: ["It works."],
            verificationPlan: [{
              id: "check_0",
              claimIds: ["claim_0"],
              kind: "unit",
              description: "Assert behavior.",
            }],
            // A forged attestation must NOT survive into the stored plan.
            attestations: [{
              id: "att_forged",
              kind: "invariant",
              status: "passed",
              fingerprint: "forged",
              scope: "handler:x",
              checkId: "spec_x",
              summary: "forged",
              createdAt: "2026-01-01T00:00:00.000Z",
            }],
          },
        },
        kernel,
        noop,
        { sessionId: session.id },
      );
      assertEquals(result.ok, true);
      const cs = result.data as { id: string };
      const stored = await kernel.changesets.get(cs.id);
      assertEquals(stored?.plan.attestations, undefined);
    });
  },
});

Deno.test({
  ...testOpts,
  name:
    "create_changeset ignores agent-supplied independentCriteria (provenance guard)",
  fn: async () => {
    await withKernel(async (kernel) => {
      const session = await kernel.sessions.createSession("Criteria Guard");
      const result = await dispatchTool(
        "create_changeset",
        {
          title: "Attempt to self-certify",
          plan: {
            summary: "Try to smuggle in a flattering independent review.",
            steps: ["Do the work"],
            acceptanceCriteria: ["It works."],
            verificationPlan: [{
              id: "check_0",
              claimIds: ["claim_0"],
              kind: "unit",
              description: "Assert behavior.",
            }],
            // The entire value of an independent criterion is that the
            // implementing agent did not write it. One it CAN write is worth
            // nothing, and worse than nothing if it clears a readiness finding —
            // so this must not survive into the stored plan.
            independentCriteria: [{
              id: "icr_forged",
              text: "Everything the user wanted is already handled.",
              priority: "must",
              rationale: "Trust me.",
              coveredBy: "claim_0",
            }],
          },
        },
        kernel,
        noop,
        { sessionId: session.id },
      );
      assertEquals(result.ok, true);
      const cs = result.data as { id: string };
      const stored = await kernel.changesets.get(cs.id);
      assertEquals(stored?.plan.independentCriteria, undefined);
    });
  },
});

Deno.test({
  ...testOpts,
  name:
    "run_tests mints a test attestation on the active changeset and returns its id",
  fn: async () => {
    await withKernel(async (kernel) => {
      const session = await kernel.sessions.createSession("Mint Session");
      const cs = await kernel.changesets.create({
        sessionId: session.id,
        title: "Minting",
        plan: {
          summary: "s",
          steps: [{ id: "s1", description: "step", status: "done" }],
          acceptanceCriteria: [{
            id: "claim_0",
            text: "works",
            source: "agent",
            priority: "must",
          }],
          verificationPlan: [{
            id: "c0",
            claimIds: ["claim_0"],
            kind: "unit",
            description: "Run the test.",
          }],
        },
      });
      await kernel.changesets.approve(cs.id);
      await kernel.changesets.startWork(cs.id);
      kernel.tests.register("t_pass", "async () => {}", async () => {});

      const result = await dispatchTool("run_tests", {}, kernel, noop, {
        sessionId: session.id,
        changesetId: cs.id,
      });
      assertEquals(result.ok, true);

      const stored = await kernel.changesets.get(cs.id);
      const atts = stored?.plan.attestations ?? [];
      assertEquals(atts.length, 1);
      assertEquals(atts[0]?.kind, "test");
      assertEquals(atts[0]?.status, "passed");
      assertEquals(atts[0]?.scope, "project");
      // Returned so an agent can cite it from record_verification_run.
      assertEquals(
        (result.data as { attestationId?: string }).attestationId,
        atts[0]?.id,
      );
    });
  },
});

// --- Stage 7: apply_rename (the atomic cross-entity rename verb) ---
// docs/lsp-support-plan.md Stage 7. The LSP rename path feeds this verb the resulting
// per-entity sources; it persists them all-or-nothing under one turnId. These tests pin
// the three exit-criterion behaviors at the tool boundary: atomic multi-entity apply +
// single reversible turn, whole-rename rejection on a QC failure, and the entity-name
// rename (register-new + retire-old + rebind-routes) round-trip.

const FN_CALC = "function calcTax(x) {\n  return x * 1.1;\n}\n";
const HANDLER_A = "function getUsers(c) {\n  return c.json([]);\n}\n";
const HANDLER_B =
  "function deleteWidget(c) {\n  const id = c.req.param('id');\n  return c.text('removed ' + id);\n}\n";

async function seedFunction(kernel: Kernel, name: string, source: string) {
  const r = await dispatchTool(
    "define_function",
    { name, source },
    kernel,
    noop,
    {
      manualEdit: true,
    },
  );
  assert(r.ok, `seed function ${name}: ${r.error?.message}`);
}

async function seedHandler(kernel: Kernel, name: string, source: string) {
  const r = await dispatchTool(
    "define_handler",
    { name, source },
    kernel,
    noop,
    {
      manualEdit: true,
    },
  );
  assert(r.ok, `seed handler ${name}: ${r.error?.message}`);
}

Deno.test({
  ...testOpts,
  name:
    "apply_rename: a symbol rename updates every entity atomically in one turn",
  fn: async () => {
    await withKernel(async (kernel) => {
      await seedFunction(kernel, "calcTax", FN_CALC);
      await seedHandler(kernel, "getUsers", HANDLER_A);
      await seedHandler(kernel, "deleteWidget", HANDLER_B);

      // The renamed sources the LSP path would have computed; the handlers get a fresh
      // valid body to prove the multi-entity commit lands as one turn.
      const fnNew = "function computeTax(x) {\n  return x * 1.1;\n}\n";
      const aNew = "function getUsers(c) {\n  return c.json([1]);\n}\n";
      const bNew =
        "function deleteWidget(c) {\n  const id = c.req.param('id');\n  return c.text('gone ' + id);\n}\n";
      const result = await dispatchTool(
        "apply_rename",
        {
          turnId: "rename_1",
          edits: [
            { entityType: "function", name: "computeTax", source: fnNew },
            { entityType: "handler", name: "getUsers", source: aNew },
            { entityType: "handler", name: "deleteWidget", source: bNew },
          ],
        },
        kernel,
        noop,
      );
      assert(
        result.ok,
        `apply_rename should succeed: ${result.error?.message}`,
      );

      assertEquals(kernel.functions.getEntry("computeTax")?.source, fnNew);
      assertEquals(kernel.handlers.get("getUsers")?.source, aNew);
      assertEquals(kernel.handlers.get("deleteWidget")?.source, bNew);

      // Every changelog entry shares the one turnId → one reversible turn.
      const records = await kernel.changelog.list({ turnId: "rename_1" });
      assertEquals(records.length, 3);
      assert(records.every((r) => r.turnId === "rename_1"));

      // undo_turn reverses the WHOLE rename in one shot.
      const undo = await dispatchTool("undo_turn", {}, kernel, noop);
      assert(undo.ok);
      assertEquals(kernel.handlers.get("getUsers")?.source, HANDLER_A);
      assertEquals(kernel.handlers.get("deleteWidget")?.source, HANDLER_B);
    });
  },
});

Deno.test({
  ...testOpts,
  name:
    "apply_rename: a QC failure on ONE entity rejects the whole rename (nothing changed)",
  fn: async () => {
    await withKernel(async (kernel) => {
      await seedFunction(kernel, "calcTax", FN_CALC);
      await seedHandler(kernel, "getUsers", HANDLER_A);

      // The second edit trips an error-level QC rule (no-eval), so QC blocks it — and the
      // first edit must NOT be applied either.
      const fnNew = "function computeTax(x) {\n  return x * 1.1;\n}\n";
      const bad =
        "function getUsers(c) {\n  eval('1');\n  return c.json([]);\n}\n";
      const result = await dispatchTool(
        "apply_rename",
        {
          turnId: "rename_bad",
          edits: [
            { entityType: "function", name: "computeTax", source: fnNew },
            { entityType: "handler", name: "getUsers", source: bad },
          ],
        },
        kernel,
        noop,
      );
      assertEquals(result.ok, false);
      assertEquals(result.error?.code, "RENAME_REJECTED");
      const failures =
        (result.data as { failures: Array<{ name: string; code: string }> })
          .failures;
      assert(
        failures.some((f) => f.name === "getUsers" && f.code === "QC_FAILED"),
      );

      // Nothing half-applied: computeTax was never created, getUsers is untouched.
      assertEquals(kernel.functions.getEntry("computeTax"), undefined);
      assertEquals(kernel.handlers.get("getUsers")?.source, HANDLER_A);
      // No changelog turn was recorded for the rejected rename.
      assertEquals(
        (await kernel.changelog.list({ turnId: "rename_bad" })).length,
        0,
      );
    });
  },
});

Deno.test({
  ...testOpts,
  name:
    "apply_rename: entity-name rename (function) registers new, retires old, round-trips",
  fn: async () => {
    await withKernel(async (kernel) => {
      await seedFunction(kernel, "calcTax", FN_CALC);
      await seedHandler(
        kernel,
        "getUsers",
        "function getUsers(c) {\n  return c.json(calcTax(1));\n}\n",
      );

      const renamedFn = "function computeTax(x) {\n  return x * 1.1;\n}\n";
      const handlerRefRewritten =
        "function getUsers(c) {\n  return c.json(computeTax(1));\n}\n";
      const result = await dispatchTool(
        "apply_rename",
        {
          turnId: "rename_entity",
          edits: [{
            entityType: "handler",
            name: "getUsers",
            source: handlerRefRewritten,
          }],
          rename: {
            entityType: "function",
            from: "calcTax",
            to: "computeTax",
            source: renamedFn,
          },
        },
        kernel,
        noop,
      );
      assert(
        result.ok,
        `entity rename should succeed: ${result.error?.message}`,
      );

      // New key created, old key retired, reference rewritten.
      assertEquals(kernel.functions.getEntry("computeTax")?.source, renamedFn);
      assertEquals(kernel.functions.getEntry("calcTax"), undefined);
      assertEquals(
        kernel.handlers.get("getUsers")?.source,
        handlerRefRewritten,
      );

      // A3: the rename is ONE reversible `rename` entry keyed by the new name,
      // carrying renamedFrom — NOT a create(new)+delete(old) pair.
      const records = await kernel.changelog.list({ turnId: "rename_entity" });
      const renameRec = records.find((r) =>
        r.category === "function" && r.key === "computeTax" &&
        r.action === "rename"
      );
      assert(
        renameRec,
        "expected one function rename record keyed by computeTax",
      );
      assertEquals(renameRec?.context?.renamedFrom, "calcTax");
      // No standalone delete(old) or create(new) for the renamed entity.
      assert(
        !records.some((r) =>
          r.category === "function" && r.action === "delete"
        ),
        "rename must not emit a delete record",
      );
      assert(
        !records.some((r) =>
          r.category === "function" && r.key === "computeTax" &&
          r.action === "create"
        ),
        "rename must not emit a create record for the new key",
      );

      // undo_turn re-registers calcTax, drops computeTax, reverts the handler.
      const undo = await dispatchTool("undo_turn", {}, kernel, noop);
      assert(undo.ok);
      assertEquals(kernel.functions.getEntry("calcTax")?.source, FN_CALC);
      assertEquals(kernel.functions.getEntry("computeTax"), undefined);
      assertStringIncludes(
        kernel.handlers.get("getUsers")?.source ?? "",
        "calcTax(1)",
      );
    });
  },
});

Deno.test({
  ...testOpts,
  name: "apply_rename: renaming a handler rebinds its routes to the new key",
  fn: async () => {
    await withKernel(async (kernel) => {
      await seedHandler(
        kernel,
        "oldHandler",
        "function oldHandler(c) {\n  return c.json([]);\n}\n",
      );
      const bind = await dispatchTool(
        "register_route",
        {
          handlerName: "oldHandler",
          method: "GET",
          path: "/api/things",
        },
        kernel,
        noop,
        { manualEdit: true },
      );
      assert(bind.ok, `route bind: ${bind.error?.message}`);

      const result = await dispatchTool(
        "apply_rename",
        {
          turnId: "rename_handler",
          edits: [],
          rename: {
            entityType: "handler",
            from: "oldHandler",
            to: "newHandler",
            source: "function newHandler(c) {\n  return c.json([]);\n}\n",
          },
        },
        kernel,
        noop,
      );
      assert(
        result.ok,
        `handler rename should succeed: ${result.error?.message}`,
      );

      assertEquals(kernel.handlers.get("oldHandler"), undefined);
      assert(kernel.handlers.get("newHandler"));
      // The route now points at the new handler — no orphaned route.
      assertEquals(
        kernel.routes.get("GET", "/api/things")?.handlerName,
        "newHandler",
      );
    });
  },
});

Deno.test({
  ...testOpts,
  name:
    "apply_rename: renaming onto an existing name is rejected (collision guard)",
  fn: async () => {
    await withKernel(async (kernel) => {
      await seedFunction(kernel, "calcTax", FN_CALC);
      await seedFunction(
        kernel,
        "computeTax",
        "function computeTax(x) {\n  return x;\n}\n",
      );

      const result = await dispatchTool(
        "apply_rename",
        {
          turnId: "rename_collide",
          edits: [],
          rename: {
            entityType: "function",
            from: "calcTax",
            to: "computeTax",
            source: "function computeTax(x) {\n  return x * 1.1;\n}\n",
          },
        },
        kernel,
        noop,
      );
      assertEquals(result.ok, false);
      assertEquals(result.error?.code, "RENAME_REJECTED");
      // Both entities untouched.
      assertEquals(kernel.functions.getEntry("calcTax")?.source, FN_CALC);
      assertStringIncludes(
        kernel.functions.getEntry("computeTax")?.source ?? "",
        "return x;",
      );
    });
  },
});

// F-08 defense-in-depth: an asset name that isn't a single safe path segment is
// rejected at the tool boundary, before it can become a traversal in the export
// tree. (The writeExportFiles containment guard is the last line; this stops bad
// names at the door.) manualEdit context bypasses the changeset gate.
Deno.test({
  ...testOpts,
  name: "upload_text_asset rejects a path-traversal name (F-08)",
  fn: async () => {
    await withKernel(async (kernel) => {
      const ctx = { manualEdit: true };
      const bad = await dispatchTool(
        "upload_text_asset",
        { name: "../../evil.txt", content: "hi", mimeType: "text/plain" },
        kernel,
        noop,
        ctx,
      );
      assertEquals(bad.ok, false);
      if (!bad.ok) assertEquals(bad.error?.code, "INVALID_ASSET_NAME");
      assertEquals(kernel.assets.get("../../evil.txt"), undefined);

      // A plain filename still works.
      const good = await dispatchTool(
        "upload_text_asset",
        { name: "styles.css", content: "a{color:red}", mimeType: "text/css" },
        kernel,
        noop,
        ctx,
      );
      assertEquals(good.ok, true);
      assert(kernel.assets.get("styles.css") !== undefined);
    });
  },
});

Deno.test({
  ...testOpts,
  name:
    "A1: dispatch stamps authorOrigin ai for agent writes, human for manual edits",
  fn: async () => {
    await withKernel(async (kernel) => {
      const session = await kernel.sessions.createSession("A1 authorship");
      const cs = await kernel.changesets.create({
        sessionId: session.id,
        title: "A1 authorship",
        plan: {
          summary: "Stamp a binary authorOrigin on every tool-driven write.",
          steps: [{
            id: "s1",
            description: "Define a handler under the changeset.",
            status: "pending",
          }],
          acceptanceCriteria: [{
            id: "claim_origin",
            text: "An agent-driven write records authorOrigin ai.",
            source: "agent",
            priority: "must",
          }],
          verificationPlan: [{
            id: "check_origin",
            claimIds: ["claim_origin"],
            kind: "unit",
            description: "Inspect the recorded changelog origin.",
          }],
        },
      });
      await kernel.changesets.approve(cs.id);
      await kernel.changesets.startWork(cs.id);

      // Agent-style write: flows through the approved changeset, no manualEdit.
      const agentWrite = await dispatchTool(
        "define_handler",
        {
          name: "aiCreated",
          source:
            "async function aiCreated(c) { return c.json({ ok: true }); }",
          module: "a1",
          purpose: "Created by the agent.",
          schema: { summary: "AI created", tags: ["a1"] },
        },
        kernel,
        noop,
        { sessionId: session.id },
      );
      assertEquals(agentWrite.ok, true);

      // Manual-save-style write: the Code panel sets manualEdit in the same
      // session — a separate request that lands after the agent turn.
      const manualWrite = await dispatchTool(
        "define_handler",
        {
          name: "humanEdited",
          source:
            "async function humanEdited(c) { const now = Date.now(); return c.json({ editedAt: now }); }",
          module: "a1",
          purpose: "Edited by hand.",
          schema: { summary: "Human edited", tags: ["a1"] },
        },
        kernel,
        noop,
        { manualEdit: true },
      );
      assertEquals(manualWrite.ok, true);

      const [aiRecord] = await kernel.changelog.list({
        category: "handler",
        key: "aiCreated",
        limit: 1,
      });
      const [humanRecord] = await kernel.changelog.list({
        category: "handler",
        key: "humanEdited",
        limit: 1,
      });
      assertEquals(aiRecord?.context?.authorOrigin, "ai");
      assertEquals(humanRecord?.context?.authorOrigin, "human");

      // The two writes in one session are distinguishable (the A1 acceptance).
      assertEquals(
        await kernel.changelog.entityAuthorship("handler", "aiCreated"),
        "ai",
      );
      assertEquals(
        await kernel.changelog.entityAuthorship("handler", "humanEdited"),
        "human",
      );
    });
  },
});

Deno.test({
  ...testOpts,
  name:
    "A2: change records carry a stable entityUid shared across create+update",
  fn: async () => {
    await withKernel(async (kernel) => {
      const session = await kernel.sessions.createSession("A2 identity");
      const cs = await kernel.changesets.create({
        sessionId: session.id,
        title: "A2 identity",
        plan: {
          summary: "Thread a stable entityUid through an entity's history.",
          steps: [{
            id: "s1",
            description: "Create then update a handler.",
            status: "pending",
          }],
          acceptanceCriteria: [{
            id: "claim_uid",
            text: "Create and update records share one entityUid.",
            source: "agent",
            priority: "must",
          }],
          verificationPlan: [{
            id: "check_uid",
            claimIds: ["claim_uid"],
            kind: "unit",
            description: "Compare the recorded entityUids.",
          }],
        },
      });
      await kernel.changesets.approve(cs.id);
      await kernel.changesets.startWork(cs.id);

      // Agent create.
      await dispatchTool(
        "define_handler",
        {
          name: "widget",
          source: "async function widget(c) { return c.json({ v: 1 }); }",
          module: "a2",
          purpose: "Widget v1.",
          schema: { summary: "Widget", tags: ["a2"] },
        },
        kernel,
        noop,
        { sessionId: session.id },
      );
      const uid = kernel.handlers.get("widget")?.entityUid;
      assert(uid && uid.startsWith("ent_"));
      // The kernel resolves the same uid by (category, key).
      assertEquals(kernel.entityUidFor("handler", "widget"), uid);

      // Agent update (same name ⇒ update, uid preserved).
      await dispatchTool(
        "define_handler",
        {
          name: "widget",
          source:
            "async function widget(c) { const n = 2; return c.json({ v: n }); }",
          module: "a2",
          purpose: "Widget v2.",
          schema: { summary: "Widget", tags: ["a2"] },
        },
        kernel,
        noop,
        { sessionId: session.id },
      );
      assertEquals(kernel.handlers.get("widget")?.entityUid, uid);

      // Both change records carry the same entityUid, injected by the facade.
      const records = await kernel.changelog.list({
        category: "handler",
        key: "widget",
      });
      assertEquals(records.length, 2);
      assertEquals(records[0]?.context?.entityUid, uid);
      assertEquals(records[1]?.context?.entityUid, uid);

      // A hand-edit to the same entity makes its uid-keyed authorship "mixed".
      await dispatchTool(
        "define_handler",
        {
          name: "widget",
          source:
            "async function widget(c) { const s = 'x'; return c.json({ s }); }",
          module: "a2",
          purpose: "Widget v3 (hand-edited).",
          schema: { summary: "Widget", tags: ["a2"] },
        },
        kernel,
        noop,
        { manualEdit: true },
      );
      assertEquals(kernel.handlers.get("widget")?.entityUid, uid);
      assertEquals(await kernel.changelog.entityAuthorshipByUid(uid), "mixed");
    });
  },
});

// --- A3: rename as a first-class operation (Stream A) ---
// A rename carries the entity's stable entityUid across the name change and records
// ONE action:"rename" record (keyed by the new name, carrying renamedFrom), so Entity
// Survival Rate reads it as the same entity alive — not a death (old) + a birth (new).

Deno.test({
  ...testOpts,
  name:
    "A3: rename preserves the entityUid and records ONE rename op carrying renamedFrom",
  fn: async () => {
    await withKernel(async (kernel) => {
      await seedFunction(kernel, "calcTax", FN_CALC);
      const uidBefore = kernel.functions.getEntry("calcTax")?.entityUid;
      assert(uidBefore && uidBefore.startsWith("ent_"));

      const renamedFn = "function computeTax(x) {\n  return x * 1.1;\n}\n";
      const result = await dispatchTool(
        "apply_rename",
        {
          turnId: "a3_rename",
          edits: [],
          rename: {
            entityType: "function",
            from: "calcTax",
            to: "computeTax",
            source: renamedFn,
          },
        },
        kernel,
        noop,
      );
      assert(result.ok, `rename should succeed: ${result.error?.message}`);

      // The uid is UNCHANGED across the rename, and resolvable by the new name.
      const uidAfter = kernel.functions.getEntry("computeTax")?.entityUid;
      assertEquals(uidAfter, uidBefore);
      assertEquals(kernel.functions.getEntry("calcTax"), undefined);
      assertEquals(kernel.entityUidFor("function", "computeTax"), uidBefore);

      // Exactly one rename record for the entity, keyed by the NEW name, carrying
      // the prior name, the human origin, and the preserved uid.
      const records = await kernel.changelog.list({ turnId: "a3_rename" });
      const renameRecs = records.filter((r) => r.action === "rename");
      assertEquals(renameRecs.length, 1);
      const rec = renameRecs[0]!;
      assertEquals(rec.category, "function");
      assertEquals(rec.key, "computeTax");
      assertEquals(rec.context?.renamedFrom, "calcTax");
      assertEquals(rec.context?.authorOrigin, "human");
      assertEquals(rec.context?.entityUid, uidBefore);

      // No create(new) or delete(old) pair was emitted for the renamed entity.
      assert(!records.some((r) => r.action === "delete"));
      assert(
        !records.some((r) => r.key === "computeTax" && r.action === "create"),
      );

      // Authorship still resolves across the rename via the preserved uid.
      assertEquals(
        await kernel.changelog.entityAuthorshipByUid(uidBefore!),
        "human",
      );
    });
  },
});

Deno.test({
  ...testOpts,
  name:
    "A3: undo_turn round-trips a rename (restores old name, drops new) and redo re-applies",
  fn: async () => {
    await withKernel(async (kernel) => {
      await seedHandler(
        kernel,
        "oldHandler",
        "function oldHandler(c) {\n  return c.json([1]);\n}\n",
      );
      const uid = kernel.handlers.get("oldHandler")?.entityUid;
      assert(uid);

      const result = await dispatchTool(
        "apply_rename",
        {
          turnId: "a3_undo",
          edits: [],
          rename: {
            entityType: "handler",
            from: "oldHandler",
            to: "newHandler",
            source: "function newHandler(c) {\n  return c.json([1]);\n}\n",
          },
        },
        kernel,
        noop,
      );
      assert(result.ok, `rename should succeed: ${result.error?.message}`);
      assert(kernel.handlers.get("newHandler"));
      assertEquals(kernel.handlers.get("oldHandler"), undefined);

      // Undo: the old name comes back, the new name is vacated (no stale duplicate).
      const undo = await dispatchTool("undo_turn", {}, kernel, noop);
      assert(undo.ok);
      assert(kernel.handlers.get("oldHandler"));
      assertEquals(kernel.handlers.get("newHandler"), undefined);

      // Redo: the rename re-applies cleanly.
      const redo = await dispatchTool("redo_turn", {}, kernel, noop);
      assert(redo.ok);
      assert(kernel.handlers.get("newHandler"));
      assertEquals(kernel.handlers.get("oldHandler"), undefined);
    });
  },
});

// --- Document store (docs/document-store-plan.md §6) — tool-surface wiring ---

Deno.test({
  ...testOpts,
  name:
    "document_write authors + document_query reads (create is changeset-exempt)",
  fn: async () => {
    await withKernel(async (kernel) => {
      const projectDir = mkdtempSync(join(tmpdir(), "genie-doc-dispatch-"));
      kernel.projectDir = projectDir;
      try {
        // No active changeset — document_write is changeset-exempt, so create
        // succeeds rather than being blocked with CHANGESET_REQUIRED.
        const created = await dispatchTool(
          "document_write",
          {
            action: "create",
            name: "Dispatch plan",
            kind: "text/markdown",
            content: "# Plan\nvia dispatch",
            scope: "session",
            description: "the plan",
          },
          kernel,
          noop,
          { sessionId: "sess_disp" },
        );
        assert(created.ok, `create should succeed: ${created.error?.message}`);
        const doc = created.data as { id: string };

        // read with content round-trips through the tool layer.
        const read = await dispatchTool(
          "document_query",
          { action: "read", id: doc.id, includeContent: true },
          kernel,
          noop,
        );
        assert(read.ok);
        const readData = read.data as {
          document: { name: string };
          content: string;
        };
        assertEquals(readData.document.name, "Dispatch plan");
        assertEquals(readData.content, "# Plan\nvia dispatch");

        // search finds it.
        const found = await dispatchTool(
          "document_query",
          { action: "search", query: "dispatch plan" },
          kernel,
          noop,
        );
        assert(found.ok);
        assertEquals((found.data as unknown[]).length, 1);

        // pin records working-set membership for the session.
        const pinned = await dispatchTool(
          "document_pin",
          { id: doc.id, pinned: true },
          kernel,
          noop,
          { sessionId: "sess_disp" },
        );
        assert(pinned.ok);
        assertEquals(await kernel.documents.listPinned("sess_disp"), [doc.id]);
      } finally {
        rmSync(projectDir, { recursive: true, force: true });
      }
    });
  },
});

Deno.test({
  ...testOpts,
  name:
    "documents carry bytes as base64, list a session's pins and take message refs",
  fn: async () => {
    await withKernel(async (kernel) => {
      const projectDir = mkdtempSync(join(tmpdir(), "genie-doc-bytes-"));
      kernel.projectDir = projectDir;
      try {
        const session = await kernel.sessions.createSession("Docs");
        const ctx = { sessionId: session.id };
        const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
        const created = await dispatchTool(
          "document_write",
          {
            action: "create",
            name: "shot.png",
            kind: "image/png",
            content_base64: encodeBase64(bytes),
            attachment: true,
          },
          kernel,
          noop,
          ctx,
        );
        assert(created.ok, created.error?.message);
        const doc = created.data as DocumentRecord;
        assertEquals(doc.createdBy, "user");
        assertEquals(doc.metadata?.source, ATTACHMENT_DOCUMENT_SOURCE);

        const read = await dispatchTool(
          "document_query",
          {
            action: "read",
            id: doc.id,
            includeContent: true,
            encoding: "base64",
          },
          kernel,
          noop,
        );
        assert(read.ok);
        const readData = read.data as {
          contentBase64: string;
          version: { versionHash: string };
        };
        assertEquals(decodeBase64(readData.contentBase64), bytes);
        assertEquals(readData.version.versionHash, doc.currentVersionHash);

        await dispatchTool(
          "document_pin",
          { id: doc.id, pinned: true },
          kernel,
          noop,
          ctx,
        );
        const pinned = await dispatchTool(
          "document_query",
          { action: "pinned" },
          kernel,
          noop,
          ctx,
        );
        assertEquals(pinned.data, { ids: [doc.id] });

        const message = await kernel.sessions.addMessage({
          sessionId: session.id,
          role: "user",
          content: "see the shot",
        });
        const ref = await dispatchTool(
          "document_write",
          {
            action: "ref",
            id: doc.id,
            message_id: message.id,
            role: "attachment",
            versionHash: doc.currentVersionHash,
          },
          kernel,
          noop,
          ctx,
        );
        assert(ref.ok, ref.error?.message);
        const refs = await kernel.documents.listRefsByTarget(
          "message",
          String(message.id),
          "attachment",
        );
        assertEquals(refs.map((r) => r.documentId), [doc.id]);

        // A message in another session, or a role the kernel owns, is refused.
        const other = await kernel.sessions.createSession("Other");
        const foreign = await dispatchTool(
          "document_write",
          {
            action: "ref",
            id: doc.id,
            message_id: message.id,
            role: "mention",
          },
          kernel,
          noop,
          { sessionId: other.id },
        );
        assertEquals(foreign.error?.code, "MESSAGE_NOT_FOUND");
        const planRef = await dispatchTool(
          "document_write",
          { action: "ref", id: doc.id, message_id: message.id, role: "plan" },
          kernel,
          noop,
          ctx,
        );
        assertEquals(planRef.error?.code, "INVALID_INPUT");
      } finally {
        rmSync(projectDir, { recursive: true, force: true });
      }
    });
  },
});

Deno.test({
  ...testOpts,
  name: "document_query is read-only; document_pin is not a mutation gate",
  fn: () => {
    assert(READ_ONLY_TOOLS.has("document_query"));
    assertEquals(isMutationTool("document_query"), false);
    // document_write is the only document verb behind the mutation gate.
    assert(MODIFICATION_TOOLS.has("document_write"));
    // document_pin writes only a membership row — not a project mutation.
    assertEquals(isMutationTool("document_pin"), false);
    assertEquals(READ_ONLY_TOOLS.has("document_pin"), false);
  },
});

Deno.test({
  ...testOpts,
  name:
    "project file tools classify as preview read-only and apply changeset-gated",
  fn: async () => {
    await withKernel(async (kernel) => {
      const projectDir = mkdtempSync(
        join(tmpdir(), "genie-project-file-tools-"),
      );
      kernel.projectDir = projectDir;
      try {
        assert(READ_ONLY_TOOLS.has("preview_project_file"));
        assertEquals(isMutationTool("preview_project_file"), false);
        assert(MODIFICATION_TOOLS.has("apply_project_file"));
        assertEquals(isMutationTool("apply_project_file"), true);

        const blocked = await dispatchTool(
          "apply_project_file",
          {
            path: "docs/plan.md",
            content: "# Plan\n",
            baseFingerprint: null,
          },
          kernel,
          noop,
        );
        assertEquals(blocked.ok, false);
        assertEquals(blocked.error?.code, "CHANGESET_REQUIRED");
        assertEquals(existsSync(join(projectDir, "docs", "plan.md")), false);
      } finally {
        rmSync(projectDir, { recursive: true, force: true });
      }
    });
  },
});

Deno.test({
  ...testOpts,
  name: "project file tools preview, apply, record changelog, and undo",
  fn: async () => {
    await withKernel(async (kernel) => {
      const projectDir = mkdtempSync(
        join(tmpdir(), "genie-project-file-apply-"),
      );
      kernel.projectDir = projectDir;
      try {
        const preview = await dispatchTool(
          "preview_project_file",
          { path: "docs/plan.md", content: "# Plan\n\nShip it.\n" },
          kernel,
          noop,
        );
        assert(preview.ok);
        const staged = preview.data as {
          action: string;
          baseFingerprint: string | null;
          after: { path: string; content: string } | null;
        };
        assertEquals(staged.action, "create");
        assertEquals(staged.baseFingerprint, null);
        assertEquals(staged.after?.path, "docs/plan.md");
        assertEquals(existsSync(join(projectDir, "docs", "plan.md")), false);

        const applied = await dispatchTool(
          "apply_project_file",
          {
            path: "docs/plan.md",
            content: "# Plan\n\nShip it.\n",
            baseFingerprint: staged.baseFingerprint,
          },
          kernel,
          noop,
          { manualEdit: true, userMessage: "Create planning note" },
        );
        assert(applied.ok);
        assertEquals(
          readFileSync(join(projectDir, "docs", "plan.md"), "utf8"),
          "# Plan\n\nShip it.\n",
        );

        const data = applied.data as {
          change: {
            category: string;
            key: string;
            context: Record<string, unknown>;
          };
          file: { action: string };
        };
        assertEquals(data.file.action, "create");
        assertEquals(data.change.category, "module");
        assertEquals(data.change.key, "docs/plan.md");
        assertEquals(data.change.context.sourceBacked, true);
        assertEquals(data.change.context.projectFile, true);

        const undone = await dispatchTool("undo_change", {}, kernel, noop, {
          manualEdit: true,
        });
        assert(undone.ok);
        assertEquals(existsSync(join(projectDir, "docs", "plan.md")), false);
      } finally {
        rmSync(projectDir, { recursive: true, force: true });
      }
    });
  },
});

Deno.test({
  ...testOpts,
  name: "document_pin without a session returns SESSION_REQUIRED",
  fn: async () => {
    await withKernel(async (kernel) => {
      const result = await dispatchTool(
        "document_pin",
        { id: "doc_x", pinned: true },
        kernel,
        noop,
      );
      assertEquals(result.ok, false);
      assertEquals(result.error?.code, "SESSION_REQUIRED");
    });
  },
});

// --- Phase 3 Slice C-minimal: ledger evidence refs (docs/document-store-plan.md §8/§11) ---
// A minted attestation is captured as a versioned agent document + a single ledger/evidence
// ref citing the head — ADDITIVE provenance beside the authoritative ledger row. Mirrors
// Slice B's plan-capture tests shape-for-shape.

const SAMPLE_ATTESTATION = {
  id: "att_sample_1",
  kind: "test" as const,
  status: "passed" as const,
  fingerprint: "fp_deadbeef",
  scope: "project",
  summary: "3/3 passed",
  checkId: "claim_x",
};

Deno.test({
  ...testOpts,
  name:
    "captureAttestationEvidenceDocument persists an agent evidence doc + one ledger/evidence ref at the head",
  fn: async () => {
    await withKernel(async (kernel) => {
      const projectDir = await Deno.makeTempDir({
        dir: TEST_TMP_DIR,
        prefix: "tideide-dispatch-evidence-",
      });
      kernel.projectDir = projectDir;
      try {
        const session = await kernel.sessions.createSession("Evidence Session");
        const att = { ...SAMPLE_ATTESTATION, id: "att_persist_1" };

        const captured = await captureAttestationEvidenceDocument(
          kernel.documents,
          att,
          session.id,
        );
        assertEquals(captured.ok, true);
        if (!captured.ok) return;

        // The ref cites the attestation id and pins the head version.
        assertEquals(captured.data.refType, "ledger");
        assertEquals(captured.data.role, "evidence");
        assertEquals(captured.data.refId, att.id);

        const doc = await kernel.documents.findBySource(
          EVIDENCE_DOCUMENT_SOURCE,
          att.id,
          { sessionId: session.id },
        );
        assert(doc, "evidence document should exist by origin");
        assertEquals(doc.createdBy, "agent");
        assertEquals(doc.scope, "session");
        assertEquals(doc.metadata.source, EVIDENCE_DOCUMENT_SOURCE);
        assertEquals(doc.metadata.sourceId, att.id);
        // Ref pins the current head (byte-exact provenance, D2).
        assertEquals(captured.data.versionHash, doc.currentVersionHash);

        // The captured bytes render the attestation fields (kind/status/scope/
        // fingerprint/summary) — the durable snapshot beside the ledger row.
        const content = await kernel.documents.readContent(doc.id);
        assertEquals(content.ok, true);
        if (content.ok) {
          assertStringIncludes(content.data.content, att.summary);
          assertStringIncludes(content.data.content, att.fingerprint);
          assertStringIncludes(content.data.content, att.kind);
        }

        // Exactly one live ref at the head.
        const refs = await kernel.documents.listRefsByTarget(
          "ledger",
          att.id,
          "evidence",
        );
        assertEquals(refs.length, 1);
        assertEquals(refs[0]?.documentId, doc.id);
        assertEquals(refs[0]?.versionHash, doc.currentVersionHash);
      } finally {
        rmSync(projectDir, { recursive: true, force: true });
      }
    });
  },
});

Deno.test({
  ...testOpts,
  name:
    "captureAttestationEvidenceDocument is idempotent per attestation id (one live doc + one ref)",
  fn: async () => {
    await withKernel(async (kernel) => {
      const projectDir = await Deno.makeTempDir({
        dir: TEST_TMP_DIR,
        prefix: "tideide-dispatch-evidence-idem-",
      });
      kernel.projectDir = projectDir;
      try {
        const session = await kernel.sessions.createSession("Idem Session");
        const att = { ...SAMPLE_ATTESTATION, id: "att_idem_1" };

        const first = await captureAttestationEvidenceDocument(
          kernel.documents,
          att,
          session.id,
        );
        assertEquals(first.ok, true);

        // Re-mint of the SAME attestation id — a retried/duplicate mint must be a
        // clean no-op, never a second doc or a duplicate ref (origin idempotency).
        const second = await captureAttestationEvidenceDocument(
          kernel.documents,
          att,
          session.id,
        );
        assertEquals(second.ok, true);

        const docs = await kernel.documents.list({ sessionId: session.id });
        assertEquals(docs.ok, true);
        if (docs.ok) {
          const evidenceDocs = docs.data.filter((d) =>
            d.metadata.source === EVIDENCE_DOCUMENT_SOURCE &&
            d.metadata.sourceId === att.id
          );
          assertEquals(evidenceDocs.length, 1);
        }

        const refs = await kernel.documents.listRefsByTarget(
          "ledger",
          att.id,
          "evidence",
        );
        assertEquals(refs.length, 1);
      } finally {
        rmSync(projectDir, { recursive: true, force: true });
      }
    });
  },
});

Deno.test({
  ...testOpts,
  name:
    "captureAttestationEvidenceDocument degrades without a project (no throw, no doc, no ref)",
  fn: async () => {
    await withKernel(async (kernel) => {
      // No kernel.projectDir → a session-scoped document cannot be stored.
      const att = { ...SAMPLE_ATTESTATION, id: "att_noproj_1" };
      const captured = await captureAttestationEvidenceDocument(
        kernel.documents,
        att,
        "sess_no_project",
      );
      assertEquals(captured.ok, false);
      if (!captured.ok) assertEquals(captured.error.code, "PROJECT_REQUIRED");

      const refs = await kernel.documents.listRefsByTarget(
        "ledger",
        att.id,
        "evidence",
      );
      assertEquals(refs.length, 0);
    });
  },
});

Deno.test({
  ...testOpts,
  name:
    "run_tests on an in-progress changeset captures a ledger/evidence document at the mint choke point",
  fn: async () => {
    await withKernel(async (kernel) => {
      const projectDir = await Deno.makeTempDir({
        dir: TEST_TMP_DIR,
        prefix: "tideide-dispatch-evidence-mint-",
      });
      kernel.projectDir = projectDir;
      try {
        const session = await kernel.sessions.createSession("Mint Session");
        const cs = await kernel.changesets.create({
          sessionId: session.id,
          title: "Attestation evidence capture",
          plan: {
            summary: "Run a test and mint a test attestation.",
            steps: [{ id: "s1", description: "Run tests.", status: "pending" }],
            acceptanceCriteria: [{
              id: "claim_tests_pass",
              text: "The suite passes.",
              source: "agent",
              priority: "must",
            }],
            verificationPlan: [{
              id: "check_tests",
              claimIds: ["claim_tests_pass"],
              kind: "unit",
              description: "Run the suite.",
            }],
          },
        });
        await kernel.changesets.approve(cs.id);
        await kernel.changesets.startWork(cs.id);

        kernel.tests.register(
          "passingEvidenceTest",
          "async function passingEvidenceTest() {}",
          async () => {},
        );

        const result = await dispatchTool(
          "run_tests",
          { pattern: "passingEvidenceTest" },
          kernel,
          noop,
          { sessionId: session.id },
        );
        assertEquals(result.ok, true);

        // The attestation is minted onto the changeset (still authoritative).
        const updated = await kernel.changesets.get(cs.id);
        const attestations = updated?.plan.attestations ?? [];
        const testAtt = attestations.find((a) => a.kind === "test");
        assert(testAtt, "a test attestation should be minted on the changeset");

        // ...and a durable evidence doc + single ledger/evidence ref appear beside it.
        const refs = await kernel.documents.listRefsByTarget(
          "ledger",
          testAtt.id,
          "evidence",
        );
        assertEquals(refs.length, 1);

        const doc = await kernel.documents.findBySource(
          EVIDENCE_DOCUMENT_SOURCE,
          testAtt.id,
          { sessionId: session.id },
        );
        assert(
          doc,
          "evidence document should exist for the minted attestation",
        );
        assertEquals(doc.createdBy, "agent");
        assertEquals(refs[0]?.documentId, doc.id);
        assertEquals(refs[0]?.versionHash, doc.currentVersionHash);
      } finally {
        rmSync(projectDir, { recursive: true, force: true });
      }
    });
  },
});

// --- Slice C-rich (plan §8/§11): record_verification_run EVIDENCE ITEMS captured as
// versioned agent documents + one ledger/evidence ref each. The C-rich reading of ledger
// evidence — capture the real bytes that justified the decision, not just the attestation.
// ADDITIVE provenance beside the authoritative ledger row + plan.evidence jsonb. ---

// A minimal VerificationEvidence carrying only the fields the run-evidence renderer reads.
function makeRunEvidence(
  overrides: Partial<
    import("../../shared/verification.ts").VerificationEvidence
  > = {},
): import("../../shared/verification.ts").VerificationEvidence {
  return {
    id: "evidence_0",
    kind: "test_result",
    summary: "12/12 tests passed.",
    status: "passed",
    createdAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

Deno.test({
  ...testOpts,
  name:
    "captureRunEvidenceDocuments persists one agent doc + one ledger/evidence ref per item at the head",
  fn: async () => {
    await withKernel(async (kernel) => {
      const projectDir = await Deno.makeTempDir({
        dir: TEST_TMP_DIR,
        prefix: "tideide-dispatch-runevi-",
      });
      kernel.projectDir = projectDir;
      try {
        const session = await kernel.sessions.createSession("Run Evidence");
        const changesetId = "cs_run_1";
        const evidence = [
          makeRunEvidence({
            id: "evidence_tests",
            checkId: "check_tests",
            summary: "testFeature passed.",
            data: { failures: 0, total: 12 },
          }),
          makeRunEvidence({
            id: "evidence_audit",
            kind: "note",
            status: "partial",
            summary: "One residual risk noted.",
          }),
        ];

        const captured = await captureRunEvidenceDocuments(
          kernel.documents,
          changesetId,
          evidence,
          session.id,
        );
        assertEquals(captured.length, 2);
        assert(captured.every((c) => c.ok), "every item should capture");

        for (const item of evidence) {
          const key = runEvidenceLedgerKey(changesetId, item.id);
          const refs = await kernel.documents.listRefsByTarget(
            "ledger",
            key,
            "evidence",
          );
          assertEquals(refs.length, 1);

          const doc = await kernel.documents.findBySource(
            RUN_EVIDENCE_DOCUMENT_SOURCE,
            key,
            { sessionId: session.id },
          );
          assert(doc, `evidence document should exist for ${key}`);
          assertEquals(doc.createdBy, "agent");
          assertEquals(doc.scope, "session");
          assertEquals(doc.kind, "text/markdown");
          assertEquals(doc.metadata.source, RUN_EVIDENCE_DOCUMENT_SOURCE);
          assertEquals(doc.metadata.sourceId, key);
          // The single ref pins the current head (byte-exact provenance, D2).
          assertEquals(refs[0]?.documentId, doc.id);
          assertEquals(refs[0]?.versionHash, doc.currentVersionHash);

          const content = await kernel.documents.readContent(doc.id);
          assertEquals(content.ok, true);
          if (content.ok) {
            assertStringIncludes(content.data.content, item.summary);
            assertStringIncludes(content.data.content, item.status);
            assertStringIncludes(content.data.content, item.kind);
          }
        }

        // The item carrying `data` renders its JSON payload in a fenced block.
        const testsKey = runEvidenceLedgerKey(changesetId, "evidence_tests");
        const testsDoc = await kernel.documents.findBySource(
          RUN_EVIDENCE_DOCUMENT_SOURCE,
          testsKey,
          { sessionId: session.id },
        );
        assert(testsDoc);
        const testsContent = await kernel.documents.readContent(testsDoc.id);
        if (testsContent.ok) {
          assertStringIncludes(testsContent.data.content, "```json");
          assertStringIncludes(testsContent.data.content, '"total": 12');
        }
      } finally {
        rmSync(projectDir, { recursive: true, force: true });
      }
    });
  },
});

Deno.test({
  ...testOpts,
  name:
    "captureRunEvidenceDocument is idempotent per composite key and never collides across changesets",
  fn: async () => {
    await withKernel(async (kernel) => {
      const projectDir = await Deno.makeTempDir({
        dir: TEST_TMP_DIR,
        prefix: "tideide-dispatch-runevi-idem-",
      });
      kernel.projectDir = projectDir;
      try {
        const session = await kernel.sessions.createSession("Idem Run");
        // Two DIFFERENT changesets each carry an `evidence_0` — the agent-supplied id is
        // not globally unique, so only the COMPOSITE key keeps them distinct.
        const evidence = makeRunEvidence({ id: "evidence_0" });

        const a1 = await captureRunEvidenceDocument(
          kernel.documents,
          "cs_A",
          evidence,
          session.id,
        );
        // Re-run of the SAME (changeset, item) — must be a clean no-op, not a second doc.
        const a2 = await captureRunEvidenceDocument(
          kernel.documents,
          "cs_A",
          evidence,
          session.id,
        );
        const b1 = await captureRunEvidenceDocument(
          kernel.documents,
          "cs_B",
          evidence,
          session.id,
        );
        assert(a1.ok && a2.ok && b1.ok);

        const keyA = runEvidenceLedgerKey("cs_A", "evidence_0");
        const keyB = runEvidenceLedgerKey("cs_B", "evidence_0");

        const listed = await kernel.documents.list({ sessionId: session.id });
        assert(listed.ok);
        const runDocsFor = (key: string) =>
          listed.data.filter((d) =>
            d.metadata.source === RUN_EVIDENCE_DOCUMENT_SOURCE &&
            d.metadata.sourceId === key
          );

        // cs_A: exactly one live doc + one ref despite the re-run.
        const docsA = runDocsFor(keyA);
        assertEquals(docsA.length, 1);
        assertEquals(
          (await kernel.documents.listRefsByTarget("ledger", keyA, "evidence"))
            .length,
          1,
        );

        // cs_B's evidence_0 is a DISTINCT target — its own doc + ref, no collision.
        const docsB = runDocsFor(keyB);
        assertEquals(docsB.length, 1);
        assert(
          docsA[0]!.id !== docsB[0]!.id,
          "two changesets' evidence_0 must be distinct documents",
        );
        assertEquals(
          (await kernel.documents.listRefsByTarget("ledger", keyB, "evidence"))
            .length,
          1,
        );
      } finally {
        rmSync(projectDir, { recursive: true, force: true });
      }
    });
  },
});

Deno.test({
  ...testOpts,
  name:
    "captureRunEvidenceDocuments degrades without a project (no throw, no doc, no ref)",
  fn: async () => {
    await withKernel(async (kernel) => {
      // No kernel.projectDir → a session-scoped document cannot be stored.
      const captured = await captureRunEvidenceDocuments(
        kernel.documents,
        "cs_np",
        [makeRunEvidence({ id: "evidence_np" })],
        "sess_no_project",
      );
      assertEquals(captured.length, 1);
      assertEquals(captured[0]?.ok, false);
      if (captured[0] && !captured[0].ok) {
        assertEquals(captured[0].error.code, "PROJECT_REQUIRED");
      }

      const key = runEvidenceLedgerKey("cs_np", "evidence_np");
      assertEquals(
        (await kernel.documents.listRefsByTarget("ledger", key, "evidence"))
          .length,
        0,
      );
    });
  },
});

Deno.test({
  ...testOpts,
  name:
    "record_verification_run captures N evidence documents on an in-progress changeset",
  fn: async () => {
    await withKernel(async (kernel) => {
      const projectDir = await Deno.makeTempDir({
        dir: TEST_TMP_DIR,
        prefix: "tideide-dispatch-runevi-e2e-",
      });
      kernel.projectDir = projectDir;
      try {
        const session = await kernel.sessions.createSession("E2E Run");
        const created = await dispatchTool(
          "create_changeset",
          {
            title: "Add proof",
            plan: {
              summary: "Plan with verification",
              steps: ["Implement feature"],
              acceptanceCriteria: [{
                id: "claim_feature",
                text: "Feature behavior is present.",
                source: "user",
                priority: "must",
              }],
              verificationPlan: [{
                id: "check_tests",
                claimIds: ["claim_feature"],
                kind: "unit",
                description: "Run targeted unit test.",
              }],
            },
          },
          kernel,
          noop,
          { sessionId: session.id },
        );
        assertEquals(created.ok, true);
        const changeset = created.data as { id: string };
        await kernel.changesets.approve(changeset.id);
        await kernel.changesets.startWork(changeset.id);

        const recorded = await dispatchTool(
          "record_verification_run",
          {
            changeset_id: changeset.id,
            status: "passed",
            summary: "Verified with targeted unit test.",
            evidence: [
              {
                id: "evidence_tests",
                kind: "test_result",
                status: "passed",
                summary: "testFeature passed.",
                checkId: "check_tests",
              },
              {
                id: "evidence_note",
                kind: "note",
                status: "passed",
                summary: "Manual smoke check ok.",
              },
            ],
            claimResults: [{
              claimId: "claim_feature",
              status: "passed",
              evidenceIds: ["evidence_tests"],
            }],
            residualRisks: [],
          },
          kernel,
          noop,
          { sessionId: session.id },
        );
        assertEquals(recorded.ok, true);
        // The run is recorded and remains authoritative (unchanged behavior).
        assertEquals(
          (await kernel.changesets.get(changeset.id))?.plan.verificationRuns
            ?.length,
          1,
        );

        // ...and each evidence item now has a durable doc + single ledger/evidence ref.
        for (const id of ["evidence_tests", "evidence_note"]) {
          const key = runEvidenceLedgerKey(changeset.id, id);
          const refs = await kernel.documents.listRefsByTarget(
            "ledger",
            key,
            "evidence",
          );
          assertEquals(refs.length, 1);
          const doc = await kernel.documents.findBySource(
            RUN_EVIDENCE_DOCUMENT_SOURCE,
            key,
            { sessionId: session.id },
          );
          assert(doc, `evidence doc should exist for ${key}`);
          assertEquals(refs[0]?.versionHash, doc.currentVersionHash);
        }
      } finally {
        rmSync(projectDir, { recursive: true, force: true });
      }
    });
  },
});

Deno.test({
  ...testOpts,
  name:
    "record_verification_run with no project still records the run and never throws",
  fn: async () => {
    await withKernel(async (kernel) => {
      // No kernel.projectDir → byte capture degrades silently; the run must still record.
      const session = await kernel.sessions.createSession("No Project Run");
      const created = await dispatchTool(
        "create_changeset",
        {
          title: "No project proof",
          plan: {
            summary: "Plan",
            steps: ["Do it"],
            acceptanceCriteria: [{
              id: "claim_x",
              text: "X holds.",
              source: "user",
              priority: "must",
            }],
            verificationPlan: [{
              id: "check_x",
              claimIds: ["claim_x"],
              kind: "unit",
              description: "Check X.",
            }],
          },
        },
        kernel,
        noop,
        { sessionId: session.id },
      );
      assertEquals(created.ok, true);
      const changeset = created.data as { id: string };
      await kernel.changesets.approve(changeset.id);
      await kernel.changesets.startWork(changeset.id);

      const recorded = await dispatchTool(
        "record_verification_run",
        {
          changeset_id: changeset.id,
          status: "passed",
          summary: "Verified.",
          evidence: [{
            id: "evidence_x",
            kind: "test_result",
            status: "passed",
            summary: "X passed.",
            checkId: "check_x",
          }],
          claimResults: [{
            claimId: "claim_x",
            status: "passed",
            evidenceIds: ["evidence_x"],
          }],
          residualRisks: [],
        },
        kernel,
        noop,
        { sessionId: session.id },
      );
      assertEquals(recorded.ok, true);
      assertEquals(
        (await kernel.changesets.get(changeset.id))?.plan.verificationRuns
          ?.length,
        1,
      );
      // No doc/ref was created (silent degrade), but the run is intact.
      const key = runEvidenceLedgerKey(changeset.id, "evidence_x");
      assertEquals(
        (await kernel.documents.listRefsByTarget("ledger", key, "evidence"))
          .length,
        0,
      );
    });
  },
});

// --- Proportional verification (the light lane) -----------------------------

// Put a light-lane changeset into in_progress, as an approval would.
async function startLightChangeset(
  kernel: Kernel,
  over: Record<string, unknown> = {},
): Promise<{ id: string }> {
  const created = await dispatchTool(
    "create_changeset",
    {
      title: "Remove the 76px header margin",
      change_class: "light",
      plan: {
        summary: "Remove the 76px margin from the header.",
        steps: ["Edit the stylesheet"],
        ...over,
      },
    },
    kernel,
    noop,
  );
  assertEquals(created.ok, true);
  const cs = created.data as { id: string };
  await kernel.changesets.approve(cs.id);
  await kernel.changesets.startWork(cs.id);
  return cs;
}

Deno.test({
  ...testOpts,
  name:
    "light lane: the kernel authors the acceptance criterion and planned check",
  fn: async () => {
    await withKernel(async (kernel) => {
      // The whole point: a margin tweak needs no authored ceremony. The plan is
      // accepted WITHOUT acceptanceCriteria/verificationPlan, which validateChangesetPlan
      // still hard-requires — because the kernel wrote them before that check ran.
      const cs = await startLightChangeset(kernel);
      const stored = await kernel.changesets.get(cs.id);
      assertEquals(stored?.plan.changeClass?.effective, "light");
      assertEquals(stored?.plan.changeClass?.declared, "light");
      assertEquals(stored?.plan.changeClass?.escalated, false);
      assertEquals(stored?.plan.acceptanceCriteria?.length, 1);
      assertEquals(stored?.plan.verificationPlan?.length, 1);
      assertEquals(stored?.plan.verificationPlan?.[0]?.kind, "manifest");
      // `should`, not `must` — this is what keeps the adversarial pass out of the gate.
      assertEquals(stored?.plan.acceptanceCriteria?.[0]?.priority, "should");
    });
  },
});

Deno.test({
  ...testOpts,
  name:
    "light lane: a light-surface mutation is allowed, a structural one is refused",
  fn: async () => {
    await withKernel(async (kernel) => {
      const cs = await startLightChangeset(kernel);
      const ctx = { changesetId: cs.id };

      // Templates are squarely inside the lane.
      const allowed = await dispatchTool(
        "define_template",
        { name: "header", content: "<header></header>" },
        kernel,
        noop,
        ctx,
      );
      assertEquals(allowed.ok, true);

      // A schema is not. This is the tightening that makes the reduced gate sound:
      // the relaxation rests on what the kernel LETS the changeset do.
      const refused = await dispatchTool(
        "define_schema",
        {
          tableName: "todos",
          sql: "CREATE TABLE todos (id serial primary key)",
        },
        kernel,
        noop,
        { changesetId: cs.id },
      );
      assertEquals(refused.ok, false);
      assertEquals(refused.error?.code, "CHANGE_CLASS_EXCEEDED");
      // The error must be actionable or the agent will loop on it.
      assertStringIncludes(
        refused.error?.suggestion ?? "",
        "amend_changeset_plan",
      );
    });
  },
});

Deno.test({
  ...testOpts,
  name: "light lane: a standard changeset is not narrowed at all",
  fn: async () => {
    await withKernel(async (kernel) => {
      const created = await dispatchTool(
        "create_changeset",
        {
          title: "Add a todos table",
          plan: {
            summary: "Add persistence.",
            steps: ["Define the schema"],
            acceptanceCriteria: ["Todos persist."],
            verificationPlan: [{
              id: "check_0",
              claimIds: ["claim_0"],
              kind: "integration",
              description: "Round-trip a todo.",
            }],
          },
        },
        kernel,
        noop,
      );
      assertEquals(created.ok, true);
      const cs = created.data as { id: string };
      const stored = await kernel.changesets.get(cs.id);
      assertEquals(stored?.plan.changeClass?.effective, "standard");
      await kernel.changesets.approve(cs.id);
      await kernel.changesets.startWork(cs.id);

      const allowed = await dispatchTool(
        "define_schema",
        {
          tableName: "todos",
          sql: "CREATE TABLE todos (id serial primary key)",
        },
        kernel,
        noop,
        { changesetId: cs.id },
      );
      assertEquals(allowed.ok, true);
    });
  },
});

Deno.test({
  ...testOpts,
  name:
    "light lane: an incoherent light declaration is rejected, not downgraded",
  fn: async () => {
    await withKernel(async (kernel) => {
      // A must-claim IS a request for adversarial review — silently downgrading would
      // leave the user reading a plan that says one thing while the kernel does another.
      const result = await dispatchTool(
        "create_changeset",
        {
          title: "Tweak checkout",
          change_class: "light",
          plan: {
            summary: "Tweak the checkout button.",
            steps: ["Edit the template"],
            acceptanceCriteria: [{
              id: "claim_0",
              text: "Checkout never double-charges.",
              source: "user",
              priority: "must",
            }],
            verificationPlan: [{
              id: "check_0",
              claimIds: ["claim_0"],
              kind: "e2e",
              description: "Drive checkout.",
            }],
          },
        },
        kernel,
        noop,
      );
      assertEquals(result.ok, false);
      assertEquals(result.error?.code, "INVALID_CHANGE_CLASS");
    });
  },
});

Deno.test({
  ...testOpts,
  name:
    "light lane: completing mints a change manifest that satisfies the gate by construction",
  fn: async () => {
    await withKernel(async (kernel) => {
      const cs = await startLightChangeset(kernel);
      const ctx = { changesetId: cs.id };
      const wrote = await dispatchTool(
        "define_template",
        { name: "header", content: "<header></header>" },
        kernel,
        noop,
        ctx,
      );
      assertEquals(wrote.ok, true);
      for (const step of (await kernel.changesets.get(cs.id))!.plan.steps) {
        await kernel.changesets.updateStep(cs.id, step.id, "done");
      }

      // No record_verification_run, no run_tests, no refute_claims — and it completes.
      const done = await dispatchTool(
        "complete_changeset",
        { changeset_id: cs.id },
        kernel,
        noop,
        { changesetId: cs.id },
      );
      assertEquals(done.ok, true, JSON.stringify(done.error));

      const stored = await kernel.changesets.get(cs.id);
      const run = stored?.plan.verificationRuns?.at(-1);
      assertEquals(run?.status, "passed");
      assertEquals(run?.evidence.length, 1);
      assertEquals(run?.evidence[0]?.kind, "manifest");
      // The evidence is kernel-minted, not self-reported: it carries an attestation.
      assert(run?.evidence[0]?.attestationId);
      assertStringIncludes(run?.evidence[0]?.summary ?? "", "template:header");
      // Every acceptance criterion has a claim result pointing at that evidence.
      assertEquals(run?.claimResults.length, 1);
      assertEquals(
        run?.claimResults[0]?.evidenceIds,
        [run?.evidence[0]?.id],
      );
      const manifest = (stored?.plan.attestations ?? []).filter((a) =>
        a.kind === "change_manifest"
      );
      assertEquals(manifest.length, 1);
      assertEquals(manifest[0]?.status, "passed");
    });
  },
});

Deno.test({
  ...testOpts,
  name:
    "light lane: work beyond the declared class escalates and blocks completion",
  fn: async () => {
    await withKernel(async (kernel) => {
      const cs = await startLightChangeset(kernel);
      // Simulate a structural change reaching the changelog anyway — a delegated verb,
      // a manual edit, or a changeset created before the dispatch gate existed. This is
      // the backstop the gate cannot cover.
      await kernel.changelog.record({
        category: "schema",
        key: "todos",
        action: "create",
        beforeSnapshot: null,
        afterSnapshot: { name: "todos" },
        context: { changesetId: cs.id },
      });
      for (const step of (await kernel.changesets.get(cs.id))!.plan.steps) {
        await kernel.changesets.updateStep(cs.id, step.id, "done");
      }

      const done = await dispatchTool(
        "complete_changeset",
        { changeset_id: cs.id },
        kernel,
        noop,
        { changesetId: cs.id },
      );
      assertEquals(done.ok, false);
      assertEquals(done.error?.code, "INCOMPLETE_VERIFICATION");
      assertStringIncludes(done.error?.message ?? "", "CHANGE_CLASS_ESCALATED");
      // And the escalation is durable + explains itself.
      const stored = await kernel.changesets.get(cs.id);
      assertEquals(stored?.plan.changeClass?.escalated, true);
      assertEquals(stored?.plan.changeClass?.effective, "standard");
      assertStringIncludes(
        stored?.plan.changeClass?.reason ?? "",
        "schema:todos",
      );
      // An escalated changeset gets no free manifest run.
      assertEquals(stored?.plan.verificationRuns ?? [], []);
    });
  },
});

Deno.test({
  ...testOpts,
  name:
    "light lane: MUST_CLAIM_UNREVIEWED is waived to skipped, even under strict",
  fn: () => {
    // The one waived code, and the one interaction worth pinning: a DOWNWARD tier
    // crossing the UPWARD enforcement ladder. Under strict the code is promoted to an
    // error first, then waived — so ordering is the contract, not an accident.
    const base = {
      id: "cs_light",
      sessionId: null,
      title: "Light",
      description: null,
      status: "in_progress" as const,
      planMessageIds: [],
      approvalMessageId: null,
      workMessageIds: [],
      toolCalls: null,
      reasoning: null,
      tokenUsage: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      completedAt: null,
    };
    const plan = {
      summary: "Light work.",
      steps: [{ id: "step_0", description: "Do it", status: "done" as const }],
      // A `must` claim would normally raise MUST_CLAIM_UNREVIEWED; here it is present
      // only to force the code so the waiver has something to act on.
      acceptanceCriteria: [{
        id: "claim_0",
        text: "It works.",
        source: "inferred" as const,
        priority: "must" as const,
      }],
      verificationPlan: [{
        id: "check_0",
        claimIds: ["claim_0"],
        kind: "manifest" as const,
        description: "Manifest.",
      }],
      verificationRuns: [{
        id: "run_0",
        status: "passed" as const,
        summary: "ok",
        evidence: [{
          id: "ev_0",
          kind: "manifest" as const,
          summary: "changed template:header",
          status: "passed" as const,
          createdAt: "2026-01-01T00:00:00.000Z",
        }],
        claimResults: [{
          claimId: "claim_0",
          status: "passed" as const,
          evidenceIds: ["ev_0"],
        }],
        residualRisks: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        completedAt: "2026-01-01T00:00:00.000Z",
      }],
    };

    for (const mode of ["advisory", "graduated", "strict"] as const) {
      const light = checkChangesetReadiness(
        {
          ...base,
          plan: {
            ...plan,
            changeClass: {
              declared: "light" as const,
              effective: "light" as const,
              escalated: false,
              reason: "light",
            },
          },
        },
        undefined,
        mode,
      );
      assertEquals(
        light.errors.some((i) => i.code === "MUST_CLAIM_UNREVIEWED"),
        false,
        `light/${mode} must not error on MUST_CLAIM_UNREVIEWED`,
      );
      assertEquals(
        light.warnings.some((i) => i.code === "MUST_CLAIM_UNREVIEWED"),
        false,
      );
      // Waived, not vanished — the audit trail shows the policy decision.
      assertEquals(
        light.skipped.some((i) => i.code === "MUST_CLAIM_UNREVIEWED"),
        true,
        `light/${mode} must record the waiver as skipped`,
      );
    }

    // A standard changeset keeps the code exactly where the ladder put it.
    const strictStandard = checkChangesetReadiness(
      base_plan(),
      undefined,
      "strict",
    );
    assertEquals(
      strictStandard.errors.some((i) => i.code === "MUST_CLAIM_UNREVIEWED"),
      true,
    );
    assertEquals(strictStandard.skipped, []);
    const advisoryStandard = checkChangesetReadiness(
      base_plan(),
      undefined,
      "advisory",
    );
    assertEquals(
      advisoryStandard.warnings.some((i) => i.code === "MUST_CLAIM_UNREVIEWED"),
      true,
    );

    function base_plan() {
      return { ...base, plan };
    }
  },
});

Deno.test({
  ...testOpts,
  name:
    "edit_entity_text delegates to the full-content verb, keeping governance intact",
  fn: async () => {
    await withKernel(async (kernel) => {
      // Works INSIDE a light changeset: the tier gate defers to the delegate
      // (define_template), which is squarely in the lane — classifying the outer
      // delegating call would wrongly refuse it.
      const cs = await startLightChangeset(kernel);
      const ctx = { changesetId: cs.id };
      await dispatchTool(
        "define_template",
        {
          name: "header",
          content: '<header style="margin: 76px">Hi</header>',
        },
        kernel,
        noop,
        ctx,
      );

      const edited = await dispatchTool(
        "edit_entity_text",
        {
          type: "template",
          name: "header",
          edits: [{ find: ' style="margin: 76px"', replace: "" }],
        },
        kernel,
        noop,
        { changesetId: cs.id },
      );
      assertEquals(edited.ok, true, JSON.stringify(edited.error));
      assertEquals(kernel.templates.get("header"), "<header>Hi</header>");

      // The delegate recorded the change, so undo/history/the change manifest all
      // see it exactly as they would a full rewrite.
      const records = await kernel.changelog.listByChangeset(cs.id);
      assertEquals(
        records.filter((r) => r.category === "template" && r.key === "header")
          .length,
        2,
      );
    });
  },
});

Deno.test({
  ...testOpts,
  name: "edit_entity_text fails closed on an ambiguous or missing match",
  fn: async () => {
    await withKernel(async (kernel) => {
      const cs = await startLightChangeset(kernel);
      const ctx = { changesetId: cs.id };
      const original = ".a { margin: 76px; }\n.b { margin: 76px; }";
      await dispatchTool(
        "upload_text_asset",
        { name: "style.css", content: original, mimeType: "text/css" },
        kernel,
        noop,
        ctx,
      );

      const ambiguous = await dispatchTool(
        "edit_entity_text",
        {
          type: "text_asset",
          name: "style.css",
          edits: [{ find: "margin: 76px;", replace: "margin: 0;" }],
        },
        kernel,
        noop,
        { changesetId: cs.id },
      );
      assertEquals(ambiguous.ok, false);
      assertEquals(ambiguous.error?.code, "EDIT_AMBIGUOUS_MATCH");

      const missing = await dispatchTool(
        "edit_entity_text",
        {
          type: "text_asset",
          name: "style.css",
          edits: [{ find: "margin: 80px;", replace: "margin: 0;" }],
        },
        kernel,
        noop,
        { changesetId: cs.id },
      );
      assertEquals(missing.ok, false);
      assertEquals(missing.error?.code, "EDIT_NO_MATCH");

      // Neither failure mutated the asset — this is what makes a preview round-trip
      // unnecessary.
      const asset = kernel.assets.get("style.css");
      assertEquals(new TextDecoder().decode(asset!.content), original);

      // And the happy path, with an explicit count for the genuinely repeated value.
      const ok = await dispatchTool(
        "edit_entity_text",
        {
          type: "text_asset",
          name: "style.css",
          edits: [{ find: "margin: 76px;", replace: "margin: 0;", count: 2 }],
        },
        kernel,
        noop,
        { changesetId: cs.id },
      );
      assertEquals(ok.ok, true, JSON.stringify(ok.error));
      assertEquals(
        new TextDecoder().decode(kernel.assets.get("style.css")!.content),
        ".a { margin: 0; }\n.b { margin: 0; }",
      );
    });
  },
});

Deno.test({
  ...testOpts,
  name:
    "edit_entity_text still requires a changeset and rejects unknown targets",
  fn: async () => {
    await withKernel(async (kernel) => {
      // The delegating verb is in MODIFICATION_TOOLS, so the changeset gate applies
      // to the OUTER call too — it is a token optimization, not a governance bypass.
      assertEquals(isMutationTool("edit_entity_text"), true);
      const blocked = await dispatchTool(
        "edit_entity_text",
        {
          type: "template",
          name: "header",
          edits: [{ find: "a", replace: "b" }],
        },
        kernel,
        noop,
      );
      assertEquals(blocked.ok, false);
      assertEquals(blocked.error?.code, "CHANGESET_REQUIRED");

      const cs = await startLightChangeset(kernel);
      const notFound = await dispatchTool(
        "edit_entity_text",
        {
          type: "template",
          name: "nope",
          edits: [{ find: "a", replace: "b" }],
        },
        kernel,
        noop,
        { changesetId: cs.id },
      );
      assertEquals(notFound.ok, false);
      assertEquals(notFound.error?.code, "TEMPLATE_NOT_FOUND");

      const badType = await dispatchTool(
        "edit_entity_text",
        {
          type: "handler",
          name: "x",
          edits: [{ find: "a", replace: "b" }],
        },
        kernel,
        noop,
        { changesetId: cs.id },
      );
      assertEquals(badType.ok, false);
      assertEquals(badType.error?.code, "INVALID_TYPE");
    });
  },
});

Deno.test({
  ...testOpts,
  name:
    "light lane: amending escalates out of the lane, so the agent cannot loop",
  fn: async () => {
    await withKernel(async (kernel) => {
      const cs = await startLightChangeset(kernel);
      // The refusal names amend_changeset_plan as the way out...
      const refused = await dispatchTool(
        "define_schema",
        {
          tableName: "todos",
          sql: "CREATE TABLE todos (id serial primary key)",
        },
        kernel,
        noop,
        { changesetId: cs.id },
      );
      assertEquals(refused.error?.code, "CHANGE_CLASS_EXCEEDED");
      assertStringIncludes(
        refused.error?.suggestion ?? "",
        "amend_changeset_plan",
      );

      // ...and taking that route actually works: the class widens, so re-approved
      // work is no longer refused. Without this the agent would amend, get approved,
      // and hit the identical refusal forever.
      const amended = await dispatchTool(
        "amend_changeset_plan",
        {
          changeset_id: cs.id,
          summary_addendum: "Also persist the todos.",
          steps: ["Define the todos schema"],
        },
        kernel,
        noop,
        { changesetId: cs.id },
      );
      assertEquals(amended.ok, true, JSON.stringify(amended.error));

      const stored = await kernel.changesets.get(cs.id);
      assertEquals(stored?.plan.changeClass?.effective, "standard");
      // Not an escalation-with-blame: the user consented by re-approving.
      assertEquals(stored?.plan.changeClass?.escalated, false);
      // The amendment returned it to planning, so the user must approve again.
      assertEquals(stored?.status, "planning");

      await kernel.changesets.approve(cs.id);
      await kernel.changesets.startWork(cs.id);
      const nowAllowed = await dispatchTool(
        "define_schema",
        {
          tableName: "todos",
          sql: "CREATE TABLE todos (id serial primary key)",
        },
        kernel,
        noop,
        { changesetId: cs.id },
      );
      assertEquals(nowAllowed.ok, true, JSON.stringify(nowAllowed.error));
    });
  },
});

// --- Handler / function removal (remove_entity types "handler" and "function") ---
//
// Until these existed, nothing in the tool surface could delete a handler or a
// function: the registries have had remove() all along, but no verb reached it.
// The practical consequence was a one-way ratchet — retiring a feature could drop
// its tables and unregister its routes, and then had to leave every handler behind.

// A session with an approved changeset, so the mutation gate lets the verb under
// test through. Setup entities are registered straight on the registries (as the
// other tests here do) — only the removal itself goes through dispatch.
async function withRemovalContext(
  kernel: Kernel,
): Promise<{ sessionId: string }> {
  const session = await kernel.sessions.createSession("Removal Session");
  const created = await dispatchTool(
    "create_changeset",
    {
      title: "Remove retired entities",
      plan: {
        summary: "Remove entities left behind by a retired feature.",
        steps: ["Remove the entity"],
        acceptanceCriteria: ["The retired entity is gone."],
        verificationPlan: [{
          id: "check_removed",
          claimIds: ["claim_0"],
          kind: "unit",
          description: "Assert the entity is no longer registered.",
        }],
      },
    },
    kernel,
    noop,
    { sessionId: session.id },
  );
  assertEquals(created.ok, true);
  const changesetId = (created.data as { id: string }).id;
  // planning → approved → in_progress; the gate only lets in_progress through.
  await kernel.changesets.approve(changesetId);
  await kernel.changesets.startWork(changesetId);
  return { sessionId: session.id };
}

const registerHandler = (kernel: Kernel, name: string) =>
  kernel.handlers.register(
    name,
    `async function ${name}(c: Context) { return c.json({}); }`,
    () => new Response("ok"),
    undefined,
    "retired",
    undefined,
    "typescript",
    `${name} handler.`,
  );

Deno.test({
  ...testOpts,
  name: "remove_entity removes an unrouted handler",
  fn: async () => {
    await withKernel(async (kernel) => {
      const ctx = await withRemovalContext(kernel);
      registerHandler(kernel, "deadHandler");
      assert(kernel.handlers.get("deadHandler"), "handler was registered");

      const result = await dispatchTool(
        "remove_entity",
        { type: "handler", key: "deadHandler" },
        kernel,
        noop,
        ctx,
      );

      assertEquals(result.ok, true);
      assertEquals(kernel.handlers.get("deadHandler"), undefined);
    });
  },
});

Deno.test({
  ...testOpts,
  name: "remove_entity refuses a handler a route still points at",
  fn: async () => {
    await withKernel(async (kernel) => {
      const ctx = await withRemovalContext(kernel);
      registerHandler(kernel, "liveHandler");
      kernel.routes.register("GET", "/live", "liveHandler");

      const result = await dispatchTool(
        "remove_entity",
        { type: "handler", key: "liveHandler" },
        kernel,
        noop,
        ctx,
      );

      assertEquals(result.ok, false);
      assertEquals(result.error?.code, "HANDLER_ROUTED");
      assertStringIncludes(result.error?.message ?? "", "GET /live");
      // Refusing means refusing: the handler is still there to serve the route.
      assert(kernel.handlers.get("liveHandler"), "the handler survived");
    });
  },
});

Deno.test({
  ...testOpts,
  name: "remove_entity removes a function nothing references",
  fn: async () => {
    await withKernel(async (kernel) => {
      const ctx = await withRemovalContext(kernel);
      kernel.functions.register(
        "orphanFn",
        `function orphanFn() { return 1; }`,
        () => 1,
      );

      const result = await dispatchTool(
        "remove_entity",
        { type: "function", key: "orphanFn" },
        kernel,
        noop,
        ctx,
      );

      assertEquals(result.ok, true);
      assertEquals(
        kernel.functions.list().some((fn) => fn.name === "orphanFn"),
        false,
      );
    });
  },
});

// The crux. A function only a TEST exercises is invisible to the call graph, so a
// naive check would call it unreferenced and delete it — turning a passing suite
// red for a reason the diff does not explain.
Deno.test({
  ...testOpts,
  name: "remove_entity refuses a function only a test calls",
  fn: async () => {
    await withKernel(async (kernel) => {
      const ctx = await withRemovalContext(kernel);
      kernel.functions.register(
        "testOnlyFn",
        `function testOnlyFn() { return 42; }`,
        () => 42,
      );
      kernel.tests.register(
        "testUsesIt",
        `async function testUsesIt() { await functions.call("testOnlyFn"); }`,
        async () => {},
      );

      const result = await dispatchTool(
        "remove_entity",
        { type: "function", key: "testOnlyFn" },
        kernel,
        noop,
        ctx,
      );

      assertEquals(result.ok, false);
      assertEquals(result.error?.code, "FUNCTION_IN_USE");
      assertStringIncludes(result.error?.message ?? "", "test:testUsesIt");
      assert(
        kernel.functions.list().some((fn) => fn.name === "testOnlyFn"),
        "the function survived",
      );
    });
  },
});

// The same blind spot one layer down: the dead-code report is what a cleanup reads
// before deciding what to delete, so it must not name a test-only function.
Deno.test({
  ...testOpts,
  name: "find_dead_code does not report a function only a test calls",
  fn: async () => {
    await withKernel(async (kernel) => {
      kernel.functions.register(
        "testOnlyFn",
        `function testOnlyFn() { return 42; }`,
        () => 42,
      );
      kernel.functions.register(
        "trulyDeadFn",
        `function trulyDeadFn() { return 0; }`,
        () => 0,
      );
      kernel.tests.register(
        "testUsesIt",
        `async function testUsesIt() { await functions.call("testOnlyFn"); }`,
        async () => {},
      );

      const dead = findDeadCode(kernel)
        .filter((item) => item.type === "function")
        .map((item) => item.name);

      assertEquals(dead.includes("testOnlyFn"), false);
      // The report still has to work: a genuinely unused function is named.
      assertEquals(dead.includes("trulyDeadFn"), true);
    });
  },
});

// No route points at the auth gate and no app code reads its config; the kernel does
// both. Reporting them dead turns project_status to "attention" for every gated app.
Deno.test({
  ...testOpts,
  name: "find_dead_code counts the auth gate handler and its config as live",
  fn: async () => {
    await withKernel(async (kernel) => {
      for (const name of ["gate", "unroutedHandler"]) {
        kernel.handlers.register(
          name,
          `async function ${name}() { return null; }`,
          () => new Response("ok"),
        );
      }
      const deadNames = () =>
        findDeadCode(kernel).map((item) => `${item.type}:${item.name}`);

      kernel.configs.set(APP_AUTH_GATE_CONFIG, "gate");
      let dead = deadNames();
      assertEquals(dead.includes("handler:gate"), false);
      assertEquals(dead.includes(`config:${APP_AUTH_GATE_CONFIG}`), false);
      assertEquals(dead.includes("handler:unroutedHandler"), true);

      // Unset, the gate is just another handler nothing calls.
      kernel.configs.set(APP_AUTH_GATE_CONFIG, "");
      dead = deadNames();
      assertEquals(dead.includes("handler:gate"), true);
    });
  },
});

// The registries live in memory and load from the project's state directory. Every other
// flush hangs off the IDE, off a git verb, or off a clean unload — so a headless MCP
// session had no way to make its work durable on purpose. This verb is that way.
Deno.test({
  ...testOpts,
  name:
    "flush_project_state writes the registries to the project state directory",
  fn: async () => {
    await withKernel(async (kernel) => {
      const dir = mkdtempSync(join(tmpdir(), "flush-state-"));
      try {
        kernel.projectDir = dir;
        kernel.handlers.register(
          "serveThing",
          "async function serveThing(c) { return c.json({}); }",
          () => new Response("{}"),
          undefined,
          "things",
        );
        kernel.functions.register(
          "thingHelper",
          "function thingHelper() { return 1; }",
          () => 1,
          "things",
        );

        const handlerFile = join(
          dir,
          ".opentide",
          "state",
          "handlers",
          "serveThing.json",
        );
        assertEquals(
          existsSync(handlerFile),
          false,
          "registering alone must not write to disk",
        );

        const result = await dispatchTool(
          "flush_project_state",
          {},
          kernel,
          noop,
        );
        assertEquals(result.ok, true);
        const data = result.data as {
          stateDir: string;
          handlers: number;
          functions: number;
        };
        assertEquals(data.handlers, 1);
        assertEquals(data.functions, 1);
        assert(data.stateDir.startsWith(dir), data.stateDir);
        assert(
          existsSync(handlerFile),
          "handler must be on disk after the flush",
        );
        assertStringIncludes(readFileSync(handlerFile, "utf8"), "serveThing");

        // A removal must reach disk too — the case that started this: entities deleted in
        // memory but left behind in the state directory come back on the next load.
        kernel.handlers.remove("serveThing");
        const second = await dispatchTool(
          "flush_project_state",
          {},
          kernel,
          noop,
        );
        assertEquals(second.ok, true);
        assertEquals((second.data as { handlers: number }).handlers, 0);
        assertEquals(
          existsSync(handlerFile),
          false,
          "a removed handler's state file must be deleted by the flush",
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  },
});

Deno.test({
  ...testOpts,
  name: "flush_project_state reports NO_PROJECT when no project is loaded",
  fn: async () => {
    await withKernel(async (kernel) => {
      const result = await dispatchTool(
        "flush_project_state",
        {},
        kernel,
        noop,
      );
      assertEquals(result.ok, false);
      assertEquals(result.error?.code, "NO_PROJECT");
    });
  },
});

// export_project used to build the file list in memory and tell the caller to
// download it from the UI. On the MCP face there is no UI, so the only route to an
// export on disk was the `opentide export` CLI — which calls loadProject and takes
// the project lock the running kernel already holds. `out` closes that gap, so what
// matters here is that the write lands, stays inside the project, and carries the
// same option set the CLI uses.
Deno.test({
  ...testOpts,
  name: "export_project writes the tree to out, with CLI-equivalent options",
  fn: async () => {
    await withKernel(async (kernel) => {
      const projectDir = await Deno.makeTempDir({
        dir: TEST_TMP_DIR,
        prefix: "tideide-dispatch-export-out-",
      });
      kernel.projectDir = projectDir;
      try {
        writeFileSync(
          join(projectDir, "opentide.json"),
          JSON.stringify({
            name: "Export Target",
            createdAt: "2026-01-01T00:00:00.000Z",
          }) + "\n",
        );
        writeFileSync(
          join(projectDir, "version.json"),
          JSON.stringify({ version: "9.9.9" }) + "\n",
        );

        const result = await dispatchTool(
          "export_project",
          { out: "dist/v9.9.9", includeManifest: true },
          kernel,
          noop,
        );
        assertEquals(result.ok, true);
        const data = result.data as { outDir: string; fileCount: number };
        const outDir = join(projectDir, "dist", "v9.9.9");
        assertEquals(data.outDir, outDir);
        assert(data.fileCount > 0);

        // The bytes actually landed — the old path returned metadata and wrote nothing.
        assert(
          existsSync(join(outDir, "main.ts")),
          "main.ts should be written",
        );

        // projectVersion reaches the exporter, so APP_VERSION is stamped rather than
        // left as "unversioned" for a build script to patch back in with perl.
        assertStringIncludes(
          readFileSync(join(outDir, "main.ts"), "utf-8"),
          'const APP_VERSION = "9.9.9"',
        );
        // ...and so does projectName, read off opentide.json.
        assertStringIncludes(
          readFileSync(join(outDir, "main.ts"), "utf-8"),
          'const APP_NAME = "Export Target"',
        );

        // DEFAULT_BUILD_OPTIONS is the base, not a bare object. includeReferenceSeeds
        // is the discriminator: the old two-key call left it false.
        assert(
          existsSync(join(outDir, "seeds", "reference", "manifest.json")),
          "reference seed manifest proves DEFAULT_BUILD_OPTIONS was applied",
        );

        // includeManifest threads through to a real manifest.json.
        const manifest = JSON.parse(
          readFileSync(join(outDir, "manifest.json"), "utf-8"),
        ) as {
          projectVersion: string;
          sourceFingerprint: string;
          exportOptions: Record<string, boolean>;
        };
        assertEquals(manifest.projectVersion, "9.9.9");
        assert(manifest.sourceFingerprint.length > 0);
        // The policy the deploy pipeline reads back as machine-checkable fact.
        assertEquals(manifest.exportOptions.includeSeedData, false);
        assertEquals(manifest.exportOptions.includeEnvFile, false);
      } finally {
        rmSync(projectDir, { recursive: true, force: true });
      }
    });
  },
});

Deno.test({
  ...testOpts,
  name:
    "export_project refuses to escape the project or clobber a non-empty out",
  fn: async () => {
    await withKernel(async (kernel) => {
      const projectDir = await Deno.makeTempDir({
        dir: TEST_TMP_DIR,
        prefix: "tideide-dispatch-export-guard-",
      });
      kernel.projectDir = projectDir;
      try {
        writeFileSync(
          join(projectDir, "opentide.json"),
          JSON.stringify({
            name: "Guard",
            createdAt: "2026-01-01T00:00:00.000Z",
          }) +
            "\n",
        );

        // `out` comes from a prompt-driven tool call; an unconstrained absolute path
        // would be a write-anywhere primitive.
        const escaped = await dispatchTool(
          "export_project",
          { out: "../escaped" },
          kernel,
          noop,
        );
        assertEquals(escaped.ok, false);
        assertEquals(escaped.error?.code, "EXPORT_OUT_ESCAPES_PROJECT");

        const atRoot = await dispatchTool(
          "export_project",
          { out: "." },
          kernel,
          noop,
        );
        assertEquals(atRoot.ok, false);
        assertEquals(atRoot.error?.code, "EXPORT_OUT_IS_PROJECT_ROOT");

        // A merge over a previous export would leave a since-deleted entity's file
        // behind, so a non-empty target is refused rather than written through.
        const outDir = join(projectDir, "dist", "v1");
        Deno.mkdirSync(outDir, { recursive: true });
        writeFileSync(
          join(outDir, "stale-handler.ts"),
          "export const gone = 1;",
        );

        const occupied = await dispatchTool(
          "export_project",
          { out: "dist/v1" },
          kernel,
          noop,
        );
        assertEquals(occupied.ok, false);
        assertEquals(occupied.error?.code, "EXPORT_OUT_NOT_EMPTY");
        assert(
          existsSync(join(outDir, "stale-handler.ts")),
          "a refused export must not have touched the target",
        );

        const forced = await dispatchTool(
          "export_project",
          { out: "dist/v1", force: true },
          kernel,
          noop,
        );
        assertEquals(forced.ok, true);
        assertEquals(
          existsSync(join(outDir, "stale-handler.ts")),
          false,
          "force clears the target so no stale file survives",
        );
        assert(existsSync(join(outDir, "main.ts")));
      } finally {
        rmSync(projectDir, { recursive: true, force: true });
      }
    });
  },
});

// An MCP client's session, as mcp/mcp-server.ts creates it.
async function mcpSession(kernel: Kernel, name: string): Promise<string> {
  const session = await kernel.sessions.createSession(name);
  await kernel.sessions.updateSummaryMetadata(
    session.id,
    null,
    mcpSessionMetadata(),
  );
  return session.id;
}

Deno.test({
  ...testOpts,
  name: "adopt_changeset: a gone client's changeset moves to the next one",
  fn: async () => {
    await withKernel(async (kernel) => {
      const gone = await mcpSession(kernel, "claude-code (MCP) #aaaa");
      const next = await mcpSession(kernel, "claude-code (MCP) #bbbb");
      kernel.liveSessions.touch(gone);
      const held = await dispatchTool(
        "create_changeset",
        { title: "Left behind", plan: ONE_STEP_PLAN },
        kernel,
        noop,
        { sessionId: gone },
      );
      const heldId = (held.data as { id: string }).id;

      // Still connected: the next client is refused and can't take it.
      kernel.liveSessions.touch(next);
      const live = await dispatchTool("adopt_changeset", {}, kernel, noop, {
        sessionId: next,
      });
      assertEquals(live.error?.code, "CHANGESET_HELD");

      // The client disconnects.
      kernel.liveSessions.close(gone);
      await kernel.sessions.endSession(gone);
      const refused = await dispatchTool(
        "create_changeset",
        { title: "Fresh", plan: ONE_STEP_PLAN },
        kernel,
        noop,
        { sessionId: next },
      );
      assertEquals(refused.error?.code, "CHANGESET_ACTIVE");
      assert(refused.error?.suggestion?.includes("adopt_changeset"));
      const status = await dispatchTool("project_status", {}, kernel, noop, {
        sessionId: next,
      });
      const statusData = status.data as {
        heldElsewhere: { orphaned: boolean } | null;
        next: string;
      };
      assertEquals(statusData.heldElsewhere?.orphaned, true);
      assert(statusData.next.includes("adopt_changeset"));

      const adopted = await dispatchTool(
        "adopt_changeset",
        { changeset_id: heldId },
        kernel,
        noop,
        { sessionId: next },
      );
      assertEquals(adopted.ok, true);
      assertEquals(
        (adopted.data as { adoptedBecause: string }).adoptedBecause,
        "client_disconnected",
      );
      assertEquals((await kernel.changesets.getActive(next))?.id, heldId);
      assertEquals(await kernel.changesets.getActive(gone), null);
    });
  },
});

Deno.test({
  ...testOpts,
  name: "adopt_changeset: after a restart nothing is connected, so it moves",
  fn: async () => {
    await withKernel(async (kernel) => {
      // Never touched: the server restarted since this client last called.
      const before = await mcpSession(kernel, "codex (MCP) #cccc");
      const after = await mcpSession(kernel, "codex (MCP) #dddd");
      const held = await dispatchTool(
        "create_changeset",
        { title: "Before restart", plan: ONE_STEP_PLAN },
        kernel,
        noop,
        { sessionId: before },
      );
      const heldId = (held.data as { id: string }).id;
      const abandoned = await dispatchTool(
        "abandon_changeset",
        { changeset_id: heldId },
        kernel,
        noop,
        { sessionId: after },
      );
      assertEquals(abandoned.ok, true, "an orphan can be abandoned by anyone");
      assertEquals((await kernel.changesets.get(heldId))?.status, "abandoned");
    });
  },
});

Deno.test({
  ...testOpts,
  name: "adopt_changeset: an IDE chat's changeset is never adoptable",
  fn: async () => {
    await withKernel(async (kernel) => {
      const ide = await kernel.sessions.createSession("IDE chat");
      const agent = await mcpSession(kernel, "claude-code (MCP) #eeee");
      await dispatchTool(
        "create_changeset",
        { title: "IDE work", plan: ONE_STEP_PLAN },
        kernel,
        noop,
        { sessionId: ide.id },
      );
      await kernel.sessions.endSession(ide.id);
      const refused = await dispatchTool("adopt_changeset", {}, kernel, noop, {
        sessionId: agent,
      });
      assertEquals(refused.error?.code, "CHANGESET_HELD");
    });
  },
});
