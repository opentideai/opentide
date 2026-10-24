---
topic: closure-apis
title: Closure API Reference
related: dev-views, dev-tools, kernel-inspector
---

# Closure API Reference

Handlers, functions, dev views, and dev tools all receive closure variables
injected at compile time. This is the complete API surface for each.

## db — Database Access

The `db` object combines Drizzle ORM query builder methods with raw SQL access.

### Type Definition

```typescript
export interface DbInterface {
  query: (
    sql: string,
    params?: unknown[],
  ) => Promise<Record<string, unknown>[]>;
  execute: (sql: string, params?: unknown[]) => Promise<{ changes: number }>;
}
```

### Drizzle Query Builder

```typescript
db.select().from(db.tables.users).where(
  db.eq(db.tables.users.email, "a@b.com"),
);
db.insert(db.tables.users).values({ name: "Alice", email: "a@b.com" });
db.update(db.tables.users).set({ name: "Bob" }).where(
  db.eq(db.tables.users.id, 1),
);
db.delete(db.tables.users).where(db.eq(db.tables.users.id, 1));
```

### db.tables

`db.tables` returns an object keyed by table name containing Drizzle table
schemas. Access columns as `db.tables.<tableName>.<columnName>`.

### Raw SQL

```typescript
const rows = await db.query("SELECT * FROM users WHERE id = $1", [userId]);
const result = await db.execute("DELETE FROM users WHERE id = $1", [userId]);
// result.changes = number of affected rows
```

### Available Operators

All Drizzle operators are available directly on `db`:

```
and, asc, avg, between, count, desc, eq, exists, gt, gte, ilike, inArray, isNotNull, isNull, like, lt, lte, max, min, ne, not, notExists, notIlike, notInArray, notLike, or, sql, sum
```

**Comparison**: `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `between` **Logical**:
`and`, `or`, `not` **Pattern**: `like`, `ilike`, `notLike`, `notIlike` **Set**:
`inArray`, `notInArray`, `exists`, `notExists` **Null**: `isNull`, `isNotNull`
**Aggregate**: `count`, `sum`, `avg`, `min`, `max` **Sort**: `asc`, `desc`
**Raw**: `sql` tagged template for raw SQL fragments within Drizzle queries

## functions — Function Registry

```typescript
export interface FunctionRegistry {
  get: (name: string) => ((...args: unknown[]) => unknown) | undefined;
  call: (name: string, ...args: unknown[]) => unknown;
}
```

- `functions.get(name)` — returns the function or `undefined`
- `functions.call(name, ...args)` — calls the function, throws if not found

## config — App Configuration

```typescript
export interface ConfigRegistry {
  get: (name: string) => unknown;
}
```

- `config.get(name)` — returns the config value or `undefined`

Set configs via the `set_config` tool. Use for app constants like retry counts,
page sizes, rate limits, and feature flags.

## templates — Template Registry

```typescript
export interface TemplateRegistry {
  get: (name: string) => string | undefined;
}
```

- `templates.get(name)` — returns the template string content or `undefined`

## packages — Installed NPM Packages

Access installed npm packages as properties:

```typescript
const _ = packages.lodash;
const dayjs = packages.dayjs;
```

Packages must be installed via `install_package` first. Access triggers a
dynamic import.

## env — Environment Variables & Secrets

```typescript
const apiKey = env.OPENAI_API_KEY;
const dbUrl = env.DATABASE_URL;
```

Merged from: environment variables, `define_env_var` values, and `define_secret`
values (secrets take priority).
