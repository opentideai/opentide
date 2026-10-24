/**
 * Docs generator — reads kernel source files and produces markdown reference docs.
 * Run: deno task docs:generate
 */

const KERNEL_DIR = new URL("../", import.meta.url).pathname;
const OUT_DIR = new URL("./generated/", import.meta.url).pathname;

function readSource(relativePath: string): string {
  return Deno.readTextFileSync(KERNEL_DIR + relativePath);
}

function extractInterface(source: string, name: string): string {
  const lines = source.split("\n");
  const startIdx = lines.findIndex((l) =>
    l.match(new RegExp(`^export (?:interface|type) ${name}[\\s<{=]`))
  );
  if (startIdx === -1) return `// ${name} not found`;

  // startIdx !== -1 above, so this element exists; noUncheckedIndexedAccess can't
  // see that, and the `?? ""` costs nothing because "" matches none of the branches.
  const startLine = lines[startIdx] ?? "";
  // Single-line type alias (ends with ;)
  if (startLine.includes("=") && startLine.trimEnd().endsWith(";")) {
    return startLine;
  }

  // Multi-line type alias or union
  if (startLine.includes("=") && !startLine.includes("{")) {
    let end = startIdx;
    for (let i = startIdx; i < lines.length; i++) {
      if ((lines[i] ?? "").trimEnd().endsWith(";")) {
        end = i;
        break;
      }
    }
    return lines.slice(startIdx, end + 1).join("\n");
  }

  // Interface or type with braces — find matching closing brace
  let depth = 0;
  let endIdx = startIdx;
  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i] ?? "";
    for (const ch of line) {
      if (ch === "{") depth++;
      if (ch === "}") depth--;
    }
    if (depth === 0 && i > startIdx) {
      endIdx = i;
      break;
    }
    if (depth === 0 && line.includes("{") && line.includes("}")) {
      endIdx = i;
      break;
    }
  }
  return lines.slice(startIdx, endIdx + 1).join("\n");
}

function extractInterfaces(source: string, names: string[]): string {
  return names.map((n) => extractInterface(source, n)).join("\n\n");
}

function extractClosureParams(source: string, fnName: string): string[] {
  const fnPattern = new RegExp(
    `export async function ${fnName}[\\s\\S]*?new Function\\(([^)]+)\\)`,
  );
  const params = source.match(fnPattern)?.[1];
  if (!params) return [];
  return params
    .split(",")
    .map((s) => s.trim().replace(/^"|"$/g, ""))
    .filter((s) =>
      !s.includes("use strict") && !s.includes("sourceURL") && s.length > 0
    );
}

function writeTopic(
  filename: string,
  frontmatter: Record<string, string>,
  content: string,
): void {
  const fm = Object.entries(frontmatter)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
  Deno.writeTextFileSync(
    `${OUT_DIR}${filename}`,
    `---\n${fm}\n---\n\n${content}\n`,
  );
}

// --- Read sources ---

const types = readSource("types.ts");
const compiler = readSource("compiler.ts");
const handlerDb = readSource("handler-db.ts");

// --- Extract ---

const devViewClosureParams = extractClosureParams(compiler, "compileDevView");
const devToolClosureParams = extractClosureParams(compiler, "compileDevTool");

const drizzleOperators = handlerDb
  .match(/import \{([^}]+)\} from "drizzle-orm"/s)?.[1]
  ?.split(",")
  .map((s) => s.trim())
  .filter(Boolean) ?? [];

// --- Generate topics ---

writeTopic(
  "dev-views.md",
  {
    topic: "dev-views",
    title: "Dev View Authoring Reference",
    related: "view-descriptors, closure-apis, kernel-inspector",
  },
  `# Dev View Authoring Reference

Dev views are custom inspector panels. When a user clicks an item in the sidebar (a handler, schema, route, etc.), the matching dev view renders it. You can create dev views for any target type, including custom ones like \`dev_tool:<toolName>\` for tool output tabs.

## Function Signature

\`\`\`typescript
// The function name MUST match the \`name\` parameter in define_dev_view
async function myView(object: any): Promise<ViewDescriptor> {
  // object contains the inspected entity's fields
  return { type: "stack", children: [] };
}
\`\`\`

## Closure Context

Dev view functions have access to these variables (injected at compile time):

\`\`\`
${devViewClosureParams.join(", ")}
\`\`\`

- \`db\` — Database access (Drizzle ORM + raw SQL). See \`closure-apis\` topic.
- \`functions\` — Call registered functions. See \`closure-apis\` topic.
- \`config\` — Read app configuration constants. See \`closure-apis\` topic.
- \`templates\` — Read registered templates. See \`closure-apis\` topic.
- \`packages\` — Access installed npm packages via \`packages.lodash\`, etc.
- \`env\` — Read environment variables and secrets via \`env.MY_KEY\`.
- \`kernel\` — **Dev views only.** Read-only registry inspector. See \`kernel-inspector\` topic.

## Target Types

The \`targetType\` parameter determines which sidebar category triggers the view:

| targetType | object shape |
|---|---|
| \`handler\` | \`{ name, source, registeredAt, module? }\` |
| \`function\` | \`{ name, source, registeredAt, module? }\` |
| \`route\` | \`{ method, path, handlerName, schema?, registeredAt, module? }\` |
| \`schema\` | \`{ tableName, columns: [{name, type, primaryKey, nullable, default?}] }\` |
| \`config\` | \`{ name, value, description?, updatedAt, module? }\` |
| \`template\` | \`{ name, content, registeredAt, module? }\` |
| \`asset\` | \`{ name, mimeType, size, registeredAt, module? }\` |
| \`error\` | \`{ timestamp, level, message, stack?, route? }\` |
| \`request\` | \`{ timestamp, method, path, status, durationMs }\` |
| \`dev_tool:<toolName>\` | The tool's return value — use this to add custom output tabs |

## Type Definition

\`\`\`typescript
${extractInterfaces(types, ["DevViewEntry", "DevViewFn"])}
\`\`\`

## Registration

\`\`\`
define_dev_view({
  name: "myView",          // must match function name
  targetType: "schema",    // which sidebar category
  title: "My View",        // tab label in the inspector
  source: "...",           // TypeScript source code
  module: "analytics"      // optional module grouping
})
\`\`\`

## Rules

- The function name must match the \`name\` parameter
- Functions can be async
- Return a ViewDescriptor (see \`view-descriptors\` topic)
- User-defined views appear as tabs alongside built-in views
- Built-in views cannot be removed; user views override them when they share a targetType`,
);

writeTopic(
  "dev-tools.md",
  {
    topic: "dev-tools",
    title: "Dev Tool Authoring Reference",
    related: "view-descriptors, closure-apis, compilation",
  },
  `# Dev Tool Authoring Reference

Dev tools are reusable functions with named arguments that appear in the Tools panel. Users execute them on demand via a form, and the agent can call them with \`call_dev_tool\`.

## Function Signature

\`\`\`typescript
// The function name MUST match the \`name\` parameter in define_dev_tool
// Arguments are positional, matching the \`args\` array order
async function analyzeTable(tableName: string, limit: number) {
  const rows = await db.query(\`SELECT * FROM \${tableName} LIMIT \${limit}\`);
  return { __view: { type: "table", columns: Object.keys(rows[0] || {}), rows: rows.map(r => Object.values(r)) }, data: rows };
}
\`\`\`

## Closure Context

Dev tool functions have access to these variables:

\`\`\`
${devToolClosureParams.join(", ")}
\`\`\`

Note: dev tools do NOT have access to \`kernel\` (the read-only inspector). Use a dev view if you need registry inspection.

## Args Schema

The \`args\` array defines the input form. Each arg becomes a form field in the Tools panel:

\`\`\`typescript
${extractInterface(types, "DevToolArgDef")}
\`\`\`

Supported \`type\` values: \`"string"\`, \`"number"\`, \`"boolean"\`, \`"object"\`.

## Output Rendering

A tool can return anything:

1. **Raw data** — rendered as a JSON tree in the output panel
2. **Custom view** — return \`{ __view: ViewDescriptor, data?: any }\` for rich rendering
3. **Custom output tabs** — register a dev view with \`targetType: "dev_tool:<toolName>"\`

## Type Definition

\`\`\`typescript
${extractInterfaces(types, ["DevToolEntry", "DevToolFn"])}
\`\`\`

## Registration

\`\`\`
define_dev_tool({
  name: "analyzeTable",
  description: "Analyze a database table",
  args: [
    { name: "tableName", type: "string", description: "Table to analyze", required: true },
    { name: "limit", type: "number", description: "Max rows to inspect", required: false }
  ],
  source: "...",
  module: "analytics"
})
\`\`\`

## Constraints

- 30-second execution timeout
- Function name must match the \`name\` parameter
- Functions can be async
- Arguments are passed positionally matching the args array order
- The agent can invoke tools with \`call_dev_tool({ name: "...", args: {...} })\``,
);

writeTopic(
  "view-descriptors.md",
  {
    topic: "view-descriptors",
    title: "ViewDescriptor Type Reference",
    related: "dev-views, dev-tools",
  },
  `# ViewDescriptor Type Reference

ViewDescriptors define how data is rendered in dev views and dev tool output. There are 7 types that can be nested via \`stack\`.

## Union Type

\`\`\`typescript
${extractInterface(types, "ViewDescriptor")}
\`\`\`

## Types

### stack — Vertical layout container

\`\`\`typescript
${extractInterface(types, "ViewStack")}
\`\`\`

Use as the root element to compose multiple views. Children can be any ViewDescriptor.

### table — Tabular data

\`\`\`typescript
${extractInterface(types, "ViewTable")}
\`\`\`

\`columns\` is an array of header strings. Each row is an array of values aligned to columns.

### code — Source code with syntax highlighting

\`\`\`typescript
${extractInterface(types, "ViewCode")}
\`\`\`

Common \`language\` values: \`"typescript"\`, \`"sql"\`, \`"html"\`, \`"css"\`, \`"json"\`.

### key-value — Labeled pairs

\`\`\`typescript
${extractInterface(types, "ViewKeyValue")}
\`\`\`

Set \`mono: true\` for monospace value rendering (useful for IDs, paths, code snippets).

### markdown — Rendered markdown content

\`\`\`typescript
${extractInterface(types, "ViewMarkdown")}
\`\`\`

### tree — Collapsible JSON tree

\`\`\`typescript
${extractInterface(types, "ViewTree")}
\`\`\`

\`data\` can be any JSON-serializable value. Renders as an interactive, collapsible tree.

### image — Inline image

\`\`\`typescript
${extractInterface(types, "ViewImage")}
\`\`\`

\`src\` can be a URL or a data URI. Use \`alt\` for accessibility.

## Composition Pattern

Use \`stack\` as the root to combine multiple descriptors:

\`\`\`typescript
return {
  type: "stack",
  children: [
    { type: "key-value", title: "Summary", entries: [...] },
    { type: "table", title: "Data", columns: [...], rows: [...] },
    rows.length === 0
      ? { type: "markdown", content: "*No data yet.*" }
      : { type: "code", title: "Sample JSON", source: JSON.stringify(rows[0], null, 2), language: "json" },
  ],
};
\`\`\``,
);

writeTopic(
  "closure-apis.md",
  {
    topic: "closure-apis",
    title: "Closure API Reference",
    related: "dev-views, dev-tools, kernel-inspector",
  },
  `# Closure API Reference

Handlers, functions, dev views, and dev tools all receive closure variables injected at compile time. This is the complete API surface for each.

## db — Database Access

The \`db\` object combines Drizzle ORM query builder methods with raw SQL access.

### Type Definition

\`\`\`typescript
${extractInterface(types, "DbInterface")}
\`\`\`

### Drizzle Query Builder

\`\`\`typescript
db.select().from(db.tables.users).where(db.eq(db.tables.users.email, "a@b.com"))
db.insert(db.tables.users).values({ name: "Alice", email: "a@b.com" })
db.update(db.tables.users).set({ name: "Bob" }).where(db.eq(db.tables.users.id, 1))
db.delete(db.tables.users).where(db.eq(db.tables.users.id, 1))
\`\`\`

### db.tables

\`db.tables\` returns an object keyed by table name containing Drizzle table schemas. Access columns as \`db.tables.<tableName>.<columnName>\`.

### Raw SQL

\`\`\`typescript
const rows = await db.query("SELECT * FROM users WHERE id = $1", [userId]);
const result = await db.execute("DELETE FROM users WHERE id = $1", [userId]);
// result.changes = number of affected rows
\`\`\`

### Available Operators

All Drizzle operators are available directly on \`db\`:

\`\`\`
${drizzleOperators.join(", ")}
\`\`\`

**Comparison**: \`eq\`, \`ne\`, \`gt\`, \`gte\`, \`lt\`, \`lte\`, \`between\`
**Logical**: \`and\`, \`or\`, \`not\`
**Pattern**: \`like\`, \`ilike\`, \`notLike\`, \`notIlike\`
**Set**: \`inArray\`, \`notInArray\`, \`exists\`, \`notExists\`
**Null**: \`isNull\`, \`isNotNull\`
**Aggregate**: \`count\`, \`sum\`, \`avg\`, \`min\`, \`max\`
**Sort**: \`asc\`, \`desc\`
**Raw**: \`sql\` tagged template for raw SQL fragments within Drizzle queries

## functions — Function Registry

\`\`\`typescript
${extractInterface(types, "FunctionRegistry")}
\`\`\`

- \`functions.get(name)\` — returns the function or \`undefined\`
- \`functions.call(name, ...args)\` — calls the function, throws if not found

## config — App Configuration

\`\`\`typescript
${extractInterface(types, "ConfigRegistry")}
\`\`\`

- \`config.get(name)\` — returns the config value or \`undefined\`

Set configs via the \`set_config\` tool. Use for app constants like retry counts, page sizes, rate limits, and feature flags.

## templates — Template Registry

\`\`\`typescript
${extractInterface(types, "TemplateRegistry")}
\`\`\`

- \`templates.get(name)\` — returns the template string content or \`undefined\`

## packages — Installed NPM Packages

Access installed npm packages as properties:

\`\`\`typescript
const _ = packages.lodash;
const dayjs = packages.dayjs;
\`\`\`

Packages must be installed via \`install_package\` first. Access triggers a dynamic import.

## env — Environment Variables & Secrets

\`\`\`typescript
const apiKey = env.OPENAI_API_KEY;
const dbUrl = env.DATABASE_URL;
\`\`\`

Merged from: environment variables, \`define_env_var\` values, and \`define_secret\` values (secrets take priority).`,
);

writeTopic(
  "kernel-inspector.md",
  {
    topic: "kernel-inspector",
    title: "Kernel Inspector API Reference",
    related: "dev-views, closure-apis",
  },
  `# Kernel Inspector API Reference

The \`kernel\` object is a read-only registry inspector available **only in dev views** (not in handlers, functions, or dev tools). It lets dev views inspect the full state of the kernel.

## Type Definition

\`\`\`typescript
${extractInterface(types, "KernelInspectAPI")}
\`\`\`

## Methods

### kernel.listRoutes()
Returns all registered routes: \`{ method, path, handlerName, schema?, registeredAt, module? }[]\`

### kernel.listHandlers()
Returns all handlers: \`{ name, source, registeredAt }[]\`

### kernel.listFunctions()
Returns all functions: \`{ name, source, registeredAt }[]\`

### kernel.listConfigs()
Returns all config entries: \`{ name, type, description?, updatedAt, module? }[]\`

### kernel.listSchemas()
Returns all database schemas: \`Promise<{ tableName, columns }[]>\`
**Note:** This is async — you must \`await\` it.

### kernel.getAssetContent(name)
Returns the text content of an asset, or \`null\` if not found.

### kernel.getDevViewSource(name)
Returns the source code of a dev view, or \`null\` if not found.

## Example: Route overview dev view

\`\`\`typescript
async function routeOverview(object: any) {
  const routes = kernel.listRoutes();
  const handlers = kernel.listHandlers();
  return {
    type: "stack",
    children: [
      { type: "key-value", title: "Summary", entries: [
        { key: "Routes", value: String(routes.length) },
        { key: "Handlers", value: String(handlers.length) },
      ]},
      { type: "table", title: "Routes", columns: ["Method", "Path", "Handler"],
        rows: routes.map(r => [r.method, r.path, r.handlerName]) },
    ],
  };
}
\`\`\``,
);

writeTopic(
  "compilation.md",
  {
    topic: "compilation",
    title: "Compilation Pipeline Reference",
    related: "dev-views, dev-tools, closure-apis",
  },
  `# Compilation Pipeline Reference

All user-defined code (handlers, functions, dev views, dev tools, tests) goes through the same compilation pipeline before being registered.

## Pipeline

1. **TypeScript → JavaScript**: Source is transformed via esbuild (\`loader: "ts", target: "esnext"\`)
2. **Function constructor**: The JS is wrapped in \`new Function(closureParams..., code)\` with dependencies injected
3. **Name check**: The code must define and return a function whose name matches the registered name
4. **QC checks**: Quality control runs on the source before persisting (lint, unused vars, dangerous patterns)

## Handler ABI

A route handler is a plain fetch-style function: a web-standard \`Request\` in, a web-standard \`Response\` out. The second argument carries what the kernel matched out of the route pattern.

\`\`\`typescript
async function getTodo(req: Request, ctx: HandlerContext): Promise<Response> {
  const rows = await db.query("SELECT * FROM todos WHERE id = $1", [ctx.params.id]);
  return rows.length ? Response.json(rows[0]) : new Response("Not found", { status: 404 });
}
\`\`\`

- \`ctx.params\` — path parameters as strings, keyed by the names in the route pattern (\`/todos/:id\` gives \`ctx.params.id\`).
- Read the request with the standard methods: \`await req.json()\`, \`await req.text()\`, \`await req.formData()\`, \`req.headers.get(name)\`, and \`new URL(req.url).searchParams\` for the query string.
- Reply with \`Response.json(data, { status: 201 })\`, \`new Response(html, { headers: { "content-type": "text/html" } })\`, or any \`Response\` you construct.

No web framework is involved and none is needed — the kernel owns routing and nothing else. Any library you install via \`install_package\` is usable inside a handler; if that library is itself an HTTP framework, mount it from one catch-all route and hand it the request with \`return app.fetch(req)\`.

Handlers written against the older framework-context signature — \`function h(c) { return c.json(...) }\` — keep running unchanged: the kernel detects the shape and adapts them. Write new handlers against the fetch ABI.

### Auth gate

Set the app config \`APP_AUTH_GATE\` to a handler's name and that handler sees every request that matches a route — the app's own routes and the platform's \`/_assets\` and OpenAPI routes — before anything else runs, schema validation included. It is never routed itself.

\`\`\`typescript
function authGate(
  req: Request,
  ctx: { params: Record<string, string>; route: { method: string; path: string } },
): Response | null {
  if (ctx.route.path === "/login") return null;
  if (req.headers.get("cookie")?.includes("session=")) return null;
  return Response.json({ error: "Sign in" }, { status: 401 });
}
\`\`\`

- Return \`null\` to let the request through, or a \`Response\` to answer it.
- \`ctx.route\` is the matched route's method and PATTERN (\`/s/:token\`, not \`/s/abc\`); \`ctx.params\` is what it matched.
- The gate's request has no body. Decide from the method, URL and headers.
- It fails closed: a throw, or an answer that is neither \`null\` nor a \`Response\`, is a 500. A config naming a handler that does not exist is a 500 on every request in the preview, and the export refuses to build.
- A request that matches no route is never gated; it gets the usual 404/405.
- With a gate set, responses no longer carry \`access-control-allow-origin: *\`, and an OPTIONS request with no OPTIONS route is a 404/405 rather than a CORS preflight.
- The export reads the config when it builds, so changing it takes a new export.

## Key Constraints

### No imports or exports
Code runs inside a \`new Function()\` constructor, not a module. You cannot use \`import\` or \`export\` statements. Instead:

- Use \`packages.<name>\` for npm packages (e.g., \`packages.lodash\`, \`packages.dayjs\`)
- All closure variables (\`db\`, \`functions\`, \`state\`, \`config\`, \`templates\`, \`packages\`, \`env\`) are pre-injected
- Tests also get \`appUrl(path)\` and \`getAppPort()\` so they can target the current live app preview port without hard-coding \`localhost:3001\`

### Function name must match
The source must define a function with exactly the name passed to the registration tool. The pipeline does \`return <name>\` after the code runs.

### Closure variables by entity type

| Entity | Closure variables |
|--------|------------------|
| Handler | \`db, functions, config, templates, packages, env, log, assertNever\` + \`(req, ctx)\` as arguments |
| Function | \`db, functions, config, templates, packages, env, log, assertNever\` |
| Dev View | \`${devViewClosureParams.join(", ")}\` |
| Dev Tool | \`${devToolClosureParams.join(", ")}\` |
| Test | \`db, functions, config, templates, packages, env, appUrl, getAppPort, log\` + assertion helpers |

### Async support
All entity types support async functions. Use \`async function name(...)\` freely.

### Available globals
Standard JavaScript globals are available: \`console\`, \`fetch\`, \`JSON\`, \`Date\`, \`Math\`, \`URL\`, \`URLSearchParams\`, \`setTimeout\`, \`Response\`, \`Headers\`, \`Request\`, \`TextEncoder\`, \`TextDecoder\`, etc.

## QC Checks

The quality control pipeline runs before code is persisted. It checks for:

- **Compilation errors** — TypeScript syntax errors (blocks registration)
- **Unused variables** — warnings for declared but unused identifiers
- **Dangerous patterns** — \`eval()\`, \`new Function()\` in user code (blocks registration)
- **Async without await** — warning if an async function never uses await
- **Empty catch blocks** — warning for swallowed errors
- **Console usage** — warning for \`console.log\` (use structured logging instead)

If QC finds blocking errors, registration is rejected. Fix the issues and retry.`,
);

writeTopic(
  "patterns.md",
  {
    topic: "patterns",
    title: "Patterns & Recipes",
    related: "dev-views, dev-tools, view-descriptors, closure-apis",
  },
  `# Patterns & Recipes

Common patterns for building dev views and dev tools.

## Dev View: Schema Data Browser

Shows column metadata and a sample of rows for any database table.

\`\`\`typescript
async function schemaDataBrowser(object: any) {
  const { tableName, columns } = object;
  const rows = await db.query("SELECT * FROM " + tableName + " LIMIT 25");
  const cols = rows.length > 0 ? Object.keys(rows[0]) : columns.map((c: any) => c.name);
  return {
    type: "stack",
    children: [
      {
        type: "table", title: "Columns",
        columns: ["Name", "Type", "PK", "Nullable"],
        rows: columns.map((c: any) => [c.name, c.type, c.primaryKey ? "YES" : "", c.nullable ? "YES" : ""]),
      },
      rows.length > 0
        ? { type: "table", title: "Data (" + rows.length + " rows)", columns: cols, rows: rows.map((r: any) => cols.map(c => r[c])) }
        : { type: "markdown", content: "*Table is empty.*" },
    ],
  };
}
\`\`\`

Register: \`define_dev_view({ name: "schemaDataBrowser", targetType: "schema", title: "Data Browser", source: "..." })\`

## Dev Tool: SQL Query Runner

Execute arbitrary SQL with formatted table output.

\`\`\`typescript
async function runQuery(sql: string) {
  const rows = await db.query(sql);
  if (rows.length === 0) return { __view: { type: "markdown", content: "*Query returned no rows.*" } };
  const cols = Object.keys(rows[0]);
  return {
    __view: { type: "table", title: "Results (" + rows.length + " rows)", columns: cols, rows: rows.map((r: any) => cols.map(c => r[c])) },
    data: rows,
  };
}
\`\`\`

Register with args: \`[{ name: "sql", type: "string", description: "SQL query", required: true }]\`

## Dev View: Handler Dependency Map

Shows which functions and templates a handler references.

\`\`\`typescript
function handlerDeps(object: any) {
  const src = object.source;
  const fnCalls = [...src.matchAll(/functions\\.(?:get|call)\\("([^"]+)"/g)].map(m => m[1]);
  const tmplRefs = [...src.matchAll(/templates\\.get\\("([^"]+)"/g)].map(m => m[1]);
  const stateRefs = [...src.matchAll(/state\\.(?:get|set)\\("([^"]+)"/g)].map(m => m[1]);
  return {
    type: "stack",
    children: [
      { type: "key-value", title: "Dependencies", entries: [
        { key: "Functions", value: fnCalls.length > 0 ? fnCalls.join(", ") : "none", mono: true },
        { key: "Templates", value: tmplRefs.length > 0 ? tmplRefs.join(", ") : "none", mono: true },
        { key: "State keys", value: stateRefs.length > 0 ? stateRefs.join(", ") : "none", mono: true },
      ]},
      { type: "code", title: "Source", source: object.source, language: "typescript" },
    ],
  };
}
\`\`\`

Register: \`define_dev_view({ name: "handlerDeps", targetType: "handler", title: "Dependencies", source: "..." })\`

## Dev Tool: Health Check Dashboard

Inspect routes, schemas, and recent errors at a glance. (Requires a dev view since it uses \`kernel\`.)

Better as a **dev view** with \`targetType: "state"\` targeting a status state key, since it needs \`kernel\`:

\`\`\`typescript
async function healthCheck(object: any) {
  const routes = kernel.listRoutes();
  const handlers = kernel.listHandlers();
  const fns = kernel.listFunctions();
  const schemas = await kernel.listSchemas();
  return {
    type: "stack",
    children: [
      { type: "key-value", title: "App Status", entries: [
        { key: "Routes", value: String(routes.length) },
        { key: "Handlers", value: String(handlers.length) },
        { key: "Functions", value: String(fns.length) },
        { key: "Tables", value: String(schemas.length) },
      ]},
      { type: "table", title: "Routes", columns: ["Method", "Path", "Handler", "Module"],
        rows: routes.map(r => [r.method, r.path, r.handlerName, r.module || ""]) },
    ],
  };
}
\`\`\`

## Dev Tool vs Dev View — When to Use Which

| Need | Use | Why |
|------|-----|-----|
| Inspect a specific sidebar item with custom rendering | Dev view | Views are triggered by clicking items |
| Run a standalone operation with user-provided arguments | Dev tool | Tools have input forms and are user-triggered |
| Need read-only access to all registries (routes, handlers, etc.) | Dev view | Only views get the \`kernel\` inspector |
| Need to combine multiple views for a specific item type | Dev view | Views compose naturally with \`stack\` |
| Reusable utility the agent should also call programmatically | Dev tool | Agent can use \`call_dev_tool\` |`,
);

console.log(`Generated ${7} topic files in ${OUT_DIR}`);
