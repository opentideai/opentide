import type { DevViewEntry, DevViewFn, KernelInspectAPI } from "./types.ts";
import type { Kernel } from "./registries.ts";
import { compileDevView } from "./compiler.ts";
import { createTimestampedId } from "./ids.ts";

export class DevViewMap {
  private views = new Map<string, DevViewEntry>();

  register(
    name: string,
    targetType: string,
    title: string,
    source: string,
    fn: DevViewFn,
    builtIn = false,
    module?: string,
    runtimeId?: string,
    language?: string,
    entityUid?: string,
  ): void {
    this.views.set(name, {
      name,
      targetType,
      title,
      source,
      fn,
      builtIn,
      registeredAt: new Date().toISOString(),
      ...(module ? { module } : {}),
      ...(runtimeId ? { runtimeId } : {}),
      ...(language ? { language } : {}),
      // A2 (Stream A): mint once, preserve across updates. See HandlerMap.register.
      entityUid: entityUid ?? this.views.get(name)?.entityUid ??
        createTimestampedId("ent"),
    });
  }

  get(name: string): DevViewEntry | undefined {
    return this.views.get(name);
  }

  getForType(targetType: string): DevViewEntry[] {
    const builtIns: DevViewEntry[] = [];
    const custom: DevViewEntry[] = [];
    for (const v of this.views.values()) {
      if (v.targetType === targetType) {
        if (v.builtIn) builtIns.push(v);
        else custom.push(v);
      }
    }
    return [...custom, ...builtIns];
  }

  list(): DevViewEntry[] {
    return [...this.views.values()];
  }

  remove(name: string): boolean {
    return this.views.delete(name);
  }

  clear(): void {
    this.views.clear();
  }

  serialize(): Array<{
    name: string;
    targetType: string;
    title: string;
    source: string;
    builtIn: boolean;
    registeredAt: string;
    module?: string;
    runtimeId?: string;
    language?: string;
    entityUid: string;
  }> {
    return this.list().map(({
      name,
      targetType,
      title,
      source,
      builtIn,
      registeredAt,
      module,
      runtimeId,
      language,
      entityUid,
    }) => ({
      name,
      targetType,
      title,
      source,
      builtIn,
      registeredAt,
      ...(module ? { module } : {}),
      ...(runtimeId ? { runtimeId } : {}),
      ...(language ? { language } : {}),
      entityUid,
    }));
  }
}

function kernelInspectAPI(kernel: Kernel): KernelInspectAPI {
  return {
    listRoutes: () => kernel.routes.list(),
    listHandlers: () => kernel.handlers.serialize(),
    listFunctions: () =>
      kernel.functions.serialize() as Array<
        {
          name: string;
          source: string;
          registeredAt: string;
          returnType?: string;
        }
      >,
    listConfigs: () => kernel.configs.list(),
    listSchemas: () => kernel.db.listSchemas(),
    listTypes: () => kernel.types.serialize(),
    listDevViews: () =>
      kernel.devViews.list().map((v) => ({
        name: v.name,
        targetType: v.targetType,
        title: v.title,
        builtIn: v.builtIn,
      })),
    getAssetContent: (name: string) => {
      const asset = kernel.assets.get(name);
      if (!asset) return null;
      try {
        return new TextDecoder().decode(asset.content);
      } catch {
        return null;
      }
    },
    getDevViewSource: (name: string) => {
      const view = kernel.devViews.get(name);
      return view?.source ?? null;
    },
  };
}

export { kernelInspectAPI };

const DEFAULT_VIEWS: Array<
  { name: string; targetType: string; title: string; source: string }
> = [
  {
    name: "handler",
    targetType: "handler",
    title: "Handler",
    source: `function handler(object: any) {
  const routes = kernel.listRoutes().filter((r: any) => r.handlerName === object.name);
  return {
    type: "stack",
    children: [
      {
        type: "key-value",
        title: "Details",
        entries: [
          { key: "Name", value: object.name, mono: true },
          ...(object.purpose ? [{ key: "Purpose", value: object.purpose }] : []),
          { key: "Registered", value: object.registeredAt },
        ],
      },
      { type: "code", title: "Source", source: object.source, language: "typescript", editEntity: { category: "handler", name: object.name } },
      routes.length > 0
        ? { type: "table", title: "Routes", columns: ["Method", "Path"], rows: routes.map((r: any) => [r.method, r.path]), rowLinks: routes.map((r: any) => ({ category: "route", key: r.method + " " + r.path })) }
        : { type: "markdown", content: "*No routes bound to this handler.*" },
    ],
  };
}`,
  },
  {
    name: "fn",
    targetType: "function",
    title: "Function",
    source: `function fn(object: any) {
  var params: any[] = [];
  var match = object.source.match(/(?:async\\s+)?function\\s+\\w+\\s*\\(([^)]*)\\)/);
  if (match && match[1]) {
    params = match[1].split(",").map(function(p: string) {
      p = p.trim();
      if (!p) return null;
      var parts = p.split("=");
      var nameType = parts[0]!.trim();
      var def = parts.length > 1 ? parts.slice(1).join("=").trim() : undefined;
      var nt = nameType.split(":");
      var name = nt[0]!.trim().replace(/\\?$/, "");
      var optional = nt[0]!.trim().endsWith("?");
      var type = nt.length > 1 ? nt.slice(1).join(":").trim() : undefined;
      if (optional && type) type = type + " (optional)";
      return { name: name, type: type, default: def };
    }).filter(Boolean);
  }
  return {
    type: "stack",
    children: [
      {
        type: "key-value",
        title: "Details",
        entries: [
          { key: "Name", value: object.name, mono: true },
          ...(object.purpose ? [{ key: "Purpose", value: object.purpose }] : []),
          ...(object.returnType ? [{ key: "Returns", value: object.returnType, mono: true }] : []),
          { key: "Registered", value: object.registeredAt },
        ],
      },
      { type: "function-runner", name: object.name, params: params, returnType: object.returnType },
      { type: "code", title: "Source", source: object.source, language: "typescript", editEntity: { category: "function", name: object.name } },
    ],
  };
}`,
  },
  {
    name: "route",
    targetType: "route",
    title: "Route",
    source: `function route(object: any) {
  const children: any[] = [
    {
      type: "key-value",
      title: "Route",
      entries: [
        { key: "Method", value: object.method, mono: true },
        { key: "Path", value: object.path, mono: true },
        { key: "Handler", value: object.handlerName, mono: true, link: { category: "handler", key: object.handlerName } },
        { key: "Registered", value: object.registeredAt },
      ],
    },
  ];

  const s = object.schema;
  if (s) {
    if (s.summary || s.description) {
      const entries: any[] = [];
      if (s.summary) entries.push({ key: "Summary", value: s.summary });
      if (s.description) entries.push({ key: "Description", value: s.description });
      if (s.tags?.length) entries.push({ key: "Tags", value: s.tags.join(", ") });
      children.push({ type: "key-value", title: "API Info", entries });
    }

    if (s.params && Object.keys(s.params).length > 0) {
      const rows = Object.entries(s.params).map(([name, def]: [string, any]) => [
        name, def.type ?? "string", def.description ?? "", def.enum ? def.enum.join(", ") : "",
      ]);
      children.push({ type: "table", title: "Path Parameters", columns: ["Name", "Type", "Description", "Enum"], rows });
    }

    if (s.query && Object.keys(s.query).length > 0) {
      const rows = Object.entries(s.query).map(([name, def]: [string, any]) => [
        name, def.type ?? "string", def.required ? "Yes" : "No", def.description ?? "",
      ]);
      children.push({ type: "table", title: "Query Parameters", columns: ["Name", "Type", "Required", "Description"], rows });
    }

    if (s.body) {
      children.push({ type: "code", title: "Request Body", source: JSON.stringify(s.body, null, 2), language: "json" });
    }

    if (s.responses) {
      const rows = Object.entries(s.responses).map(([status, def]: [string, any]) => [
        status, def.description ?? "",
      ]);
      children.push({ type: "table", title: "Responses", columns: ["Status", "Description"], rows });
      for (const [status, def] of Object.entries(s.responses) as [string, any][]) {
        if (def.schema) {
          children.push({ type: "code", title: "Response " + status, source: JSON.stringify(def.schema, null, 2), language: "json" });
        }
      }
    }
  } else {
    children.push({ type: "markdown", content: "*No schema defined — add one via register\\\\_route with a schema parameter.*" });
  }

  return { type: "stack", children, gap: 8 };
}`,
  },
  {
    name: "schema",
    targetType: "schema",
    title: "Schema",
    source: `async function schema(object: any) {
  let dataSection;
  try {
    const safe = String(object.tableName).replace(/[^a-zA-Z0-9_]/g, "");
    const countResult = await db.query('SELECT count(*)::int AS total FROM "' + safe + '"');
    const total = countResult[0]?.total ?? 0;
    const rows = await db.query('SELECT * FROM "' + safe + '" LIMIT 25');
    if (rows.length > 0) {
      const cols = Object.keys(rows[0]);
      const title = total <= 25 ? "Data (" + total + " rows)" : "Data (first 25 of " + total + " rows)";
      dataSection = { type: "table", title: title, columns: cols, rows: rows.map((r: any) => cols.map(c => r[c])) };
    } else {
      dataSection = { type: "markdown", content: "*No rows in table.*" };
    }
  } catch {
    dataSection = { type: "markdown", content: "*Could not query table.*" };
  }
  return {
    type: "stack",
    children: [
      {
        type: "key-value",
        title: "Table",
        entries: [
          { key: "Name", value: object.tableName, mono: true },
          { key: "Created", value: object.createdAt },
          { key: "Updated", value: object.updatedAt },
        ],
      },
      {
        type: "table",
        title: "Columns",
        columns: ["Name", "Type", "PK", "Nullable", "Default"],
        rows: object.columns.map((c: any) => [c.name, c.type, c.primaryKey ? "YES" : "", c.nullable ? "YES" : "", c.defaultValue ?? ""]),
      },
      { type: "code", title: "SQL", source: object.sql, language: "sql", editEntity: { category: "schema", name: object.tableName } },
      dataSection,
    ],
  };
}`,
  },
  {
    name: "error",
    targetType: "error",
    title: "Error",
    source: `function error(object: any) {
  const children: any[] = [
    {
      type: "key-value",
      title: "Error",
      entries: [
        { key: "Message", value: object.error },
        { key: "Timestamp", value: object.timestamp },
        ...(object.route ? [{ key: "Route", value: object.route, mono: true, link: { category: "route", key: object.route } }] : []),
      ],
    },
  ];
  if (object.stack) {
    children.push({ type: "code", title: "Stack Trace", source: object.stack });
  }
  return { type: "stack", children };
}`,
  },
  {
    name: "request",
    targetType: "request",
    title: "Request",
    source: `function request(object: any) {
  return {
    type: "key-value",
    title: "Request",
    entries: [
      { key: "Method", value: object.method, mono: true },
      { key: "Path", value: object.path, mono: true },
      { key: "Status", value: String(object.status), mono: true },
      { key: "Duration", value: object.durationMs + "ms" },
      { key: "Timestamp", value: object.timestamp },
    ],
  };
}`,
  },
  {
    name: "template",
    targetType: "template",
    title: "Template",
    source: `function template(object: any) {
  const lang = object.name.endsWith('.md') ? 'markdown'
    : object.name.endsWith('.css') ? 'css'
    : object.name.endsWith('.json') ? 'json'
    : object.name.endsWith('.xml') ? 'xml'
    : object.name.endsWith('.yaml') || object.name.endsWith('.yml') ? 'yaml'
    : 'html';
  return {
    type: "stack",
    children: [
      {
        type: "key-value",
        title: "Details",
        entries: [
          { key: "Name", value: object.name, mono: true },
          { key: "Size", value: object.content.length + " chars" },
          { key: "Registered", value: object.registeredAt },
        ],
      },
      { type: "code", title: "Source", source: object.content, language: lang, editEntity: { category: "template", name: object.name } },
    ],
  };
}`,
  },
  {
    name: "asset",
    targetType: "asset",
    title: "Asset",
    source: `function asset(object: any) {
  const mime = object.mimeType || '';
  const children: any[] = [
    {
      type: "key-value",
      title: "Details",
      entries: [
        { key: "Name", value: object.name, mono: true },
        { key: "Type", value: mime, mono: true },
        { key: "Size", value: object.size + " bytes" },
        { key: "Registered", value: object.registeredAt },
      ],
    },
  ];

  if (mime.startsWith('image/')) {
    children.push({ type: "image", title: "Preview", src: "/api/assets/" + encodeURIComponent(object.name), alt: object.name });
  } else if (
    mime.startsWith('text/') ||
    mime === 'application/json' ||
    mime === 'application/javascript' ||
    mime === 'application/xml' ||
    mime === 'application/yaml' ||
    mime === 'application/svg+xml'
  ) {
    const content = kernel.getAssetContent(object.name);
    if (content !== null) {
      const langMap: Record<string, string> = {
        'text/html': 'html',
        'text/css': 'css',
        'text/javascript': 'javascript',
        'text/markdown': 'markdown',
        'text/xml': 'xml',
        'text/yaml': 'yaml',
        'text/plain': 'plaintext',
        'application/json': 'json',
        'application/javascript': 'javascript',
        'application/xml': 'xml',
        'application/yaml': 'yaml',
        'application/svg+xml': 'xml',
      };
      const lang = langMap[mime] || 'plaintext';
      children.push({ type: "code", title: "Content", source: content, language: lang });
    }
  }

  return { type: "stack", children };
}`,
  },
  {
    name: "type",
    targetType: "type",
    title: "Type",
    source: `function type(object: any) {
  var devViews = kernel.listDevViews().filter(function(v: any) {
    return !v.builtIn && v.targetType === object.name;
  });
  var detailEntries: any[] = [
    { key: "Name", value: object.name, mono: true },
    ...(object.description ? [{ key: "Description", value: object.description }] : []),
    { key: "Fields", value: String(object.fields.length) },
  ];
  if (devViews.length > 0) {
    detailEntries.push({ key: "Dev View", value: devViews[0].name, mono: true, link: { category: "dev_view", key: devViews[0].name } });
  }
  detailEntries.push({ key: "Registered", value: object.registeredAt });

  const children: any[] = [
    { type: "key-value", title: "Details", entries: detailEntries },
    {
      type: "table",
      title: "Fields",
      columns: ["Name", "Type", "Optional", "Description"],
      rows: object.fields.map(function(f: any) {
        return [f.name, f.type, f.optional ? "Yes" : "", f.description || ""];
      }),
    },
  ];

  var fns = kernel.listFunctions().filter(function(f: any) {
    return f.returnType === object.name || f.returnType === object.name + "[]";
  });
  if (fns.length > 0) {
    children.push({
      type: "table",
      title: "Functions returning this type",
      columns: ["Name", "Return Type"],
      rows: fns.map(function(f: any) { return [f.name, f.returnType]; }),
      rowLinks: fns.map(function(f: any) { return { category: "function", key: f.name }; }),
    });
  }

  return { type: "stack", children };
}`,
  },
  {
    name: "dev_view",
    targetType: "dev_view",
    title: "Dev View",
    source: `function dev_view(object: any) {
  var types = kernel.listTypes();
  var linkedType = types.find(function(t: any) { return t.name === object.targetType; });
  var entries: any[] = [
    { key: "Name", value: object.name, mono: true },
  ];
  if (linkedType) {
    entries.push({ key: "Type", value: object.targetType, mono: true, link: { category: "type", key: object.targetType } });
  } else {
    entries.push({ key: "Target", value: object.targetType, mono: true });
  }
  entries.push({ key: "Title", value: object.title });
  entries.push({ key: "Built-in", value: object.builtIn ? "Yes" : "No" });
  entries.push({ key: "Registered", value: object.registeredAt });

  const children: any[] = [
    { type: "key-value", title: "Details", entries: entries },
  ];
  const source = kernel.getDevViewSource(object.name);
  if (source) {
    var codeBlock: any = { type: "code", title: "Source", source: source, language: "typescript" };
    if (!object.builtIn) codeBlock.editEntity = { category: "dev_view", name: object.name };
    children.push(codeBlock);
  }
  return { type: "stack", children };
}`,
  },
];

export async function registerDefaultViews(kernel: Kernel): Promise<void> {
  const deps = await kernel.compileDeps();
  const inspect = kernelInspectAPI(kernel);

  for (const view of DEFAULT_VIEWS) {
    const result = await compileDevView(view.name, view.source, deps, inspect);
    if (result.ok) {
      kernel.devViews.register(
        view.name,
        view.targetType,
        view.title,
        view.source,
        result.data,
        true,
      );
    } else {
      console.error(
        `Failed to compile default dev view "${view.name}":`,
        result.error?.message,
      );
    }
  }
}
