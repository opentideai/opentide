import { assertEquals } from "@std/assert";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { testStoreComposition } from "../verification/test-stores.ts";
import {
  createProject,
  getProjectPaths,
  removeProject,
} from "./project-manager.ts";
import { PRIVATE_HISTORY_DIR } from "./config.ts";
import { loadProject, unloadProject } from "./project-loader.ts";
import { initCompiler, stopCompiler } from "./compiler.ts";
import { isolateHome, TEST_TMP_DIR } from "./test-home_test.ts";

isolateHome();

const testOpts = { sanitizeResources: false, sanitizeOps: false };

Deno.test({
  ...testOpts,
  name: "every app rebuild bumps the kernel's app revision",
  fn: async () => {
    await initCompiler();
    const baseDir = await Deno.makeTempDir({
      dir: TEST_TMP_DIR,
      prefix: "tideide-revision-",
    });
    const entry = createProject(baseDir, "Revision App");
    const ctx = await loadProject(entry.path, {
      appPort: 0,
      composition: testStoreComposition(),
    });
    try {
      const before = ctx.kernel.appRevision;
      ctx.rebuild();
      ctx.rebuild();
      assertEquals(ctx.kernel.appRevision, before + 2);
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
  name: "loading a project moves its private sessions out of shared history",
  fn: async () => {
    await initCompiler();
    const baseDir = await Deno.makeTempDir({
      dir: TEST_TMP_DIR,
      prefix: "tideide-private-move-",
    });
    const entry = createProject(baseDir, "Private Move App");
    const historyDir = getProjectPaths(entry.path).historyDir;
    const id = "session_written_before_private_dir";
    mkdirSync(join(historyDir, "sessions"), { recursive: true });
    writeFileSync(
      join(historyDir, "sessions", `${id}.json`),
      JSON.stringify({ id, name: "Old", visibility: "private" }),
    );
    const ctx = await loadProject(entry.path, {
      appPort: 0,
      composition: testStoreComposition(),
    });
    try {
      assertEquals(
        existsSync(join(historyDir, "sessions", `${id}.json`)),
        false,
      );
      assertEquals(
        existsSync(
          join(historyDir, PRIVATE_HISTORY_DIR, "sessions", `${id}.json`),
        ),
        true,
      );
      assertEquals((await ctx.kernel.sessions.getSession(id))?.name, "Old");
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
  name: "closing a project backs it up only when something changed",
  fn: async () => {
    const baseDir = await Deno.makeTempDir({
      dir: TEST_TMP_DIR,
      prefix: "opentide-shutdown-backup-",
    });
    const entry = createProject(baseDir, "Shutdown Backup");
    const backups = getProjectPaths(entry.path).backups;
    const count = () => existsSync(backups) ? readdirSync(backups).length : 0;
    const session = async (
      work: (ctx: Awaited<ReturnType<typeof loadProject>>) => Promise<void>,
    ) => {
      const ctx = await loadProject(entry.path, {
        appPort: 0,
        composition: testStoreComposition(),
      });
      try {
        await work(ctx);
      } finally {
        await unloadProject(ctx);
      }
    };
    try {
      await session(async (ctx) => {
        await ctx.db.defineSchema(
          "items",
          "CREATE TABLE items (id SERIAL PRIMARY KEY, name TEXT)",
        );
        await ctx.db.execute(`INSERT INTO items (name) VALUES ('a')`);
      });
      assertEquals(count(), 1);
      // Opened, read, closed: every session used to leave a full copy behind.
      await session(async (ctx) => {
        await ctx.db.query(`SELECT * FROM items`);
      });
      assertEquals(count(), 1, "nothing changed, nothing written");
      await session(async (ctx) => {
        await ctx.db.execute(`UPDATE items SET name = 'b'`);
      });
      assertEquals(count(), 2);
    } finally {
      removeProject(entry.path);
      rmSync(baseDir, { recursive: true, force: true });
    }
  },
});
