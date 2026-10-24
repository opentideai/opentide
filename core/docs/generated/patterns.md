---
topic: patterns
title: Patterns & Recipes
related: dev-views, dev-tools, view-descriptors, closure-apis
---

# Patterns & Recipes

Common patterns for building dev views and dev tools.

## Dev View: Schema Data Browser

Shows column metadata and a sample of rows for any database table.

```typescript
async function schemaDataBrowser(object: any) {
  const { tableName, columns } = object;
  const rows = await db.query("SELECT * FROM " + tableName + " LIMIT 25");
  const cols = rows.length > 0
    ? Object.keys(rows[0])
    : columns.map((c: any) => c.name);
  return {
    type: "stack",
    children: [
      {
        type: "table",
        title: "Columns",
        columns: ["Name", "Type", "PK", "Nullable"],
        rows: columns.map((
          c: any,
        ) => [
          c.name,
          c.type,
          c.primaryKey ? "YES" : "",
          c.nullable ? "YES" : "",
        ]),
      },
      rows.length > 0
        ? {
          type: "table",
          title: "Data (" + rows.length + " rows)",
          columns: cols,
          rows: rows.map((r: any) => cols.map((c) => r[c])),
        }
        : { type: "markdown", content: "*Table is empty.*" },
    ],
  };
}
```

Register:
`define_dev_view({ name: "schemaDataBrowser", targetType: "schema", title: "Data Browser", source: "..." })`

## Dev Tool: SQL Query Runner

Execute arbitrary SQL with formatted table output.

```typescript
async function runQuery(sql: string) {
  const rows = await db.query(sql);
  if (rows.length === 0) {
    return {
      __view: { type: "markdown", content: "*Query returned no rows.*" },
    };
  }
  const cols = Object.keys(rows[0]);
  return {
    __view: {
      type: "table",
      title: "Results (" + rows.length + " rows)",
      columns: cols,
      rows: rows.map((r: any) => cols.map((c) => r[c])),
    },
    data: rows,
  };
}
```

Register with args:
`[{ name: "sql", type: "string", description: "SQL query", required: true }]`

## Dev View: Handler Dependency Map

Shows which functions and templates a handler references.

```typescript
function handlerDeps(object: any) {
  const src = object.source;
  const fnCalls = [...src.matchAll(/functions\.(?:get|call)\("([^"]+)"/g)].map(
    (m) => m[1],
  );
  const tmplRefs = [...src.matchAll(/templates\.get\("([^"]+)"/g)].map((m) =>
    m[1]
  );
  const stateRefs = [...src.matchAll(/state\.(?:get|set)\("([^"]+)"/g)].map(
    (m) => m[1],
  );
  return {
    type: "stack",
    children: [
      {
        type: "key-value",
        title: "Dependencies",
        entries: [
          {
            key: "Functions",
            value: fnCalls.length > 0 ? fnCalls.join(", ") : "none",
            mono: true,
          },
          {
            key: "Templates",
            value: tmplRefs.length > 0 ? tmplRefs.join(", ") : "none",
            mono: true,
          },
          {
            key: "State keys",
            value: stateRefs.length > 0 ? stateRefs.join(", ") : "none",
            mono: true,
          },
        ],
      },
      {
        type: "code",
        title: "Source",
        source: object.source,
        language: "typescript",
      },
    ],
  };
}
```

Register:
`define_dev_view({ name: "handlerDeps", targetType: "handler", title: "Dependencies", source: "..." })`

## Dev Tool: Health Check Dashboard

Inspect routes, schemas, and recent errors at a glance. (Requires a dev view
since it uses `kernel`.)

Better as a **dev view** with `targetType: "state"` targeting a status state
key, since it needs `kernel`:

```typescript
async function healthCheck(object: any) {
  const routes = kernel.listRoutes();
  const handlers = kernel.listHandlers();
  const fns = kernel.listFunctions();
  const schemas = await kernel.listSchemas();
  return {
    type: "stack",
    children: [
      {
        type: "key-value",
        title: "App Status",
        entries: [
          { key: "Routes", value: String(routes.length) },
          { key: "Handlers", value: String(handlers.length) },
          { key: "Functions", value: String(fns.length) },
          { key: "Tables", value: String(schemas.length) },
        ],
      },
      {
        type: "table",
        title: "Routes",
        columns: ["Method", "Path", "Handler", "Module"],
        rows: routes.map(
          (r) => [r.method, r.path, r.handlerName, r.module || ""],
        ),
      },
    ],
  };
}
```

## Dev Tool vs Dev View — When to Use Which

| Need                                                             | Use      | Why                                           |
| ---------------------------------------------------------------- | -------- | --------------------------------------------- |
| Inspect a specific sidebar item with custom rendering            | Dev view | Views are triggered by clicking items         |
| Run a standalone operation with user-provided arguments          | Dev tool | Tools have input forms and are user-triggered |
| Need read-only access to all registries (routes, handlers, etc.) | Dev view | Only views get the `kernel` inspector         |
| Need to combine multiple views for a specific item type          | Dev view | Views compose naturally with `stack`          |
| Reusable utility the agent should also call programmatically     | Dev tool | Agent can use `call_dev_tool`                 |
