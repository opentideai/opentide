// Every mutation lands in the changelog under the changeset that made it. Task
// merges, rollback and change-class adjudication all read a changeset's footprint
// from these records, so a writer that skips them is invisible to all three.
import { assert, assertEquals } from "@std/assert";
import { join } from "node:path";
import { testComposition } from "../../cli/test-composition.ts";
import { initCompiler, stopCompiler } from "../compiler.ts";
import { startControlServer } from "../control-server.ts";
import { Database } from "../db.ts";
import { Kernel } from "../registries.ts";
import { dispatchTool, MODIFICATION_TOOLS } from "./dispatch.ts";

const testOpts = { sanitizeResources: false, sanitizeOps: false };
const noop = () => {};

// Verbs the walk below does not run, and why. Anything else in MODIFICATION_TOOLS
// must appear in STEPS, so a new writer can't ship without a record.
const NOT_WALKED: Record<string, string> = {
  install_package: "reaches the package registry",
  remove_package: "needs an installed package, which reaches the registry",
  document_write: "documents version themselves; not a changelog entity",
};

type Step = [verb: string, input: Record<string, unknown>];

const handlerSource = (name: string) =>
  `async function ${name}(c) { return c.json({ ok: true }); }`;

const STEPS: Step[] = [
  ["define_handler", { name: "hello", source: handlerSource("hello") }],
  ["define_handler", {
    name: "spare",
    source: handlerSource("spare"),
    duplicateJustification: "Throwaway, removed below.",
  }],
  ["define_function", {
    name: "double",
    source: "function double(n: number): number { return n * 2; }",
  }],
  ["define_function", {
    name: "triple",
    source: "function triple(n: number): number { return n * 3; }",
    duplicateJustification: "Throwaway, removed below.",
  }],
  ["register_route", { method: "GET", path: "/hello", handlerName: "hello" }],
  ["register_route", { method: "GET", path: "/spare", handlerName: "spare" }],
  ["unregister_route", { method: "GET", path: "/spare" }],
  ["remove_handler", { name: "spare" }],
  ["remove_function", { name: "triple" }],
  ["define_schema", {
    tableName: "items",
    sql: "CREATE TABLE items (id SERIAL PRIMARY KEY, name TEXT NOT NULL)",
  }],
  ["alter_schema", {
    tableName: "items",
    sql: "ALTER TABLE items ADD COLUMN note TEXT",
  }],
  ["execute_sql", { sql: "INSERT INTO items (name) VALUES ('one')" }],
  ["define_schema", {
    tableName: "scratch",
    sql: "CREATE TABLE scratch (id SERIAL PRIMARY KEY)",
  }],
  ["drop_schema", { tableName: "scratch" }],
  // Not a writer: it produces the fixture import_data reads back.
  ["export_data", { name: "seed" }],
  ["reset_data", { tables: ["items"] }],
  ["import_data", { name: "seed" }],
  ["define_template", { name: "header", content: "<header>Hi</header>" }],
  ["edit_entity_text", {
    type: "template",
    name: "header",
    edits: [{ find: "Hi", replace: "Hello" }],
  }],
  ["define_template", { name: "old", content: "<p>old</p>" }],
  ["delete_template", { name: "old" }],
  ["define_test", {
    name: "testDouble",
    source: "async function testDouble() { assertEquals(double(2), 4); }",
  }],
  ["define_test", {
    name: "testSpare",
    source: "async function testSpare() { assertEquals(1, 1); }",
  }],
  ["remove_test", { name: "testSpare" }],
  ["upload_text_asset", {
    name: "app.css",
    content: "body { color: red; }\n",
    mimeType: "text/css",
  }],
  ["upload_asset", {
    name: "dot.bin",
    contentBase64: btoa("\x00\x01\x02"),
    mimeType: "application/octet-stream",
  }],
  ["delete_asset", { name: "dot.bin" }],
  ["define_dev_view", {
    name: "itemView",
    targetType: "item",
    title: "Item",
    source:
      "function itemView(object) { return { type: 'markdown', content: 'x' }; }",
  }],
  ["remove_dev_view", { name: "itemView" }],
  ["define_dev_tool", {
    name: "ping",
    description: "Ping",
    args: [],
    source: "async function ping() { return { pong: true }; }",
  }],
  ["remove_dev_tool", { name: "ping" }],
  ["define_type", {
    name: "Item",
    fields: [{ name: "name", type: "string" }],
  }],
  ["define_type", { name: "Spare", fields: [{ name: "x", type: "number" }] }],
  ["remove_type", { name: "Spare" }],
  ["define_secret", { key: "API_TOKEN", description: "Token" }],
  ["set_secret_value", { key: "API_TOKEN", value: "s3cret" }],
  ["clear_secret_value", { key: "API_TOKEN" }],
  ["delete_secret", { key: "API_TOKEN" }],
  ["set_config", { name: "greeting", value: "hi" }],
  ["delete_config", { name: "greeting" }],
  ["set_env", { key: "MODE", value: "dev" }],
  ["delete_env", { key: "MODE" }],
  ["define_env_var", { key: "REGION", description: "Region" }],
  ["set_env_var_value", { key: "REGION", value: "eu" }],
  ["clear_env_var_value", { key: "REGION" }],
  ["delete_env_var", { key: "REGION" }],
  ["define_audit", {
    name: "naming",
    description: "Naming audit",
    prompt: "Check names.",
  }],
  ["remove_audit", { name: "naming" }],
  ["define_template", { name: "gone", content: "<p>gone</p>" }],
  ["remove_entity", { type: "template", key: "gone" }],
  ["move_to_module", { category: "handler", key: "hello", module: "greet" }],
  ["move_to_module", { category: "schema", key: "items", module: "greet" }],
  ["rename_module", { oldName: "greet", newName: "greeting" }],
  ["apply_project_file", {
    path: "notes.md",
    content: "# Notes\n",
    baseFingerprint: null,
  }],
  ["write_project_file", { path: "docs/extra.md", content: "extra\n" }],
  ["generate_project_docs", { files: ["README.md"] }],
  // Last: it swaps the whole registry state back to the snapshot.
  ["restore_snapshot", { id: "$snapshot" }],
];

async function withProjectKernel(
  fn: (kernel: Kernel) => Promise<void>,
): Promise<void> {
  await initCompiler();
  const db = await Database.create({ driver: "pglite" });
  const kernel = new Kernel(db, { composition: testComposition() });
  const projectDir = await Deno.makeTempDir({ prefix: "tide-completeness-" });
  kernel.projectDir = projectDir;
  try {
    await fn(kernel);
  } finally {
    await db.close();
    stopCompiler();
    await Deno.remove(projectDir, { recursive: true });
  }
}

async function startChangeset(kernel: Kernel): Promise<string> {
  const created = await dispatchTool(
    "create_changeset",
    {
      title: "Exercise every writer",
      plan: {
        summary: "Run every mutation verb once.",
        steps: ["Run them"],
        acceptanceCriteria: ["Each write is recorded."],
        verificationPlan: [{
          id: "check_records",
          claimIds: ["claim_0"],
          kind: "unit",
          description: "Each write has a changelog record.",
        }],
      },
    },
    kernel,
    noop,
  );
  assertEquals(created.ok, true, JSON.stringify(created.error));
  const id = (created.data as { id: string }).id;
  await kernel.changesets.approve(id);
  await kernel.changesets.startWork(id);
  return id;
}

Deno.test("every mutation verb is walked or excused", () => {
  const walked = new Set(STEPS.map(([verb]) => verb));
  const missing = [...MODIFICATION_TOOLS].filter((verb) =>
    !walked.has(verb) && !(verb in NOT_WALKED)
  );
  assertEquals(missing, [], "add these verbs to STEPS or NOT_WALKED");
  for (const verb of Object.keys(NOT_WALKED)) {
    assert(MODIFICATION_TOOLS.has(verb), `${verb} is not a mutation verb`);
  }
});

Deno.test({
  ...testOpts,
  name: "every mutation verb records under the active changeset",
  fn: async () => {
    await withProjectKernel(async (kernel) => {
      const snapshot = await dispatchTool("take_snapshot", {}, kernel, noop);
      assertEquals(snapshot.ok, true);
      const snapshotId = (snapshot.data as { id: string }).id;
      const changesetId = await startChangeset(kernel);

      for (const [verb, rawInput] of STEPS) {
        const input = rawInput.id === "$snapshot"
          ? { ...rawInput, id: snapshotId }
          : rawInput;
        const before = (await kernel.changelog.listByChangeset(changesetId))
          .length;
        const result = await dispatchTool(verb, input, kernel, noop, {});
        assertEquals(
          result.ok,
          true,
          `${verb}: ${JSON.stringify(result.error)}`,
        );
        const after = (await kernel.changelog.listByChangeset(changesetId))
          .length;
        if (MODIFICATION_TOOLS.has(verb)) {
          assert(after > before, `${verb} wrote no record under the changeset`);
        }
      }
    });
  },
});

Deno.test({
  ...testOpts,
  name: "module moves record each entity and leave the table's rows alone",
  fn: async () => {
    await withProjectKernel(async (kernel) => {
      const changesetId = await startChangeset(kernel);
      const run = async (verb: string, input: Record<string, unknown>) => {
        const result = await dispatchTool(verb, input, kernel, noop, {});
        assertEquals(
          result.ok,
          true,
          `${verb}: ${JSON.stringify(result.error)}`,
        );
      };
      await run("define_handler", {
        name: "hello",
        source: handlerSource("hello"),
        module: "a",
      });
      await run("define_schema", {
        tableName: "items",
        sql: "CREATE TABLE items (id SERIAL PRIMARY KEY, name TEXT)",
        module: "a",
      });
      await run("alter_schema", {
        tableName: "items",
        sql: "ALTER TABLE items ADD COLUMN note TEXT",
      });
      await run("execute_sql", {
        sql: "INSERT INTO items (name) VALUES ('x')",
      });

      await run("rename_module", { oldName: "a", newName: "b" });

      const rows = await kernel.db.query("SELECT name FROM items");
      assertEquals(rows.length, 1, "the rename rebuilt the table");
      assertEquals((await kernel.db.getSchema("items")).ok, true);
      const schema = await kernel.db.getSchema("items");
      assertEquals(schema.ok && schema.data.module, "b");
      assertEquals(kernel.handlers.get("hello")?.module, "b");

      const records = await kernel.changelog.listByChangeset(changesetId);
      const moves = records.filter((r) =>
        (r.afterSnapshot as { module?: string } | null)?.module === "b"
      );
      assertEquals(
        moves.map((r) => `${r.category}:${r.key}`).sort(),
        ["handler:hello", "schema:items"],
      );

      await runVerb(kernel, "undo_change");
      await runVerb(kernel, "undo_change");
      assertEquals(kernel.handlers.get("hello")?.module, "a");
      const restored = await kernel.db.getSchema("items");
      assertEquals(restored.ok && restored.data.module, "a");
    });
  },
});

Deno.test({
  ...testOpts,
  name: "env var, type and audit changes undo and redo",
  fn: async () => {
    await withProjectKernel(async (kernel) => {
      await startChangeset(kernel);
      const run = async (verb: string, input: Record<string, unknown>) => {
        const result = await dispatchTool(verb, input, kernel, noop, {});
        assertEquals(
          result.ok,
          true,
          `${verb}: ${JSON.stringify(result.error)}`,
        );
      };
      const undo = () => run("undo_change", {});
      const redo = () => run("redo_change", {});

      await run("define_env_var", { key: "REGION", description: "Region" });
      await run("set_env_var_value", { key: "REGION", value: "eu" });
      await undo();
      assertEquals(kernel.envVars.get("REGION")?.value, undefined);
      assertEquals(kernel.envVars.get("REGION")?.description, "Region");
      await redo();
      assertEquals(kernel.envVars.get("REGION")?.value, "eu");

      await run("define_type", {
        name: "Item",
        fields: [{ name: "name", type: "string" }],
        module: "shop",
      });
      await run("remove_type", { name: "Item" });
      await undo();
      assertEquals(kernel.types.get("Item")?.module, "shop");

      await run("define_audit", {
        name: "naming",
        description: "Naming",
        prompt: "Check names.",
      });
      await run("define_audit", {
        name: "naming",
        description: "Naming v2",
        prompt: "Check names harder.",
      });
      await undo();
      assertEquals(kernel.customAudits.get("naming")?.prompt, "Check names.");
      await undo();
      assertEquals(kernel.customAudits.get("naming"), undefined);
    });
  },
});

async function runVerb(
  kernel: Kernel,
  verb: string,
  input: Record<string, unknown> = {},
): Promise<void> {
  const result = await dispatchTool(verb, input, kernel, noop, {});
  assertEquals(result.ok, true, `${verb}: ${JSON.stringify(result.error)}`);
}

Deno.test({
  ...testOpts,
  name: "alter_schema records the statement, its reverse and the changeset",
  fn: async () => {
    await withProjectKernel(async (kernel) => {
      const changesetId = await startChangeset(kernel);
      await runVerb(kernel, "define_schema", {
        tableName: "items",
        sql: "CREATE TABLE items (id SERIAL PRIMARY KEY, name TEXT)",
      });
      await runVerb(kernel, "alter_schema", {
        tableName: "items",
        sql: "ALTER TABLE items ADD COLUMN note TEXT",
      });

      const alter = (await kernel.changelog.listByChangeset(changesetId))
        .find((r) => r.category === "schema" && r.action === "update");
      const after = alter?.afterSnapshot as Record<string, unknown>;
      assertEquals(after.statement, "ALTER TABLE items ADD COLUMN note TEXT");
      assertEquals(after.migrationVersion, 2);
      assert(
        typeof after.reverseSql === "string" &&
          /DROP COLUMN/i.test(after.reverseSql),
        `reverse: ${after.reverseSql}`,
      );
      assert(String(after.sql).startsWith("CREATE TABLE items"));

      const migrations = await kernel.db.listMigrations("items");
      assertEquals(
        migrations.map((m) => m.changesetId),
        [changesetId, changesetId],
      );
    });
  },
});

Deno.test({
  ...testOpts,
  name: "binary assets undo to their exact bytes and module",
  fn: async () => {
    await withProjectKernel(async (kernel) => {
      await startChangeset(kernel);
      const v1 = new Uint8Array([0, 1, 2, 250]);
      const v2 = new Uint8Array([9, 9]);
      const upload = (bytes: Uint8Array) =>
        runVerb(kernel, "upload_asset", {
          name: "logo.bin",
          contentBase64: btoa(String.fromCharCode(...bytes)),
          mimeType: "application/octet-stream",
          module: "brand",
        });
      const bytes = () => kernel.assets.get("logo.bin")?.content;

      await upload(v1);
      await upload(v2);
      await runVerb(kernel, "undo_change");
      assertEquals(bytes(), v1);
      assertEquals(kernel.assets.get("logo.bin")?.module, "brand");
      await runVerb(kernel, "redo_change");
      assertEquals(bytes(), v2);

      await runVerb(kernel, "delete_asset", { name: "logo.bin" });
      await runVerb(kernel, "undo_change");
      assertEquals(bytes(), v2);

      await runVerb(kernel, "move_to_module", {
        category: "asset",
        key: "logo.bin",
        module: "media",
      });
      await runVerb(kernel, "undo_change");
      assertEquals(kernel.assets.get("logo.bin")?.module, "brand");
      assertEquals(bytes(), v2);
    });
  },
});

Deno.test({
  ...testOpts,
  name: "a schema module move undoes",
  fn: async () => {
    await withProjectKernel(async (kernel) => {
      await startChangeset(kernel);
      await runVerb(kernel, "define_schema", {
        tableName: "items",
        sql: "CREATE TABLE items (id SERIAL PRIMARY KEY)",
        module: "a",
      });
      await runVerb(kernel, "move_to_module", {
        category: "schema",
        key: "items",
        module: "b",
      });
      await runVerb(kernel, "undo_change");
      const schema = await kernel.db.getSchema("items");
      assertEquals(schema.ok && schema.data.module, "a");
    });
  },
});

Deno.test({
  ...testOpts,
  name: "a failed undo leaves the cursor where it was",
  fn: async () => {
    await withProjectKernel(async (kernel) => {
      await startChangeset(kernel);
      await runVerb(kernel, "upload_asset", {
        name: "logo.bin",
        contentBase64: btoa("\x00\x01"),
        mimeType: "application/octet-stream",
      });
      await runVerb(kernel, "upload_asset", {
        name: "logo.bin",
        contentBase64: btoa("\x02\x03"),
        mimeType: "application/octet-stream",
      });
      const cursor = await kernel.changelog.getCursor();
      const blobs = join(kernel.projectDir!, ".opentide/history/asset-blobs");
      const hidden = `${blobs}.hidden`;
      await Deno.rename(blobs, hidden);

      const failed = await dispatchTool("undo_change", {}, kernel, noop, {});
      assertEquals(failed.ok, false);
      assertEquals(await kernel.changelog.getCursor(), cursor);

      await Deno.rename(hidden, blobs);
      await runVerb(kernel, "undo_change");
      assertEquals(
        kernel.assets.get("logo.bin")?.content,
        new Uint8Array([0, 1]),
      );
    });
  },
});

// IDE writes that don't go through a verb. Each must land under the open changeset.
const REST_WRITES: Array<[method: string, path: string, body?: unknown]> = [
  ["PUT", "/api/env/MODE", { value: "dev" }],
  ["DELETE", "/api/env/MODE"],
  ["PUT", "/api/custom-audits/naming", {
    description: "Naming",
    prompt: "Check names.",
  }],
  ["DELETE", "/api/custom-audits/naming"],
  ["PUT", "/api/configs/greeting", { value: "hi" }],
  ["DELETE", "/api/configs/greeting"],
  ["POST", "/api/env-vars", { key: "REGION" }],
  ["POST", "/api/secrets", { key: "API_TOKEN" }],
  ["PUT", "/api/entities/handler/hello", { source: handlerSource("hello") }],
];

Deno.test({
  ...testOpts,
  name: "IDE writes record under the open changeset",
  fn: async () => {
    await withProjectKernel(async (kernel) => {
      const changesetId = await startChangeset(kernel);
      const now = new Date().toISOString();
      const control = await startControlServer(
        {
          entry: {
            path: kernel.projectDir!,
            name: "completeness",
            createdAt: now,
            lastOpenedAt: now,
          },
          kernel,
          db: kernel.db,
          appServer: { shutdown: async () => {} } as never,
          devServer: { shutdown: async () => {} } as never,
          commandRunner: { shutdown: async () => {} } as never,
          rebuild: noop,
        },
        0,
      );
      try {
        const base = `http://127.0.0.1:${control.server.addr.port}`;
        for (const [method, path, body] of REST_WRITES) {
          const before = (await kernel.changelog.listByChangeset(changesetId))
            .length;
          const res = await fetch(`${base}${path}`, {
            method,
            headers: { "content-type": "application/json" },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          });
          const text = await res.text();
          assert(res.ok, `${method} ${path}: ${res.status} ${text}`);
          const after = (await kernel.changelog.listByChangeset(changesetId))
            .length;
          assert(after > before, `${method} ${path} wrote no record`);
        }
        const dotEnv = (await kernel.changelog.listByChangeset(changesetId))
          .filter((r) => r.category === "env_var" && r.key === "MODE");
        assert(
          !JSON.stringify(dotEnv).includes("dev"),
          ".env values must not reach the changelog",
        );
      } finally {
        await control.server.shutdown();
      }
    });
  },
});
