import { assertEquals } from "@std/assert";
import { join } from "node:path";
import {
  createDefaultSemanticsPluginRegistry,
  discoverTsJsProject,
  GENERIC_TSJS_PLUGIN_ID,
  indexCodebaseWithPlugins,
} from "./index.ts";

Deno.test("discoverTsJsProject detects npm package metadata and scripts", async () => {
  await withFixture({
    "package.json": JSON.stringify({
      name: "npm-app",
      version: "1.2.3",
      type: "module",
      scripts: {
        dev: "vite",
        test: "vitest",
        typecheck: "tsc --noEmit",
        lint: "eslint .",
        build: "vite build",
        ignored: "echo nope",
      },
      dependencies: { express: "^5.0.0" },
      devDependencies: { typescript: "^5.0.0" },
    }),
    "package-lock.json": "{}",
    "tsconfig.json": "{}",
    "src/index.ts": "export {};",
  }, async (root) => {
    const discovery = await discoverTsJsProject(root);

    assertEquals(discovery.packageManager, "npm");
    assertEquals(discovery.lockfiles, ["package-lock.json"]);
    assertEquals(discovery.packageJson?.name, "npm-app");
    assertEquals(Object.keys(discovery.packageJson?.scripts ?? {}).toSorted(), [
      "build",
      "dev",
      "ignored",
      "lint",
      "test",
      "typecheck",
    ]);
    assertEquals(discovery.configFiles.map((f) => [f.path, f.kind]), [
      ["package.json", "package-json"],
      ["tsconfig.json", "tsconfig"],
    ]);
    assertEquals(discovery.sourceRoots, ["src"]);
  });
});

Deno.test("discoverTsJsProject detects common TS/JS config variants", async () => {
  await withFixture({
    "package.json": JSON.stringify({ scripts: {} }),
    "tsconfig.app.json": "{}",
    ".eslintrc.cjs": "module.exports = {}",
    ".eslintrc.yaml": "root: true",
    "prettier.config.mjs": "export default {}",
    ".prettierrc": "{}",
    "tailwind.config.ts": "export default {}",
    "postcss.config.cjs": "module.exports = {}",
    "deno.json": "{}",
  }, async (root) => {
    const discovery = await discoverTsJsProject(root);

    assertEquals(discovery.configFiles.map((f) => [f.path, f.kind]), [
      [".eslintrc.cjs", "eslint"],
      [".eslintrc.yaml", "eslint"],
      [".prettierrc", "prettier"],
      ["deno.json", "deno"],
      ["package.json", "package-json"],
      ["postcss.config.cjs", "postcss"],
      ["prettier.config.mjs", "prettier"],
      ["tailwind.config.ts", "tailwind"],
      ["tsconfig.app.json", "tsconfig"],
    ]);
  });
});

Deno.test("discoverTsJsProject infers deno from config without lockfile", async () => {
  await withFixture({
    "deno.json": JSON.stringify({
      tasks: {
        dev: "deno run --watch main.ts",
        test: "deno test",
      },
    }),
    "main.ts": "export {};",
  }, async (root) => {
    const discovery = await discoverTsJsProject(root);
    const registry = createDefaultSemanticsPluginRegistry();
    const graph = await indexCodebaseWithPlugins(registry, {
      projectId: "deno-fixture",
      rootPath: root,
      discovery,
    });

    assertEquals(discovery.packageManager, "deno");
    assertEquals(discovery.lockfiles, []);
    assertEquals(discovery.configFiles.map((f) => [f.path, f.kind]), [
      ["deno.json", "deno"],
    ]);
    assertEquals(
      graph.commands.map((command) => [
        command.commandKind,
        command.command,
        command.packageManager,
      ]),
      [
        ["install", "deno cache", "deno"],
      ],
    );
  });
});

Deno.test("discoverTsJsProject prefers pnpm lockfile", async () => {
  await withFixture({
    "package.json": JSON.stringify({
      scripts: { dev: "next dev" },
      dependencies: {
        next: "^15.0.0",
        "@sveltejs/kit": "^2.0.0",
      },
      devDependencies: {
        vite: "^7.0.0",
      },
    }),
    "package-lock.json": "{}",
    "pnpm-lock.yaml": "lockfileVersion: '9.0'",
    "next.config.mjs": "export default {}",
    "app/page.tsx": "export default function Page() { return null; }",
  }, async (root) => {
    const discovery = await discoverTsJsProject(root);

    assertEquals(discovery.packageManager, "pnpm");
    assertEquals(discovery.lockfiles, ["pnpm-lock.yaml", "package-lock.json"]);
    assertEquals(discovery.sourceRoots, ["app"]);
    assertEquals(
      discovery.frameworkHints.map((h) => [
        h.id,
        h.source,
        h.evidence,
      ]),
      [
        ["next", "dependency", "next"],
        ["sveltekit", "dependency", "@sveltejs/kit"],
        ["next", "config", "next.config.mjs"],
        ["vite", "dependency", "vite"],
      ],
    );
  });
});

Deno.test("discoverTsJsProject handles JS-only projects without tsconfig", async () => {
  await withFixture({
    "package.json": JSON.stringify({
      scripts: { start: "node server.js" },
      dependencies: { fastify: "^5.0.0" },
    }),
    "server/index.js": "module.exports = {};",
  }, async (root) => {
    const discovery = await discoverTsJsProject(root);

    assertEquals(discovery.packageManager, "npm");
    assertEquals(discovery.configFiles.map((f) => f.kind), ["package-json"]);
    assertEquals(discovery.sourceRoots, ["server"]);
  });
});

Deno.test("discoverTsJsProject reports ignored directories without source-rooting them", async () => {
  await withFixture({
    "package.json": JSON.stringify({ scripts: { build: "vite build" } }),
    "node_modules/pkg/index.js": "",
    "dist/index.js": "",
    "coverage/index.html": "",
    "src/index.ts": "",
  }, async (root) => {
    const discovery = await discoverTsJsProject(root);

    assertEquals(discovery.ignoredDirs, ["coverage", "dist", "node_modules"]);
    assertEquals(discovery.sourceRoots, ["src"]);
  });
});

Deno.test("generic TS/JS plugin emits commands and facts from discovery", async () => {
  await withFixture({
    "package.json": JSON.stringify({
      scripts: {
        dev: "vite",
        test: "vitest",
        build: "vite build",
        format: "prettier . --write",
        custom: "echo custom",
      },
      dependencies: { express: "^5.0.0" },
      devDependencies: { vitest: "^3.0.0" },
    }),
    "pnpm-lock.yaml": "lockfileVersion: '9.0'",
    "jsconfig.json": "{}",
    "src/server.js": "",
  }, async (root) => {
    const discovery = await discoverTsJsProject(root);
    const registry = createDefaultSemanticsPluginRegistry();
    const graph = await indexCodebaseWithPlugins(registry, {
      projectId: "fixture",
      rootPath: root,
      discovery,
    });

    assertEquals(graph.plugins.map((p) => [p.pluginId, p.status]), [
      [GENERIC_TSJS_PLUGIN_ID, "completed"],
      // Non-Hono project ⇒ the Hono plugin detects nothing and is skipped.
      ["hono", "skipped"],
    ]);
    assertEquals(
      graph.commands.map((command) => [
        command.commandKind,
        command.name,
        command.command,
        command.packageManager,
      ]),
      [
        ["build", "build", "pnpm run build", "pnpm"],
        ["dev", "dev", "pnpm run dev", "pnpm"],
        ["format", "format", "pnpm run format", "pnpm"],
        ["install", "install", "pnpm install", "pnpm"],
        ["test", "test", "pnpm run test", "pnpm"],
      ],
    );
    assertEquals(graph.facts.map((fact) => [fact.factKind, fact.name]), [
      ["config", "jsconfig: jsconfig.json"],
      ["config", "package-json: package.json"],
      ["dependency", "vitest"],
      ["dependency", "express"],
      ["framework", "Framework hint: express"],
      ["config", "Package manager: pnpm"],
      ["entrypoint", "Source root: src"],
    ]);
  });
});

async function withFixture(
  files: Record<string, string>,
  fn: (root: string) => Promise<void>,
): Promise<void> {
  const root = await Deno.makeTempDir({ prefix: "genie-codebase-" });
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
