import { assertEquals } from "@std/assert";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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
