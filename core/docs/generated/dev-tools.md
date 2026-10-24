---
topic: dev-tools
title: Dev Tool Authoring Reference
related: view-descriptors, closure-apis, compilation
---

# Dev Tool Authoring Reference

Dev tools are reusable functions with named arguments that appear in the Tools
panel. Users execute them on demand via a form, and the agent can call them with
`call_dev_tool`.

## Function Signature

```typescript
// The function name MUST match the `name` parameter in define_dev_tool
// Arguments are positional, matching the `args` array order
async function analyzeTable(tableName: string, limit: number) {
  const rows = await db.query(`SELECT * FROM ${tableName} LIMIT ${limit}`);
  return {
    __view: {
      type: "table",
      columns: Object.keys(rows[0] || {}),
      rows: rows.map((r) => Object.values(r)),
    },
    data: rows,
  };
}
```

## Closure Context

Dev tool functions have access to these variables:

```
db, functions, config, templates, packages, env, log
```

Note: dev tools do NOT have access to `kernel` (the read-only inspector). Use a
dev view if you need registry inspection.

## Args Schema

The `args` array defines the input form. Each arg becomes a form field in the
Tools panel:

```typescript
export interface DevToolArgDef {
  name: string;
  type: string;
  description: string;
  required: boolean;
}
```

Supported `type` values: `"string"`, `"number"`, `"boolean"`, `"object"`.

## Output Rendering

A tool can return anything:

1. **Raw data** — rendered as a JSON tree in the output panel
2. **Custom view** — return `{ __view: ViewDescriptor, data?: any }` for rich
   rendering
3. **Custom output tabs** — register a dev view with
   `targetType: "dev_tool:<toolName>"`

## Type Definition

```typescript
export interface DevToolEntry {
  name: string;
  description: string;
  args: DevToolArgDef[];
  source: string;
  fn: DevToolFn;
  registeredAt: string;
  module?: string;
  runtimeId?: string;
  language?: string;
  // Stable identity — see HandlerEntry.entityUid (Stream A / A2).
  entityUid: string;
}

export type DevToolFn = (...args: unknown[]) => unknown | Promise<unknown>;
```

## Registration

```
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
```

## Constraints

- 30-second execution timeout
- Function name must match the `name` parameter
- Functions can be async
- Arguments are passed positionally matching the args array order
- The agent can invoke tools with `call_dev_tool({ name: "...", args: {...} })`
