// Fixtures shared by the task fork, diff and merge tests: a loaded main project
// under its own HOME, and a way to work in a fork.
import { rmSync } from "node:fs";
import { testComposition } from "../../cli/test-composition.ts";
import { compileHandler, initCompiler, stopCompiler } from "../compiler.ts";
import { createProject, getProjectPaths } from "../project-manager.ts";
import {
  loadProject,
  type ProjectContext,
  unloadProject,
} from "../project-loader.ts";
import type { Kernel } from "../registries.ts";
import { createTaskFork, discardTaskFork } from "./fork.ts";
import { readTasks } from "./task-store.ts";

export const testOpts = { sanitizeResources: false, sanitizeOps: false };

// Each test gets its own HOME, so forks, the registry and backups land in a
// temp dir, and a loaded main project with one handler and one app row.
export async function withMainProject(
  fn: (main: ProjectContext) => Promise<void>,
): Promise<void> {
  const prevHome = Deno.env.get("HOME");
  const home = await Deno.makeTempDir({ prefix: "genie-task-home-" });
  const baseDir = await Deno.makeTempDir({ prefix: "genie-task-project-" });
  let main: ProjectContext | null = null;
  try {
    Deno.env.set("HOME", home);
    await initCompiler();
    const entry = createProject(baseDir, "Fork Main");
    main = await loadProject(entry.path, {
      appPort: 0,
      composition: testComposition(),
    });
    await registerHandler(main.kernel, "calcTotal");
    main.kernel.routes.register("GET", "/total", "calcTotal");
    main.rebuild();
    const schema = await main.db.defineSchema(
      "items",
      "CREATE TABLE items (id SERIAL PRIMARY KEY, name TEXT NOT NULL)",
    );
    if (!schema.ok) throw new Error(schema.error.message);
    await main.db.execute("INSERT INTO items (name) VALUES ($1)", ["main row"]);
    await fn(main);
  } finally {
    if (main) {
      for (
        const task of readTasks(getProjectPaths(main.entry.path).tasksFile)
      ) {
        await discardTaskFork(main.kernel, task.id);
      }
      await unloadProject(main);
    }
    stopCompiler();
    rmSync(baseDir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
    if (prevHome === undefined) Deno.env.delete("HOME");
    else Deno.env.set("HOME", prevHome);
  }
}

export async function registerHandler(
  kernel: Kernel,
  name: string,
): Promise<void> {
  const source = `function ${name}() { return new Response("${name}"); }`;
  const compiled = await compileHandler(
    name,
    source,
    await kernel.compileDeps(),
  );
  if (!compiled.ok) throw new Error(compiled.error.message);
  kernel.handlers.register(name, source, compiled.data);
}

export async function createOk(
  kernel: Kernel,
  title: string,
  claims?: string[],
) {
  const created = await createTaskFork(kernel, { title, claims });
  if (!created.ok) throw new Error(created.error.message);
  return created.data;
}

// Loads the fork, runs `fn` in it, and unloads it, which flushes its state.
export async function inFork(
  forkPath: string,
  fn: (fork: ProjectContext) => Promise<void>,
): Promise<void> {
  const fork = await loadProject(forkPath, {
    appPort: 0,
    composition: testComposition(),
  });
  try {
    await fn(fork);
  } finally {
    await unloadProject(fork);
  }
}
