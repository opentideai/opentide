---
topic: kernel-inspector
title: Kernel Inspector API Reference
related: dev-views, closure-apis
---

# Kernel Inspector API Reference

The `kernel` object is a read-only registry inspector available **only in dev
views** (not in handlers, functions, or dev tools). It lets dev views inspect
the full state of the kernel.

## Type Definition

```typescript
export interface KernelInspectAPI {
  listRoutes(): RouteEntry[];
  listHandlers(): Array<{ name: string; source: string; registeredAt: string }>;
  listFunctions(): Array<
    { name: string; source: string; registeredAt: string; returnType?: string }
  >;
  listConfigs(): Array<
    {
      name: string;
      type: string;
      description?: string;
      updatedAt: string;
      module?: string;
    }
  >;
  listSchemas(): Promise<SchemaEntry[]>;
  listTypes(): Array<
    {
      name: string;
      fields: TypeFieldDef[];
      description?: string;
      registeredAt: string;
    }
  >;
  listDevViews(): Array<
    { name: string; targetType: string; title: string; builtIn: boolean }
  >;
  getAssetContent(name: string): string | null;
  getDevViewSource(name: string): string | null;
}
```

## Methods

### kernel.listRoutes()

Returns all registered routes:
`{ method, path, handlerName, schema?, registeredAt, module? }[]`

### kernel.listHandlers()

Returns all handlers: `{ name, source, registeredAt }[]`

### kernel.listFunctions()

Returns all functions: `{ name, source, registeredAt }[]`

### kernel.listConfigs()

Returns all config entries: `{ name, type, description?, updatedAt, module? }[]`

### kernel.listSchemas()

Returns all database schemas: `Promise<{ tableName, columns }[]>` **Note:** This
is async — you must `await` it.

### kernel.getAssetContent(name)

Returns the text content of an asset, or `null` if not found.

### kernel.getDevViewSource(name)

Returns the source code of a dev view, or `null` if not found.

## Example: Route overview dev view

```typescript
async function routeOverview(object: any) {
  const routes = kernel.listRoutes();
  const handlers = kernel.listHandlers();
  return {
    type: "stack",
    children: [
      {
        type: "key-value",
        title: "Summary",
        entries: [
          { key: "Routes", value: String(routes.length) },
          { key: "Handlers", value: String(handlers.length) },
        ],
      },
      {
        type: "table",
        title: "Routes",
        columns: ["Method", "Path", "Handler"],
        rows: routes.map((r) => [r.method, r.path, r.handlerName]),
      },
    ],
  };
}
```
