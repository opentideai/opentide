import { MODIFICATION_TOOLS } from "./dispatch.ts";

export interface CustomToolDef {
  type: "custom";
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

const str = (desc: string) => ({ type: "string", description: desc });
const num = (desc: string) => ({ type: "number", description: desc });

// Item shapes for the changeset/verification arrays. Each is OPEN
// (additionalProperties: true) — dispatch normalizes items and tolerates extra
// fields — but names the fields that matter and their vocabularies, so a
// misspelled `summary` or an invented status is refused at the boundary instead
// of being silently dropped or downgraded (normalizeVerificationStatus turns an
// unknown status into "partial"; normalizeClaimPriority turns an unknown
// priority into "should", which quietly drops a criterion the caller meant to
// be "must").
const VERIFICATION_STATUSES = ["passed", "failed", "partial", "manual"];
const acceptanceCriterionItem = {
  description:
    "A string, or an object { id, text, source, priority }. Default priority to `should`; `must` makes complete_changeset run a billed refutation agent.",
  properties: {
    id: str("Stable claim id, e.g. claim_saves_bookmark"),
    text: str("The behavior claim"),
    source: { type: "string", enum: ["user", "agent", "inferred"] },
    priority: { type: "string", enum: ["must", "should", "nice"] },
  },
  required: ["text"],
  additionalProperties: true,
};
const verificationCheckItem = {
  properties: {
    id: str("Stable check id"),
    claimIds: { type: "array", items: { type: "string" } },
    kind: str(
      "unit, integration, e2e, screenshot, typecheck, coverage, audit, adversarial, manual, invariant, or manifest",
    ),
    description: str("What the check does"),
  },
  required: ["description"],
  additionalProperties: true,
};
const evidenceItem = {
  type: "object",
  properties: {
    id: str("Evidence id, referenced from claimResults[].evidenceIds"),
    kind: str("test_result, note, or a verification check kind"),
    status: { type: "string", enum: VERIFICATION_STATUSES },
    summary: str("What this evidence shows"),
    checkId: str("The verificationPlan check this evidence satisfies"),
    attestationId: str("Kernel attestation id for this evidence, if any"),
    artifactPath: str("Path to a saved artifact (screenshot, log)"),
  },
  required: ["summary"],
  additionalProperties: true,
};
const claimResultItem = {
  type: "object",
  properties: {
    claimId: str("The acceptance criterion's own id"),
    status: { type: "string", enum: VERIFICATION_STATUSES },
    evidenceIds: { type: "array", items: { type: "string" } },
    note: str("Optional note"),
  },
  required: ["claimId", "status"],
  additionalProperties: true,
};

// Test-only route metadata (Milestone 4, Slice 4.3): opt in to the production
// route-smoke plan probing a route it would otherwise skip. `safe` lets a mutating
// method be auto-hit; `exampleRequest` supplies the path params / query / body a
// parameterized route needs. Never emitted into openapi.json or any exported
// bytes. Kept a plain optional object (no AJV meta-schema tightening) — dispatch
// passes schema through verbatim, so declaring it here is purely discoverability.
const productionTestSchema = {
  type: "object",
  description:
    "Optional fixtures for the production route-smoke gate, so a mutating or parameterized route is probed instead of skipped. Not in OpenAPI docs.",
  properties: {
    safe: {
      type: "boolean",
      description:
        "Let the smoke gate hit a mutating route (the smoke app is thrown away).",
    },
    exampleRequest: {
      type: "object",
      description: "A valid request for the route's inputs.",
      properties: {
        pathParams: {
          type: "object",
          description: "Path param values by name, e.g. { id: '123' }.",
        },
        query: {
          type: "object",
          description: "Required query values by name.",
        },
        body: {
          type: "object",
          description: "JSON body (body-allowing methods only).",
        },
      },
    },
    expectedStatus: num(
      "Expected status, overriding the schema-derived default.",
    ),
    deterministicBody: {
      type: "boolean",
      description:
        "Response body is identical across targets (target-parity check).",
    },
  },
} as const;

export const CUSTOM_TOOLS: CustomToolDef[] = [
  // --- Inspection ---
  {
    type: "custom",
    name: "list_routes",
    description:
      "Returns all registered routes with their methods, paths, and handler names.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    type: "custom",
    name: "list_handlers",
    description:
      "Returns a summary of every registered handler (name, module, purpose, language, line count) — NOT source. Pass `name` to return that one handler's full source and schema. Use this to inspect application handler source; do not query internal database tables such as _temp_build for app source.",
    input_schema: {
      type: "object",
      properties: {
        name: str(
          "Optional: return this one handler's full source and schema instead of the summary list.",
        ),
      },
      required: [],
    },
  },
  {
    type: "custom",
    name: "get_handler_source",
    description: "Returns the source code of a handler function by name.",
    input_schema: {
      type: "object",
      properties: { handlerName: str("Name of the handler") },
      required: ["handlerName"],
    },
  },
  {
    type: "custom",
    name: "list_functions",
    description:
      "Returns a summary of every function in the function registry — shared business logic — (name, module, purpose, return type, line count), NOT source. Pass `name` to return that one function's full source.",
    input_schema: {
      type: "object",
      properties: {
        name: str(
          "Optional: return this one function's full source instead of the summary list.",
        ),
      },
      required: [],
    },
  },
  {
    type: "custom",
    name: "get_function_source",
    description: "Returns the source code of a named function.",
    input_schema: {
      type: "object",
      properties: { functionName: str("Name of the function") },
      required: ["functionName"],
    },
  },
  {
    type: "custom",
    name: "list_schemas",
    description: "Returns all database table schemas with column definitions.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    type: "custom",
    name: "get_schema",
    description: "Returns a single table schema in detail.",
    input_schema: {
      type: "object",
      properties: { tableName: str("Name of the table") },
      required: ["tableName"],
    },
  },
  {
    type: "custom",
    name: "query_database",
    description:
      "Execute a read-only SQL query for inspecting user/app data rows in registered schemas. Returns rows and column names. Use PostgreSQL syntax ($1, $2 for params). Do not use this to discover app source; internal tables whose names start with '_' (including _temp_build) are Tide/Genie implementation details and generated artifacts. Note: handler code should use `await db.query()` directly — this tool is for ad-hoc data investigation.",
    input_schema: {
      type: "object",
      properties: {
        sql: str("SQL SELECT query"),
        params: { type: "array", description: "Query parameters", items: {} },
      },
      required: ["sql"],
    },
  },
  {
    type: "custom",
    name: "get_logs",
    description:
      "Returns recent log entries from the unified kernel log. Supports filtering by level (debug/info/warn/error), source (handler/system/script/agent), and text search.",
    input_schema: {
      type: "object",
      properties: {
        level: str("Filter by log level: debug, info, warn, error"),
        source: str("Filter by source: handler, system, script, agent"),
        limit: num("Max entries to return (default 50)"),
        search: str("Search text in message"),
      },
      required: [],
    },
  },
  {
    type: "custom",
    name: "find_similar_entities",
    description:
      "Find existing functions or handlers that may duplicate a proposed entity. Use before creating shared logic or handlers. This is read-only; duplicate enforcement currently applies only to define_function and define_handler.",
    input_schema: {
      type: "object",
      properties: {
        kind: str('Entity kind: "function" or "handler"'),
        name: str("Proposed entity name"),
        purpose: str("Optional plain-English purpose of the proposed entity"),
        source: str("Optional proposed source code"),
        module: str("Optional module name"),
      },
      required: ["kind", "name"],
    },
  },
  {
    type: "custom",
    name: "get_recent_errors",
    description: "Returns recent runtime errors from the app server.",
    input_schema: {
      type: "object",
      properties: { limit: num("Max errors to return (default 20)") },
      required: [],
    },
  },
  {
    type: "custom",
    name: "get_recent_requests",
    description: "Returns recent HTTP requests served by the app.",
    input_schema: {
      type: "object",
      properties: { limit: num("Max requests to return (default 20)") },
      required: [],
    },
  },
  {
    type: "custom",
    name: "doctor_project",
    description:
      "Run the current project's consistency check. Reports malformed JSON, duplicate IDs, broken references, schema/migration mismatches, and Git data hygiene without modifying files.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    type: "custom",
    name: "project_status",
    description:
      "Orient before working: one read-only call that reports whether this project is safe to change. Returns `verdict` (ok / attention / stop) with one line per problem, the project consistency check (what doctor_project would report), entity counts in memory against .opentide/state on disk (a difference is unflushed work, or state that did not load), unreachable code, the active changeset and its step progress, and the tool surface version. Does not run tests — call run_tests next if the verdict is ok. Call this first in a session, and again whenever a readiness or consistency error is unclear.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    type: "custom",
    name: "git_status",
    description:
      "Flush current Tide state to disk and return Git repository status for the loaded project: branch, changed files, latest commit, remotes, and push readiness. `files[]` lists app-source paths only and is capped (`truncated: true` when it was cut); changes under `.opentide/` (Tide's own state and provenance tree) are summarised as counts in `projectState`. `changedCount` and `untrackedCount` are totals across both groups — use those for any number you report, never `files.length`.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    type: "custom",
    name: "git_init",
    description:
      "Initialize Git in the current project directory if it is not already a repository.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    type: "custom",
    name: "git_add_tide_gitignore",
    description:
      "Add Tide's default .gitignore to the current project only when no .gitignore exists.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    type: "custom",
    name: "git_set_remote",
    description:
      "Add or update a Git remote for the current project. Defaults to remote name origin.",
    input_schema: {
      type: "object",
      properties: {
        url: str("Remote URL, such as a GitHub HTTPS or SSH URL"),
        name: str("Remote name. Defaults to origin."),
      },
      required: ["url"],
    },
  },
  {
    type: "custom",
    name: "git_commit",
    description:
      "Flush current Tide state, stage all nonignored project files with git add --all, and commit them. If message is omitted or empty, generate a commit message from the staged changes. Do not call this unless the user explicitly asked to commit or confirmed a proposed commit.",
    input_schema: {
      type: "object",
      properties: {
        message: str("Optional commit message to use for the Git commit"),
      },
      required: [],
    },
  },
  {
    type: "custom",
    name: "git_push",
    description:
      "Flush current Tide state and push the current branch to a configured remote using local Git credentials. Defaults to origin and the current branch. Do not call this unless the user explicitly asked to push or confirmed a proposed push.",
    input_schema: {
      type: "object",
      properties: {
        name: str("Remote name. Defaults to origin."),
        branch: str("Branch name. Defaults to the current branch."),
      },
      required: [],
    },
  },

  // --- Codebase Index (source-backed project import) ---
  {
    type: "custom",
    name: "index_codebase",
    description:
      "Index an existing source-backed TS/JS project into a neutral codebase graph (files, modules, symbols, routes, handlers, commands, framework facts). Returns a COMPACT summary — per-category counts plus discovery basics (package manager, detected frameworks, plugins that ran) — not the full graph. The full graph is cached in the kernel and served over GET /api/codebase. Defaults to the current project's root when rootPath is omitted.",
    input_schema: {
      type: "object",
      properties: {
        rootPath: str(
          "Absolute path to the project root to index. Defaults to the current project's directory.",
        ),
        classification: {
          type: "string",
          enum: ["off", "assist"],
          description:
            "Optional import classification mode. Omit or use 'off' for deterministic indexing only. Use 'assist' to run model-assisted semantic classification after deterministic indexing when possible.",
        },
      },
      required: [],
    },
  },
  {
    type: "custom",
    name: "preview_project_file",
    description:
      "Preview a create, update, or delete for a safe text file inside the current project root. This is read-only and returns before/after snapshots plus a baseFingerprint that must be echoed to apply_project_file. Use this before creating project planning files such as Markdown notes.",
    input_schema: {
      type: "object",
      properties: {
        path: str(
          "Project-root-relative target path. Must stay inside the project and use an allowed text extension such as .md, .txt, .json, .yaml, .csv, .html, .css, .js, or .ts.",
        ),
        content: str(
          "Full replacement content for create/update. Omit when delete is true.",
        ),
        delete: {
          type: "boolean",
          description: "Set true to preview deleting the file.",
        },
      },
      required: ["path"],
    },
  },
  {
    type: "custom",
    name: "apply_project_file",
    description:
      "Apply a previously previewed create, update, or delete for a safe text file inside the current project root. Requires the baseFingerprint returned by preview_project_file and is rejected if the file changed since preview.",
    input_schema: {
      type: "object",
      properties: {
        path: str(
          "Project-root-relative target path. Must match the previewed file.",
        ),
        content: str(
          "Full replacement content for create/update. Must match the previewed operation. Omit when delete is true.",
        ),
        delete: {
          type: "boolean",
          description: "Set true to apply deleting the file.",
        },
        baseFingerprint: {
          type: ["string", "null"],
          description:
            "The exact baseFingerprint returned by preview_project_file, including null for a create.",
        },
      },
      required: ["path", "baseFingerprint"],
    },
  },

  // --- Modification ---
  {
    type: "custom",
    name: "define_handler",
    description:
      "Register a route handler. The source must define a function whose name matches the 'name' parameter. The handler is called as `(req: Request, ctx: HandlerContext) => Response | Promise<Response>` — a web-standard Request in, a web-standard Response out. `ctx.params` holds the path parameters the route pattern matched, as strings (`/todos/:id` gives `ctx.params.id`). Read the request with `await req.json()`, `req.headers.get(...)` and `new URL(req.url).searchParams`; reply with `Response.json(data, { status: 201 })` or any Response you construct. `db`, `functions`, `config`, `templates`, `packages`, `env`, `log` and `assertNever` arrive via closure. No web framework is involved and none is needed — the kernel owns routing and nothing else; if you install one via install_package anyway, mount it from a single catch-all route with `return app.fetch(req)`. Optionally provide a schema describing the expected request format — it will auto-apply when this handler is bound to a route.",
    input_schema: {
      type: "object",
      properties: {
        name: str("Handler name (must match function name in source)"),
        source: str(
          "Project runtime source defining the handler function. Current runtime: TypeScript/JavaScript.",
        ),
        module: str(
          "Module name for grouping (e.g., 'todos', 'auth', 'users')",
        ),
        purpose: str(
          "One-sentence purpose of this handler. Required for new handlers unless intentionally preserving existing metadata.",
        ),
        duplicateJustification: str(
          "Required only to override a high-confidence duplicate warning. Explain why this separate handler should exist instead of reusing or updating the candidate.",
        ),
        expectedRevision: num(
          "Optional optimistic-concurrency token: the entity revision you last read. If it no longer matches (a concurrent write landed), the call is rejected with STALE_WRITE instead of clobbering. Omit for last-writer-wins.",
        ),
        schema: {
          type: "object",
          description:
            "Optional request/response schema. Auto-applied when this handler is bound to a route via register_route (unless the route provides its own schema).",
          properties: {
            summary: str("Short summary of what this handler does"),
            description: str("Detailed description"),
            tags: {
              type: "array",
              items: { type: "string" },
              description: "Tags for grouping in API docs",
            },
            params: {
              type: "object",
              description: "Path parameter schemas keyed by param name",
            },
            query: {
              type: "object",
              description: "Query parameter schemas keyed by param name",
            },
            body: {
              type: "object",
              description: "JSON Schema for the request body",
            },
            responses: {
              type: "object",
              description: "Response schemas keyed by status code",
            },
            productionTest: productionTestSchema,
          },
        },
      },
      required: ["name", "source"],
    },
  },
  {
    type: "custom",
    name: "define_function",
    description:
      "Register a shared function. The source must define a function whose name matches the 'name' parameter. Has access to db, functions, config, packages, and env via closure. Use returnType to link the output to a custom type for dev view rendering.",
    input_schema: {
      type: "object",
      properties: {
        name: str("Function name (must match function name in source)"),
        source: str(
          "Project runtime source defining the function. Current runtime: TypeScript/JavaScript.",
        ),
        returnType: str(
          "Name of a registered type this function returns (e.g., 'Todo' or 'Todo[]' for arrays)",
        ),
        module: str(
          "Module name for grouping (e.g., 'todos', 'auth', 'users')",
        ),
        purpose: str(
          "One-sentence purpose of this function. Required for new functions unless intentionally preserving existing metadata.",
        ),
        duplicateJustification: str(
          "Required only to override a high-confidence duplicate warning. Explain why this separate function should exist instead of reusing or updating the candidate.",
        ),
        expectedRevision: num(
          "Optional optimistic-concurrency token: the entity revision you last read. If it no longer matches (a concurrent write landed), the call is rejected with STALE_WRITE instead of clobbering. Omit for last-writer-wins.",
        ),
      },
      required: ["name", "source"],
    },
  },
  {
    type: "custom",
    name: "register_route",
    description:
      "Bind a route (method + path) to a handler name. The handler must already be defined. Optionally provide a schema for request validation and OpenAPI documentation.",
    input_schema: {
      type: "object",
      properties: {
        method: str("HTTP method (GET, POST, PUT, DELETE, PATCH)"),
        path: str("URL path (e.g., /api/todos, /api/todos/:id)"),
        handlerName: str("Name of an existing handler"),
        module: str(
          "Module name for grouping (e.g., 'todos', 'auth', 'users')",
        ),
        schema: {
          type: "object",
          description:
            "Optional schema for request validation and API docs. Declared params, query and body are ALL validated automatically — an invalid request gets a 400 before the handler runs, in the live preview and in an exported app alike. `format` is documented, not enforced: constrain a param with `enum`, or a body property with `enum` or `pattern`.",
          properties: {
            summary: str("Short summary of what this endpoint does"),
            description: str("Detailed description of the endpoint"),
            tags: {
              type: "array",
              items: { type: "string" },
              description: "Tags for grouping in API docs",
            },
            params: {
              type: "object",
              description:
                "Path parameter schemas keyed by param name. Each value: { type, description?, enum? }",
            },
            query: {
              type: "object",
              description:
                "Query parameter schemas keyed by param name. Each value: { type, description?, required?, enum? }",
            },
            body: {
              type: "object",
              description:
                "JSON Schema for the request body. Must have type: 'object' with properties and optional required array.",
            },
            responses: {
              type: "object",
              description:
                "Response schemas keyed by status code (e.g. '200', '400'). Each value: { description, schema? }",
            },
            productionTest: productionTestSchema,
          },
        },
      },
      required: ["method", "path", "handlerName"],
    },
  },
  {
    type: "custom",
    name: "unregister_route",
    description: "Remove a route binding.",
    input_schema: {
      type: "object",
      properties: {
        method: str("HTTP method"),
        path: str("URL path"),
      },
      required: ["method", "path"],
    },
  },
  {
    type: "custom",
    name: "define_schema",
    description:
      "Create a new database table. SQL must be exactly one CREATE TABLE statement. Do not include companion CREATE INDEX statements; use inline constraints for simple uniqueness or call alter_schema once per extra DDL statement after the table exists.",
    input_schema: {
      type: "object",
      properties: {
        tableName: str("Table name (alphanumeric and underscores only)"),
        sql: str("Exactly one CREATE TABLE SQL statement"),
        module: str(
          "Module name for grouping (e.g., 'todos', 'auth', 'users')",
        ),
      },
      required: ["tableName", "sql"],
    },
  },
  {
    type: "custom",
    name: "alter_schema",
    description:
      "Modify an existing table using native PostgreSQL DDL. Provide a single ALTER TABLE, CREATE INDEX, or other DDL statement. The kernel executes it directly and records a versioned migration with auto-generated reverse SQL for undo/rollback. For multiple changes, call this tool once per DDL statement.",
    input_schema: {
      type: "object",
      properties: {
        tableName: str("Table name to alter"),
        sql: str(
          "A single DDL statement (e.g., ALTER TABLE ... ADD COLUMN ..., CREATE INDEX ..., etc.)",
        ),
        module: str(
          "Module name for grouping (e.g., 'todos', 'auth', 'users')",
        ),
      },
      required: ["tableName", "sql"],
    },
  },
  {
    type: "custom",
    name: "drop_schema",
    description: "Drop a table and remove its schema.",
    input_schema: {
      type: "object",
      properties: { tableName: str("Table name to drop") },
      required: ["tableName"],
    },
  },
  {
    type: "custom",
    name: "execute_sql",
    description:
      "Execute a write SQL statement (INSERT, UPDATE, DELETE) for debugging or data seeding. Use PostgreSQL syntax ($1, $2 for params). Note: handler code should use `await db.execute()` directly — this tool is for ad-hoc operations.",
    input_schema: {
      type: "object",
      properties: {
        sql: str("SQL statement"),
        params: { type: "array", description: "Query parameters", items: {} },
      },
      required: ["sql"],
    },
  },
  // --- App Config ---
  {
    type: "custom",
    name: "set_config",
    description:
      "Set an app configuration value. Available as `config.get('<name>')` in handlers, functions, and scripts. Use for non-sensitive app-level constants like retry counts, pagination sizes, rate limits, and feature flags.",
    input_schema: {
      type: "object",
      properties: {
        name: str("Config name (e.g., MAX_RETRIES, PAGE_SIZE, RATE_LIMIT)"),
        value: {
          description:
            "Config value (must be JSON-serializable — string, number, boolean, object, or array)",
        },
        description: str(
          "What this config controls (e.g., 'Maximum retry attempts for API calls')",
        ),
        module: str("Module name for grouping (e.g., 'todos', 'auth', 'api')"),
      },
      required: ["name", "value"],
    },
  },
  {
    type: "custom",
    name: "get_config",
    description: "Get an app configuration value and its metadata.",
    input_schema: {
      type: "object",
      properties: { name: str("Config name") },
      required: ["name"],
    },
  },
  {
    type: "custom",
    name: "list_configs",
    description: "List all app configuration entries.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    type: "custom",
    name: "delete_config",
    description: "Remove an app configuration entry.",
    input_schema: {
      type: "object",
      properties: { name: str("Config name to remove") },
      required: ["name"],
    },
  },

  // --- Environment Variables ---
  {
    type: "custom",
    name: "set_env",
    description:
      "Set an environment variable for this project. Stored in the project database and available as `env.<KEY>` in all handlers, functions, and scripts. Falls back to the project .env file if not set in the database. Use for non-sensitive configuration like API hosts, base URLs, and feature flags. For sensitive values, use define_secret instead.",
    input_schema: {
      type: "object",
      properties: {
        key: str("Variable name (e.g., API_HOST, BASE_URL)"),
        value: str("Variable value"),
      },
      required: ["key", "value"],
    },
  },
  {
    type: "custom",
    name: "get_env",
    description:
      "Get the value of an environment variable. Checks the database first, then falls back to the project .env file.",
    input_schema: {
      type: "object",
      properties: { key: str("Variable name") },
      required: ["key"],
    },
  },
  {
    type: "custom",
    name: "list_env",
    description:
      "List all environment variables defined for this project (from database and .env file).",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    type: "custom",
    name: "delete_env",
    description: "Remove an environment variable from the project database.",
    input_schema: {
      type: "object",
      properties: { key: str("Variable name to remove") },
      required: ["key"],
    },
  },

  // --- Env Vars (DB-stored) ---
  {
    type: "custom",
    name: "define_env_var",
    description:
      "Define or update an environment variable stored in the project database. Use for non-sensitive config like API hosts, base URLs, ports, feature flags. Pass `value` to set an explicit override (supersedes any .env fallback); pass `clearValue: true` to drop the override and read from the project .env file. Available as `env.<KEY>` in handlers, functions, and scripts.",
    input_schema: {
      type: "object",
      properties: {
        key: str("Variable name (e.g., API_HOST, DB_HOST, BASE_URL)"),
        value: str(
          "Explicit value (optional — omit to read from .env fallback)",
        ),
        clearValue: {
          type: "boolean",
          description:
            "Drop the explicit value and revert to the .env fallback.",
        },
        description: str(
          "What this variable is for (e.g., 'API server hostname')",
        ),
      },
      required: ["key"],
    },
  },
  {
    type: "custom",
    name: "get_env_var",
    description: "Get an environment variable's metadata and resolved value.",
    input_schema: {
      type: "object",
      properties: { key: str("Variable name") },
      required: ["key"],
    },
  },
  {
    type: "custom",
    name: "list_env_vars",
    description:
      "List all defined environment variables with their status (set/env/unset).",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    type: "custom",
    name: "delete_env_var",
    description: "Remove an environment variable definition from the database.",
    input_schema: {
      type: "object",
      properties: { key: str("Variable name to delete") },
      required: ["key"],
    },
  },
  {
    type: "custom",
    name: "set_env_var_value",
    description:
      "Set an explicit value for an environment variable, overriding any .env file fallback.",
    input_schema: {
      type: "object",
      properties: {
        key: str("Variable name"),
        value: str("Value to store"),
      },
      required: ["key", "value"],
    },
  },
  {
    type: "custom",
    name: "clear_env_var_value",
    description:
      "Remove the explicit value from an environment variable, reverting it to read from the .env file.",
    input_schema: {
      type: "object",
      properties: { key: str("Variable name") },
      required: ["key"],
    },
  },

  // --- Secrets ---
  {
    type: "custom",
    name: "define_secret",
    description:
      "Define or update a secret that the app needs at runtime. Secrets are stored securely outside the project directory. Pass `value` to set an explicit value (overrides any process env var of the same key); pass `clearValue: true` to drop the explicit value and read from the process environment variable instead. Available as `env.<KEY>` in handlers, functions, and scripts. Use for API keys, DB credentials, and other sensitive config.",
    input_schema: {
      type: "object",
      properties: {
        key: str("Secret key name (e.g., DATABASE_URL, STRIPE_KEY)"),
        value: str(
          "Explicit secret value (optional — omit to read from the process env var)",
        ),
        clearValue: {
          type: "boolean",
          description:
            "Drop the explicit value and revert to the process environment variable.",
        },
        description: str(
          "What this secret is for (e.g., 'PostgreSQL connection string')",
        ),
      },
      required: ["key"],
    },
  },
  {
    type: "custom",
    name: "get_secret",
    description:
      "Get a secret's metadata and resolved value. Returns the key, description, whether an explicit value is set, and the resolved value (explicit or from env).",
    input_schema: {
      type: "object",
      properties: { key: str("Secret key name") },
      required: ["key"],
    },
  },
  {
    type: "custom",
    name: "list_secrets",
    description:
      "List all defined secrets with their status (set/env/unset) but without values.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    type: "custom",
    name: "delete_secret",
    description: "Remove a secret definition entirely.",
    input_schema: {
      type: "object",
      properties: { key: str("Secret key name to delete") },
      required: ["key"],
    },
  },
  {
    type: "custom",
    name: "set_secret_value",
    description:
      "Set an explicit value for a secret. This overrides any environment variable with the same key.",
    input_schema: {
      type: "object",
      properties: {
        key: str("Secret key name"),
        value: str("Secret value to store"),
      },
      required: ["key", "value"],
    },
  },
  {
    type: "custom",
    name: "clear_secret_value",
    description:
      "Remove the explicit value from a secret, reverting it to read from the process environment variable.",
    input_schema: {
      type: "object",
      properties: { key: str("Secret key name") },
      required: ["key"],
    },
  },

  // --- Templates ---
  {
    type: "custom",
    name: "define_template",
    description:
      "Register an HTML template. Templates are stored separately from handlers and accessible via `templates.get(name)` in handlers, functions, and scripts. Use templates for HTML pages and partials — keep handlers focused on logic, not markup.",
    input_schema: {
      type: "object",
      properties: {
        name: str("Template name (e.g., 'main', 'todo-page', 'header')"),
        content: str("HTML content of the template"),
        module: str(
          "Module name for grouping (e.g., 'todos', 'auth', 'users')",
        ),
      },
      required: ["name", "content"],
    },
  },
  {
    type: "custom",
    name: "list_templates",
    description:
      "Returns all registered templates with their names and sizes. Pass `name` to return a single template's full content instead.",
    input_schema: {
      type: "object",
      properties: {
        name: str(
          "Optional: return this one template's full content instead of the list.",
        ),
      },
      required: [],
    },
  },
  {
    type: "custom",
    name: "get_template",
    description: "Returns the content of a template by name.",
    input_schema: {
      type: "object",
      properties: { name: str("Template name") },
      required: ["name"],
    },
  },
  {
    type: "custom",
    name: "delete_template",
    description: "Remove a template from the registry.",
    input_schema: {
      type: "object",
      properties: { name: str("Template name to delete") },
      required: ["name"],
    },
  },

  // --- Assets ---
  {
    type: "custom",
    name: "upload_text_asset",
    description:
      "Upload a text-based asset (CSS, JS, HTML, SVG, JSON, etc.) to be served at /_assets/<name>. Preferred over upload_asset for text content — no encoding needed.",
    input_schema: {
      type: "object",
      properties: {
        name: str("Asset filename (e.g., 'style.css', 'app.js')"),
        content: str("Raw text content of the file"),
        mimeType: str("MIME type (e.g., 'text/css', 'application/javascript')"),
        module: str(
          "Module name for grouping (e.g., 'todos', 'auth', 'users')",
        ),
      },
      required: ["name", "content", "mimeType"],
    },
  },
  {
    type: "custom",
    name: "upload_asset",
    description:
      "Upload a binary asset (image, font, etc.) to be served at /_assets/<name>. Content must be base64-encoded. For text assets (CSS, JS, etc.), prefer upload_text_asset instead.",
    input_schema: {
      type: "object",
      properties: {
        name: str("Asset filename (e.g., 'logo.png', 'font.woff2')"),
        contentBase64: str("Base64-encoded file content"),
        mimeType: str("MIME type (e.g., 'image/png', 'font/woff2')"),
        module: str(
          "Module name for grouping (e.g., 'todos', 'auth', 'users')",
        ),
      },
      required: ["name", "contentBase64", "mimeType"],
    },
  },
  {
    type: "custom",
    name: "list_assets",
    description:
      "Returns uploaded assets with their names, MIME types, and sizes. Pass name and includeContent=true to read the live source of a text asset such as CSS, JS, HTML, SVG, JSON, XML, or YAML.",
    input_schema: {
      type: "object",
      properties: {
        name: str("Optional asset filename to return one asset"),
        includeContent: {
          type: "boolean",
          description:
            "When true, name is required and content is returned only for editable text assets.",
        },
      },
      required: [],
    },
  },
  {
    type: "custom",
    name: "get_asset",
    description:
      "Returns metadata for a specific asset (name, MIME type, size). Does not return content.",
    input_schema: {
      type: "object",
      properties: { name: str("Asset filename") },
      required: ["name"],
    },
  },
  {
    type: "custom",
    name: "delete_asset",
    description: "Remove an uploaded asset.",
    input_schema: {
      type: "object",
      properties: { name: str("Asset filename to delete") },
      required: ["name"],
    },
  },

  // --- Packages ---
  {
    type: "custom",
    name: "install_package",
    description:
      "Install an npm package for use in handlers, functions, and scripts. After installation, the package module is available as `packages.<name>` in all code. Example: install 'marked', then use `const { marked } = packages.marked;` in a handler.",
    input_schema: {
      type: "object",
      properties: {
        name: str("npm package name (e.g., 'marked', 'lodash', 'date-fns')"),
        version: str(
          "Optional version (e.g., '18', '4.17.21'). Omit for latest.",
        ),
      },
      required: ["name"],
    },
  },
  {
    type: "custom",
    name: "list_packages",
    description:
      "Returns all installed npm packages with their names and version specifiers.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    type: "custom",
    name: "remove_package",
    description:
      "Remove an installed npm package. Existing handlers/functions referencing it will error at runtime.",
    input_schema: {
      type: "object",
      properties: { name: str("Package name to remove") },
      required: ["name"],
    },
  },
  {
    type: "custom",
    name: "find_unused_packages",
    description:
      "Scan all handlers, functions, and tests to find installed packages that are not referenced anywhere. Returns used and unused packages with their reference locations. Use this to clean up dependencies.",
    input_schema: { type: "object", properties: {}, required: [] },
  },

  // --- Execution ---
  {
    type: "custom",
    name: "run_script",
    description:
      "Execute a TypeScript/JavaScript script. The script has access to `db` (query/execute SQL), `functions` (call registered functions), `state` (get/set state), `env` (environment variables), `packages` (npm packages), and `log(...)` for output. The script body is top-level code (not wrapped in a function). Returns the last expression value and any logged output. Use for CLI tools, data processing, testing logic, or anything that isn't an HTTP handler.",
    input_schema: {
      type: "object",
      properties: {
        source: str("TypeScript/JavaScript source code to execute"),
      },
      required: ["source"],
    },
  },

  // --- Custom Types ---
  {
    type: "custom",
    name: "define_type",
    description:
      "Register a custom type definition. Types describe the shape of data returned by functions. Once defined, functions can declare a returnType and dev views can target the type name to provide custom rendering.",
    input_schema: {
      type: "object",
      properties: {
        name: str(
          "Type name in PascalCase (e.g., 'Todo', 'UserProfile', 'ChartData')",
        ),
        fields: {
          type: "array",
          description: "Fields that make up this type",
          items: {
            type: "object",
            properties: {
              name: str("Field name"),
              type: str(
                "Field type (e.g., 'string', 'number', 'boolean', 'string[]', 'Date')",
              ),
              description: str("What this field represents"),
              optional: {
                type: "boolean",
                description: "Whether this field is optional (default false)",
              },
            },
            required: ["name", "type"],
          },
        },
        description: str("What this type represents"),
        module: str(
          "Module name for grouping (e.g., 'todos', 'auth', 'users')",
        ),
      },
      required: ["name", "fields"],
    },
  },
  {
    type: "custom",
    name: "list_types",
    description:
      "Returns a summary of every registered custom type (name, module, description, field count) — NOT the field definitions. Pass `name` to return that one type's full definition.",
    input_schema: {
      type: "object",
      properties: {
        name: str(
          "Optional: return this one type's full definition instead of the summary list.",
        ),
      },
      required: [],
    },
  },
  {
    type: "custom",
    name: "get_type",
    description: "Get a custom type definition by name.",
    input_schema: {
      type: "object",
      properties: { name: str("Type name") },
      required: ["name"],
    },
  },
  {
    type: "custom",
    name: "remove_handler",
    description:
      "Remove a registered handler by name. Refused while any route still points at it — remove the route first.",
    input_schema: {
      type: "object",
      properties: { name: str("Handler name to remove") },
      required: ["name"],
    },
  },
  {
    type: "custom",
    name: "remove_function",
    description:
      "Remove a registered function by name. Refused while any handler, function, or test still calls it.",
    input_schema: {
      type: "object",
      properties: { name: str("Function name to remove") },
      required: ["name"],
    },
  },
  {
    type: "custom",
    name: "remove_type",
    description: "Remove a custom type by name.",
    input_schema: {
      type: "object",
      properties: { name: str("Type name to remove") },
      required: ["name"],
    },
  },

  // --- Dev Views ---
  {
    type: "custom",
    name: "define_dev_view",
    description:
      "Define a dev view — a custom inspector panel for a category of objects. Cannot overwrite built-in views. The source must define a function whose name matches the 'name' parameter. The function receives (object) and has closure access to db, functions, config, and kernel (read-only registry inspector with listRoutes(), listHandlers(), listFunctions(), listSchemas()). It must return a ViewDescriptor: stack (children[]), table (columns, rows), code (source, language?), key-value (entries[{key,value,mono?}]), markdown (content), or tree (data).",
    input_schema: {
      type: "object",
      properties: {
        name: str("View name (must match function name in source)"),
        targetType: str(
          "Category this view applies to: handler, function, route, config, schema, error, request, or any custom type",
        ),
        title: str("Display title for the view tab"),
        source: str(
          "Project runtime source defining the view function. Current runtime: TypeScript/JavaScript.",
        ),
        module: str(
          "Module name for grouping (e.g., 'todos', 'auth', 'users')",
        ),
      },
      required: ["name", "targetType", "title", "source"],
    },
  },
  {
    type: "custom",
    name: "remove_dev_view",
    description:
      "Remove a user-created dev view by name. Cannot remove built-in views.",
    input_schema: {
      type: "object",
      properties: { name: str("Name of the dev view to remove") },
      required: ["name"],
    },
  },
  {
    type: "custom",
    name: "list_dev_views",
    description:
      "List all registered dev views with their target types and whether they are built-in or user-defined. Pass `name` to return a single dev view's source instead.",
    input_schema: {
      type: "object",
      properties: {
        name: str(
          "Optional: return this one dev view's source instead of the list.",
        ),
      },
      required: [],
    },
  },
  {
    type: "custom",
    name: "get_dev_view_source",
    description: "Returns the source code of a dev view by name.",
    input_schema: {
      type: "object",
      properties: { name: str("Name of the dev view") },
      required: ["name"],
    },
  },

  // --- Dev Tools ---
  {
    type: "custom",
    name: "define_dev_tool",
    description:
      "Define a dev tool — a reusable function with named arguments that can be executed from the Tools panel. The source must define a function whose name matches the 'name' parameter. The function has closure access to db, functions, state, config, templates, packages, and env. It can return raw data (rendered as JSON) or include a __view property with a ViewDescriptor for custom rendering: { __view: { type: 'table', columns: [...], rows: [...] }, data: ... }. Custom dev views can also be registered for a tool's output using targetType 'dev_tool:<toolName>'.",
    input_schema: {
      type: "object",
      properties: {
        name: str("Tool name (must match function name in source)"),
        description: str("What this tool does"),
        args: {
          type: "array",
          description: "Argument definitions",
          items: {
            type: "object",
            properties: {
              name: str("Argument name"),
              type: str("Type: string, number, boolean, or object"),
              description: str("What this argument is for"),
              required: {
                type: "boolean",
                description: "Whether this argument is required",
              },
            },
            required: ["name", "type", "description", "required"],
          },
        },
        source: str(
          "Project runtime source defining the tool function. Current runtime: TypeScript/JavaScript.",
        ),
        module: str(
          "Module name for grouping (e.g., 'todos', 'auth', 'users')",
        ),
      },
      required: ["name", "description", "args", "source"],
    },
  },
  {
    type: "custom",
    name: "remove_dev_tool",
    description: "Remove a dev tool by name.",
    input_schema: {
      type: "object",
      properties: { name: str("Name of the dev tool to remove") },
      required: ["name"],
    },
  },
  {
    type: "custom",
    name: "list_dev_tools",
    description:
      "List all registered dev tools with their names, descriptions, and argument schemas.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    type: "custom",
    name: "call_dev_tool",
    description:
      "Execute a dev tool with the given arguments. Returns the tool's output. This is ephemeral — not recorded in the changelog.",
    input_schema: {
      type: "object",
      properties: {
        name: str("Name of the dev tool to call"),
        args: {
          type: "object",
          description:
            "Named arguments as key-value pairs matching the tool's arg schema",
        },
      },
      required: ["name"],
    },
  },

  // --- Tests ---
  {
    type: "custom",
    name: "define_test",
    description:
      "Register a test function. The source must define an async function whose name matches the 'name' parameter. The function has access to db, functions, config, templates, packages, env via closure, appUrl(path) for the current live app preview URL, getAppPort() for the current live preview port, plus assertion helpers: assert(condition, msg?), assertEquals(actual, expected, msg?), assertNotEquals(actual, expected, msg?), assertThrows(fn, msg?), assertRejects(asyncFn, msg?). Throw or use assertions to signal failure.",
    input_schema: {
      type: "object",
      properties: {
        name: str("Test name (must match function name in source)"),
        source: str(
          "Project runtime source defining the test function. Current runtime: TypeScript/JavaScript.",
        ),
        module: str(
          "Module name for grouping (e.g., 'todos', 'auth', 'users')",
        ),
        verification: {
          type: "object",
          description:
            "Optional proof metadata linking this test to acceptance criteria. Include claimIds, kind (unit/integration/e2e/adversarial), description, and generatedFrom when relevant.",
          properties: {
            claimIds: {
              type: "array",
              items: { type: "string" },
              description: "Acceptance criterion IDs this test verifies.",
            },
            kind: str("Test kind: unit, integration, e2e, or adversarial"),
            description: str("Short description of the behavior checked"),
            generatedFrom: str(
              "Source criterion, check, prompt, or plan step that generated this test",
            ),
          },
        },
      },
      required: ["name", "source"],
    },
  },
  {
    type: "custom",
    name: "list_tests",
    description:
      "Returns all registered tests. Pass `name` to return a single test's source instead.",
    input_schema: {
      type: "object",
      properties: {
        name: str(
          "Optional: return this one test's source instead of the list.",
        ),
      },
      required: [],
    },
  },
  {
    type: "custom",
    name: "get_test_source",
    description: "Returns the source code of a test by name.",
    input_schema: {
      type: "object",
      properties: { name: str("Test name") },
      required: ["name"],
    },
  },
  {
    type: "custom",
    name: "remove_test",
    description: "Remove a test from the registry.",
    input_schema: {
      type: "object",
      properties: { name: str("Test name to remove") },
      required: ["name"],
    },
  },
  {
    type: "custom",
    name: "run_tests",
    description:
      "Run all tests or a subset matching a name pattern. Returns pass/fail results for each test with error messages. Use this after making code changes to verify nothing is broken.",
    input_schema: {
      type: "object",
      properties: {
        pattern: str(
          "Optional glob-like pattern to filter tests by name (e.g., 'test_todo*'). Omit to run all tests.",
        ),
      },
      required: [],
    },
  },
  {
    type: "custom",
    name: "check_export_types",
    description:
      "Run the strict TypeScript check for the generated Deno export. Returns structured diagnostics with severity, TS code, message, file, line, column, and source snippets. Use this after code changes to verify the exported app type-checks; fix all error diagnostics in the registered source entities before completing a changeset. Generated paths, _temp_build, and temporary build tables are not source files.",
    input_schema: { type: "object", properties: {}, required: [] },
  },

  {
    type: "custom",
    name: "test_coverage",
    description:
      "Analyze test coverage by cross-referencing registered tests against handlers, functions, routes, templates, and database schemas. Reports which entities have tests, which are untested, and whether covering tests are passing or failing. Uses static analysis of test source code to detect fetch calls, functions.call/get references, templates.get references, SQL table references, and handler name mentions.",
    input_schema: {
      type: "object",
      properties: {
        module: str(
          "Optional module name to filter coverage (e.g., 'todos'). Omit for full app coverage.",
        ),
      },
      required: [],
    },
  },

  // --- Quality Control ---
  {
    type: "custom",
    name: "lint_code",
    description:
      "Run quality checks on source code. Returns issues (errors, warnings, info) covering unused variables, dangerous patterns, code style, and more. Use this to validate code before defining handlers/functions, or to check existing entity source.",
    input_schema: {
      type: "object",
      properties: {
        source: str("Source code to check"),
        kind: str(
          "Code type: handler, function, template, css, js, dev_view, dev_tool (default: function)",
        ),
      },
      required: ["source"],
    },
  },

  {
    type: "custom",
    name: "find_dead_code",
    description:
      "Analyze the call graph to find unreachable entities: handlers with no route, functions nothing calls, configs nobody reads, templates nobody renders, tables nobody queries. Use this to identify code that can be safely removed.",
    input_schema: {
      type: "object",
      properties: {},
    },
  },

  {
    type: "custom",
    name: "blast_radius",
    description:
      "What depends on X — the direct and transitive set of entities that would be affected by changing entity X. Use before proposing a change to a shared function/config/handler/template to understand its blast radius.",
    input_schema: {
      type: "object",
      properties: {
        category: str(
          "Entity category: route, handler, function, config, template, or schema",
        ),
        name: str("Entity name"),
      },
      required: ["category", "name"],
    },
  },

  // --- Audits ---
  {
    type: "custom",
    name: "run_audit",
    description:
      "Run an AI-powered code audit. Built-in categories: security, performance, seo, accessibility, code-quality. Custom audit categories can also be created and run.",
    input_schema: {
      type: "object",
      properties: {
        category: str("Audit category name (built-in or custom)"),
      },
      required: ["category"],
    },
  },
  {
    type: "custom",
    name: "refute_claims",
    description:
      "Run an adversarial refutation pass on a changeset's acceptance criteria: for each targeted claim an independent AI reviewer tries to DISPROVE it by finding a concrete counterexample. Mints an 'adversarial' attestation per claim (passed = survived, failed = refuted) and returns per-claim verdicts with counterexamples. Defaults to all 'must' criteria. A fresh refuted claim blocks completion until reviewed, fixed, amended, or dismissed by a fresh passing refutation. Include the returned adversarial evidence (with its attestationId) in record_verification_run.",
    input_schema: {
      type: "object",
      properties: {
        changeset_id: str(
          "Changeset to review (defaults to the active changeset)",
        ),
        claim_ids: {
          type: "array",
          description:
            "Specific acceptance-criterion ids to refute. Omit to review all 'must' criteria.",
          items: { type: "string" },
        },
        attempts: {
          type: "number",
          description: "Independent refutation attempts per claim (default 2).",
        },
        force: {
          type: "boolean",
          description:
            "Re-run even if a fresh verdict already exists for the claim.",
        },
      },
      required: [],
    },
  },
  {
    type: "custom",
    name: "list_audits",
    description:
      "List recent audit results with their summaries, issue counts, and scores.",
    input_schema: {
      type: "object",
      properties: {
        category: str("Optional category filter"),
      },
      required: [],
    },
  },
  {
    type: "custom",
    name: "define_audit",
    description:
      "Define a custom audit category. The prompt should instruct the AI auditor what to check for and how to report issues. It will receive the application's code context (handlers, functions, templates, routes) and must return a JSON array of issues with severity, rule, message, entity, and suggestion fields.",
    input_schema: {
      type: "object",
      properties: {
        name: str(
          "Audit category name in kebab-case (e.g., 'data-validation', 'error-handling')",
        ),
        description: str("Short description of what this audit checks"),
        prompt: str(
          "System prompt for the AI auditor — what to analyze and what issues to look for",
        ),
        module: str("Module name for grouping"),
      },
      required: ["name", "description", "prompt"],
    },
  },
  {
    type: "custom",
    name: "remove_audit",
    description:
      "Remove a custom audit category by name. Built-in audits cannot be removed.",
    input_schema: {
      type: "object",
      properties: { name: str("Name of the custom audit to remove") },
      required: ["name"],
    },
  },

  {
    type: "custom",
    name: "check_package_security",
    description:
      "Check all installed packages for known vulnerabilities, deprecated packages, and available updates. Returns advisories with severity and upgrade recommendations.",
    input_schema: { type: "object", properties: {}, required: [] },
  },

  {
    type: "custom",
    name: "analyze_complexity",
    description:
      "Analyze cyclomatic complexity, nesting depth, line count, and parameter count for all handlers and functions. Flags entities that exceed recommended thresholds.",
    input_schema: { type: "object", properties: {}, required: [] },
  },

  {
    type: "custom",
    name: "analyze",
    description:
      "Run a static codebase analysis. `kind` selects which: 'complexity' (cyclomatic complexity, nesting, size flags for handlers/functions) or 'dead_code' (unreachable entities via the call graph). For package vulnerability/update advisories use check_package_security.",
    input_schema: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: ["complexity", "dead_code"],
          description: "Which analysis to run.",
        },
      },
      required: ["kind"],
    },
  },

  // --- Changelog ---
  {
    type: "custom",
    name: "search_changes",
    description:
      "Search the changelog for past modifications. Use this before editing an existing entity to understand why it last changed and to avoid undoing intentional behavior. Without a query, lists recent changes. With a query, searches by key name or context (user message). Filter by category (handler, function, route, state, schema, sql), key, or turnId.",
    input_schema: {
      type: "object",
      properties: {
        query: str("Free-text search across key names and context"),
        category: str(
          "Filter by category: handler, function, route, state, schema, sql",
        ),
        key: str("Filter by item key/name"),
        turnId: str("Filter by turn ID to see all changes in a specific turn"),
        limit: num("Max results (default 20)"),
      },
      required: [],
    },
  },
  {
    type: "custom",
    name: "list_turns",
    description:
      "List recent turns (grouped batches of changes from a single user request). Each turn includes the user message, timestamp, and all changes made. Use this to understand recent project intent and what happened at a high level before debugging or modifying existing code.",
    input_schema: {
      type: "object",
      properties: { limit: num("Max turns to return (default 20)") },
      required: [],
    },
  },
  {
    type: "custom",
    name: "get_change",
    description:
      "Get full details of a specific changelog entry including before/after snapshots. Use this after search_changes or list_turns when you need to inspect exactly what changed before editing or explaining an entity.",
    input_schema: {
      type: "object",
      properties: { id: num("Changelog entry ID") },
      required: ["id"],
    },
  },
  {
    type: "custom",
    name: "goto_change",
    description:
      "Jump to a specific point in the changelog by ID. Automatically undoes or redoes all changes between the current cursor position and the target. Use this to restore the app to any previous state in the timeline.",
    input_schema: {
      type: "object",
      properties: { id: num("Target changelog entry ID to jump to") },
      required: ["id"],
    },
  },
  {
    type: "custom",
    name: "undo_change",
    description:
      "Undo the most recent undoable change. Restores the previous state of the affected item. Works for handlers, functions, routes, and state. Schema and SQL changes are not undoable — use snapshots for those.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    type: "custom",
    name: "redo_change",
    description:
      "Redo the most recently undone change. Re-applies the change that was undone.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    type: "custom",
    name: "undo_turn",
    description:
      "Undo all changes from the most recent turn (batch of changes from a single user request). Reverses all undoable changes in the turn at once.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    type: "custom",
    name: "redo_turn",
    description: "Redo all changes from the most recently undone turn.",
    input_schema: { type: "object", properties: {}, required: [] },
  },

  // --- Changesets ---
  {
    type: "custom",
    name: "list_changesets",
    description:
      "List recent changesets in the current project. Use this to find a changeset before fetching detailed context.",
    input_schema: {
      type: "object",
      properties: {
        status: str(
          "Optional status filter: planning, approved, in_progress, completed, abandoned, or rejected",
        ),
        limit: num("Max changesets to return (default 20)"),
      },
      required: [],
    },
  },
  {
    type: "custom",
    name: "get_changeset_context",
    description:
      "Fetch structured details for a changeset in the current project, including its plan, status, and related changelog entries. Use this when the user mentions a changeset, asks to explain one, or when recent history shows a relevant changeset for existing code you are about to edit.",
    input_schema: {
      type: "object",
      properties: {
        changeset_id: str("ID of the changeset to fetch"),
        include_snapshots: {
          type: "boolean",
          description:
            "Include before/after snapshots for each changelog entry. Default false to keep responses compact.",
        },
      },
      required: ["changeset_id"],
    },
  },
  {
    type: "custom",
    name: "check_changeset_readiness",
    description:
      "Run deterministic completion checks for a changeset. Returns structured errors and actions when acceptance criteria, planned checks, finished steps, verification evidence, or per-claim results are missing. Use this before complete_changeset; if passed is false, fix the listed errors by running validations and record_verification_run.",
    input_schema: {
      type: "object",
      properties: {
        changeset_id: str(
          "Optional changeset ID. Defaults to the active changeset for the current session, then the latest active changeset.",
        ),
      },
      required: [],
    },
  },
  {
    type: "custom",
    name: "verify_formal_specs",
    description:
      "Verify the active changeset's formal specs (Tier-1 type-level invariants). Runs the export type check (deno check) and confirms each spec's guard marker (e.g. `default: return assertNever(x);` in the relevant switch, `satisfies Record<K,V>`) is present in its target entity. For `discriminated-union`, a plain `switch (action.type)` is not enough: the same switch must include an `assertNever` default so omitted variants fail to type-check; when the spec includes `discriminant`, the guard must be on that exact switch expression. A spec passes only when the guard is present AND the project type-checks. MINTS one kernel `invariant` attestation per spec (fingerprinted to the target entity) and returns per-spec results plus ready-to-record 'invariant' evidence carrying each attestationId (and checkId set to the spec id). Call this during execution after writing the guards, fix any unmet HARD spec, then pass the returned evidence (with its attestationId) to record_verification_run. Editing a spec's target entity afterwards invalidates its attestation — re-run this before completing.",
    input_schema: {
      type: "object",
      properties: {
        changeset_id: str(
          "Optional changeset ID. Defaults to the active changeset for the current session, then the latest active changeset.",
        ),
      },
      required: [],
    },
  },
  {
    type: "custom",
    name: "create_changeset",
    description:
      "Propose a detailed plan for a complex request. Include what will be done, how it will be implemented, why it is needed, and why this implementation strategy fits the existing app. Creates a changeset in 'planning' status. Wait for the user to approve before starting work.",
    input_schema: {
      type: "object",
      properties: {
        title: str(
          "Descriptive title summarizing the feature or change (e.g. 'Add user authentication with login/signup pages'). Do NOT echo the user's message — write a concise summary of what will be built.",
        ),
        description: str(
          "Optional longer description of what will be built, why it is needed, and why the chosen technical approach is appropriate",
        ),
        plan: {
          type: "object",
          description: "The proposed plan",
          properties: {
            summary: str(
              "Detailed summary of the approach, including what will be built, why it is needed, why this approach fits the existing app, and any notable tradeoffs",
            ),
            steps: {
              type: "array",
              description:
                "Ordered list of implementation step descriptions. Each step should include the technical how: entities, schemas, handlers, routes, templates, assets, APIs, data flow, validation rules, algorithms, queries, state transitions, or tests involved.",
              items: { type: "string" },
            },
            acceptanceCriteria: {
              type: "array",
              description:
                "Concrete behavior claims extracted from the request. Each item can be a string or an object with id, text, source (user/agent/inferred), and priority (must/should/nice).",
              items: acceptanceCriterionItem,
            },
            verificationPlan: {
              type: "array",
              description:
                "Planned verification checks mapped to acceptance criteria. Each item should include description, kind (unit/integration/e2e/screenshot/typecheck/coverage/audit/adversarial/manual/invariant), and claimIds.",
              items: verificationCheckItem,
            },
            formalSpecs: {
              type: "array",
              description:
                'Optional Tier-1 formal specs: type-level invariants the compiler enforces. Propose one only where a type-level guard genuinely applies. Each item: { id, claimIds, technique (exhaustive-switch/satisfies-guard/discriminated-union/union-alias/numeric-range/exhaustive-record/branded-type), scope ("handler:<name>" or "function:<name>"), statement, enforcement (hard/soft), discriminant? }. For `discriminated-union`, set `discriminant` (e.g. `"status"`) rather than naming it only in prose. Enforcement defaults to hard for a \'must\' criterion, soft otherwise; hard specs block completion until verify_formal_specs passes, and a failing spec says what code shape it needs.',
              items: {},
            },
          },
          required: [
            "summary",
            "steps",
          ],
        },
        change_class: {
          type: "string",
          enum: ["light", "standard"],
          description:
            "`light` for small, low-blast-radius work (a copy or style tweak, a tightened validation, a small handler fix): the kernel writes the criterion and check, skips adversarial review, and may skip the approval round-trip. In exchange it refuses routes, schemas, SQL, secrets, env vars, packages, snapshots and handler/function deletes, and escalates to `standard` past a few entities. Rejected with formal specs, a `must` criterion, or more than two steps. `standard` (the default) for anything structural or risky.",
        },
      },
      required: ["title", "plan"],
    },
  },
  {
    type: "custom",
    name: "update_changeset_plan",
    description:
      "Revise the plan of a changeset that is still in 'planning' status, based on user feedback.",
    input_schema: {
      type: "object",
      properties: {
        changeset_id: str("ID of the changeset to update"),
        plan: {
          type: "object",
          description:
            "The revised plan, preserving enough technical detail and rationale for the user to evaluate the strategy",
          properties: {
            summary: str(
              "Detailed summary of the approach, including what will be built, why it is needed, why this approach fits the existing app, and any notable tradeoffs",
            ),
            steps: {
              type: "array",
              description:
                "Ordered list of implementation step descriptions. Each step should include the technical how: entities, schemas, handlers, routes, templates, assets, APIs, data flow, validation rules, algorithms, queries, state transitions, or tests involved.",
              items: { type: "string" },
            },
            acceptanceCriteria: {
              type: "array",
              description:
                "Concrete behavior claims extracted from the request. Each item can be a string or an object with id, text, source (user/agent/inferred), and priority (must/should/nice).",
              items: acceptanceCriterionItem,
            },
            verificationPlan: {
              type: "array",
              description:
                "Planned verification checks mapped to acceptance criteria. Each item should include description, kind (unit/integration/e2e/screenshot/typecheck/coverage/audit/adversarial/manual/invariant), and claimIds.",
              items: verificationCheckItem,
            },
            formalSpecs: {
              type: "array",
              description:
                'Optional Tier-1 formal specs: type-level invariants the compiler enforces. Propose one only where a type-level guard genuinely applies. Each item: { id, claimIds, technique (exhaustive-switch/satisfies-guard/discriminated-union/union-alias/numeric-range/exhaustive-record/branded-type), scope ("handler:<name>" or "function:<name>"), statement, enforcement (hard/soft), discriminant? }. For `discriminated-union`, set `discriminant` (e.g. `"status"`) rather than naming it only in prose. Enforcement defaults to hard for a \'must\' criterion, soft otherwise; hard specs block completion until verify_formal_specs passes, and a failing spec says what code shape it needs.',
              items: {},
            },
          },
          required: [
            "summary",
            "steps",
          ],
        },
        change_class: {
          type: "string",
          enum: ["light", "standard"],
          description:
            "How much verification ceremony the revised plan warrants. Same meaning and same kernel-enforced bounds as on create_changeset: `light` for small, low-blast-radius work (the kernel writes the criterion and check, skips adversarial review, and narrows what the changeset may touch), `standard` for anything structural or risky. Re-declare it on every revision — omitting it means `standard`.",
        },
      },
      required: ["changeset_id", "plan"],
    },
  },
  {
    type: "custom",
    name: "amend_changeset_plan",
    description:
      "Append new scope to an active in-progress changeset when the user asks for additional modifying work outside the approved plan. This moves the changeset back to 'planning'; stop after calling it and wait for user approval before making the extra modifications.",
    input_schema: {
      type: "object",
      properties: {
        changeset_id: str("ID of the active in-progress changeset to amend"),
        summary_addendum: str(
          "Explanation of the newly requested scope and why it extends the approved plan",
        ),
        steps: {
          type: "array",
          description:
            "New implementation step descriptions to append. Each step should explain the technical how and map to the added scope.",
          items: { type: "string" },
        },
        acceptanceCriteria: {
          type: "array",
          description:
            "Additional concrete behavior claims introduced by the new scope. Each item can be a string or an object with id, text, source (user/agent/inferred), and priority (must/should/nice).",
          items: acceptanceCriterionItem,
        },
        verificationPlan: {
          type: "array",
          description:
            "Additional planned verification checks mapped to the new or existing acceptance criteria. Each item should include description, kind (unit/integration/e2e/screenshot/typecheck/coverage/audit/adversarial/manual/invariant), and claimIds.",
          items: verificationCheckItem,
        },
        formalSpecs: {
          type: "array",
          description:
            'Additional Tier-1 formal specs introduced by the amendment. Each item: { id, claimIds, technique (exhaustive-switch/satisfies-guard/discriminated-union/union-alias/numeric-range/exhaustive-record/branded-type), scope ("handler:<name>" or "function:<name>"), statement, enforcement (hard/soft), discriminant? }. For `discriminated-union`, include `discriminant` when known instead of relying on prose.',
          items: {},
        },
      },
      required: [
        "changeset_id",
        "summary_addendum",
        "steps",
      ],
    },
  },
  {
    type: "custom",
    name: "record_verification_run",
    description:
      "Record a durable verification run for a changeset after running tests, type checks, coverage, screenshots, browser flows, audits, or manual checks. Use this before completing a changeset so history includes proof evidence and residual risks.",
    input_schema: {
      type: "object",
      properties: {
        changeset_id: str("ID of the changeset this verification run proves"),
        status: {
          type: "string",
          enum: VERIFICATION_STATUSES,
          description: "Overall status: passed, failed, partial, or manual",
        },
        summary: str(
          "Human-readable proof summary describing what was verified and any important limits",
        ),
        evidence: {
          type: "array",
          description:
            "Evidence items. Each item should include id, kind, status, summary, optional checkId, optional artifactPath, and optional data. checkId names the planned check or formal spec this evidence discharges. For grounded evidence (tests, typecheck, coverage, audits, formal-spec invariants), set attestationId to the id returned by the verifier that produced it (run_tests, check_export_types, test_coverage, run_audit, verify_formal_specs) so the readiness gate can confirm the proof is kernel-minted and still fresh.",
          items: evidenceItem,
        },
        claimResults: {
          type: "array",
          description:
            "Per-claim results with claimId, status, evidenceIds, and optional note. evidenceIds must reference evidence[].id values from this same verification run; do not put verificationPlan checkId values or attestationId values here.",
          items: claimResultItem,
        },
        residualRisks: {
          type: "array",
          description:
            "Known remaining risks or manual gaps. Use an empty array when there are none.",
          items: { type: "string" },
        },
      },
      required: [
        "changeset_id",
        "status",
        "summary",
        "evidence",
        "claimResults",
        "residualRisks",
      ],
    },
  },
  {
    type: "custom",
    name: "update_changeset_step",
    description:
      "Update the status of a changeset step during execution. Call this as you work through each step.",
    input_schema: {
      type: "object",
      properties: {
        changeset_id: str("ID of the changeset"),
        step_id: str("Step ID (e.g., 'step_0', 'step_1')"),
        status: {
          type: "string",
          enum: ["in_progress", "done", "skipped"],
          description: "New status: 'in_progress', 'done', or 'skipped'",
        },
      },
      required: ["changeset_id", "step_id", "status"],
    },
  },
  {
    type: "custom",
    name: "complete_changeset",
    description:
      "Mark a changeset as completed after all steps are done and check_changeset_readiness passes. Aggregates usage stats.",
    input_schema: {
      type: "object",
      properties: {
        changeset_id: str("ID of the changeset to complete"),
      },
      required: ["changeset_id"],
    },
  },
  {
    type: "custom",
    name: "abandon_changeset",
    description:
      "Abandon a changeset. Use when the user cancels or the approach is no longer viable. Rewinds the project's code, schema and files to where they stood when the changeset began; rows written meanwhile stay. The result's `rewind` says whether it did.",
    input_schema: {
      type: "object",
      properties: {
        changeset_id: str("ID of the changeset to abandon"),
      },
      required: ["changeset_id"],
    },
  },
  {
    type: "custom",
    name: "adopt_changeset",
    description:
      "Continue an open changeset left behind by a client that is gone (it disconnected, the server restarted, or it sat idle 30 minutes). Moves it to this session with its plan and step statuses. Refused while its owner is still connected. Use when create_changeset or project_status says a changeset was left open.",
    input_schema: {
      type: "object",
      properties: {
        changeset_id: str(
          "ID of the changeset to adopt. Omit to adopt the project's open one.",
        ),
      },
      required: [],
    },
  },

  // --- Modules ---
  {
    type: "custom",
    name: "list_modules",
    description:
      "Returns all modules in the project with entity counts per module. Pass `name` to return the entities belonging to a single module instead.",
    input_schema: {
      type: "object",
      properties: {
        name: str(
          "Optional: return this one module's entities instead of the list.",
        ),
      },
      required: [],
    },
  },
  {
    type: "custom",
    name: "get_module",
    description: "Returns all entities belonging to a specific module.",
    input_schema: {
      type: "object",
      properties: { name: str("Module name") },
      required: ["name"],
    },
  },
  {
    type: "custom",
    name: "rename_module",
    description:
      "Rename a module across all entities. Updates the module field on every entity that belongs to the old module name.",
    input_schema: {
      type: "object",
      properties: {
        oldName: str("Current module name"),
        newName: str("New module name"),
      },
      required: ["oldName", "newName"],
    },
  },
  {
    type: "custom",
    name: "move_to_module",
    description:
      "Move a specific entity to a different module (or remove from module by passing empty string).",
    input_schema: {
      type: "object",
      properties: {
        category: str(
          "Entity category: handler, function, route, template, asset, schema, test, dev_view, dev_tool",
        ),
        key: str(
          "Entity key (handler name, function name, 'METHOD /path' for routes, table name for schemas, etc.)",
        ),
        module: str("Target module name (empty string to ungroup)"),
      },
      required: ["category", "key", "module"],
    },
  },

  {
    type: "custom",
    name: "edit_entity_text",
    description:
      "Make targeted string replacements in a template or a text asset (CSS/JS/SVG), instead of re-sending the whole file through define_template / upload_text_asset. PREFER THIS for small edits — changing one CSS declaration, fixing a label, adjusting a class — where re-emitting the entire file would cost far more output than the change is worth. Each `find` must match EXACTLY, whitespace and indentation included, and must occur exactly `count` times (default 1); zero matches or an unexpected count fails without changing anything, so read the current content first (list_templates({name}) / list_assets({includeContent:true})) and copy the text verbatim. Edits apply in order, all-or-nothing. Use define_template / upload_text_asset instead when rewriting most of a file or creating it.",
    input_schema: {
      type: "object",
      properties: {
        type: {
          type: "string",
          enum: ["template", "text_asset"],
          description:
            "Entity kind to edit. `text_asset` covers UTF-8 assets (CSS, JS, SVG); binary assets must be replaced with upload_asset.",
        },
        name: str("Name of the template or asset to edit."),
        edits: {
          type: "array",
          description:
            "Ordered replacements. Each item: { find (exact text to locate, including whitespace), replace (text to substitute; empty string deletes), count? (expected occurrences, default 1 — set it to rewrite a value that genuinely repeats) }. Include enough surrounding context that each `find` is unambiguous.",
          items: {},
        },
      },
      required: ["type", "name", "edits"],
    },
  },

  {
    type: "custom",
    name: "remove_entity",
    description:
      "Remove a project entity of any type. `type` selects the entity kind; `key` identifies it (name for most; 'METHOD /path' for a route; table name for a schema). Consolidates the per-entity removal verbs. Removing a `handler` is refused while a route still points at it, and removing a `function` is refused while any handler, function, or test still calls it — clear the dependants first. Note: config values, simple env vars (env.*), and branches keep their own dedicated remove verbs.",
    input_schema: {
      type: "object",
      properties: {
        type: {
          type: "string",
          enum: [
            "route",
            "schema",
            "template",
            "asset",
            "handler",
            "function",
            "type",
            "test",
            "dev_view",
            "dev_tool",
            "audit",
            "env_var",
            "secret",
            "package",
          ],
          description: "Entity type to remove.",
        },
        key: str(
          "Entity key: name for most; 'METHOD /path' for a route; table name for a schema.",
        ),
      },
      required: ["type", "key"],
    },
  },

  // --- System ---
  {
    type: "custom",
    name: "set_system_prompt",
    description:
      "Set custom instructions appended to the system prompt. Use to customize AI behavior, personality, or focus areas. Pass empty string to clear custom instructions.",
    input_schema: {
      type: "object",
      properties: {
        instructions: str("Custom instructions to append to the system prompt"),
      },
      required: ["instructions"],
    },
  },

  // --- Export ---
  {
    type: "custom",
    name: "export_project",
    description:
      "Export the current app as a standalone Deno project. Returns file metadata; without `out` the user can download the archive from the UI. Pass `out` to write the export tree to a directory inside the project, done by the process that already owns it so no second kernel has to take the project lock. Always generates .env.example if secrets are defined. Optionally includes .env with resolved secret values.",
    input_schema: {
      type: "object",
      properties: {
        out: str(
          "Directory to write the export tree into, resolved against the project directory and required to stay inside it. Default: dist/v<version>. Omit to return file metadata without writing anything.",
        ),
        force: {
          type: "boolean",
          description:
            "If true, clear a non-empty `out` directory before writing (default false, which refuses rather than merging over stale files)",
        },
        includeEnvFile: {
          type: "boolean",
          description:
            "If true, include a .env file with resolved secret values (default false)",
        },
        includeSeedData: {
          type: "boolean",
          description:
            "If true, include current database rows in seed.sql (default false; schema only)",
        },
        includeManifest: {
          type: "boolean",
          description:
            "If true, emit a self-describing manifest.json with a sha256 per file and a sourceFingerprint over the whole file set (default false)",
        },
      },
      required: [],
    },
  },
  {
    type: "custom",
    name: "export_data",
    description:
      "Export current local database rows into mergeable project fixture JSON files under fixtures/<name>. Schemas are not exported here; they come from project state.",
    input_schema: {
      type: "object",
      properties: {
        name: str("Fixture name (default: default)"),
        tables: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional table names to export. Defaults to all tables.",
        },
      },
      required: [],
    },
  },
  {
    type: "custom",
    name: "import_data",
    description:
      "Import rows from project fixture JSON files under fixtures/<name> into the local database. Requires schemas to already exist in project state.",
    input_schema: {
      type: "object",
      properties: {
        name: str("Fixture name (default: default)"),
        tables: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional table names to import. Defaults to all fixture tables.",
        },
        mode: {
          type: "string",
          enum: ["truncate", "append"],
          description:
            "Import mode. truncate clears selected tables first; append inserts rows without clearing. Default: truncate.",
        },
      },
      required: [],
    },
  },
  {
    type: "custom",
    name: "reset_data",
    description:
      "Clear local database rows for selected tables, or all tables if none are provided. This does not change schema state or fixture files.",
    input_schema: {
      type: "object",
      properties: {
        tables: {
          type: "array",
          items: { type: "string" },
          description: "Optional table names to reset. Defaults to all tables.",
        },
      },
      required: [],
    },
  },
  {
    type: "custom",
    name: "generate_project_docs",
    description:
      "Generate README.md and/or AGENT.md for the project. These are auto-generated from current kernel state (routes, handlers, schemas, configs) and include any custom instructions set via set_system_prompt. Write the results to the project directory.",
    input_schema: {
      type: "object",
      properties: {
        files: {
          type: "array",
          items: { type: "string", enum: ["README.md", "AGENT.md"] },
          description: "Which docs to generate (default: both)",
        },
        projectName: str("Project name for the doc title (optional)"),
      },
      required: [],
    },
  },
  {
    type: "custom",
    name: "write_project_file",
    description:
      "Write a file to the project directory. Use this to create project files like .gitignore, .env, or other custom files. The file path is relative to the project root. For README.md and AGENT.md, prefer generate_project_docs which auto-includes project state and custom instructions.",
    input_schema: {
      type: "object",
      properties: {
        path: str(
          "File path relative to project root (e.g., '.gitignore', '.env')",
        ),
        content: str("File content to write"),
      },
      required: ["path", "content"],
    },
  },

  // --- Branches ---
  {
    type: "custom",
    name: "create_branch",
    description:
      "Create a named branch from the current state. Saves a snapshot so you can switch back later.",
    input_schema: {
      type: "object",
      properties: { name: str("Branch name") },
      required: ["name"],
    },
  },
  {
    type: "custom",
    name: "switch_branch",
    description:
      "Switch to a different branch. Auto-saves the current branch first, then restores the target branch's state.",
    input_schema: {
      type: "object",
      properties: { name: str("Branch name to switch to") },
      required: ["name"],
    },
  },
  {
    type: "custom",
    name: "list_branches",
    description: "Returns all branches with the active branch marked.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    type: "custom",
    name: "delete_branch",
    description: "Delete a branch.",
    input_schema: {
      type: "object",
      properties: { name: str("Branch name to delete") },
      required: ["name"],
    },
  },

  // --- Tasks (forks of the project that merge back) ---
  {
    type: "custom",
    name: "start_task",
    description:
      "Fork this project into a task: a full copy (files, state, database) that runs under its own serve, so separate work happens in parallel and merges back with merge_task. Returns the task, any `overlaps` with other open tasks' claims, the fork's serve, and `connect`: the MCP server config and a ready-to-run Claude Code command for the fork. You can't work in the fork over this connection, and subagents share it, so to fan out, launch a separate client per fork with that command; its stdio bridge attaches to the fork's running serve (to run it headless, append `--allowedTools mcp__opentide -p \"<instructions>\"`). The work in the fork must end with a completed changeset before it can merge. Refused with TASK_LIMIT past the open-task cap, TASK_IN_FORK inside a fork, and TASK_NO_CLEAN_POINT when main's open changeset has no start snapshot. If main has a changeset open, the fork starts from that changeset's start, not from its half-done work.",
    input_schema: {
      type: "object",
      properties: {
        title: str("What the task is for, e.g. 'Add GET /api/invoices'"),
        claims: {
          type: "array",
          items: { type: "string" },
          description:
            "category:key scopes the task expects to touch, e.g. handler:calcTotal or 'route:GET /api/a'. Used only to flag overlaps between open tasks; nothing is locked.",
        },
      },
      required: ["title"],
    },
  },
  {
    type: "custom",
    name: "list_tasks",
    description:
      "Returns this project's tasks: id, title, fork path, status (open / merged / discarded), the fork's serve port while one runs, claims and overlaps with other open tasks.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    type: "custom",
    name: "merge_task",
    description:
      "Merge a task's fork back into this project. Stops the fork's serve, replays what the fork changed (schema, code, routes, tests, files) under a new changeset on main, runs main's tests and completes that changeset only if main's own verification passes. `outcome` is merged, unverified (landed, changeset left open with `readiness` saying why) or apply-failed (stopped partway, changeset left open). App rows, documents and secrets never merge; `notMerged` lists them. Refused with TASK_BUSY while the fork has a changeset open, CHANGESET_ACTIVE while main does, and TASK_MERGE_BLOCKED when the fork conflicts with main's changes since the fork (discard and redo the task then).",
    input_schema: {
      type: "object",
      properties: {
        task_id: str("The task's id, from start_task or list_tasks"),
      },
      required: ["task_id"],
    },
  },
  {
    type: "custom",
    name: "discard_task",
    description:
      "Stop a task's serve and delete its fork. Anything not merged is gone. A merged task stays merged. Discarding twice is a no-op.",
    input_schema: {
      type: "object",
      properties: {
        task_id: str("The task's id, from start_task or list_tasks"),
      },
      required: ["task_id"],
    },
  },

  // --- Control ---
  {
    type: "custom",
    name: "get_kernel_status",
    description:
      "Returns kernel uptime, route count, handler count, schema count, recent activity summary.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    type: "custom",
    name: "flush_project_state",
    description:
      "Write the in-memory registries (routes, handlers, functions, templates, assets, tests, types, configs) to the project's state directory on disk, together with branch snapshots and logs. The project LOADS FROM that directory, so until this runs, entities defined or removed in this session exist only in memory and are lost unless the process shuts down cleanly. Completing a changeset flushes automatically; call this for work outside one, or before ending a long session. Touches only the project's own state directory — no git operations, no database writes.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    type: "custom",
    name: "take_snapshot",
    description:
      "Save a snapshot of the current kernel state (routes, handlers, functions, state, database). Use before risky changes.",
    input_schema: {
      type: "object",
      properties: { description: str("Optional description of the snapshot") },
      required: [],
    },
  },
  {
    type: "custom",
    name: "list_snapshots",
    description: "Returns all saved snapshots with their metadata.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    type: "custom",
    name: "restore_snapshot",
    description:
      "Restore the kernel to a previously saved snapshot. This replaces all current state.",
    input_schema: {
      type: "object",
      properties: { id: str("Snapshot ID to restore") },
      required: ["id"],
    },
  },

  // --- Browser ---
  {
    type: "custom",
    name: "screenshot_app",
    description:
      "Take a screenshot of the running app at a given path. Returns the screenshot image and page metadata (title, console messages, errors). Use this to visually verify the UI after making changes.",
    input_schema: {
      type: "object",
      properties: {
        path: str("URL path to screenshot (default: '/')"),
        selector: str(
          "Optional CSS selector — wait for this element before screenshotting",
        ),
        width: num("Viewport width in pixels (default: 1280)"),
        height: num("Viewport height in pixels (default: 720)"),
        fullPage: {
          type: "boolean",
          description: "Capture the full scrollable page (default: false)",
        },
      },
      required: [],
    },
  },
  {
    type: "custom",
    name: "test_app",
    description:
      "Navigate to a page and run a sequence of interaction steps (click, fill, assert, etc.). Returns results for each step and a final screenshot. Use this to test user flows and verify interactive behavior.",
    input_schema: {
      type: "object",
      properties: {
        path: str("URL path to start at (default: '/')"),
        steps: {
          type: "array",
          description: "Steps to execute in order",
          items: {
            type: "object",
            properties: {
              action: str(
                "Action: click, fill, select, wait, screenshot, assert_text, assert_visible, navigate",
              ),
              selector: str("CSS selector for the target element"),
              value: str("Value for fill/select/assert_text actions"),
              path: str("URL path for navigate action"),
            },
            required: ["action"],
          },
        },
        width: num("Viewport width (default: 1280)"),
        height: num("Viewport height (default: 720)"),
      },
      required: ["steps"],
    },
  },
  {
    type: "custom",
    name: "browser_status",
    description:
      "Check if a browser is available for screenshots and testing. Returns the browser mode (headful/headless), and fails if Chromium is unavailable.",
    input_schema: { type: "object", properties: {}, required: [] },
  },

  // --- Platform Docs ---
  {
    type: "custom",
    name: "get_platform_docs",
    description:
      "Get Genie platform documentation for building dev views, dev tools, and extending the kernel. Returns reference docs including type definitions, API surfaces, and patterns. Use this when you need detailed knowledge beyond what's in the system prompt.",
    input_schema: {
      type: "object",
      properties: {
        topic: {
          type: "string",
          description: "Documentation topic to retrieve",
          enum: [
            "dev-views",
            "dev-tools",
            "view-descriptors",
            "closure-apis",
            "kernel-inspector",
            "compilation",
            "patterns",
          ],
        },
      },
      required: ["topic"],
    },
  },

  // --- Session ---
  {
    type: "custom",
    name: "list_projects",
    description:
      "List Genie projects known to the launcher, including recent session summaries. Use this before referencing another project or a cross-project session.",
    input_schema: {
      type: "object",
      properties: {
        sessionLimit: num("Max sessions to include per project (default 10)"),
      },
      required: [],
    },
  },
  {
    type: "custom",
    name: "get_project_context",
    description:
      "Fetch context about a Genie project. If no project_path or project_name is provided, returns the current project. Includes entity counts and recent sessions.",
    input_schema: {
      type: "object",
      properties: {
        project_path: str(
          "Exact project path. Prefer this when available from @project mentions.",
        ),
        project_name: str("Project name to resolve when path is unknown."),
        include_sessions: {
          type: "boolean",
          description: "Include recent sessions (default true)",
        },
        sessionLimit: num("Max sessions to include (default 20)"),
      },
      required: [],
    },
  },
  {
    type: "custom",
    name: "get_session_context",
    description:
      "Fetch messages and metadata for a session in the current project or another project. For cross-project references, pass project_path or project_name plus session_id.",
    input_schema: {
      type: "object",
      properties: {
        session_id: str("Session ID to fetch"),
        project_path: str("Exact project path for cross-project sessions."),
        project_name: str("Project name when path is unknown."),
        messageLimit: num("Max messages to include (default 50)"),
      },
      required: ["session_id"],
    },
  },
  {
    type: "custom",
    name: "list_current_session_pins",
    description:
      "List pinned messages for the current session with compact metadata, including message previews and attachment metadata. Use this before relying on durable session-specific context.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    type: "custom",
    name: "list_current_project_pins",
    description:
      "List project-wide pinned messages with compact metadata, including their source session, message previews, and attachment metadata. Use this to discover durable project specs, decisions, and reference material.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    type: "custom",
    name: "summarize_session",
    description:
      "Generate a reusable markdown summary for a session. Use this when context is large, the user asks what happened, or a handoff would help. Defaults to the current session and stores the summary for later @session context.",
    input_schema: {
      type: "object",
      properties: {
        session_id: str(
          "Session ID to summarize. Omit to summarize the current session.",
        ),
        kind: {
          type: "string",
          description:
            "Summary kind: brief, handoff, full, decisions, or todo. Default: handoff.",
          enum: ["brief", "handoff", "full", "decisions", "todo"],
        },
        throughMessageId: num("Optional highest message ID to include."),
        store: {
          type: "boolean",
          description:
            "Whether to store the generated summary on the session. Default: true.",
        },
        refresh: {
          type: "boolean",
          description:
            "Regenerate even when a fresh stored summary already exists. Default: false.",
        },
      },
      required: [],
    },
  },
  {
    type: "custom",
    name: "rename_session",
    description:
      "Rename the current session. Use this to give the session a descriptive name that reflects what was accomplished or discussed.",
    input_schema: {
      type: "object",
      properties: {
        name: str(
          "New name for the session (3-8 words, concise and descriptive)",
        ),
      },
      required: ["name"],
    },
  },
  {
    type: "custom",
    name: "manage_sessions",
    description:
      "List, search, rename, archive, or unarchive Genie sessions. Use this when the user asks to manage session history or asks for the current session to be renamed. For archive/unarchive, pass an explicit session_id.",
    input_schema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "search", "rename", "archive", "unarchive"],
          description: "Session operation to perform.",
        },
        session_id: str(
          "Target session ID. Required for archive/unarchive. Defaults to the current session for rename.",
        ),
        name: str("New session name, required for action=rename."),
        query: str(
          "Search text for action=search. Matches session names, summaries, focus, metadata, and recent matching messages.",
        ),
        limit: num(
          "Max sessions to return for list/search (default 20, max 100).",
        ),
        offset: num("Offset for action=list (default 0)."),
        include_archived: {
          type: "boolean",
          description:
            "Include archived sessions in list/search. Default false for list, true for search.",
        },
      },
      required: ["action"],
    },
  },

  // --- Document store (docs/document-store-plan.md §6). Role-split verbs so each
  // classifies cleanly against the name-keyed allowlists (never one mixed
  // read+write verb): document_query (read), document_write (mutation),
  // document_pin (working-set membership). ---
  {
    type: "custom",
    name: "document_query",
    description:
      "Read the durable document store. action=search finds documents by name/metadata substring; action=read returns a document's metadata + version history; action=list returns documents (optionally filtered by scope/session). Use this to recall plans, specs, decisions, and reference material on demand.",
    input_schema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["search", "read", "list"],
          description: "search | read | list",
        },
        id: str("Document id (required for action=read)."),
        query: str("Search string (required for action=search)."),
        scope: {
          type: "string",
          enum: ["session", "project", "global"],
          description: "Optional scope filter for search/list.",
        },
        sessionId: str("Optional session id filter for search/list."),
        includeArchived: {
          type: "boolean",
          description:
            "Include archived documents in search/list. Default false.",
        },
        versionHash: str(
          "Optional exact version to read content for (action=read); omit for the head.",
        ),
        includeContent: {
          type: "boolean",
          description:
            "For action=read, also return the resolved content of the requested (or head) version.",
        },
      },
      required: ["action"],
    },
  },
  {
    type: "custom",
    name: "document_write",
    description:
      "Author the durable document store. action=create makes a new document (and its first immutable version); action=update writes a new immutable version and moves the head; action=archive soft-archives a document. create/update are how the agent authors and revises plans and specs (each save is a citable version).",
    input_schema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["create", "update", "archive"],
          description: "create | update | archive",
        },
        id: str("Document id (required for action=update/archive)."),
        name: str(
          "Display name / @-mention handle (required for action=create).",
        ),
        kind: str(
          "MIME type, e.g. text/markdown, text/html, application/pdf (create).",
        ),
        content: str("Document content (required for action=create/update)."),
        scope: {
          type: "string",
          enum: ["session", "project", "global"],
          description:
            "Storage scope for a new document (create): session | project | global.",
        },
        sessionId: str(
          "Owning session id for a session-scoped document (create).",
        ),
        note: str("Optional changelog line for this version (create/update)."),
        description: str(
          "Optional short description stored in metadata (create).",
        ),
      },
      required: ["action"],
    },
  },
  {
    type: "custom",
    name: "document_pin",
    description:
      "Toggle a document's membership in the session working set (Tier-2). pinned=true keeps it in front of the agent across steps; pinned=false releases it. Phase 1 records the membership; prompt injection follows in a later phase.",
    input_schema: {
      type: "object",
      properties: {
        id: str("Document id."),
        pinned: {
          type: "boolean",
          description: "true to pin into the working set, false to release.",
        },
      },
      required: ["id", "pinned"],
    },
  },
];

const AGENT_TOOL_EXCLUDE = new Set([
  // Available through UI/local state, but low-value in the model tool budget.
  "rename_session",
  "list_current_session_pins",
  "list_current_project_pins",
  "get_kernel_status",
  "browser_status",
  "doctor_project",
  "get_recent_errors",
  "get_recent_requests",
  "list_snapshots",
  "list_branches",
  // Metadata/content reads are covered by list_assets.
  // Unhooked from the model budget to make room for blast_radius (B1c); still
  // reachable via direct dispatch.
  "get_asset",
  // Single-config reads are covered by list_configs (it returns every entry with
  // full metadata). Unhooked from the model budget to make room for
  // index_codebase (project import Slice 1) within the 128-tool ceiling; still
  // reachable via direct dispatch.
  "get_config",
  // --- Tool consolidation (surface v5.0.0) ---
  // Singular get_* reads folded into their list_* sibling, matching the
  // get_asset/get_config precedent. The list verb already returns the same data
  // (source/metadata/values), so the single-item read is pure redundancy on the
  // model surface. All still reachable via direct dispatch.
  "get_handler_source", // list_handlers({name}) returns source
  "get_function_source", // list_functions({name}) returns source
  "get_schema", // list_schemas returns columns
  "get_type", // list_types({name}) returns the full definition
  "get_env", // list_env returns resolved values
  "get_env_var", // metadata via list_env_vars, values via list_env
  "get_secret", // list_secrets returns status (values never exposed by tool)
  // These four list_* now accept an optional `name` to return the single item's
  // full detail (content/source/entities), so the get_* is redundant.
  "get_template", // list_templates({name}) returns content
  "get_dev_view_source", // list_dev_views({name}) returns source
  "get_test_source", // list_tests({name}) returns source
  "get_module", // list_modules({name}) returns the module's entities
  // Explicit value set/clear folded into define_env_var / define_secret via
  // `value` / `clearValue`. The define verb now covers create + set + clear.
  "set_env_var_value",
  "clear_env_var_value",
  "set_secret_value",
  "clear_secret_value",
  // Per-entity removal verbs folded into the single remove_entity({type,key})
  // verb (the move_to_module precedent). delete_config / delete_env / delete_branch
  // are deliberately NOT folded — they keep distinct changeset-gating semantics
  // (config/env removals are changeset-exempt; branch deletes are ungated).
  "unregister_route",
  "drop_schema",
  "delete_template",
  "delete_asset",
  "remove_handler",
  "remove_function",
  "remove_type",
  "remove_test",
  "remove_dev_view",
  "remove_dev_tool",
  "remove_audit",
  "remove_package",
  "delete_env_var",
  "delete_secret",
  // Core static analyses folded into analyze({kind}). check_package_security is
  // deliberately NOT folded — it is capability-layer-gated and open-world, a
  // different governance class from these core call-graph analyses.
  "analyze_complexity",
  "find_dead_code",
]);

export const AGENT_TOOLS: CustomToolDef[] = CUSTOM_TOOLS.filter((tool) =>
  !AGENT_TOOL_EXCLUDE.has(tool.name)
);

for (const tool of CUSTOM_TOOLS) {
  if (!MODIFICATION_TOOLS.has(tool.name)) continue;
  const schema = tool.input_schema;
  if (schema.type !== "object") continue;
  const properties = (schema.properties ??= {}) as Record<string, unknown>;
  properties.rationale ??= str(
    "Short explanation of why this code change is needed.",
  );
  properties.implementation ??= str(
    "Short explanation of why this implementation approach was chosen.",
  );
}
