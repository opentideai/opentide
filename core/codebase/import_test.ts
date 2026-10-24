import { assertEquals } from "@std/assert";
import { join } from "node:path";
import {
  GENERIC_TSJS_PLUGIN_ID,
  indexSourceBackedCodebase,
  summarizeCodebaseGraph,
} from "./index.ts";

Deno.test("indexSourceBackedCodebase runs discovery, source index, and plugins", async () => {
  await withFixture({
    "package.json": JSON.stringify({
      scripts: { test: "vitest", build: "vite build" },
      dependencies: { express: "^5.0.0" },
      devDependencies: { typescript: "^5.0.0" },
    }),
    "package-lock.json": "{}",
    "tsconfig.json": "{}",
    "src/lib.ts": "export function lib() { return 1; }",
    "src/main.ts": "import { lib } from './lib'; export const value = lib();",
  }, async (root) => {
    const result = await indexSourceBackedCodebase({
      projectId: "fixture",
      rootPath: root,
      indexedAt: "2026-07-03T00:00:00.000Z",
    });

    assertEquals(result.discovery.packageManager, "npm");
    assertEquals(result.discovery.frameworkHints.map((hint) => hint.id), [
      "express",
    ]);
    assertEquals(result.sourceIndex.files.map((file) => file.path), [
      "src/lib.ts",
      "src/main.ts",
    ]);
    assertEquals(result.graph.projectId, "fixture");
    assertEquals(result.graph.indexedAt, "2026-07-03T00:00:00.000Z");
    assertEquals(result.graph.plugins.map((plugin) => plugin.pluginId), [
      GENERIC_TSJS_PLUGIN_ID,
      // Express fixture ⇒ Hono plugin runs detect, finds nothing, is skipped.
      "hono",
    ]);
    assertEquals(result.graph.files.map((file) => file.path), [
      "src/lib.ts",
      "src/main.ts",
    ]);
    assertEquals(result.graph.commands.map((command) => command.commandKind), [
      "build",
      "install",
      "test",
    ]);
    assertEquals(
      result.graph.symbols.map((symbol) => [
        symbol.name,
        symbol.file,
      ]),
      [
        ["lib", "src/lib.ts"],
        ["value", "src/main.ts"],
      ],
    );
  });
});

Deno.test("indexSourceBackedCodebase forwards plugin and source options", async () => {
  await withFixture({
    "package.json": JSON.stringify({ scripts: { test: "vitest" } }),
    "src/a.ts": "export const a = 1;",
    "src/b.ts": "export const b = 1;",
  }, async (root) => {
    const disabled = await indexSourceBackedCodebase({
      projectId: "fixture",
      rootPath: root,
      pluginOptions: { disabledPluginIds: [GENERIC_TSJS_PLUGIN_ID] },
    });
    // Generic disabled; Hono still runs detect but this fixture isn't Hono.
    assertEquals(disabled.graph.plugins.map((p) => [p.pluginId, p.status]), [
      ["hono", "skipped"],
    ]);
    assertEquals(disabled.graph.files, []);
    assertEquals(disabled.sourceIndex.files.map((file) => file.path), [
      "src/a.ts",
      "src/b.ts",
    ]);

    const capped = await indexSourceBackedCodebase({
      projectId: "fixture",
      rootPath: root,
      sourceOptions: { maxFiles: 1 },
    });
    assertEquals(capped.sourceIndex.files.map((file) => file.path), [
      "src/a.ts",
    ]);
    assertEquals(capped.graph.files.map((file) => file.path), ["src/a.ts"]);
  });
});

Deno.test("summarizeCodebaseGraph digests a Hono project without the full graph", async () => {
  await withFixture({
    "package.json": JSON.stringify({
      scripts: { dev: "deno task kernel", test: "deno test" },
      dependencies: { hono: "^4.0.0" },
    }),
    "deno.json": "{}",
    "src/app.ts": "import { Hono } from 'hono'; export const app = new Hono();",
  }, async (root) => {
    const { graph, discovery } = await indexSourceBackedCodebase({
      projectId: "hono-fixture",
      rootPath: root,
      indexedAt: "2026-07-31T00:00:00.000Z",
    });
    const summary = summarizeCodebaseGraph(graph, discovery);

    assertEquals(summary.projectId, "hono-fixture");
    assertEquals(summary.rootPath, root);
    assertEquals(summary.indexedAt, "2026-07-31T00:00:00.000Z");
    // package.json present ⇒ npm inferred (discovery checks it before deno.json).
    assertEquals(summary.packageManager, "npm");
    assertEquals(summary.frameworks, ["hono"]);
    assertEquals(summary.plugins, [GENERIC_TSJS_PLUGIN_ID, "hono"]);
    // Counts mirror the graph collections exactly (round-trip invariant).
    assertEquals(summary.counts.files, graph.files.length);
    assertEquals(summary.counts.symbols, graph.symbols.length);
    assertEquals(summary.counts.files, 1);
    // The digest carries no entity arrays — only counts + discovery basics.
    assertEquals(
      Object.keys(summary).toSorted(),
      [
        "counts",
        "frameworks",
        "indexedAt",
        "packageManager",
        "plugins",
        "projectId",
        "rootPath",
      ],
    );
  });
});

Deno.test("summarizeCodebaseGraph handles a plain-TS project with no framework", async () => {
  await withFixture({
    "package.json": JSON.stringify({ scripts: { build: "tsc" } }),
    "package-lock.json": "{}",
    "src/util.ts": "export const two = 2;",
  }, async (root) => {
    const { graph, discovery } = await indexSourceBackedCodebase({
      projectId: "plain-fixture",
      rootPath: root,
    });
    const summary = summarizeCodebaseGraph(graph, discovery);

    assertEquals(summary.packageManager, "npm");
    assertEquals(summary.frameworks, []);
    assertEquals(summary.counts.files, 1);
    assertEquals(summary.counts.routes, 0);
    assertEquals(summary.counts.handlers, 0);
  });
});

async function withFixture(
  files: Record<string, string>,
  fn: (root: string) => Promise<void>,
): Promise<void> {
  const root = await Deno.makeTempDir({ prefix: "genie-import-" });
  try {
    for (const [path, content] of Object.entries(files)) {
      const fullPath = join(root, path);
      await Deno.mkdir(join(fullPath, ".."), { recursive: true });
      await Deno.writeTextFile(fullPath, content);
    }
    await fn(root);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}
