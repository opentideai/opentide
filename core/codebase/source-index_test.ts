import { assertEquals } from "@std/assert";
import { join } from "node:path";
import {
  createDefaultSemanticsPluginRegistry,
  discoverTsJsProject,
  indexCodebaseWithPlugins,
  indexTsJsSource,
  sourceIndexContribution,
  symbolSemanticId,
} from "./index.ts";

Deno.test("indexTsJsSource inventories TS files and extracts symbols/imports/exports", async () => {
  await withFixture({
    "package.json": JSON.stringify({ scripts: {} }),
    "tsconfig.json": "{}",
    "src/math.ts": `
      export function add(a: number, b: number) { return a + b; }
      function internal() {}
      export type Sum = number;
    `,
    "src/index.ts": `
      import { add } from "./math";
      export { add };
      export const answer = add(20, 22);
    `,
  }, async (root) => {
    const discovery = await discoverTsJsProject(root);
    const index = await indexTsJsSource(root, discovery);
    const contribution = sourceIndexContribution("generic-tsjs", index);

    assertEquals(index.files.map((file) => [file.path, file.language]), [
      ["src/index.ts", "typescript"],
      ["src/math.ts", "typescript"],
    ]);
    assertEquals(
      contribution.symbols?.map((symbol) => [
        symbol.name,
        symbol.symbolKind,
        symbol.file,
        symbol.exported,
      ]),
      [
        ["answer", "variable", "src/index.ts", true],
        ["add", "function", "src/math.ts", true],
        ["internal", "function", "src/math.ts", false],
        ["Sum", "type", "src/math.ts", true],
      ],
    );
    assertEquals(
      contribution.modules?.find((m) => m.file === "src/index.ts")?.importIds,
      [
        "file:src/math.ts",
      ],
    );
    assertEquals(
      contribution.modules?.find((m) => m.file === "src/index.ts")?.exportIds,
      [
        symbolSemanticId("src/index.ts", "answer"),
      ],
    );
    assertEquals(
      contribution.edges?.some((edge) =>
        edge.type === "imports" &&
        edge.sourceId === "module:src/index.ts" &&
        edge.targetId === "file:src/math.ts"
      ),
      true,
    );
  });
});

Deno.test("indexTsJsSource emits symbols for every variable declarator", async () => {
  await withFixture({
    "package.json": JSON.stringify({ scripts: {} }),
    "src/constants.ts": "export const a = 1, b = 2;",
  }, async (root) => {
    const index = await indexTsJsSource(root);
    const contribution = sourceIndexContribution("generic-tsjs", index);
    const module = contribution.modules?.find((m) =>
      m.file === "src/constants.ts"
    );

    assertEquals(
      contribution.symbols?.map((symbol) => [
        symbol.name,
        symbol.symbolKind,
        symbol.exported,
      ]),
      [
        ["a", "variable", true],
        ["b", "variable", true],
      ],
    );
    assertEquals(module?.exportIds, [
      symbolSemanticId("src/constants.ts", "a"),
      symbolSemanticId("src/constants.ts", "b"),
    ]);
    assertEquals(
      contribution.edges?.filter((edge) =>
        edge.sourceId === "module:src/constants.ts" &&
        edge.type === "defines"
      ).map((edge) => edge.targetId).toSorted(),
      [
        symbolSemanticId("src/constants.ts", "a"),
        symbolSemanticId("src/constants.ts", "b"),
      ],
    );
    assertEquals(
      contribution.edges?.filter((edge) =>
        edge.sourceId === "module:src/constants.ts" &&
        edge.type === "exports"
      ).map((edge) => edge.targetId).toSorted(),
      [
        symbolSemanticId("src/constants.ts", "a"),
        symbolSemanticId("src/constants.ts", "b"),
      ],
    );
  });
});

Deno.test("indexTsJsSource handles CommonJS require and exports", async () => {
  await withFixture({
    "package.json": JSON.stringify({ scripts: {} }),
    "server/util.js": "exports.format = function format() { return 'x'; };",
    "server/index.cjs": `
      const util = require("./util");
      module.exports = function handler() { return util.format(); };
    `,
  }, async (root) => {
    const discovery = await discoverTsJsProject(root);
    const index = await indexTsJsSource(root, discovery);
    const contribution = sourceIndexContribution("generic-tsjs", index);

    assertEquals(index.files.map((file) => [file.path, file.language]), [
      ["server/index.cjs", "javascript"],
      ["server/util.js", "javascript"],
    ]);
    assertEquals(
      contribution.modules?.find((m) => m.file === "server/index.cjs")
        ?.importIds,
      [
        "file:server/util.js",
      ],
    );
    assertEquals(
      contribution.symbols?.map((symbol) => [
        symbol.name,
        symbol.file,
        symbol.exported,
      ]),
      [
        ["module.exports", "server/index.cjs", true],
        ["format", "server/util.js", true],
      ],
    );
  });
});

Deno.test("indexTsJsSource inventories TSX and JSX components", async () => {
  await withFixture({
    "package.json": JSON.stringify({ scripts: {} }),
    "src/App.tsx": "export function App() { return <main />; }",
    "src/Card.jsx": "export const Card = () => <section />;",
  }, async (root) => {
    const index = await indexTsJsSource(root);
    const contribution = sourceIndexContribution("generic-tsjs", index);

    assertEquals(index.files.map((file) => [file.path, file.language]), [
      ["src/App.tsx", "tsx"],
      ["src/Card.jsx", "jsx"],
    ]);
    assertEquals(
      contribution.symbols?.map((symbol) => [
        symbol.name,
        symbol.symbolKind,
        symbol.exported,
      ]),
      [
        ["App", "function", true],
        ["Card", "variable", true],
      ],
    );
  });
});

Deno.test("indexTsJsSource handles default exports", async () => {
  await withFixture({
    "package.json": JSON.stringify({ scripts: {} }),
    "src/page.ts": "export default function Page() { return null; }",
    "src/anonymous.ts": "export default class { render() {} }",
    "src/value.ts": "const value = 1; export default value;",
  }, async (root) => {
    const index = await indexTsJsSource(root);
    const contribution = sourceIndexContribution("generic-tsjs", index);

    assertEquals(
      contribution.symbols?.map((symbol) => [
        symbol.name,
        symbol.symbolKind,
        symbol.file,
        symbol.exported,
      ]),
      [
        ["default", "class", "src/anonymous.ts", true],
        ["Page", "function", "src/page.ts", true],
        ["value", "variable", "src/value.ts", true],
      ],
    );
  });
});

Deno.test("indexTsJsSource extracts enums and class decorators", async () => {
  await withFixture({
    "package.json": JSON.stringify({ scripts: {} }),
    "src/model.ts": `
      export enum Color { Red, Green, Blue }

      @Component({ selector: "app" })
      @Injectable()
      export class Widget {}
    `,
  }, async (root) => {
    const index = await indexTsJsSource(root);
    const contribution = sourceIndexContribution("generic-tsjs", index);

    assertEquals(
      contribution.symbols?.map((symbol) => [
        symbol.name,
        symbol.symbolKind,
        symbol.exported,
        symbol.decorators ?? null,
      ]),
      [
        ["Color", "enum", true, null],
        ["Widget", "class", true, ["Component", "Injectable"]],
      ],
    );
  });
});

Deno.test("indexTsJsSource records re-export and dynamic import relationships", async () => {
  await withFixture({
    "package.json": JSON.stringify({ scripts: {} }),
    "src/lazy.ts": "export const lazy = 1;",
    "src/source.ts": "export const source = 1;",
    "src/barrel.ts": "export { source } from './source';",
    "src/main.ts":
      "export async function load() { return await import('./lazy'); }",
  }, async (root) => {
    const index = await indexTsJsSource(root);
    const contribution = sourceIndexContribution("generic-tsjs", index);

    const barrel = contribution.modules?.find((m) =>
      m.file === "src/barrel.ts"
    );
    const main = contribution.modules?.find((m) => m.file === "src/main.ts");

    assertEquals(barrel?.importIds, ["file:src/source.ts"]);
    assertEquals(main?.importIds, ["file:src/lazy.ts"]);
    assertEquals(
      contribution.edges?.some((edge) =>
        edge.type === "exports" &&
        edge.sourceId === "module:src/barrel.ts" &&
        edge.targetId === "file:src/source.ts"
      ),
      true,
    );
    assertEquals(
      contribution.edges?.some((edge) =>
        edge.type === "imports" &&
        edge.sourceId === "module:src/main.ts" &&
        edge.targetId === "file:src/lazy.ts"
      ),
      true,
    );
  });
});

Deno.test("indexTsJsSource respects ignored directories and file caps", async () => {
  await withFixture({
    "package.json": JSON.stringify({ scripts: {} }),
    "src/a.ts": "export const a = 1;",
    "src/b.ts": "export const b = 1;",
    "dist/generated.ts": "export const generated = 1;",
    "node_modules/pkg/index.js": "module.exports = {};",
  }, async (root) => {
    const discovery = await discoverTsJsProject(root);
    const index = await indexTsJsSource(root, discovery, { maxFiles: 1 });

    assertEquals(index.files.map((file) => file.path), ["src/a.ts"]);
  });
});

Deno.test("generic TS/JS plugin emits source index graph entities", async () => {
  await withFixture({
    "package.json": JSON.stringify({ scripts: { test: "vitest" } }),
    "src/lib.ts": "export function lib() { return 1; }",
    "src/main.ts": "import { lib } from './lib'; export const value = lib();",
  }, async (root) => {
    const discovery = await discoverTsJsProject(root);
    const sourceIndex = await indexTsJsSource(root, discovery);
    const registry = createDefaultSemanticsPluginRegistry();
    const graph = await indexCodebaseWithPlugins(registry, {
      projectId: "p1",
      rootPath: root,
      discovery,
      sourceIndex,
    });

    assertEquals(graph.files.map((file) => file.path), [
      "src/lib.ts",
      "src/main.ts",
    ]);
    assertEquals(graph.modules.map((module) => module.file), [
      "src/lib.ts",
      "src/main.ts",
    ]);
    assertEquals(graph.symbols.map((symbol) => [symbol.name, symbol.file]), [
      ["lib", "src/lib.ts"],
      ["value", "src/main.ts"],
    ]);
    assertEquals(graph.edges.some((edge) => edge.type === "imports"), true);
    assertEquals(graph.commands.map((command) => command.commandKind), [
      "install",
      "test",
    ]);
  });
});

Deno.test("sourceIndexContribution emits test nodes with tested-by edges", async () => {
  await withFixture({
    "package.json": JSON.stringify({ scripts: { test: "vitest" } }),
    "src/math.ts":
      "export function add(a: number, b: number) { return a + b; }",
    "src/math_test.ts": `
      import { add } from "./math";
      test("add", () => { add(1, 2); });
    `,
    "src/lonely.ts": "export const lonely = 1;",
  }, async (root) => {
    const discovery = await discoverTsJsProject(root);
    const index = await indexTsJsSource(root, discovery);
    const contribution = sourceIndexContribution("generic-tsjs", index);

    // math_test.ts becomes a test node targeting the source file it imports.
    assertEquals(
      contribution.tests?.map((t) => [t.file, t.targetIds]),
      [["src/math_test.ts", ["file:src/math.ts"]]],
    );
    // …and a tested-by edge from the source file to the test.
    assertEquals(
      contribution.edges?.some((edge) =>
        edge.type === "tested-by" &&
        edge.sourceId === "file:src/math.ts" &&
        edge.targetId === "test:src/math_test.ts"
      ),
      true,
    );
  });
});

async function withFixture(
  files: Record<string, string>,
  fn: (root: string) => Promise<void>,
): Promise<void> {
  const root = await Deno.makeTempDir({ prefix: "genie-source-index-" });
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
