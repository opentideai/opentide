---
topic: view-descriptors
title: ViewDescriptor Type Reference
related: dev-views, dev-tools
---

# ViewDescriptor Type Reference

ViewDescriptors define how data is rendered in dev views and dev tool output.
There are 7 types that can be nested via `stack`.

## Union Type

```typescript
export type ViewDescriptor =
  | ViewTable
  | ViewCode
  | ViewKeyValue
  | ViewMarkdown
  | ViewTree
  | ViewStack
  | ViewImage;
```

## Types

### stack — Vertical layout container

```typescript
export interface ViewStack {
  type: "stack";
  children: ViewDescriptor[];
  gap?: number;
}
```

Use as the root element to compose multiple views. Children can be any
ViewDescriptor.

### table — Tabular data

```typescript
export interface ViewTable {
  type: "table";
  title?: string;
  columns: string[];
  rows: unknown[][];
}
```

`columns` is an array of header strings. Each row is an array of values aligned
to columns.

### code — Source code with syntax highlighting

```typescript
export interface ViewCode {
  type: "code";
  title?: string;
  source: string;
  language?: string;
}
```

Common `language` values: `"typescript"`, `"sql"`, `"html"`, `"css"`, `"json"`.

### key-value — Labeled pairs

```typescript
export interface ViewKeyValue {
  type: "key-value";
  title?: string;
  entries: Array<{ key: string; value: string; mono?: boolean }>;
}
```

Set `mono: true` for monospace value rendering (useful for IDs, paths, code
snippets).

### markdown — Rendered markdown content

```typescript
export interface ViewMarkdown {
  type: "markdown";
  content: string;
}
```

### tree — Collapsible JSON tree

```typescript
export interface ViewTree {
  type: "tree";
  title?: string;
  data: unknown;
}
```

`data` can be any JSON-serializable value. Renders as an interactive,
collapsible tree.

### image — Inline image

```typescript
export interface ViewImage {
  type: "image";
  title?: string;
  src: string;
  alt?: string;
}
```

`src` can be a URL or a data URI. Use `alt` for accessibility.

## Composition Pattern

Use `stack` as the root to combine multiple descriptors:

```typescript
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
```
