---
topic: dev-views
title: Dev View Authoring Reference
related: view-descriptors, closure-apis, kernel-inspector
---

# Dev View Authoring Reference

Dev views are custom inspector panels. When a user clicks an item in the sidebar
(a handler, schema, route, etc.), the matching dev view renders it. You can
create dev views for any target type, including custom ones like
`dev_tool:<toolName>` for tool output tabs.

## Function Signature

```typescript
// The function name MUST match the `name` parameter in define_dev_view
async function myView(object: any): Promise<ViewDescriptor> {
  // object contains the inspected entity's fields
  return { type: "stack", children: [] };
}
```

## Closure Context

Dev view functions have access to these variables (injected at compile time):

```
db, functions, config, templates, packages, env, log, kernel
```

- `db` — Database access (Drizzle ORM + raw SQL). See `closure-apis` topic.
- `functions` — Call registered functions. See `closure-apis` topic.
- `config` — Read app configuration constants. See `closure-apis` topic.
- `templates` — Read registered templates. See `closure-apis` topic.
- `packages` — Access installed npm packages via `packages.lodash`, etc.
- `env` — Read environment variables and secrets via `env.MY_KEY`.
- `kernel` — **Dev views only.** Read-only registry inspector. See
  `kernel-inspector` topic.

## Target Types

The `targetType` parameter determines which sidebar category triggers the view:

| targetType            | object shape                                                             |
| --------------------- | ------------------------------------------------------------------------ |
| `handler`             | `{ name, source, registeredAt, module? }`                                |
| `function`            | `{ name, source, registeredAt, module? }`                                |
| `route`               | `{ method, path, handlerName, schema?, registeredAt, module? }`          |
| `schema`              | `{ tableName, columns: [{name, type, primaryKey, nullable, default?}] }` |
| `config`              | `{ name, value, description?, updatedAt, module? }`                      |
| `template`            | `{ name, content, registeredAt, module? }`                               |
| `asset`               | `{ name, mimeType, size, registeredAt, module? }`                        |
| `error`               | `{ timestamp, level, message, stack?, route? }`                          |
| `request`             | `{ timestamp, method, path, status, durationMs }`                        |
| `dev_tool:<toolName>` | The tool's return value — use this to add custom output tabs             |

## Type Definition

```typescript
export interface DevViewEntry {
  name: string;
  targetType: string;
  title: string;
  source: string;
  fn: DevViewFn;
  builtIn: boolean;
  registeredAt: string;
  module?: string;
  runtimeId?: string;
  language?: string;
  // Stable identity — see HandlerEntry.entityUid (Stream A / A2).
  entityUid: string;
}

export type DevViewFn = (
  object: unknown,
) => ViewDescriptor | Promise<ViewDescriptor>;
```

## Registration

```
define_dev_view({
  name: "myView",          // must match function name
  targetType: "schema",    // which sidebar category
  title: "My View",        // tab label in the inspector
  source: "...",           // TypeScript source code
  module: "analytics"      // optional module grouping
})
```

## Rules

- The function name must match the `name` parameter
- Functions can be async
- Return a ViewDescriptor (see `view-descriptors` topic)
- User-defined views appear as tabs alongside built-in views
- Built-in views cannot be removed; user views override them when they share a
  targetType
