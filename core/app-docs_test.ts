import { assertEquals } from "@std/assert";
import {
  docsToMarkdownFiles,
  docsToStaticSiteFiles,
  generateAppDocs,
} from "./app-docs.ts";
import { Database } from "./db.ts";
import { Kernel } from "./registries.ts";

Deno.test("generateAppDocs includes project entity sections", async () => {
  const db = await Database.create({ driver: "pglite" });
  const kernel = new Kernel(db);

  try {
    kernel.handlers.register(
      "listThings",
      "async function listThings(c) { return c.json([]); }",
      () => new Response("[]"),
      undefined,
      "things",
    );
    kernel.routes.register("GET", "/things", "listThings", {
      summary: "List things",
    }, "things");
    kernel.functions.register(
      "formatThing",
      "function formatThing(thing) { return thing.name; }",
      () => "Thing",
      "things",
      "string",
    );
    kernel.tests.register(
      "formatThing works",
      "Deno.test('formatThing works', () => {});",
      async () => {},
      "things",
    );
    kernel.templates.register("thing-card", "<article></article>", "things");
    kernel.templates.register(
      "thing card (wide)",
      "<section></section>",
      "things",
    );
    kernel.assets.register(
      "thing.css",
      new TextEncoder().encode(".thing {}"),
      "text/css",
      "things",
    );
    kernel.assets.register(
      "thing art (draft).css",
      new TextEncoder().encode(".thing-art {}"),
      "text/css",
      "things",
    );
    kernel.configs.set("THING_LIMIT", 10, "Maximum things", "things");
    kernel.types.register(
      "Thing",
      [{ name: "name", type: "string", description: "Display name" }],
      "Thing view model",
      "things",
    );
    kernel.devViews.register(
      "ThingView",
      "Thing",
      "Thing",
      "function ThingView() { return { type: 'markdown', content: 'Thing' }; }",
      () => ({ type: "markdown", content: "Thing" }),
      false,
      "things",
    );
    kernel.devTools.register(
      "inspectThing",
      "Inspect a thing",
      [{ name: "id", type: "string", description: "Thing id", required: true }],
      "function inspectThing() { return {}; }",
      () => ({}),
      "things",
    );
    (kernel.runtime as unknown as {
      listPackages: () => Array<
        {
          name: string;
          specifier: string;
          installedAt: string;
          module?: string;
        }
      >;
    }).listPackages = () => [{
      name: "is-odd",
      specifier: "npm:is-odd@3",
      installedAt: "2026-01-01T00:00:00.000Z",
      module: "things",
    }];
    kernel.configs.set("_genie_pinned_packages", ["is-odd"]);
    kernel.envVars.define("THING_API_URL", undefined, "Thing API URL");
    kernel.secrets.define("THING_TOKEN", "Thing API token");
    kernel.customAudits.register(
      "thing-audit",
      "Checks thing quality",
      "Review thing quality",
      "things",
    );
    const schema = await kernel.db.defineSchema(
      "things",
      "CREATE TABLE things (id TEXT PRIMARY KEY, name TEXT NOT NULL)",
      "things",
    );
    if (!schema.ok) throw new Error(schema.error.message);

    const docs = await generateAppDocs(kernel);
    const ids = docs.sections.map((section) => section.id);

    assertEquals(ids.includes("api"), true);
    assertEquals(ids.includes("data-model"), true);
    assertEquals(ids.includes("handlers"), true);
    assertEquals(ids.includes("functions"), true);
    assertEquals(ids.includes("tests"), true);
    assertEquals(ids.includes("types"), true);
    assertEquals(ids.includes("templates"), true);
    assertEquals(ids.includes("assets"), true);
    assertEquals(ids.includes("packages"), true);
    assertEquals(ids.includes("config"), true);
    assertEquals(ids.includes("env-vars"), true);
    assertEquals(ids.includes("secrets"), true);
    assertEquals(ids.includes("dev-views"), true);
    assertEquals(ids.includes("dev-tools"), true);
    assertEquals(ids.includes("custom-audits"), true);

    assertEquals(Array.isArray(docs.nav), true);
    const modulesNav = docs.nav?.find((node) => node.id === "modules");
    assertEquals(modulesNav?.title, "Modules");
    const thingsNav = modulesNav?.children?.find((node) =>
      node.id === "module:things"
    );
    assertEquals(thingsNav?.title, "things");

    const modulePageIds = collectNavPageIds(thingsNav);
    assertEquals(modulePageIds.includes("route:GET:/things"), true);
    assertEquals(modulePageIds.includes("handler:listThings"), true);
    assertEquals(modulePageIds.includes("function:formatThing"), true);
    assertEquals(modulePageIds.includes("test:formatThing works"), true);
    assertEquals(modulePageIds.includes("type:Thing"), true);
    assertEquals(modulePageIds.includes("template:thing-card"), true);
    assertEquals(modulePageIds.includes("template:thing card (wide)"), true);
    assertEquals(modulePageIds.includes("asset:thing.css"), true);
    assertEquals(modulePageIds.includes("asset:thing art (draft).css"), true);
    assertEquals(modulePageIds.includes("package:is-odd"), true);

    const templatePages = docs.sections.find((section) =>
      section.id === "templates"
    )?.pages ?? [];
    assertEquals(templatePages.some((page) => page.id === "templates"), true);
    assertEquals(
      templatePages.some((page) => page.id === "template:thing-card"),
      true,
    );
    assertEquals(
      templatePages.some((page) => page.id === "template:thing card (wide)"),
      true,
    );
    const templateDetail = templatePages.find((page) =>
      page.id === "template:thing-card"
    );
    assertEquals(templateDetail?.meta, {
      entityKind: "template",
      entityKey: "thing-card",
      module: "things",
    });
    assertEquals(templateDetail?.content.includes("```html"), true);
    assertEquals(templateDetail?.content.includes("<article></article>"), true);

    const assetPages = docs.sections.find((section) =>
      section.id === "assets"
    )?.pages ?? [];
    assertEquals(assetPages.some((page) => page.id === "assets"), true);
    assertEquals(
      assetPages.some((page) => page.id === "asset:thing.css"),
      true,
    );
    assertEquals(
      assetPages.some((page) => page.id === "asset:thing art (draft).css"),
      true,
    );
    const assetDetail = assetPages.find((page) =>
      page.id === "asset:thing.css"
    );
    assertEquals(
      assetDetail?.content.includes("**MIME Type:** `text/css`"),
      true,
    );
    assertEquals(
      assetDetail?.content.includes("**Served URL:** `/_assets/thing.css`"),
      true,
    );
    assertEquals(assetDetail?.content.includes("```css"), true);
    assertEquals(assetDetail?.content.includes(".thing {}"), true);
    const weirdAssetDetail = assetPages.find((page) =>
      page.id === "asset:thing art (draft).css"
    );
    assertEquals(
      weirdAssetDetail?.content.includes(
        "**Served URL:** `/_assets/thing%20art%20%28draft%29.css`",
      ),
      true,
    );

    const packagePages =
      docs.sections.find((section) => section.id === "packages")?.pages ?? [];
    assertEquals(packagePages.map((page) => page.id), [
      "packages",
      "package:is-odd",
    ]);
    const packageDetail = packagePages.find((page) =>
      page.id === "package:is-odd"
    );
    assertEquals(
      packageDetail?.content.includes("**Current Range:** `3`"),
      true,
    );
    assertEquals(
      packageDetail?.content.includes("**Pin Status:** pinned"),
      true,
    );
    assertEquals(
      packageDetail?.content.includes(
        "https://www.npmjs.com/package/is-odd",
      ),
      true,
    );

    const exportedFiles = docsToMarkdownFiles(docs);
    const exportedPaths = exportedFiles.map((file) => file.path);
    assertEquals(
      exportedPaths.includes("docs/templates/template-thing-card.md"),
      true,
    );
    assertEquals(
      exportedPaths.includes("docs/templates/template-thing-card-wide.md"),
      true,
    );
    assertEquals(
      exportedPaths.includes("docs/assets/asset-thing-css.md"),
      true,
    );
    assertEquals(
      exportedPaths.includes("docs/assets/asset-thing-art-draft-css.md"),
      true,
    );
    assertEquals(
      exportedPaths.includes("docs/packages/package-is-odd.md"),
      true,
    );
    const templateIndex = exportedFiles.find((file) =>
      file.path === "docs/templates/index.md"
    );
    assertEquals(
      templateIndex?.content.includes("template-thing-card-wide.md"),
      true,
    );
    const assetIndex = exportedFiles.find((file) =>
      file.path === "docs/assets/index.md"
    );
    assertEquals(
      assetIndex?.content.includes("asset-thing-art-draft-css.md"),
      true,
    );

    const secrets = docs.sections.find((section) => section.id === "secrets");
    assertEquals(
      secrets?.pages[0]?.content.includes(
        "Secret values are intentionally omitted.",
      ),
      true,
    );
    assertEquals(secrets?.pages[0]?.content.includes("THING_TOKEN"), true);
  } finally {
    await db.close();
  }
});

Deno.test("generateAppDocs enriches package docs when registry info is supplied", async () => {
  const db = await Database.create({ driver: "pglite" });
  const kernel = new Kernel(db);

  try {
    (kernel.runtime as unknown as {
      listPackages: () => Array<{
        name: string;
        specifier: string;
        installedAt: string;
      }>;
    }).listPackages = () => [{
      name: "@scope/widget",
      specifier: "npm:@scope/widget@1",
      installedAt: "2026-01-01T00:00:00.000Z",
    }];

    const offlineDocs = await generateAppDocs(kernel);
    const offlinePackageDetail = offlineDocs.sections.find((section) =>
      section.id === "packages"
    )?.pages.find((page) => page.id === "package:@scope/widget");
    assertEquals(
      offlinePackageDetail?.content.includes("**Latest Version:**"),
      false,
    );
    assertEquals(
      offlinePackageDetail?.content.includes("**Homepage:**"),
      false,
    );

    const docs = await generateAppDocs(kernel, {
      packageRegistryInfo: {
        "@scope/widget": {
          homepage: "https://example.test/widget",
          license: "MIT",
          latest: "2.0.0",
        },
      },
    });

    const packagePages = docs.sections.find((section) =>
      section.id === "packages"
    )?.pages ?? [];
    const packageIndex = packagePages.find((page) => page.id === "packages");
    const packageDetail = packagePages.find((page) =>
      page.id === "package:@scope/widget"
    );

    assertEquals(
      packageIndex?.content.includes("| Package | Specifier | Current Range |"),
      true,
    );
    assertEquals(
      packageIndex?.content.includes("| `2.0.0` | yes | MIT |"),
      true,
    );
    assertEquals(
      packageIndex?.content.includes("[homepage](https://example.test/widget)"),
      true,
    );
    assertEquals(
      packageDetail?.content.includes("**Current Range:** `1`"),
      true,
    );
    assertEquals(
      packageDetail?.content.includes("**Latest Version:** `2.0.0`"),
      true,
    );
    assertEquals(packageDetail?.content.includes("**Outdated:** yes"), true);
    assertEquals(packageDetail?.content.includes("**License:** MIT"), true);
    assertEquals(
      packageDetail?.content.includes(
        "**Homepage:** [https://example.test/widget](https://example.test/widget)",
      ),
      true,
    );
  } finally {
    await db.close();
  }
});

Deno.test("generateAppDocs omits unsafe package homepage links", async () => {
  const db = await Database.create({ driver: "pglite" });
  const kernel = new Kernel(db);

  try {
    (kernel.runtime as unknown as {
      listPackages: () => Array<{
        name: string;
        specifier: string;
        installedAt: string;
      }>;
    }).listPackages = () => [{
      name: "unsafe-homepage",
      specifier: "npm:unsafe-homepage@1",
      installedAt: "2026-01-01T00:00:00.000Z",
    }];

    const docs = await generateAppDocs(kernel, {
      packageRegistryInfo: {
        "unsafe-homepage": {
          homepage: "javascript:alert(1)",
          license: "MIT",
          latest: "1.2.0",
        },
      },
    });
    const packagePages = docs.sections.find((section) =>
      section.id === "packages"
    )?.pages ?? [];
    const packageIndex = packagePages.find((page) => page.id === "packages");
    const packageDetail = packagePages.find((page) =>
      page.id === "package:unsafe-homepage"
    );
    const staticSite = docsToStaticSiteFiles(docs, "Unsafe Homepage Test")[0]!
      .content;

    assertEquals(packageIndex?.content.includes("javascript:alert(1)"), false);
    assertEquals(packageDetail?.content.includes("javascript:alert(1)"), false);
    assertEquals(packageDetail?.content.includes("**Homepage:**"), false);
    assertEquals(
      packageDetail?.content.includes(
        "https://www.npmjs.com/package/unsafe-homepage",
      ),
      true,
    );
    assertEquals(staticSite.includes("javascript:alert(1)"), false);
  } finally {
    await db.close();
  }
});

function collectNavPageIds(
  node: { pageId?: string; children?: unknown[] } | undefined,
): string[] {
  if (!node) return [];
  const children = (node.children ?? []) as Array<
    { pageId?: string; children?: unknown[] }
  >;
  return [
    ...(node.pageId ? [node.pageId] : []),
    ...children.flatMap((child) => collectNavPageIds(child)),
  ];
}
