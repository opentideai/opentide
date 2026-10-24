---
topic: compilation
title: Compilation Pipeline Reference
related: dev-views, dev-tools, closure-apis
---

# Compilation Pipeline Reference

All user-defined code (handlers, functions, dev views, dev tools, tests) goes
through the same compilation pipeline before being registered.

## Pipeline

1. **TypeScript → JavaScript**: Source is transformed via esbuild
   (`loader: "ts", target: "esnext"`)
2. **Function constructor**: The JS is wrapped in
   `new Function(closureParams..., code)` with dependencies injected
3. **Name check**: The code must define and return a function whose name matches
   the registered name
4. **QC checks**: Quality control runs on the source before persisting (lint,
   unused vars, dangerous patterns)

## Handler ABI

A route handler is a plain fetch-style function: a web-standard `Request` in, a
web-standard `Response` out. The second argument carries what the kernel matched
out of the route pattern.

```typescript
async function getTodo(req: Request, ctx: HandlerContext): Promise<Response> {
  const rows = await db.query("SELECT * FROM todos WHERE id = $1", [
    ctx.params.id,
  ]);
  return rows.length
    ? Response.json(rows[0])
    : new Response("Not found", { status: 404 });
}
```

- `ctx.params` — path parameters as strings, keyed by the names in the route
  pattern (`/todos/:id` gives `ctx.params.id`).
- Read the request with the standard methods: `await req.json()`,
  `await req.text()`, `await req.formData()`, `req.headers.get(name)`, and
  `new URL(req.url).searchParams` for the query string.
- Reply with `Response.json(data, { status: 201 })`,
  `new Response(html, { headers: { "content-type": "text/html" } })`, or any
  `Response` you construct.

No web framework is involved and none is needed — the kernel owns routing and
nothing else. Any library you install via `install_package` is usable inside a
handler; if that library is itself an HTTP framework, mount it from one
catch-all route and hand it the request with `return app.fetch(req)`.

Handlers written against the older framework-context signature —
`function h(c) { return c.json(...) }` — keep running unchanged: the kernel
detects the shape and adapts them. Write new handlers against the fetch ABI.

### Auth gate

Set the app config `APP_AUTH_GATE` to a handler's name and that handler sees
every request that matches a route — the app's own routes and the platform's
`/_assets` and OpenAPI routes — before anything else runs, schema validation
included. It is never routed itself.

```typescript
function authGate(
  req: Request,
  ctx: {
    params: Record<string, string>;
    route: { method: string; path: string };
  },
): Response | null {
  if (ctx.route.path === "/login") return null;
  if (req.headers.get("cookie")?.includes("session=")) return null;
  return Response.json({ error: "Sign in" }, { status: 401 });
}
```

- Return `null` to let the request through, or a `Response` to answer it.
- `ctx.route` is the matched route's method and PATTERN (`/s/:token`, not
  `/s/abc`); `ctx.params` is what it matched.
- The gate's request has no body. Decide from the method, URL and headers.
- It fails closed: a throw, or an answer that is neither `null` nor a
  `Response`, is a 500. A config naming a handler that does not exist is a 500
  on every request in the preview, and the export refuses to build.
- A request that matches no route is never gated; it gets the usual 404/405.
- With a gate set, responses no longer carry `access-control-allow-origin: *`,
  and an OPTIONS request with no OPTIONS route is a 404/405 rather than a CORS
  preflight.
- The export reads the config when it builds, so changing it takes a new export.

## Key Constraints

### No imports or exports

Code runs inside a `new Function()` constructor, not a module. You cannot use
`import` or `export` statements. Instead:

- Use `packages.<name>` for npm packages (e.g., `packages.lodash`,
  `packages.dayjs`)
- All closure variables (`db`, `functions`, `state`, `config`, `templates`,
  `packages`, `env`) are pre-injected
- Tests also get `appUrl(path)` and `getAppPort()` so they can target the
  current live app preview port without hard-coding `localhost:3001`

### Function name must match

The source must define a function with exactly the name passed to the
registration tool. The pipeline does `return <name>` after the code runs.

### Closure variables by entity type

| Entity   | Closure variables                                                                               |
| -------- | ----------------------------------------------------------------------------------------------- |
| Handler  | `db, functions, config, templates, packages, env, log, assertNever` + `(req, ctx)` as arguments |
| Function | `db, functions, config, templates, packages, env, log, assertNever`                             |
| Dev View | `db, functions, config, templates, packages, env, log, kernel`                                  |
| Dev Tool | `db, functions, config, templates, packages, env, log`                                          |
| Test     | `db, functions, config, templates, packages, env, appUrl, getAppPort, log` + assertion helpers  |

### Async support

All entity types support async functions. Use `async function name(...)` freely.

### Available globals

Standard JavaScript globals are available: `console`, `fetch`, `JSON`, `Date`,
`Math`, `URL`, `URLSearchParams`, `setTimeout`, `Response`, `Headers`,
`Request`, `TextEncoder`, `TextDecoder`, etc.

## QC Checks

The quality control pipeline runs before code is persisted. It checks for:

- **Compilation errors** — TypeScript syntax errors (blocks registration)
- **Unused variables** — warnings for declared but unused identifiers
- **Dangerous patterns** — `eval()`, `new Function()` in user code (blocks
  registration)
- **Async without await** — warning if an async function never uses await
- **Empty catch blocks** — warning for swallowed errors
- **Console usage** — warning for `console.log` (use structured logging instead)

If QC finds blocking errors, registration is rejected. Fix the issues and retry.
