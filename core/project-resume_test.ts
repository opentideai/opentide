import { assertEquals, assertExists } from "@std/assert";
import { testStoreComposition } from "../verification/test-stores.ts";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createProject,
  getProjectPaths,
  removeProject,
} from "./project-manager.ts";
import { loadProject, unloadProject } from "./project-loader.ts";
import { compileHandler, initCompiler, stopCompiler } from "./compiler.ts";
import { isolateHome, TEST_TMP_DIR } from "./test-home_test.ts";

isolateHome();

const testOpts = { sanitizeResources: false, sanitizeOps: false };

Deno.test({
  ...testOpts,
  name: "project resumes IDE state and history without data directory",
  fn: async () => {
    await initCompiler();
    const baseDir = await Deno.makeTempDir({
      dir: TEST_TMP_DIR,
      prefix: "tideide-resume-",
    });
    const entry = createProject(baseDir, "Resume App");
    const paths = getProjectPaths(entry.path);

    let ctx = await loadProject(entry.path, {
      appPort: 0,
      composition: testStoreComposition(),
    });
    try {
      const deps = await ctx.kernel.compileDeps();
      const source = "function hello() { return new Response('hello'); }";
      const compiled = await compileHandler("hello", source, deps);
      if (!compiled.ok) throw new Error(compiled.error.message);

      ctx.kernel.handlers.register("hello", source, compiled.data);
      ctx.kernel.routes.register("GET", "/hello", "hello");
      ctx.kernel.configs.set("appName", "Resume App");
      const schema = await ctx.db.defineSchema(
        "items",
        "CREATE TABLE items (id SERIAL PRIMARY KEY, name TEXT NOT NULL)",
      );
      if (!schema.ok) throw new Error(schema.error.message);
      const altered = await ctx.db.alterSchema(
        "items",
        "ALTER TABLE items ADD COLUMN quantity INTEGER NOT NULL DEFAULT 1",
      );
      if (!altered.ok) throw new Error(altered.error.message);
      await ctx.db.execute(
        "INSERT INTO items (name, quantity) VALUES ($1, $2)",
        ["local row", 2],
      );

      const session = await ctx.kernel.sessions.createSession("Resume Session");
      const message = await ctx.kernel.sessions.addMessage({
        sessionId: session.id,
        role: "user",
        content: "keep this message",
        turnId: "turn_resume",
      });
      const changeset = await ctx.kernel.changesets.create({
        sessionId: session.id,
        title: "Resume Changeset",
        plan: {
          summary: "Resume plan",
          steps: [{ id: "s1", description: "Step", status: "pending" }],
          acceptanceCriteria: [{
            id: "claim_resume_changeset",
            text: "The changeset is restored with the resumed project.",
            source: "agent",
            priority: "must",
          }],
          verificationPlan: [{
            id: "check_resume_changeset",
            claimIds: ["claim_resume_changeset"],
            kind: "unit",
            description: "Assert the resumed project exposes the changeset.",
          }],
        },
        planMessageIds: [message.id],
      });
      await ctx.kernel.changelog.record({
        category: "handler",
        key: "hello",
        action: "create",
        beforeSnapshot: null,
        afterSnapshot: { source },
        context: {
          turnId: "turn_resume",
          sessionId: session.id,
          changesetId: changeset.id,
          userMessage: "keep this message",
        },
      });
      ctx.kernel.log.log("warn", "system", "persist this log entry");
    } finally {
      await unloadProject(ctx);
    }

    assertEquals(existsSync(paths.dataDir), true);
    assertEquals(existsSync(paths.logsCache), true);
    assertEquals(existsSync(join(paths.schemaDir, "items.json")), true);
    rmSync(paths.dataDir, { recursive: true, force: true });
    assertEquals(existsSync(paths.dataDir), false);

    ctx = await loadProject(entry.path, {
      appPort: 0,
      composition: testStoreComposition(),
    });
    try {
      assertEquals(ctx.kernel.configs.get("appName"), "Resume App");
      assertExists(ctx.kernel.handlers.get("hello"));
      assertEquals(ctx.kernel.routes.list()[0]?.path, "/hello");

      const schemas = await ctx.db.listSchemas();
      assertEquals(schemas.length, 1);
      assertEquals(schemas[0]!.tableName, "items");
      assertEquals(
        schemas[0]!.columns.some((column) => column.name === "quantity"),
        true,
      );
      const migrations = await ctx.db.listMigrations("items");
      assertEquals(migrations.length, 2);
      const rows = await ctx.db.query("SELECT COUNT(*) AS count FROM items");
      assertEquals(Number(rows[0]!.count), 0);
      await ctx.db.execute(
        "INSERT INTO items (name, quantity) VALUES ($1, $2)",
        ["new local row", 3],
      );

      const sessions = await ctx.kernel.sessions.listSessions();
      assertEquals(sessions.length, 1);
      assertEquals(sessions[0]!.name, "Resume Session");

      const messages = await ctx.kernel.sessions.getMessages(sessions[0]!.id);
      assertEquals(messages.length, 1);
      assertEquals(messages[0]!.content, "keep this message");

      const changesets = await ctx.kernel.changesets.list({
        sessionId: sessions[0]!.id,
      });
      assertEquals(changesets.length, 1);
      assertEquals(changesets[0]!.title, "Resume Changeset");

      const changes = await ctx.kernel.changelog.listByChangeset(
        changesets[0]!.id,
      );
      assertEquals(changes.length, 1);
      assertEquals(changes[0]!.key, "hello");
      assertEquals(await ctx.kernel.changelog.getCursor(), changes[0]!.id);

      const logs = ctx.kernel.log.query({ search: "persist this log entry" });
      assertEquals(logs.length, 1);
      assertEquals(logs[0]!.source, "system");
      assertEquals(logs[0]!.level, "warn");
    } finally {
      await unloadProject(ctx);
      removeProject(entry.path);
      rmSync(baseDir, { recursive: true, force: true });
      stopCompiler();
    }
  },
});

Deno.test({
  ...testOpts,
  name: "unloadProject is idempotent",
  fn: async () => {
    await initCompiler();
    const baseDir = await Deno.makeTempDir({
      dir: TEST_TMP_DIR,
      prefix: "tideide-unload-",
    });
    const entry = createProject(baseDir, "Unload App");
    const ctx = await loadProject(entry.path, {
      appPort: 0,
      composition: testStoreComposition(),
    });

    try {
      await Promise.all([unloadProject(ctx), unloadProject(ctx)]);
      await unloadProject(ctx);
    } finally {
      removeProject(entry.path);
      rmSync(baseDir, { recursive: true, force: true });
      stopCompiler();
    }
  },
});

Deno.test({
  ...testOpts,
  name: "loadProject runs project doctor when state restore has issues",
  fn: async () => {
    await initCompiler();
    const baseDir = await Deno.makeTempDir({
      dir: TEST_TMP_DIR,
      prefix: "tideide-load-doctor-",
    });
    const entry = createProject(baseDir, "Load Doctor App");
    const paths = getProjectPaths(entry.path);
    mkdirSync(paths.stateDir, { recursive: true });
    writeFileSync(
      join(paths.stateDir, "configs.json"),
      '{"version":1, "incomplete...',
    );

    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...parts: unknown[]) => {
      warnings.push(parts.map(String).join(" "));
    };

    let ctx: Awaited<ReturnType<typeof loadProject>> | null = null;
    try {
      ctx = await loadProject(entry.path, {
        appPort: 0,
        composition: testStoreComposition(),
      });
    } finally {
      console.warn = originalWarn;
      if (ctx) await unloadProject(ctx);
      removeProject(entry.path);
      rmSync(baseDir, { recursive: true, force: true });
      stopCompiler();
    }

    assertEquals(
      warnings.some((line) => line.includes("State restore warnings")),
      true,
    );
    assertEquals(
      warnings.some((line) => line.includes("Project doctor found 1 error")),
      true,
    );
    assertEquals(
      warnings.some((line) => line.includes("INVALID_JSON")),
      true,
    );
  },
});
