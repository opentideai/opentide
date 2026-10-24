import { isEditableTextAssetMime } from "./assets.ts";
import { isPackageOutdated, parseSpecifierRange } from "./package-versions.ts";
import type { Kernel } from "./registries.ts";
import type { RouteEntry, RouteSchema } from "./types.ts";
import { sortRoutes } from "./types.ts";

export interface DocsPage {
  id: string;
  title: string;
  content: string;
  meta?: {
    entityKind?: string;
    entityKey?: string;
    module?: string;
  };
}

export interface DocsSection {
  id: string;
  title: string;
  pages: DocsPage[];
}

export interface DocsNavNode {
  id: string;
  title: string;
  pageId?: string;
  count?: number;
  children?: DocsNavNode[];
}

export interface AppDocs {
  sections: DocsSection[];
  nav?: DocsNavNode[];
}

export interface DocsExportFile {
  path: string;
  content: string;
}

export interface DocsPackageRegistryInfo {
  homepage?: string;
  license?: string;
  latest?: string;
}

export interface GenerateAppDocsOptions {
  packageRegistryInfo?: Record<
    string,
    DocsPackageRegistryInfo | null | undefined
  >;
}

type DocsTemplate = {
  name: string;
  content: string;
  registeredAt: string;
  module?: string;
};

type DocsAsset = {
  name: string;
  mimeType: string;
  size: number;
  registeredAt: string;
  module?: string;
};

type DocsPackage = {
  name: string;
  specifier: string;
  installedAt: string;
  module?: string;
  pinned?: boolean;
  registryInfo?: DocsPackageRegistryInfo;
};

export async function generateAppDocs(
  kernel: Kernel,
  options: GenerateAppDocsOptions = {},
): Promise<AppDocs> {
  const routes = sortRoutes(kernel.routes.list());
  const handlers = kernel.handlers.list();
  const functions = kernel.functions.list();
  const templates = kernel.templates.list();
  const schemas = await kernel.db.listSchemas();
  const tests = kernel.tests.serialize();
  const configs = kernel.configs.list().filter((c) =>
    !c.name.startsWith("_genie_")
  );
  const assets = kernel.assets.list();
  const devViews = kernel.devViews.list().filter((v) => !v.builtIn);
  const devTools = kernel.devTools.list();
  const types = kernel.types.serialize();
  const pinnedPackages = (kernel.configs.get("_genie_pinned_packages") as
    | string[]
    | undefined) ?? [];
  const pinnedPackageSet = new Set(pinnedPackages);
  const packages: DocsPackage[] = (kernel.runtime.listPackages?.(kernel) ?? [])
    .map((pkg) => {
      const enriched = pkg as typeof pkg & { pinned?: unknown };
      return {
        ...pkg,
        pinned: typeof enriched.pinned === "boolean"
          ? enriched.pinned
          : pinnedPackageSet.has(pkg.name),
        registryInfo: options.packageRegistryInfo?.[pkg.name] ?? undefined,
      };
    });
  const envVars = kernel.envVars.listEnriched();
  const secrets = kernel.secrets.list().map((s) => ({
    key: s.key,
    description: s.description,
    status: kernel.secrets.status(s.key),
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  }));
  const customAudits = kernel.customAudits.list();
  const modules = kernel.listModules();

  const handlerRouteMap = new Map<string, RouteEntry[]>();
  for (const r of routes) {
    const arr = handlerRouteMap.get(r.handlerName);
    if (arr) arr.push(r);
    else handlerRouteMap.set(r.handlerName, [r]);
  }

  const sections: DocsSection[] = [];

  // --- Overview (top-level section with one page) ---
  sections.push({
    id: "overview",
    title: "Overview",
    pages: [{
      id: "overview",
      title: "Overview",
      content: buildOverview(
        routes,
        schemas,
        handlers,
        functions,
        tests,
        templates,
        assets,
        configs,
        devViews,
        devTools,
        types,
        packages,
        envVars,
        secrets,
        customAudits,
        modules,
      ),
    }],
  });

  // --- API Reference ---
  if (routes.length) {
    const grouped = groupBy(routes, (r) => r.module || ungroupedModule(r.path));
    const pages: DocsPage[] = [];

    pages.push({
      id: "api",
      title: "All Routes",
      content: buildApiIndex(grouped),
    });

    for (const route of routes) {
      pages.push({
        id: `route:${route.method}:${route.path}`,
        title: `${route.method} ${route.path}`,
        content: buildRoutePage(route, handlers),
        meta: {
          entityKind: "route",
          entityKey: `${route.method}:${route.path}`,
          ...(route.module ? { module: route.module } : {}),
        },
      });
    }

    sections.push({ id: "api", title: "API Reference", pages });
  }

  // --- Data Model ---
  if (schemas.length) {
    const pages: DocsPage[] = [];

    pages.push({
      id: "data-model",
      title: "All Tables",
      content: buildSchemaIndex(schemas),
    });

    for (const schema of schemas) {
      pages.push({
        id: `schema:${schema.tableName}`,
        title: schema.tableName,
        content: buildSchemaPage(schema),
        meta: {
          entityKind: "schema",
          entityKey: schema.tableName,
          ...(schema.module ? { module: schema.module } : {}),
        },
      });
    }

    sections.push({ id: "data-model", title: "Data Model", pages });
  }

  // --- Handlers ---
  if (handlers.length) {
    const pages: DocsPage[] = [];

    pages.push({
      id: "handlers",
      title: "All Handlers",
      content: buildHandlerIndex(handlers, handlerRouteMap),
    });

    for (const h of handlers) {
      pages.push({
        id: `handler:${h.name}`,
        title: h.name,
        content: buildHandlerPage(h, handlerRouteMap),
        meta: {
          entityKind: "handler",
          entityKey: h.name,
          ...(h.module ? { module: h.module } : {}),
        },
      });
    }

    sections.push({ id: "handlers", title: "Handlers", pages });
  }

  // --- Functions ---
  if (functions.length) {
    const pages: DocsPage[] = [];

    pages.push({
      id: "functions",
      title: "All Functions",
      content: buildFunctionIndex(functions),
    });

    for (const fn of functions) {
      pages.push({
        id: `function:${fn.name}`,
        title: fn.name,
        content: buildFunctionPage(fn),
        meta: {
          entityKind: "function",
          entityKey: fn.name,
          ...(fn.module ? { module: fn.module } : {}),
        },
      });
    }

    sections.push({ id: "functions", title: "Functions", pages });
  }

  // --- Tests ---
  if (tests.length) {
    const pages: DocsPage[] = [];

    pages.push({
      id: "tests",
      title: "All Tests",
      content: buildTestIndex(tests),
    });

    for (const test of tests) {
      pages.push({
        id: `test:${test.name}`,
        title: test.name,
        content: buildTestPage(test),
        meta: {
          entityKind: "test",
          entityKey: test.name,
          ...(test.module ? { module: test.module } : {}),
        },
      });
    }

    sections.push({ id: "tests", title: "Tests", pages });
  }

  // --- Types ---
  if (types.length) {
    const pages: DocsPage[] = [];

    pages.push({
      id: "types",
      title: "All Types",
      content: buildTypeIndex(types),
    });

    for (const type of types) {
      pages.push({
        id: `type:${type.name}`,
        title: type.name,
        content: buildTypePage(type),
        meta: {
          entityKind: "type",
          entityKey: type.name,
          ...(type.module ? { module: type.module } : {}),
        },
      });
    }

    sections.push({ id: "types", title: "Types", pages });
  }

  // --- Templates ---
  if (templates.length) {
    const pages: DocsPage[] = [];

    pages.push({
      id: "templates",
      title: "All Templates",
      content: buildTemplateIndex(templates),
    });

    for (const template of templates) {
      pages.push({
        id: `template:${template.name}`,
        title: template.name,
        content: buildTemplatePage(template),
        meta: {
          entityKind: "template",
          entityKey: template.name,
          ...(template.module ? { module: template.module } : {}),
        },
      });
    }

    sections.push({ id: "templates", title: "Templates", pages });
  }

  // --- Assets ---
  if (assets.length) {
    const pages: DocsPage[] = [];

    pages.push({
      id: "assets",
      title: "All Assets",
      content: buildAssetIndex(assets),
    });

    for (const asset of assets) {
      pages.push({
        id: `asset:${asset.name}`,
        title: asset.name,
        content: buildAssetPage(asset, kernel.assets.get(asset.name)),
        meta: {
          entityKind: "asset",
          entityKey: asset.name,
          ...(asset.module ? { module: asset.module } : {}),
        },
      });
    }

    sections.push({ id: "assets", title: "Assets", pages });
  }

  // --- Packages ---
  if (packages.length) {
    const pages: DocsPage[] = [];

    pages.push({
      id: "packages",
      title: "All Packages",
      content: buildPackageIndex(packages),
    });

    for (const pkg of packages) {
      pages.push({
        id: `package:${pkg.name}`,
        title: pkg.name,
        content: buildPackagePage(pkg),
        meta: {
          entityKind: "package",
          entityKey: pkg.name,
          ...(pkg.module ? { module: pkg.module } : {}),
        },
      });
    }

    sections.push({ id: "packages", title: "Packages", pages });
  }

  // --- Config ---
  if (configs.length) {
    sections.push({
      id: "config",
      title: "Config",
      pages: [{
        id: "config",
        title: "Config",
        content: buildConfigList(configs),
      }],
    });
  }

  // --- Env Vars ---
  if (envVars.length) {
    sections.push({
      id: "env-vars",
      title: "Environment Variables",
      pages: [{
        id: "env-vars",
        title: "Environment Variables",
        content: buildEnvVarList(envVars),
      }],
    });
  }

  // --- Secrets ---
  if (secrets.length) {
    sections.push({
      id: "secrets",
      title: "Secrets",
      pages: [{
        id: "secrets",
        title: "Secrets",
        content: buildSecretList(secrets),
      }],
    });
  }

  // --- Dev Views ---
  if (devViews.length) {
    const pages: DocsPage[] = [];

    pages.push({
      id: "dev-views",
      title: "All Dev Views",
      content: buildDevViewIndex(devViews),
    });

    for (const view of devViews) {
      pages.push({
        id: `dev-view:${view.name}`,
        title: view.name,
        content: buildDevViewPage(view),
        meta: {
          entityKind: "dev-view",
          entityKey: view.name,
          ...(view.module ? { module: view.module } : {}),
        },
      });
    }

    sections.push({ id: "dev-views", title: "Dev Views", pages });
  }

  // --- Dev Tools ---
  if (devTools.length) {
    const pages: DocsPage[] = [];

    pages.push({
      id: "dev-tools",
      title: "All Dev Tools",
      content: buildDevToolIndex(devTools),
    });

    for (const tool of devTools) {
      pages.push({
        id: `dev-tool:${tool.name}`,
        title: tool.name,
        content: buildDevToolPage(tool),
        meta: {
          entityKind: "dev-tool",
          entityKey: tool.name,
          ...(tool.module ? { module: tool.module } : {}),
        },
      });
    }

    sections.push({ id: "dev-tools", title: "Dev Tools", pages });
  }

  // --- Custom Audits ---
  if (customAudits.length) {
    sections.push({
      id: "custom-audits",
      title: "Custom Audits",
      pages: [{
        id: "custom-audits",
        title: "Custom Audits",
        content: buildCustomAuditList(customAudits),
      }],
    });
  }

  return {
    sections,
    nav: buildDocsNav({
      sections,
      modules,
      routes,
      schemas,
      handlers,
      functions,
      tests,
      templates,
      assets,
      packages,
      devViews,
      devTools,
      types,
    }),
  };
}

function buildDocsNav(input: {
  sections: DocsSection[];
  modules: string[];
  routes: RouteEntry[];
  schemas: Array<{ tableName: string; module?: string }>;
  handlers: Array<{ name: string; module?: string }>;
  functions: Array<{ name: string; module?: string }>;
  tests: Array<{ name: string; module?: string }>;
  templates: Array<{ name: string; module?: string }>;
  assets: Array<{ name: string; module?: string }>;
  packages: Array<{ name: string; module?: string }>;
  devViews: Array<{ name: string; module?: string }>;
  devTools: Array<{ name: string; module?: string }>;
  types: Array<{ name: string; module?: string }>;
}): DocsNavNode[] {
  const nav = input.sections.map((section): DocsNavNode => ({
    id: `section:${section.id}`,
    title: section.title,
    pageId: section.pages[0]?.id,
    count: section.pages.length,
    children: section.pages.map((page) => ({
      id: `page:${page.id}`,
      title: page.title,
      pageId: page.id,
    })),
  }));

  const pageIds = new Set(
    input.sections.flatMap((section) => section.pages.map((page) => page.id)),
  );
  const moduleChildren = input.modules
    .map((module) => buildModuleNavNode(module, input, pageIds))
    .filter((node): node is DocsNavNode => node !== null);

  if (moduleChildren.length) {
    const overviewIndex = nav.findIndex((node) => node.pageId === "overview");
    nav.splice(overviewIndex >= 0 ? overviewIndex + 1 : 1, 0, {
      id: "modules",
      title: "Modules",
      count: moduleChildren.length,
      children: moduleChildren,
    });
  }

  return nav;
}

function buildModuleNavNode(
  module: string,
  input: Parameters<typeof buildDocsNav>[0],
  pageIds: Set<string>,
): DocsNavNode | null {
  const categories = [
    moduleCategory(
      module,
      "routes",
      "Routes",
      input.routes.filter((route) => route.module === module),
      (route) => `${route.method} ${route.path}`,
      (route) => `route:${route.method}:${route.path}`,
    ),
    moduleCategory(
      module,
      "schemas",
      "Schemas",
      input.schemas.filter((schema) => schema.module === module),
      (schema) => schema.tableName,
      (schema) => `schema:${schema.tableName}`,
    ),
    moduleCategory(
      module,
      "handlers",
      "Handlers",
      input.handlers.filter((handler) => handler.module === module),
      (handler) => handler.name,
      (handler) => `handler:${handler.name}`,
    ),
    moduleCategory(
      module,
      "functions",
      "Functions",
      input.functions.filter((fn) => fn.module === module),
      (fn) => fn.name,
      (fn) => `function:${fn.name}`,
    ),
    moduleCategory(
      module,
      "tests",
      "Tests",
      input.tests.filter((test) => test.module === module),
      (test) => test.name,
      (test) => `test:${test.name}`,
    ),
    moduleCategory(
      module,
      "types",
      "Types",
      input.types.filter((type) => type.module === module),
      (type) => type.name,
      (type) => `type:${type.name}`,
    ),
    moduleCategory(
      module,
      "templates",
      "Templates",
      input.templates.filter((template) => template.module === module),
      (template) => template.name,
      (template) => `template:${template.name}`,
    ),
    moduleCategory(
      module,
      "assets",
      "Assets",
      input.assets.filter((asset) => asset.module === module),
      (asset) => asset.name,
      (asset) => `asset:${asset.name}`,
    ),
    moduleCategory(
      module,
      "packages",
      "Packages",
      input.packages.filter((pkg) => pkg.module === module),
      (pkg) => pkg.name,
      (pkg) => `package:${pkg.name}`,
    ),
    moduleCategory(
      module,
      "dev-views",
      "Dev Views",
      input.devViews.filter((view) => view.module === module),
      (view) => view.name,
      (view) => `dev-view:${view.name}`,
    ),
    moduleCategory(
      module,
      "dev-tools",
      "Dev Tools",
      input.devTools.filter((tool) => tool.module === module),
      (tool) => tool.name,
      (tool) => `dev-tool:${tool.name}`,
    ),
  ].filter((node): node is DocsNavNode => node !== null).map((category) => {
    const children = category.children?.filter((leaf) =>
      leaf.pageId ? pageIds.has(leaf.pageId) : true
    ) ?? [];
    return { ...category, count: children.length, children };
  }).filter((category) => category.children.length > 0);

  if (!categories.length) return null;
  return {
    id: `module:${module}`,
    title: module,
    count: categories.reduce((sum, category) => sum + (category.count ?? 0), 0),
    children: categories,
  };
}

function moduleCategory<T>(
  module: string,
  id: string,
  title: string,
  entries: T[],
  titleFor: (entry: T) => string,
  pageIdFor: (entry: T) => string,
): DocsNavNode | null {
  if (!entries.length) return null;
  const children = entries
    .map((entry) => ({
      id: `module:${module}:${pageIdFor(entry)}`,
      title: titleFor(entry),
      pageId: pageIdFor(entry),
    }))
    .toSorted((a, b) => a.title.localeCompare(b.title));
  return {
    id: `module:${module}:category:${id}`,
    title,
    count: children.length,
    children,
  };
}

export function docsToMarkdownFiles(docs: AppDocs): DocsExportFile[] {
  const pathMap = buildPagePathMap(docs);
  const files: DocsExportFile[] = [];

  for (const section of docs.sections) {
    for (const page of section.pages) {
      const path = pathMap.get(page.id);
      if (!path) continue;
      files.push({
        path: `docs/${path}`,
        content: rewriteMarkdownLinks(page.content, page.id, pathMap) + "\n",
      });
    }
  }

  return files;
}

export function docsToStaticSiteFiles(
  docs: AppDocs,
  projectName: string,
): DocsExportFile[] {
  return [{
    path: "index.html",
    content: buildStaticDocsHtml(docs, projectName),
  }];
}

function buildPagePathMap(docs: AppDocs): Map<string, string> {
  const map = new Map<string, string>();
  const used = new Set<string>();

  for (const section of docs.sections) {
    for (let i = 0; i < section.pages.length; i++) {
      const page = section.pages[i]!;
      const base = section.id === "overview" && i === 0
        ? "index.md"
        : i === 0
        ? `${slugify(section.id)}/index.md`
        : `${slugify(section.id)}/${slugify(page.id)}.md`;
      let path = base;
      let n = 2;
      while (used.has(path)) {
        path = base.replace(/\.md$/, `-${n}.md`);
        n++;
      }
      used.add(path);
      map.set(page.id, path);
    }
  }

  return map;
}

function rewriteMarkdownLinks(
  content: string,
  currentPageId: string,
  pathMap: Map<string, string>,
): string {
  const currentPath = pathMap.get(currentPageId) ?? "index.md";
  return content.replace(/\]\(#([^)]+)\)/g, (match, pageId: string) => {
    const targetPath = pathMap.get(decodePageId(pageId));
    if (!targetPath) return match;
    return `](${relativeMarkdownPath(currentPath, targetPath)})`;
  });
}

function relativeMarkdownPath(from: string, to: string): string {
  const fromParts = from.split("/");
  fromParts.pop();
  const toParts = to.split("/");

  while (
    fromParts.length > 0 && toParts.length > 0 &&
    fromParts[0] === toParts[0]
  ) {
    fromParts.shift();
    toParts.shift();
  }

  return [...fromParts.map(() => ".."), ...toParts].join("/") || "./";
}

function buildStaticDocsHtml(docs: AppDocs, projectName: string): string {
  const data = JSON.stringify(docs).replace(/</g, "\\u003c");
  const title = escapeHtml(projectName || "Project Docs");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title} Docs</title>
  <style>
    :root { color-scheme: light dark; --bg: #f7f7f8; --panel: #ffffff; --text: #1f2328; --muted: #667085; --border: #d0d7de; --accent: #0969da; --code: #f6f8fa; }
    @media (prefers-color-scheme: dark) { :root { --bg: #0d1117; --panel: #161b22; --text: #e6edf3; --muted: #8b949e; --border: #30363d; --accent: #58a6ff; --code: #0d1117; } }
    * { box-sizing: border-box; }
    body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    .shell { display: grid; grid-template-columns: 280px minmax(0, 1fr); min-height: 100vh; }
    nav { border-right: 1px solid var(--border); background: var(--panel); padding: 18px 14px; overflow: auto; }
    main { min-width: 0; padding: 32px; }
    article { max-width: 980px; margin: 0 auto; background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 28px 32px; }
    h1, h2, h3 { line-height: 1.25; }
    h1 { margin-top: 0; font-size: 28px; }
    h2 { margin-top: 28px; border-bottom: 1px solid var(--border); padding-bottom: 6px; }
    a { color: var(--accent); text-decoration: none; }
    a:hover { text-decoration: underline; }
    .brand { font-weight: 700; font-size: 15px; margin: 0 0 16px; }
    .section { margin: 14px 0 6px; color: var(--muted); font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; }
    .nav-link { display: block; width: 100%; border: 0; background: transparent; color: var(--text); text-align: left; padding: 6px 8px; border-radius: 5px; cursor: pointer; font: inherit; overflow-wrap: anywhere; }
    .nav-link:hover, .nav-link.active { background: color-mix(in srgb, var(--accent) 14%, transparent); color: var(--accent); }
    code { background: var(--code); border: 1px solid var(--border); border-radius: 4px; padding: 1px 4px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: .92em; }
    pre { background: var(--code); border: 1px solid var(--border); border-radius: 6px; padding: 14px; overflow: auto; }
    pre code { border: 0; padding: 0; background: transparent; }
    table { border-collapse: collapse; width: 100%; margin: 14px 0; display: block; overflow-x: auto; }
    th, td { border: 1px solid var(--border); padding: 7px 9px; text-align: left; vertical-align: top; }
    th { background: color-mix(in srgb, var(--border) 35%, transparent); }
    @media (max-width: 760px) { .shell { grid-template-columns: 1fr; } nav { border-right: 0; border-bottom: 1px solid var(--border); max-height: 44vh; } main { padding: 16px; } article { padding: 20px; } }
  </style>
</head>
<body>
  <div class="shell">
    <nav id="nav"><div class="brand">${title} Docs</div></nav>
    <main><article id="content"></article></main>
  </div>
  <script id="docs-data" type="application/json">${data}</script>
  <script>
    const docs = JSON.parse(document.getElementById("docs-data").textContent);
    const pages = new Map();
    const nav = document.getElementById("nav");
    for (const section of docs.sections) {
      const heading = document.createElement("div");
      heading.className = "section";
      heading.textContent = section.title;
      nav.appendChild(heading);
      for (const page of section.pages) {
        pages.set(page.id, page);
        const button = document.createElement("button");
        button.className = "nav-link";
        button.dataset.page = page.id;
        button.textContent = page.title;
        button.addEventListener("click", () => {
          location.hash = encodeURIComponent(page.id);
          render(page.id);
        });
        nav.appendChild(button);
      }
    }
    function escapeHtml(value) {
      return String(value).replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
    }
    function inline(md) {
      return escapeHtml(md)
        .replace(/\\[([^\\]]+)\\]\\(#([^\\)]+)\\)/g, (_m, text, id) => {
          const pageId = safeDecodeURIComponent(id);
          return '<a href="#' + encodeURIComponent(pageId) + '">' + text + '</a>';
        })
        .replace(/\\[([^\\]]+)\\]\\(([^\\)]+)\\)/g, (_m, text, url) => {
          const href = safeExternalHref(url);
          return href ? '<a href="' + href + '">' + text + '</a>' : text;
        })
        .replace(new RegExp("\\x60([^\\x60]+)\\x60", "g"), '<code>$1</code>')
        .replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>');
    }
    function safeDecodeURIComponent(value) {
      try { return decodeURIComponent(value); } catch { return value; }
    }
    function safeExternalHref(value) {
      try {
        const url = new URL(value);
        return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
      } catch {
        return null;
      }
    }
    function table(lines) {
      const rows = lines.filter(line => line.trim()).map(line => line.trim().slice(1, -1).split("|").map(cell => inline(cell.trim())));
      const head = rows.shift() || [];
      if (rows[0] && rows[0].every(cell => /^-+$/.test(cell.replace(/<[^>]*>/g, "")))) rows.shift();
      return '<table><thead><tr>' + head.map(cell => '<th>' + cell + '</th>').join("") + '</tr></thead><tbody>' + rows.map(row => '<tr>' + row.map(cell => '<td>' + cell + '</td>').join("") + '</tr>').join("") + '</tbody></table>';
    }
    function markdown(md) {
      const lines = md.split("\\n");
      const out = [];
      const fence = String.fromCharCode(96, 96, 96);
      let i = 0;
      while (i < lines.length) {
        const line = lines[i];
        if (line.startsWith(fence)) {
          const lang = line.slice(3).trim();
          const code = [];
          i++;
          while (i < lines.length && !lines[i].startsWith(fence)) code.push(lines[i++]);
          i++;
          out.push('<pre><code class="language-' + escapeHtml(lang) + '">' + escapeHtml(code.join("\\n")) + '</code></pre>');
          continue;
        }
        if (/^\\|.+\\|$/.test(line)) {
          const block = [];
          while (i < lines.length && /^\\|.*\\|$/.test(lines[i])) block.push(lines[i++]);
          out.push(table(block));
          continue;
        }
        const heading = line.match(/^(#{1,4})\\s+(.*)$/);
        if (heading) {
          const level = heading[1].length;
          out.push('<h' + level + '>' + inline(heading[2]) + '</h' + level + '>');
          i++;
          continue;
        }
        if (line.startsWith("- ")) {
          const items = [];
          while (i < lines.length && lines[i].startsWith("- ")) items.push('<li>' + inline(lines[i++].slice(2)) + '</li>');
          out.push('<ul>' + items.join("") + '</ul>');
          continue;
        }
        if (!line.trim()) { i++; continue; }
        const para = [];
        while (i < lines.length && lines[i].trim() && !lines[i].startsWith(fence) && !/^\\|.+\\|$/.test(lines[i]) && !/^(#{1,4})\\s+/.test(lines[i]) && !lines[i].startsWith("- ")) {
          para.push(lines[i++]);
        }
        out.push('<p>' + inline(para.join(" ")) + '</p>');
      }
      return out.join("\\n");
    }
    function render(id) {
      const page = pages.get(id) || docs.sections[0]?.pages[0];
      if (!page) return;
      document.querySelectorAll(".nav-link").forEach(button => button.classList.toggle("active", button.dataset.page === page.id));
      document.getElementById("content").innerHTML = markdown(page.content);
    }
    window.addEventListener("hashchange", () => render(decodeURIComponent(location.hash.slice(1))));
    render(location.hash ? decodeURIComponent(location.hash.slice(1)) : docs.sections[0]?.pages[0]?.id);
  </script>
</body>
</html>
`;
}

function slugify(value: string): string {
  const slug = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(
    /^-+|-+$/g,
    "",
  );
  return slug || "page";
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[ch]!));
}

// --- Page builders ---

function buildOverview(
  routes: RouteEntry[],
  schemas: Array<{ tableName: string }>,
  handlers: Array<{ name: string }>,
  functions: Array<{ name: string }>,
  tests: Array<{ name: string }>,
  templates: Array<{ name: string }>,
  assets: Array<{ name: string }>,
  configs: Array<{ name: string }>,
  devViews: Array<{ name: string }>,
  devTools: Array<{ name: string }>,
  types: Array<{ name: string }>,
  packages: Array<{ name: string }>,
  envVars: Array<{ key: string }>,
  secrets: Array<{ key: string }>,
  customAudits: Array<{ name: string }>,
  modules: string[],
): string {
  const lines: string[] = ["# Overview", ""];

  lines.push("| | Count |", "|---|---|");
  if (routes.length) {
    lines.push(`| [Routes](${pageLink("api")}) | ${routes.length} |`);
  }
  if (schemas.length) {
    lines.push(`| [Tables](${pageLink("data-model")}) | ${schemas.length} |`);
  }
  if (handlers.length) {
    lines.push(`| [Handlers](${pageLink("handlers")}) | ${handlers.length} |`);
  }
  if (functions.length) {
    lines.push(
      `| [Functions](${pageLink("functions")}) | ${functions.length} |`,
    );
  }
  if (tests.length) {
    lines.push(`| [Tests](${pageLink("tests")}) | ${tests.length} |`);
  }
  if (types.length) {
    lines.push(`| [Types](${pageLink("types")}) | ${types.length} |`);
  }
  if (templates.length) {
    lines.push(
      `| [Templates](${pageLink("templates")}) | ${templates.length} |`,
    );
  }
  if (assets.length) {
    lines.push(`| [Assets](${pageLink("assets")}) | ${assets.length} |`);
  }
  if (packages.length) {
    lines.push(`| [Packages](${pageLink("packages")}) | ${packages.length} |`);
  }
  if (configs.length) {
    lines.push(`| [Config](${pageLink("config")}) | ${configs.length} |`);
  }
  if (envVars.length) {
    lines.push(
      `| [Environment Variables](${
        pageLink("env-vars")
      }) | ${envVars.length} |`,
    );
  }
  if (secrets.length) {
    lines.push(`| [Secrets](${pageLink("secrets")}) | ${secrets.length} |`);
  }
  if (devViews.length) {
    lines.push(
      `| [Dev Views](${pageLink("dev-views")}) | ${devViews.length} |`,
    );
  }
  if (devTools.length) {
    lines.push(
      `| [Dev Tools](${pageLink("dev-tools")}) | ${devTools.length} |`,
    );
  }
  if (customAudits.length) {
    lines.push(
      `| [Custom Audits](${
        pageLink("custom-audits")
      }) | ${customAudits.length} |`,
    );
  }
  lines.push("");

  if (modules.length) {
    lines.push("## Modules", "");
    for (const m of modules) lines.push(`- \`${m}\``);
    lines.push("");
  }

  return lines.join("\n");
}

function buildApiIndex(grouped: Map<string, RouteEntry[]>): string {
  const lines: string[] = ["# API Reference", ""];

  for (const [mod, modRoutes] of sorted(grouped)) {
    lines.push(`## ${mod}`, "");
    lines.push("| Method | Path | Handler | Summary |", "|---|---|---|---|");
    for (const r of modRoutes) {
      const summary = r.schema?.summary ?? "";
      lines.push(
        `| \`${r.method}\` | [\`${r.path}\`](${
          pageLink(`route:${r.method}:${r.path}`)
        }) | [\`${r.handlerName}\`](${
          pageLink(`handler:${r.handlerName}`)
        }) | ${summary} |`,
      );
    }
    lines.push("");
  }

  return lines.join("\n");
}

function buildRoutePage(
  route: RouteEntry,
  handlers: Array<{ name: string; source: string }>,
): string {
  const lines: string[] = [`# ${route.method} ${route.path}`, ""];

  if (route.schema?.summary) lines.push(route.schema.summary, "");
  if (route.schema?.description) lines.push(route.schema.description, "");

  lines.push(
    `**Handler:** [\`${route.handlerName}\`](${
      pageLink(`handler:${route.handlerName}`)
    })`,
  );
  if (route.module) lines.push(`**Module:** \`${route.module}\``);
  lines.push("");

  renderRouteSchema(route.schema, lines);

  const handler = handlers.find((h) => h.name === route.handlerName);
  if (handler) {
    lines.push("## Handler Source", "");
    lines.push("```typescript", handler.source, "```", "");
  }

  return lines.join("\n");
}

function buildSchemaIndex(
  schemas: Array<
    { tableName: string; columns: Array<{ name: string }>; module?: string }
  >,
): string {
  const lines: string[] = ["# Data Model", ""];
  lines.push("| Table | Columns | Module |", "|---|---|---|");
  for (const s of schemas) {
    lines.push(
      `| [\`${s.tableName}\`](${
        pageLink(`schema:${s.tableName}`)
      }) | ${s.columns.length} | ${s.module ?? ""} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

function buildSchemaPage(
  schema: {
    tableName: string;
    columns: Array<
      {
        name: string;
        type: string;
        primaryKey: boolean;
        nullable: boolean;
        defaultValue: string | null;
      }
    >;
    sql: string;
    module?: string;
  },
): string {
  const lines: string[] = [`# ${schema.tableName}`, ""];
  if (schema.module) lines.push(`**Module:** \`${schema.module}\``, "");

  lines.push("## Columns", "");
  lines.push(
    "| Column | Type | PK | Nullable | Default |",
    "|---|---|---|---|---|",
  );
  for (const col of schema.columns) {
    lines.push(
      `| \`${col.name}\` | ${col.type} | ${col.primaryKey ? "YES" : ""} | ${
        col.nullable ? "YES" : ""
      } | ${col.defaultValue ?? ""} |`,
    );
  }
  lines.push("");

  lines.push("## SQL", "", "```sql", schema.sql, "```", "");

  return lines.join("\n");
}

function buildHandlerIndex(
  handlers: Array<{ name: string; module?: string; purpose?: string }>,
  handlerRouteMap: Map<string, RouteEntry[]>,
): string {
  const lines: string[] = ["# Handlers", ""];
  lines.push("| Handler | Purpose | Routes | Module |", "|---|---|---|---|");
  for (const h of handlers) {
    const routes = handlerRouteMap.get(h.name) ?? [];
    const routeStr = routes.map((r) =>
      `\`${r.method} ${r.path}\``
    ).join(", ") || "—";
    lines.push(
      `| [\`${h.name}\`](${pageLink(`handler:${h.name}`)}) | ${
        h.purpose ?? ""
      } | ${routeStr} | ${h.module ?? ""} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

function buildHandlerPage(
  handler: { name: string; source: string; module?: string; purpose?: string },
  handlerRouteMap: Map<string, RouteEntry[]>,
): string {
  const lines: string[] = [`# ${handler.name}`, ""];
  if (handler.module) lines.push(`**Module:** \`${handler.module}\``, "");
  if (handler.purpose) lines.push(handler.purpose, "");

  const routes = handlerRouteMap.get(handler.name) ?? [];
  if (routes.length) {
    lines.push("## Routes", "");
    for (const r of routes) {
      lines.push(
        `- [\`${r.method} ${r.path}\`](${
          pageLink(`route:${r.method}:${r.path}`)
        })`,
      );
    }
    lines.push("");
  }

  lines.push("## Source", "", "```typescript", handler.source, "```", "");

  return lines.join("\n");
}

function buildFunctionIndex(
  functions: Array<{ name: string; module?: string; purpose?: string }>,
): string {
  const lines: string[] = ["# Functions", ""];
  lines.push("| Function | Purpose | Module |", "|---|---|---|");
  for (const fn of functions) {
    lines.push(
      `| [\`${fn.name}\`](${pageLink(`function:${fn.name}`)}) | ${
        fn.purpose ?? ""
      } | ${fn.module ?? ""} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

function buildFunctionPage(
  fn: { name: string; source: string; module?: string; purpose?: string },
): string {
  const lines: string[] = [`# ${fn.name}`, ""];
  if (fn.module) lines.push(`**Module:** \`${fn.module}\``, "");
  if (fn.purpose) lines.push(fn.purpose, "");
  lines.push("## Source", "", "```typescript", fn.source, "```", "");
  return lines.join("\n");
}

function buildTestIndex(
  tests: Array<
    {
      name: string;
      module?: string;
      lastResult?: { passed: boolean; durationMs: number; ranAt: string };
    }
  >,
): string {
  const lines: string[] = ["# Tests", ""];
  lines.push("| Test | Last Result | Duration | Module |", "|---|---|---|---|");
  for (const test of tests) {
    const result = test.lastResult
      ? test.lastResult.passed ? "passed" : "failed"
      : "";
    const duration = test.lastResult ? `${test.lastResult.durationMs} ms` : "";
    lines.push(
      `| [\`${test.name}\`](${
        pageLink(`test:${test.name}`)
      }) | ${result} | ${duration} | ${test.module ?? ""} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

function buildTestPage(
  test: {
    name: string;
    source: string;
    module?: string;
    changesetId?: string;
    lastResult?: {
      passed: boolean;
      error?: string;
      errorName?: string;
      durationMs: number;
      ranAt: string;
    };
  },
): string {
  const lines: string[] = [`# ${test.name}`, ""];
  if (test.module) lines.push(`**Module:** \`${test.module}\``);
  if (test.changesetId) lines.push(`**Changeset:** \`${test.changesetId}\``);
  if (test.module || test.changesetId) lines.push("");

  if (test.lastResult) {
    lines.push("## Last Result", "");
    lines.push(
      `- Status: ${test.lastResult.passed ? "passed" : "failed"}`,
      `- Duration: ${test.lastResult.durationMs} ms`,
      `- Ran at: ${test.lastResult.ranAt}`,
    );
    if (test.lastResult.error) {
      lines.push(`- Error: ${test.lastResult.error}`);
    }
    lines.push("");
  }

  lines.push("## Source", "", "```typescript", test.source, "```", "");
  return lines.join("\n");
}

function buildTypeIndex(
  types: Array<
    { name: string; fields: Array<{ name: string }>; module?: string }
  >,
): string {
  const lines: string[] = ["# Types", ""];
  lines.push("| Type | Fields | Module |", "|---|---|---|");
  for (const type of types) {
    lines.push(
      `| [\`${type.name}\`](${
        pageLink(`type:${type.name}`)
      }) | ${type.fields.length} | ${type.module ?? ""} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

function buildTypePage(
  type: {
    name: string;
    fields: Array<
      { name: string; type: string; description?: string; optional?: boolean }
    >;
    description?: string;
    module?: string;
  },
): string {
  const lines: string[] = [`# ${type.name}`, ""];
  if (type.module) lines.push(`**Module:** \`${type.module}\``, "");
  if (type.description) lines.push(type.description, "");

  lines.push("| Field | Type | Optional | Description |", "|---|---|---|---|");
  for (const field of type.fields) {
    lines.push(
      `| \`${field.name}\` | ${field.type} | ${field.optional ? "YES" : ""} | ${
        field.description ?? ""
      } |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

function buildTemplateIndex(
  templates: DocsTemplate[],
): string {
  const lines: string[] = ["# Templates", ""];
  lines.push(
    "| Template | Module | Size | Registered At |",
    "|---|---|---|---|",
  );
  for (const t of templates) {
    lines.push(
      `| [\`${escapeMarkdownTableCell(t.name)}\`](${
        pageLink(`template:${t.name}`)
      }) | ${t.module ?? ""} | ${
        formatSize(textByteLength(t.content))
      } | ${t.registeredAt} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

function buildTemplatePage(template: DocsTemplate): string {
  const lines: string[] = [`# ${template.name}`, ""];
  if (template.module) lines.push(`**Module:** \`${template.module}\``);
  lines.push(
    `**Registered:** ${template.registeredAt}`,
    `**Size:** ${formatSize(textByteLength(template.content))}`,
    "",
    "## Source",
    "",
    "```html",
    template.content,
    "```",
    "",
  );
  return lines.join("\n");
}

function buildAssetIndex(
  assets: DocsAsset[],
): string {
  const lines: string[] = ["# Assets", ""];
  lines.push(
    "| Asset | MIME Type | Size | Module | Registered At |",
    "|---|---|---|---|---|",
  );
  for (const a of assets) {
    lines.push(
      `| [\`${escapeMarkdownTableCell(a.name)}\`](${
        pageLink(`asset:${a.name}`)
      }) | ${a.mimeType} | ${formatSize(a.size)} | ${
        a.module ?? ""
      } | ${a.registeredAt} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

function buildAssetPage(
  asset: DocsAsset,
  fullAsset: { content: Uint8Array; mimeType: string } | undefined,
): string {
  const lines: string[] = [`# ${asset.name}`, ""];
  if (asset.module) lines.push(`**Module:** \`${asset.module}\``);
  lines.push(
    `**MIME Type:** \`${asset.mimeType}\``,
    `**Size:** ${formatSize(asset.size)}`,
    `**Registered:** ${asset.registeredAt}`,
    `**Served URL:** \`${assetUrl(asset.name)}\``,
    "",
  );

  const source = fullAsset
    ? decodeEditableAssetSource(fullAsset.content, fullAsset.mimeType)
    : null;
  if (source !== null) {
    lines.push(
      "## Source",
      "",
      "```" + assetCodeLanguage(asset.mimeType),
      source,
      "```",
      "",
    );
  }

  return lines.join("\n");
}

function buildPackageIndex(
  packages: DocsPackage[],
): string {
  const lines: string[] = ["# Packages", ""];
  const hasRegistryInfo = packages.some((pkg) =>
    packageRegistryInfoAvailable(pkg.registryInfo)
  );
  lines.push(
    hasRegistryInfo
      ? "| Package | Specifier | Current Range | Installed At | Pin Status | Latest | Outdated | License | Homepage | npm |"
      : "| Package | Specifier | Current Range | Installed At | Pin Status | npm |",
    hasRegistryInfo
      ? "|---|---|---|---|---|---|---|---|---|---|"
      : "|---|---|---|---|---|---|",
  );
  for (const pkg of packages) {
    const currentRange = parsePackageCurrentRange(pkg);
    const homepage = safePackageHomepage(pkg);
    const offlineCells = [
      `[\`${escapeMarkdownTableCell(pkg.name)}\`](${
        pageLink(`package:${pkg.name}`)
      })`,
      `\`${escapeMarkdownTableCell(pkg.specifier)}\``,
      currentRange ? `\`${escapeMarkdownTableCell(currentRange)}\`` : "",
      pkg.installedAt,
      pinStatus(pkg),
    ];
    const registryCells = hasRegistryInfo
      ? [
        pkg.registryInfo?.latest
          ? `\`${escapeMarkdownTableCell(pkg.registryInfo.latest)}\``
          : "",
        packageOutdatedStatus(pkg),
        pkg.registryInfo?.license
          ? escapeMarkdownTableCell(pkg.registryInfo.license)
          : "",
        homepage ? `[homepage](${homepage})` : "",
      ]
      : [];
    lines.push(
      `| ${
        [...offlineCells, ...registryCells, `[npm](${npmPackageUrl(pkg.name)})`]
          .join(" | ")
      } |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

function buildPackagePage(pkg: DocsPackage): string {
  const currentRange = parsePackageCurrentRange(pkg);
  const lines: string[] = [`# ${pkg.name}`, ""];
  lines.push(
    `**Specifier:** \`${pkg.specifier}\``,
    `**Installed:** ${pkg.installedAt}`,
    `**Pin Status:** ${pinStatus(pkg)}`,
    `**npm:** [${npmPackageUrl(pkg.name)}](${npmPackageUrl(pkg.name)})`,
  );
  if (currentRange) {
    lines.splice(3, 0, `**Current Range:** \`${currentRange}\``);
  }
  const registryInfo = pkg.registryInfo;
  if (packageRegistryInfoAvailable(registryInfo)) {
    lines.push("");
    const homepage = safePackageHomepage(pkg);
    if (registryInfo.latest) {
      lines.push(`**Latest Version:** \`${registryInfo.latest}\``);
      lines.push(`**Outdated:** ${packageOutdatedStatus(pkg)}`);
    }
    if (registryInfo.license) {
      lines.push(`**License:** ${registryInfo.license}`);
    }
    if (homepage) {
      lines.push(`**Homepage:** [${homepage}](${homepage})`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

function buildConfigList(
  configs: Array<
    { name: string; type: string; description?: string; module?: string }
  >,
): string {
  const lines: string[] = ["# Config", ""];
  lines.push("| Key | Type | Description | Module |", "|---|---|---|---|");
  for (const c of configs) {
    lines.push(
      `| \`${c.name}\` | ${c.type} | ${c.description ?? ""} | ${
        c.module ?? ""
      } |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

function buildEnvVarList(
  envVars: Array<
    {
      key: string;
      description?: string;
      status: "set" | "env" | "unset";
      updatedAt: string;
    }
  >,
): string {
  const lines: string[] = ["# Environment Variables", ""];
  lines.push(
    "| Key | Status | Description | Updated At |",
    "|---|---|---|---|",
  );
  for (const envVar of envVars) {
    lines.push(
      `| \`${envVar.key}\` | ${envVar.status} | ${
        envVar.description ?? ""
      } | ${envVar.updatedAt} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

function buildSecretList(
  secrets: Array<
    {
      key: string;
      description?: string;
      status: "set" | "env" | "unset";
      updatedAt: string;
    }
  >,
): string {
  const lines: string[] = [
    "# Secrets",
    "",
    "Secret values are intentionally omitted.",
    "",
  ];
  lines.push(
    "| Key | Status | Description | Updated At |",
    "|---|---|---|---|",
  );
  for (const secret of secrets) {
    lines.push(
      `| \`${secret.key}\` | ${secret.status} | ${
        secret.description ?? ""
      } | ${secret.updatedAt} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

function buildDevViewIndex(
  devViews: Array<
    { name: string; targetType: string; title: string; module?: string }
  >,
): string {
  const lines: string[] = ["# Dev Views", ""];
  lines.push("| View | Target | Title | Module |", "|---|---|---|---|");
  for (const view of devViews) {
    lines.push(
      `| [\`${view.name}\`](${
        pageLink(`dev-view:${view.name}`)
      }) | \`${view.targetType}\` | ${view.title} | ${view.module ?? ""} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

function buildDevViewPage(
  view: {
    name: string;
    targetType: string;
    title: string;
    source: string;
    module?: string;
  },
): string {
  const lines: string[] = [`# ${view.name}`, ""];
  lines.push(`**Target:** \`${view.targetType}\``);
  lines.push(`**Title:** ${view.title}`);
  if (view.module) lines.push(`**Module:** \`${view.module}\``);
  lines.push("");
  lines.push("## Source", "", "```typescript", view.source, "```", "");
  return lines.join("\n");
}

function buildDevToolIndex(
  devTools: Array<{ name: string; description: string }>,
): string {
  const lines: string[] = ["# Dev Tools", ""];
  for (const tool of devTools) {
    lines.push(
      `- [\`${tool.name}\`](${
        pageLink(`dev-tool:${tool.name}`)
      }) — ${tool.description}`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

function buildDevToolPage(
  tool: {
    name: string;
    description: string;
    args: Array<
      { name: string; type: string; description: string; required: boolean }
    >;
    module?: string;
  },
): string {
  const lines: string[] = [`# ${tool.name}`, ""];
  if (tool.description) lines.push(tool.description, "");
  if (tool.args.length) {
    lines.push("## Arguments", "");
    lines.push("| Arg | Type | Required | Description |", "|---|---|---|---|");
    for (const arg of tool.args) {
      lines.push(
        `| \`${arg.name}\` | ${arg.type} | ${
          arg.required ? "YES" : ""
        } | ${arg.description} |`,
      );
    }
    lines.push("");
  }
  return lines.join("\n");
}

function buildCustomAuditList(
  audits: Array<{ name: string; description: string; module?: string }>,
): string {
  const lines: string[] = ["# Custom Audits", ""];
  lines.push("| Name | Description | Module |", "|---|---|---|");
  for (const audit of audits) {
    lines.push(
      `| \`${audit.name}\` | ${audit.description} | ${audit.module ?? ""} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

// --- Helpers ---

function renderRouteSchema(
  schema: RouteSchema | undefined,
  lines: string[],
): void {
  if (!schema) return;

  if (schema.params && Object.keys(schema.params).length) {
    lines.push("## Path Parameters", "");
    for (const [name, def] of Object.entries(schema.params)) {
      lines.push(
        `- \`${name}\` (${def.type})${
          def.description ? " — " + def.description : ""
        }`,
      );
    }
    lines.push("");
  }

  if (schema.query && Object.keys(schema.query).length) {
    lines.push("## Query Parameters", "");
    for (const [name, def] of Object.entries(schema.query)) {
      const req = def.required ? ", required" : "";
      lines.push(
        `- \`${name}\` (${def.type}${req})${
          def.description ? " — " + def.description : ""
        }`,
      );
    }
    lines.push("");
  }

  if (schema.body) {
    lines.push("## Request Body", "", "`application/json`", "");
    if (schema.body.properties) {
      const required = new Set(schema.body.required ?? []);
      for (const [name, def] of Object.entries(schema.body.properties)) {
        const prop = def as Record<string, unknown>;
        const req = required.has(name) ? ", required" : "";
        lines.push(
          `- \`${name}\` (${prop.type ?? "any"}${req})${
            prop.description ? " — " + prop.description : ""
          }`,
        );
      }
      lines.push("");
    }
  }

  if (schema.responses && Object.keys(schema.responses).length) {
    lines.push("## Responses", "");
    for (const [code, def] of Object.entries(schema.responses)) {
      lines.push(`- \`${code}\` — ${def.description}`);
    }
    lines.push("");
  }
}

function textByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function assetUrl(name: string): string {
  return `/_assets/${encodePageId(name)}`;
}

function decodeEditableAssetSource(
  content: Uint8Array,
  mimeType: string,
): string | null {
  if (!isEditableTextAssetMime(mimeType)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    return null;
  }
}

function assetCodeLanguage(mimeType: string): string {
  const mime = mimeType.split(";")[0]!.trim().toLowerCase();
  switch (mime) {
    case "application/javascript":
    case "text/javascript":
      return "javascript";
    case "application/json":
      return "json";
    case "application/svg+xml":
    case "image/svg+xml":
      return "svg";
    case "application/xml":
    case "text/xml":
      return "xml";
    case "application/yaml":
    case "text/yaml":
      return "yaml";
    case "text/css":
      return "css";
    case "text/html":
      return "html";
    case "text/markdown":
      return "markdown";
    default:
      return "";
  }
}

function parsePackageCurrentRange(
  pkg: Pick<DocsPackage, "name" | "specifier">,
) {
  return parseSpecifierRange(pkg.specifier, pkg.name);
}

function pinStatus(pkg: Pick<DocsPackage, "pinned">): string {
  return pkg.pinned ? "pinned" : "not pinned";
}

function packageRegistryInfoAvailable(
  info: DocsPackageRegistryInfo | null | undefined,
): info is DocsPackageRegistryInfo {
  return Boolean(
    safeHomepageUrl(info?.homepage) || info?.license || info?.latest,
  );
}

function packageOutdatedStatus(pkg: DocsPackage): string {
  const latest = pkg.registryInfo?.latest;
  if (!latest) return "";
  return isPackageOutdated(pkg.specifier, pkg.name, latest) ? "yes" : "no";
}

function safePackageHomepage(pkg: DocsPackage): string | null {
  return safeHomepageUrl(pkg.registryInfo?.homepage);
}

function safeHomepageUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

function npmPackageUrl(name: string): string {
  return `https://www.npmjs.com/package/${
    name.split("/").map((part) => encodeURIComponent(part)).join("/")
  }`;
}

function escapeMarkdownTableCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function pageLink(pageId: string): string {
  return `#${encodePageId(pageId)}`;
}

function encodePageId(pageId: string): string {
  return encodeURIComponent(pageId).replace(
    /[!'()*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function decodePageId(pageId: string): string {
  try {
    return decodeURIComponent(pageId);
  } catch {
    return pageId;
  }
}

function ungroupedModule(path: string): string {
  const seg = path.split("/").filter(Boolean)[0];
  return seg || "root";
}

function groupBy<T>(items: T[], keyFn: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    const arr = map.get(key);
    if (arr) arr.push(item);
    else map.set(key, [item]);
  }
  return map;
}

function sorted<T>(map: Map<string, T[]>): [string, T[]][] {
  return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
